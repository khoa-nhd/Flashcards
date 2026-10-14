/**
 * Owns the session state and runs its side effects (loading, saving). State
 * lives in a plain variable rather than React state so every transition is
 * synchronous: two key presses in the same tick see each other's effect, and
 * the second one finds the machine already `saving`.
 */
import type { Confidence, ReviewFocus } from '../../shared/api.js';
import type { ReviewAction } from '../../shared/review-logic.js';
import { ApiError, type ReviewApi } from './api-client.js';
import { startTiming } from './perf.js';
import { newRequestId } from './request-id.js';
import {
  currentCard,
  initialSessionState,
  transition,
  type PendingAnswer,
  type SessionEvent,
  type SessionState,
} from './session-machine.js';
import { enqueueReviewAction, enqueueReviewUndo, type MutationQueue, type ReviewActionMutation, type ReviewUndoMutation, getGlobalTestMode } from './mutation-queue.js';

export interface SessionController {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /**
   * (Re)loads the queue. Reads only; never changes review data. Given a focus
   * (or `null` for everything due) it switches to it; given nothing, it keeps
   * the one in use, which is what Refresh wants.
   */
  load(options?: { focus: ReviewFocus | null; collection?: string | null }): Promise<void>;
  flip(): void;
  /**
   * Records how sure the reviewer is and shows the answer. Returns false when
   * it was not accepted: the answer has already been seen, or the store does
   * not keep ratings.
   */
  rateConfidence(level: Confidence): boolean;
  /** Returns false when the answer was not accepted (card not flipped, save in flight…). */
  grade(action: ReviewAction): boolean;
  retrySave(): void;
  cancelSave(): void;
  skipCard(): void;
  /** Takes back the latest saved answer. Returns false when there is nothing that can be undone now. */
  undo(): boolean;
  /** The sitting in progress: every answer since the queue was last loaded. */
  sessionId(): string;
}

const messageOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Something unexpected went wrong.';

/** The longest time on one card worth recording; anything more is a tab left open. */
const MAX_DURATION_MS = 86_400_000;

/** Failures after which trying the same Undo again cannot succeed. */
const UNDO_IS_OVER = new Set(['conflict', 'not_found', 'not_supported', 'read_only']);

/** Internal timer for tracking active review time per card. */
interface ReviewTimer {
  /** The card id this timer belongs to. */
  cardId: string;
  /** Accumulated active time in milliseconds. */
  accumulatedMs: number;
  /** Monotonic timestamp when the timer was last started, or null if paused. */
  startedAt: number | null;
}

export function createSessionController(
  api: Pick<ReviewApi, 'fetchQueue' | 'submitAction' | 'undoAction'>,
  /** Called once an answer is confirmed as saved, so other views know their data has changed. */
  onSaved: () => void = () => {},
  /** Optional mutation queue for offline-first persistence. If not provided, falls back to direct API calls. */
  mutationQueue?: MutationQueue,
): SessionController {
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
  const listeners = new Set<() => void>();

  /** Start or resume the timer for a card. */
  const startTimer = (cardId: string) => {
    if (timer?.cardId === cardId && timer.startedAt !== null) {
      // Already running for this card
      return;
    }
    const now = performance.now();
    if (timer?.cardId === cardId) {
      // Resuming existing timer for same card
      timer.startedAt = now;
    } else {
      // New card
      timer = { cardId, accumulatedMs: 0, startedAt: now };
    }
  };

  /** Pause the timer for a card, accumulating elapsed active time. */
  const pauseTimer = (cardId: string) => {
    if (timer?.cardId === cardId && timer.startedAt !== null) {
      const now = performance.now();
      timer.accumulatedMs += now - timer.startedAt;
      timer.startedAt = null;
    }
  };

  /** Get the total active time for the current card and stop the timer. */
  const stopTimer = (cardId: string): number => {
    if (timer?.cardId === cardId) {
      if (timer.startedAt !== null) {
        const now = performance.now();
        timer.accumulatedMs += now - timer.startedAt;
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
    
    for (const listener of listeners) listener();
    return true;
  };

  // Mutation queue handlers - these execute the actual API calls
  const executeReviewAction = async (payload: ReviewActionMutation['payload']): Promise<unknown> => {
    const card = state.cards.find((c) => c.id === payload.pageId);
    if (!card) {
      throw new Error('Card no longer in queue');
    }
    const response = await api.submitAction({
      pageId: card.id,
      action: payload.action,
      expected: { mastery: card.mastery, nextReview: card.nextReview },
      requestId: payload.requestId,
      durationMs: payload.durationMs,
      sessionId: payload.sessionId,
      ...(payload.confidence === null ? {} : { confidence: payload.confidence }),
    });
    return response;
  };

  const executeReviewUndo = async (payload: ReviewUndoMutation['payload']): Promise<unknown> => {
    const response = await api.undoAction({
      reviewRequestId: payload.reviewRequestId,
      requestId: payload.requestId,
    });
    return response;
  };

  // Register handlers if mutation queue is provided and not in test mode
  const inTestMode = getGlobalTestMode();
  if (mutationQueue && !inTestMode) {
    mutationQueue.registerHandler<ReviewActionMutation['payload']>('review_action', executeReviewAction);
    mutationQueue.registerHandler<ReviewUndoMutation['payload']>('review_undo', executeReviewUndo);
  }

  const save = async (attempt: PendingAnswer) => {
    const card = state.cards[attempt.index];
    if (card === undefined) {
      dispatch({ type: 'SAVE_FAILED', requestId: attempt.requestId, message: 'That card is no longer in the queue.' });
      return;
    }

    if (mutationQueue && !inTestMode) {
      // Enqueue for background sync - UI already updated optimistically
      await enqueueReviewAction(mutationQueue, {
        pageId: card.id,
        action: attempt.action,
        expected: { mastery: card.mastery, nextReview: card.nextReview },
        requestId: attempt.requestId,
        durationMs: attempt.durationMs,
        sessionId,
        confidence: attempt.confidence,
      });
      // The mutation queue will handle retry, conflict, etc. via its own logic
      // We still call onSaved to mark vocabulary as stale for other views
      onSaved();
    } else {
      // Direct API call (for tests or non-queue mode)
      const done = startTiming('review.save');
      try {
        const response = await api.submitAction({
          pageId: card.id,
          action: attempt.action,
          expected: { mastery: card.mastery, nextReview: card.nextReview },
          requestId: attempt.requestId,
          durationMs: attempt.durationMs,
          sessionId,
          ...(attempt.confidence === null ? {} : { confidence: attempt.confidence }),
        });
        const undoable = response.outcome !== 'dry_run' && state.meta?.capabilities.undo === true;
        dispatch({ type: 'SAVE_SETTLED', requestId: attempt.requestId, undoable });
        onSaved();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'conflict') {
          dispatch({ type: 'SAVE_CONFLICT', requestId: attempt.requestId, message: error.message });
        } else {
          dispatch({ type: 'SAVE_FAILED', requestId: attempt.requestId, message: messageOf(error) });
        }
      } finally {
        done();
      }
    }
  };

  const runUndo = async (reviewRequestId: string) => {
    if (undoRequest?.of !== reviewRequestId) undoRequest = { of: reviewRequestId, requestId: newRequestId() };

    // In test mode, use direct API calls to maintain test compatibility
    const inTestMode = getGlobalTestMode();

    if (mutationQueue && !inTestMode) {
      await enqueueReviewUndo(mutationQueue, {
        reviewRequestId,
        requestId: undoRequest.requestId,
      });
      onSaved();
    } else {
      try {
        await api.undoAction({ reviewRequestId, requestId: undoRequest.requestId });
        dispatch({ type: 'UNDO_SUCCEEDED' });
        onSaved();
      } catch (error) {
        const final = error instanceof ApiError && UNDO_IS_OVER.has(error.code);
        dispatch({ type: 'UNDO_FAILED', message: messageOf(error), final });
      }
    }
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async load(options) {
      if (state.saving !== null) return;
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
        const { cards, ...meta } = await api.fetchQueue(collection === null ? { focus } : { focus: null, collection });
        if (sequence !== loadSequence) return;
        // A freshly loaded queue is a new sitting.
        sessionId = newRequestId();
        dispatch({ type: 'LOAD_SUCCEEDED', cards, meta });
        // Set up visibility handler after successful load
        setupVisibilityHandler();
      } catch (error) {
        if (sequence !== loadSequence) return;
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
      const elapsed = card === null ? 0 : stopTimer(card.id);
      const durationMs = Math.min(Math.max(elapsed, 0), MAX_DURATION_MS);
      const done = startTiming('review.advance');
      const accepted = dispatch({ type: 'GRADE', action, requestId: newRequestId(), durationMs });
      done();
      if (!accepted) return false;
      // The answer is already counted and the next card is up; the write happens behind that.
      const attempt = state.saving;
      if (attempt !== null) void save(attempt);
      return true;
    },

    retrySave() {
      const attempt = state.failed;
      if (attempt === null || !dispatch({ type: 'RETRY_SAVE' })) return;
      void save(attempt);
    },

    cancelSave() {
      dispatch({ type: 'CANCEL_SAVE' });
    },

    skipCard() {
      dispatch({ type: 'SKIP_CARD' });
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