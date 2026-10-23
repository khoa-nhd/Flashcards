/**
 * FSRS as the only schedule (schema version 15), through the real routes,
 * account sessions, schema and Row Level Security. Covers the one-off
 * conversion in the version 15 file too: a database at version 14 with old
 * data, then the file run on top of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, RECOMMENDED_SCHEMA_VERSION } from '../../server/supabase/supabase-database.js';
import {
  accountSettingsSchema,
  apiErrorSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  reviewUndoResponseSchema,
  studyGoalsResponseSchema,
  vocabularyListResponseSchema,
  weakWordsResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { TODAY } from '../helpers/fixtures.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, readMigrations, type TestDatabase } from '../helpers/test-database.js';

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

async function addWord(user: TestUser, word: string): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), word, meaning: 'nghĩa' } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

/** A card's stored row, read as JSON so dates and timestamps compare as text. */
const stored = async (id: string) =>
  ((await db.admin<{ row: Record<string, unknown> }>('select to_jsonb(c) as row from public.card_states c where vocabulary_id = $1', [id]))[0]!).row;

const queueOf = async (user: TestUser) =>
  queueResponseSchema.parse(await (await call(app, user, '/api/review-queue')).json());

const answer = (user: TestUser, body: Record<string, unknown>) =>
  call(app, user, '/api/review-action', { method: 'POST', body: { requestId: newId(), ...body } });

const remember = (id: string, revision: number, extra: Record<string, unknown> = {}) => ({
  pageId: id,
  action: 'remember',
  expected: { mastery: 1, nextReview: TODAY },
  expectedRevision: revision,
  ...extra,
});

describe('the schema version Settings reports', () => {
  it('asks for version 15 now that its screens exist, and reports a database at 15 as up to date', async () => {
    const settings = accountSettingsSchema.parse(await (await call(app, alice, '/api/settings')).json());
    expect(settings.database).toEqual({ version: LATEST_SCHEMA_VERSION, latest: RECOMMENDED_SCHEMA_VERSION });
    expect(RECOMMENDED_SCHEMA_VERSION).toBe(15);
    expect(settings.database!.version >= settings.database!.latest).toBe(true);
  });
});

describe('settings kept from version 15', () => {
  const settingsOf = async (user: TestUser) => accountSettingsSchema.parse(await (await call(app, user, '/api/settings')).json());
  const save = (user: TestUser, body: Record<string, unknown>) => call(app, user, '/api/settings', { method: 'PUT', body });

  it('keeps a daily review limit and an interface language, and can go back to following the browser', async () => {
    expect(await settingsOf(alice)).toMatchObject({ fsrsOnly: true, maxReviewsPerDay: null, uiLanguage: null });
    const saved = await save(alice, { maxReviewsPerDay: 50, uiLanguage: 'en' });
    expect(saved.status).toBe(200);
    expect(accountSettingsSchema.parse(await saved.json())).toMatchObject({ maxReviewsPerDay: 50, uiLanguage: 'en' });
    expect(await settingsOf(alice)).toMatchObject({ maxReviewsPerDay: 50, uiLanguage: 'en' });

    await save(alice, { maxReviewsPerDay: null, uiLanguage: null });
    expect(await settingsOf(alice)).toMatchObject({ maxReviewsPerDay: null, uiLanguage: null });
    // Another account is untouched throughout.
    expect(await settingsOf(bob)).toMatchObject({ maxReviewsPerDay: null, uiLanguage: null });
  });

  it('refuses a limit outside 1 to 1000 and a language it does not have', async () => {
    expect((await save(alice, { maxReviewsPerDay: 0 })).status).toBe(400);
    expect((await save(alice, { uiLanguage: 'fr' })).status).toBe(400);
  });

  it('takes the FSRS-first name of the counting choice as the same setting', async () => {
    await save(alice, { countReviewsTowardSchedule: false });
    expect((await settingsOf(alice)).countReviewsTowardMastery).toBe(false);
  });
});

describe('a new word under FSRS alone', () => {
  it('is new and due today, and keeps the starting mastery underneath without a schedule of its own', async () => {
    const word = await addWord(alice, 'candid');
    expect(word).toMatchObject({ reviewStatus: 'new', reviewable: true, dueDate: TODAY, revision: 0, suspended: false });
    expect(word.memory).toMatchObject({ level: 1, label: 'New', reps: 0 });

    const row = await stored(word.id);
    expect(row).toMatchObject({ mastery: 1, due_on: TODAY, revision: 0, fsrs_due: null });
    const queue = await queueOf(alice);
    expect(queue).toMatchObject({ scheduler: 'fsrs', fsrsOnly: true });
    expect(queue.cards.map((card) => card.word)).toEqual(['candid']);
    expect(queue.cards[0]).toMatchObject({ revision: 0, detailCollapsed: false });
  });
});

describe('answering under FSRS alone', () => {
  it('moves FSRS and the revision, and never writes mastery or the review date', async () => {
    const word = await addWord(alice, 'candid');
    const response = await answer(alice, remember(word.id, 0));
    expect(response.status).toBe(200);
    const body = reviewActionResponseSchema.parse(await response.json());
    expect(body.outcome).toBe('applied');
    expect(body.state).toMatchObject({ revision: 1, dueOn: null });
    expect(body.state?.fsrs?.reps).toBe(1);

    const row = await stored(word.id);
    expect(row).toMatchObject({ mastery: 1, review_date: TODAY, due_on: null, revision: 1, fsrs_reps: 1 });
    const [log] = await db.admin('select to_jsonb(l) as row from public.review_logs l where vocabulary_id = $1', [word.id]);
    expect(log!.row).toMatchObject({
      scheduler: 'fsrs',
      revision_before: 0,
      revision_after: 1,
      due_on_before: TODAY,
      due_on_after: null,
      counted_toward_schedule: true,
      counted_as_new: true,
      // Mastery is frozen: the history repeats it rather than inventing a new one.
      mastery_before: 1,
      mastery_after: 1,
    });

    // It is no longer due today, so it leaves the queue.
    expect((await queueOf(alice)).cards).toEqual([]);
  });

  it('saves a repeated answer once, and refuses a stale one from another device', async () => {
    const word = await addWord(alice, 'candid');
    const requestId = newId();
    expect((await answer(alice, { ...remember(word.id, 0), requestId })).status).toBe(200);
    const again = reviewActionResponseSchema.parse(await (await answer(alice, { ...remember(word.id, 0), requestId })).json());
    expect(again.outcome).toBe('already_applied');
    expect(again.state).toMatchObject({ revision: 1 });

    const stale = await answer(alice, remember(word.id, 0, { allowNotDue: true }));
    expect(stale.status).toBe(409);
    expect(apiErrorSchema.parse(await stale.json()).error.code).toBe('conflict');
    expect(await stored(word.id)).toMatchObject({ revision: 1, fsrs_reps: 1 });
  });

  it('still takes an answer from a page that sends no revision, while the day it was shown still holds', async () => {
    const word = await addWord(alice, 'candid');
    const old: Record<string, unknown> = { ...remember(word.id, 0) };
    delete old.expectedRevision;
    expect((await answer(alice, old)).status).toBe(200);
    // Shown the same day again, but the card has moved on: refused.
    expect((await answer(alice, { ...old, allowNotDue: true })).status).toBe(409);
  });

  it('records an answer that does not count without moving anything', async () => {
    const word = await addWord(alice, 'candid');
    const response = await answer(alice, remember(word.id, 0, { countsTowardSchedule: false }));
    expect(response.status).toBe(200);
    expect(await stored(word.id)).toMatchObject({ revision: 0, due_on: TODAY, fsrs_due: null });
    const [log] = await db.admin('select to_jsonb(l) as row from public.review_logs l where vocabulary_id = $1', [word.id]);
    expect(log!.row).toMatchObject({ counted_toward_schedule: false, revision_before: 0, revision_after: 0 });
    expect((await queueOf(alice)).cards.map((card) => card.word)).toEqual(['candid']);
  });

  it('refuses an early answer unless the review allows it', async () => {
    const word = await addWord(alice, 'candid');
    await answer(alice, remember(word.id, 0));
    const early = await answer(alice, remember(word.id, 1));
    expect(early.status).toBe(409);
    expect(apiErrorSchema.parse(await early.json()).error.message).toContain('not due');
    expect((await answer(alice, remember(word.id, 1, { allowNotDue: true }))).status).toBe(200);
    expect(await stored(word.id)).toMatchObject({ revision: 2, fsrs_reps: 2 });
  });

  it('never lets another account answer for a word', async () => {
    const word = await addWord(alice, 'candid');
    expect((await answer(bob, remember(word.id, 0))).status).toBe(404);
    expect(await stored(word.id)).toMatchObject({ revision: 0, fsrs_due: null });
  });
});

describe('Undo under FSRS alone', () => {
  it('puts the word back as it was and moves the revision on, never back', async () => {
    const word = await addWord(alice, 'candid');
    const requestId = newId();
    await answer(alice, { ...remember(word.id, 0), requestId });

    const response = await call(app, alice, '/api/review-undo', {
      method: 'POST',
      body: { reviewRequestId: requestId, requestId: newId() },
    });
    expect(response.status).toBe(200);
    const body = reviewUndoResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ outcome: 'undone', pageId: word.id });
    expect(await stored(word.id)).toMatchObject({ fsrs_due: null, due_on: TODAY, revision: 2, mastery: 1 });
    expect((await queueOf(alice)).cards.map((card) => card.word)).toEqual(['candid']);

    // The answer cannot come back by being sent again.
    expect((await answer(alice, { ...remember(word.id, 0), requestId })).status).toBe(409);
  });

  it('takes back only the latest answer', async () => {
    const word = await addWord(alice, 'candid');
    const first = newId();
    await answer(alice, { ...remember(word.id, 0), requestId: first });
    await answer(alice, remember(word.id, 1, { allowNotDue: true }));
    const response = await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: first, requestId: newId() } });
    expect(response.status).toBe(409);
    expect(await stored(word.id)).toMatchObject({ revision: 2, fsrs_reps: 2 });
  });
});

describe('archiving', () => {
  it('takes words out of the queue in bulk and brings them back, without touching their FSRS state', async () => {
    const one = await addWord(alice, 'candid');
    const two = await addWord(alice, 'lucid');
    const archive = await call(app, alice, '/api/vocabulary/archive', { method: 'POST', body: { ids: [one.id, two.id], archived: true } });
    expect(archive.status).toBe(200);
    expect(((await archive.json()) as { archived: number }).archived).toBe(2);
    expect((await queueOf(alice)).cards).toEqual([]);

    const listed = vocabularyListResponseSchema.parse(await (await call(app, alice, '/api/vocabulary')).json()).entries;
    expect(listed.map((entry) => [entry.word, entry.reviewStatus, entry.suspended])).toEqual(
      expect.arrayContaining([
        ['candid', 'suspended', true],
        ['lucid', 'suspended', true],
      ]),
    );
    // An answer prepared before the archive is refused: the revision moved on.
    expect((await answer(alice, remember(one.id, 0))).status).toBe(409);

    await call(app, alice, '/api/vocabulary/archive', { method: 'POST', body: { ids: [one.id], archived: false } });
    expect((await queueOf(alice)).cards.map((card) => card.word)).toEqual(['candid']);
    expect(await stored(one.id)).toMatchObject({ suspended_at: null, revision: 2, fsrs_due: null });
  });

  it('cannot archive another account’s words', async () => {
    const word = await addWord(alice, 'candid');
    const response = await call(app, bob, '/api/vocabulary/archive', { method: 'POST', body: { ids: [word.id], archived: true } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { archived: number }).archived).toBe(0);
    expect(await stored(word.id)).toMatchObject({ suspended_at: null });
  });
});

describe('the version 15 file on a database with old data', () => {
  let old: TestDatabase;
  let owner: string;

  beforeAll(async () => {
    const migrations = readMigrations();
    const fifteen = migrations.findIndex((migration) => migration.name.endsWith('_fsrs_only.sql'));
    old = await createTestDatabase({ migrations: fifteen });
    owner = await old.createUser('owner@example.com');
    await old.admin(`insert into public.user_settings (user_id, time_zone) values ($1, 'Asia/Ho_Chi_Minh')`, [owner]);

    const add = (word: string, mastery: number, reviewDate: string | null) =>
      old.as(owner, (session) =>
        session.query<{ id: string }>(
          `select id from public.create_vocabulary($1, $1, $2::smallint, p_review_date => $3::date)`,
          [word, mastery, reviewDate],
        ),
      );
    await add('never-studied', 1, null);
    await add('dated-new', 1, '2026-10-12');
    await add('halfway', 5, '2026-10-20');
    await add('retired', 10, null);
    await add('overdue', 7, '2026-09-01');
    const [seen] = await add('already-fsrs', 4, '2026-10-15');
    await old.admin(
      `update public.card_states set fsrs_due = '2026-10-30T00:00:00Z', fsrs_stability = 12, fsrs_difficulty = 4,
         fsrs_state = 2, fsrs_reps = 3, fsrs_lapses = 0, fsrs_scheduled_days = 12, fsrs_learning_steps = 0,
         fsrs_last_review = '2026-10-18T00:00:00Z', fsrs_version = 'v5' where vocabulary_id = $1`,
      [seen!.id],
    );
    // A word at the starting mastery that has been answered once is studied, not new.
    const [answered] = await add('answered-once', 1, '2026-10-08');
    await old.admin(
      `insert into public.review_logs (user_id, vocabulary_id, request_id, action, reviewed_on, reviewed_at,
         mastery_before, mastery_after, review_date_before, review_date_after)
       values ($1, $2, gen_random_uuid(), 'not_remember', '2026-10-07', '2026-10-07T03:00:00Z', 1, 1, null, '2026-10-08')`,
      [owner, answered!.id],
    );

    await old.db.exec(migrations[fifteen]!.sql);
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  const card = async (word: string) =>
    (
      await old.admin(
        `select to_jsonb(c) || jsonb_build_object('due_epoch', extract(epoch from c.fsrs_due), 'last_epoch', extract(epoch from c.fsrs_last_review)) as row
           from public.card_states c join public.vocabulary v on v.id = c.vocabulary_id where v.word = $1`,
        [word],
      )
    )[0]!.row as Record<string, unknown>;

  it('leaves words never studied new, with their review day as the day they come up', async () => {
    expect(await card('never-studied')).toMatchObject({ fsrs_due: null, due_on: null, mastery: 1, revision: 0 });
    expect(await card('dated-new')).toMatchObject({ fsrs_due: null, due_on: '2026-10-12' });
  });

  it('estimates a state from mastery, due on the old review day at the start of that day in the reviewer’s zone', async () => {
    const halfway = await card('halfway');
    expect(halfway).toMatchObject({ fsrs_stability: 14, fsrs_difficulty: 5, fsrs_state: 2, fsrs_reps: 0, fsrs_lapses: 0, fsrs_version: 'legacy-mapped', due_on: null, mastery: 5 });
    // Midnight of 20 October in Ho Chi Minh City is 17:00 UTC the day before.
    expect(new Date(Number(halfway.due_epoch) * 1000).toISOString()).toBe('2026-10-19T17:00:00.000Z');
    // With no answer on record, the last review is one stability before the due time.
    expect((Number(halfway.due_epoch) - Number(halfway.last_epoch)) / 86400).toBeCloseTo(14, 5);
    expect(halfway.fsrs_scheduled_days).toBe(14);
  });

  it('gives a retired word the longest estimate and makes it due at once, without archiving it', async () => {
    const retired = await card('retired');
    expect(retired).toMatchObject({ fsrs_stability: 365, fsrs_version: 'legacy-mapped', suspended_at: null });
    expect(Number(retired.due_epoch)).toBeLessThanOrEqual(Date.now() / 1000 + 5);
  });

  it('keeps a past review day, so an overdue word is due at once', async () => {
    const overdue = await card('overdue');
    expect(overdue).toMatchObject({ fsrs_stability: 60 });
    expect(new Date(Number(overdue.due_epoch) * 1000).toISOString()).toBe('2026-08-31T17:00:00.000Z');
  });

  it('counts a word answered at the starting mastery as studied, from its last answer', async () => {
    const answered = await card('answered-once');
    expect(answered).toMatchObject({ fsrs_stability: 0.5, fsrs_version: 'legacy-mapped' });
    expect(new Date(Number(answered.last_epoch) * 1000).toISOString()).toBe('2026-10-07T03:00:00.000Z');
  });

  it('never touches a state FSRS already has', async () => {
    expect(await card('already-fsrs')).toMatchObject({ fsrs_stability: 12, fsrs_reps: 3, fsrs_version: 'v5', mastery: 4 });
  });

  it('can be run again without changing anything', async () => {
    const before = await old.admin('select * from public.card_states order by vocabulary_id');
    await old.db.exec(readMigrations().find((migration) => migration.name.endsWith('_fsrs_only.sql'))!.sql);
    const after = await old.admin('select * from public.card_states order by vocabulary_id');
    const withoutTouch = (rows: Array<Record<string, unknown>>) =>
      rows.map((row) => {
        const copy = { ...row };
        delete copy.updated_at;
        return copy;
      });
    expect(withoutTouch(after)).toEqual(withoutTouch(before));
  });
});

describe('the two daily goals', () => {
  const goalsOf = async (user: TestUser) =>
    studyGoalsResponseSchema.parse(await (await call(app, user, '/api/study-goals')).json());
  const setGoals = (user: TestUser, body: Record<string, unknown>) => call(app, user, '/api/study-goals', { method: 'PUT', body });
  const yesterday = '2026-10-08';

  it('suggests 10 new words and 30 reviews until goals are chosen, and records nothing before that', async () => {
    const goals = await goalsOf(alice);
    expect(goals).toMatchObject({ available: true, chosen: false, goals: { newWords: 10, reviews: 30, maintenanceMode: false } });
    expect(goals.streak).toEqual({ current: 0, longest: 0, metToday: false });
    expect(await db.admin('select * from public.study_days')).toEqual([]);
  });

  it('counts a word added today, meets the review goal when nothing is left to study, and starts a streak', async () => {
    expect((await setGoals(alice, { newWords: 1, reviews: 5 })).status).toBe(200);
    expect(await goalsOf(alice)).toMatchObject({ chosen: true, newWords: { done: 0, met: false }, streak: { current: 0 } });
    // Nothing at all to study yet, so five reviews are not needed today.
    expect((await goalsOf(alice)).reviews).toMatchObject({ target: 5, done: 0, met: true, exhausted: true });

    const word = await addWord(alice, 'candid');
    let goals = await goalsOf(alice);
    // The owner's rule (2026-10-22): adding the word is what counts, not studying it.
    expect(goals.newWords).toEqual({ target: 1, done: 1, remaining: 0, met: true, exhausted: false });
    // The owner's rule (2026-10-23): the new word is still waiting, so the review goal is open again.
    expect(goals.reviews).toMatchObject({ target: 5, done: 0, met: false, exhausted: false });
    expect(goals.streak).toEqual({ current: 0, longest: 0, metToday: false });

    await answer(alice, remember(word.id, 0));
    goals = await goalsOf(alice);
    expect(goals.reviews).toMatchObject({ target: 5, done: 0, met: true, exhausted: true });
    expect(goals.streak).toEqual({ current: 1, longest: 1, metToday: true });
  });

  it('reopens a review goal met by running out, when a word is added before it is reached', async () => {
    await setGoals(alice, { newWords: 1, reviews: 5 });
    const first = await addWord(alice, 'candid');
    await answer(alice, remember(first.id, 0));
    expect((await goalsOf(alice)).reviews.met).toBe(true);

    await addWord(alice, 'lucid');
    const goals = await goalsOf(alice);
    expect(goals.reviews).toMatchObject({ done: 0, remaining: 5, met: false, exhausted: false });
    // The day was already met, and a met day stays met for the streak.
    expect(goals.streak).toMatchObject({ current: 1, metToday: true });
  });

  it('counts only due words as reviews, not words taken early', async () => {
    await setGoals(alice, { newWords: 1, reviews: 1 });
    const due = await addWord(alice, 'candid');
    const early = await addWord(alice, 'lucid');
    await answer(alice, remember(due.id, 0));
    await answer(alice, remember(early.id, 0));
    // Make one of them due again today, as if its day had come.
    await db.admin(`update public.card_states set fsrs_due = '2026-10-08T00:00:00Z' where vocabulary_id = $1`, [due.id]);
    await answer(alice, remember(due.id, 1));
    await answer(alice, remember(early.id, 1, { allowNotDue: true }));
    const goals = await goalsOf(alice);
    expect(goals.newWords.done).toBe(2);
    expect(goals.reviews.done).toBe(1);
  });

  it('keeps a met day met, even after the word that met it is deleted', async () => {
    await setGoals(alice, { newWords: 1, reviews: 1 });
    const word = await addWord(alice, 'candid');
    await answer(alice, remember(word.id, 0));
    expect((await goalsOf(alice)).streak.metToday).toBe(true);
    await call(app, alice, `/api/vocabulary/${word.id}`, { method: 'DELETE' });
    const goals = await goalsOf(alice);
    expect(goals.newWords.done).toBe(0);
    expect(goals.streak).toMatchObject({ current: 1, metToday: true });
  });

  it('counts the streak back over met days, and keeps it from yesterday until today is met', async () => {
    await setGoals(alice, { newWords: 1, reviews: 1 });
    for (const day of ['2026-10-06', '2026-10-07', yesterday]) {
      await db.admin(
        `insert into public.study_days (user_id, day, new_words, reviews, new_goal, review_goal, met) values ($1, $2, 1, 1, 1, 1, true)`,
        [alice.id, day],
      );
    }
    // Nothing added today, so today is not met yet and the streak stands from yesterday.
    expect((await goalsOf(alice)).streak).toEqual({ current: 3, longest: 3, metToday: false });
    // Another account has a streak of its own.
    expect((await goalsOf(bob)).streak.current).toBe(0);
  });

  it('lets the new-word goal be 0 only in maintenance mode', async () => {
    const refused = await setGoals(alice, { newWords: 0, reviews: 30 });
    expect(refused.status).toBe(400);
    expect(apiErrorSchema.parse(await refused.json()).error.message).toContain('maintenance mode');
    const maintenance = await setGoals(alice, { newWords: 0, reviews: 30, maintenanceMode: true });
    expect(maintenance.status).toBe(200);
    expect(studyGoalsResponseSchema.parse(await maintenance.json()).newWords).toMatchObject({ target: 0, met: true });
  });

  it('records the day as soon as it is completed, without the goals being opened', async () => {
    await setGoals(alice, { newWords: 1, reviews: 1 });
    const word = await addWord(alice, 'candid');
    const recorded = () => db.admin('select day::text as day, met from public.study_days where user_id = $1', [alice.id]);
    // Added but not studied yet: the review goal is still open.
    expect(await recorded()).toEqual([{ day: TODAY, met: false }]);
    await answer(alice, remember(word.id, 0));
    expect(await recorded()).toEqual([{ day: TODAY, met: true }]);
  });

  it('counts a spread-out import by the day its words are added, not the day they first come up', async () => {
    await setGoals(alice, { newWords: 3, reviews: 1 });
    const response = await call(app, alice, '/api/vocabulary/import', {
      method: 'POST',
      body: { items: ['one', 'two', 'three'].map((word) => ({ requestId: newId(), word })), wordsPerDay: 1 },
    });
    expect(response.status).toBe(200);
    expect((await goalsOf(alice)).newWords).toMatchObject({ done: 3, met: true });
  });

});

describe('the daily review limit', () => {
  /** Three words answered once, then all made due again, earliest first. */
  async function threeDue(user: TestUser) {
    const words = [];
    for (const [index, name] of ['first', 'second', 'third'].entries()) {
      const word = await addWord(user, name);
      await answer(user, remember(word.id, 0));
      await db.admin(`update public.card_states set fsrs_due = $2 where vocabulary_id = $1`, [word.id, `2026-10-0${index + 1}T00:00:00Z`]);
      words.push(word);
    }
    return words;
  }

  it('shows everything due until a limit is set', async () => {
    await threeDue(alice);
    const queue = await queueOf(alice);
    expect(queue.cards.map((card) => card.word)).toEqual(['first', 'second', 'third']);
    expect(queue.heldBack).toBe(0);
  });

  it('offers only the earliest-due reviews up to what is left of the limit, and never holds back a new word', async () => {
    const words = await threeDue(alice);
    await addWord(alice, 'brand-new');
    await call(app, alice, '/api/settings', { method: 'PUT', body: { maxReviewsPerDay: 2 } });

    const queue = await queueOf(alice);
    expect(queue.cards.map((card) => card.word)).toEqual(['first', 'second', 'brand-new']);
    expect(queue.heldBack).toBe(1);

    // One of today's two is used up by a review; one more is offered.
    await answer(alice, remember(words[0]!.id, 1));
    const later = await queueOf(alice);
    expect(later.cards.map((card) => card.word)).toEqual(['second', 'brand-new']);
    expect(later.heldBack).toBe(1);
  });
});

describe('weak words under FSRS alone', () => {
  /** Gives a word an FSRS state directly: last reviewed `daysAgo` before now, with this stability and lapses. */
  async function setState(id: string, stability: number, daysAgo: number, lapses = 0) {
    const last = new Date(Date.parse('2026-10-09T05:00:00Z') - daysAgo * 86_400_000).toISOString();
    const due = new Date(Date.parse(last) + stability * 86_400_000).toISOString();
    await db.admin(
      `update public.card_states set fsrs_due = $2, fsrs_stability = $3, fsrs_difficulty = 5, fsrs_state = 2, fsrs_reps = 3,
         fsrs_lapses = $4, fsrs_scheduled_days = $5, fsrs_learning_steps = 0, fsrs_last_review = $6, fsrs_version = 'test',
         due_on = null where vocabulary_id = $1`,
      [id, due, stability, lapses, Math.round(stability), last],
    );
  }

  it('lists the lowest estimated recall first, gives strength not mastery, and leaves archived words out', async () => {
    // Words added with a meaning only, so each has something against it (no definition or example).
    const fresh = await addWord(alice, 'fresh');
    const fading = await addWord(alice, 'fading');
    const lapsed = await addWord(alice, 'lapsed');
    const archived = await addWord(alice, 'archived');
    await addWord(alice, 'unseen');
    await setState(fresh.id, 30, 1);
    await setState(fading.id, 3, 20);
    await setState(lapsed.id, 30, 1, 4);
    await setState(archived.id, 2, 40);
    await call(app, alice, '/api/vocabulary/archive', { method: 'POST', body: { ids: [archived.id], archived: true } });

    const weak = weakWordsResponseSchema.parse(await (await call(app, alice, '/api/weak-words')).json());
    // fresh and lapsed have the same recall: the one that lapsed more comes first. unseen has no estimate.
    expect(weak.words.map((word) => word.word)).toEqual(['fading', 'lapsed', 'fresh', 'unseen']);
    expect(weak.words.find((word) => word.word === 'fresh')?.mastery).toBe(6);

    // The weakest-words review takes them in the same order.
    const queue = queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue?focus=weak')).json());
    expect(queue.cards.map((card) => card.word)).toEqual(['fading', 'lapsed', 'fresh', 'unseen']);
  });
});

describe('editing a word under FSRS alone', () => {
  it('saves its text, and refuses a schedule set by hand rather than dropping it', async () => {
    const word = await addWord(alice, 'candid');
    const text = await call(app, alice, `/api/vocabulary/${word.id}`, { method: 'PATCH', body: { definition: 'Honest.' } });
    expect(text.status).toBe(200);
    expect(entryResponseSchema.parse(await text.json()).entry.definition).toBe('Honest.');

    const schedule = await call(app, alice, `/api/vocabulary/${word.id}`, {
      method: 'PATCH',
      body: { meaning: 'thẳng', schedule: { mastery: 8, reviewDate: '2026-12-01' } },
    });
    expect(schedule.status).toBe(409);
    expect(apiErrorSchema.parse(await schedule.json()).error.code).toBe('not_editable');
    // Nothing of that request was saved, the text included.
    expect(await stored(word.id)).toMatchObject({ mastery: 1, revision: 0 });
    const after = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${word.id}`)).json()).entry;
    expect(after.meaning).toBe('nghĩa');
  });
});
