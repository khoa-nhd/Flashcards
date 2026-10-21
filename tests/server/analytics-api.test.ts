/**
 * Analytics and Weak Words through the HTTP API on the real schema: counted
 * from saved answers, per account, with undone answers left out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_CAPABILITIES,
  analyticsResponseSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  weakWordsResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { MASTERY_ERA_MIGRATIONS, createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  db = await createTestDatabase({ migrations: MASTERY_ERA_MIGRATIONS });
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  alice = await createTestUser(db, 'alice');
  bob = await createTestUser(db, 'bob');
});

/** The app as it is at noon in Vietnam on the given day. */
const on = (day: string, users: TestUser[] = [alice, bob]) =>
  createSupabaseTestApp(db, users, { now: () => new Date(`${day}T05:00:00Z`) });

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

/** Answers a card with whatever state it currently holds, and returns the request id. */
async function answer(app: TestApp, user: TestUser, id: string, action: 'remember' | 'not_remember', durationMs?: number) {
  const current = entryResponseSchema.parse(await (await call(app, user, `/api/vocabulary/${id}`)).json()).entry;
  const requestId = newId();
  const response = await call(app, user, '/api/review-action', {
    method: 'POST',
    body: {
      pageId: id,
      action,
      expected: { mastery: current.mastery, nextReview: current.reviewDate },
      requestId,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  });
  expect(response.status, `${action} on ${current.word}`).toBe(200);
  return requestId;
}

/** Answers a card without moving it, the way a weak review does by default. */
async function answerOff(app: TestApp, user: TestUser, id: string, action: 'remember' | 'not_remember') {
  const current = entryResponseSchema.parse(await (await call(app, user, `/api/vocabulary/${id}`)).json()).entry;
  const response = await call(app, user, '/api/review-action', {
    method: 'POST',
    body: {
      pageId: id,
      action,
      expected: { mastery: current.mastery, nextReview: current.reviewDate },
      requestId: newId(),
      countsTowardMastery: false,
    },
  });
  expect(response.status, `${action} on ${current.word}`).toBe(200);
}

const analyticsOf = async (app: TestApp, user: TestUser) =>
  analyticsResponseSchema.parse(await (await call(app, user, '/api/analytics')).json());
const weakOf = async (app: TestApp, user: TestUser) =>
  weakWordsResponseSchema.parse(await (await call(app, user, '/api/weak-words')).json());

describe('review activity', () => {
  it('is empty, with no percentages, before anything has been reviewed', async () => {
    const app = on('2026-10-09');
    await addWord(app, alice, { word: 'candid' });
    const result = await analyticsOf(app, alice);
    expect(result).toMatchObject({
      available: true,
      today: '2026-10-09',
      timeZone: 'Asia/Ho_Chi_Minh',
      minSample: 5,
      streak: { current: 0, longest: 0 },
      byMode: [],
      firstReviewOn: null,
      windowDays: 90,
    });
    expect(result.periods.today).toMatchObject({ reviews: 0, accuracy: null, retention: null, averageMs: null });
    expect(result.days).toHaveLength(90);
  });

  it('counts saved answers by the reviewer’s own day, with accuracy and time', async () => {
    const day1 = on('2026-10-08');
    const words: VocabularyEntry[] = [];
    for (let n = 0; n < 6; n += 1) {
      words.push(await addWord(day1, alice, { word: `word-${n}`, mastery: 0, reviewDate: '2026-10-08' }));
    }
    // Day one: six first reviews, four remembered.
    for (const [index, word] of words.entries()) {
      await answer(day1, alice, word.id, index < 4 ? 'remember' : 'not_remember', 3000);
    }
    // Day two: all six again (mastery 0 → 1 is due the same day; the others the next), five remembered.
    const day2 = on('2026-10-09');
    for (const [index, word] of words.entries()) {
      await answer(day2, alice, word.id, index < 5 ? 'remember' : 'not_remember', index < 3 ? 5000 : undefined);
    }

    const result = await analyticsOf(day2, alice);
    expect(result.periods.today).toMatchObject({
      from: '2026-10-09',
      to: '2026-10-09',
      reviews: 6,
      remembered: 5,
      notRemembered: 1,
      repeatReviews: 6,
      durationMs: 15_000,
      timedReviews: 3,
      averageMs: 5000,
      activeDays: 1,
    });
    expect(result.periods.today.accuracy).toBeCloseTo(5 / 6);
    // Every one of today's answers was to a word reviewed before, so retention is the same figure today…
    expect(result.periods.today.retention).toBeCloseTo(5 / 6);
    // …but over the week, the six first encounters count towards accuracy and not towards retention.
    expect(result.periods.week).toMatchObject({ reviews: 12, remembered: 9, repeatReviews: 6, activeDays: 2 });
    expect(result.periods.week.accuracy).toBeCloseTo(9 / 12);
    expect(result.periods.week.retention).toBeCloseTo(5 / 6);
    expect(result.streak).toEqual({ current: 2, longest: 2 });
    expect(result.byMode).toEqual([{ mode: 'flashcard', reviews: 12, remembered: 9, accuracy: 0.75 }]);
    expect(result.firstReviewOn).toBe('2026-10-08');
    expect(result.days.slice(-2)).toEqual([
      { date: '2026-10-08', reviews: 6, remembered: 4, notRemembered: 2, durationMs: 18_000 },
      { date: '2026-10-09', reviews: 6, remembered: 5, notRemembered: 1, durationMs: 15_000 },
    ]);
  });

  it('files an answer under the reviewer’s day, not the server’s', async () => {
    // 18:30 UTC on the 9th is already the 10th in Vietnam.
    const late = createSupabaseTestApp(db, [alice], { now: () => new Date('2026-10-09T18:30:00Z') });
    const word = await addWord(late, alice, { word: 'candid' });
    await answer(late, alice, word.id, 'remember');
    const result = await analyticsOf(late, alice);
    expect(result.today).toBe('2026-10-10');
    expect(result.periods.today.reviews).toBe(1);
    expect(result.days.at(-1)).toMatchObject({ date: '2026-10-10', reviews: 1 });
  });

  it('does not count an answer that was undone', async () => {
    const app = on('2026-10-09');
    const full = { meaning: 'm', definition: 'd', example: 'e' };
    const kept = await addWord(app, alice, { word: 'kept', ...full });
    const dropped = await addWord(app, alice, { word: 'dropped', ...full });
    await answer(app, alice, kept.id, 'remember');
    const requestId = await answer(app, alice, dropped.id, 'not_remember');
    await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: requestId, requestId: newId() } });

    const result = await analyticsOf(app, alice);
    expect(result.periods.today).toMatchObject({ reviews: 1, remembered: 1, notRemembered: 0 });
    // The failure that was taken back does not make the word weak either.
    expect((await weakOf(app, alice)).words).toEqual([]);
  });

  it('belongs to one account only', async () => {
    const app = on('2026-10-09');
    const mine = await addWord(app, alice, { word: 'mine' });
    await answer(app, alice, mine.id, 'remember');
    const theirs = await analyticsOf(app, bob);
    expect(theirs.periods.month.reviews).toBe(0);
    expect(theirs.streak.current).toBe(0);
    expect((await weakOf(app, bob)).words).toEqual([]);
  });

  it('drops out of "today" the next day but stays in the week', async () => {
    const day1 = on('2026-10-08');
    const word = await addWord(day1, alice, { word: 'candid' });
    await answer(day1, alice, word.id, 'remember');
    const result = await analyticsOf(on('2026-10-09'), alice);
    expect(result.periods.today.reviews).toBe(0);
    expect(result.periods.week.reviews).toBe(1);
    // Yesterday's review keeps the streak alive until today ends.
    expect(result.streak.current).toBe(1);
  });
});

describe('weak words', () => {
  it('ranks repeated forgetting above a single slip, and says why', async () => {
    const day1 = on('2026-10-06');
    const stubborn = await addWord(day1, alice, { word: 'stubborn', meaning: 'm', definition: 'd', example: 'e', mastery: 2, reviewDate: '2026-10-06' });
    const slipped = await addWord(day1, alice, { word: 'slipped', meaning: 'm', definition: 'd', example: 'e', mastery: 2, reviewDate: '2026-10-08' });
    const solid = await addWord(day1, alice, { word: 'solid', meaning: 'm', definition: 'd', example: 'e', mastery: 2, reviewDate: '2026-10-06' });

    // "stubborn" is forgotten on three separate days; "slipped" once; "solid" never.
    await answer(day1, alice, stubborn.id, 'not_remember');
    await answer(day1, alice, solid.id, 'remember');
    await answer(on('2026-10-07'), alice, stubborn.id, 'not_remember');
    const day3 = on('2026-10-08');
    await answer(day3, alice, stubborn.id, 'not_remember');
    await answer(day3, alice, slipped.id, 'not_remember');

    const result = await weakOf(day3, alice);
    expect(result).toMatchObject({ historyAvailable: true, today: '2026-10-08', windowDays: 30, total: 2 });
    expect(result.words.map((word) => word.word)).toEqual(['stubborn', 'slipped']);

    const [first, second] = result.words;
    expect(first).toMatchObject({ severity: 'high', recent: { reviews: 3, remembered: 0 }, reviewable: false });
    expect(first?.reasons.map((reason) => reason.code)).toEqual(['repeated_failures', 'recent_failures', 'low_recent_accuracy']);
    expect(first?.reasons[0]?.detail).toBe('Forgotten on 3 separate days.');
    expect(second).toMatchObject({ severity: 'low', score: 2, recent: { reviews: 1, remembered: 0 } });
    expect(second?.reasons).toEqual([{ code: 'recent_failures', points: 2, detail: 'Not remembered 1 time in the last 30 days.' }]);
  });

  it('includes long-overdue and incomplete words even without any review history', async () => {
    const app = on('2026-10-09');
    await addWord(app, alice, { word: 'waiting', meaning: 'm', definition: 'd', example: 'e', mastery: 3, reviewDate: '2026-09-20' });
    await addWord(app, alice, { word: 'bare', mastery: 3, reviewDate: '2026-10-20' });
    await addWord(app, alice, { word: 'fine', meaning: 'm', definition: 'd', example: 'e', mastery: 3, reviewDate: '2026-10-20' });
    const mastered = await addWord(app, alice, { word: 'done', meaning: 'm', definition: 'd', example: 'e', mastery: 10, reviewDate: '2026-01-01' });

    const result = await weakOf(app, alice);
    expect(result.words.map((word) => [word.word, word.reasons[0]?.code, word.reviewable])).toEqual([
      ['waiting', 'long_overdue', true],
      ['bare', 'incomplete', false],
    ]);
    expect(result.words.map((word) => word.id)).not.toContain(mastered.id);
    expect(result.words[0]?.recent).toBeNull();
  });

  it('leaves out words in the trash', async () => {
    const app = on('2026-10-09');
    const word = await addWord(app, alice, { word: 'waiting', mastery: 3, reviewDate: '2026-09-01' });
    expect((await weakOf(app, alice)).total).toBe(1);
    await call(app, alice, `/api/vocabulary/${word.id}`, { method: 'DELETE' });
    expect((await weakOf(app, alice)).total).toBe(0);
  });
});

describe('weak words recovery', () => {
  const full = { meaning: 'm', definition: 'd', example: 'e' };

  /** A word that is weak from one forgotten answer, then remembered without moving it. */
  const weakWord = async (day: string, word: string) => {
    const app = on(day);
    const entry = await addWord(app, alice, { word, ...full, mastery: 2, reviewDate: day });
    await answerOff(app, alice, entry.id, 'not_remember');
    return entry;
  };

  it('earns a point a day from being remembered, and leaves the list once it has enough', async () => {
    const word = await weakWord('2026-10-06', 'recover');
    expect((await weakOf(on('2026-10-06'), alice)).words.find((item) => item.id === word.id)).toMatchObject({
      severity: 'low',
      recovery: { points: 0, threshold: 3, recovered: false },
    });

    // A weak review is judged by the reviewer, so two remembers in a day make one point.
    const day2 = on('2026-10-07');
    await answerOff(day2, alice, word.id, 'remember');
    await answerOff(day2, alice, word.id, 'remember');
    expect((await weakOf(day2, alice)).words.find((item) => item.id === word.id)).toMatchObject({
      recovery: { points: 1, threshold: 3 },
    });

    const day3 = on('2026-10-08');
    await answerOff(day3, alice, word.id, 'remember');
    await answerOff(day3, alice, word.id, 'remember');
    expect((await weakOf(day3, alice)).words.find((item) => item.id === word.id)).toMatchObject({
      recovery: { points: 2, threshold: 3 },
    });

    const day4 = on('2026-10-09');
    await answerOff(day4, alice, word.id, 'remember');
    await answerOff(day4, alice, word.id, 'remember');
    expect((await weakOf(day4, alice)).words.find((item) => item.id === word.id)).toBeUndefined();
  });

  it('takes a point back when the word is forgotten again', async () => {
    const word = await weakWord('2026-10-06', 'setback');
    const day2 = on('2026-10-07');
    await answerOff(day2, alice, word.id, 'remember');
    await answerOff(day2, alice, word.id, 'remember');
    await answerOff(day2, alice, word.id, 'not_remember');
    expect((await weakOf(day2, alice)).words.find((item) => item.id === word.id)).toMatchObject({
      recovery: { points: 0 },
    });
  });

  it('starts again from a clean slate after a slip', async () => {
    const word = await weakWord('2026-10-06', 'fresh-start');
    for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) {
      const app = on(day);
      await answerOff(app, alice, word.id, 'remember');
      await answerOff(app, alice, word.id, 'remember');
    }
    expect((await weakOf(on('2026-10-09'), alice)).words.find((item) => item.id === word.id)).toBeUndefined();

    // One more forget, and the word is back, but lightly: its old failures are gone.
    const day5 = on('2026-10-10');
    await answerOff(day5, alice, word.id, 'not_remember');
    expect((await weakOf(day5, alice)).words.find((item) => item.id === word.id)).toMatchObject({
      severity: 'low',
      score: 2,
      recovery: { points: 0, threshold: 3, recovered: false },
    });
  });

  it('forgives an overdue word once it has been remembered recently', async () => {
    const app = on('2026-10-09');
    const word = await addWord(app, alice, { word: 'waiting', ...full, mastery: 3, reviewDate: '2026-09-20' });
    expect((await weakOf(app, alice)).words.find((item) => item.id === word.id)).toMatchObject({
      severity: 'low',
      recovery: { points: 0, threshold: 3 },
    });
    await answerOff(app, alice, word.id, 'remember');
    expect((await weakOf(app, alice)).words.find((item) => item.id === word.id)).toBeUndefined();
  });
});

describe('focusing a review on the weakest words', () => {
  it('holds every weak word, weakest first, whether or not it is due', async () => {
    const app = on('2026-10-09');
    const full = { meaning: 'm', definition: 'd', example: 'e' };
    await addWord(app, alice, { word: 'healthy', ...full, mastery: 3, reviewDate: '2026-10-09' });
    await addWord(app, alice, { word: 'overdue-a-month', ...full, mastery: 3, reviewDate: '2026-09-05' });
    await addWord(app, alice, { word: 'overdue-a-week', ...full, mastery: 3, reviewDate: '2026-10-02' });
    await addWord(app, alice, { word: 'weak-but-not-due', mastery: 3, reviewDate: '2026-10-20' });

    const everything = queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue')).json());
    expect(everything.focus).toBeNull();
    expect(everything.cards).toHaveLength(3);

    const focused = queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue?focus=weak')).json());
    expect(focused.focus).toBe('weak');
    // A weak word is brought forward whether it is overdue or dated in the future; the waiting one still leads.
    expect(focused.cards.map((card) => card.word)).toEqual(['overdue-a-month', 'overdue-a-week', 'weak-but-not-due']);
  });

  it('lets a weak word be answered early, and leaves its mastery and date as they were', async () => {
    const app = on('2026-10-09');
    const word = await addWord(app, alice, { word: 'early', mastery: 3, reviewDate: '2026-10-20' });

    const focused = queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue?focus=weak')).json());
    expect(focused.cards.map((card) => card.word)).toEqual(['early']);

    // Without the weak focus it is refused, exactly as before.
    const without = await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: word.id, action: 'remember', expected: { mastery: 3, nextReview: '2026-10-20' }, requestId: newId() },
    });
    expect(without.status).toBe(409);

    const response = await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: {
        pageId: word.id,
        action: 'remember',
        expected: { mastery: 3, nextReview: '2026-10-20' },
        requestId: newId(),
        allowNotDue: true,
        countsTowardMastery: false,
      },
    });
    expect(response.status).toBe(200);
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'applied',
      state: { mastery: 3, nextReview: '2026-10-20' },
    });
    const after = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${word.id}`)).json()).entry;
    // A review that does not count is extra practice: Remember does not raise mastery or move the date.
    expect(after).toMatchObject({ mastery: 3, reviewDate: '2026-10-20' });
  });

  it('moves a word taken early when the same review is set to count', async () => {
    const app = on('2026-10-09');
    const word = await addWord(app, alice, { word: 'early', mastery: 3, reviewDate: '2026-10-20' });
    const response = await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: {
        pageId: word.id,
        action: 'remember',
        expected: { mastery: 3, nextReview: '2026-10-20' },
        requestId: newId(),
        allowNotDue: true,
        countsTowardMastery: true,
      },
    });
    expect(response.status).toBe(200);
    const after = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${word.id}`)).json()).entry;
    // The reviewer asked for it to count, so it behaves exactly like a due answer.
    expect(after).toMatchObject({ mastery: 4, reviewDate: '2026-10-12' });
  });

  it('leaves a due weak word unchanged on Not remember too, records the answer, and can be undone', async () => {
    const app = on('2026-10-09');
    const word = await addWord(app, alice, { word: 'shaky', mastery: 2, reviewDate: '2026-10-01' });
    const requestId = newId();
    const answer = () =>
      call(app, alice, '/api/review-action', {
        method: 'POST',
        body: {
          pageId: word.id,
          action: 'not_remember',
          expected: { mastery: 2, nextReview: '2026-10-01' },
          requestId,
          allowNotDue: true,
          countsTowardMastery: false,
        },
      });
    expect((await answer()).status).toBe(200);
    // Sent again, it is recognised rather than saved twice.
    expect(reviewActionResponseSchema.parse(await (await answer()).json()).outcome).toBe('already_applied');

    const after = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${word.id}`)).json()).entry;
    expect(after).toMatchObject({ mastery: 2, reviewDate: '2026-10-01' });

    const undo = await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: requestId, requestId: newId() } });
    expect(undo.status).toBe(200);
    const undone = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${word.id}`)).json()).entry;
    expect(undone).toMatchObject({ mastery: 2, reviewDate: '2026-10-01' });
  });

  it('still raises mastery for the same word reviewed outside the weak focus', async () => {
    const app = on('2026-10-09');
    const word = await addWord(app, alice, { word: 'due', mastery: 3, reviewDate: '2026-10-09' });
    const response = await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: word.id, action: 'remember', expected: { mastery: 3, nextReview: '2026-10-09' }, requestId: newId() },
    });
    expect(response.status).toBe(200);
    const after = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${word.id}`)).json()).entry;
    expect(after).toMatchObject({ mastery: 4, reviewDate: '2026-10-12' });
  });

  it('is simply empty when there is no weak word, without claiming nothing at all is due', async () => {
    const app = on('2026-10-09');
    await addWord(app, alice, { word: 'healthy', meaning: 'm', definition: 'd', example: 'e', mastery: 3, reviewDate: '2026-10-09' });
    const focused = queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue?focus=weak')).json());
    expect(focused).toMatchObject({ cards: [], focus: 'weak', vocabulary: 'in_progress' });
  });

  it('rejects a focus it does not know', async () => {
    const response = await call(on('2026-10-09'), alice, '/api/review-queue?focus=everything');
    expect(response.status).toBe(400);
  });
});

describe('a database one migration behind (version 3)', () => {
  let old: TestDatabase;
  let owner: TestUser;

  beforeAll(async () => {
    old = await createTestDatabase({ migrations: 3 });
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  beforeEach(async () => {
    await old.admin('delete from auth.users');
    owner = await createTestUser(old, 'owner');
  });

  it('reports that review history cannot be summarised yet, and still ranks what it can', async () => {
    const app = createSupabaseTestApp(old, [owner], { now: () => new Date('2026-10-09T05:00:00Z') });
    await addWord(app, owner, { word: 'waiting', meaning: 'm', definition: 'd', example: 'e', mastery: 3, reviewDate: '2026-09-01' });

    const analytics = await analyticsOf(app, owner);
    expect(analytics.available).toBe(false);
    expect(analytics.periods.month.reviews).toBe(0);

    const weak = await weakOf(app, owner);
    expect(weak.historyAvailable).toBe(false);
    expect(weak.words.map((word) => [word.word, word.reasons[0]?.code])).toEqual([['waiting', 'long_overdue']]);

    const queue = queueResponseSchema.parse(await (await call(app, owner, '/api/review-queue')).json());
    expect(queue.capabilities).toEqual({ ...NO_CAPABILITIES, sessions: true, undo: true, fsrs: true });
  });
});
