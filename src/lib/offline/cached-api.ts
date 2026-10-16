/**
 * The reads that survive a lost connection.
 *
 * Most of what a page shows is read once and then only changed by a write, so
 * the last answer this device saw is still worth showing when the server
 * cannot be reached. Wrapping those reads keeps that in one place: every
 * successful read is kept on the device, and a read that fails because the
 * server cannot be reached — and only then — is answered from what was kept.
 *
 * Two kinds of copy are kept apart. Some answers depend on the reviewer's own
 * day (what is due, today's goal, weak words as of now): for those, only a copy
 * from today is used, so yesterday's "today" is never shown as today's. The
 * rest — settings, the library, a word, practice history — keep for a week.
 *
 * Nothing here can decide what is due or change any data: the queue and the
 * vocabulary have their own, stricter handling.
 */
import { ApiError, type AppApi } from '../api-client.js';
import type { LocalStore } from './storage.js';

/** Bumped when the shape of a stored read changes, so an old copy is never served. */
const READ_CACHE_VERSION = 1;
/** The longest a day-independent copy is served. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedRead {
  version: number;
  /** When it was stored. */
  at: number;
  /** The device's own day when it was stored, `YYYY-MM-DD`. */
  day: string;
  value: unknown;
}

/** The device's own calendar day, not the account's: it only has to be stable across a reload. */
function localDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Whether the failure means the server was never reached. */
function unreachable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === null;
}

export interface CachedReadsOptions {
  store: LocalStore;
  /** The signed-in account's id; copies from one account are never shown to another. */
  accountId: string;
  now?: () => number;
}

/**
 * Returns the same API with its read-only methods backed by this device's
 * copies. Writes, the queue and the vocabulary are passed through untouched.
 */
export function withCachedReads(api: AppApi, options: CachedReadsOptions): AppApi {
  const { store, accountId } = options;
  const now = options.now ?? Date.now;

  const keyFor = (name: string, args: unknown[]): string =>
    `${accountId}:read:${name}:${args.length === 0 ? '' : JSON.stringify(args)}`;

  const keep = (name: string, args: unknown[], value: unknown): void => {
    const record: CachedRead = { version: READ_CACHE_VERSION, at: now(), day: localDay(now()), value };
    void store.kv.put(keyFor(name, args), record).catch(() => undefined);
  };

  const recall = async <T>(name: string, args: unknown[], dayScoped: boolean): Promise<T | null> => {
    const record = await store.kv.get<CachedRead>(keyFor(name, args)).catch(() => null);
    if (record === null || record.version !== READ_CACHE_VERSION) return null;
    if (dayScoped ? record.day !== localDay(now()) : now() - record.at > MAX_AGE_MS) return null;
    return record.value as T;
  };

  const read = <T>(name: string, args: unknown[], dayScoped: boolean, run: () => Promise<T>): Promise<T> =>
    run()
      .then((value) => {
        keep(name, args, value);
        return value;
      })
      .catch(async (error: unknown) => {
        if (!unreachable(error)) throw error;
        const remembered = await recall<T>(name, args, dayScoped);
        if (remembered === null) throw error;
        return remembered;
      });

  return {
    ...api,
    fetchSettings: () => read('fetchSettings', [], true, () => api.fetchSettings()),
    fetchScheduler: () => read('fetchScheduler', [], true, () => api.fetchScheduler()),
    fetchSimulation: (retention?: number) =>
      read('fetchSimulation', [retention ?? null], true, () => api.fetchSimulation(retention)),
    fetchAnalytics: () => read('fetchAnalytics', [], true, () => api.fetchAnalytics()),
    fetchWeakWords: () => read('fetchWeakWords', [], true, () => api.fetchWeakWords()),
    fetchPlan: () => read('fetchPlan', [], true, () => api.fetchPlan()),
    fetchReviewDays: (from, to) => read('fetchReviewDays', [from, to], true, () => api.fetchReviewDays(from, to)),
    fetchLibrary: () => read('fetchLibrary', [], false, () => api.fetchLibrary()),
    fetchPracticeHistory: (since) =>
      read('fetchPracticeHistory', [since], false, () => api.fetchPracticeHistory(since)),
    fetchPracticeMastery: (id) => read('fetchPracticeMastery', [id], false, () => api.fetchPracticeMastery(id)),
    fetchEntry: (id) => read('fetchEntry', [id], false, () => api.fetchEntry(id)),
    fetchTrash: () => read('fetchTrash', [], false, () => api.fetchTrash()),
  };
}
