/**
 * Durable local storage for the offline layer: a small key–value area per
 * account, and the outbox of operations waiting to reach the server.
 *
 * IndexedDB is used where it exists (every real browser). Where it does not —
 * tests, or a browser with storage disabled — an in-memory store with exactly
 * the same interface takes its place, so nothing else has to know the
 * difference; `persistent` says which one is in use. Storage failures (quota,
 * private mode, a blocked database) are caught the same way: the store
 * degrades to memory rather than breaking the app.
 *
 * Nothing secret is ever written here: only the account's own vocabulary,
 * queue snapshots and review operations, all of which the account can already
 * read from the server.
 */

/** One operation waiting for the server, as it is stored. */
export interface OutboxRecord {
  /** The client-generated request id: what the server deduplicates by. */
  id: string;
  accountId: string;
  /** Monotonic within an account; decides the order operations are sent in. */
  seq: number;
  kind: 'review_action' | 'practice' | 'vocab_create' | 'vocab_update' | 'vocab_delete';
  /**
   * The request to send. Entity ids in it may still be temporary (a word added
   * offline keeps its local id until the create settles); the owner rewrites
   * them just before sending.
   */
  payload: Record<string, unknown>;
  /**
   * The entity this operation is about (a word or card id, or a temporary id).
   * Operations about one entity are sent in the order they were made; the
   * entity name is never sent anywhere by itself.
   */
  entity: string;
  /** When the operation was made, in epoch milliseconds (the browser's clock). */
  createdAt: number;
  /** When the action happened, as an ISO instant: what `answeredAt` carries. */
  answeredAt: string;
  /** `syncing` is a claim: only the claimer may send it. */
  status: 'pending' | 'syncing' | 'failed';
  /** How many times sending was attempted and failed for a reason worth retrying. */
  attempts: number;
  /** Won't be attempted before this instant (epoch ms): the backoff. */
  nextAttemptAt: number;
  /** When the row was claimed for sending; a stale claim may be taken over. */
  claimedAt: number | null;
  /** Why the last attempt failed or the operation was refused, for the person to read. */
  lastError: string | null;
  /** The error code behind `lastError`, where there was one. */
  lastErrorCode: string | null;
}

/** The key–value part: whole snapshots under account-scoped names. */
export interface LocalKeyValue {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface LocalOutbox {
  /** Every stored operation for the account, oldest first. */
  list(accountId: string): Promise<OutboxRecord[]>;
  add(record: OutboxRecord): Promise<void>;
  put(record: OutboxRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * Takes sole ownership of one operation so it can be sent: succeeds only for
   * a `pending` operation whose backoff has passed, or for a `syncing` one
   * whose claim went stale (a tab that closed mid-send). Everything else is
   * left alone. This is what keeps two tabs from sending one operation twice.
   */
  claim(id: string, now: number, staleAfterMs: number): Promise<OutboxRecord | null>;
}

export interface LocalStore {
  /** False when everything lives in memory and will not survive a reload. */
  readonly persistent: boolean;
  kv: LocalKeyValue;
  outbox: LocalOutbox;
  /** Forgets everything one account left here. Other accounts are untouched. */
  clearAccount(accountId: string): Promise<void>;
}

const KV_STORE = 'kv';
const OUTBOX_STORE = 'outbox';
const OUTBOX_ACCOUNT_INDEX = 'byAccount';
const DATABASE_NAME = 'flashcards-offline';
const DATABASE_VERSION = 1;

/**
 * A deliberately tiny promise wrapper: one request, one transaction, and no
 * cleverness. Every failure is surfaced as a rejection for the caller to
 * degrade from.
 */
function ask<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(KV_STORE)) database.createObjectStore(KV_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        const outbox = database.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
        outbox.createIndex(OUTBOX_ACCOUNT_INDEX, 'accountId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage'));
    request.onblocked = () => reject(new Error('Local storage is blocked by another tab'));
  });
}

/** The in-memory store: the fallback, and what the tests use. */
export function createMemoryStore(): LocalStore {
  const values = new Map<string, unknown>();
  const ops = new Map<string, OutboxRecord>();
  return {
    persistent: false,
    kv: {
      async get<T>(key: string) {
        const value = values.get(key);
        return value === undefined ? null : (structuredClone(value) as T);
      },
      async put(key, value) {
        values.set(key, structuredClone(value));
      },
      async remove(key) {
        values.delete(key);
      },
    },
    outbox: {
      async list(accountId) {
        return [...ops.values()]
          .filter((op) => op.accountId === accountId)
          .sort((a, b) => a.seq - b.seq)
          .map((op) => structuredClone(op));
      },
      async add(record) {
        ops.set(record.id, structuredClone(record));
      },
      async put(record) {
        ops.set(record.id, structuredClone(record));
      },
      async remove(id) {
        ops.delete(id);
      },
      async claim(id, now, staleAfterMs) {
        const op = ops.get(id);
        if (op === undefined) return null;
        const sendable = op.status === 'pending' && op.nextAttemptAt <= now;
        const abandoned = op.status === 'syncing' && op.claimedAt !== null && op.claimedAt + staleAfterMs <= now;
        if (!sendable && !abandoned) return null;
        const claimed = { ...op, status: 'syncing' as const, claimedAt: now };
        ops.set(id, claimed);
        return structuredClone(claimed);
      },
    },
    async clearAccount(accountId) {
      for (const [key, value] of [...values]) {
        if (key.startsWith(`${accountId}:`) || (typeof value === 'object' && value !== null && 'accountId' in value && (value as { accountId?: unknown }).accountId === accountId)) {
          values.delete(key);
        }
      }
      for (const [id, op] of [...ops]) if (op.accountId === accountId) ops.delete(id);
    },
  };
}

function idbStore(database: IDBDatabase): LocalStore {
  const tx = <T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T> | T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(store, mode);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction aborted'));
      Promise.resolve(run(transaction.objectStore(store))).then(
        (value) => {
          transaction.oncomplete = () => resolve(value);
          transaction.onerror = () => reject(transaction.error ?? new Error('Local storage transaction failed'));
          // A read-only transaction completes on its own; a write needs the
          // value captured before completion, which it now is.
          if (mode === 'readonly') resolve(value);
        },
        (error) => {
          try {
            transaction.abort();
          } catch {
            // Already finished; the rejection below is what matters.
          }
          reject(error);
        },
      );
    });

  return {
    persistent: true,
    kv: {
      get: <T>(key: string) => tx<unknown>(KV_STORE, 'readonly', (store) => ask(store.get(key))).then((row) => {
        const found = row as { value?: unknown } | undefined;
        return found === undefined ? null : (found.value as T);
      }),
      put: (key, value) => tx(KV_STORE, 'readwrite', (store) => ask(store.put({ key, value }))).then(() => undefined),
      remove: (key) => tx(KV_STORE, 'readwrite', (store) => ask(store.delete(key))).then(() => undefined),
    },
    outbox: {
      list: (accountId) =>
        tx<OutboxRecord[]>(OUTBOX_STORE, 'readonly', (store) => {
          const index = store.index(OUTBOX_ACCOUNT_INDEX);
          return ask(index.getAll(IDBKeyRange.only(accountId)));
        }).then((rows) => rows.sort((a, b) => a.seq - b.seq)),
      add: (record) => tx(OUTBOX_STORE, 'readwrite', (store) => ask(store.add(record))).then(() => undefined),
      put: (record) => tx(OUTBOX_STORE, 'readwrite', (store) => ask(store.put(record))).then(() => undefined),
      remove: (id) => tx(OUTBOX_STORE, 'readwrite', (store) => ask(store.delete(id))).then(() => undefined),
      claim: (id, now, staleAfterMs) =>
        tx<OutboxRecord | null>(OUTBOX_STORE, 'readwrite', async (store) => {
          // One transaction covers the read and the write, so no other tab can
          // claim the same operation in between.
          const current = (await ask(store.get(id))) as OutboxRecord | undefined;
          if (current === undefined) return null;
          const sendable = current.status === 'pending' && current.nextAttemptAt <= now;
          const abandoned = current.status === 'syncing' && current.claimedAt !== null && current.claimedAt + staleAfterMs <= now;
          if (!sendable && !abandoned) return null;
          const claimed = { ...current, status: 'syncing' as const, claimedAt: now };
          await ask(store.put(claimed));
          return claimed;
        }),
    },
    async clearAccount(accountId) {
      await tx(OUTBOX_STORE, 'readwrite', async (store) => {
        const rows = await ask(store.index(OUTBOX_ACCOUNT_INDEX).getAll(IDBKeyRange.only(accountId)));
        for (const row of rows as OutboxRecord[]) await ask(store.delete(row.id));
      });
      await tx(KV_STORE, 'readwrite', async (store) => {
        const keys = await ask(store.getAllKeys());
        for (const key of keys) if (String(key).startsWith(`${accountId}:`)) await ask(store.delete(key));
      });
    },
  };
}

/** Calls `fallback` with the message from a storage failure, once per failure. */
function withFallback(store: LocalStore, fallback: LocalStore, report: (message: string) => void): LocalStore {
  const wrap = <A extends unknown[], R>(run: (...args: A) => Promise<R>, idle: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      run(...args).catch((error: unknown) => {
        report(error instanceof Error ? error.message : 'Local storage failed');
        return idle(...args);
      });
  return {
    persistent: store.persistent,
    kv: {
      get: <T>(key: string): Promise<T | null> =>
        store.kv.get<T>(key).catch((error: unknown) => {
          report(error instanceof Error ? error.message : 'Local storage failed');
          return fallback.kv.get<T>(key);
        }),
      put: wrap(store.kv.put.bind(store.kv), fallback.kv.put.bind(fallback.kv)),
      remove: wrap(store.kv.remove.bind(store.kv), fallback.kv.remove.bind(fallback.kv)),
    },
    outbox: {
      list: wrap(store.outbox.list.bind(store.outbox), fallback.outbox.list.bind(fallback.outbox)),
      add: wrap(store.outbox.add.bind(store.outbox), fallback.outbox.add.bind(fallback.outbox)),
      put: wrap(store.outbox.put.bind(store.outbox), fallback.outbox.put.bind(fallback.outbox)),
      remove: wrap(store.outbox.remove.bind(store.outbox), fallback.outbox.remove.bind(fallback.outbox)),
      claim: wrap(store.outbox.claim.bind(store.outbox), fallback.outbox.claim.bind(fallback.outbox)),
    },
    clearAccount: wrap(store.clearAccount.bind(store), fallback.clearAccount.bind(fallback)),
  };
}

export interface OpenedStore {
  store: LocalStore;
  /** Resolves once the durable database is open, or once the fallback is in use. */
  ready: Promise<LocalStore>;
}

/**
 * Opens the best available store. The handle is usable at once; methods wait
 * for the database themselves, so nothing has to await opening first.
 */
export function createLocalStore(onDegrade?: (message: string) => void): OpenedStore {
  if (typeof indexedDB === 'undefined') {
    const store = createMemoryStore();
    return { store, ready: Promise.resolve(store) };
  }
  const memory = createMemoryStore();
  let database: IDBDatabase | null = null;
  const ready = openDatabase()
    .then((opened) => {
      database = opened;
      opened.onversionchange = () => {
        opened.close();
        database = null;
      };
      return idbStore(opened);
    })
    .catch((error: unknown) => {
      onDegrade?.(error instanceof Error ? error.message : 'Local storage could not be opened');
      return memory;
    });
  const guarded = guardUntilReady(ready);
  const store = withFallback(guarded, memory, (message) => onDegrade?.(message));
  // The store reports itself as durable only while the database really is open.
  return {
    store: {
      get persistent() {
        return database !== null;
      },
      kv: store.kv,
      outbox: store.outbox,
      clearAccount: store.clearAccount,
    },
    ready,
  };
}

/**
 * Holds calls until the database has opened (or failed), so a caller never
 * sees "everything is empty" just because opening is still in progress.
 */
function guardUntilReady(ready: Promise<LocalStore>): LocalStore {
  const wait = () => ready;
  const call = <A extends unknown[], R>(run: (store: LocalStore, ...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => wait().then((store) => run(store, ...args));
  return {
    persistent: false,
    kv: {
      get: <T>(key: string): Promise<T | null> => wait().then((store) => store.kv.get<T>(key)),
      put: call((store, key: string, value: unknown) => store.kv.put(key, value)),
      remove: call((store, key: string) => store.kv.remove(key)),
    },
    outbox: {
      list: call((store, accountId: string) => store.outbox.list(accountId)),
      add: call((store, record: OutboxRecord) => store.outbox.add(record)),
      put: call((store, record: OutboxRecord) => store.outbox.put(record)),
      remove: call((store, id: string) => store.outbox.remove(id)),
      claim: call((store, id: string, now: number, staleAfterMs: number) => store.outbox.claim(id, now, staleAfterMs)),
    },
    clearAccount: call((store, accountId: string) => store.clearAccount(accountId)),
  };
}
