/**
 * A durable, offline-first mutation queue for study interactions.
 *
 * Design goals:
 * - Mutations are enqueued without blocking the UI.
 * - Pending mutations survive page refresh / browser restart (IndexedDB).
 * - Retries with exponential backoff + jitter for transient failures.
 * - Resumes sync when connectivity returns or the app regains focus.
 * - Idempotent via stable request IDs generated once per user action.
 * - Distinguishes transient failures (retry) from permanent errors (surface for recovery).
 * - Account isolation: queue is cleared on sign-out.
 * - Small, explicit mutation types; no competing state system.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ReviewAction } from '../../shared/review-logic.js';
import type { PracticeRequest } from '../../shared/api.js';
import type { VocabularyEntry } from '../../shared/api.js';
import { newRequestId } from './request-id.js';

// -----------------------------------------------------------------------------
// Mutation types
// -----------------------------------------------------------------------------

export type MutationKind =
  | 'review_action'
  | 'practice_answer'
  | 'review_undo'
  | 'vocabulary_upsert'
  | 'vocabulary_delete'
  | 'vocabulary_restore'
  | 'collection_create'
  | 'collection_rename'
  | 'collection_delete'
  | 'collection_membership'
  | 'example_add'
  | 'example_update'
  | 'example_delete'
  | 'relation_add'
  | 'relation_delete'
  | 'goal_save'
  | 'settings_save'
  | 'scheduler_choose';

export interface BaseMutation {
  /** Stable ID for this mutation, generated once and reused on retry. */
  id: string;
  /** Discriminant for the payload. */
  kind: MutationKind;
  /** When the mutation was first enqueued (ms since epoch). */
  createdAt: number;
  /** Account/user this mutation belongs to. Empty string for unauthenticated (mock) mode. */
  accountId: string;
  /** Number of sync attempts made. */
  attempt: number;
  /** The last error, if the most recent attempt failed. */
  lastError: string | null;
  /** `transient` = will retry; `permanent` = will not retry, needs user action. */
  status: 'pending' | 'syncing' | 'transient' | 'permanent' | 'synced';
  /** The server response when synced, for reconciliation. */
  serverResponse: unknown | null;
}

export interface ReviewActionMutation extends BaseMutation {
  kind: 'review_action';
  payload: {
    pageId: string;
    action: ReviewAction;
    expected: { mastery: number; nextReview: string | null };
    requestId: string;
    durationMs: number;
    sessionId: string;
    confidence: 1 | 2 | 3 | null;
  };
}

export interface PracticeAnswerMutation extends BaseMutation {
  kind: 'practice_answer';
  payload: PracticeRequest & { requestId: string };
}

export interface ReviewUndoMutation extends BaseMutation {
  kind: 'review_undo';
  payload: {
    reviewRequestId: string;
    requestId: string;
  };
}

export interface VocabularyUpsertMutation extends BaseMutation {
  kind: 'vocabulary_upsert';
  payload: VocabularyEntry;
}

export interface VocabularyDeleteMutation extends BaseMutation {
  kind: 'vocabulary_delete';
  payload: { id: string };
}

export interface VocabularyRestoreMutation extends BaseMutation {
  kind: 'vocabulary_restore';
  payload: { id: string };
}

export interface CollectionCreateMutation extends BaseMutation {
  kind: 'collection_create';
  payload: { name: string; requestId: string };
}

export interface CollectionRenameMutation extends BaseMutation {
  kind: 'collection_rename';
  payload: { id: string; name: string; requestId: string };
}

export interface CollectionDeleteMutation extends BaseMutation {
  kind: 'collection_delete';
  payload: { id: string; requestId: string };
}

export interface CollectionMembershipMutation extends BaseMutation {
  kind: 'collection_membership';
  payload: { collectionId: string; wordId: string; member: boolean; requestId: string };
}

export interface ExampleAddMutation extends BaseMutation {
  kind: 'example_add';
  payload: { wordId: string; sentence: string; source: string | null; preferred: boolean; requestId: string };
}

export interface ExampleUpdateMutation extends BaseMutation {
  kind: 'example_update';
  payload: { id: string; sentence?: string; source?: string | null; preferred?: boolean; requestId: string };
}

export interface ExampleDeleteMutation extends BaseMutation {
  kind: 'example_delete';
  payload: { id: string; requestId: string };
}

export interface RelationAddMutation extends BaseMutation {
  kind: 'relation_add';
  payload: { fromId: string; toId: string; kind: string; requestId: string };
}

export interface RelationDeleteMutation extends BaseMutation {
  kind: 'relation_delete';
  payload: { id: string; requestId: string };
}

export interface GoalSaveMutation extends BaseMutation {
  kind: 'goal_save';
  payload: { reviews: number | null; minutes: number | null; requestId: string };
}

export interface SettingsSaveMutation extends BaseMutation {
  kind: 'settings_save';
  payload: { timeZone?: string; fsrsRetention?: number | null; requestId: string };
}

export interface SchedulerChooseMutation extends BaseMutation {
  kind: 'scheduler_choose';
  payload: { scheduler: string; requestId: string };
}

export type Mutation =
  | ReviewActionMutation
  | PracticeAnswerMutation
  | ReviewUndoMutation
  | VocabularyUpsertMutation
  | VocabularyDeleteMutation
  | VocabularyRestoreMutation
  | CollectionCreateMutation
  | CollectionRenameMutation
  | CollectionDeleteMutation
  | CollectionMembershipMutation
  | ExampleAddMutation
  | ExampleUpdateMutation
  | ExampleDeleteMutation
  | RelationAddMutation
  | RelationDeleteMutation
  | GoalSaveMutation
  | SettingsSaveMutation
  | SchedulerChooseMutation;

// -----------------------------------------------------------------------------
// IndexedDB schema
// -----------------------------------------------------------------------------

interface MutationQueueDB extends DBSchema {
  mutations: {
    key: string;
    value: Mutation;
    indexes: { 'by-account': string; 'by-status': string; 'by-kind': string; 'by-created': number };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
}

const DB_NAME = 'flashcards-mutation-queue';
const DB_VERSION = 1;

// -----------------------------------------------------------------------------
// Retry policy
// -----------------------------------------------------------------------------

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 10;

function nextBackoff(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = Math.random() * 0.5 * base;
  return Math.round(base + jitter);
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('could not reach') ||
      message.includes('offline') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('504')
    );
  }
  return false;
}

function isPermanentError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('unauthorized') ||
      message.includes('401') ||
      message.includes('403') ||
      message.includes('not_found') ||
      message.includes('conflict') ||
      message.includes('duplicate') ||
      message.includes('invalid') ||
      message.includes('not_supported') ||
      message.includes('read_only')
    );
  }
  return false;
}

// -----------------------------------------------------------------------------
// Mutation queue input type (what callers pass to enqueue)
// -----------------------------------------------------------------------------

// Callers must not provide accountId; the queue sets it from the current account.
type MutationInput = Omit<Mutation, 'id' | 'createdAt' | 'attempt' | 'lastError' | 'status' | 'serverResponse' | 'accountId'>;

// Internal type for mutations in the queue (adds internal tracking fields)
type QueuedMutation = Mutation & {
  /** Resolve/reject functions for the enqueue promise (not used currently). */
  _resolve?: () => void;
  _reject?: (error: Error) => void;
};

// -----------------------------------------------------------------------------
// MutationQueue class (per-instance state)
// -----------------------------------------------------------------------------

type Listener = () => void;
// Use a generic handler type that allows specific payload types
type MutationHandler<P = unknown> = (payload: P) => Promise<unknown>;

/** Global test mode flag for all mutation queue instances. */
let globalTestMode = false;

export function setGlobalTestMode(enabled: boolean): void {
  globalTestMode = enabled;
}

export function getGlobalTestMode(): boolean {
  return globalTestMode;
}

export class MutationQueue {
  private dbPromise: Promise<IDBPDatabase<MutationQueueDB>> | null = null;
  private listeners = new Set<Listener>();
  private currentAccountId = '';
  private syncInProgress = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineListenerAdded = false;
  private handlers = new Map<MutationKind, MutationHandler<unknown>>();
  private pendingMutations: QueuedMutation[] = [];

  private get testMode(): boolean {
    return globalTestMode;
  }

  constructor() {
    this.setupOnlineListener();
  }

  private getDB(): Promise<IDBPDatabase<MutationQueueDB>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<MutationQueueDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          const store = db.createObjectStore('mutations', { keyPath: 'id' });
          store.createIndex('by-account', 'accountId');
          store.createIndex('by-status', 'status');
          store.createIndex('by-kind', 'kind');
          store.createIndex('by-created', 'createdAt');
          db.createObjectStore('meta', { keyPath: 'key' });
        },
      });
    }
    return this.dbPromise;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleSync(delayMs: number = 0): void {
    if (this.testMode) {
      // In test mode, enqueue already processes synchronously via processTestMutation
      return;
    }
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.processQueue(), delayMs);
  }

  /** Register a handler for a mutation kind. */
  registerHandler<P>(kind: MutationKind, handler: MutationHandler<P>): void {
    this.handlers.set(kind, handler as MutationHandler<unknown>);
  }

  /** Unregister a handler. */
  unregisterHandler(kind: MutationKind): void {
    this.handlers.delete(kind);
  }

  /** Enable synchronous mutation processing for tests. */
  setTestMode(enabled: boolean): void {
    globalTestMode = enabled;
  }

  /** Set the current account ID. Triggers a sync. */
  setAccountId(accountId: string): void {
    if (this.currentAccountId === accountId) return;
    this.currentAccountId = accountId;
    this.notify();
    this.scheduleSync(0);
  }

  getAccountId(): string {
    return this.currentAccountId;
  }

  /** Whether a sync is currently in progress. */
  isSyncing(): boolean {
    return this.syncInProgress;
  }

  /** Subscribe to queue changes. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Enqueue a mutation for background sync. Returns the mutation ID. Throws if no account is set or persistence fails. */
  async enqueue(mutation: MutationInput): Promise<string> {
    if (!this.currentAccountId) {
      throw new Error('Cannot enqueue mutation: no account ID set. Call setAccountId() first.');
    }

    const id = newRequestId();
    const fullMutation = {
      ...mutation,
      id,
      createdAt: Date.now(),
      attempt: 0,
      lastError: null,
      status: 'pending' as const,
      serverResponse: null,
      accountId: this.currentAccountId,
    } as QueuedMutation;

    if (this.testMode) {
      // In test mode, process immediately by calling the handler directly
      this.pendingMutations.push(fullMutation);
      await this.processTestMutation(fullMutation);
      this.notify();
    } else {
      const db = await this.getDB();
      await db.put('mutations', fullMutation);
      this.notify();
      this.scheduleSync(0);
    }
    return id;
  }

  private async processTestMutation(mutation: QueuedMutation): Promise<void> {
    const handler = this.handlers.get(mutation.kind);
    if (!handler) {
      console.warn(`No handler registered for mutation kind: ${mutation.kind}`);
      return;
    }
    // Increment attempt to match non-test mode behavior (syncMutation increments before calling handler)
    mutation.attempt += 1;
    try {
      const response = await handler(mutation.payload);
      mutation.status = 'synced';
      mutation.lastError = null;
      mutation.serverResponse = response;
    } catch (error) {
      const transient = isTransientError(error);
      const permanent = isPermanentError(error);
      const nextAttempt = mutation.attempt + 1;

      if (transient && nextAttempt < MAX_ATTEMPTS) {
        mutation.status = 'transient';
        mutation.lastError = error instanceof Error ? error.message : String(error);
        mutation.attempt = nextAttempt;
      } else if (permanent || nextAttempt >= MAX_ATTEMPTS) {
        mutation.status = 'permanent';
        mutation.lastError = error instanceof Error ? error.message : String(error);
        mutation.attempt = nextAttempt;
      } else {
        mutation.status = 'transient';
        mutation.lastError = error instanceof Error ? error.message : String(error);
        mutation.attempt = nextAttempt;
      }
    }
    this.notify();
  }

  /** Get all mutations for the current account. */
  async getAll(): Promise<Mutation[]> {
    if (this.testMode) {
      return this.pendingMutations.filter((m) => m.accountId === this.currentAccountId) as Mutation[];
    }
    const db = await this.getDB();
    return db.getAllFromIndex('mutations', 'by-account', this.currentAccountId);
  }

  /** Get mutations by status. */
  async getByStatus(status: Mutation['status']): Promise<Mutation[]> {
    if (this.testMode) {
      return this.pendingMutations.filter(
        (m) => m.accountId === this.currentAccountId && m.status === status,
      ) as Mutation[];
    }
    const db = await this.getDB();
    const all = await db.getAllFromIndex('mutations', 'by-status', status);
    return all.filter((m) => m.accountId === this.currentAccountId);
  }

  /** Manually retry a failed mutation. */
  async retry(id: string): Promise<void> {
    if (this.testMode) {
      const mutation = this.pendingMutations.find((m) => m.id === id);
      if (!mutation || mutation.accountId !== this.currentAccountId) return;
      if (mutation.status === 'synced' || mutation.status === 'permanent') return;
      mutation.status = 'pending';
      mutation.lastError = null;
      await this.processTestMutation(mutation);
      this.notify();
      return;
    }
    const db = await this.getDB();
    const mutation = await db.get('mutations', id);
    if (!mutation || mutation.accountId !== this.currentAccountId) return;
    if (mutation.status === 'synced' || mutation.status === 'permanent') return;
    await db.put('mutations', { ...mutation, status: 'pending', lastError: null });
    this.notify();
    this.scheduleSync(0);
  }

  /** Discard a failed mutation (mark as resolved without syncing). */
  async discard(id: string): Promise<void> {
    if (this.testMode) {
      this.pendingMutations = this.pendingMutations.filter((m) => m.id !== id);
      this.notify();
      return;
    }
    const db = await this.getDB();
    const mutation = await db.get('mutations', id);
    if (!mutation || mutation.accountId !== this.currentAccountId) return;
    await db.delete('mutations', id);
    this.notify();
  }

  /** Clear all mutations for the current account (e.g., on sign out). */
  async clearAccount(): Promise<void> {
    if (this.testMode) {
      this.pendingMutations = this.pendingMutations.filter(
        (m) => m.accountId !== this.currentAccountId,
      );
      this.notify();
      return;
    }
    const db = await this.getDB();
    const all = await db.getAllFromIndex('mutations', 'by-account', this.currentAccountId);
    for (const mutation of all) {
      await db.delete('mutations', mutation.id);
    }
    this.notify();
  }

  /** Get the count of pending/transient mutations. */
  async getPendingCount(): Promise<number> {
    if (this.testMode) {
      return this.pendingMutations.filter(
        (m) => m.accountId === this.currentAccountId && m.status !== 'synced',
      ).length;
    }
    const db = await this.getDB();
    const pending = await db.getAllFromIndex('mutations', 'by-status', 'pending');
    const transient = await db.getAllFromIndex('mutations', 'by-status', 'transient');
    return [...pending, ...transient].filter((m) => m.accountId === this.currentAccountId).length;
  }

  // ---------------------------------------------------------------------------
  // Background sync (non-test mode)
  // ---------------------------------------------------------------------------

  private async processQueue(): Promise<void> {
    if (this.syncInProgress) return;
    const db = await this.getDB();
    const pending = await db.getAllFromIndex('mutations', 'by-status', 'pending');
    const transient = await db.getAllFromIndex('mutations', 'by-status', 'transient');
    const all = [...pending, ...transient].filter((m) => m.accountId === this.currentAccountId);
    if (all.length === 0) return;

    this.syncInProgress = true;
    this.notify();

    for (const mutation of all) {
      if (mutation.accountId !== this.currentAccountId) continue;
      await this.syncMutation(mutation);
    }

    this.syncInProgress = false;
    this.notify();

    // If more mutations arrived while we were syncing, schedule another pass
    const remaining = await db.getAllFromIndex('mutations', 'by-status', 'pending');
    const moreTransient = await db.getAllFromIndex('mutations', 'by-status', 'transient');
    if ([...remaining, ...moreTransient].some((m) => m.accountId === this.currentAccountId)) {
      this.scheduleSync(100);
    }
  }

  private async syncMutation(mutation: Mutation): Promise<void> {
    const db = await this.getDB();
    await db.put('mutations', { ...mutation, status: 'syncing', attempt: mutation.attempt + 1 });
    this.notify();

    try {
      const handler = this.handlers.get(mutation.kind);
      if (!handler) throw new Error(`No handler registered for mutation kind: ${mutation.kind}`);
      const response = await handler(mutation.payload);
      await db.put('mutations', {
        ...mutation,
        status: 'synced',
        lastError: null,
        serverResponse: response,
      });
      this.notify();
    } catch (error) {
      const transient = isTransientError(error);
      const permanent = isPermanentError(error);
      const nextAttempt = mutation.attempt + 1;

      if (transient && nextAttempt < MAX_ATTEMPTS) {
        const backoff = nextBackoff(nextAttempt);
        await db.put('mutations', {
          ...mutation,
          status: 'transient',
          lastError: error instanceof Error ? error.message : String(error),
          attempt: nextAttempt,
        });
        this.scheduleSync(backoff);
      } else if (permanent || nextAttempt >= MAX_ATTEMPTS) {
        await db.put('mutations', {
          ...mutation,
          status: 'permanent',
          lastError: error instanceof Error ? error.message : String(error),
          attempt: nextAttempt,
        });
      } else {
        const backoff = nextBackoff(nextAttempt);
        await db.put('mutations', {
          ...mutation,
          status: 'transient',
          lastError: error instanceof Error ? error.message : String(error),
          attempt: nextAttempt,
        });
        this.scheduleSync(backoff);
      }
      this.notify();
    }
  }

  // ---------------------------------------------------------------------------
  // Online/offline handling
  // ---------------------------------------------------------------------------

  private setupOnlineListener(): void {
    if (this.onlineListenerAdded || typeof window === 'undefined') return;
    this.onlineListenerAdded = true;
    window.addEventListener('online', () => {
      this.scheduleSync(0);
    });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.scheduleSync(0);
      }
    });
    window.addEventListener('focus', () => {
      this.scheduleSync(0);
    });
  }
}

// -----------------------------------------------------------------------------
// Convenience enqueue helpers
// -----------------------------------------------------------------------------

export async function enqueueReviewAction(
  queue: MutationQueue,
  payload: ReviewActionMutation['payload'],
): Promise<string> {
  return queue.enqueue(createBaseMutation('review_action', payload));
}

export async function enqueuePracticeAnswer(
  queue: MutationQueue,
  payload: PracticeAnswerMutation['payload'],
): Promise<string> {
  return queue.enqueue(createBaseMutation('practice_answer', payload));
}

export async function enqueueReviewUndo(
  queue: MutationQueue,
  payload: ReviewUndoMutation['payload'],
): Promise<string> {
  return queue.enqueue(createBaseMutation('review_undo', payload));
}

export async function enqueueVocabularyUpsert(
  queue: MutationQueue,
  payload: VocabularyUpsertMutation['payload'],
): Promise<string> {
  return queue.enqueue(createBaseMutation('vocabulary_upsert', payload));
}

export async function enqueueVocabularyDelete(
  queue: MutationQueue,
  payload: VocabularyDeleteMutation['payload'],
): Promise<string> {
  return queue.enqueue(createBaseMutation('vocabulary_delete', payload));
}

export async function enqueueVocabularyRestore(
  queue: MutationQueue,
  payload: VocabularyRestoreMutation['payload'],
): Promise<string> {
  return queue.enqueue(createBaseMutation('vocabulary_restore', payload));
}

function createBaseMutation(kind: MutationKind, payload: unknown): MutationInput {
  return {
    kind,
    payload: payload as Mutation['payload'],
  } as MutationInput;
}

// -----------------------------------------------------------------------------
// Sync status for UI
// -----------------------------------------------------------------------------

export interface SyncStatus {
  pending: number;
  syncing: boolean;
  lastSyncAt: number | null;
  hasPermanentErrors: boolean;
}

let lastSyncAt: number | null = null;

export function getSyncStatus(queue: MutationQueue): Promise<SyncStatus> {
  return queue.getPendingCount().then((pending) => ({
    pending,
    syncing: queue.isSyncing(),
    lastSyncAt,
    hasPermanentErrors: false,
  }));
}

function markSynced(): void {
  lastSyncAt = Date.now();
}

export function onMutationSynced(): void {
  markSynced();
}