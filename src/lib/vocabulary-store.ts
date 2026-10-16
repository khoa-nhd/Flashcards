/**
 * The one copy of the vocabulary in the browser. The dashboard, bank, calendar
 * and insights pages all read from here, so switching tabs never refetches the
 * whole database, and a change shows up everywhere at once.
 *
 * Adds, edits and removals are applied here the moment they are made and
 * recorded in the outbox, which sends them when it can — now if there is a
 * connection, later if there is not. What is shown is the last confirmed state
 * with the outstanding operations folded over it, so a word added offline is
 * still there after a reload.
 *
 * Data is kept for a short while and then re-read in the background the next
 * time a page asks for it; it is never treated as permanently fresh. Where the
 * server cannot be reached, the last read is shown instead of an error.
 */
import type {
  CreateEntryInput,
  UpdateEntryInput,
  VocabularyEntry,
  VocabularyListResponse,
} from '../../shared/api.js';
import { ApiError, type VocabularyApi } from './api-client.js';
import {
  isVocabularyOp,
  optimisticCreate,
  optimisticUpdate,
  projectVocabulary,
  resolveEntityId,
  type VocabCreatePayload,
  type VocabDeletePayload,
  type VocabUpdatePayload,
} from './offline/ops.js';
import type { LocalStore, OutboxRecord } from './offline/storage.js';
import type { SyncEngine } from './offline/sync-engine.js';
import { newRequestId } from './request-id.js';

export type VocabularyMeta = Omit<VocabularyListResponse, 'entries'>;

/** One write on its way to the database, or one that could not be saved. */
export interface PendingWrite {
  /** The operation's id: a new word's temporary id until the server confirms it; otherwise the word's own id. */
  id: string;
  operation: 'create' | 'update' | 'delete';
  status: 'saving' | 'failed';
  /** Why the last attempt failed, when it did. */
  error: string | null;
}

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
  /** Writes not yet confirmed by the database, including failed ones waiting on a retry. */
  pending: PendingWrite[];
  /** True when the data shown is this device's own copy rather than a fresh read. */
  offline: boolean;
}

/** Why a write could not be saved. */
export interface WriteFailure {
  code: string;
  message: string;
  /** Existing words, when a create or rename was refused as a duplicate. */
  duplicates: VocabularyEntry[];
}

export type WriteResult = { ok: true; entry: VocabularyEntry | null } | ({ ok: false } & WriteFailure);

export interface CreatedHandle {
  /** The temporary id the new word carries until the database confirms it. */
  localId: string;
  /** Settles once the background save has succeeded or failed. */
  result: Promise<WriteResult>;
}

export interface ChangedHandle {
  /** The entry as it looks right now, before the database has answered. */
  entry: VocabularyEntry;
  /** The operation's id, so a refused write can be sent again or dismissed. */
  operationId: string;
  result: Promise<WriteResult>;
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

  /** Adds a word at once and saves it in the background. */
  create(input: Omit<CreateEntryInput, 'requestId'>): CreatedHandle;
  /** Applies an edit at once and saves it in the background. */
  update(id: string, input: UpdateEntryInput): ChangedHandle;
  /** Takes a word out at once and moves it to the trash in the background. */
  trash(id: string): ChangedHandle;
  /** Sends a failed write again, settling with the new outcome; `null` when there is nothing to retry. */
  retry(id: string): Promise<WriteResult> | null;
  /** Gives up on a failed write, clearing its indicator. Its optimistic change is already undone. */
  dismiss(id: string): void;
  /** The real id for a word added on this device, once its create has settled. */
  resolveId(id: string): string;
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
  pending: [],
  offline: false,
};

export interface VocabularyStoreOptions {
  api: Pick<VocabularyApi, 'fetchVocabulary' | 'createEntry' | 'updateEntry' | 'deleteEntry'>;
  engine: SyncEngine;
  store: LocalStore;
  accountId: string;
  /** Temporary ids of words added on this device, resolved to the real ones. Shared with the sender. */
  ids: Map<string, string>;
  now?: () => number;
}

function failureOf(error: unknown): WriteFailure {
  if (error instanceof ApiError) return { code: error.code, message: error.message, duplicates: error.duplicates };
  return { code: 'unexpected', message: 'Could not save the change.', duplicates: [] };
}

interface Deferred {
  resolve: (result: WriteResult) => void;
  promise: Promise<WriteResult>;
}

function defer(): Deferred {
  let resolve!: (result: WriteResult) => void;
  const promise = new Promise<WriteResult>((settle) => {
    resolve = settle;
  });
  return { resolve, promise };
}

export function createVocabularyStore(options: VocabularyStoreOptions): VocabularyStore {
  const { api, engine, store, accountId, ids } = options;
  const now = options.now ?? Date.now;
  let state = initialState;
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;
  /** What the database last said; never changed by local edits. */
  let base: VocabularyEntry[] = [];
  /** Counts confirmed changes, so a read that started before one cannot undo it. */
  let revision = 0;
  /** What each outstanding operation's caller is waiting for, by operation id. */
  const results = new Map<string, Deferred>();

  /** The entries as they look right now: the last read with outstanding writes folded over it. */
  const entries = (): VocabularyEntry[] =>
    projectVocabulary(base, engine.currentOps(), {
      today: state.meta?.today ?? null,
      resolveId: (id) => resolveEntityId(id, ids),
    });

  const pendingWrites = (): PendingWrite[] =>
    engine
      .currentOps()
      .filter(isVocabularyOp)
      .map((op) => ({
        id: op.id,
        operation: op.kind === 'vocab_create' ? 'create' : op.kind === 'vocab_update' ? 'update' : 'delete',
        status: op.status === 'failed' ? 'failed' : 'saving',
        error: op.lastError,
      }));

  const commit = (patch: Partial<VocabularyState> = {}): void => {
    state = { ...state, ...patch, entries: entries(), pending: pendingWrites() };
    for (const listener of listeners) listener();
  };

  const replaceBase = (entry: VocabularyEntry): void => {
    revision += 1;
    const index = base.findIndex((existing) => existing.id === entry.id);
    base = index === -1 ? [entry, ...base] : base.map((existing) => (existing.id === entry.id ? entry : existing));
  };

  /** Takes a word out of the confirmed copy. Counts as a change: older reads must not undo it. */
  const removeFromBase = (id: string): void => {
    revision += 1;
    base = base.filter((entry) => entry.id !== id);
  };

  const findLocal = (id: string): VocabularyEntry | null => {
    const real = resolveEntityId(id, ids);
    return entries().find((entry) => entry.id === id || entry.id === real) ?? null;
  };

  /**
   * A new write to a word replaces any refused earlier write to it. Both carry
   * absolute values, the refused one changed nothing on screen, and the panel
   * offers the new attempt itself — without this, a refused update would block
   * every later write to the same word, whose turn only comes after it.
   */
  const supersedeRefused = (entity: string): void => {
    for (const op of engine.currentOps()) {
      if (op.entity !== entity || !isVocabularyOp(op) || op.status !== 'failed') continue;
      results.delete(op.id);
      engine.dismiss(op.id);
    }
  };

  /** The one place a settled operation lands, whichever kind it was. */
  const settled = (op: OutboxRecord, value: unknown): void => {
    const deferred = results.get(op.id);
    results.delete(op.id);
    if (op.kind === 'vocab_create') {
      const entry = value as VocabularyEntry | undefined;
      const payload = op.payload as unknown as VocabCreatePayload;
      if (entry !== undefined && entry !== null) {
        replaceBase(entry);
        ids.set(payload.tempId, entry.id);
        void store.kv
          .put(`${accountId}:ids`, Object.fromEntries(ids))
          .catch(() => undefined);
      }
      deferred?.resolve({ ok: true, entry: entry ?? null });
      return;
    }
    if (op.kind === 'vocab_update') {
      const entry = value as VocabularyEntry | undefined;
      if (entry !== undefined && entry !== null) replaceBase(entry);
      deferred?.resolve({ ok: true, entry: entry ?? null });
      return;
    }
    if (op.kind === 'vocab_delete') {
      // Gone for good: the confirmed copy has to lose it too, or the fold
      // would bring the word back now that the operation has left the outbox.
      removeFromBase(resolveEntityId((op.payload as unknown as VocabDeletePayload).id, ids));
    }
    deferred?.resolve({ ok: true, entry: null });
  };

  // Everything the outbox settles or refuses changes what is on screen.
  engine.subscribeEvents((event) => {
    if (!isVocabularyOp(event.op)) return;
    if (event.type === 'settled') {
      settled(event.op, event.value);
    } else if (event.type === 'refused' || event.type === 'dismissed') {
      const deferred = results.get(event.op.id);
      results.delete(event.op.id);
      if (deferred !== undefined) {
        deferred.resolve(
          event.type === 'refused' && event.error !== null
            ? { ok: false, ...failureOf(event.error) }
            : {
                ok: false,
                code: event.op.lastErrorCode ?? 'dismissed',
                message: event.op.lastError ?? 'The change was given up.',
                duplicates: [],
              },
        );
      }
    }
    commit();
  });
  engine.subscribe(() => commit());

  /** The stored id map, so a reload can still name a word added earlier. */
  const loadIds = async (): Promise<void> => {
    const saved = await store.kv.get<Record<string, string>>(`${accountId}:ids`);
    if (saved !== null) for (const [temporary, real] of Object.entries(saved)) ids.set(temporary, real);
  };

  const load = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    const startedAt = revision;
    commit(state.status === 'ready' ? { refreshing: true } : { status: 'loading', error: null });

    inFlight = (async () => {
      let again = false;
      try {
        const { entries: fetched, ...meta } = await api.fetchVocabulary();
        if (revision !== startedAt) {
          // A record was confirmed meanwhile; this snapshot predates it. Read again.
          again = true;
        } else {
          base = fetched;
          commit({ status: 'ready', meta, error: null, refreshing: false, stale: false, loadedAt: now(), offline: false });
        }
      } catch (error) {
        const failure = {
          message: error instanceof ApiError ? error.message : 'Could not load your vocabulary.',
          unauthorized: error instanceof ApiError && error.code === 'unauthorized',
        };
        const unreachable =
          error instanceof ApiError && (error.code === 'network' || error.code === 'timeout') && state.meta !== null;
        // Keep showing what we have; a first load has nothing to fall back on.
        if (state.status === 'ready' || unreachable) commit({ error: failure, refreshing: false, offline: unreachable });
        else commit({ status: 'error', error: failure });
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
      void loadIds().catch(() => undefined);
      if (state.status === 'idle' || state.status === 'error') void load();
      else if (state.status === 'ready' && !state.refreshing) {
        const old = state.loadedAt === null || now() - state.loadedAt > MAX_AGE_MS;
        if (state.stale || old) void load();
      }
    },

    reload: () => load(),

    upsert(entry) {
      replaceBase(entry);
      commit();
    },

    remove(id) {
      removeFromBase(id);
      commit();
    },

    markStale() {
      if (state.status === 'ready') commit({ stale: true });
    },

    create(input) {
      const localId = newRequestId();
      const entry = optimisticCreate(input, state.meta === null ? null : { ...state.meta.defaults, today: state.meta.today }, localId);
      const opId = engine.enqueue({
        kind: 'vocab_create',
        entity: localId,
        payload: { tempId: localId, entry, input } satisfies VocabCreatePayload,
      });
      const deferred = defer();
      results.set(opId, deferred);
      commit();
      return { localId: opId, result: deferred.promise };
    },

    update(id, input) {
      const previous = findLocal(id);
      if (previous === null) throw new Error(`Cannot update a word that is not loaded (${id}).`);
      supersedeRefused(id);
      const next = optimisticUpdate(previous, input, state.meta?.today ?? null);
      const opId = engine.enqueue({
        kind: 'vocab_update',
        entity: id,
        payload: { id, input } satisfies VocabUpdatePayload,
      });
      const deferred = defer();
      results.set(opId, deferred);
      commit();
      return { entry: next, operationId: opId, result: deferred.promise };
    },

    trash(id) {
      const previous = findLocal(id);
      if (previous === null) throw new Error(`Cannot delete a word that is not loaded (${id}).`);
      supersedeRefused(id);
      const opId = engine.enqueue({
        kind: 'vocab_delete',
        entity: id,
        payload: { id } satisfies VocabDeletePayload,
      });
      const deferred = defer();
      results.set(opId, deferred);
      commit();
      return { entry: previous, operationId: opId, result: deferred.promise };
    },

    retry(id) {
      const op = engine.currentOps().find((candidate) => candidate.id === id);
      if (op === undefined || !isVocabularyOp(op) || op.status !== 'failed') return null;
      const deferred = defer();
      results.set(id, deferred);
      engine.retry(id);
      return deferred.promise;
    },

    dismiss(id) {
      const op = engine.currentOps().find((candidate) => candidate.id === id);
      if (op === undefined || !isVocabularyOp(op) || op.status !== 'failed') return;
      results.delete(id);
      engine.dismiss(id);
    },

    resolveId: (id) => resolveEntityId(id, ids),
  };
}
