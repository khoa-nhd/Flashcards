/**
 * Practice mastery, through the HTTP API on the real schema: one point per
 * correct practice answer in a mode, up to ten, counted from the practice
 * history itself. It must never reach a word's review mastery, review date
 * or FSRS state, and reviewing must never reach it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { practiceOutcomeOf } from '../../server/supabase/supabase-database.js';
import {
  entryResponseSchema,
  practiceMasteryResponseSchema,
  practiceResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { PRACTICE_MASTERY_MAX, STUDY_MODES, practiceMasteryOf, type StudyMode } from '../../shared/study-modes.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const TODAY = '2026-10-09';

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
  app = createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${TODAY}T05:00:00Z`) });
});

async function addWord(user: TestUser, input: Record<string, unknown>, on: TestApp = app): Promise<VocabularyEntry> {
  const response = await call(on, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

const candidOf = (user: TestUser, on: TestApp = app) =>
  addWord(user, { word: 'candid', meaning: 'thẳng thắn', example: 'A candid answer.', mastery: 3, reviewDate: TODAY }, on);

/** One typed practice answer; right when `text` is the word. */
async function typed(user: TestUser, word: VocabularyEntry, text: string, mode: StudyMode = 'typing', requestId = newId()) {
  const response = await call(app, user, '/api/practice', {
    method: 'POST',
    body: { pageId: word.id, mode, answer: { kind: 'typed', text }, requestId },
  });
  expect(response.status).toBe(200);
  return practiceResponseSchema.parse(await response.json());
}

const masteryOf = async (user: TestUser, id: string, on: TestApp = app) =>
  practiceMasteryResponseSchema.parse(await (await call(on, user, `/api/vocabulary/${id}/practice-mastery`)).json());

/** `{ typing: 2, … }` for the modes that are above zero. */
const scores = async (user: TestUser, id: string) =>
  Object.fromEntries((await masteryOf(user, id)).modes.filter((mode) => mode.mastery > 0).map((mode) => [mode.mode, mode.mastery]));

/** Everything about a word's schedule, as the database holds it. */
const scheduleOf = (id: string) =>
  db.admin(
    `select mastery, review_date::text as review_date, fsrs_due, fsrs_stability, fsrs_difficulty, fsrs_reps, fsrs_lapses,
            fsrs_state, updated_at
       from public.card_states where vocabulary_id = $1`,
    [id],
  );

describe('the rule', () => {
  it('is one point per correct answer, never more than the ceiling', () => {
    expect([0, 1, 2, 9, 10, 11, 250].map(practiceMasteryOf)).toEqual([0, 1, 2, 3, 3, 3, 3]);
    expect(PRACTICE_MASTERY_MAX).toBe(3);
  });

  it('is zero for anything that is not a count', () => {
    expect([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.9].map(practiceMasteryOf)).toEqual([0, 0, 0, 0]);
    expect(practiceMasteryOf(3.7)).toBe(3);
  });
});

describe('a word’s practice mastery', () => {
  it('starts at zero in every mode', async () => {
    const word = await candidOf(alice);
    expect(await masteryOf(alice, word.id)).toEqual({
      available: true,
      max: 3,
      modes: STUDY_MODES.map((mode) => ({ mode, correct: 0, mastery: 0 })),
    });
  });

  it('goes up by one for a correct answer, and the reply to that answer says where it now stands', async () => {
    const word = await candidOf(alice);
    expect(await typed(alice, word, 'candid')).toMatchObject({ outcome: 'recorded', correct: true, modeMastery: 1 });
    expect(await typed(alice, word, 'Candid')).toMatchObject({ correct: true, modeMastery: 2 });
    expect(await scores(alice, word.id)).toEqual({ typing: 2 });
  });

  it('is left exactly where it was by a wrong answer', async () => {
    const word = await candidOf(alice);
    await typed(alice, word, 'candid');
    expect(await typed(alice, word, 'candit')).toMatchObject({ outcome: 'recorded', correct: false, modeMastery: 1 });
    expect(await typed(alice, word, 'nothing like it')).toMatchObject({ correct: false, modeMastery: 1 });
    expect(await scores(alice, word.id)).toEqual({ typing: 1 });
  });

  it('is kept separately for each mode', async () => {
    const word = await candidOf(alice);
    await typed(alice, word, 'candid', 'typing');
    await typed(alice, word, 'candid', 'typing');
    await typed(alice, word, 'candid', 'cloze');
    await typed(alice, word, 'candid', 'listening');
    expect(await scores(alice, word.id)).toEqual({ typing: 2, cloze: 1, listening: 1 });
  });

  it('stops at three, however many more correct answers follow', async () => {
    const word = await candidOf(alice);
    let last = 0;
    for (let answer = 1; answer <= 12; answer += 1) last = (await typed(alice, word, 'candid')).modeMastery ?? -1;
    expect(last).toBe(3);
    const typing = (await masteryOf(alice, word.id)).modes.find((mode) => mode.mode === 'typing');
    // The count behind it is kept as it is; only the score stops.
    expect(typing).toEqual({ mode: 'typing', correct: 12, mastery: 3 });
  });

  it('counts an answer that was sent twice only once', async () => {
    const word = await candidOf(alice);
    const requestId = newId();
    expect(await typed(alice, word, 'candid', 'typing', requestId)).toMatchObject({ outcome: 'recorded', modeMastery: 1 });
    expect(await typed(alice, word, 'candid', 'typing', requestId)).toMatchObject({ outcome: 'already_recorded', modeMastery: 1 });
    expect(await scores(alice, word.id)).toEqual({ typing: 1 });
  });

  it('follows the practice history: it is a count of it, not a second number that could disagree', async () => {
    const word = await candidOf(alice);
    await typed(alice, word, 'candid');
    await typed(alice, word, 'wrong');
    await typed(alice, word, 'candid');
    const recorded = await db.admin<{ correct: number }>(
      `select count(*)::int as correct from public.review_logs
        where vocabulary_id = $1 and kind = 'practice' and review_mode = 'typing' and answer_correct`,
      [word.id],
    );
    expect((await scores(alice, word.id)).typing).toBe(recorded[0]!.correct);
    // And nothing new is stored for it anywhere.
    const tables = await db.admin<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name like '%mastery%'`,
    );
    expect(tables).toEqual([]);
  });
});

describe('practice mastery and the review schedule', () => {
  it('never touches review mastery, the review date or FSRS, whatever it reaches', async () => {
    const word = await candidOf(alice);
    const before = await scheduleOf(word.id);
    for (let answer = 0; answer < 11; answer += 1) await typed(alice, word, 'candid');
    await typed(alice, word, 'wrong');
    expect(await scheduleOf(word.id)).toEqual(before);
    const entry = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${word.id}`)).json()).entry;
    expect(entry).toMatchObject({ mastery: 3, reviewDate: TODAY, reviewStatus: 'due_today' });
  });

  it('is not moved by reviewing the word', async () => {
    const word = await candidOf(alice);
    await typed(alice, word, 'candid');
    const reviewed = await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: word.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY }, requestId: newId() },
    });
    expect(reviewed.status).toBe(200);
    expect(await scores(alice, word.id)).toEqual({ typing: 1 });
  });

  it('is not moved by editing the word’s review mastery by hand', async () => {
    const word = await candidOf(alice);
    await typed(alice, word, 'candid');
    const edited = await call(app, alice, `/api/vocabulary/${word.id}`, {
      method: 'PATCH',
      body: { schedule: { mastery: 9, reviewDate: TODAY } },
    });
    expect(edited.status).toBe(200);
    expect(await scores(alice, word.id)).toEqual({ typing: 1 });
  });
});

describe('whose it is', () => {
  it('is read only by the account that owns the word', async () => {
    const word = await candidOf(alice);
    await typed(alice, word, 'candid');
    const stranger = await call(app, bob, `/api/vocabulary/${word.id}/practice-mastery`);
    expect(stranger.status).toBe(404);
    expect(JSON.stringify(await stranger.json())).not.toContain('typing');
  });

  it('is counted per account: the same word in two vocabularies shares nothing', async () => {
    const mine = await candidOf(alice);
    const theirs = await candidOf(bob);
    await typed(alice, mine, 'candid');
    await typed(alice, mine, 'candid');
    await typed(bob, theirs, 'candid');
    expect(await scores(alice, mine.id)).toEqual({ typing: 2 });
    expect(await scores(bob, theirs.id)).toEqual({ typing: 1 });
  });

  it('needs an account, a real word and a well-formed id', async () => {
    const word = await candidOf(alice);
    expect((await call(app, null, `/api/vocabulary/${word.id}/practice-mastery`)).status).toBe(401);
    expect((await call(app, alice, `/api/vocabulary/${newId()}/practice-mastery`)).status).toBe(404);
    expect((await call(app, alice, '/api/vocabulary/not-an-id/practice-mastery')).status).toBe(400);
  });

  it('is gone with a word in the trash, and back when the word is restored', async () => {
    const word = await candidOf(alice);
    await typed(alice, word, 'candid');
    await call(app, alice, `/api/vocabulary/${word.id}`, { method: 'DELETE' });
    expect((await call(app, alice, `/api/vocabulary/${word.id}/practice-mastery`)).status).toBe(404);
    await call(app, alice, `/api/vocabulary/${word.id}/restore`, { method: 'POST' });
    expect(await scores(alice, word.id)).toEqual({ typing: 1 });
  });
});

describe('where practice is not recorded', () => {
  it('reports no score, and counts nothing, while saving is switched off', async () => {
    const word = await candidOf(alice);
    const frozen = createSupabaseTestApp(db, [alice], { env: { REVIEW_WRITES_ENABLED: 'false' } });
    const response = await call(frozen, alice, '/api/practice', {
      method: 'POST',
      body: { pageId: word.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' }, requestId: newId() },
    });
    expect(practiceResponseSchema.parse(await response.json())).toMatchObject({ outcome: 'dry_run', correct: true, modeMastery: null });
    expect(await scores(alice, word.id)).toEqual({});
  });

  describe('a database from before practice was recorded (version 5)', () => {
    let old: TestDatabase;
    let owner: TestUser;
    let legacy: TestApp;

    beforeAll(async () => {
      old = await createTestDatabase({ migrations: 5 });
    }, 60_000);

    afterAll(async () => {
      await old.close();
    });

    beforeEach(async () => {
      await old.admin('delete from auth.users');
      owner = await createTestUser(old, 'owner');
      legacy = createSupabaseTestApp(old, [owner]);
    });

    it('says so instead of showing zeros as if they had been earned', async () => {
      const word = await candidOf(owner, legacy);
      expect(await masteryOf(owner, word.id, legacy)).toEqual({ available: false, max: 3, modes: [] });
    });
  });
});

describe('reading what the database answered to a practice answer', () => {
  it('takes the outcome however a one-column result is handed back', () => {
    expect(practiceOutcomeOf([{ outcome: 'recorded' }])).toBe('recorded');
    expect(practiceOutcomeOf({ outcome: 'already_recorded' })).toBe('already_recorded');
    expect(practiceOutcomeOf(['not_found'])).toBe('not_found');
    expect(practiceOutcomeOf('recorded')).toBe('recorded');
  });

  it('accepts nothing else as a confirmation', () => {
    for (const other of [null, undefined, [], [{}], [{ outcome: 'saved' }], 'ok', 1, true, [null]]) {
      expect(practiceOutcomeOf(other)).toBeNull();
    }
  });
});
