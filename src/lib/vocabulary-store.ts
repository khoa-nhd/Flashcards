/**
 * The one copy of the vocabulary in the browser. The dashboard, bank, calendar
 * and insights pages all read from here, so switching tabs never refetches the
 * whole database, and a change shows up everywhere at once.
 *
 * Adds, edits and removals are applied here the moment they are made and sent
 * to the database behind them. Until a write is confirmed the entry it left
 * behind is only optimistic; if the database refuses it the change is taken
 * back out and the caller is told what went wrong. A repeated request id makes
 * a retry after a lost answer harmless.
 *
 * Data is kept for a short while and then re-read in the background the next
 * time a page asks for it; it is never treated as permanently fresh.
 */
import type {
  CreateEntryInput,
  UpdateEntryInput,
  VocabularyEntry,
  VocabularyListResponse,
} from '../../shared/api.js';
import { compareDates, isIsoDate } from '../../shared/dates.js';
import { ApiError, type VocabularyApi } from './api-client.js';
import { newRequestId } from './request-id.js';

export type VocabularyMeta = Omit<VocabularyListResponse, 'entries'>;

/** One write on its way to the database, or one that could not be saved. */
export interface PendingWrite {
  /** A new word's temporary id until the server answers; otherwise the word's own id. */
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
  create(input: CreateEntryInput): CreatedHandle;
  /** Applies an edit at once and saves it in the background. */
  update(id: string, input: UpdateEntryInput): ChangedHandle;
  /** Takes a word out at once and moves it to the trash in the background. */
  trash(id: string): ChangedHandle;
  /** Sends a failed write again, settling with the new outcome; `null` when there is nothing to retry. */
  retry(id: string): Promise<WriteResult> | null;
  /** Gives up on a failed write, clearing its indicator. Its optimistic change is already undone. */
  dismiss(id: string): void;
}

/** How long loaded data is used before a page visit triggers a background re-read. */
export const MAX_AGE_MS = 60_000;

/** The rules a new or edited word is shown under, for the moment before the server answers. */
const OPTIMISTIC_RETIRED_AT_MASTERY = 10;

const initialState: VocabularyState = {
  status: 'idle',
  entries: [],
  meta: null,
  error: null,
  refreshing: false,
  stale: false,
  loadedAt: null,
  pending: [],
};

/** A write kept alive so it can be retried and reconciled exactly once. */
interface PendingOp {
  id: string;
  operation: 'create' | 'update' | 'delete';
  /** Runs the server call. */
  run: () => Promise<VocabularyEntry | null>;
  /** Puts the optimistic change in place, again after a failed attempt. */
  apply: () => void;
  /** Takes the optimistic change back out. */
  revert: () => void;
  /** Puts the record the server confirmed in place. */
  confirm: (entry: VocabularyEntry | null) => void;
  status: 'saving' | 'failed';
  error: string | null;
  resolve: ((result: WriteResult) => void) | null;
}

const tidyWord = (word: string): string => word.normalize('NFC').trim().replace(/\s+/g, ' ');

const tidyText = (text: string | undefined): string | null => {
  const tidy = text === undefined ? '' : text.normalize('NFC').trim();
  return tidy === '' ? null : tidy;
};

/** Whether a word with this mastery and date is due, judged the way the server judges it. */
function statusFor(
  mastery: number | null,
  reviewDate: string | null,
  today: string | null,
): VocabularyEntry['reviewStatus'] {
  if (mastery === null || !Number.isInteger(mastery) || mastery < 0) return 'invalid';
  if (mastery >= OPTIMISTIC_RETIRED_AT_MASTERY) return 'mastered';
  if (reviewDate === null || !isIsoDate(reviewDate)) return 'unscheduled';
  const order = compareDates(reviewDate, today ?? reviewDate);
  if (order < 0) return 'overdue';
  return order === 0 ? 'due_today' : 'upcoming';
}

const isReviewable = (status: VocabularyEntry['reviewStatus']): boolean =>
  status === 'overdue' || status === 'due_today' || status === 'unscheduled';

/** A new word as it looks before the database has answered. */
function optimisticCreate(input: CreateEntryInput, meta: VocabularyMeta | null, localId: string): VocabularyEntry {
  const today = meta?.today ?? null;
  const mastery = input.mastery ?? meta?.defaults.mastery ?? null;
  const reviewDate =
    input.reviewDate !== undefined ? input.reviewDate : meta?.defaults.reviewDate === 'today' ? meta.today : null;
  const reviewStatus = statusFor(mastery, reviewDate, today);
  return {
    id: localId,
    word: tidyWord(input.word),
    meaning: tidyText(input.meaning),
    definition: tidyText(input.definition),
    example: tidyText(input.example),
    mastery,
    reviewDate,
    dateAdded: input.dateAdded ?? today,
    reviewStatus,
    reviewable: isReviewable(reviewStatus),
    createdTime: null,
    lastEditedTime: null,
  };
}

/** The entry an edit would leave behind, before the database has answered. */
function optimisticUpdate(
  entry: VocabularyEntry,
  input: UpdateEntryInput,
  today: string | null,
): VocabularyEntry {
  const mastery = input.schedule?.mastery ?? entry.mastery;
  const reviewDate = input.schedule === undefined ? entry.reviewDate : input.schedule.reviewDate;
  const reviewStatus = statusFor(mastery, reviewDate, today);
  return {
    ...entry,
    word: input.word === undefined ? entry.word : tidyWord(input.word),
    meaning: input.meaning === undefined ? entry.meaning : tidyText(input.meaning),
    definition: input.definition === undefined ? entry.definition : tidyText(input.definition),
    example: input.example === undefined ? entry.example : tidyText(input.example),
    dateAdded: input.dateAdded === undefined ? entry.dateAdded : input.dateAdded,
    mastery,
    reviewDate,
    reviewStatus,
    reviewable: isReviewable(reviewStatus),
  };
}

function failureOf(error: unknown): WriteFailure {
  if (error instanceof ApiError) return { code: error.code, message: error.message, duplicates: error.duplicates };
  return { code: 'unexpected', message: 'Could not save the change.', duplicates: [] };
}

export function createVocabularyStore(
  api: Pick<VocabularyApi, 'fetchVocabulary' | 'createEntry' | 'updateEntry' | 'deleteEntry'>,
  now: () => number = Date.now,
): VocabularyStore {
  let state = initialState;
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;
  /** Counts local changes, so a response that started before one is not allowed to undo it. */
  let revision = 0;
  /** What the database last said, and what it has been told since. */
  let base: VocabularyEntry[] = [];
  /** New words the database has not confirmed yet, by their temporary id. */
  const optimistic = new Map<string, VocabularyEntry>();
  /** Writes still owed to the database, kept so they can be retried. */
  const ops = new Map<string, PendingOp>();

  const commit = (patch: Partial<VocabularyState> = {}): void => {
    state = {
      ...state,
      ...patch,
      entries: [...optimistic.values(), ...base],
      pending: [...ops.values()].map((op) => ({
        id: op.id,
        operation: op.operation,
        status: op.status,
        error: op.error,
      })),
    };
    for (const listener of listeners) listener();
  };

  const replaceBase = (entry: VocabularyEntry): void => {
    const index = base.findIndex((existing) => existing.id === entry.id);
    base = index === -1 ? [entry, ...base] : base.map((existing) => (existing.id === entry.id ? entry : existing));
  };

  const removeLocally = (id: string): void => {
    optimistic.delete(id);
    base = base.filter((entry) => entry.id !== id);
  };

  const findLocal = (id: string): VocabularyEntry | null =>
    optimistic.get(id) ?? base.find((entry) => entry.id === id) ?? null;

  const replaceLocal = (entry: VocabularyEntry): void => {
    if (optimistic.has(entry.id)) optimistic.set(entry.id, entry);
    else replaceBase(entry);
  };

  const finish = (op: PendingOp, result: WriteResult): void => {
    const resolve = op.resolve;
    op.resolve = null;
    // A local change either way: a response that started earlier must not undo it.
    revision += 1;
    if (result.ok) {
      op.confirm(result.entry);
      ops.delete(op.id);
    } else {
      op.revert();
      op.status = 'failed';
      op.error = result.message;
    }
    commit();
    resolve?.(result);
  };

  const runOp = (op: PendingOp): void => {
    op.status = 'saving';
    op.error = null;
    commit();
    void (async () => {
      try {
        finish(op, { ok: true, entry: (await op.run()) ?? null });
      } catch (error) {
        finish(op, { ok: false, ...failureOf(error) });
      }
    })();
  };

  const startOp = (op: PendingOp): Promise<WriteResult> => {
    ops.set(op.id, op);
    op.apply();
    revision += 1;
    const result = new Promise<WriteResult>((resolve) => {
      op.resolve = resolve;
    });
    runOp(op);
    return result;
  };

  const load = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    const startedAt = revision;
    commit(state.status === 'ready' ? { refreshing: true } : { status: 'loading', error: null });

    inFlight = (async () => {
      let again = false;
      try {
        const { entries, ...meta } = await api.fetchVocabulary();
        if (revision !== startedAt) {
          // A word was added, edited or removed meanwhile; this snapshot predates it.
          again = true;
        } else {
          base = entries;
          commit({ status: 'ready', meta, error: null, refreshing: false, stale: false, loadedAt: now() });
        }
      } catch (error) {
        const failure = {
          message: error instanceof ApiError ? error.message : 'Could not load your vocabulary.',
          unauthorized: error instanceof ApiError && error.code === 'unauthorized',
        };
        // Keep showing what we have; only an initial load has nothing to fall back on.
        commit(state.status === 'ready' ? { error: failure, refreshing: false } : { status: 'error', error: failure });
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
      // The database confirmed this record, so any optimistic stand-in for it goes.
      optimistic.delete(entry.id);
      replaceBase(entry);
      commit();
    },

    remove(id) {
      revision += 1;
      removeLocally(id);
      commit();
    },

    markStale() {
      if (state.status === 'ready') commit({ stale: true });
    },

    create(input) {
      const localId = newRequestId();
      const entry = optimisticCreate(input, state.meta, localId);
      const op: PendingOp = {
        id: localId,
        operation: 'create',
        run: () => api.createEntry(input),
        apply: () => {
          optimistic.set(localId, entry);
        },
        revert: () => {
          optimistic.delete(localId);
        },
        confirm: (serverEntry) => {
          optimistic.delete(localId);
          if (serverEntry !== null) replaceBase(serverEntry);
        },
        status: 'saving',
        error: null,
        resolve: null,
      };
      return { localId, result: startOp(op) };
    },

    update(id, input) {
      const previous = findLocal(id);
      if (previous === null) throw new Error(`Cannot update a word that is not loaded (${id}).`);
      const next = optimisticUpdate(previous, input, state.meta?.today ?? null);
      const op: PendingOp = {
        id,
        operation: 'update',
        run: () => api.updateEntry(id, input),
        apply: () => replaceLocal(next),
        revert: () => replaceLocal(previous),
        confirm: (serverEntry) => replaceLocal(serverEntry ?? previous),
        status: 'saving',
        error: null,
        resolve: null,
      };
      return { entry: next, result: startOp(op) };
    },

    trash(id) {
      const previous = findLocal(id);
      if (previous === null) throw new Error(`Cannot delete a word that is not loaded (${id}).`);
      const op: PendingOp = {
        id,
        operation: 'delete',
        run: async () => {
          await api.deleteEntry(id);
          return null;
        },
        apply: () => removeLocally(id),
        revert: () => {
          if (optimistic.has(id)) optimistic.set(id, previous);
          else replaceBase(previous);
        },
        confirm: () => {},
        status: 'saving',
        error: null,
        resolve: null,
      };
      return { entry: previous, result: startOp(op) };
    },

    retry(id) {
      const op = ops.get(id);
      if (op === undefined || op.status !== 'failed') return null;
      op.apply();
      revision += 1;
      const result = new Promise<WriteResult>((resolve) => {
        op.resolve = resolve;
      });
      runOp(op);
      return result;
    },

    dismiss(id) {
      const op = ops.get(id);
      if (op === undefined || op.status !== 'failed') return;
      ops.delete(id);
      commit();
    },
  };
}
