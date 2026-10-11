/**
 * FSRS calculated in the background: every saved answer also stores what FSRS
 * makes of it, on the real schema, while the mastery schedule goes on deciding
 * what is due exactly as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsrsRatingMap } from '../../config/review.config.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { ReviewService } from '../../server/review-service.js';
import { LATEST_SCHEMA_VERSION } from '../../server/supabase/supabase-database.js';
import {
  NO_CAPABILITIES,
  accountSettingsSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  schedulerReportSchema,
  vocabularyListResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { addDays } from '../../shared/dates.js';
import { FSRS_ENGINE, fsrsDueDay, fsrsReview, type FsrsState } from '../../shared/scheduler/fsrs.js';
import { FakeRepository, NOW, TEST_FIELDS, TIME_ZONE, TODAY, pageId, record } from '../helpers/fixtures.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;
let app: TestApp;

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
  app = createSupabaseTestApp(db, [alice, bob]);
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
  options: { requestId?: string; on?: TestApp } = {},
) {
  const requestId = options.requestId ?? newId();
  const response = await call(options.on ?? app, user, '/api/review-action', {
    method: 'POST',
    body: { pageId: id, action, expected, requestId },
  });
  return { requestId, response };
}

type StoredFsrsColumns = {
  fsrs_due: Date | string | null;
  fsrs_stability: number | null;
  fsrs_difficulty: number | null;
  fsrs_reps: number | null;
  fsrs_lapses: number | null;
  fsrs_state: number | null;
  fsrs_scheduled_days: number | null;
  fsrs_learning_steps: number | null;
  fsrs_version: string | null;
  mastery: number;
};

const cardOf = async (id: string) =>
  (await db.admin<StoredFsrsColumns>('select * from public.card_states where vocabulary_id = $1', [id]))[0]!;

/** The stored FSRS fields in the shape the adapter uses, for comparing with it directly. */
function stored(row: StoredFsrsColumns): Pick<FsrsState, 'due' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'state' | 'scheduledDays'> | null {
  if (row.fsrs_due === null) return null;
  return {
    due: new Date(row.fsrs_due).toISOString(),
    stability: row.fsrs_stability ?? Number.NaN,
    difficulty: row.fsrs_difficulty ?? Number.NaN,
    reps: row.fsrs_reps ?? -1,
    lapses: row.fsrs_lapses ?? -1,
    state: row.fsrs_state ?? -1,
    scheduledDays: row.fsrs_scheduled_days ?? -1,
  };
}

const pick = (state: FsrsState) => ({
  due: state.due,
  stability: state.stability,
  difficulty: state.difficulty,
  reps: state.reps,
  lapses: state.lapses,
  state: state.state,
  scheduledDays: state.scheduledDays,
});

const seen = { mastery: 3, nextReview: TODAY };

describe('a word FSRS has not seen', () => {
  it('has no FSRS state at all: none is invented for it', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 8, reviewDate: '2026-10-20' });
    const row = await cardOf(word.id);
    expect(stored(row)).toBeNull();
    expect(row.fsrs_version).toBeNull();
    expect(row.mastery).toBe(8);
  });
});

describe('saving an answer', () => {
  it('stores the FSRS state that answer leads to, beside the mastery schedule', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { response, requestId } = await answer(alice, word.id, 'remember', seen);
    // What the user sees is the mastery schedule, unchanged: +1 level, due in 3 days.
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'applied',
      state: { mastery: 4, nextReview: '2026-10-12' },
    });

    const expected = fsrsReview(null, 3, NOW);
    const row = await cardOf(word.id);
    expect(stored(row)).toEqual(pick(expected));
    expect(row.fsrs_version).toBe(FSRS_ENGINE);

    const [log] = await db.admin<{ rating: number; fsrs_before: unknown; fsrs_after: { due: string; version: string; reps: number }; fsrs_version: string }>(
      'select rating, fsrs_before, fsrs_after, fsrs_version from public.review_logs where request_id = $1',
      [requestId],
    );
    expect(log).toMatchObject({ rating: fsrsRatingMap.remember, fsrs_before: null, fsrs_version: FSRS_ENGINE });
    expect(log?.fsrs_after).toMatchObject({ due: expected.due, reps: 1, version: FSRS_ENGINE });
  });

  it('rates Not remember as Again', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word.id, 'not_remember', seen);
    expect(stored(await cardOf(word.id))).toEqual(pick(fsrsReview(null, 1, NOW)));
    const [log] = await db.admin<{ rating: number }>('select rating from public.review_logs where request_id = $1', [requestId]);
    expect(log?.rating).toBe(1);
  });

  it('builds the next state on the stored one, and records both in the history', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 0, reviewDate: TODAY });
    await answer(alice, word.id, 'remember', { mastery: 0, nextReview: TODAY });
    const first = fsrsReview(null, 3, NOW);

    // Mastery 0 stays due the same day, so a second answer can follow at once.
    const later = new Date('2026-10-09T07:00:00Z');
    const afternoon = createSupabaseTestApp(db, [alice], { now: () => later });
    const { requestId } = await answer(alice, word.id, 'not_remember', { mastery: 1, nextReview: TODAY }, { on: afternoon });

    const second = fsrsReview(first, 1, later);
    expect(stored(await cardOf(word.id))).toEqual(pick(second));
    expect(second).toMatchObject({ reps: 2, lapses: 1 });

    const [log] = await db.admin<{ fsrs_before: { due: string; reps: number }; fsrs_after: { due: string; lapses: number } }>(
      'select fsrs_before, fsrs_after from public.review_logs where request_id = $1',
      [requestId],
    );
    expect(log?.fsrs_before).toMatchObject({ due: first.due, reps: 1 });
    expect(log?.fsrs_after).toMatchObject({ due: second.due, lapses: 1 });
  });

  it('does not let FSRS decide what is due', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    await answer(alice, word.id, 'remember', seen);
    const fsrsDay = fsrsDueDay(fsrsReview(null, 3, NOW), 'Asia/Ho_Chi_Minh');

    // On the day FSRS would show it but the mastery schedule would not (or the reverse), the mastery schedule wins.
    for (const day of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']) {
      const then = createSupabaseTestApp(db, [alice], { now: () => new Date(`${day}T05:00:00Z`) });
      const queue = queueResponseSchema.parse(await (await call(then, alice, '/api/review-queue')).json());
      expect(queue.cards.length === 1, day).toBe(day >= '2026-10-12');
    }
    const list = vocabularyListResponseSchema.parse(await (await call(app, alice, '/api/vocabulary')).json());
    expect(list.entries[0]).toMatchObject({ mastery: 4, reviewDate: '2026-10-12', reviewStatus: 'upcoming' });
    expect(fsrsDay).toBeDefined();
  });

  it('counts a repeated request once in FSRS too', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const requestId = newId();
    await answer(alice, word.id, 'remember', seen, { requestId });
    await answer(alice, word.id, 'remember', seen, { requestId });
    expect((await cardOf(word.id)).fsrs_reps).toBe(1);
    expect(await db.admin('select 1 from public.review_logs')).toHaveLength(1);
  });

  it('leaves FSRS alone when a stale answer from another device is refused', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    await answer(alice, word.id, 'remember', seen);
    const before = await cardOf(word.id);
    const stale = await answer(alice, word.id, 'not_remember', seen);
    expect(stale.response.status).toBe(409);
    expect(await cardOf(word.id)).toEqual(before);
  });
});

describe('undoing an answer', () => {
  const undo = (user: TestUser, reviewRequestId: string) =>
    call(app, user, '/api/review-undo', { method: 'POST', body: { reviewRequestId, requestId: newId() } });

  it('removes the FSRS state again when the card had none before', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word.id, 'remember', seen);
    expect((await undo(alice, requestId)).status).toBe(200);

    const row = await cardOf(word.id);
    expect(stored(row)).toBeNull();
    expect(row.fsrs_version).toBeNull();
    expect(row.fsrs_learning_steps).toBeNull();
    expect(row.mastery).toBe(3);
  });

  it('puts back the earlier FSRS state exactly when there was one', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 0, reviewDate: TODAY });
    await answer(alice, word.id, 'remember', { mastery: 0, nextReview: TODAY });
    const afterFirst = await cardOf(word.id);

    const second = await answer(alice, word.id, 'not_remember', { mastery: 1, nextReview: TODAY });
    expect((await cardOf(word.id)).fsrs_lapses).toBe(1);

    await undo(alice, second.requestId);
    expect(await cardOf(word.id)).toMatchObject({
      fsrs_stability: afterFirst.fsrs_stability,
      fsrs_difficulty: afterFirst.fsrs_difficulty,
      fsrs_reps: 1,
      fsrs_lapses: 0,
      fsrs_scheduled_days: afterFirst.fsrs_scheduled_days,
      fsrs_version: FSRS_ENGINE,
      mastery: 1,
    });
    expect(new Date((await cardOf(word.id)).fsrs_due as string).toISOString()).toBe(new Date(afterFirst.fsrs_due as string).toISOString());

    // The undo is itself on record, with the FSRS states the other way round.
    const [row] = await db.admin<{ fsrs_before: { lapses: number }; fsrs_after: { lapses: number } }>(
      `select fsrs_before, fsrs_after from public.review_logs where kind = 'undo'`,
    );
    expect(row?.fsrs_before.lapses).toBe(1);
    expect(row?.fsrs_after.lapses).toBe(0);
  });
});

describe('the retention FSRS aims for', () => {
  const settingsOf = async (user: TestUser) =>
    accountSettingsSchema.parse(await (await call(app, user, '/api/settings')).json());

  it('starts at 90% and can be changed per account', async () => {
    expect((await settingsOf(alice)).fsrsRetention).toBe(0.9);
    const saved = await call(app, alice, '/api/settings', { method: 'PUT', body: { fsrsRetention: 0.95 } });
    expect(saved.status).toBe(200);
    expect(accountSettingsSchema.parse(await saved.json())).toMatchObject({ fsrsRetention: 0.95, timeZone: 'Asia/Ho_Chi_Minh' });
    expect((await settingsOf(alice)).fsrsRetention).toBe(0.95);
    expect((await settingsOf(bob)).fsrsRetention).toBe(0.9);
  });

  it.each([[0.5], [0.99], ['0.9'], [null]])('rejects %s', async (value) => {
    await settingsOf(alice);
    const response = await call(app, alice, '/api/settings', { method: 'PUT', body: { fsrsRetention: value } });
    expect(response.status).toBe(400);
    expect((await settingsOf(alice)).fsrsRetention).toBe(0.9);
  });

  it('is what later answers are scheduled with', async () => {
    await call(app, alice, '/api/settings', { method: 'PUT', body: { fsrsRetention: 0.95 } });
    const mine = await addWord(alice, { word: 'candid', mastery: 0, reviewDate: TODAY });
    const theirs = await addWord(bob, { word: 'candid', mastery: 0, reviewDate: TODAY });
    for (const [user, word] of [[alice, mine], [bob, theirs]] as const) {
      await answer(user, word.id, 'remember', { mastery: 0, nextReview: TODAY });
    }
    // A week later both remember again; the stricter target brings the word back sooner.
    const nextWeek = createSupabaseTestApp(db, [alice, bob], { now: () => new Date('2026-10-16T05:00:00Z') });
    for (const [user, word] of [[alice, mine], [bob, theirs]] as const) {
      await answer(user, word.id, 'remember', { mastery: 1, nextReview: TODAY }, { on: nextWeek });
    }
    const strict = (await cardOf(mine.id)).fsrs_scheduled_days ?? 0;
    const standard = (await cardOf(theirs.id)).fsrs_scheduled_days ?? 0;
    expect(strict).toBeLessThan(standard);
  });

  it('can be changed without touching the time zone, and the other way round', async () => {
    await settingsOf(alice);
    await call(app, alice, '/api/settings', { method: 'PUT', body: { fsrsRetention: 0.85 } });
    await call(app, alice, '/api/settings', { method: 'PUT', body: { timeZone: 'UTC' } });
    expect(await settingsOf(alice)).toMatchObject({ fsrsRetention: 0.85, timeZone: 'UTC' });
    expect((await call(app, alice, '/api/settings', { method: 'PUT', body: {} })).status).toBe(400);
  });
});

describe('comparing the two schedules', () => {
  const reportOf = async (user: TestUser, on: TestApp = app) =>
    schedulerReportSchema.parse(await (await call(on, user, '/api/scheduler')).json());

  it('says which schedule is in force and how FSRS is set up', async () => {
    const report = await reportOf(alice);
    expect(report).toMatchObject({
      active: 'mastery_v1',
      today: TODAY,
      timeZone: 'Asia/Ho_Chi_Minh',
      fsrs: { available: true, engine: FSRS_ENGINE, requestRetention: 0.9, ratings: { remember: 'Good', notRemember: 'Again' } },
      totalCards: 0,
      comparable: 0,
      cards: [],
    });
    expect(report.workload).toHaveLength(14);
    expect(report.workload[0]).toEqual({ date: TODAY, legacy: 0, fsrs: 0 });
  });

  it('compares only words FSRS has seen, and only the caller’s own', async () => {
    const reviewed = await addWord(alice, { word: 'reviewed', mastery: 3, reviewDate: TODAY });
    await addWord(alice, { word: 'untouched', mastery: 5, reviewDate: '2026-10-20' });
    const theirs = await addWord(bob, { word: 'bobs', mastery: 3, reviewDate: TODAY });
    await answer(alice, reviewed.id, 'remember', seen);
    await answer(bob, theirs.id, 'remember', seen);

    const report = await reportOf(alice);
    const fsrs = fsrsReview(null, 3, NOW);
    expect(report).toMatchObject({ totalCards: 2, comparable: 1 });
    expect(report.cards).toEqual([
      {
        id: reviewed.id,
        word: 'reviewed',
        mastery: 4,
        legacyDue: '2026-10-12',
        fsrsDue: addDays(TODAY, fsrs.scheduledDays),
        fsrsIntervalDays: fsrs.scheduledDays,
        differenceDays: fsrs.scheduledDays - 3,
        // One answer is too little for FSRS's estimate to be worth showing.
        recall: null,
      },
    ]);
    expect(report.workload.reduce((total, day) => total + day.legacy, 0)).toBe(1);
    expect(report.workload.find((day) => day.date === '2026-10-12')?.legacy).toBe(1);
    expect(JSON.stringify(report)).not.toContain('bobs');
  });

  it('reads only: asking for it changes nothing', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    await answer(alice, word.id, 'remember', seen);
    const before = await db.admin('select * from public.card_states');
    await reportOf(alice);
    await reportOf(alice);
    expect(await db.admin('select * from public.card_states')).toEqual(before);
    expect(await db.admin('select 1 from public.review_logs')).toHaveLength(1);
  });
});

describe('the database itself', () => {
  it('refuses a half-filled FSRS state', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    await expect(
      db.as(alice.id, (s) => s.query(`update public.card_states set fsrs_due = now() where vocabulary_id = $1`, [word.id])),
    ).rejects.toMatchObject({ code: '23514' });
    expect(stored(await cardOf(word.id))).toBeNull();
  });

  it('refuses a retention outside the supported range', async () => {
    await call(app, alice, '/api/settings');
    await expect(
      db.as(alice.id, (s) => s.query(`update public.user_settings set fsrs_request_retention = 0.5 returning user_id`)),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an FSRS event that is missing its state, and saves nothing', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const event = {
      vocabulary_id: word.id,
      request_id: newId(),
      action: 'remember',
      expected_mastery: 3,
      expected_review_date: TODAY,
      new_mastery: 4,
      new_review_date: '2026-10-12',
      reviewed_on: TODAY,
      fsrs: { rating: 3, version: FSRS_ENGINE },
    };
    await expect(
      db.as(alice.id, (s) => s.query('select * from public.record_review($1::jsonb)', [JSON.stringify(event)])),
    ).rejects.toMatchObject({ code: '22023' });
    expect((await cardOf(word.id)).mastery).toBe(3);
    expect(await db.admin('select 1 from public.review_logs')).toEqual([]);
  });
});

describe('a database one migration behind (version 2)', () => {
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

  it('keeps saving reviews, with sessions and Undo, and simply has no FSRS', async () => {
    const queue = queueResponseSchema.parse(await (await call(legacy, owner, '/api/review-queue')).json());
    expect(queue.capabilities).toEqual({ ...NO_CAPABILITIES, sessions: true, undo: true });

    const word = await addWord(owner, { word: 'candid', mastery: 3, reviewDate: TODAY }, legacy);
    const { response, requestId } = await answer(owner, word.id, 'remember', seen, { on: legacy });
    expect(reviewActionResponseSchema.parse(await response.json()).state).toEqual({ mastery: 4, nextReview: '2026-10-12' });
    const undone = await call(legacy, owner, '/api/review-undo', { method: 'POST', body: { reviewRequestId: requestId, requestId: newId() } });
    expect(undone.status).toBe(200);
  });

  it('says FSRS is not available, without failing', async () => {
    const report = schedulerReportSchema.parse(await (await call(legacy, owner, '/api/scheduler')).json());
    expect(report).toMatchObject({ active: 'mastery_v1', fsrs: { available: false }, comparable: 0, cards: [] });
    const settings = accountSettingsSchema.parse(await (await call(legacy, owner, '/api/settings')).json());
    expect(settings).toMatchObject({ fsrsRetention: null, database: { version: 2, latest: LATEST_SCHEMA_VERSION } });
    const save = await call(legacy, owner, '/api/settings', { method: 'PUT', body: { fsrsRetention: 0.9 } });
    expect(save.status).toBe(400);
  });
});

describe('a failure inside FSRS', () => {
  it('never costs the user their review', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const repository = new FakeRepository([record(1, { mastery: 3, nextReview: '2026-10-01' })]);
    Object.assign(repository, { capabilities: { ...NO_CAPABILITIES, fsrs: true } });
    const writes: unknown[] = [];
    const save = repository.applyReview.bind(repository);
    repository.applyReview = async (write) => {
      writes.push(write.fsrs);
      return save(write);
    };
    const service = new ReviewService({
      repository,
      rules: sampleRules,
      cardFields: TEST_FIELDS,
      timeZone: TIME_ZONE,
      writesRequested: true,
      // An impossible setting makes the FSRS calculation throw.
      fsrs: { settings: { requestRetention: 2 }, ratingMap: fsrsRatingMap },
      now: () => NOW,
    });
    const result = await service.submitAction({
      pageId: pageId(1),
      action: 'remember',
      expected: { mastery: 3, nextReview: '2026-10-01' },
    });
    expect(result.outcome).toBe('applied');
    expect(writes).toEqual([null]);
    expect(error).toHaveBeenCalledWith('FSRS calculation failed:', expect.any(String));
  });
});
