/**
 * Answers the server never confirmed, kept until it does (step 2 of
 * docs/offline-mode-design.md). An answer goes in when its fate is unknown —
 * no connection, a timeout, a server that could not answer — and is sent
 * again with the same request id, so one answer is recorded once, never
 * twice. An entry leaves only when the server has confirmed it or
 * definitively refused it, and a refusal is reported with the word it was
 * for rather than dropped in silence.
 *
 * The outbox lives only as long as the page: nothing is written to the
 * device (that is step 3 of the design). Entries are retried when the
 * connection returns, after the next answer saves, or on *Try now*; no
 * background timer runs.
 */
import type { ReviewActionRequest } from '../../shared/api.js';
import { ApiError, type AppApi } from './api-client.js';

/** An answer the server would not take, with the word it was for. */
export interface Refusal {
  word: string;
  reason: string;
}

export interface OutboxEntry {
  /** The id the answer was sent under; a repeat carries it, so it is saved once. */
  requestId: string;
  word: string;
  request: ReviewActionRequest;
}

export interface OutboxState {
  entries: OutboxEntry[];
  /** Answers the server refused, newest last, waiting to be shown to the reviewer. */
  refused: Refusal[];
  /** True while sending is stopped until the reviewer signs in again. */
  waitingForSignIn: boolean;
}

export interface OutboxStore {
  getState(): OutboxState;
  subscribe(listener: () => void): () => void;
  enqueue(entry: OutboxEntry): void;
  /** Sends what is waiting, oldest first, one at a time. Safe to call at any time. */
  flush(): Promise<void>;
  /** Forgets refusals the reviewer has already been shown. */
  dismissRefused(): void;
}

/**
 * A 4xx is the server's final word ("no", with a reason) — nothing to retry.
 * Anything else (no connection, a timeout, a 5xx, a reply this app cannot
 * read) may yet succeed, so the answer stays for another attempt.
 */
export const isFinalRefusal = (error: unknown): boolean =>
  error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500;

export function createOutbox(api: Pick<AppApi, 'submitAction'>): OutboxStore {
  let state: OutboxState = { entries: [], refused: [], waitingForSignIn: false };
  const listeners = new Set<() => void>();
  let flushing = false;

  const set = (next: Partial<OutboxState>): void => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    // "Try now" is how a stopped sync (signed out) is resumed by hand.
    if (state.waitingForSignIn) set({ waitingForSignIn: false });
    try {
      while (state.entries.length > 0 && !state.waitingForSignIn) {
        const entry = state.entries[0]!;
        try {
          const response = await api.submitAction(entry.request);
          set({ entries: state.entries.filter((item) => item !== entry) });
          if (response.outcome === 'dry_run') {
            set({
              refused: [...state.refused, { word: entry.word, reason: 'Nothing was recorded, because saving is switched off.' }],
            });
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            set({ waitingForSignIn: true });
            break;
          }
          if (isFinalRefusal(error)) {
            set({ entries: state.entries.filter((item) => item !== entry) });
            set({
              refused: [
                ...state.refused,
                { word: entry.word, reason: error instanceof ApiError ? error.message : 'The server would not take it.' },
              ],
            });
          }
          // A refusal has been reported; an unknown failure stops this round —
          // the connection returning, the next saved answer or "Try now" starts the next one.
          break;
        }
      }
    } finally {
      flushing = false;
    }
  };

  // The connection coming back is the natural moment to try again.
  if (typeof window !== 'undefined') window.addEventListener('online', () => void flush());

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enqueue(entry) {
      set({ entries: [...state.entries, entry] });
    },
    flush,
    dismissRefused() {
      if (state.refused.length > 0) set({ refused: [] });
    },
  };
}
