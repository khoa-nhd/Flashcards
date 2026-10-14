/**
 * The review session as a pure state machine. `transition` returns the SAME
 * object for any event that is not valid in the current state, which is how
 * invalid transitions (grading an unflipped card, a second answer while one is
 * still being saved) are ruled out rather than merely discouraged.
 *
 * An answer advances the session at once: the next card is on screen before the
 * server has confirmed the write. `saving` is the one answer in flight, and
 * `failed` the one the server would not take, so the interface can always tell
 * a pending write from a confirmed one and never shows an unsaved answer as if
 * it were saved.
 */
import type { Confidence, QueueResponse, ReviewCard } from '../../shared/api.js';
import type { ReviewAction } from '../../shared/review-logic.js';

export type SessionStatus = 'loading' | 'ready' | 'flipped' | 'error' | 'completed';

export type SessionMeta = Omit<QueueResponse, 'cards'>;

export type SessionError =
  | { kind: 'load'; message: string; unauthorized: boolean }
  /** The answer could not be saved. The same answer can be retried. */
  | { kind: 'save'; message: string }
  /** The record changed elsewhere. The answer was not saved and cannot be retried as-is. */
  | { kind: 'conflict'; message: string };

export interface SessionTally {
  remember: number;
  notRemember: number;
  skipped: number;
}

/** One answer that has been accepted but not yet confirmed by the server. */
export interface PendingAnswer {
  /** Where its card sat in the queue. */
  index: number;
  action: ReviewAction;
  /** The id the answer is saved under: what a retry repeats and what Undo names. */
  requestId: string;
  /** How long the card was on screen. Sent again unchanged if the answer is retried. */
  durationMs: number;
  /** The confidence rating given before seeing the answer, if any. */
  confidence: Confidence | null;
}

export interface SessionState {
  status: SessionStatus;
  cards: ReviewCard[];
  /** Position of the current card; equals `cards.length` once completed. */
  index: number;
  meta: SessionMeta | null;
  tally: SessionTally;
  /** The answer on its way to the server, if any. Its card has already been passed. */
  saving: PendingAnswer | null;
  /** An answer the server did not save, kept so Retry can repeat exactly it. */
  failed: PendingAnswer | null;
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
  /** The answer is accepted at once; the card moves on while the save is in flight. */
  | { type: 'GRADE'; action: ReviewAction; requestId: string; durationMs: number }
  /** `undoable` is given only when the answer was really saved and can be undone. */
  | { type: 'SAVE_SETTLED'; requestId: string; undoable: boolean }
  | { type: 'SAVE_FAILED'; requestId: string; message: string }
  | { type: 'SAVE_CONFLICT'; requestId: string; message: string }
  | { type: 'RETRY_SAVE' }
  /** Gives up on an answer that would not save, so the session can go on. */
  | { type: 'CANCEL_SAVE' }
  /** Passes a card whose record changed elsewhere; it counts as skipped. */
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
  saving: null,
  failed: null,
  error: null,
  lastSaved: null,
  undoing: false,
  undoError: null,
  confidence: null,
  revealed: false,
};

const tallyKey = (action: ReviewAction): 'remember' | 'notRemember' =>
  action === 'remember' ? 'remember' : 'notRemember';

/** True while an answer is on its way to the server. */
export function isSaving(state: SessionState): boolean {
  return state.saving !== null;
}

/** A save that needs the reviewer's attention before the session can go on. */
export function saveIssue(state: SessionState): Extract<SessionError, { kind: 'save' | 'conflict' }> | null {
  return state.error !== null && state.error.kind !== 'load' ? state.error : null;
}

/** Whether the latest saved answer can be taken back right now. */
export function canUndo(state: SessionState): boolean {
  const settled = state.status === 'ready' || state.status === 'flipped' || state.status === 'completed';
  return (
    state.lastSaved !== null &&
    !state.undoing &&
    state.saving === null &&
    state.error === null &&
    settled &&
    // Only the card just before the current position can be taken back, so a
    // card that was skipped or failed in between is never stepped over.
    state.lastSaved.index === state.index - 1
  );
}

export function currentCard(state: SessionState): ReviewCard | null {
  return state.cards[state.index] ?? null;
}

export function transition(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'LOAD':
      // Never abandon a save in flight: its outcome would be unknown.
      if (state.saving !== null) return state;
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

    case 'GRADE': {
      // One answer at a time, and nothing while a failed one is unresolved.
      if (state.status !== 'flipped' || state.undoing) return state;
      if (state.saving !== null || saveIssue(state) !== null) return state;
      const index = state.index;
      const key = tallyKey(event.action);
      const next = index + 1;
      return {
        ...state,
        // The card moves on at once. `saving` is what still has to be confirmed.
        status: next >= state.cards.length ? 'completed' : 'ready',
        index: next,
        tally: { ...state.tally, [key]: state.tally[key] + 1 },
        saving: {
          index,
          action: event.action,
          requestId: event.requestId,
          durationMs: event.durationMs,
          confidence: state.confidence,
        },
        failed: null,
        error: null,
        confidence: null,
        revealed: false,
      };
    }

    case 'SAVE_SETTLED': {
      if (state.saving === null || state.saving.requestId !== event.requestId) return state;
      const settled = state.saving;
      return {
        ...state,
        saving: null,
        error: null,
        lastSaved: event.undoable
          ? { index: settled.index, action: settled.action, requestId: settled.requestId }
          : state.lastSaved,
      };
    }

    case 'SAVE_FAILED':
      if (state.saving === null || state.saving.requestId !== event.requestId) return state;
      return {
        ...state,
        saving: null,
        failed: state.saving,
        error: { kind: 'save', message: event.message },
      };

    case 'SAVE_CONFLICT': {
      if (state.saving === null || state.saving.requestId !== event.requestId) return state;
      // The answer was never stored, so it is not an answer: the card changed
      // elsewhere and is counted as skipped, not remembered.
      const key = tallyKey(state.saving.action);
      return {
        ...state,
        saving: null,
        failed: state.saving,
        error: { kind: 'conflict', message: event.message },
        tally: {
          ...state.tally,
          [key]: Math.max(0, state.tally[key] - 1),
          skipped: state.tally.skipped + 1,
        },
      };
    }

    case 'RETRY_SAVE':
      if (state.error?.kind !== 'save' || state.failed === null || state.saving !== null) return state;
      return { ...state, saving: state.failed, failed: null, error: null };

    case 'CANCEL_SAVE': {
      if (state.error?.kind !== 'save') return state;
      const failed = state.failed;
      if (failed === null) return { ...state, saving: null, error: null };
      const key = tallyKey(failed.action);
      return {
        ...state,
        saving: null,
        failed: null,
        error: null,
        tally: { ...state.tally, [key]: Math.max(0, state.tally[key] - 1) },
      };
    }

    case 'SKIP_CARD':
      if (state.error?.kind !== 'conflict') return state;
      return { ...state, error: null };

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
        failed: null,
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
