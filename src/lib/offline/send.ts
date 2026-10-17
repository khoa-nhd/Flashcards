/**
 * Turns one outbox operation into the one request that performs it. The
 * request is built field by field — never by forwarding the stored payload —
 * so local-only fields (like the word kept for notices) can never travel, and
 * the client-generated operation id is what the server deduplicates by.
 */
import { ApiError, type AppApi } from '../api-client.js';
import type { ReviewActionPayload, PracticePayload, VocabCreatePayload, VocabUpdatePayload, VocabDeletePayload } from './ops.js';
import type { OutboxRecord } from './storage.js';
import type { Sender } from './sync-engine.js';

/** Maps a temporary word id to the real one once its create has settled. */
export type IdResolver = (id: string) => string;

export function createSender(api: AppApi, resolveId: IdResolver): Sender {
  return async (op: OutboxRecord): Promise<unknown> => {
    switch (op.kind) {
      case 'review_action': {
        const payload = op.payload as unknown as ReviewActionPayload;
        return api.submitAction({
          pageId: resolveId(payload.pageId),
          action: payload.action,
          expected: payload.expected,
          requestId: op.id,
          durationMs: payload.durationMs ?? undefined,
          sessionId: payload.sessionId ?? undefined,
          allowNotDue: payload.allowNotDue === true,
          countsTowardMastery: payload.countsTowardMastery !== false,
          ...(payload.confidence == null ? {} : { confidence: payload.confidence }),
          // The instant the answer was given, so an offline answer lands on the
          // day it was answered rather than the day it synced.
          answeredAt: op.answeredAt,
        });
      }
      case 'practice': {
        const payload = op.payload as unknown as PracticePayload;
        return api.submitPractice({
          pageId: resolveId(payload.pageId),
          mode: payload.mode,
          answer: payload.answer,
          requestId: op.id,
          sessionId: payload.sessionId ?? undefined,
          durationMs: payload.durationMs ?? undefined,
          ...(payload.confidence == null ? {} : { confidence: payload.confidence }),
          answeredAt: op.answeredAt,
        });
      }
      case 'vocab_create': {
        const payload = op.payload as unknown as VocabCreatePayload;
        // The request id doubles as the operation's name for the server's
        // duplicate-create guard.
        return api.createEntry({ ...payload.input, requestId: op.id });
      }
      case 'vocab_update': {
        const payload = op.payload as unknown as VocabUpdatePayload;
        // Updates carry absolute values, so sending one twice changes nothing.
        return api.updateEntry(resolveId(payload.id), payload.input);
      }
      case 'vocab_delete': {
        const payload = op.payload as unknown as VocabDeletePayload;
        try {
          await api.deleteEntry(resolveId(payload.id));
          return { deleted: true };
        } catch (error) {
          // The word is already gone — the first attempt must have landed —
          // so the desired end state is reached either way.
          if (error instanceof ApiError && error.code === 'not_found') return { deleted: true };
          throw error;
        }
      }
    }
  };
}
