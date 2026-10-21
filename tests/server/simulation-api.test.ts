/**
 * The what-if comparison and the calendar's review counts over HTTP, on the
 * real schema. Both only read: nothing they are asked can move a due date.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  entryResponseSchema,
  reviewDaysResponseSchema,
  schedulerReportSchema,
  simulationResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { addDays } from '../../shared/dates.js';
import { NOW, TODAY } from '../helpers/fixtures.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { MASTERY_ERA_MIGRATIONS, createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const DAY_MS = 86_400_000;
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
  expect(response.status).toBe(200);
  // The database stamps each answer with its own clock, which in real use is the moment the
  // server worked the answer out. Here the server's clock is the test's, so the stamp is set to match.
  const target = on === app ? db : null;
  await target?.admin('update public.review_logs set reviewed_at = $1 where request_id = $2', [
    clock.toISOString(),
    requestId,
  ]);
  return requestId;
}

const simulationOf = async (user: TestUser, query = '', on: TestApp = app) =>
  simulationResponseSchema.parse(await (await call(on, user, `/api/simulation${query}`)).json());

/** Everything a read must leave alone, as one comparable value. */
const snapshot = async () => ({
  cards: await db.admin('select * from public.card_states order by vocabulary_id'),
  logs: await db.admin('select * from public.review_logs order by id'),
  settings: await db.admin('select * from public.user_settings order by user_id'),
  words: await db.admin('select * from public.vocabulary order by id'),
});

/** One word answered on three separate days, so FSRS and the mastery schedule have drifted apart. */
async function seasonedWord(user: TestUser = alice) {
  const word = await addWord(user, { word: 'seasoned', mastery: 1, reviewDate: TODAY });
  await answer(user, word.id, 'remember', { mastery: 1, nextReview: TODAY });
  clock = later(1);
  await answer(user, word.id, 'remember', { mastery: 2, nextReview: addDays(TODAY, 1) });
  clock = later(3);
  await answer(user, word.id, 'remember', { mastery: 3, nextReview: addDays(TODAY, 3) });
  return word;
}

describe('the what-if comparison', () => {
  it('reaches, from the saved answers alone, the same FSRS date the app stored at the time', async () => {
    const word = await seasonedWord();
    const stored = schedulerReportSchema.parse(await (await call(app, alice, '/api/scheduler')).json());
    const simulated = await simulationOf(alice);

    expect(simulated).toMatchObject({ available: true, retention: 0.9, today: addDays(TODAY, 3) });
    expect(simulated.history).toMatchObject({ reviews: 3, firstDay: TODAY, lastDay: addDays(TODAY, 3) });
    expect(simulated.words).toEqual({ active: 1, replayed: 1, unseen: 0, retired: 0 });
    const card = simulated.cards[0]!;
    const live = stored.cards.find((item) => item.id === word.id)!;
    expect(card).toMatchObject({
      id: word.id,
      reviews: 3,
      mastery: 4,
      masteryDue: live.legacyDue,
      fsrsDue: live.fsrsDue,
      fsrsIntervalDays: live.fsrsIntervalDays,
    });
  });

  it('tries another target retention on request, moving only the FSRS side', async () => {
    await seasonedWord();
    const strict = await simulationOf(alice, '?retention=0.97');
    const relaxed = await simulationOf(alice, '?retention=0.75');
    expect(strict.retention).toBe(0.97);
    expect(relaxed.retention).toBe(0.75);
    expect(relaxed.cards[0]!.fsrsDue > strict.cards[0]!.fsrsDue).toBe(true);
    expect(relaxed.cards[0]!.masteryDue).toBe(strict.cards[0]!.masteryDue);
    expect(relaxed.nextDue.days.map((day) => day.mastery)).toEqual(strict.nextDue.days.map((day) => day.mastery));
  });

  it('uses the account’s own target when none is given', async () => {
    await call(app, alice, '/api/settings', { method: 'PUT', body: { fsrsRetention: 0.85 } });
    expect((await simulationOf(alice)).retention).toBe(0.85);
  });

  it('refuses a target outside the supported range, or one that is not a number', async () => {
    for (const bad of ['0.5', '0.99', '1', '-1', 'high', 'NaN']) {
      const response = await call(app, alice, `/api/simulation?retention=${bad}`);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('invalid_request');
    }
  });

  it('only reads: asking, at any target, stores nothing and moves nothing', async () => {
    await seasonedWord();
    await addWord(alice, { word: 'unseen', mastery: 2, reviewDate: addDays(TODAY, 6) });
    const before = await snapshot();
    await simulationOf(alice);
    await simulationOf(alice, '?retention=0.75');
    await simulationOf(alice, '?retention=0.97');
    expect(await snapshot()).toEqual(before);
  });

  it('leaves a word with no saved answer on its mastery date', async () => {
    const unseen = await addWord(alice, { word: 'unseen', mastery: 2, reviewDate: addDays(TODAY, 6) });
    const simulated = await simulationOf(alice);
    expect(simulated.words).toEqual({ active: 1, replayed: 0, unseen: 1, retired: 0 });
    expect(simulated.cards).toEqual([
      {
        id: unseen.id,
        word: 'unseen',
        mastery: 2,
        reviews: 0,
        masteryDue: addDays(TODAY, 6),
        fsrsDue: addDays(TODAY, 6),
        fsrsIntervalDays: null,
        differenceDays: 0,
      },
    ]);
  });

  it('does not replay an answer that was taken back, or any practice', async () => {
    const word = await addWord(alice, { word: 'candid', meaning: 'thẳng thắn', mastery: 3, reviewDate: TODAY });
    const requestId = await answer(alice, word.id, 'remember', { mastery: 3, nextReview: TODAY });
    const undone = await call(app, alice, '/api/review-undo', {
      method: 'POST',
      body: { reviewRequestId: requestId, requestId: newId() },
    });
    expect(undone.status).toBe(200);
    const practised = await call(app, alice, '/api/practice', {
      method: 'POST',
      body: { pageId: word.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' }, requestId: newId() },
    });
    expect(practised.status).toBe(200);

    const simulated = await simulationOf(alice);
    expect(simulated.history).toMatchObject({ reviews: 0, leftOut: { undone: 2, practice: 1, otherWords: 0 } });
    expect(simulated.cards[0]).toMatchObject({ reviews: 0, fsrsIntervalDays: null, masteryDue: TODAY, fsrsDue: TODAY });
  });

  it('sees only the caller’s own words and answers', async () => {
    await seasonedWord(alice);
    clock = NOW;
    const mine = await addWord(bob, { word: 'private', mastery: 5, reviewDate: addDays(TODAY, 2) });

    const simulated = await simulationOf(bob);
    expect(simulated.history).toMatchObject({ reviews: 0, leftOut: { undone: 0, practice: 0, otherWords: 0 } });
    expect(simulated.cards.map((card) => card.id)).toEqual([mine.id]);
    expect(JSON.stringify(simulated)).not.toContain('seasoned');
  });

  it('needs an account', async () => {
    expect((await call(app, null, '/api/simulation')).status).toBe(401);
  });
});

describe('reviews per day, for the calendar', () => {
  const daysOf = async (user: TestUser, from: string, to: string, on: TestApp = app) =>
    reviewDaysResponseSchema.parse(await (await call(on, user, `/api/review-days?from=${from}&to=${to}`)).json());

  it('counts saved answers on the reviewer’s own days, and leaves empty days out', async () => {
    await seasonedWord();
    const other = await addWord(alice, { word: 'other', mastery: 2, reviewDate: TODAY });
    await answer(alice, other.id, 'not_remember', { mastery: 2, nextReview: TODAY });

    const result = await daysOf(alice, '2026-10-01', '2026-10-31');
    expect(result).toEqual({
      available: true,
      from: '2026-10-01',
      to: '2026-10-31',
      days: [
        { date: TODAY, reviews: 1, remembered: 1 },
        { date: addDays(TODAY, 1), reviews: 1, remembered: 1 },
        { date: addDays(TODAY, 3), reviews: 2, remembered: 1 },
      ],
    });
    // Only the range asked for.
    expect((await daysOf(alice, addDays(TODAY, 1), addDays(TODAY, 2))).days).toEqual([
      { date: addDays(TODAY, 1), reviews: 1, remembered: 1 },
    ]);
  });

  it('does not count an answer that was taken back', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const requestId = await answer(alice, word.id, 'remember', { mastery: 3, nextReview: TODAY });
    await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: requestId, requestId: newId() } });
    expect((await daysOf(alice, TODAY, TODAY)).days).toEqual([]);
  });

  it('shows nobody else’s reviewing', async () => {
    await seasonedWord(alice);
    expect((await daysOf(bob, '2026-10-01', '2026-10-31')).days).toEqual([]);
  });

  it('refuses a range that is malformed, backwards or too long', async () => {
    for (const query of [
      '',
      '?from=2026-10-01',
      '?from=yesterday&to=2026-10-31',
      '?from=2026-10-31&to=2026-10-01',
      '?from=2026-01-01&to=2026-12-31',
      '?from=2026-02-30&to=2026-03-01',
    ]) {
      const response = await call(app, alice, `/api/review-days${query}`);
      expect(response.status).toBe(400);
    }
    // A hundred days is the most it will count at once.
    expect((await call(app, alice, '/api/review-days?from=2026-01-01&to=2026-04-10')).status).toBe(200);
    expect((await call(app, alice, '/api/review-days?from=2026-01-01&to=2026-04-11')).status).toBe(400);
  });

  it('needs an account', async () => {
    expect((await call(app, null, `/api/review-days?from=${TODAY}&to=${TODAY}`)).status).toBe(401);
  });
});

describe('a database that predates FSRS and review statistics (version 2)', () => {
  let old: TestDatabase;
  let owner: TestUser;
  let legacy: TestApp;

  beforeAll(async () => {
    old = await createTestDatabase({ migrations: 2 });
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  beforeEach(async () => {
    await old.admin('delete from auth.users');
    owner = await createTestUser(old, 'owner');
    legacy = createSupabaseTestApp(old, [owner]);
  });

  it('answers both without failing, and says there is nothing to show yet', async () => {
    const word = await addWord(owner, { word: 'candid', mastery: 3, reviewDate: TODAY }, legacy);
    await answer(owner, word.id, 'remember', { mastery: 3, nextReview: TODAY }, legacy);

    const simulated = await simulationOf(owner, '', legacy);
    expect(simulated).toMatchObject({ available: false, cards: [], words: { active: 0, replayed: 0, unseen: 0, retired: 0 } });

    const days = reviewDaysResponseSchema.parse(
      await (await call(legacy, owner, `/api/review-days?from=${TODAY}&to=${TODAY}`)).json(),
    );
    expect(days).toEqual({ available: false, from: TODAY, to: TODAY, days: [] });
  });
});
