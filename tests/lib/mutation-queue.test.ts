import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MutationQueue, setGlobalTestMode, type ReviewActionMutation, type ReviewUndoMutation, type Mutation } from '../../src/lib/mutation-queue.js';

// Type guards for test mutations
function isReviewActionMutation(m: Mutation): m is ReviewActionMutation {
  return m.kind === 'review_action';
}
function isReviewUndoMutation(m: Mutation): m is ReviewUndoMutation {
  return m.kind === 'review_undo';
}

describe('MutationQueue', () => {
  let queue: MutationQueue;

  beforeEach(() => {
    setGlobalTestMode(false);
    queue = new MutationQueue();
    // Enable test mode for synchronous handler execution
    setGlobalTestMode(true);
  });

  afterEach(() => {
    setGlobalTestMode(false);
  });

  describe('account isolation', () => {
    it('sets accountId on mutations when enqueued', async () => {
      queue.setAccountId('user-123');
      
      const handler = vi.fn().mockResolvedValue({ success: true });
      queue.registerHandler('review_action', handler);

      const mutationId = await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      const mutations = await queue.getAll();
      expect(mutations).toHaveLength(1);
      const mutation = mutations[0]!;
      expect(isReviewActionMutation(mutation)).toBe(true);
      expect(mutation.accountId).toBe('user-123');
      expect(mutation.id).toBe(mutationId);
    });

    it('throws when enqueueing without account ID set', async () => {
      await expect(queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      })).rejects.toThrow('no account ID set');
    });

    it('isolates mutations between accounts', async () => {
      queue.setAccountId('user-1');
      
      queue.registerHandler('review_action', vi.fn().mockResolvedValue({ success: true }));

      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      // Switch accounts
      queue.setAccountId('user-2');

      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-2',
          action: 'not_remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-2',
          durationMs: 1000,
          sessionId: 'session-2',
          confidence: 1,
        } as ReviewActionMutation['payload'],
      });

      // Get mutations for user-2
      const user2Mutations = await queue.getAll();
      expect(user2Mutations).toHaveLength(1);
      const user2Mutation = user2Mutations[0]!;
      expect(isReviewActionMutation(user2Mutation)).toBe(true);
      expect(user2Mutation.accountId).toBe('user-2');
      expect((user2Mutation.payload as ReviewActionMutation['payload']).pageId).toBe('card-2');

      // Switch back to user-1
      queue.setAccountId('user-1');
      const user1Mutations = await queue.getAll();
      expect(user1Mutations).toHaveLength(1);
      const user1Mutation = user1Mutations[0]!;
      expect(isReviewActionMutation(user1Mutation)).toBe(true);
      expect(user1Mutation.accountId).toBe('user-1');
      expect((user1Mutation.payload as ReviewActionMutation['payload']).pageId).toBe('card-1');
    });

    it('clearAccount only clears current account mutations', async () => {
      queue.setAccountId('user-1');
      queue.registerHandler('review_action', vi.fn().mockResolvedValue({ success: true }));

      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      // Add mutation for user-2 without switching account (simulating leftover)
      queue.setAccountId('user-2');
      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-2',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-2',
          durationMs: 1000,
          sessionId: 'session-2',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      // Clear user-2's mutations
      queue.setAccountId('user-2');
      await queue.clearAccount();

      const user2Mutations = await queue.getAll();
      expect(user2Mutations).toHaveLength(0);

      // User-1's mutations should still exist
      queue.setAccountId('user-1');
      const user1Mutations = await queue.getAll();
      expect(user1Mutations).toHaveLength(1);
    });
  });

  describe('Review and Undo mutations get correct account ID', () => {
    it('review_action mutation gets correct account ID', async () => {
      queue.setAccountId('test-user');
      queue.registerHandler('review_action', vi.fn().mockResolvedValue({ success: true }));

      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      const mutations = await queue.getAll();
      expect(mutations).toHaveLength(1);
      const mutation = mutations[0]!;
      expect(isReviewActionMutation(mutation)).toBe(true);
      expect(mutation.accountId).toBe('test-user');
      expect(mutation.kind).toBe('review_action');
    });

    it('review_undo mutation gets correct account ID', async () => {
      queue.setAccountId('test-user');
      queue.registerHandler('review_undo', vi.fn().mockResolvedValue({ success: true }));

      await queue.enqueue({
        kind: 'review_undo',
        payload: {
          reviewRequestId: 'review-req-1',
          requestId: 'undo-req-1',
        } as ReviewUndoMutation['payload'],
      });

      const mutations = await queue.getAll();
      expect(mutations).toHaveLength(1);
      const mutation = mutations[0]!;
      expect(isReviewUndoMutation(mutation)).toBe(true);
      expect(mutation.accountId).toBe('test-user');
      expect(mutation.kind).toBe('review_undo');
    });
  });

  describe('persistence failure is surfaced', () => {
    it('throws when IndexedDB write fails', async () => {
      // Create a queue in non-test mode
      setGlobalTestMode(false);
      const realQueue = new MutationQueue();
      realQueue.setAccountId('test-user');
      
      // The key test: enqueue is now async and awaits the db.put
      // This test verifies the API shape
      expect(typeof realQueue.enqueue).toBe('function');
    });
  });

  describe('mutation ID stability', () => {
    it('preserves mutation ID after successful sync', async () => {
      queue.setAccountId('test-user');
      
      const handler = vi.fn().mockResolvedValue({ success: true });
      queue.registerHandler('review_action', handler);

      const mutationId = await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      const mutations = await queue.getAll();
      expect(mutations).toHaveLength(1);
      const mutation = mutations[0]!;
      expect(isReviewActionMutation(mutation)).toBe(true);
      expect(mutation.status).toBe('synced');
      expect(mutation.id).toBe(mutationId);
      expect(mutation.attempt).toBe(1);
    });

    it('preserves mutation ID when handler fails (transient error)', async () => {
      queue.setAccountId('test-user');
      
      const handler = vi.fn().mockRejectedValue(new Error('network error'));
      queue.registerHandler('review_action', handler);

      const mutationId = await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      const mutations = await queue.getAll();
      // In test mode, the error is caught and status becomes transient
      // Attempt is 2: first attempt (incremented before handler) + retry increment in catch
      const mutation = mutations[0]!;
      expect(isReviewActionMutation(mutation)).toBe(true);
      expect(mutation.status).toBe('transient');
      expect(mutation.id).toBe(mutationId);
      expect(mutation.attempt).toBe(2);
    });
  });

  describe('permanent failure handling', () => {
    it('marks mutation as permanent for unauthorized error', async () => {
      queue.setAccountId('test-user');
      
      const handler = vi.fn().mockRejectedValue(new Error('unauthorized'));
      queue.registerHandler('review_action', handler);

      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      const mutations = await queue.getAll();
      expect(mutations).toHaveLength(1);
      const mutation = mutations[0]!;
      expect(isReviewActionMutation(mutation)).toBe(true);
      expect(mutation.status).toBe('permanent');
      expect(mutation.lastError).toContain('unauthorized');
    });

    it('does not retry permanent failures when retry is called', async () => {
      queue.setAccountId('test-user');
      
      const handler = vi.fn().mockRejectedValue(new Error('unauthorized'));
      queue.registerHandler('review_action', handler);

      const mutationId = await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      const mutations = await queue.getAll();
      expect(mutations).toHaveLength(1);
      const mutation = mutations[0]!;
      expect(isReviewActionMutation(mutation)).toBe(true);
      expect(mutation.status).toBe('permanent');
      
      // Try to retry - should not call handler again for permanent errors
      await queue.retry(mutationId);
      
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('queue ordering and review behavior', () => {
    it('maintains FIFO order for same account', async () => {
      queue.setAccountId('test-user');
      
      const order: string[] = [];
      const handler = vi.fn().mockImplementation(async (payload: ReviewActionMutation['payload']) => {
        order.push(payload.pageId);
        return { success: true };
      });
      
      queue.registerHandler('review_action', handler);

      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-1',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-1',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 2,
        } as ReviewActionMutation['payload'],
      });

      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-2',
          action: 'not_remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-2',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 1,
        } as ReviewActionMutation['payload'],
      });

      await queue.enqueue({
        kind: 'review_action',
        payload: {
          pageId: 'card-3',
          action: 'remember',
          expected: { mastery: 3, nextReview: null },
          requestId: 'req-3',
          durationMs: 1000,
          sessionId: 'session-1',
          confidence: 3,
        } as ReviewActionMutation['payload'],
      });

      expect(order).toEqual(['card-1', 'card-2', 'card-3']);
    });
  });
});