/**
 * Choosing which schedule is in charge, on the real schema. The mastery
 * schedule stays the default; an account can put FSRS in charge and take it
 * out again, and neither direction converts, loses or invents anything,
 * because every answer keeps both schedules up to date.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsrsRatingMap } from '../../config/review.config.js';
import { MockVocabularyRepository, mockCardFields } from '../../server/mock/mock-repository.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { ReviewService } from '../../server/review-service.js';
import { createSchedulerStore } from '../../server/scheduler-store.js';
import {
  dayPlanSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  schedulerReportSchema,
  vocabularyListResponseSchema,
  weakWordsResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { DEFAULT_FSRS_SETTINGS, FSRS_ENGINE, fsrsDueDay, fsrsReview } from '../../shared/scheduler/fsrs.js';
import { NOW, TIME_ZONE, TODAY } from '../helpers/fixtures.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { MASTERY_ERA_MIGRATIONS, createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const DAY_MS = 86_400_000;
/** The same time of day, `days` later. TIME_ZONE has no daylight saving, so the calendar day moves with it. */
const later = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;
let clock: Date;
let app: TestApp;

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
  clock = NOW;
  app = createSupabaseTestApp(db, [alice, bob], { now: () => clock });
});

async function addWord(user: TestUser, input: Record<string, unknown>, on: TestApp = app): Promise<VocabularyEntry> {
  const response = await call(on, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

async function answer(
  user: TestUser,
  id: string,
  action: 'remember' | 'not_remember',
  expected: { mastery: number; nextReview: string | null },
  on: TestApp = app,
) {
  const requestId = newId();
  const response = await call(on, user, '/api/review-action', {
    method: 'POST',
    body: { pageId: id, action, expected, requestId },
  });
  return { requestId, response };
}

const queueOf = async (user: TestUser, on: TestApp = app) =>
  queueResponseSchema.parse(await (await call(on, user, '/api/review-queue')).json());
const reportOf = async (user: TestUser, on: TestApp = app) =>
  schedulerReportSchema.parse(await (await call(on, user, '/api/scheduler')).json());
const listOf = async (user: TestUser) =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;
const choose = (user: TestUser, scheduler: unknown, on: TestApp = app) =>
  call(on, user, '/api/scheduler', { method: 'PUT', body: { scheduler } });

type CardRow = {
  mastery: number;
  review_date: string | null;
  fsrs_due: Date | string | null;
  fsrs_reps: number | null;
  fsrs_stability: number | null;
};
const cardOf = async (id: string) =>
  (
    await db.admin<CardRow>(
      'select mastery, review_date::text as review_date, fsrs_due, fsrs_reps, fsrs_stability from public.card_states where vocabulary_id = $1',
      [id],
    )
  )[0]!;
const logsOf = (id: string) =>
  db.admin<{ kind: string; scheduler: string; mastery_after: number }>(
    'select kind, scheduler, mastery_after from public.review_logs where vocabulary_id = $1 order by reviewed_at, id',
    [id],
  );

/** FSRS's date for a brand-new word answered Remember at `at`: three days on, by the library's own arithmetic. */
const firstFsrsDay = (at: Date) => fsrsDueDay(fsrsReview(null, fsrsRatingMap.remember, at, DEFAULT_FSRS_SETTINGS), TIME_ZONE);

/**
 * Two words answered once today, so FSRS has seen both and has them due on
 * the same day, while the mastery schedule has one due before that day and
 * the other after it.
 */
async function twoSeenWords() {
  const soon = await addWord(alice, { word: 'soon', mastery: 1, reviewDate: TODAY });
  const late = await addWord(alice, { word: 'late', mastery: 6, reviewDate: TODAY });
  expect((await answer(alice, soon.id, 'remember', { mastery: 1, nextReview: TODAY })).response.status).toBe(200);
  expect((await answer(alice, late.id, 'remember', { mastery: 6, nextReview: TODAY })).response.status).toBe(200);
  return { soon, late };
}

describe('until an account chooses otherwise', () => {
  it('the mastery schedule is in charge, and FSRS can be chosen', async () => {
    const report = await reportOf(alice);
    expect(report).toMatchObject({ active: 'mastery_v1', switchable: true });
    expect((await queueOf(alice)).scheduler).toBe('mastery_v1');
  });

  it('the dates this file relies on are the ones the two schedules really give', async () => {
    const { soon, late } = await twoSeenWords();
    expect(firstFsrsDay(NOW)).toBe('2026-10-12');
    expect(await cardOf(soon.id)).toMatchObject({ mastery: 2, review_date: '2026-10-10', fsrs_reps: 1 });
    expect(await cardOf(late.id)).toMatchObject({ mastery: 7, review_date: '2026-10-15', fsrs_reps: 1 });
  });

  it('a word is due by its mastery date, and the card carries nothing else', async () => {
    const { soon, late } = await twoSeenWords();
    clock = later(1);
    const queue = await queueOf(alice);
    expect(queue.cards.map((card) => card.id)).toEqual([soon.id]);
    expect(queue.cards[0]).not.toHaveProperty('dueOn');

    // Under the mastery schedule the other word is simply not due on FSRS's day.
    clock = later(3);
    const early = await answer(alice, late.id, 'remember', { mastery: 7, nextReview: '2026-10-15' });
    expect(early.response.status).toBe(409);
    expect(await cardOf(late.id)).toMatchObject({ mastery: 7, review_date: '2026-10-15', fsrs_reps: 1 });
  });
});

describe('with FSRS in charge', () => {
  it('a word FSRS has seen is due on FSRS’s day, not on its mastery date', async () => {
    const { soon, late } = await twoSeenWords();
    const chosen = await choose(alice, 'fsrs');
    expect(chosen.status).toBe(200);
    expect(schedulerReportSchema.parse(await chosen.json()).active).toBe('fsrs');

    // The mastery date of one word has arrived. FSRS has neither due yet.
    clock = later(1);
    const before = await queueOf(alice);
    expect(before.scheduler).toBe('fsrs');
    expect(before.cards).toEqual([]);
    expect(before.vocabulary).toBe('in_progress');

    // On FSRS's day both are due, whatever their mastery dates say.
    clock = later(3);
    const queue = await queueOf(alice);
    expect(queue.cards.map((card) => card.id).sort()).toEqual([soon.id, late.id].sort());
    const card = queue.cards.find((item) => item.id === late.id)!;
    // The stored mastery state travels with the card and comes back with the answer; FSRS's day is beside it.
    expect(card).toMatchObject({ mastery: 7, nextReview: '2026-10-15', dueOn: '2026-10-12' });
  });

  it('an answer still moves both schedules, each by its own rule', async () => {
    const { late } = await twoSeenWords();
    await choose(alice, 'fsrs');
    clock = later(3);
    const before = await cardOf(late.id);

    const { response } = await answer(alice, late.id, 'remember', { mastery: 7, nextReview: '2026-10-15' });
    expect(response.status).toBe(200);
    // Mastery counts as it always has: one more, and the date is the day of review plus the old level.
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'applied',
      state: { mastery: 8, nextReview: '2026-10-19' },
    });
    const after = await cardOf(late.id);
    expect(after).toMatchObject({ mastery: 8, review_date: '2026-10-19', fsrs_reps: 2 });
    expect(new Date(after.fsrs_due!).getTime()).toBeGreaterThan(new Date(before.fsrs_due!).getTime());
    expect(after.fsrs_stability!).toBeGreaterThan(before.fsrs_stability!);

    // It is no longer due under FSRS, although nothing about its mastery date says so.
    expect((await queueOf(alice)).cards.map((item) => item.id)).not.toContain(late.id);
  });

  it('the history says which schedule was in charge for each answer', async () => {
    const { late } = await twoSeenWords();
    await choose(alice, 'fsrs');
    clock = later(3);
    await answer(alice, late.id, 'remember', { mastery: 7, nextReview: '2026-10-15' });
    expect(await logsOf(late.id)).toEqual([
      { kind: 'review', scheduler: 'mastery_v1', mastery_after: 7 },
      { kind: 'review', scheduler: 'fsrs', mastery_after: 8 },
    ]);
  });

  it('a word FSRS has never seen keeps its mastery date until its first answer', async () => {
    const unseen = await addWord(alice, { word: 'unseen', mastery: 2, reviewDate: '2026-10-11' });
    await choose(alice, 'fsrs');
    expect((await cardOf(unseen.id)).fsrs_due).toBeNull();

    clock = later(1);
    expect((await queueOf(alice)).cards).toEqual([]);

    clock = later(2);
    const queue = await queueOf(alice);
    expect(queue.cards.map((card) => card.id)).toEqual([unseen.id]);
    expect(queue.cards[0]).not.toHaveProperty('dueOn');

    // That first answer is where it enters FSRS, as a new card with no history assumed.
    const { response } = await answer(alice, unseen.id, 'remember', { mastery: 2, nextReview: '2026-10-11' });
    expect(response.status).toBe(200);
    const stored = await cardOf(unseen.id);
    expect(stored).toMatchObject({ mastery: 3, review_date: '2026-10-13', fsrs_reps: 1 });
    expect(new Date(stored.fsrs_due!).toISOString()).toBe(fsrsReview(null, fsrsRatingMap.remember, later(2)).due);
    expect((await queueOf(alice)).cards).toEqual([]);
  });

  it('a word with no review date at all is still due at once', async () => {
    const fresh = await addWord(alice, { word: 'fresh' });
    await choose(alice, 'fsrs');
    expect((await queueOf(alice)).cards.map((card) => card.id)).toEqual([fresh.id]);
  });

  it('Not remember brings the word back on FSRS’s day, and leaves mastery where it was', async () => {
    const { late } = await twoSeenWords();
    await choose(alice, 'fsrs');
    clock = later(3);
    const { response } = await answer(alice, late.id, 'not_remember', { mastery: 7, nextReview: '2026-10-15' });
    expect(reviewActionResponseSchema.parse(await response.json()).state).toEqual({ mastery: 7, nextReview: '2026-10-13' });

    const stored = await cardOf(late.id);
    const fsrsDay = fsrsDueDay(
      { ...fsrsReview(null, 3, NOW), due: new Date(stored.fsrs_due!).toISOString() },
      TIME_ZONE,
    );
    clock = new Date(new Date(stored.fsrs_due!).getTime());
    const card = (await queueOf(alice)).cards.find((item) => item.id === late.id)!;
    expect(card.mastery).toBe(7);
    expect(card.dueOn ?? card.nextReview).toBe(fsrsDay);
  });

  it('mastery still retires a word, exactly as before', async () => {
    const nearly = await addWord(alice, { word: 'nearly', mastery: 9, reviewDate: TODAY });
    await choose(alice, 'fsrs');
    const { response } = await answer(alice, nearly.id, 'remember', { mastery: 9, nextReview: TODAY });
    expect(reviewActionResponseSchema.parse(await response.json()).state?.mastery).toBe(10);

    // FSRS will have it due one day, but a retired word is never shown again under either schedule.
    clock = later(400);
    expect((await queueOf(alice)).cards).toEqual([]);
    const refused = await answer(alice, nearly.id, 'remember', { mastery: 10, nextReview: '2026-10-18' });
    expect(refused.response.status).toBe(409);
  });

  it('Undo puts both schedules back, and the word is due again', async () => {
    const { late } = await twoSeenWords();
    await choose(alice, 'fsrs');
    clock = later(3);
    const before = await cardOf(late.id);
    const { requestId } = await answer(alice, late.id, 'remember', { mastery: 7, nextReview: '2026-10-15' });

    const undone = await call(app, alice, '/api/review-undo', {
      method: 'POST',
      body: { reviewRequestId: requestId, requestId: newId() },
    });
    expect(undone.status).toBe(200);
    expect(await cardOf(late.id)).toEqual(before);
    expect((await queueOf(alice)).cards.map((card) => card.id)).toContain(late.id);
  });

  it('a repeated answer is saved once, and a stale one from another device is refused', async () => {
    const { late } = await twoSeenWords();
    await choose(alice, 'fsrs');
    clock = later(3);
    const body = {
      pageId: late.id,
      action: 'remember',
      expected: { mastery: 7, nextReview: '2026-10-15' },
      requestId: newId(),
    };
    const first = await call(app, alice, '/api/review-action', { method: 'POST', body });
    const again = await call(app, alice, '/api/review-action', { method: 'POST', body });
    expect(reviewActionResponseSchema.parse(await first.json()).outcome).toBe('applied');
    expect(reviewActionResponseSchema.parse(await again.json()).outcome).toBe('already_applied');
    expect(await cardOf(late.id)).toMatchObject({ mastery: 8, fsrs_reps: 2 });

    // Another device still showing the card as it was, answering the other way: it must not land on top.
    const stale = await answer(alice, late.id, 'not_remember', { mastery: 7, nextReview: '2026-10-15' });
    expect(stale.response.status).toBe(409);
    // The same answer again from there is recognised as the one already saved, as it always was.
    const same = await answer(alice, late.id, 'remember', { mastery: 7, nextReview: '2026-10-15' });
    expect(reviewActionResponseSchema.parse(await same.response.json()).outcome).toBe('already_applied');
    expect(await cardOf(late.id)).toMatchObject({ mastery: 8, fsrs_reps: 2 });
    expect(await logsOf(late.id)).toHaveLength(2);
  });
});

describe('everything that says when a word is due follows the schedule in charge', () => {
  it('the word list shows FSRS’s day and says who set it', async () => {
    const { soon, late } = await twoSeenWords();
    const unseen = await addWord(alice, { word: 'unseen', mastery: 2, reviewDate: '2026-10-20' });

    const under = async () => new Map((await listOf(alice)).map((entry) => [entry.id, entry]));
    let entries = await under();
    expect(entries.get(late.id)).toMatchObject({ reviewDate: '2026-10-15', reviewStatus: 'upcoming' });
    expect(entries.get(late.id)).not.toHaveProperty('scheduledBy');

    await choose(alice, 'fsrs');
    clock = later(3);
    entries = await under();
    expect(entries.get(late.id)).toMatchObject({
      reviewDate: '2026-10-12',
      scheduledBy: 'fsrs',
      reviewStatus: 'due_today',
      reviewable: true,
      mastery: 7,
    });
    // Its mastery date came and went two days ago, which no longer makes it overdue.
    expect(entries.get(soon.id)).toMatchObject({ reviewDate: '2026-10-12', reviewStatus: 'due_today' });
    expect(entries.get(unseen.id)).toMatchObject({ reviewDate: '2026-10-20', reviewStatus: 'upcoming' });
    expect(entries.get(unseen.id)).not.toHaveProperty('scheduledBy');
    // Nothing internal leaks into the list.
    expect(entries.get(late.id)).not.toHaveProperty('fsrsDue');
  });

  it('the day’s plan and the weak words count what is due the same way', async () => {
    const { soon } = await twoSeenWords();
    const planOf = async () => dayPlanSchema.parse(await (await call(app, alice, '/api/plan')).json());
    const weakOf = async () => weakWordsResponseSchema.parse(await (await call(app, alice, '/api/weak-words')).json());

    clock = later(2);
    // Mastery schedule: one word a day overdue, the other not due.
    expect((await planOf()).due).toEqual({ total: 1, overdue: 1 });

    await choose(alice, 'fsrs');
    expect((await planOf()).due).toEqual({ total: 0, overdue: 0 });
    for (const word of (await weakOf()).words) expect(word.reviewable).toBe(false);

    clock = later(4);
    expect((await planOf()).due).toEqual({ total: 2, overdue: 2 });
    expect(soon.id).toBeTruthy();
  });

  it('a date FSRS set cannot be typed over, but mastery can still be corrected', async () => {
    const { late } = await twoSeenWords();
    const unseen = await addWord(alice, { word: 'unseen', mastery: 2, reviewDate: '2026-10-20' });
    await choose(alice, 'fsrs');
    const patch = (id: string, schedule: unknown) =>
      call(app, alice, `/api/vocabulary/${id}`, { method: 'PATCH', body: { schedule } });

    const refused = await patch(late.id, { mastery: 7, reviewDate: '2026-11-01' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('not_editable');
    expect(await cardOf(late.id)).toMatchObject({ mastery: 7, review_date: '2026-10-15' });

    // The form sends back the date it was shown. That is no change, so only the mastery moves.
    const corrected = await patch(late.id, { mastery: 5, reviewDate: '2026-10-12' });
    expect(corrected.status).toBe(200);
    expect(entryResponseSchema.parse(await corrected.json()).entry).toMatchObject({
      mastery: 5,
      reviewDate: '2026-10-12',
      scheduledBy: 'fsrs',
    });
    expect(await cardOf(late.id)).toMatchObject({ mastery: 5, review_date: '2026-10-15' });

    // A word FSRS has not seen is still on its mastery date, which is the reviewer's to set.
    const moved = await patch(unseen.id, { mastery: 2, reviewDate: '2026-10-25' });
    expect(moved.status).toBe(200);
    expect(await cardOf(unseen.id)).toMatchObject({ review_date: '2026-10-25' });
  });
});

describe('changing back', () => {
  it('reads the mastery schedule again, which every answer under FSRS kept up to date', async () => {
    const { soon, late } = await twoSeenWords();
    await choose(alice, 'fsrs');
    clock = later(3);
    await answer(alice, late.id, 'remember', { mastery: 7, nextReview: '2026-10-15' });
    const underFsrs = await cardOf(late.id);

    const back = await choose(alice, 'mastery_v1');
    expect(schedulerReportSchema.parse(await back.json()).active).toBe('mastery_v1');
    // Nothing was converted or cleared by the change, in either direction.
    expect(await cardOf(late.id)).toEqual(underFsrs);

    const queue = await queueOf(alice);
    expect(queue.scheduler).toBe('mastery_v1');
    // "soon" has been due by its mastery date since the 10th; "late" now waits for the 19th.
    expect(queue.cards.map((card) => card.id)).toEqual([soon.id]);
    expect(queue.cards[0]).not.toHaveProperty('dueOn');
    const entries = new Map((await listOf(alice)).map((entry) => [entry.id, entry]));
    expect(entries.get(late.id)).toMatchObject({ mastery: 8, reviewDate: '2026-10-19', reviewStatus: 'upcoming' });
    expect(entries.get(late.id)).not.toHaveProperty('scheduledBy');
  });

  it('can be done any number of times; choosing what is already chosen changes nothing', async () => {
    for (const next of ['fsrs', 'fsrs', 'mastery_v1', 'fsrs', 'mastery_v1'] as const) {
      const response = await choose(alice, next);
      expect(response.status).toBe(200);
      expect(schedulerReportSchema.parse(await response.json()).active).toBe(next);
      expect((await reportOf(alice)).active).toBe(next);
    }
  });
});

describe('whose choice it is', () => {
  it('belongs to one account and reaches no other', async () => {
    const word = await addWord(bob, { word: 'steady', mastery: 6, reviewDate: TODAY });
    await answer(bob, word.id, 'remember', { mastery: 6, nextReview: TODAY });
    await choose(alice, 'fsrs');

    expect((await reportOf(bob)).active).toBe('mastery_v1');
    clock = later(3);
    // FSRS would have Bob's word due today. He did not choose FSRS, so it waits for its mastery date.
    const queue = await queueOf(bob);
    expect(queue.scheduler).toBe('mastery_v1');
    expect(queue.cards).toEqual([]);

    const rows = await db.admin<{ user_id: string; scheduler: string }>(
      'select user_id, scheduler from public.user_settings order by scheduler',
    );
    expect(rows).toEqual([
      { user_id: alice.id, scheduler: 'fsrs' },
      { user_id: bob.id, scheduler: 'mastery_v1' },
    ]);
  });

  it('cannot be set on someone else’s row, or to anything but the two schedules', async () => {
    await choose(alice, 'fsrs');
    // Row Level Security: Bob's update matches no row of Alice's.
    await db.as(bob.id, (s) => s.query(`update public.user_settings set scheduler = 'mastery_v1' where user_id = $1`, [alice.id]));
    expect((await reportOf(alice)).active).toBe('fsrs');

    await expect(
      db.as(alice.id, (s) => s.query(`update public.user_settings set scheduler = 'sm2'`)),
    ).rejects.toMatchObject({ code: '23514' });

    for (const bad of ['sm2', '', null, 3]) {
      const response = await choose(alice, bad);
      expect(response.status).toBe(400);
    }
    expect((await reportOf(alice)).active).toBe('fsrs');
  });

  it('needs an account', async () => {
    expect((await call(app, null, '/api/scheduler', { method: 'PUT', body: { scheduler: 'fsrs' } })).status).toBe(401);
  });
});

describe('the database itself', () => {
  it('refuses an answer without an FSRS result while FSRS is in charge, and saves nothing', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    await choose(alice, 'fsrs');
    const event = {
      vocabulary_id: word.id,
      request_id: newId(),
      action: 'remember',
      expected_mastery: 3,
      expected_review_date: TODAY,
      new_mastery: 4,
      new_review_date: '2026-10-12',
      reviewed_on: TODAY,
    };
    await expect(
      db.as(alice.id, (s) => s.query('select * from public.record_review($1::jsonb)', [JSON.stringify(event)])),
    ).rejects.toMatchObject({ code: '22023' });
    expect(await cardOf(word.id)).toMatchObject({ mastery: 3, review_date: TODAY });
    expect(await logsOf(word.id)).toEqual([]);

    // The same event is accepted as it always was while the mastery schedule is in charge.
    await choose(alice, 'mastery_v1');
    const saved = await db.as(alice.id, (s) =>
      s.query<{ outcome: string }>('select * from public.record_review($1::jsonb)', [JSON.stringify(event)]),
    );
    expect(saved[0]?.outcome).toBe('applied');
  });

  it('stamps the schedule from the account’s own setting, never from the request', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const after = fsrsReview(null, 3, NOW);
    const event = {
      vocabulary_id: word.id,
      request_id: newId(),
      action: 'remember',
      expected_mastery: 3,
      expected_review_date: TODAY,
      new_mastery: 4,
      new_review_date: '2026-10-12',
      reviewed_on: TODAY,
      // Not something the function reads.
      scheduler: 'fsrs',
      fsrs: {
        rating: 3,
        version: FSRS_ENGINE,
        after: {
          due: after.due,
          stability: after.stability,
          difficulty: after.difficulty,
          last_review: after.lastReview,
          reps: after.reps,
          lapses: after.lapses,
          state: after.state,
          scheduled_days: after.scheduledDays,
          learning_steps: after.learningSteps,
        },
      },
    };
    await db.as(alice.id, (s) => s.query('select * from public.record_review($1::jsonb)', [JSON.stringify(event)]));
    expect(await logsOf(word.id)).toEqual([{ kind: 'review', scheduler: 'mastery_v1', mastery_after: 4 }]);
  });
});

describe('when FSRS cannot work out the next review', () => {
  const brokenMap = { remember: 9, not_remember: 1 } as unknown as typeof fsrsRatingMap;

  function serviceWith(scheduler: 'mastery_v1' | 'fsrs') {
    const repository = new MockVocabularyRepository(TODAY, () => NOW);
    const service = new ReviewService({
      repository,
      rules: sampleRules,
      cardFields: mockCardFields,
      timeZone: TIME_ZONE,
      writesRequested: true,
      fsrs: { settings: DEFAULT_FSRS_SETTINGS, ratingMap: brokenMap },
      scheduler: createSchedulerStore(scheduler),
      now: () => NOW,
    });
    return { repository, service };
  }

  it('beside the mastery schedule the answer is still saved', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repository, service } = serviceWith('mastery_v1');
    const card = (await service.getQueue()).cards[0]!;
    const result = await service.submitAction({
      pageId: card.id,
      action: 'remember',
      expected: { mastery: card.mastery, nextReview: card.nextReview },
      requestId: newId(),
    });
    expect(result.outcome).toBe('applied');
    expect((await repository.getRecord(card.id))?.mastery).toBe(card.mastery + 1);
    quiet.mockRestore();
  });

  it('in charge, the answer is refused rather than saved without it', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repository, service } = serviceWith('fsrs');
    const card = (await service.getQueue()).cards[0]!;
    await expect(
      service.submitAction({
        pageId: card.id,
        action: 'remember',
        expected: { mastery: card.mastery, nextReview: card.nextReview },
        requestId: newId(),
      }),
    ).rejects.toMatchObject({ status: 500, code: 'scheduler_failed' });
    expect((await repository.getRecord(card.id))?.mastery).toBe(card.mastery);
    expect(await repository.listHistory()).toEqual([]);
    quiet.mockRestore();
  });
});

describe('a database one migration behind (version 7)', () => {
  let old: TestDatabase;
  let owner: TestUser;
  let legacy: TestApp;

  beforeAll(async () => {
    old = await createTestDatabase({ migrations: 7 });
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  beforeEach(async () => {
    await old.admin('delete from auth.users');
    owner = await createTestUser(old, 'owner');
    legacy = createSupabaseTestApp(old, [owner], { now: () => clock });
  });

  it('keeps the mastery schedule in charge and says the choice is not available yet', async () => {
    expect(await reportOf(owner, legacy)).toMatchObject({ active: 'mastery_v1', switchable: false });
    const response = await choose(owner, 'fsrs', legacy);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('not_supported');
    expect((await reportOf(owner, legacy)).active).toBe('mastery_v1');
  });

  it('reviews exactly as before', async () => {
    const word = await addWord(owner, { word: 'candid', mastery: 3, reviewDate: TODAY }, legacy);
    const queue = await queueOf(owner, legacy);
    expect(queue.scheduler).toBe('mastery_v1');
    expect(queue.cards.map((card) => card.id)).toEqual([word.id]);
    const { response } = await answer(owner, word.id, 'remember', { mastery: 3, nextReview: TODAY }, legacy);
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'applied',
      state: { mastery: 4, nextReview: '2026-10-12' },
    });
  });
});
