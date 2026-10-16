/**
 * The outbox pump. Every write in the app is recorded here first, in durable
 * storage, and then sent to the server when it can be — immediately online,
 * later when the connection comes back. Nothing waits for the server: the
 * interface moves on, and the pump works in the background.
 *
 * Guarantees:
 *  - exactly once: each operation carries a client-generated request id, and
 *    the server recognises a repeat of one it has already applied;
 *  - order: operations about one word are sent in the order they were made,
 *    and a refused operation blocks its own word (but not others);
 *  - no silent loss: an operation that cannot be sent stays in the outbox; one
 *    the server refuses stays visible until the person retries or dismisses it.
 */
import { ApiError } from '../api-client.js';
import { newRequestId } from '../request-id.js';
import { createMemoryStore, type LocalStore, type OutboxRecord } from './storage.js';

/** What the pump is doing, for the indicator and the panels that show it. */
export interface SyncEngineState {
  /** Operations waiting to be sent. */
  pending: number;
  /** Operations the server refused; they need a person to decide. */
  refused: number;
  /** An operation is being sent right now. */
  syncing: boolean;
  /** The last failure worth telling about, if any. */
  lastError: string | null;
  /** True when the outbox is only in memory and would not survive a reload. */
  memoryOnly: boolean;
  /** True once the stored operations have been read back. */
  hydrated: boolean;
}

/** Something that happened to one operation, told to whoever is interested. */
export type SyncEvent =
  | { type: 'settled'; op: OutboxRecord; value: unknown }
  /** The server refused it. `error` is the refusal itself, where it was one. */
  | { type: 'refused'; op: OutboxRecord; error: ApiError | null }
  | { type: 'retrying'; op: OutboxRecord; message: string }
  | { type: 'dismissed'; op: OutboxRecord };

/** How sending one operation ended. A refusal never reaches here: errors are thrown. */
export type Sender = (op: OutboxRecord) => Promise<unknown>;

export interface EnqueueInput {
  kind: OutboxRecord['kind'];
  /**
   * The request id for the operation, when the caller already made one — the
   * same id must then be used to recognise the operation's fate. Generated
   * here otherwise.
   */
  id?: string;
  /** The request to send. Ids in it may still be temporary. */
  payload: Record<string, unknown>;
  /** The word the operation is about; operations about one word keep their order. */
  entity: string;
  /** When the action happened. Defaults to now. */
  answeredAt?: string;
}

export interface SyncEngine {
  getState(): SyncEngineState;
  subscribe(listener: () => void): () => void;
  subscribeEvents(listener: (event: SyncEvent) => void): () => void;
  /** Records one operation and returns its id. The operation is stored before it is ever sent. */
  enqueue(input: EnqueueInput): string;
  /** Sends what can be sent now. Safe to call at any moment; it never runs twice at once. */
  kick(): void;
  /** Sends one refused operation again. */
  retry(id: string): void;
  /** Gives up on a refused operation: it is not sent again. */
  dismiss(id: string): void;
  /** Every stored operation, oldest first, once storage has settled. */
  ops(): Promise<OutboxRecord[]>;
  /** The operations known right now, without waiting for storage. */
  currentOps(): OutboxRecord[];
  /** Resolves once the stored operations have been read back. */
  ready(): Promise<void>;
  /** Stops timers and listeners. Called when the account's services are thrown away. */
  stop(): void;
}

export interface SyncEngineOptions {
  accountId: string;
  store: LocalStore;
  sender: Sender;
  now?: () => number;
  /** How long a claim may stand before another tab may take the operation over. */
  claimStaleMs?: number;
  /** For tests: the shortest and longest waits between attempts. */
  backoffMs?: { base: number; max: number };
}

const DEFAULT_CLAIM_STALE_MS = 60_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;
/** After this long without an answer the session is treated as over; trying again waits a while. */
const SIGNED_OUT_RETRY_MS = 60_000;

/** An error the server will never accept, however often it is sent. */
function isRefusal(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'unauthorized') return false;
  // A missing status means the request never reached the server (network, timeout).
  if (error.status === null) return false;
  // Temporary server-side conditions are worth retrying.
  return error.status < 500 && error.status !== 408 && error.status !== 429;
}

const messageOf = (error: unknown): string => {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Could not reach the server.';
};

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { accountId, store, sender } = options;
  const now = options.now ?? Date.now;
  const claimStaleMs = options.claimStaleMs ?? DEFAULT_CLAIM_STALE_MS;
  const backoffBase = options.backoffMs?.base ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMax = options.backoffMs?.max ?? DEFAULT_BACKOFF_MAX_MS;

  // The in-memory mirror of the outbox, so screens can project without waiting
  // for storage on every render.
  const known = new Map<string, OutboxRecord>();
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(event: SyncEvent) => void>();

  let hydrated = false;
  let pumping = false;
  let stopped = false;
  let seq = 0;
  let lastError: string | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serialises storage writes, so sequence numbers follow the order of making. */
  let persistChain: Promise<void> = Promise.resolve();

  const buildState = (): SyncEngineState => {
    let pending = 0;
    let refused = 0;
    for (const op of known.values()) {
      if (op.status === 'failed') refused += 1;
      else pending += 1;
    }
    return { pending, refused, syncing: pumping, lastError, memoryOnly: !store.persistent, hydrated };
  };

  /**
   * The state object handed to `useSyncExternalStore`. It is rebuilt only when
   * something changes — React compares snapshots by identity, and a fresh
   * object on every call would render forever.
   */
  let snapshot = buildState();

  const notify = (): void => {
    snapshot = buildState();
    for (const listener of listeners) listener();
  };

  const emit = (event: SyncEvent): void => {
    for (const listener of eventListeners) listener(event);
  };

  /**
   * Reads the stored operations back. The sequence number continues from the
   * highest ever used, so operations made before a reload keep their order.
   */
  const hydrate = async (): Promise<void> => {
    try {
      const [stored, savedSeq] = await Promise.all([store.outbox.list(accountId), store.kv.get<number>(`${accountId}:seq`)]);
      for (const op of stored) known.set(op.id, op);
      seq = Math.max(typeof savedSeq === 'number' ? savedSeq : 0, ...stored.map((op) => op.seq), 0);
    } catch {
      // Storage is unavailable; the outbox is empty in memory and will be
      // reported as memory-only, so nothing pretends to be durable.
    }
    hydrated = true;
    notify();
    if (!stopped) kick();
  };

  const readyPromise = hydrate();

  /** The next sequence number, assigned in the order operations were made. */
  const nextSeq = async (): Promise<number> => {
    await readyPromise;
    seq += 1;
    return seq;
  };

  const isOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

  const onlineListeners = { online: () => kick(), visible: () => kick() };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onlineListeners.online);
    document.addEventListener('visibilitychange', onlineListeners.visible);
  }

  const backoffDelay = (attempts: number): number => {
    const growth = Math.min(backoffMax, backoffBase * 2 ** Math.max(0, attempts - 1));
    // Full jitter, within a factor of two either way, so many devices do not
    // all come back at the same instant.
    return Math.round(growth * (0.5 + Math.random()));
  };

  const put = async (op: OutboxRecord): Promise<void> => {
    known.set(op.id, op);
    try {
      await store.outbox.put(op);
    } catch {
      lastError = 'The change could not be written to this device’s storage.';
    }
    notify();
  };

  const settle = async (op: OutboxRecord, value: unknown): Promise<void> => {
    known.delete(op.id);
    lastError = null;
    try {
      await store.outbox.remove(op.id);
    } catch {
      // Leaving it stored means it may be sent again after a reload; the
      // request id makes that harmless.
    }
    notify();
    emit({ type: 'settled', op, value });
  };

  const refuse = async (op: OutboxRecord, error: ApiError): Promise<void> => {
    const refusedOp: OutboxRecord = {
      ...op,
      status: 'failed',
      claimedAt: null,
      lastError: error.message,
      lastErrorCode: error.code,
    };
    await put(refusedOp);
    emit({ type: 'refused', op: refusedOp, error });
  };

  const retryLater = (op: OutboxRecord, message: string, delay: number): void => {
    const next: OutboxRecord = {
      ...op,
      status: 'pending',
      attempts: op.attempts + 1,
      claimedAt: null,
      nextAttemptAt: now() + delay,
      lastError: message,
    };
    lastError = message;
    void put(next);
    emit({ type: 'retrying', op: next, message });
  };

  /** The earliest operation whose turn it is, respecting per-word order. */
  const nextSendable = async (skip: ReadonlySet<string>): Promise<OutboxRecord | null> => {
    const all = await store.outbox.list(accountId);
    const at = now();
    const seenEntities = new Set<string>();
    for (const op of all) {
      if (op.entity !== '') {
        // An earlier operation about this word is still stored, so this one
        // must wait for it — whether it is pending or was refused.
        if (seenEntities.has(op.entity)) continue;
        seenEntities.add(op.entity);
      }
      if (op.status === 'failed') continue;
      if (op.nextAttemptAt > at) continue;
      if (skip.has(op.id)) continue;
      return op;
    }
    return null;
  };

  /** Sends one operation; reports what should happen next. */
  const attempt = async (op: OutboxRecord): Promise<'continue' | 'again'> => {
    try {
      const value = await sender(op);
      await settle(op, value);
      return 'continue';
    } catch (error) {
      if (error instanceof ApiError && error.code === 'unauthorized') {
        // Trying every operation against an ended session helps nobody.
        retryLater(op, error.message, SIGNED_OUT_RETRY_MS);
        return 'again';
      }
      if (isRefusal(error)) {
        await refuse(op, error);
        return 'continue';
      }
      // The server could not be reached or failed: back off and try again.
      retryLater(op, messageOf(error), backoffDelay(op.attempts + 1));
      return 'again';
    }
  };

  const schedule = (): void => {
    if (stopped || wakeTimer !== undefined) return;
    let earliest: number | null = null;
    for (const op of known.values()) {
      if (op.status === 'failed') continue;
      if (earliest === null || op.nextAttemptAt < earliest) earliest = op.nextAttemptAt;
    }
    if (earliest === null) return;
    const wait = Math.max(0, Math.min(earliest - now(), 60_000));
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      kick();
    }, wait);
  };

  function kick(): void {
    if (stopped || pumping) return;
    void pump();
  }

  async function pump(): Promise<void> {
    if (stopped || pumping) return;
    pumping = true;
    notify();
    const skip = new Set<string>();
    try {
      await readyPromise;
      for (;;) {
        if (stopped || !isOnline()) break;
        const op = await nextSendable(skip);
        if (op === null) break;
        const claimed = await store.outbox.claim(op.id, now(), claimStaleMs);
        if (claimed === null) {
          // Another tab owns it, it is gone, or its backoff has not passed.
          skip.add(op.id);
          continue;
        }
        known.set(claimed.id, claimed);
        notify();
        const outcome = await attempt(claimed);
        if (outcome === 'again') break;
      }
    } catch (error) {
      // Storage failing mid-send must not take the app down with it.
      lastError = messageOf(error);
      notify();
    } finally {
      pumping = false;
      notify();
      schedule();
    }
  }

  return {
    getState: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    enqueue(input) {
      const id = input.id ?? newRequestId();
      const created: OutboxRecord = {
        id,
        accountId,
        // The real sequence number is assigned when the operation is stored,
        // in the order operations were made.
        seq: 0,
        kind: input.kind,
        payload: input.payload,
        entity: input.entity,
        createdAt: now(),
        answeredAt: input.answeredAt ?? new Date(now()).toISOString(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        claimedAt: null,
        lastError: null,
        lastErrorCode: null,
      };
      known.set(id, created);
      notify();
      // Store it first, then send: an operation never exists only in memory on
      // its way to the server.
      persistChain = persistChain.then(async () => {
        const stored: OutboxRecord = { ...created, seq: await nextSeq() };
        known.set(id, stored);
        try {
          await store.outbox.add(stored);
        } catch {
          lastError = 'The change could not be written to this device’s storage.';
        }
        notify();
        if (!stopped) kick();
      });
      return id;
    },

    kick,

    retry(id) {
      const op = known.get(id);
      if (op === undefined) return;
      void put({ ...op, status: 'pending', nextAttemptAt: 0, claimedAt: null });
      kick();
    },

    dismiss(id) {
      const op = known.get(id);
      if (op === undefined) return;
      known.delete(id);
      void store.outbox.remove(id).catch(() => undefined);
      notify();
      emit({ type: 'dismissed', op });
    },

    async ops() {
      await readyPromise;
      return [...known.values()].sort((a, b) => a.seq - b.seq);
    },

    currentOps() {
      return [...known.values()].sort((a, b) => a.seq - b.seq);
    },

    ready: () => readyPromise,

    stop() {
      stopped = true;
      if (wakeTimer !== undefined) clearTimeout(wakeTimer);
      wakeTimer = undefined;
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onlineListeners.online);
        document.removeEventListener('visibilitychange', onlineListeners.visible);
      }
      listeners.clear();
      eventListeners.clear();
    },
  };
}

/** A store for signed-out use (the built-in sample words), which never persists. */
export function createEphemeralEngine(accountId: string, sender: Sender): SyncEngine {
  return createSyncEngine({ accountId, store: createMemoryStore(), sender });
}
