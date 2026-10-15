/**
 * Global practice history cache with incremental updates.
 * Avoids repeated full-history fetches and enables incremental updates.
 */
import type { PracticeAnswer } from '../../shared/true-mastery.js';
import type { IsoDate } from '../../shared/dates.js';

interface CachedPracticeHistory {
  answers: PracticeAnswer[];
  fetchedAt: number;
  since: IsoDate | null;
}

interface CacheEntry {
  data: CachedPracticeHistory;
  promise: Promise<CachedPracticeHistory> | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map<string, CacheEntry>(); // key: accountId (or 'global' for no account)
const subscribers = new Map<string, Set<() => void>>();

/** Get cache key based on account context */
function getCacheKey(since: IsoDate | null): string {
  // In this app, each account has its own history, but we don't have accountId here
  // The API already scopes to the current user, so we use a global key
  return `practice-history:${since ?? 'all'}`;
}

/** Notify subscribers of cache changes */
function notifySubscribers(since: IsoDate | null): void {
  const key = getCacheKey(since);
  const subs = subscribers.get(key);
  if (subs) {
    for (const callback of subs) callback();
  }
}

/** Subscribe to cache updates */
export function subscribeToPracticeHistory(since: IsoDate | null, callback: () => void): () => void {
  const key = getCacheKey(since);
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key)!.add(callback);
  return () => {
    const subs = subscribers.get(key);
    if (subs) subs.delete(callback);
  };
}

/** Get cached data if fresh, otherwise return null */
export function getCachedPracticeHistory(since: IsoDate | null): CachedPracticeHistory | null {
  const key = getCacheKey(since);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.data.fetchedAt > CACHE_TTL_MS) return null;
  return entry.data;
}

/** Set cache data */
export function setCachedPracticeHistory(since: IsoDate | null, answers: PracticeAnswer[]): void {
  const key = getCacheKey(since);
  cache.set(key, {
    data: { answers, fetchedAt: Date.now(), since },
    promise: null,
  });
  notifySubscribers(since);
}

/** Invalidate cache for a specific since value */
export function invalidatePracticeHistory(since: IsoDate | null): void {
  const key = getCacheKey(since);
  cache.delete(key);
  notifySubscribers(since);
}

/** Invalidate all practice history caches */
export function invalidateAllPracticeHistory(): void {
  cache.clear();
  for (const subs of subscribers.values()) {
    for (const callback of subs) callback();
  }
}

/** Optimistically add a new practice answer to the cache */
export function addPracticeAnswerToCache(since: IsoDate | null, answer: PracticeAnswer): void {
  const key = getCacheKey(since);
  const entry = cache.get(key);
  if (!entry) return;

  // Check for duplicate by requestId
  const exists = entry.data.answers.some(a => a.requestId === answer.requestId);
  if (exists) return;

  const newAnswers = [...entry.data.answers, answer];
  entry.data = { ...entry.data, answers: newAnswers };
  notifySubscribers(since);
}

/** Optimistically update a practice answer in the cache (for retries) */
export function updatePracticeAnswerInCache(since: IsoDate | null, requestId: string, updates: Partial<PracticeAnswer>): void {
  const key = getCacheKey(since);
  const entry = cache.get(key);
  if (!entry) return;

  entry.data.answers = entry.data.answers.map(a =>
    a.requestId === requestId ? { ...a, ...updates } : a
  );
  notifySubscribers(since);
}

/** Remove a practice answer from cache (for undo) */
export function removePracticeAnswerFromCache(since: IsoDate | null, requestId: string): void {
  const key = getCacheKey(since);
  const entry = cache.get(key);
  if (!entry) return;

  entry.data.answers = entry.data.answers.filter(a => a.requestId !== requestId);
  notifySubscribers(since);
}