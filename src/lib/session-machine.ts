/**
 * The review session as a pure state machine. `transition` returns the SAME
 * object for any event that is not valid in the current state, which is how
 * invalid transitions (grading an unflipped card, a second submit while one is
 * in flight) are ruled out rather than merely discouraged.
 */
import type { Confidence, QueueResponse, ReviewCard } from '../../shared/api.js';
import type { ReviewAction } from '../../shared/review-logic.js';

export type SessionStatus = 'loading' | 'ready' | 'flipped' | 'saving' | 'error' | 'completed';

export type SessionMeta = Omit<QueueResponse, 'cards'>;

export type SessionError =
  | { kind: 'load'; message: string; unauthorized: boolean }
  /** The save failed or went unconfirmed. The same answer can be retried. */
  | { kind: 'save'; message: string }
  /** The record changed elsewhere. The card on screen is stale and cannot be graded. */
  | { kind: 'conflict'; message: string };

export interface SessionTally {
  remember: number;
  notRemember: number;
  skipped: number;
}

export interface SessionState {
  status: SessionStatus;
  cards: ReviewCard[];
  /** Position of the current card; equals `cards.length` once completed. */
  index: number;
  meta: SessionMeta | null;
  tally: SessionTally;
  /** The answer being saved, kept through a failure so Retry repeats exactly it. */
  pendingAction: ReviewAction | null;
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
  | { type: 'LOAD_SUCCEEDED'; cards: ReviewCard[]; meta: SessionMeta }
  | { type: 'LOAD_FAILED'; message: string; unauthorized: boolean }
  | { type: 'FLIP' }
  /** Says how sure the reviewer is and shows the answer. Only before the answer has been seen. */
  | { type: 'RATE_CONFIDENCE'; level: Confidence }
  | { type: 'GRADE'; action: ReviewAction }
  /** `requestId` is given only when the answer was really saved and can be undone. */
  | { type: 'SAVE_SUCCEEDED'; requestId?: string }
  | { type: 'SAVE_FAILED'; message: string }
  | { type: 'SAVE_CONFLICT'; message: string }
  | { type: 'RETRY_SAVE' }
  | { type: 'CANCEL_SAVE' }
  | { type: 'SKIP_CARD' }
  | { type: 'UNDO' }
  | { type: 'UNDO_SUCCEEDED' }
  /** `final` when the answer can no longer be undone at all, so the offer is withdrawn. */
  | { type: 'UNDO_FAILED'; message: string; final: boolean };

export const initialSessionState: SessionState = {
  status: 'loading',
  cards: [],
  index: 0,
  meta: null,
  tally: { remember: 0, notRemember: 0, skipped: 0 },
  pendingAction: null,
  error: null,
  lastSaved: null,
  undoing: false,
  undoError: null,
  confidence: null,
  revealed: false,
};

/** Whether the latest saved answer can be taken back right now. */
export function canUndo(state: SessionState): boolean {
  const settled = state.status === 'ready' || state.status === 'flipped' || state.status === 'completed';
  return state.lastSaved !== null && !state.undoing && settled;
}

export function currentCard(state: SessionState): ReviewCard | null {
  return state.cards[state.index] ?? null;
}

/** Moves past the current card, always arriving on the front of the next one. */
function advance(state: SessionState, tally: SessionTally): SessionState {
  const index = state.index + 1;
  return {
    ...state,
    status: index >= state.cards.length ? 'completed' : 'ready',
    index,
    tally,
    pendingAction: null,
    error: null,
    // A new card: nothing has been said about it, and nothing shown.
    confidence: null,
    revealed: false,
  };
}

export function transition(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'LOAD':
      // Never abandon a save in flight: its outcome would be unknown.
      if (state.status === 'saving') return state;
      return { ...initialSessionState, meta: state.meta };

    case 'LOAD_SUCCEEDED':
      if (state.status !== 'loading') return state;
      return {
        ...initialSessionState,
        status: event.cards.length === 0 ? 'completed' : 'ready',
        cards: event.cards,
        meta: event.meta,
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

    case 'GRADE':
      // Not while an Undo is in flight: it is about to move the session back a card.
      if (state.status !== 'flipped' || state.undoing) return state;
      return { ...state, status: 'saving', pendingAction: event.action, undoError: null };

    case 'SAVE_SUCCEEDED': {
      if (state.status !== 'saving' || state.pendingAction === null) return state;
      const key = state.pendingAction === 'remember' ? 'remember' : 'notRemember';
      const lastSaved =
        event.requestId === undefined
          ? null
          : { index: state.index, action: state.pendingAction, requestId: event.requestId };
      return { ...advance(state, { ...state.tally, [key]: state.tally[key] + 1 }), lastSaved, undoError: null };
    }

    case 'SAVE_FAILED':
      if (state.status !== 'saving') return state;
      return { ...state, status: 'error', error: { kind: 'save', message: event.message } };

    case 'SAVE_CONFLICT':
      if (state.status !== 'saving') return state;
      return { ...state, status: 'error', error: { kind: 'conflict', message: event.message } };

    case 'RETRY_SAVE':
      if (state.status !== 'error' || state.error?.kind !== 'save' || state.pendingAction === null) {
        return state;
      }
      return { ...state, status: 'saving', error: null };

    case 'CANCEL_SAVE':
      if (state.status !== 'error' || state.error?.kind !== 'save') return state;
      return { ...state, status: 'flipped', pendingAction: null, error: null };

    case 'SKIP_CARD':
      if (state.status !== 'error' || state.error?.kind !== 'conflict') return state;
      // Going back past a skipped card would only meet the same conflict again.
      return { ...advance(state, { ...state.tally, skipped: state.tally.skipped + 1 }), lastSaved: null };

    case 'UNDO':
      if (!canUndo(state)) return state;
      return { ...state, undoing: true, undoError: null };

    case 'UNDO_SUCCEEDED': {
      if (!state.undoing || state.lastSaved === null) return state;
      const key = state.lastSaved.action === 'remember' ? 'remember' : 'notRemember';
      return {
        ...state,
        // Back on the card that was answered, unflipped, as if it had just come up.
        status: 'ready',
        index: state.lastSaved.index,
        tally: { ...state.tally, [key]: Math.max(0, state.tally[key] - 1) },
        pendingAction: null,
        error: null,
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
