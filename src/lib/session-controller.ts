/**
 * Owns the session state and runs its side effects (loading, saving). State
 * lives in a plain variable rather than React state so every transition is
 * synchronous: two key presses in the same tick see each other's effect, and
 * the second one finds the machine already `saving`.
 */
import type { ReviewAction } from '../../shared/review-logic.js';
import { ApiError, type ReviewApi } from './api-client.js';
import {
  currentCard,
  initialSessionState,
  transition,
  type SessionEvent,
  type SessionState,
} from './session-machine.js';

export interface SessionController {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /** (Re)loads the queue. Reads only; never changes review data. */
  load(): Promise<void>;
  flip(): void;
  /** Returns false when the answer was not accepted (card not flipped, save in flight…). */
  grade(action: ReviewAction): boolean;
  retrySave(): void;
  cancelSave(): void;
  skipCard(): void;
}

const messageOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Something unexpected went wrong.';

export function createSessionController(
  api: Pick<ReviewApi, 'fetchQueue' | 'submitAction'>,
  /** Called once Notion has confirmed an answer, so other views know their data has changed. */
  onSaved: () => void = () => {},
): SessionController {
  let state = initialSessionState;
  let loadSequence = 0;
  const listeners = new Set<() => void>();

  const dispatch = (event: SessionEvent): boolean => {
    const next = transition(state, event);
    if (next === state) return false;
    state = next;
    for (const listener of listeners) listener();
    return true;
  };

  const save = async () => {
    const card = currentCard(state);
    const action = state.pendingAction;
    if (state.status !== 'saving' || card === null || action === null) return;
    try {
      await api.submitAction({
        pageId: card.id,
        action,
        expected: { mastery: card.mastery, nextReview: card.nextReview },
      });
      dispatch({ type: 'SAVE_SUCCEEDED' });
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        dispatch({ type: 'SAVE_CONFLICT', message: error.message });
      } else {
        dispatch({ type: 'SAVE_FAILED', message: messageOf(error) });
      }
    }
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async load() {
      if (state.status === 'saving') return;
      // A newer load supersedes any still in flight.
      const sequence = ++loadSequence;
      dispatch({ type: 'LOAD' });
      try {
        const { cards, ...meta } = await api.fetchQueue();
        if (sequence === loadSequence) dispatch({ type: 'LOAD_SUCCEEDED', cards, meta });
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

    grade(action) {
      if (!dispatch({ type: 'GRADE', action })) return false;
      void save();
      return true;
    },

    retrySave() {
      if (dispatch({ type: 'RETRY_SAVE' })) void save();
    },

    cancelSave() {
      dispatch({ type: 'CANCEL_SAVE' });
    },

    skipCard() {
      dispatch({ type: 'SKIP_CARD' });
    },
  };
}
