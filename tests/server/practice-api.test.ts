/**
 * Practice in the other study modes, through the HTTP API on the real schema.
 * The rule that everything here defends: an answer given in practice is
 * recorded, and never changes a word's mastery, review date or FSRS state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_CAPABILITIES,
  analyticsResponseSchema,
  dayPlanSchema,
  entryResponseSchema,
  practiceResponseSchema,
  queueResponseSchema,
  weakWordsResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  db = await createTestDatabase();
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

const on = (day: string, database: TestDatabase = db, users: TestUser[] = [alice, bob], env?: Record<string, string>) =>
  createSupabaseTestApp(database, users, { now: () => new Date(`${day}T05:00:00Z`), env });

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

const practise = (app: TestApp, user: TestUser | null, body: Record<string, unknown>) =>
  call(app, user, '/api/practice', { method: 'POST', body: { requestId: newId(), ...body } });

async function practised(app: TestApp, user: TestUser, body: Record<string, unknown>) {
  const response = await practise(app, user, body);
  expect(response.status, JSON.stringify(body)).toBe(200);
  return practiceResponseSchema.parse(await response.json());
}

const entryOf = async (app: TestApp, user: TestUser, id: string) =>
  entryResponseSchema.parse(await (await call(app, user, `/api/vocabulary/${id}`)).json()).entry;

const weakOf = async (app: TestApp, user: TestUser) =>
  weakWordsResponseSchema.parse(await (await call(app, user, '/api/weak-words')).json());

const rows = () =>
  db.admin<{
    kind: string;
    review_mode: string;
    action: string;
    answer_correct: boolean | null;
    grading: string | null;
    submitted_answer: string | null;
  }>('select kind, review_mode, action, answer_correct, grading, submitted_answer from public.review_logs order by reviewed_at, id');

/** Everything about a word's schedule, as the database holds it. */
const scheduleOf = (id: string) =>
  db.admin(
    `select mastery, review_date::text as review_date, scheduler, fsrs_due, fsrs_stability, fsrs_difficulty, fsrs_reps,
            fsrs_lapses, fsrs_state, updated_at
       from public.card_states where vocabulary_id = $1`,
    [id],
  );

async function library(app: TestApp, user: TestUser = alice) {
  const candid = await addWord(app, user, {
    word: 'candid',
    meaning: 'thẳng thắn',
    definition: 'Honest and direct.',
    example: 'He gave a candid account of it.',
    mastery: 3,
    reviewDate: TODAY,
  });
  const others: VocabularyEntry[] = [];
  for (const [word, meaning] of [
    ['lucid', 'sáng suốt'],
    ['tenacious', 'bền bỉ'],
    ['ephemeral', 'phù du'],
    ['well-known', 'nổi tiếng'],
  ] as const) {
    others.push(await addWord(app, user, { word, meaning, example: `A sentence with ${word} in it.`, mastery: 2, reviewDate: '2026-10-20' }));
  }
  return { candid, others };
}

describe('an answer in each mode', () => {
  it('recognition is right only when the word’s own meaning is chosen', async () => {
    const app = on(TODAY);
    const { candid, others } = await library(app);
    expect(await practised(app, alice, { pageId: candid.id, mode: 'recognition', answer: { kind: 'choice', selectedId: candid.id } })).toEqual({
      outcome: 'recorded',
      correct: true,
      typed: null,
      expected: 'thẳng thắn',
      modeMastery: 1,
    });
    expect(
      await practised(app, alice, { pageId: candid.id, mode: 'recognition', answer: { kind: 'choice', selectedId: others[0]!.id } }),
    ).toMatchObject({ outcome: 'recorded', correct: false, expected: 'thẳng thắn' });
    expect(await rows()).toEqual([
      { kind: 'practice', review_mode: 'recognition', action: 'remember', answer_correct: true, grading: 'auto', submitted_answer: null },
      { kind: 'practice', review_mode: 'recognition', action: 'not_remember', answer_correct: false, grading: 'auto', submitted_answer: null },
    ]);
  });

  it('typing is judged by the server, and what was typed is kept', async () => {
    const app = on(TODAY);
    const { candid, others } = await library(app);
    const typed = (text: string, id = candid.id) => practised(app, alice, { pageId: id, mode: 'typing', answer: { kind: 'typed', text } });

    expect(await typed(' Candid ')).toMatchObject({ correct: true, typed: 'exact', expected: 'candid' });
    expect(await typed('candid.')).toMatchObject({ correct: true, typed: 'variant' });
    expect(await typed('candit')).toMatchObject({ correct: false, typed: 'incorrect', expected: 'candid' });
    expect(await typed('well - known', others[3]!.id)).toMatchObject({ correct: true, typed: 'variant', expected: 'well-known' });

    expect((await rows()).map((row) => [row.answer_correct, row.submitted_answer, row.grading])).toEqual([
      [true, 'Candid', 'auto'],
      [true, 'candid.', 'auto'],
      [false, 'candit', 'auto'],
      [true, 'well - known', 'auto'],
    ]);
  });

  it('cloze is judged against the word, shown as its sentence had it', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid', example: 'Candid answers are rare.' });
    expect(await practised(app, alice, { pageId: word.id, mode: 'cloze', answer: { kind: 'typed', text: 'candid' } })).toMatchObject({
      correct: true,
      typed: 'exact',
      expected: 'Candid',
    });
    expect(await practised(app, alice, { pageId: word.id, mode: 'cloze', answer: { kind: 'typed', text: 'frank' } })).toMatchObject({
      correct: false,
    });
  });

  it('listening is judged like typing, and kept under its own name', async () => {
    const app = on(TODAY);
    // A word with nothing but its spelling: enough to be listened to, not enough for the other modes.
    const bare = await addWord(app, alice, { word: 'lucid', mastery: 3, reviewDate: TODAY });
    const heard = (text: string) => practised(app, alice, { pageId: bare.id, mode: 'listening', answer: { kind: 'typed', text } });

    expect(await heard('Lucid')).toEqual({
      outcome: 'recorded',
      correct: true,
      typed: 'exact',
      expected: 'lucid',
      modeMastery: 1,
    });
    expect(await heard('loosid')).toMatchObject({ correct: false, typed: 'incorrect', expected: 'lucid' });
    expect(await rows()).toEqual([
      { kind: 'practice', review_mode: 'listening', action: 'remember', answer_correct: true, grading: 'auto', submitted_answer: 'Lucid' },
      { kind: 'practice', review_mode: 'listening', action: 'not_remember', answer_correct: false, grading: 'auto', submitted_answer: 'loosid' },
    ]);
    // Practice, like every other mode: the word's schedule has not moved.
    expect(await entryOf(app, alice, bare.id)).toMatchObject({ mastery: 3, reviewDate: TODAY });

    // And it is reported on its own line, never folded into typing.
    const analytics = analyticsResponseSchema.parse(await (await call(app, alice, '/api/analytics')).json());
    expect(analytics.practice.modes).toEqual([{ mode: 'listening', answers: 2, correct: 1, accuracy: null }]);
  });

  it('does not believe the browser about whether a typed answer was right', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const response = await practise(app, alice, {
      pageId: candid.id,
      mode: 'typing',
      answer: { kind: 'typed', text: 'wrong', correct: true },
    });
    expect(response.status).toBe(400);
    expect(await rows()).toEqual([]);
  });
});

describe('practice and the schedule', () => {
  it('leaves mastery, the review date and every FSRS field exactly as they were, in every mode', async () => {
    const app = on(TODAY);
    const { candid, others } = await library(app);
    // Give the word an FSRS state first, by reviewing it once.
    await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: candid.id, action: 'not_remember', expected: { mastery: 3, nextReview: TODAY }, requestId: newId() },
    });
    const before = await scheduleOf(candid.id);
    expect(before[0]).toMatchObject({ mastery: 3, review_date: '2026-10-10' });
    expect(before[0]?.fsrs_due).not.toBeNull();

    const answers: Array<[string, Record<string, unknown>]> = [
      ['recognition', { kind: 'choice', selectedId: candid.id }],
      ['recognition', { kind: 'choice', selectedId: others[0]!.id }],
      ['listening', { kind: 'typed', text: 'candid' }],
      ['listening', { kind: 'typed', text: 'nope' }],
      ['typing', { kind: 'typed', text: 'candid' }],
      ['typing', { kind: 'typed', text: 'nope' }],
      ['cloze', { kind: 'typed', text: 'candid' }],
      ['cloze', { kind: 'typed', text: 'nope' }],
    ];
    for (const [mode, answer] of answers) await practised(app, alice, { pageId: candid.id, mode, answer });

    expect(await scheduleOf(candid.id)).toEqual(before);
    expect((await rows()).filter((row) => row.kind === 'practice')).toHaveLength(8);
  });

  it('records the state it found, unchanged, on every practice row', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    await practised(app, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    const logged = await db.admin(
      `select mastery_before, mastery_after, review_date_before::text as before, review_date_after::text as after,
              rating, fsrs_before, fsrs_after from public.review_logs`,
    );
    expect(logged).toEqual([
      { mastery_before: 3, mastery_after: 3, before: TODAY, after: TODAY, rating: null, fsrs_before: null, fsrs_after: null },
    ]);
  });

  it('does not take a word out of the review queue, or put one in', async () => {
    const app = on(TODAY);
    const { candid, others } = await library(app);
    const queue = async () => queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue')).json()).cards;
    const before = await queue();
    expect(before.map((card) => card.word)).toEqual(['candid']);

    // A right answer on the due word, and on one that is not due.
    await practised(app, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    await practised(app, alice, { pageId: others[0]!.id, mode: 'typing', answer: { kind: 'typed', text: 'lucid' } });
    expect(await queue()).toEqual(before);
    expect(await entryOf(app, alice, others[0]!.id)).toMatchObject({ mastery: 2, reviewDate: '2026-10-20' });
  });

  it('can be done on a word that is not due, and on a mastered one, without touching either', async () => {
    const app = on(TODAY);
    await library(app);
    const mastered = await addWord(app, alice, { word: 'eloquent', meaning: 'hùng hồn', mastery: 10, reviewDate: '2026-09-01' });
    expect(await practised(app, alice, { pageId: mastered.id, mode: 'typing', answer: { kind: 'typed', text: 'wrong' } })).toMatchObject({
      outcome: 'recorded',
      correct: false,
    });
    expect(await entryOf(app, alice, mastered.id)).toMatchObject({ mastery: 10, reviewDate: '2026-09-01', reviewStatus: 'mastered' });
  });

  it('does not stand in the way of undoing the review before it', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const reviewId = newId();
    await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: candid.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY }, requestId: reviewId },
    });
    await practised(app, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'nope' } });

    const undo = await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: reviewId, requestId: newId() } });
    expect(undo.status).toBe(200);
    expect(await entryOf(app, alice, candid.id)).toMatchObject({ mastery: 3, reviewDate: TODAY });
  });

  it('a practice answer cannot itself be "undone" into changing a word', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const requestId = newId();
    await practise(app, alice, { requestId, pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    const undo = await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: requestId, requestId: newId() } });
    expect(undo.status).toBe(404);
    expect(await entryOf(app, alice, candid.id)).toMatchObject({ mastery: 3, reviewDate: TODAY });
  });
});

describe('practice kept apart from reviews', () => {
  it('is not counted as a review in activity, streak or goal, but does count towards weak words', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    await call(app, alice, '/api/goal', { method: 'PUT', body: { reviews: 1, minutes: null } });
    for (let index = 0; index < 6; index += 1) {
      await practised(app, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'wrong' }, durationMs: 4000 });
    }

    const analytics = analyticsResponseSchema.parse(await (await call(app, alice, '/api/analytics')).json());
    expect(analytics.periods.today).toMatchObject({ reviews: 0, remembered: 0, durationMs: 0 });
    expect(analytics.streak).toEqual({ current: 0, longest: 0 });
    expect(analytics.byMode).toEqual([]);
    expect(analytics.firstReviewOn).toBeNull();

    const plan = dayPlanSchema.parse(await (await call(app, alice, '/api/plan')).json());
    expect(plan).toMatchObject({ met: false, done: { reviews: 0, durationMs: 0 } });

    // Six wrong answers in practice are not a review — activity, streak and the goal
    // still read scheduled reviews only — but they do count towards the weak list.
    const weak = weakWordsResponseSchema.parse(await (await call(app, alice, '/api/weak-words')).json());
    expect(weak.words.find((item) => item.id === candid.id)).toMatchObject({
      score: 9,
      severity: 'high',
      recovery: { points: 0, threshold: 4, recovered: false, lastRememberedOn: null },
    });
    expect(await db.admin('select count(*)::int as count from public.effective_reviews')).toEqual([{ count: 0 }]);
  });

  it('is reported per mode, with a share only from five answers up', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const typed = (text: string) => practised(app, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text } });
    for (const text of ['candid', 'candid', 'candid', 'nope', 'nope']) await typed(text);
    await practised(app, alice, { pageId: candid.id, mode: 'listening', answer: { kind: 'typed', text: 'candid' } });

    const { practice } = analyticsResponseSchema.parse(await (await call(app, alice, '/api/analytics')).json());
    expect(practice).toEqual({
      available: true,
      modes: [
        { mode: 'typing', answers: 5, correct: 3, accuracy: 0.6 },
        { mode: 'listening', answers: 1, correct: 1, accuracy: null },
      ],
      today: { answers: 6, correct: 4 },
    });
  });

  it('looks back thirty days, and counts "today" by the reviewer’s own day', async () => {
    const { candid } = await library(on('2026-09-01'));
    const answer = { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } };
    await practised(on('2026-09-09'), alice, answer);
    await practised(on('2026-09-10'), alice, answer);
    await practised(on('2026-10-08'), alice, answer);
    const { practice } = analyticsResponseSchema.parse(await (await call(on(TODAY), alice, '/api/analytics')).json());
    // From 9 October the window starts on 10 September.
    expect(practice.modes).toEqual([{ mode: 'typing', answers: 2, correct: 2, accuracy: null }]);
    expect(practice.today).toEqual({ answers: 0, correct: 0 });
  });

  it('keeps a confidence rating with the answer without mixing it into review calibration', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    await practised(app, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' }, confidence: 3 });
    expect(await db.admin('select confidence from public.review_logs')).toEqual([{ confidence: 3 }]);
    const { calibration } = analyticsResponseSchema.parse(await (await call(app, alice, '/api/analytics')).json());
    expect(calibration.levels.every((level) => level.reviews === 0)).toBe(true);
  });
});

describe('practice and recovery', () => {
  it('recovers a word through practice alone', async () => {
    const day1 = on('2026-10-06');
    const { candid } = await library(day1);
    // One forgotten review makes it weak.
    const current = await entryOf(day1, alice, candid.id);
    await call(day1, alice, '/api/review-action', {
      method: 'POST',
      body: {
        pageId: candid.id,
        action: 'not_remember',
        expected: { mastery: current.mastery, nextReview: current.reviewDate },
        requestId: newId(),
        allowNotDue: true,
        countsTowardMastery: false,
      },
    });
    expect((await weakOf(day1, alice)).words.find((word) => word.id === candid.id)).toBeDefined();

    // One correct typing answer a day is one auto-graded point a day: three days and it is back.
    for (const day of ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']) {
      await practised(on(day), alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    }
    const weak = await weakOf(on('2026-10-09'), alice);
    expect(weak.words.find((word) => word.id === candid.id)).toBeUndefined();
  });
});

describe('recording once', () => {
  it('records a repeated request a single time', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const body = { requestId: newId(), pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } };
    const first = practiceResponseSchema.parse(await (await practise(app, alice, body)).json());
    const second = practiceResponseSchema.parse(await (await practise(app, alice, body)).json());
    expect(first.outcome).toBe('recorded');
    expect(second).toEqual({ ...first, outcome: 'already_recorded' });
    expect(await rows()).toHaveLength(1);
  });

  it('refuses a request id that already belongs to a review, and records nothing', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const requestId = newId();
    await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: candid.id, action: 'not_remember', expected: { mastery: 3, nextReview: TODAY }, requestId },
    });
    const response = await practise(app, alice, { requestId, pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    expect(response.status).toBe(400);
    expect((await rows()).map((row) => row.kind)).toEqual(['review']);
  });

  it('groups a session’s answers under its session id', async () => {
    const app = on(TODAY);
    const { candid, others } = await library(app);
    const sessionId = newId();
    await practised(app, alice, { sessionId, pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    await practised(app, alice, { sessionId, pageId: others[0]!.id, mode: 'typing', answer: { kind: 'typed', text: 'x' } });
    expect(await db.admin('select id, mode, user_id from public.study_sessions')).toEqual([
      { id: sessionId, mode: 'typing', user_id: alice.id },
    ]);
    expect(await db.admin('select count(*)::int as count from public.review_logs where session_id = $1', [sessionId])).toEqual([
      { count: 2 },
    ]);
  });
});

describe('what is refused', () => {
  it.each([
    ['a self-graded answer in typing', { mode: 'typing', answer: { kind: 'self', correct: true } }],
    ['a typed answer in recognition', { mode: 'recognition', answer: { kind: 'typed', text: 'thẳng thắn' } }],
    ['a choice in cloze', { mode: 'cloze', answer: { kind: 'choice', selectedId: '00000000-0000-4000-8000-000000000001' } }],
    ['the flashcard mode, which is a review', { mode: 'flashcard', answer: { kind: 'typed', text: 'candid' } }],
    ['a mode that does not exist', { mode: 'singing', answer: { kind: 'typed', text: 'candid' } }],
    ['a self-graded answer in listening', { mode: 'listening', answer: { kind: 'self', correct: true } }],
    ['no answer', { mode: 'typing' }],
    ['a mastery to store', { mode: 'typing', answer: { kind: 'typed', text: 'candid' }, mastery: 10 }],
    ['a review date to store', { mode: 'typing', answer: { kind: 'typed', text: 'candid' }, expected: { mastery: 3, nextReview: null } }],
    ['an over-long answer', { mode: 'typing', answer: { kind: 'typed', text: 'x'.repeat(501) } }],
  ])('%s', async (_name, body) => {
    const app = on(TODAY);
    const { candid } = await library(app);
    expect((await practise(app, alice, { pageId: candid.id, ...body })).status).toBe(400);
    expect(await rows()).toEqual([]);
    expect(await entryOf(app, alice, candid.id)).toMatchObject({ mastery: 3, reviewDate: TODAY });
  });

  it('a request with no id of its own', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const response = await call(app, alice, '/api/practice', {
      method: 'POST',
      body: { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } },
    });
    expect(response.status).toBe(400);
  });

  it('a cloze answer for a word whose example does not contain it', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'alleviate', example: 'It alleviated the pain.' });
    expect((await practise(app, alice, { pageId: word.id, mode: 'cloze', answer: { kind: 'typed', text: 'alleviate' } })).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('a word that is in the trash, or does not exist', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    await call(app, alice, `/api/vocabulary/${candid.id}`, { method: 'DELETE' });
    const answer = { mode: 'typing', answer: { kind: 'typed', text: 'candid' } };
    expect((await practise(app, alice, { pageId: candid.id, ...answer })).status).toBe(404);
    expect((await practise(app, alice, { pageId: '99999999-9999-4999-8999-999999999999', ...answer })).status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it('a visitor who is not signed in', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    expect((await practise(app, null, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } })).status).toBe(401);
  });
});

describe('one account’s practice and another’s', () => {
  it('cannot be recorded against someone else’s word', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const response = await practise(app, bob, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    expect(response.status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it('is invisible to the other account, in the rows and in the figures', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    await practised(app, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });

    expect(await db.as(bob.id, (s) => s.query('select * from public.review_logs'))).toEqual([]);
    expect(await db.as(bob.id, (s) => s.query(`select * from public.practice_daily_stats('2026-01-01', '2026-12-31')`))).toEqual([]);
    const theirs = analyticsResponseSchema.parse(await (await call(app, bob, '/api/analytics')).json());
    expect(theirs.practice).toEqual({ available: true, modes: [], today: { answers: 0, correct: 0 } });
  });

  it('cannot join another account’s session', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const mine = await addWord(app, bob, { word: 'mine', meaning: 'của tôi' });
    const sessionId = newId();
    await practised(app, alice, { sessionId, pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    const response = await practise(app, bob, { sessionId, pageId: mine.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    expect(response.status).toBe(403);
    expect(await db.admin('select count(*)::int as count from public.review_logs where user_id = $1', [bob.id])).toEqual([{ count: 0 }]);
  });

  it('is closed to a signed-out visitor at the database too', async () => {
    for (const statement of [`select * from public.record_practice('{}'::jsonb)`, `select * from public.practice_daily_stats('2026-01-01', '2026-12-31')`]) {
      await expect(db.asAnon((s) => s.query(statement)), statement).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('what the database itself insists on', () => {
  const event = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      request_id: newId(),
      review_mode: 'typing',
      answer_correct: true,
      grading: 'auto',
      reviewed_on: TODAY,
      ...overrides,
    });

  it('a practice row cannot record a change of schedule', async () => {
    const { candid } = await library(on(TODAY));
    const insert = (columns: string) =>
      db.as(alice.id, (s) =>
        s.query(
          `insert into public.review_logs
             (vocabulary_id, request_id, kind, action, review_mode, reviewed_on, answer_correct, grading,
              mastery_before, mastery_after, review_date_before, review_date_after)
           values ($1, $2, 'practice', 'remember', 'typing', $3, true, 'auto', ${columns})`,
          [candid.id, newId(), TODAY],
        ),
      );
    await expect(insert(`3, 4, '${TODAY}', '${TODAY}'`)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(`3, 3, '${TODAY}', '2026-10-12'`)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(`3, 3, '${TODAY}', '${TODAY}'`)).resolves.toEqual([]);
  });

  it('a flashcard answer cannot be passed off as practice, nor an unknown mode recorded', async () => {
    const { candid } = await library(on(TODAY));
    const record = (overrides: Record<string, unknown>) =>
      db.as(alice.id, (s) => s.query('select * from public.record_practice($1::jsonb)', [event({ vocabulary_id: candid.id, ...overrides })]));
    await expect(record({ review_mode: 'flashcard' })).rejects.toMatchObject({ code: '22023' });
    await expect(record({ review_mode: 'telepathy' })).rejects.toMatchObject({ code: '23514' });
    await expect(record({ grading: 'guess' })).rejects.toMatchObject({ code: '23514' });
    await expect(record({ confidence: 7 })).rejects.toMatchObject({ code: '22023' });
    await expect(record({ answer_correct: null })).rejects.toMatchObject({ code: '22023' });
    expect(await rows()).toEqual([]);
  });

  it('practice history cannot be edited or deleted, even by its owner', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    await practised(app, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'nope' } });
    await expect(db.as(alice.id, (s) => s.query('update public.review_logs set answer_correct = true'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(db.as(alice.id, (s) => s.query('delete from public.review_logs'))).rejects.toMatchObject({ code: '42501' });
    expect((await rows())[0]).toMatchObject({ answer_correct: false });
  });

  it('existing review rows satisfy the new rules', async () => {
    const app = on(TODAY);
    const { candid } = await library(app);
    const response = await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: candid.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY }, requestId: newId() },
    });
    expect(response.status).toBe(200);
    expect(await rows()).toEqual([
      { kind: 'review', review_mode: 'flashcard', action: 'remember', answer_correct: null, grading: null, submitted_answer: null },
    ]);
  });
});

describe('where practice cannot be recorded', () => {
  let old: TestDatabase;
  let carol: TestUser;

  beforeAll(async () => {
    old = await createTestDatabase({ migrations: 5 });
    carol = await createTestUser(old, 'carol');
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  it('a database one migration behind still judges the answer, and says nothing was recorded', async () => {
    const app = on(TODAY, old, [carol]);
    const word = await addWord(app, carol, { word: 'candid', meaning: 'thẳng thắn' });
    expect(await practised(app, carol, { pageId: word.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } })).toEqual({
      outcome: 'dry_run',
      correct: true,
      typed: 'exact',
      expected: 'candid',
      // Nothing was recorded, so there is no new score to report.
      modeMastery: null,
    });
    expect(await old.admin('select count(*)::int as count from public.review_logs')).toEqual([{ count: 0 }]);

    const queue = queueResponseSchema.parse(await (await call(app, carol, '/api/review-queue')).json());
    expect(queue.capabilities).toEqual({ ...NO_CAPABILITIES, sessions: true, undo: true, fsrs: true, analytics: true, goals: true, confidence: true });
    const analytics = analyticsResponseSchema.parse(await (await call(app, carol, '/api/analytics')).json());
    expect(analytics.practice).toEqual({ available: false, modes: [], today: { answers: 0, correct: 0 } });
  });

  it('with saving switched off, an answer is judged and nothing is recorded', async () => {
    const { candid } = await library(on(TODAY));
    const frozen = on(TODAY, db, [alice, bob], { REVIEW_WRITES_ENABLED: 'false' });
    expect(await practised(frozen, alice, { pageId: candid.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } })).toMatchObject({
      outcome: 'dry_run',
      correct: true,
    });
    expect(await rows()).toEqual([]);
  });
});
