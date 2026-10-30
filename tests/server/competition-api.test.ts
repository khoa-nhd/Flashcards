/**
 * Competition (schema version 18) through the real routes, account sessions,
 * schema and Row Level Security: a nickname on first visit, a league group of
 * twenty with the empty seats filled, friends by nickname, challenges, and
 * moderation that needs both ADMIN_EMAILS and the database's list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  entryResponseSchema,
  friendsResponseSchema,
  leagueResponseSchema,
  profileResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { calendarDateInTimeZone } from '../../shared/dates.js';
import { loadConfig } from '../../server/env.js';
import { SUPABASE_ENV, call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
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
  await db.admin('delete from public.league_groups');
  await db.admin('delete from public.game_signing_key');
  await db.admin('insert into public.game_signing_key (key) values ($1)', [KEY]);
  alice = await createTestUser(db, 'alice');
  bob = await createTestUser(db, 'bob');
  // League weeks are counted from when the database records XP, so these tests run on the real clock.
  app = createSupabaseTestApp(db, [alice, bob], {
    env: { GAME_SIGNING_KEY: KEY, ADMIN_EMAILS: 'alice@example.com' },
    now: () => new Date(),
  });
});

async function addWord(user: TestUser, word: string): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', {
    method: 'POST',
    body: { requestId: newId(), word, meaning: 'nghĩa' },
  });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

const study = async (user: TestUser) => {
  const word = await addWord(user, `word${newId().slice(0, 6)}`);
  const response = await call(app, user, '/api/review-action', {
    method: 'POST',
    body: {
      requestId: newId(),
      pageId: word.id,
      action: 'remember',
      expected: {
        mastery: 1,
        nextReview: calendarDateInTimeZone(new Date(), loadConfig(SUPABASE_ENV).timeZone ?? 'UTC'),
      },
      expectedRevision: 0,
    },
  });
  expect(response.status).toBe(200);
};

const league = async (user: TestUser) => leagueResponseSchema.parse(await (await call(app, user, '/api/league')).json());
const profile = async (user: TestUser, nickname?: string) => {
  const response = await call(app, user, nickname === undefined ? '/api/profile' : `/api/profile?u=${encodeURIComponent(nickname)}`);
  return { status: response.status, body: (await response.json()) as unknown };
};
const post = (user: TestUser, path: string, body: unknown = {}) => call(app, user, path, { method: 'POST', body });
const rename = (user: TestUser, nickname: string) => call(app, user, '/api/profile', { method: 'PUT', body: { nickname } });

describe('nicknames', () => {
  it('gives a random nickname on the first visit, and keeps it', async () => {
    const first = profileResponseSchema.parse((await profile(alice)).body);
    expect(first.nickname).toMatch(/^\S.* \d{4}$/);
    expect(profileResponseSchema.parse((await profile(alice)).body).nickname).toBe(first.nickname);
  });

  it('refuses a taken, rude or malformed nickname, and says why', async () => {
    expect((await rename(alice, 'Moon Owl')).status).toBe(200);
    const taken = await rename(bob, 'moon owl');
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ problem: 'taken' });
    for (const [nickname, problem] of [
      ['ab', 'length'],
      ['bad<script>', 'characters'],
      ['Fuuuck you', 'blocked'],
      ['Đồ lồn', 'blocked'],
    ] as const) {
      const response = await rename(bob, nickname);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ problem });
    }
    // A Vietnamese word that only looks like a swear word without its accents is fine.
    expect((await rename(bob, 'Cá Lớn')).status).toBe(200);
  });
});

describe('the league', () => {
  it('has no group before the week’s first XP, then twenty seats with the account among them', async () => {
    const before = await league(alice);
    expect(before).toMatchObject({ available: true, group: null, tier: 1 });

    await study(alice);
    const after = await league(alice);
    expect(after.weekXp).toBeGreaterThan(0);
    expect(after.group?.rows).toHaveLength(20);
    const mine = after.group!.rows.filter((row) => row.me);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.xp).toBe(after.weekXp);
    // Ranked by XP, with the top five going up and Bronze never going down.
    const ranks = after.group!.rows.map((row) => row.rank);
    expect(ranks).toEqual(Array.from({ length: 20 }, (_, at) => at + 1));
    expect(after.group!.rows.slice(0, 5).every((row) => row.zone === 'up')).toBe(true);
    expect(after.group!.rows.some((row) => row.zone === 'down')).toBe(false);
  });

  it('puts a second account in the same group, still twenty seats', async () => {
    await study(alice);
    await study(bob);
    // Each joins on opening the league with XP this week.
    await league(alice);
    const other = (await league(bob)).nickname;
    const board = await league(alice);
    expect(board.group?.rows).toHaveLength(20);
    expect(board.group!.rows.filter((row) => row.nickname === other)).toHaveLength(1);
  });

  it('shows the same rivals with the same XP each time it is read', async () => {
    await study(alice);
    const first = (await league(alice)).group!.rows.filter((row) => !row.me);
    const second = (await league(alice)).group!.rows.filter((row) => !row.me);
    expect(second).toEqual(first);
  });

  it('shows a rival in one’s league as a player who keeps their profile private', async () => {
    await study(alice);
    const rival = (await league(alice)).group!.rows.find((row) => !row.me)!;
    const shown = await profile(alice, rival.nickname!);
    expect(shown.status).toBe(200);
    expect(profileResponseSchema.parse(shown.body)).toMatchObject({
      nickname: rival.nickname,
      limited: true,
      me: false,
    });
    // Someone outside the league finds no such player.
    expect((await profile(bob, rival.nickname!)).status).toBe(404);
  });
});

describe('the end of a league week', () => {
  it('settles the week on the first look after it ends, once, with a result waiting to be claimed', async () => {
    let clock = new Date();
    const later = createSupabaseTestApp(db, [alice, bob], {
      env: { GAME_SIGNING_KEY: KEY },
      now: () => clock,
    });
    const answerToday = calendarDateInTimeZone(new Date(), loadConfig(SUPABASE_ENV).timeZone ?? 'UTC');
    const word = entryResponseSchema.parse(
      await (
        await call(later, alice, '/api/vocabulary', {
          method: 'POST',
          body: { requestId: newId(), word: 'candid', meaning: 'nghĩa' },
        })
      ).json(),
    ).entry;
    await call(later, alice, '/api/review-action', {
      method: 'POST',
      body: {
        requestId: newId(),
        pageId: word.id,
        action: 'remember',
        expected: { mastery: 1, nextReview: answerToday },
        expectedRevision: 0,
      },
    });
    const week = leagueResponseSchema.parse(await (await call(later, alice, '/api/league')).json());
    expect(week.group).not.toBeNull();

    clock = new Date(Date.parse(week.endsAt) + 3_600_000);
    // Bob's look settles Alice's group too.
    const look = await call(later, bob, '/api/league');
    expect(look.status, await look.text()).toBe(200);
    await call(later, alice, '/api/league');
    const rewards = await db.admin<{
      kind: string;
      outcome: string;
      rank: string;
    }>(
      `select kind, payload ->> 'outcome' as outcome, payload ->> 'rank' as rank from public.game_rewards where user_id = $1 and kind = 'league'`,
      [alice.id],
    );
    expect(rewards).toHaveLength(1);
    // Bronze never goes down.
    expect(['up', 'stay']).toContain(rewards[0]!.outcome);
    expect(await db.admin('select finalized_at is not null as settled from public.league_groups')).toEqual([{ settled: true }]);
    // The new week starts with no group until its first XP.
    expect(leagueResponseSchema.parse(await (await call(later, alice, '/api/league')).json()).group).toBeNull();
  });
});

describe('friends', () => {
  it('follows by nickname; following each other makes friends who can challenge each other', async () => {
    await rename(alice, 'Alice Owl');
    await rename(bob, 'Bob Fox');
    expect((await post(alice, '/api/friends/challenge', { nickname: 'Bob Fox' })).status).toBe(400);

    expect((await post(alice, '/api/friends/follow', { nickname: 'bob fox' })).status).toBe(200);
    let friends = friendsResponseSchema.parse(await (await call(app, alice, '/api/friends')).json());
    expect(friends.friends).toEqual([
      expect.objectContaining({
        nickname: 'Bob Fox',
        mutual: false,
        streak: null,
      }),
    ]);

    await post(bob, '/api/friends/follow', { nickname: 'Alice Owl' });
    friends = friendsResponseSchema.parse(await (await call(app, alice, '/api/friends')).json());
    expect(friends.friends[0]).toMatchObject({
      mutual: true,
      streak: 0,
      sharedStreak: 0,
    });

    expect((await post(alice, '/api/friends/challenge', { nickname: 'Bob Fox' })).status).toBe(200);
    const received = friendsResponseSchema.parse(await (await call(app, bob, '/api/friends')).json()).challenges;
    expect(received).toEqual([
      expect.objectContaining({
        nickname: 'Alice Owl',
        mine: false,
        accepted: false,
        current: true,
      }),
    ]);
    expect((await post(bob, `/api/challenges/${received[0]!.id}/accept`)).status).toBe(200);
  });

  it('joins two accounts through an invite link', async () => {
    const invite = (await (await post(alice, '/api/friends/invite')).json()) as { token: string };
    expect((await post(bob, '/api/friends/invite/accept', { token: invite.token })).status).toBe(200);
    expect(friendsResponseSchema.parse(await (await call(app, bob, '/api/friends')).json()).friends[0]).toMatchObject({ mutual: true });
    expect((await post(bob, '/api/friends/invite/accept', { token: 'x'.repeat(24) })).status).toBe(404);
  });

  it('hides an account from someone it blocked', async () => {
    await rename(alice, 'Alice Owl');
    await rename(bob, 'Bob Fox');
    await post(alice, '/api/friends/block', { nickname: 'Bob Fox' });
    expect((await profile(bob, 'Alice Owl')).status).toBe(404);
    expect((await post(bob, '/api/friends/follow', { nickname: 'Alice Owl' })).status).toBe(404);
    const search = (await (await call(app, bob, '/api/players?q=Ali')).json()) as { players: unknown[] };
    expect(search.players).toEqual([]);
  });

  it('never shows another account’s email or id', async () => {
    await rename(alice, 'Alice Owl');
    await rename(bob, 'Bob Fox');
    await post(alice, '/api/friends/follow', { nickname: 'Bob Fox' });
    await study(alice);
    await study(bob);
    for (const path of ['/api/league', '/api/friends', '/api/profile?u=Bob%20Fox', '/api/players?q=Bo']) {
      const text = await (await call(app, alice, path)).text();
      expect(text).not.toContain('bob@example.com');
      expect(text).not.toContain(bob.id);
    }
  });
});

describe('moderation', () => {
  it('needs both ADMIN_EMAILS and the database’s list of admins', async () => {
    await rename(bob, 'Rude Name');
    expect(
      (
        await post(alice, '/api/reports', {
          nickname: 'Rude Name',
          reason: 'rude',
        })
      ).status,
    ).toBe(200);
    // On ADMIN_EMAILS, but not yet in app_admins.
    expect((await call(app, alice, '/api/admin')).status).toBe(403);
    await db.admin('insert into public.app_admins (user_id) values ($1)', [alice.id]);
    // In app_admins, but not on ADMIN_EMAILS.
    await db.admin('insert into public.app_admins (user_id) values ($1)', [bob.id]);
    expect((await call(app, bob, '/api/admin')).status).toBe(403);

    const reports = (await (await call(app, alice, '/api/admin')).json()) as {
      reports: Array<{ target: string; nickname: string }>;
    };
    expect(reports.reports).toEqual([expect.objectContaining({ nickname: 'Rude Name' })]);
    expect(
      (
        await post(alice, '/api/admin/action', {
          target: reports.reports[0]!.target,
          action: 'rename',
        })
      ).status,
    ).toBe(200);
    expect(profileResponseSchema.parse((await profile(bob)).body).nickname).not.toBe('Rude Name');
    expect(
      (
        (await (await call(app, alice, '/api/admin')).json()) as {
          reports: unknown[];
        }
      ).reports,
    ).toEqual([]);
  });
});
