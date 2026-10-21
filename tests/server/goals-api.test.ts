/**
 * Daily goals, review filters and confidence ratings through the HTTP API on
 * the real schema. The thread running through all three: none of them may
 * change which words are due, or what an answer does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_CAPABILITIES,
  accountSettingsSchema,
  analyticsResponseSchema,
  dayPlanSchema,
  entryResponseSchema,
  queueResponseSchema,
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

const TODAY = '2026-10-09';

/** The app as it is at noon in Vietnam on the given day. */
const on = (day: string, database: TestDatabase = db, users: TestUser[] = [alice, bob]) =>
  createSupabaseTestApp(database, users, { now: () => new Date(`${day}T05:00:00Z`) });

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

interface AnswerOptions {
  durationMs?: number;
  confidence?: unknown;
}

function send(app: TestApp, user: TestUser, entry: VocabularyEntry, action: string, options: AnswerOptions = {}) {
  const requestId = newId();
  return {
    requestId,
    response: call(app, user, '/api/review-action', {
      method: 'POST',
      body: {
        pageId: entry.id,
        action,
        expected: { mastery: entry.mastery, nextReview: entry.reviewDate },
        requestId,
        ...options,
      },
    }),
  };
}

/** Answers a card with whatever state it currently holds, and returns the request id. */
async function answer(app: TestApp, user: TestUser, id: string, action: 'remember' | 'not_remember', options: AnswerOptions = {}) {
  const current = entryResponseSchema.parse(await (await call(app, user, `/api/vocabulary/${id}`)).json()).entry;
  const { requestId, response } = send(app, user, current, action, options);
  expect((await response).status, `${action} on ${current.word}`).toBe(200);
  return requestId;
}

const planOf = async (app: TestApp, user: TestUser) => dayPlanSchema.parse(await (await call(app, user, '/api/plan')).json());
const queueOf = async (app: TestApp, user: TestUser, focus?: string) =>
  queueResponseSchema.parse(await (await call(app, user, `/api/review-queue${focus === undefined ? '' : `?focus=${focus}`}`)).json());
const setGoal = (app: TestApp, user: TestUser | null, goal: unknown) => call(app, user, '/api/goal', { method: 'PUT', body: goal });
const words = (queue: { cards: Array<{ word: string }> }) => queue.cards.map((card) => card.word);

describe('the day’s plan', () => {
  it('starts with no goal, and counts what is due from the real records', async () => {
    const app = on(TODAY);
    await addWord(app, alice, { word: 'late', mastery: 3, reviewDate: '2026-10-01' });
    await addWord(app, alice, { word: 'now', mastery: 2, reviewDate: TODAY });
    await addWord(app, alice, { word: 'new' });
    await addWord(app, alice, { word: 'later', mastery: 4, reviewDate: '2026-10-20' });
    await addWord(app, alice, { word: 'done', mastery: 10, reviewDate: '2026-10-01' });

    expect(await planOf(app, alice)).toMatchObject({
      available: true,
      today: TODAY,
      timeZone: 'Asia/Ho_Chi_Minh',
      goal: { reviews: null, minutes: null },
      done: { reviews: 0, durationMs: 0 },
      due: { total: 3, overdue: 1 },
      averageMs: null,
      reviews: null,
      time: null,
      met: null,
      estimatedDueMs: null,
      cardsToGoal: null,
      beyondGoal: null,
    });
  });

  it('is refused to a visitor who is not signed in', async () => {
    const app = on(TODAY);
    expect((await call(app, null, '/api/plan')).status).toBe(401);
    expect((await setGoal(app, null, { reviews: 10, minutes: null })).status).toBe(401);
  });
});

describe('setting a goal', () => {
  it('keeps it with the account, on every device, and for nobody else', async () => {
    const app = on(TODAY);
    const response = await setGoal(app, alice, { reviews: 20, minutes: 10 });
    expect(response.status).toBe(200);
    expect(dayPlanSchema.parse(await response.json()).goal).toEqual({ reviews: 20, minutes: 10 });

    // A different server instance, as another device would reach.
    expect((await planOf(on(TODAY), alice)).goal).toEqual({ reviews: 20, minutes: 10 });
    expect((await planOf(app, bob)).goal).toEqual({ reviews: null, minutes: null });
    const stored = await db.admin('select user_id, daily_goal_reviews, daily_goal_minutes from public.user_settings order by 2');
    expect(stored).toEqual([
      { user_id: alice.id, daily_goal_reviews: 20, daily_goal_minutes: 10 },
      { user_id: bob.id, daily_goal_reviews: null, daily_goal_minutes: null },
    ]);
  });

  it('can be one part only, changed, and cleared', async () => {
    const app = on(TODAY);
    expect(dayPlanSchema.parse(await (await setGoal(app, alice, { reviews: null, minutes: 30 })).json()).goal).toEqual({
      reviews: null,
      minutes: 30,
    });
    expect(dayPlanSchema.parse(await (await setGoal(app, alice, { reviews: 15, minutes: null })).json()).goal).toEqual({
      reviews: 15,
      minutes: null,
    });
    const cleared = dayPlanSchema.parse(await (await setGoal(app, alice, { reviews: null, minutes: null })).json());
    expect(cleared).toMatchObject({ goal: { reviews: null, minutes: null }, met: null });
  });

  it('leaves the time zone and every other setting alone', async () => {
    const app = on(TODAY);
    await planOf(app, alice);
    await setGoal(app, alice, { reviews: 20, minutes: null });
    const rows = await db.admin('select time_zone, fsrs_request_retention::float8 as retention from public.user_settings where user_id = $1', [
      alice.id,
    ]);
    expect(rows).toEqual([{ time_zone: 'Asia/Ho_Chi_Minh', retention: 0.9 }]);
  });

  it.each([
    ['zero reviews', { reviews: 0, minutes: null }],
    ['too many reviews', { reviews: 1001, minutes: null }],
    ['a fraction', { reviews: 12.5, minutes: null }],
    ['zero minutes', { reviews: null, minutes: 0 }],
    ['too many minutes', { reviews: null, minutes: 601 }],
    ['text', { reviews: 'twenty', minutes: null }],
    ['a missing part', { reviews: 20 }],
    ['an extra field', { reviews: 20, minutes: null, fsrsRetention: 0.8 }],
  ])('refuses %s and stores nothing', async (_name, goal) => {
    const app = on(TODAY);
    await setGoal(app, alice, { reviews: 5, minutes: 5 });
    expect((await setGoal(app, alice, goal)).status).toBe(400);
    expect((await planOf(app, alice)).goal).toEqual({ reviews: 5, minutes: 5 });
  });

  it('is also held to its limits by the database itself', async () => {
    await planOf(on(TODAY), alice);
    for (const change of ['daily_goal_reviews = 0', 'daily_goal_reviews = 1001', 'daily_goal_minutes = 0', 'daily_goal_minutes = 601']) {
      await expect(db.as(alice.id, (s) => s.query(`update public.user_settings set ${change}`)), change).rejects.toMatchObject({
        code: '23514',
      });
    }
  });
});

describe('progress towards a goal', () => {
  it('counts answers saved today, and the time spent on them', async () => {
    const app = on(TODAY);
    const a = await addWord(app, alice, { word: 'a' });
    const b = await addWord(app, alice, { word: 'b' });
    await addWord(app, alice, { word: 'c' });
    await setGoal(app, alice, { reviews: 3, minutes: 1 });

    await answer(app, alice, a.id, 'remember', { durationMs: 20_000 });
    await answer(app, alice, b.id, 'not_remember', { durationMs: 25_000 });

    const plan = await planOf(app, alice);
    expect(plan.done).toEqual({ reviews: 2, durationMs: 45_000 });
    expect(plan.reviews).toEqual({ target: 3, done: 2, remaining: 1, met: false });
    expect(plan.time).toEqual({ target: 60_000, done: 45_000, remaining: 15_000, met: false });
    expect(plan.met).toBe(false);
  });

  it('is reached by saved answers, and says so', async () => {
    const app = on(TODAY);
    const a = await addWord(app, alice, { word: 'a' });
    const b = await addWord(app, alice, { word: 'b' });
    await setGoal(app, alice, { reviews: 2, minutes: null });
    await answer(app, alice, a.id, 'remember');
    expect((await planOf(app, alice)).met).toBe(false);
    await answer(app, alice, b.id, 'remember');
    expect(await planOf(app, alice)).toMatchObject({ met: true, cardsToGoal: 0, reviews: { remaining: 0, met: true } });
  });

  it('does not count an answer that was undone', async () => {
    const app = on(TODAY);
    const a = await addWord(app, alice, { word: 'a' });
    await setGoal(app, alice, { reviews: 1, minutes: null });
    const requestId = await answer(app, alice, a.id, 'remember', { durationMs: 9_000 });
    expect((await planOf(app, alice)).met).toBe(true);

    const undo = await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: requestId, requestId: newId() } });
    expect(undo.status).toBe(200);
    expect(await planOf(app, alice)).toMatchObject({ met: false, done: { reviews: 0, durationMs: 0 } });
  });

  it('starts again each day, in the reviewer’s own time zone', async () => {
    const a = await addWord(on(TODAY), alice, { word: 'a' });
    await setGoal(on(TODAY), alice, { reviews: 1, minutes: null });
    await answer(on(TODAY), alice, a.id, 'remember');
    expect((await planOf(on(TODAY), alice)).met).toBe(true);
    expect(await planOf(on('2026-10-10'), alice)).toMatchObject({ met: false, done: { reviews: 0 }, goal: { reviews: 1 } });
  });

  it('never counts another account’s answers', async () => {
    const app = on(TODAY);
    const theirs = await addWord(app, bob, { word: 'theirs' });
    await answer(app, bob, theirs.id, 'remember', { durationMs: 5_000 });
    await setGoal(app, alice, { reviews: 1, minutes: null });
    expect(await planOf(app, alice)).toMatchObject({ met: false, done: { reviews: 0, durationMs: 0 }, due: { total: 0 } });
  });
});

describe('estimating the work', () => {
  it('uses the reviewer’s own pace, and only once there are enough timed answers', async () => {
    const app = on(TODAY);
    const made: VocabularyEntry[] = [];
    for (const word of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) made.push(await addWord(app, alice, { word }));
    await setGoal(app, alice, { reviews: null, minutes: 5 });

    for (const entry of made.slice(0, 4)) await answer(app, alice, entry.id, 'not_remember', { durationMs: 30_000 });
    const early = await planOf(app, alice);
    // Four timed answers are not enough to go by: no pace, so no card count is offered.
    expect(early).toMatchObject({ averageMs: null, estimatedDueMs: null, cardsToGoal: null, beyondGoal: null });
    expect(early.time).toMatchObject({ done: 120_000, remaining: 180_000 });

    await answer(app, alice, made[4]!.id, 'not_remember', { durationMs: 30_000 });
    const later = await planOf(app, alice);
    expect(later.averageMs).toBe(30_000);
    // "Not remember" brings a word back tomorrow, so three words are still due today.
    expect(later.due.total).toBe(3);
    expect(later.estimatedDueMs).toBe(90_000);
    // 150 s of the goal left at 30 s a card.
    expect(later.cardsToGoal).toBe(5);
    expect(later.beyondGoal).toBe(0);
  });

  it('says when more is due than the goal asks for', async () => {
    const app = on(TODAY);
    for (const word of ['a', 'b', 'c', 'd', 'e']) await addWord(app, alice, { word });
    await setGoal(app, alice, { reviews: 2, minutes: null });
    expect(await planOf(app, alice)).toMatchObject({ due: { total: 5 }, cardsToGoal: 2, beyondGoal: 3 });
  });
});

describe('a goal and the review queue', () => {
  it('never hides, reorders or reschedules a word, before or after it is reached', async () => {
    const app = on(TODAY);
    await addWord(app, alice, { word: 'late', mastery: 3, reviewDate: '2026-10-01' });
    const now = await addWord(app, alice, { word: 'now', mastery: 2, reviewDate: TODAY });
    await addWord(app, alice, { word: 'new' });
    const before = await queueOf(app, alice);
    expect(words(before)).toEqual(['late', 'now', 'new']);

    await setGoal(app, alice, { reviews: 1, minutes: 1 });
    expect((await queueOf(app, alice)).cards).toEqual(before.cards);

    await answer(app, alice, now.id, 'remember', { durationMs: 90_000 });
    expect((await planOf(app, alice)).met).toBe(true);
    // The goal is met and two words are still due: both are still offered, in the same order.
    expect(words(await queueOf(app, alice))).toEqual(['late', 'new']);
    const states = await db.admin(
      `select v.word, c.mastery, c.review_date::text as review_date from public.card_states c
         join public.vocabulary v on v.id = c.vocabulary_id where v.word in ('late', 'new') order by v.word`,
    );
    expect(states).toEqual([
      { word: 'late', mastery: 3, review_date: '2026-10-01' },
      { word: 'new', mastery: 1, review_date: null },
    ]);
  });

  it('never touches the retention FSRS is asked for', async () => {
    const app = on(TODAY);
    await setGoal(app, alice, { reviews: 500, minutes: 300 });
    const rows = await db.admin('select fsrs_request_retention::float8 as retention from public.user_settings where user_id = $1', [alice.id]);
    expect(rows).toEqual([{ retention: 0.9 }]);
  });
});

describe('narrowing a review', () => {
  async function library(app: TestApp) {
    await addWord(app, alice, { word: 'late-old', mastery: 3, reviewDate: '2026-10-01', dateAdded: '2026-09-01' });
    await addWord(app, alice, { word: 'late-new', mastery: 1, reviewDate: '2026-10-08', dateAdded: '2026-10-07' });
    await addWord(app, alice, { word: 'today-old', mastery: 2, reviewDate: TODAY, dateAdded: '2026-09-15' });
    await addWord(app, alice, { word: 'today-new', mastery: 1, reviewDate: TODAY, dateAdded: '2026-10-03' });
    await addWord(app, alice, { word: 'undated-new', dateAdded: TODAY });
    await addWord(app, alice, { word: 'undated-old', dateAdded: '2026-10-02' });
    // Recently added, but not due: no filter may bring it forward.
    await addWord(app, alice, { word: 'future-new', mastery: 2, reviewDate: '2026-10-12', dateAdded: TODAY });
    await addWord(app, alice, { word: 'mastered-new', mastery: 10, reviewDate: '2026-10-01', dateAdded: TODAY });
  }

  const picked = async (app: TestApp, user: TestUser, ids: string[]) =>
    queueResponseSchema.parse(
      await (await call(app, user, '/api/review-queue', { method: 'POST', body: { ids } })).json(),
    );

  it('shows everything due when not narrowed', async () => {
    const app = on(TODAY);
    await library(app);
    const queue = await queueOf(app, alice);
    expect(queue.focus).toBeNull();
    expect(queue.selection).toBe(false);
    expect(words(queue)).toEqual(['late-old', 'late-new', 'today-old', 'today-new', 'undated-new', 'undated-old']);
  });

  it('the weakest-words review holds weak words, weakest first, and may bring one forward', async () => {
    const app = on(TODAY);
    await library(app);
    const weak = words(await queueOf(app, alice, 'weak'));
    // A weak word may be taken early; a mastered one never appears.
    expect(weak).toContain('future-new');
    expect(weak).not.toContain('mastered-new');
  });

  it('words the reviewer picked are held in the order they were ticked, due or not', async () => {
    const app = on(TODAY);
    await library(app);
    const entries = await db.admin<{ id: string; word: string }>('select id, word from public.vocabulary');
    const id = (word: string) => entries.find((row) => row.word === word)?.id ?? '';

    const queue = await picked(app, alice, [id('future-new'), id('late-old'), id('today-new')]);
    expect(words(queue)).toEqual(['future-new', 'late-old', 'today-new']);
    expect(queue).toMatchObject({ focus: null, selection: true, vocabulary: 'in_progress' });
  });

  it('a picked review holds only the caller’s own words, is not repeated, and never a mastered one', async () => {
    const app = on(TODAY);
    await library(app);
    await addWord(app, bob, { word: 'bobs', mastery: 1, reviewDate: '2026-10-01', dateAdded: TODAY });
    const mine = await addWord(app, alice, { word: 'mine', mastery: 1, reviewDate: '2026-10-01' });
    const mastered = await addWord(app, alice, { word: 'finished', mastery: 10, reviewDate: '2026-10-01' });
    const theirs = (await addWord(app, bob, { word: 'theirs', mastery: 1, reviewDate: '2026-10-01' })).id;

    const queue = await picked(app, alice, [mine.id, theirs, mine.id, mastered.id]);
    // The mastered word is not reviewable at all, and another account's word is not reachable.
    expect(words(queue)).toEqual(['mine']);
  });

  it('an empty pick does not claim that nothing at all is due', async () => {
    const app = on(TODAY);
    await addWord(app, alice, { word: 'undated', dateAdded: '2026-01-01' });
    expect(await picked(app, alice, [])).toMatchObject({ cards: [], vocabulary: 'in_progress', selection: true });
  });

  it('saves an answer from a picked review by the same rules as any other', async () => {
    const app = on(TODAY);
    await library(app);
    const entries = await db.admin<{ id: string; word: string }>('select id, word from public.vocabulary');
    const lateOld = entries.find((row) => row.word === 'late-old')!.id;

    const [card] = (await picked(app, alice, [lateOld])).cards;
    await answer(app, alice, card!.id, 'remember');
    const after = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${card!.id}`)).json()).entry;
    // Mastery 3 remembered on the 9th: mastery 4, due three days later.
    expect(after).toMatchObject({ word: 'late-old', mastery: 4, reviewDate: '2026-10-12' });
  });

  it('rejects a selection it does not know, naming the ones it does', async () => {
    const response = await call(on(TODAY), alice, '/api/review-queue?focus=everything');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      'Unknown focus. Use one of: weak.',
    );
  });
});

describe('a confidence rating', () => {
  const logs = () =>
    db.admin<{ action: string; confidence: number | null; mastery_after: number }>(
      'select action, confidence, mastery_after from public.review_logs order by reviewed_at, id',
    );

  it('is stored beside the answer and changes nothing about what the answer does', async () => {
    const app = on(TODAY);
    const sure = await addWord(app, alice, { word: 'sure', mastery: 3, reviewDate: TODAY });
    const unsure = await addWord(app, alice, { word: 'unsure', mastery: 3, reviewDate: TODAY });
    const unrated = await addWord(app, alice, { word: 'unrated', mastery: 3, reviewDate: TODAY });

    await answer(app, alice, sure.id, 'remember', { confidence: 3 });
    await answer(app, alice, unsure.id, 'remember', { confidence: 1 });
    await answer(app, alice, unrated.id, 'remember');

    expect(await logs()).toEqual([
      { action: 'remember', confidence: 3, mastery_after: 4 },
      { action: 'remember', confidence: 1, mastery_after: 4 },
      { action: 'remember', confidence: null, mastery_after: 4 },
    ]);
    // The same answer leads to the same schedule whatever the confidence was.
    const states = await db.admin('select mastery, review_date::text as review_date from public.card_states');
    expect(new Set(states.map((row) => JSON.stringify(row)))).toEqual(new Set(['{"mastery":4,"review_date":"2026-10-12"}']));
  });

  it('does not stand in for the answer: sure and wrong is still wrong', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'overconfident', mastery: 6, reviewDate: TODAY });
    await answer(app, alice, word.id, 'not_remember', { confidence: 3 });
    expect(await logs()).toEqual([{ action: 'not_remember', confidence: 3, mastery_after: 6 }]);
  });

  it.each([[0], [4], [2.5], ['high'], [null]])('refuses %j and saves nothing', async (confidence) => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { response } = send(app, alice, word, 'remember', { confidence });
    expect((await response).status).toBe(400);
    expect(await logs()).toEqual([]);
    expect(entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${word.id}`)).json()).entry.mastery).toBe(3);
  });

  it('is held to 1, 2 or 3 by the database itself', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const event = (confidence: number) =>
      JSON.stringify({
        vocabulary_id: word.id,
        request_id: newId(),
        action: 'remember',
        expected_mastery: 3,
        expected_review_date: TODAY,
        new_mastery: 4,
        new_review_date: '2026-10-12',
        reviewed_on: TODAY,
        confidence,
      });
    for (const confidence of [0, 4]) {
      await expect(
        db.as(alice.id, (s) => s.query('select * from public.record_review($1::jsonb)', [event(confidence)])),
        String(confidence),
      ).rejects.toSatisfy((err: { code?: string }) => err.code === '22023' || err.code === '23514');
    }
    expect(await logs()).toEqual([]);
  });

  it('is kept when the same answer is sent again, and not counted twice', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const body = {
      pageId: word.id,
      action: 'remember',
      expected: { mastery: 3, nextReview: TODAY },
      requestId: newId(),
      confidence: 2,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await call(app, alice, '/api/review-action', { method: 'POST', body })).status).toBe(200);
    }
    expect(await logs()).toEqual([{ action: 'remember', confidence: 2, mastery_after: 4 }]);
  });
});

describe('calibration', () => {
  const calibrationOf = async (app: TestApp, user: TestUser) =>
    analyticsResponseSchema.parse(await (await call(app, user, '/api/analytics')).json()).calibration;

  it('lists every level, at zero, before any rating has been given', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    await answer(app, alice, word.id, 'remember');
    expect(await calibrationOf(app, alice)).toEqual({
      available: true,
      levels: [
        { confidence: 1, reviews: 0, remembered: 0, accuracy: null },
        { confidence: 2, reviews: 0, remembered: 0, accuracy: null },
        { confidence: 3, reviews: 0, remembered: 0, accuracy: null },
      ],
    });
  });

  it('counts how rated answers went at each level, with a share only from five answers up', async () => {
    const app = on(TODAY);
    const made: VocabularyEntry[] = [];
    for (let index = 0; index < 9; index += 1) made.push(await addWord(app, alice, { word: `w${index}` }));
    // High confidence: five answers, three remembered. Low: two, both remembered. Two unrated.
    const plan: Array<['remember' | 'not_remember', number | undefined]> = [
      ['remember', 3],
      ['remember', 3],
      ['remember', 3],
      ['not_remember', 3],
      ['not_remember', 3],
      ['remember', 1],
      ['remember', 1],
      ['remember', undefined],
      ['not_remember', undefined],
    ];
    for (const [index, [action, confidence]] of plan.entries()) {
      await answer(app, alice, made[index]!.id, action, confidence === undefined ? {} : { confidence });
    }
    expect((await calibrationOf(app, alice)).levels).toEqual([
      { confidence: 1, reviews: 2, remembered: 2, accuracy: null },
      { confidence: 2, reviews: 0, remembered: 0, accuracy: null },
      { confidence: 3, reviews: 5, remembered: 3, accuracy: 0.6 },
    ]);
  });

  it('leaves out an answer that was undone', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const requestId = await answer(app, alice, word.id, 'remember', { confidence: 2 });
    expect((await calibrationOf(app, alice)).levels[1]).toMatchObject({ reviews: 1, remembered: 1 });
    await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: requestId, requestId: newId() } });
    expect((await calibrationOf(app, alice)).levels[1]).toMatchObject({ reviews: 0, remembered: 0 });
  });

  it('looks back thirty days and no further', async () => {
    const word = await addWord(on('2026-09-01'), alice, { word: 'candid' });
    await answer(on('2026-09-09'), alice, word.id, 'not_remember', { confidence: 3 });
    await answer(on('2026-09-10'), alice, word.id, 'not_remember', { confidence: 3 });
    // From 9 October the window starts on 10 September.
    expect((await calibrationOf(on(TODAY), alice)).levels[2]).toMatchObject({ reviews: 1 });
  });

  it('belongs to one account only', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    await answer(app, alice, word.id, 'remember', { confidence: 3 });
    expect((await calibrationOf(app, bob)).levels.every((level) => level.reviews === 0)).toBe(true);
    await expect(db.asAnon((s) => s.query(`select * from public.confidence_stats('2026-01-01')`))).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('a database one migration behind (version 4)', () => {
  let old: TestDatabase;
  let carol: TestUser;

  beforeAll(async () => {
    old = await createTestDatabase({ migrations: 4 });
    carol = await createTestUser(old, 'carol');
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  it('says a goal cannot be kept yet, and refuses to pretend it was saved', async () => {
    const app = on(TODAY, old, [carol]);
    expect(await planOf(app, carol)).toMatchObject({ available: false, goal: { reviews: null, minutes: null }, met: null });
    const response = await setGoal(app, carol, { reviews: 20, minutes: null });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_supported');
  });

  it('still counts what is due and what was reviewed', async () => {
    const app = on(TODAY, old, [carol]);
    const word = await addWord(app, carol, { word: 'candid' });
    await addWord(app, carol, { word: 'lucid' });
    await answer(app, carol, word.id, 'not_remember', { durationMs: 4_000 });
    expect(await planOf(app, carol)).toMatchObject({ done: { reviews: 1, durationMs: 4_000 }, due: { total: 1 } });
  });

  it('saves an answer as before and simply does not keep its confidence', async () => {
    const app = on(TODAY, old, [carol]);
    const word = await addWord(app, carol, { word: 'candid2', mastery: 3, reviewDate: TODAY });
    await answer(app, carol, word.id, 'remember', { confidence: 3 });
    expect(entryResponseSchema.parse(await (await call(app, carol, `/api/vocabulary/${word.id}`)).json()).entry.mastery).toBe(4);

    const queue = await queueOf(app, carol);
    expect(queue.capabilities).toEqual({ ...NO_CAPABILITIES, sessions: true, undo: true, fsrs: true, analytics: true });
    const analytics = analyticsResponseSchema.parse(await (await call(app, carol, '/api/analytics')).json());
    expect(analytics.calibration).toMatchObject({ available: false });
    expect(analytics.calibration.levels.every((level) => level.reviews === 0)).toBe(true);
  });

  it('can still take the words the reviewer picked, and counts them by default', async () => {
    const app = on(TODAY, old, [carol]);
    const word = await addWord(app, carol, { word: 'early', mastery: 2, reviewDate: '2026-10-20' });
    const queue = queueResponseSchema.parse(
      await (await call(app, carol, '/api/review-queue', { method: 'POST', body: { ids: [word.id] } })).json(),
    );
    expect(queue.cards.map((card) => card.word)).toEqual(['early']);

    // Nowhere to keep the choice, so a review counts, exactly as it always did.
    const settings = accountSettingsSchema.parse(await (await call(app, carol, '/api/settings')).json());
    expect(settings.countReviewsTowardMastery).toBe(true);
  });
});
