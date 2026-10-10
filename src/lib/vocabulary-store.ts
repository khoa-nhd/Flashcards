/**
 * The one copy of the vocabulary in the browser. The dashboard, bank, calendar
 * and insights pages all read from here, so switching tabs never refetches the
 * whole database, and a confirmed change shows up everywhere at once.
 *
 * Data is kept for a short while and then re-read in the background the next
 * time a page asks for it; it is never treated as permanently fresh.
 */
import type { VocabularyEntry, VocabularyListResponse } from '../../shared/api.js';
import { ApiError, type VocabularyApi } from './api-client.js';

export type VocabularyMeta = Omit<VocabularyListResponse, 'entries'>;

export interface VocabularyState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  entries: VocabularyEntry[];
  meta: VocabularyMeta | null;
  /** The last failure. With `status: 'ready'` it means a refresh failed and older data is shown. */
  error: { message: string; unauthorized: boolean } | null;
  /** A re-read is in flight while existing data stays on screen. */
  refreshing: boolean;
  /** Something changed that this copy does not reflect yet (for example a review was saved). */
  stale: boolean;
  loadedAt: number | null;
}

export interface VocabularyStore {
  getState(): VocabularyState;
  subscribe(listener: () => void): () => void;
  /** Loads on first use; afterwards re-reads only when the data is stale or old. */
  ensureFresh(): void;
  /** Re-reads now, keeping the current data visible meanwhile. */
  reload(): Promise<void>;
  /** Puts a record the server has just confirmed into the list. */
  upsert(entry: VocabularyEntry): void;
  remove(id: string): void;
  markStale(): void;
}

/** How long loaded data is used before a page visit triggers a background re-read. */
export const MAX_AGE_MS = 60_000;

const initialState: VocabularyState = {
  status: 'idle',
  entries: [],
  meta: null,
  error: null,
  refreshing: false,
  stale: false,
  loadedAt: null,
};

export function createVocabularyStore(
  api: Pick<VocabularyApi, 'fetchVocabulary'>,
  now: () => number = Date.now,
): VocabularyStore {
  let state = initialState;
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;
  /** Counts local changes, so a response that started before one is not allowed to undo it. */
  let revision = 0;

  const set = (patch: Partial<VocabularyState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const load = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    const startedAt = revision;
    set(state.status === 'ready' ? { refreshing: true } : { status: 'loading', error: null });

    inFlight = (async () => {
      let again = false;
      try {
        const { entries, ...meta } = await api.fetchVocabulary();
        if (revision !== startedAt) {
          // A word was added, edited or removed meanwhile; this snapshot predates it.
          again = true;
        } else {
          set({ status: 'ready', entries, meta, error: null, refreshing: false, stale: false, loadedAt: now() });
        }
      } catch (error) {
        const failure = {
          message: error instanceof ApiError ? error.message : 'Could not load your vocabulary.',
          unauthorized: error instanceof ApiError && error.code === 'unauthorized',
        };
        // Keep showing what we have; only an initial load has nothing to fall back on.
        set(state.status === 'ready' ? { error: failure, refreshing: false } : { status: 'error', error: failure });
      } finally {
        inFlight = null;
      }
      if (again) await load();
    })();
    return inFlight;
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    ensureFresh() {
      if (state.status === 'idle' || state.status === 'error') void load();
      else if (state.status === 'ready' && !state.refreshing) {
        const old = state.loadedAt === null || now() - state.loadedAt > MAX_AGE_MS;
        if (state.stale || old) void load();
      }
    },

    reload: () => load(),

    upsert(entry) {
      revision += 1;
      const index = state.entries.findIndex((existing) => existing.id === entry.id);
      const entries =
        index === -1 ? [entry, ...state.entries] : state.entries.map((existing, i) => (i === index ? entry : existing));
      set({ entries });
    },

    remove(id) {
      revision += 1;
      set({ entries: state.entries.filter((entry) => entry.id !== id) });
    },

    markStale() {
      if (state.status === 'ready') set({ stale: true });
    },
  };
}
