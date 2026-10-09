/**
 * The review session as a pure state machine. `transition` returns the SAME
 * object for any event that is not valid in the current state, which is how
 * invalid transitions (grading an unflipped card, a second submit while one is
 * in flight) are ruled out rather than merely discouraged.
 */
import type { QueueResponse, ReviewCard } from '../../shared/api.js';
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
}

export type SessionEvent =
  | { type: 'LOAD' }
  | { type: 'LOAD_SUCCEEDED'; cards: ReviewCard[]; meta: SessionMeta }
  | { type: 'LOAD_FAILED'; message: string; unauthorized: boolean }
  | { type: 'FLIP' }
  | { type: 'GRADE'; action: ReviewAction }
  | { type: 'SAVE_SUCCEEDED' }
  | { type: 'SAVE_FAILED'; message: string }
  | { type: 'SAVE_CONFLICT'; message: string }
  | { type: 'RETRY_SAVE' }
  | { type: 'CANCEL_SAVE' }
  | { type: 'SKIP_CARD' };

export const initialSessionState: SessionState = {
  status: 'loading',
  cards: [],
  index: 0,
  meta: null,
  tally: { remember: 0, notRemember: 0, skipped: 0 },
  pendingAction: null,
  error: null,
};

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
      if (state.status === 'ready') return { ...state, status: 'flipped' };
      if (state.status === 'flipped') return { ...state, status: 'ready' };
      return state;

    case 'GRADE':
      if (state.status !== 'flipped') return state;
      return { ...state, status: 'saving', pendingAction: event.action };

    case 'SAVE_SUCCEEDED': {
      if (state.status !== 'saving' || state.pendingAction === null) return state;
      const key = state.pendingAction === 'remember' ? 'remember' : 'notRemember';
      return advance(state, { ...state.tally, [key]: state.tally[key] + 1 });
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
      return advance(state, { ...state.tally, skipped: state.tally.skipped + 1 });
  }
}
