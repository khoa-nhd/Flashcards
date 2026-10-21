/**
 * The sample data with FSRS as the only schedule (`npm run dev:mock-fsrs`),
 * built the way the dev server builds it. It is what the new screens are made
 * against, so it must behave like a database at schema version 15.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../server/bootstrap.js';
import { MockVocabularyRepository } from '../../server/mock/mock-repository.js';
import {
  queueResponseSchema,
  reviewActionResponseSchema,
  reviewUndoResponseSchema,
  vocabularyListResponseSchema,
} from '../../shared/api.js';
import { TODAY } from '../helpers/fixtures.js';

const ENV = { DATA_MODE: 'mock', REVIEW_TIMEZONE: 'Asia/Ho_Chi_Minh' };

const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('the sample data under FSRS alone', () => {
  it('stays on the mastery schedule unless asked', async () => {
    const { app } = buildApp(ENV);
    const queue = queueResponseSchema.parse(await (await app.request('/api/review-queue')).json());
    expect(queue).toMatchObject({ fsrsOnly: false, scheduler: 'mastery_v1' });
    expect(queue.capabilities.fsrsOnly).toBe(false);
  });

  it('converts the sample words the way version 15 converts real ones', async () => {
    const { app } = buildApp({ ...ENV, MOCK_FSRS_ONLY: 'true' });
    const queue = queueResponseSchema.parse(await (await app.request('/api/review-queue')).json());
    expect(queue).toMatchObject({ fsrsOnly: true, scheduler: 'fsrs' });

    const { entries } = vocabularyListResponseSchema.parse(await (await app.request('/api/vocabulary')).json());
    const byWord = new Map(entries.map((entry) => [entry.word, entry]));
    // Studied words: an estimate from mastery. Never studied: new.
    expect(byWord.get('candid')?.memory).toMatchObject({ level: 9, label: 'Strong', reps: 0 });
    expect(byWord.get('eloquent')).toMatchObject({ reviewStatus: 'overdue', suspended: false });
    expect(byWord.get('eloquent')?.memory).toMatchObject({ level: 10, label: 'Master' });
    expect(byWord.get('tenacious')).toMatchObject({ reviewStatus: 'new' });
    expect(byWord.get('tenacious')?.memory?.level).toBe(1);
    // The old due day is kept: one dated two days ahead is still upcoming.
    expect(byWord.get('pragmatic')).toMatchObject({ reviewStatus: 'upcoming' });
  });

  it('answers, takes back and answers again by revision', async () => {
    const { app } = buildApp({ ...ENV, MOCK_FSRS_ONLY: 'true' });
    const queue = queueResponseSchema.parse(await (await app.request('/api/review-queue')).json());
    const card = queue.cards.find((item) => item.word === 'tenacious')!;
    expect(card.revision).toBe(0);

    const requestId = crypto.randomUUID();
    const first = reviewActionResponseSchema.parse(
      await (
        await app.request('/api/review-action', post({ pageId: card.id, action: 'remember', expected: { mastery: card.mastery, nextReview: card.nextReview }, expectedRevision: 0, requestId }))
      ).json(),
    );
    expect(first).toMatchObject({ outcome: 'applied', state: { revision: 1 } });

    const undo = reviewUndoResponseSchema.parse(
      await (await app.request('/api/review-undo', post({ reviewRequestId: requestId, requestId: crypto.randomUUID() }))).json(),
    );
    // Back to new: no FSRS state, and its own fallback day again.
    expect(undo).toMatchObject({ outcome: 'undone', state: { revision: 2, fsrs: null, dueOn: expect.any(String) } });

    const stale = await app.request(
      '/api/review-action',
      post({ pageId: card.id, action: 'remember', expected: { mastery: card.mastery, nextReview: card.nextReview }, expectedRevision: 0, requestId: crypto.randomUUID() }),
    );
    expect(stale.status).toBe(409);
    const again = await app.request(
      '/api/review-action',
      post({ pageId: card.id, action: 'not_remember', expected: { mastery: card.mastery, nextReview: card.nextReview }, expectedRevision: 2, requestId: crypto.randomUUID() }),
    );
    expect(again.status).toBe(200);
  });

  it('archives in bulk, and an archived word leaves the queue', async () => {
    const { app } = buildApp({ ...ENV, MOCK_FSRS_ONLY: 'true' });
    const before = queueResponseSchema.parse(await (await app.request('/api/review-queue')).json());
    const target = before.cards[0]!;
    const response = await app.request('/api/vocabulary/archive', post({ ids: [target.id], archived: true }));
    expect(((await response.json()) as { archived: number }).archived).toBe(1);
    const after = queueResponseSchema.parse(await (await app.request('/api/review-queue')).json());
    expect(after.cards.map((item) => item.id)).not.toContain(target.id);
  });

  it('cannot archive on the mastery schedule', async () => {
    const repository = new MockVocabularyRepository(TODAY);
    expect(await repository.setEntriesSuspended(['00000000-0000-4000-8000-000000000001'], true)).toEqual([]);
  });
});
