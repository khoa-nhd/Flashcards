/**
 * The game (schema version 17) through the real routes, account sessions,
 * schema and Row Level Security: XP in the reply to each answer, the game as
 * the dashboard reads it, claiming rewards, and the signed change that keeps
 * the XP the server's own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  entryResponseSchema,
  gameResponseSchema,
  practiceResponseSchema,
  reviewActionResponseSchema,
  reviewUndoResponseSchema,
  studyGoalsResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { RATE_LIMIT } from '../../shared/gamification/xp.js';
import { TODAY } from '../helpers/fixtures.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const KEY = 'k'.repeat(64);

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
  await db.admin('delete from public.game_signing_key');
  await db.admin('insert into public.game_signing_key (key) values ($1)', [KEY]);
  alice = await createTestUser(db, 'alice');
  bob = await createTestUser(db, 'bob');
  app = createSupabaseTestApp(db, [alice, bob], { env: { GAME_SIGNING_KEY: KEY } });
});

async function addWord(user: TestUser, word: string): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), word, meaning: 'nghĩa' } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

/**
 * Waits as a reviewer would between two answers: one less than 600 ms after
 * the last earns nothing (version 18), and a test answers faster than anyone can.
 */
const later = () => new Promise((resolve) => setTimeout(resolve, RATE_LIMIT.minGapMs + 50));

const answer = async (user: TestUser, id: string, revision: number, extra: Record<string, unknown> = {}) => {
  await later();
  const requestId = newId();
  const response = await call(app, user, '/api/review-action', {
    method: 'POST',
    body: { requestId, pageId: id, action: 'remember', expected: { mastery: 1, nextReview: TODAY }, expectedRevision: revision, ...extra },
  });
  expect(response.status).toBe(200);
  return { requestId, reply: reviewActionResponseSchema.parse(await response.json()) };
};

const gameOf = async (user: TestUser) => gameResponseSchema.parse(await (await call(app, user, '/api/game')).json());

describe('XP for answers', () => {
  it('replies to each answer with what it earned, and keeps the total', async () => {
    const word = await addWord(alice, 'candid');
    const { reply } = await answer(alice, word.id, 0);
    // A word studied for the first time: 15, and 2 for having added it.
    expect(reply.game).toMatchObject({ xp: 17, totalXp: 17, level: 1, combo: 1 });

    const game = await gameOf(alice);
    expect(game).toMatchObject({ available: true, totalXp: 17, level: { level: 1, into: 17, needed: 100 } });
    expect(game.quests.day).toHaveLength(3);
    expect(game.quests.week).not.toBeNull();
    // The first answer of the day is the day's check-in, waiting to be claimed.
    expect(game.rewards.map((reward) => reward.kind)).toContain('checkin');
    expect(await gameOf(bob)).toMatchObject({ totalXp: 0 });
  });

  it('gives practice its own XP, and takes an answer back with its XP', async () => {
    const word = await addWord(alice, 'candid');
    const { requestId } = await answer(alice, word.id, 0);

    await later();
    const practice = await call(app, alice, '/api/practice', {
      method: 'POST',
      body: { requestId: newId(), pageId: word.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } },
    });
    expect(practiceResponseSchema.parse(await practice.json()).game).toMatchObject({ xp: 5, totalXp: 22 });

    const undo = await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: requestId, requestId: newId() } });
    expect(reviewUndoResponseSchema.parse(await undo.json()).game).toMatchObject({ xp: -17, totalXp: 5 });
  });

  it('counts answers saved before the game was set up, without bonuses', async () => {
    const word = await addWord(alice, 'candid');
    // An answer saved while the game could not be kept: the reply has no XP.
    await db.admin('delete from public.game_signing_key');
    const { reply } = await answer(alice, word.id, 0);
    expect(reply.outcome).toBe('applied');
    expect(reply.game).toBeUndefined();

    await db.admin('insert into public.game_signing_key (key) values ($1)', [KEY]);
    expect(await gameOf(alice)).toMatchObject({ totalXp: 17 });
  });
});

describe('claiming rewards', () => {
  it('adds a reward’s XP once, however often it is claimed', async () => {
    const word = await addWord(alice, 'candid');
    await answer(alice, word.id, 0);
    const checkin = (await gameOf(alice)).rewards.find((reward) => reward.kind === 'checkin')!;
    expect(checkin.payload).toMatchObject({ day: 1, xp: 10 });

    const claimed = gameResponseSchema.parse(
      await (await call(app, alice, '/api/game/claim', { method: 'POST', body: { ids: [checkin.id] } })).json(),
    );
    expect(claimed.totalXp).toBe(27);
    expect(claimed.rewards.some((reward) => reward.id === checkin.id)).toBe(false);

    await call(app, alice, '/api/game/claim', { method: 'POST', body: { ids: [checkin.id] } });
    expect((await gameOf(alice)).totalXp).toBe(27);
  });

  it('cannot claim another account’s reward', async () => {
    const word = await addWord(alice, 'candid');
    await answer(alice, word.id, 0);
    const checkin = (await gameOf(alice)).rewards.find((reward) => reward.kind === 'checkin')!;
    await call(app, bob, '/api/game/claim', { method: 'POST', body: { ids: [checkin.id] } });
    expect((await gameOf(alice)).rewards.some((reward) => reward.id === checkin.id)).toBe(true);
    expect((await gameOf(bob)).totalXp).toBe(0);
  });
});

describe('the streak and its freezes', () => {
  it('keeps the streak over a missed day with a freeze held', async () => {
    await call(app, alice, '/api/study-goals', { method: 'PUT', body: { newWords: 1, reviews: 1, practice: 0 } });
    for (const day of ['2026-10-06', '2026-10-07']) {
      await db.admin(
        `insert into public.study_days (user_id, day, new_words, reviews, new_goal, review_goal, practice_goal, met) values ($1, $2, 1, 1, 1, 1, 0, true)`,
        [alice.id, day],
      );
    }
    // Yesterday was missed. Without a freeze, the streak is gone.
    expect(studyGoalsResponseSchema.parse(await (await call(app, alice, '/api/study-goals')).json()).streak.current).toBe(0);

    await db.admin(`insert into public.game_freezes (id, user_id, granted_on) values ($1, $2, '2026-10-01')`, [newId(), alice.id]);
    const goals = studyGoalsResponseSchema.parse(await (await call(app, alice, '/api/study-goals')).json());
    expect(goals.streak.current).toBe(2);
    expect(await db.admin('select used_on::text as used from public.game_freezes')).toEqual([{ used: '2026-10-08' }]);
    const game = await gameOf(alice);
    expect(game.freezes).toEqual({ held: 0, max: 2 });
    expect(game.rewards.find((reward) => reward.kind === 'freeze_used')?.payload).toEqual({ days: ['2026-10-08'] });
  });
});

describe('review early and random review', () => {
  const queue = async (user: TestUser, query: string) => {
    const response = await call(app, user, `/api/review-queue?${query}`);
    return { status: response.status, body: (await response.json()) as { focus?: string | null; cards?: Array<{ id: string }> } };
  };

  it('takes words coming up within the days chosen, and studied words at random', async () => {
    const studied = await addWord(alice, 'candid');
    const fresh = await addWord(alice, 'lucid');
    await answer(alice, studied.id, 0);

    // The answered word now comes up in a few days, well within two weeks.
    const soon = await queue(alice, 'focus=early&days=14');
    expect(soon.status).toBe(200);
    expect(soon.body.focus).toBe('early');
    expect(soon.body.cards?.map((card) => card.id)).toEqual([studied.id]);

    const random = await queue(alice, 'focus=random');
    expect(random.body.focus).toBe('random');
    // Only words already studied: the new one is not taken at random.
    expect(random.body.cards?.map((card) => card.id)).toEqual([studied.id]);
    expect(random.body.cards?.some((card) => card.id === fresh.id)).toBe(false);

    expect((await queue(alice, 'focus=early&days=30')).status).toBe(400);
    // Bob's queue knows nothing of Alice's words.
    expect((await queue(bob, 'focus=random')).body.cards).toEqual([]);
  });

  it('counts an early review toward the schedule at 5 XP', async () => {
    const word = await addWord(alice, 'candid');
    await answer(alice, word.id, 0);
    const soon = await queue(alice, 'focus=early&days=14');
    expect(soon.body.cards).toHaveLength(1);
    const { reply } = await answer(alice, word.id, 1, { allowNotDue: true });
    expect(reply.game).toMatchObject({ xp: 5 });
    expect(Number((await db.admin<{ revision: number }>('select revision from public.card_states where vocabulary_id = $1', [word.id]))[0]!.revision)).toBe(2);
  });
});

describe('when the game cannot be kept', () => {
  it('says why, and answers are saved as ever', async () => {
    const plain = createSupabaseTestApp(db, [alice], {});
    const game = gameResponseSchema.parse(await (await call(plain, alice, '/api/game')).json());
    expect(game).toMatchObject({ available: false, reason: expect.stringContaining('GAME_SIGNING_KEY') });

    const word = entryResponseSchema.parse(
      await (await call(plain, alice, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), word: 'lucid', meaning: 'x' } })).json(),
    ).entry;
    const response = await call(plain, alice, '/api/review-action', {
      method: 'POST',
      body: { requestId: newId(), pageId: word.id, action: 'remember', expected: { mastery: 1, nextReview: TODAY }, expectedRevision: 0 },
    });
    expect(reviewActionResponseSchema.parse(await response.json())).toMatchObject({ outcome: 'applied' });
  });

  it('keeps answering when the server key does not match the database one', async () => {
    const wrong = createSupabaseTestApp(db, [alice], { env: { GAME_SIGNING_KEY: 'w'.repeat(64) } });
    const word = await addWord(alice, 'candid');
    const response = await call(wrong, alice, '/api/review-action', {
      method: 'POST',
      body: { requestId: newId(), pageId: word.id, action: 'remember', expected: { mastery: 1, nextReview: TODAY }, expectedRevision: 0 },
    });
    const reply = reviewActionResponseSchema.parse(await response.json());
    expect(reply.outcome).toBe('applied');
    expect(reply.game).toBeUndefined();
    expect(await db.admin('select * from public.xp_ledger')).toEqual([]);

    // The daily goals still answer, with the freezes already spent.
    await db.admin(`insert into public.game_freezes (id, user_id, granted_on, used_on) values ($1, $2, '2026-10-01', '2026-10-08')`, [
      newId(),
      alice.id,
    ]);
    const goals = await call(wrong, alice, '/api/study-goals');
    expect(goals.status).toBe(200);
  });
});
