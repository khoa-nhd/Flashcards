/**
 * The review session as a pure state machine. `transition` returns the SAME
 * object for any event that is not valid in the current state, which is how
 * invalid transitions (grading an unflipped card, a second answer while one is
 * being undone) are ruled out rather than merely discouraged.
 *
 * An answer advances the session the moment it is given: it is recorded
 * locally, the next card comes up, and its write happens behind that. Nothing
 * the server does can hold the next answer up, so any number of answers can be
 * in flight at once. Each answer is one entry in `pending` until the server
 * confirms it; an answer the server refuses leaves `pending` and waits in
 * `refused`, listed but never in the way.
 */
import type { Confidence, QueueResponse, ReviewCard } from '../../shared/api.js';
import type { ReviewAction } from '../../shared/review-logic.js';

export type SessionStatus = 'loading' | 'ready' | 'flipped' | 'error' | 'completed';

export type SessionMeta = Omit<QueueResponse, 'cards'>;

export type SessionError = { kind: 'load'; message: string; unauthorized: boolean };

export interface SessionTally {
  remember: number;
  notRemember: number;
  skipped: number;
}

/** One answer that has been accepted locally and is not confirmed by the server yet. */
export interface PendingAnswer {
  /** Where its card sat in the queue. */
  index: number;
  /** The word, so a notice can name it without the card. */
  word: string;
  action: ReviewAction;
  /** The id the answer is saved under: what a retry repeats and what Undo names. */
  requestId: string;
  /** How long the card was on screen. Sent again unchanged if the answer is retried. */
  durationMs: number;
  /** The confidence rating given before seeing the answer, if any. */
  confidence: Confidence | null;
}

/** An answer the server refused: listed for a decision, never in the way. */
export interface RefusedAnswer extends PendingAnswer {
  kind: 'save' | 'conflict';
  message: string;
}

export interface SessionState {
  status: SessionStatus;
  cards: ReviewCard[];
  /** Position of the current card; equals `cards.length` once completed. */
  index: number;
  meta: SessionMeta | null;
  /** Where the queue came from: the server, or this device's own storage when it could not be reached. */
  source: 'server' | 'cache';
  tally: SessionTally;
  /** Answers accepted locally that the server has not confirmed yet. */
  pending: PendingAnswer[];
  /** Answers the server refused, waiting for a retry or a dismissal. */
  refused: RefusedAnswer[];
  error: SessionError | null;
  /** The latest answer the server confirmed, for as long as it can be taken back. */
  lastSaved: SavedAnswer | null;
  /** An Undo is on its way to the server. */
  undoing: boolean;
  /** Why the last Undo did not happen. */
  undoError: string | null;
  /**
   * How sure the reviewer said they were about the current card, before
   * seeing its answer. Sent with the answer; it never changes what the answer does.
   */
  confidence: Confidence | null;
  /**
   * The current card's answer has been shown at least once. From then on a
   * confidence rating would be hindsight, so none is accepted.
   */
  revealed: boolean;
}

export interface SavedAnswer {
  /** Where its card sits in the queue, so Undo can return to it. */
  index: number;
  action: ReviewAction;
  /** The id the answer was saved under: what Undo names. */
  requestId: string;
}

export type SessionEvent =
  | { type: 'LOAD' }
  | { type: 'LOAD_SUCCEEDED'; cards: ReviewCard[]; meta: SessionMeta; source?: 'server' | 'cache' }
  /** The queue came back from this device's own storage: the sitting goes on where it stopped. */
  | {
      type: 'LOAD_RESTORED';
      cards: ReviewCard[];
      meta: SessionMeta;
      index: number;
      tally: SessionTally;
      pending: PendingAnswer[];
      refused: RefusedAnswer[];
      lastSaved: SavedAnswer | null;
    }
  | { type: 'LOAD_FAILED'; message: string; unauthorized: boolean }
  | { type: 'FLIP' }
  /** Says how sure the reviewer is and shows the answer. Only before the answer has been seen. */
  | { type: 'RATE_CONFIDENCE'; level: Confidence }
  /** The answer is accepted at once; the card moves on while the write waits its turn. */
  | { type: 'GRADE'; action: ReviewAction; requestId: string; durationMs: number }
  /** The server confirmed the answer (or an earlier retry of it). */
  | { type: 'SAVE_SETTLED'; requestId: string; undoable: boolean }
  /** The server refused the answer. It moves to the refused list, out of the way. */
  | { type: 'SAVE_REFUSED'; requestId: string; kind: 'save' | 'conflict'; message: string }
  /**
   * Answers an earlier sitting could not save are still in the outbox; this
   * sitting adopts them so they can be retried or dismissed here.
   */
  | { type: 'ADOPT_REFUSALS'; refused: RefusedAnswer[] }
  /** Sends a refused answer again. */
  | { type: 'RETRY_SAVE'; requestId: string }
  /** Gives up on a refused answer for good. */
  | { type: 'DISMISS_REFUSAL'; requestId: string }
  | { type: 'UNDO' }
  | { type: 'UNDO_SUCCEEDED' }
  /** `final` when the answer can no longer be undone at all, so the offer is withdrawn. */
  | { type: 'UNDO_FAILED'; message: string; final: boolean };

export const initialSessionState: SessionState = {
  status: 'loading',
  cards: [],
  index: 0,
  meta: null,
  source: 'server',
  tally: { remember: 0, notRemember: 0, skipped: 0 },
  pending: [],
  refused: [],
  error: null,
  lastSaved: null,
  undoing: false,
  undoError: null,
  confidence: null,
  revealed: false,
};

const tallyKey = (action: ReviewAction): 'remember' | 'notRemember' =>
  action === 'remember' ? 'remember' : 'notRemember';

/** How many answers are waiting for the server. */
export function pendingCount(state: SessionState): number {
  return state.pending.length;
}

/** Whether any answer has been accepted and not confirmed yet. */
export function isSaving(state: SessionState): boolean {
  return state.pending.length > 0;
}

/** Whether the latest saved answer can be taken back right now. */
export function canUndo(state: SessionState): boolean {
  const settled = state.status === 'ready' || state.status === 'flipped' || state.status === 'completed';
  return (
    state.lastSaved !== null &&
    !state.undoing &&
    settled &&
    // Only the card just before the current position can be taken back, so a
    // card that was skipped in between is never stepped over.
    state.lastSaved.index === state.index - 1
  );
}

export function currentCard(state: SessionState): ReviewCard | null {
  return state.cards[state.index] ?? null;
}

export function transition(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'LOAD':
      // A new queue is a new sitting. Answers already given are not lost:
      // their writes are in the outbox, and the sync indicator still counts
      // them, while refusals stay in the account-wide list.
      return { ...initialSessionState, meta: state.meta };

    case 'LOAD_SUCCEEDED':
      if (state.status !== 'loading') return state;
      return {
        ...initialSessionState,
        status: event.cards.length === 0 ? 'completed' : 'ready',
        cards: event.cards,
        meta: event.meta,
        source: event.source ?? 'server',
      };

    case 'LOAD_RESTORED':
      if (state.status !== 'loading') return state;
      return {
        ...initialSessionState,
        status: event.index >= event.cards.length ? 'completed' : 'ready',
        cards: event.cards,
        meta: event.meta,
        source: 'cache',
        index: event.index,
        tally: event.tally,
        pending: event.pending,
        refused: event.refused,
        lastSaved: event.lastSaved,
      };

    case 'LOAD_FAILED':
      if (state.status !== 'loading') return state;
      return {
        ...state,
        status: 'error',
        error: { kind: 'load', message: event.message, unauthorized: event.unauthorized },
      };

    case 'FLIP':
      if (state.status === 'ready') return { ...state, status: 'flipped', revealed: true };
      if (state.status === 'flipped') return { ...state, status: 'ready' };
      return state;

    case 'RATE_CONFIDENCE':
      if (state.status !== 'ready' || state.revealed) return state;
      return { ...state, status: 'flipped', revealed: true, confidence: event.level };

    case 'GRADE': {
      // Nothing but an unflipped card or an Undo in flight can refuse an answer:
      // an earlier answer still on its way never holds this one up.
      if (state.status !== 'flipped' || state.undoing) return state;
      const index = state.index;
      const key = tallyKey(event.action);
      const next = index + 1;
      return {
        ...state,
        // The card moves on at once. `pending` is what still has to be confirmed.
        status: next >= state.cards.length ? 'completed' : 'ready',
        index: next,
        tally: { ...state.tally, [key]: state.tally[key] + 1 },
        pending: [
          ...state.pending,
          {
            index,
            word: state.cards[index]?.word ?? '',
            action: event.action,
            requestId: event.requestId,
            durationMs: event.durationMs,
            confidence: state.confidence,
          },
        ],
        confidence: null,
        revealed: false,
      };
    }

    case 'SAVE_SETTLED': {
      const waiting = state.pending.find((answer) => answer.requestId === event.requestId);
      const refused = state.refused.find((answer) => answer.requestId === event.requestId);
      if (waiting === undefined && refused === undefined) return state;
      const settled = waiting ?? refused!;
      const key = tallyKey(settled.action);
      return {
        ...state,
        pending: state.pending.filter((answer) => answer.requestId !== event.requestId),
        refused: state.refused.filter((answer) => answer.requestId !== event.requestId),
        // A retried refusal counts again now that it has really been saved.
        tally:
          refused === undefined
            ? state.tally
            : {
                ...state.tally,
                [key]: state.tally[key] + 1,
                skipped: Math.max(0, state.tally.skipped - 1),
              },
        lastSaved: event.undoable
          ? { index: settled.index, action: settled.action, requestId: settled.requestId }
          : state.lastSaved,
      };
    }

    case 'SAVE_REFUSED': {
      const waiting = state.pending.find((answer) => answer.requestId === event.requestId);
      if (waiting === undefined) return state;
      const key = tallyKey(waiting.action);
      return {
        ...state,
        pending: state.pending.filter((answer) => answer.requestId !== event.requestId),
        refused: [...state.refused, { ...waiting, kind: event.kind, message: event.message }],
        // The answer was never saved, so it is not counted as an answer.
        tally: {
          ...state.tally,
          [key]: Math.max(0, state.tally[key] - 1),
          skipped: state.tally.skipped + 1,
        },
      };
    }

    case 'ADOPT_REFUSALS': {
      // One an answer already known here is not listed twice.
      const known = new Set([...state.pending, ...state.refused].map((answer) => answer.requestId));
      const adopted = event.refused.filter((answer) => !known.has(answer.requestId));
      if (adopted.length === 0) return state;
      return { ...state, refused: [...state.refused, ...adopted] };
    }

    case 'RETRY_SAVE': {
      const refused = state.refused.find((answer) => answer.requestId === event.requestId);
      if (refused === undefined) return state;
      const key = tallyKey(refused.action);
      // Out of the refused list and back among the answers waiting to be saved.
      const answer: PendingAnswer = {
        index: refused.index,
        word: refused.word,
        action: refused.action,
        requestId: refused.requestId,
        durationMs: refused.durationMs,
        confidence: refused.confidence,
      };
      return {
        ...state,
        refused: state.refused.filter((entry) => entry.requestId !== event.requestId),
        pending: [...state.pending, answer],
        // On its way again, so it counts again; a second refusal puts it back.
        tally: {
          ...state.tally,
          [key]: state.tally[key] + 1,
          skipped: Math.max(0, state.tally.skipped - 1),
        },
      };
    }

    case 'DISMISS_REFUSAL':
      if (!state.refused.some((answer) => answer.requestId === event.requestId)) return state;
      return { ...state, refused: state.refused.filter((answer) => answer.requestId !== event.requestId) };

    case 'UNDO':
      if (!canUndo(state)) return state;
      return { ...state, undoing: true, undoError: null };

    case 'UNDO_SUCCEEDED': {
      if (!state.undoing || state.lastSaved === null) return state;
      const key = tallyKey(state.lastSaved.action);
      return {
        ...state,
        // Back on the card that was answered, unflipped, as if it had just come up.
        status: 'ready',
        index: state.lastSaved.index,
        tally: { ...state.tally, [key]: Math.max(0, state.tally[key] - 1) },
        lastSaved: null,
        undoing: false,
        undoError: null,
        // Its answer was on screen a moment ago: a rating given now would not be a prediction.
        confidence: null,
        revealed: true,
      };
    }

    case 'UNDO_FAILED':
      if (!state.undoing) return state;
      return { ...state, undoing: false, undoError: event.message, lastSaved: event.final ? null : state.lastSaved };
  }
}
