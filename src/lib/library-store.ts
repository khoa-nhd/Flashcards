/**
 * The one copy of the account's collections, further examples and
 * relationships in the browser. Loaded on first use; every change made here
 * is one the server has already confirmed.
 */
import type { LibraryResponse } from '../../shared/api.js';
import type { Collection, ExtraExample, Relation } from '../../shared/library.js';
import { ApiError, type LibraryApi } from './api-client.js';

export interface LibraryState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** False where the store cannot keep any of this yet. */
  available: boolean;
  collections: Collection[];
  examples: ExtraExample[];
  relations: Relation[];
  error: string | null;
}

export interface LibraryStore {
  getState(): LibraryState;
  subscribe(listener: () => void): () => void;
  /** Loads on first use, and again after a failure. */
  ensureLoaded(): void;
  reload(): Promise<void>;
  /** Each of these puts a record the server has just confirmed into the lists, or takes one out. */
  putCollection(collection: Collection): void;
  removeCollection(id: string): void;
  putExample(example: ExtraExample): void;
  removeExample(id: string): void;
  putRelation(relation: Relation): void;
  removeRelation(id: string): void;
}

const initialState: LibraryState = {
  status: 'idle',
  available: false,
  collections: [],
  examples: [],
  relations: [],
  error: null,
};

const byName = (a: Collection, b: Collection) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function createLibraryStore(api: Pick<LibraryApi, 'fetchLibrary'>): LibraryStore {
  let state = initialState;
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;

  const set = (patch: Partial<LibraryState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const load = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    if (state.status !== 'ready') set({ status: 'loading', error: null });
    inFlight = (async () => {
      try {
        const loaded: LibraryResponse = await api.fetchLibrary();
        set({ status: 'ready', error: null, ...loaded, collections: [...loaded.collections].sort(byName) });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'Could not load your collections.';
        // Keep showing what we have; only a first load has nothing to fall back on.
        set(state.status === 'ready' ? { error: message } : { status: 'error', error: message });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const replace = <T extends { id: string }>(list: readonly T[], item: T): T[] =>
    list.some((existing) => existing.id === item.id)
      ? list.map((existing) => (existing.id === item.id ? item : existing))
      : [...list, item];

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureLoaded() {
      if (state.status === 'idle' || state.status === 'error') void load();
    },
    reload: () => load(),

    putCollection: (collection) => set({ collections: replace(state.collections, collection).sort(byName) }),
    removeCollection: (id) => set({ collections: state.collections.filter((collection) => collection.id !== id) }),

    putExample(example) {
      // Marking one example as preferred clears the mark on the word's others, as the server did.
      const others = example.preferred
        ? state.examples.map((existing) =>
            existing.vocabularyId === example.vocabularyId && existing.id !== example.id
              ? { ...existing, preferred: false }
              : existing,
          )
        : state.examples;
      set({ examples: replace(others, example) });
    },
    removeExample: (id) => set({ examples: state.examples.filter((example) => example.id !== id) }),

    putRelation: (relation) => set({ relations: replace(state.relations, relation) }),
    removeRelation: (id) => set({ relations: state.relations.filter((relation) => relation.id !== id) }),
  };
}
