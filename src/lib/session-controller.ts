/**
 * Owns the session state and runs its side effects (loading, recording
 * answers). State lives in a plain variable rather than React state so every
 * transition is synchronous: two key presses in the same tick see each other's
 * effect.
 *
 * An answer is recorded in the outbox and the session moves on in the same
 * breath; the write reaches the server whenever it can. Nothing waits on the
 * network, so any number of answers may be on their way at once. When the
 * server refuses an answer it moves to the session's refused list, which is
 * shown beside the current card rather than in front of it.
 *
 * The queue itself, and the sitting in progress, are written to this device's
 * own storage, so a reload without a connection resumes where it stopped.
 */
import type { Confidence, QueueResponse, ReviewActionResponse, ReviewFocus } from '../../shared/api.js';
import { calendarDateInTimeZone } from '../../shared/dates.js';
import { reviewRules } from '../../config/review.config.js';
import type { ReviewAction } from '../../shared/review-logic.js';
import { checkEligibility } from '../../shared/review-logic.js';
import { ApiError, type ReviewApi } from './api-client.js';
import { answeredCards, isReviewOp, type ReviewActionPayload } from './offline/ops.js';
import type { LocalStore } from './offline/storage.js';
import type { SyncEngine } from './offline/sync-engine.js';
import { startTiming } from './perf.js';
import { newRequestId } from './request-id.js';
import {
  currentCard,
  initialSessionState,
  transition,
  type PendingAnswer,
  type RefusedAnswer,
  type SavedAnswer,
  type SessionEvent,
  type SessionMeta,
  type SessionState,
  type SessionTally,
} from './session-machine.js';

export interface SessionController {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /**
   * (Re)loads the queue. Reads only; never changes review data. Given a focus
   * (or `null` for everything due) it switches to it; given nothing, it keeps
   * the one in use, which is what Refresh wants. Where the server cannot be
   * reached, the last queue (and the sitting in progress) comes back from this
   * device's own storage.
   */
  load(options?: { focus: ReviewFocus | null; collection?: string | null }): Promise<void>;
  flip(): void;
  /**
   * Records how sure the reviewer is and shows the answer. Returns false when
   * it was not accepted: the answer has already been seen, or the store does
   * not keep ratings.
   */
  rateConfidence(level: Confidence): boolean;
  /** Returns false when the answer was not accepted (card not flipped, Undo in flight…). */
  grade(action: ReviewAction): boolean;
  /** Sends a refused answer again. */
  retryRefusal(requestId: string): void;
  /** Gives up on a refused answer for good. */
  dismissRefusal(requestId: string): void;
  /** Takes back the latest confirmed answer. Returns false when there is nothing that can be undone now. */
  undo(): boolean;
  /** The sitting in progress: every answer since the queue was last loaded. */
  sessionId(): string;
}

const messageOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Something unexpected went wrong.';

/** The longest time on one card worth recording; anything more is a tab left open. */
const MAX_DURATION_MS = 86_400_000;

/** How long a saved sitting may be resumed; after that a fresh queue is wanted. */
const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Failures after which trying the same Undo again cannot succeed. */
const UNDO_IS_OVER = new Set(['conflict', 'not_found', 'not_supported', 'read_only']);

/** The sitting as it is written to this device, so a reload can resume it. */
interface SessionSnapshot {
  version: 1;
  sessionId: string;
  focus: ReviewFocus | null;
  collection: string | null;
  cards: SessionState['cards'];
  index: number;
  meta: SessionMeta;
  tally: SessionTally;
  pending: PendingAnswer[];
  refused: RefusedAnswer[];
  lastSaved: SavedAnswer | null;
  savedAt: number;
}

/** The last queue the server sent, so a reload without a connection has cards to show. */
interface QueueCache {
  version: 1;
  response: QueueResponse;
  cachedAt: number;
}

/** Internal timer for tracking active review time per card. */
interface ReviewTimer {
  /** The card id this timer belongs to. */
  cardId: string;
  /** Accumulated active time in milliseconds. */
  accumulatedMs: number;
  /** Monotonic timestamp when the timer was last started, or null if paused. */
  startedAt: number | null;
}

export interface SessionControllerOptions {
  api: Pick<ReviewApi, 'fetchQueue' | 'submitAction' | 'undoAction'>;
  /** Where answers go to be sent, and how the session hears their fate. */
  engine: SyncEngine;
  /** This device's storage, for the queue cache and the sitting in progress. */
  store: LocalStore;
  accountId: string;
  /** Called once an answer is confirmed as saved, so other views know their data has changed. */
  onSaved?: () => void;
  now?: () => number;
}

const focusKey = (focus: ReviewFocus | null, collection: string | null): string =>
  collection === null ? focus ?? 'all' : `collection:${collection}`;

export function createSessionController(options: SessionControllerOptions): SessionController {
  const { api, engine, store, accountId } = options;
  const now = options.now ?? Date.now;
  const onSaved = options.onSaved ?? (() => {});

  let state = initialSessionState;
  let loadSequence = 0;
  let sessionId = newRequestId();
  /** What the queue is narrowed to, if anything. */
  let focus: ReviewFocus | null = null;
  /** The collection the queue is narrowed to instead, if any. */
  let collection: string | null = null;
  /** Timer for the currently active card. */
  let timer: ReviewTimer | null = null;
  /** Visibility change handler reference for cleanup. */
  let visibilityHandler: (() => void) | null = null;
  /** Identifies the Undo of one answer. Pressing Undo again after a failure repeats it. */
  let undoRequest: { of: string; requestId: string } | null = null;
  /** The answers this session recorded, so only their fate is acted on. */
  const ours = new Set<string>();
  const listeners = new Set<() => void>();

  /** Start or resume the timer for a card. */
  const startTimer = (cardId: string) => {
    if (timer?.cardId === cardId && timer.startedAt !== null) {
      // Already running for this card
      return;
    }
    const at = performance.now();
    if (timer?.cardId === cardId) {
      // Resuming existing timer for same card
      timer.startedAt = at;
    } else {
      // New card
      timer = { cardId, accumulatedMs: 0, startedAt: at };
    }
  };

  /** Pause the timer for a card, accumulating elapsed active time. */
  const pauseTimer = (cardId: string) => {
    if (timer?.cardId === cardId && timer.startedAt !== null) {
      const at = performance.now();
      timer.accumulatedMs += at - timer.startedAt;
      timer.startedAt = null;
    }
  };

  /** Get the total active time for the current card and stop the timer. */
  const stopTimer = (cardId: string): number => {
    if (timer?.cardId === cardId) {
      if (timer.startedAt !== null) {
        const at = performance.now();
        timer.accumulatedMs += at - timer.startedAt;
        timer.startedAt = null;
      }
      const total = Math.round(timer.accumulatedMs);
      timer = null;
      return total;
    }
    return 0;
  };

  /** Set up visibility change handling to pause/resume the timer. */
  const setupVisibilityHandler = () => {
    if (visibilityHandler !== null || typeof document === 'undefined') return;
    visibilityHandler = () => {
      const card = currentCard(state);
      if (card === null || timer === null || timer.cardId !== card.id) return;
      if (document.visibilityState === 'hidden') {
        pauseTimer(card.id);
      } else if (document.visibilityState === 'visible') {
        // Only resume if the same card is still active and we're in a state where timing makes sense
        if (state.status === 'ready' || state.status === 'flipped') {
          startTimer(card.id);
        }
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  };

  /** Clean up visibility handler. */
  const cleanupVisibilityHandler = () => {
    if (visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
  };

  /** Writes the sitting in progress, so a reload can resume it. Fire and forget. */
  const saveSnapshot = (): void => {
    if (state.meta === null) return;
    if (state.status !== 'ready' && state.status !== 'flipped' && state.status !== 'completed') return;
    const snapshot: SessionSnapshot = {
      version: 1,
      sessionId,
      focus,
      collection,
      cards: state.cards,
      index: state.index,
      meta: state.meta,
      tally: state.tally,
      pending: state.pending,
      refused: state.refused,
      lastSaved: state.lastSaved,
      savedAt: now(),
    };
    void store.kv.put(`${accountId}:session`, snapshot).catch(() => undefined);
  };

  /** Writes the queue the server just sent, so it can be shown again without one. */
  const cacheQueue = (response: QueueResponse): void => {
    const cache: QueueCache = { version: 1, response, cachedAt: now() };
    void store.kv.put(`${accountId}:queue:${focusKey(focus, collection)}`, cache).catch(() => undefined);
  };

  const dispatch = (event: SessionEvent): boolean => {
    const next = transition(state, event);
    if (next === state) return false;
    const previousCard = currentCard(state);
    state = next;
    const card = currentCard(state);

    // Handle timer transitions
    if (previousCard !== null && card !== null && previousCard.id !== card.id) {
      // Card changed - stop timer for old card, start for new card
      stopTimer(previousCard.id);
      startTimer(card.id);
    } else if (card === null) {
      // No card active
      if (timer !== null) {
        stopTimer(timer.cardId);
      }
    } else if (timer === null || timer.cardId !== card.id) {
      // New card or timer was lost
      startTimer(card.id);
    }

    saveSnapshot();
    for (const listener of listeners) listener();
    return true;
  };

  // The fate of every answer this session recorded. An answer sent by this
  // session is the session's to show; answers from an earlier sitting (or
  // another tab) are the sync indicator's.
  engine.subscribeEvents((event) => {
    if (!ours.has(event.op.id)) return;
    if (event.type === 'settled') {
      const value = event.value as ReviewActionResponse | undefined;
      const undoable = value !== undefined && value.outcome !== 'dry_run' && state.meta?.capabilities.undo === true;
      dispatch({ type: 'SAVE_SETTLED', requestId: event.op.id, undoable });
      onSaved();
    } else if (event.type === 'refused') {
      dispatch({
        type: 'SAVE_REFUSED',
        requestId: event.op.id,
        kind: event.op.lastErrorCode === 'conflict' ? 'conflict' : 'save',
        message: event.op.lastError ?? 'That answer could not be saved.',
      });
    }
  });

  const runUndo = async (reviewRequestId: string) => {
    if (undoRequest?.of !== reviewRequestId) undoRequest = { of: reviewRequestId, requestId: newRequestId() };
    try {
      await api.undoAction({ reviewRequestId, requestId: undoRequest.requestId });
      dispatch({ type: 'UNDO_SUCCEEDED' });
      onSaved();
    } catch (error) {
      const final = error instanceof ApiError && UNDO_IS_OVER.has(error.code);
      dispatch({ type: 'UNDO_FAILED', message: messageOf(error), final });
    }
  };

  /**
   * What this device still has to show for the requested queue: the sitting in
   * progress first (it carries everything), then the last queue the server
   * sent, with the cards already answered taken out.
   */
  const restore = async (): Promise<
    | { kind: 'snapshot'; snapshot: SessionSnapshot }
    | { kind: 'queue'; cards: SessionState['cards']; meta: SessionMeta }
    | null
  > => {
    const snapshot = await store.kv.get<SessionSnapshot>(`${accountId}:session`);
    if (
      snapshot !== null &&
      snapshot.version === 1 &&
      snapshot.focus === focus &&
      snapshot.collection === collection &&
      snapshot.meta !== null &&
      now() - snapshot.savedAt < MAX_SNAPSHOT_AGE_MS
    ) {
      return { kind: 'snapshot', snapshot };
    }

    const cache = await store.kv.get<QueueCache>(`${accountId}:queue:${focusKey(focus, collection)}`);
    if (cache === null || cache.version !== 1) return null;
    const { cards: cachedCards, ...cachedMeta } = cache.response;
    const response = cache.response;
    const today = calendarDateInTimeZone(new Date(now()), response.timeZone);
    const answered = answeredCards(await engine.ops(), cache.cachedAt);
    let cards = cachedCards.filter((card) => !answered.has(card.id));
    if (response.today !== today) {
      // The queue was fetched on an earlier day. A word that has stopped being
      // due since then is left out; a weak review may still take one early.
      cards = cards.filter(
        (card) =>
          checkEligibility(
            { mastery: card.mastery, nextReview: card.dueOn ?? card.nextReview },
            today,
            reviewRules,
            { allowNotDue: focus === 'weak' },
          ).eligible,
      );
    }
    return { kind: 'queue', cards, meta: { ...cachedMeta, today } };
  };

  /**
   * A freshly loaded queue is a new sitting, but answers an earlier sitting
   * could not save are still in the outbox. They are adopted here — one list
   * for the account — so they can be retried or dismissed instead of only
   * being counted by the sync indicator.
   */
  const adoptRefusals = async (cards: SessionState['cards']): Promise<void> => {
    const failed = (await engine.ops()).filter((op) => isReviewOp(op) && op.status === 'failed');
    if (failed.length === 0) return;
    const refused: RefusedAnswer[] = failed.map((op) => {
      const payload = op.payload as unknown as ReviewActionPayload;
      return {
        // The card was already answered, so it is not in this queue. No Undo
        // is offered for it: that needs an index this sitting never had.
        index: cards.length,
        word: payload.word,
        action: payload.action,
        requestId: op.id,
        durationMs: payload.durationMs ?? 0,
        confidence: payload.confidence ?? null,
        kind: op.lastErrorCode === 'conflict' ? 'conflict' : 'save',
        message: op.lastError ?? 'That answer could not be saved.',
      };
    });
    for (const answer of refused) ours.add(answer.requestId);
    dispatch({ type: 'ADOPT_REFUSALS', refused });
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async load(options) {
      if (state.undoing) return;
      if (options !== undefined) {
        collection = options.collection ?? null;
        // One selection at a time: a collection takes the place of a focus.
        focus = collection === null ? options.focus : null;
      }
      // A newer load supersedes any still in flight.
      const sequence = ++loadSequence;
      // Clean up any existing timer and visibility handler before starting fresh
      if (timer !== null) stopTimer(timer.cardId);
      cleanupVisibilityHandler();
      dispatch({ type: 'LOAD' });
      try {
        const response = await api.fetchQueue(collection === null ? { focus } : { focus: null, collection });
        if (sequence !== loadSequence) return;
        // A freshly loaded queue is a new sitting.
        sessionId = newRequestId();
        const { cards, ...meta } = response;
        dispatch({ type: 'LOAD_SUCCEEDED', cards, meta });
        cacheQueue(response);
        // Set up visibility handler after successful load
        setupVisibilityHandler();
        // Refusals from an earlier sitting stay answerable here.
        await adoptRefusals(cards);
      } catch (error) {
        if (sequence !== loadSequence) return;
        const unreachable = error instanceof ApiError && (error.code === 'network' || error.code === 'timeout');
        if (unreachable) {
          const restored = await restore().catch(() => null);
          if (sequence !== loadSequence) return;
          if (restored?.kind === 'snapshot') {
            const { snapshot } = restored;
            sessionId = snapshot.sessionId;
            dispatch({
              type: 'LOAD_RESTORED',
              cards: snapshot.cards,
              meta: snapshot.meta,
              index: snapshot.index,
              tally: snapshot.tally,
              pending: snapshot.pending,
              refused: snapshot.refused,
              lastSaved: snapshot.lastSaved,
            });
            for (const answer of [...snapshot.pending, ...snapshot.refused]) ours.add(answer.requestId);
            setupVisibilityHandler();
            return;
          }
          if (restored?.kind === 'queue') {
            sessionId = newRequestId();
            dispatch({ type: 'LOAD_SUCCEEDED', cards: restored.cards, meta: restored.meta, source: 'cache' });
            setupVisibilityHandler();
            await adoptRefusals(restored.cards);
            return;
          }
        }
        dispatch({
          type: 'LOAD_FAILED',
          message: messageOf(error),
          unauthorized: error instanceof ApiError && error.code === 'unauthorized',
        });
      }
    },

    flip() {
      dispatch({ type: 'FLIP' });
    },

    rateConfidence(level) {
      // Where the rating would not be stored, it is not asked for at all.
      if (state.meta?.capabilities.confidence !== true || !state.meta.writesEnabled) return false;
      return dispatch({ type: 'RATE_CONFIDENCE', level });
    },

    grade(action) {
      const card = currentCard(state);
      if (card === null) return false;
      const elapsed = stopTimer(card.id);
      const durationMs = Math.min(Math.max(elapsed, 0), MAX_DURATION_MS);
      const done = startTiming('review.advance');
      const requestId = newRequestId();
      const accepted = dispatch({ type: 'GRADE', action, requestId, durationMs });
      done();
      if (!accepted) return false;
      const recorded = state.pending[state.pending.length - 1];
      ours.add(requestId);
      const payload: ReviewActionPayload = {
        pageId: card.id,
        action,
        expected: { mastery: card.mastery, nextReview: card.nextReview },
        sessionId,
        durationMs,
        focus,
        confidence: recorded?.confidence ?? null,
        // Local detail only, never sent: names the card in notices.
        word: card.word,
      };
      engine.enqueue({ id: requestId, kind: 'review_action', entity: card.id, payload });
      return true;
    },

    retryRefusal(requestId) {
      if (!dispatch({ type: 'RETRY_SAVE', requestId })) return;
      engine.retry(requestId);
    },

    dismissRefusal(requestId) {
      dispatch({ type: 'DISMISS_REFUSAL', requestId });
      engine.dismiss(requestId);
    },

    undo() {
      const target = state.lastSaved;
      if (target === null || !dispatch({ type: 'UNDO' })) return false;
      void runUndo(target.requestId);
      return true;
    },

    sessionId: () => sessionId,
  };
}
