/**
 * Competition (schema version 18): the write lockdown on the history, the
 * signed operations of game_apply, and the functions that read other
 * accounts, which must give their public columns and nothing else.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, readMigrations, type Session, type TestDatabase } from '../helpers/test-database.js';

const KEY = 'c'.repeat(64);
const sign = (payload: string, key = KEY) => createHmac('sha256', key).update(payload, 'utf8').digest('hex');
const soon = () => new Date(Date.now() + 60_000).toISOString();
const WEEK = '2026-10-26';

let db: TestDatabase;
let alice: string;
let bob: string;
let carol: string;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  await db.admin('delete from public.game_signing_key');
  await db.admin('delete from public.league_groups');
  await db.admin(`insert into public.game_signing_key (key) values ($1)`, [KEY]);
  alice = await db.createUser('alice@example.com');
  bob = await db.createUser('bob@example.com');
  carol = await db.createUser('carol@example.com');
});

const apply = (session: Session, user: string, op: Record<string, unknown>, options: { key?: string; exp?: string } = {}) => {
  const payload = JSON.stringify({ ...op, user, exp: options.exp ?? soon() });
  return session.query<{ result: string | null }>('select * from public.game_apply($1, $2)', [payload, sign(payload, options.key)]);
};
const as = (user: string, op: Record<string, unknown>, options?: { key?: string; exp?: string }) =>
  db.as(user, (s) => apply(s, user, op, options));
const name = (user: string, nickname: string) =>
  as(user, {
    op: 'profile',
    nickname,
    frame: null,
    title: null,
    inLeagues: true,
  });

const code = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

/** Runs as the database owner, with the API's request path set as PostgREST sets it. */
const throughApi = (path: string, sql: string, params: unknown[] = []) =>
  db.db.transaction(async (tx) => {
    await tx.query(`select set_config('request.path', $1, true)`, [path]);
    return (await tx.query(sql, params)).rows;
  });

const word = async (user: string) => {
  const [row] = await db.as(user, (s) =>
    s.query<{ id: string }>(
      `select id from public.create_vocabulary(p_word => 'candid', p_word_key => 'candid', p_mastery => 1::smallint, p_review_date => '2026-10-29'::date, p_request_id => null, p_external_source => null, p_external_id => null)`,
    ),
  );
  return row!.id;
};

describe('the write lockdown', () => {
  it('refuses history rows and met days written through the table endpoint, even by the owner role', async () => {
    const id = await word(alice);
    const insert = `insert into public.review_logs (user_id, vocabulary_id, request_id, kind, action, reviewed_on, reviewed_at, mastery_before, mastery_after, scheduler)
                    values ($1, $2, gen_random_uuid(), 'review', 'remember', '2026-10-29', now(), 1, 2, 'mastery_v1')`;
    expect(await code(throughApi('/review_logs', insert, [alice, id]))).toBe('42501');
    expect(
      await code(throughApi('/card_states', `update public.card_states set fsrs_stability = 400 where vocabulary_id = $1`, [id])),
    ).toBe('42501');
    expect(
      await code(
        throughApi(
          '/study_days',
          `insert into public.study_days (user_id, day, new_goal, review_goal, practice_goal, met) values ($1, '2026-10-29', 0, 0, 0, true)`,
          [alice],
        ),
      ),
    ).toBe('42501');
    // The app's own functions are called under /rpc/, and the SQL Editor has no path at all.
    expect(await code(throughApi('/rpc/record_fsrs_review', insert, [alice, id]))).toBeNull();
    expect(await code(db.admin(insert, [alice, id]))).toBeNull();
  });

  it('stamps new answers with the database’s time, and leaves the history before it without one', async () => {
    const id = await word(alice);
    const [row] = await db.admin<{ recorded: boolean }>(
      `insert into public.review_logs (user_id, vocabulary_id, request_id, kind, action, reviewed_on, reviewed_at, mastery_before, mastery_after, scheduler)
       values ($1, $2, gen_random_uuid(), 'review', 'remember', '2020-01-01', '2020-01-01T00:00:00Z', 1, 2, 'mastery_v1')
       returning recorded_at > now() - interval '1 minute' as recorded`,
      [alice, id],
    );
    expect(row).toEqual({ recorded: true });
  });
});

describe('game_apply', () => {
  it('refuses an operation not signed by the server, made out for another account, or expired', async () => {
    expect(await code(as(alice, { op: 'profile', nickname: 'Alice' }, { key: 'd'.repeat(64) }))).toBe('42501');
    expect(await code(db.as(bob, (s) => apply(s, alice, { op: 'profile', nickname: 'Alice' })))).toBe('42501');
    expect(await code(as(alice, { op: 'profile', nickname: 'Alice' }, { exp: '2020-01-01T00:00:00Z' }))).toBe('42501');
    expect(await db.admin('select * from public.public_profiles')).toEqual([]);
  });

  it('keeps nicknames unique whatever their case', async () => {
    await name(alice, 'Moon Owl');
    expect(await code(name(bob, 'moon owl'))).toBe('23505');
    // Renaming oneself to one's own name in another case is fine.
    expect(await code(name(alice, 'MOON OWL'))).toBeNull();
  });

  it('puts accounts of one tier in the same open group, and one account in one group a week', async () => {
    const [first] = await as(alice, { op: 'league_join', week: WEEK, tier: 1 });
    const [again] = await as(alice, { op: 'league_join', week: WEEK, tier: 1 });
    const [second] = await as(bob, { op: 'league_join', week: WEEK, tier: 1 });
    const [other] = await as(carol, { op: 'league_join', week: WEEK, tier: 3 });
    expect(again!.result).toBe(first!.result);
    expect(second!.result).toBe(first!.result);
    expect(other!.result).not.toBe(first!.result);
  });

  it('opens a new group once twenty real people are in one', async () => {
    const [full] = await as(alice, { op: 'league_join', week: WEEK, tier: 2 });
    for (let at = 0; at < 19; at += 1) {
      const user = await db.createUser(`filler${at}@example.com`);
      await as(user, { op: 'league_join', week: WEEK, tier: 2 });
    }
    const [next] = await as(bob, { op: 'league_join', week: WEEK, tier: 2 });
    expect(next!.result).not.toBe(full!.result);
  });

  it('settles a group once: tiers move and a reward waits, and a second settling changes nothing', async () => {
    const [group] = await as(alice, { op: 'league_join', week: WEEK, tier: 1 });
    const settle = (tier: number) =>
      as(bob, {
        op: 'league_settle',
        week: WEEK,
        groups: [
          {
            id: group!.result,
            members: [
              {
                user: alice,
                rank: 1,
                xp: 500,
                outcome: 'up',
                tier,
                reward: { tier, rank: 1, outcome: 'up' },
              },
            ],
          },
        ],
      });
    await settle(2);
    await settle(5);
    expect(await db.admin('select tier from public.league_tiers where user_id = $1', [alice])).toEqual([{ tier: 2 }]);
    expect(await db.admin(`select kind, payload ->> 'tier' as tier from public.game_rewards where user_id = $1`, [alice])).toEqual([
      { kind: 'league', tier: '2' },
    ]);
    expect(await db.admin('select final_rank, final_xp, outcome from public.league_members')).toEqual([
      { final_rank: 1, final_xp: 500, outcome: 'up' },
    ]);
  });

  it('lets only admins moderate', async () => {
    await name(bob, 'Rude Name');
    expect(await code(as(alice, { op: 'admin_rename', other: bob, nickname: 'Cú Đêm 1234' }))).toBe('42501');
    await db.admin('insert into public.app_admins (user_id) values ($1)', [alice]);
    await as(alice, {
      op: 'admin_rename',
      other: bob,
      nickname: 'Cú Đêm 1234',
    });
    expect(await db.admin('select nickname from public.public_profiles where user_id = $1', [bob])).toEqual([{ nickname: 'Cú Đêm 1234' }]);
  });

  it('has challenges only between friends, and settles one once with its rewards', async () => {
    expect(await code(as(alice, { op: 'challenge', other: bob, week: WEEK }))).toBe('22023');
    await as(alice, { op: 'follow', other: bob });
    await as(bob, { op: 'follow', other: alice });
    await as(alice, { op: 'challenge', other: bob, week: WEEK });
    const [challenge] = await db.admin<{ id: string }>('select id from public.challenges');
    // Only the one challenged can accept.
    await as(alice, { op: 'challenge_accept', id: challenge!.id });
    expect(await db.admin('select accepted_at is null as open from public.challenges')).toEqual([{ open: true }]);
    await as(bob, { op: 'challenge_accept', id: challenge!.id });
    const settle = () =>
      as(alice, {
        op: 'challenge_settle',
        id: challenge!.id,
        winner: alice,
        rewards: [
          { user: alice, payload: { xp: 100 } },
          { user: carol, payload: { xp: 1000 } },
        ],
      });
    await settle();
    await settle();
    // Rewards go only to the two sides, once.
    expect(await db.admin(`select user_id = $1 as alice, kind from public.game_rewards`, [alice])).toEqual([
      { alice: true, kind: 'challenge' },
    ]);
  });

  it('accepts an invite link: both follow each other', async () => {
    await as(alice, { op: 'invite', token: 'a'.repeat(24), expires: soon() });
    await as(bob, { op: 'invite_accept', token: 'a'.repeat(24) });
    expect(Number((await db.admin<{ n: number }>('select count(*) as n from public.follows'))[0]!.n)).toBe(2);
    expect(await code(as(carol, { op: 'invite_accept', token: 'b'.repeat(24) }))).toBe('22023');
  });
});

describe('reading other accounts', () => {
  beforeEach(async () => {
    await name(alice, 'Alice Owl');
    await name(bob, 'Bob Fox');
    await as(alice, { op: 'league_join', week: WEEK, tier: 1 });
    await as(bob, { op: 'league_join', week: WEEK, tier: 1 });
    await db.admin(
      `insert into public.study_days (user_id, day, new_goal, review_goal, practice_goal, met) values ($1, '2026-10-28', 0, 0, 0, true)`,
      [alice],
    );
  });

  it('shows a league group’s nicknames and XP, and no email', async () => {
    const board = await db.as(bob, (s) => s.query<Record<string, unknown>>(`select * from public.league_board($1)`, [WEEK]));
    expect(board.map((row) => row.nickname).sort()).toEqual(['Alice Owl', 'Bob Fox']);
    for (const row of board) {
      expect(Object.keys(row)).not.toContain('email');
      expect(JSON.stringify(row)).not.toContain('@example.com');
    }
  });

  it('gives a stranger’s streak days to nobody, and a friend’s to those they follow or who follow them', async () => {
    expect(await db.as(bob, (s) => s.query(`select * from public.streak_days($1)`, [alice]))).toEqual([]);
    await as(bob, { op: 'follow', other: alice });
    expect(await db.as(bob, (s) => s.query(`select day::text as day from public.streak_days($1)`, [alice]))).toEqual([
      { day: '2026-10-28' },
    ]);
    expect(await db.as(carol, (s) => s.query(`select * from public.streak_days($1)`, [alice]))).toEqual([]);
  });

  it('hides a profile from someone it blocked, in lookups and searches', async () => {
    expect(await db.as(bob, (s) => s.query(`select nickname from public.profile_by_nickname('alice owl')`))).toEqual([
      { nickname: 'Alice Owl' },
    ]);
    await as(alice, { op: 'block', other: bob });
    expect(await db.as(bob, (s) => s.query(`select * from public.profile_by_nickname('Alice Owl')`))).toEqual([]);
    expect(await db.as(bob, (s) => s.query(`select * from public.profile_search('Ali')`))).toEqual([]);
    expect(await db.as(carol, (s) => s.query(`select nickname from public.profile_search('Ali')`))).toEqual([{ nickname: 'Alice Owl' }]);
  });

  it('lets nobody read the tables of others directly', async () => {
    expect(await db.as(bob, (s) => s.query('select * from public.public_profiles'))).toEqual([
      expect.objectContaining({ nickname: 'Bob Fox' }),
    ]);
    expect(await code(db.as(bob, (s) => s.query('select * from public.league_members')))).toBe('42501');
    expect(await code(db.as(bob, (s) => s.query('select * from public.reports')))).toBe('42501');
    expect(
      await code(db.as(bob, (s) => s.query(`insert into public.public_profiles (user_id, nickname) values (auth.uid(), 'Forged')`))),
    ).toBe('42501');
  });

  it('shows reports to admins only', async () => {
    await as(bob, { op: 'report', other: alice, reason: 'rude' });
    expect(await db.as(bob, (s) => s.query('select * from public.admin_reports()'))).toEqual([]);
    await db.admin('insert into public.app_admins (user_id) values ($1)', [carol]);
    expect(await db.as(carol, (s) => s.query('select nickname, reason, reports from public.admin_reports()'))).toEqual([
      { nickname: 'Alice Owl', reason: 'rude', reports: 1 },
    ]);
  });
});

describe('upgrading to version 18', () => {
  it('runs on a database at version 17, and can be run again', async () => {
    const migrations = readMigrations();
    const at = migrations.findIndex((migration) => migration.name.endsWith('_competition.sql'));
    const old = await createTestDatabase({ migrations: at });
    try {
      const user = await old.createUser('owner@example.test');
      const [row] = await old.as(user, (s) =>
        s.query<{ id: string }>(
          `select id from public.create_vocabulary(p_word => 'candid', p_word_key => 'candid', p_mastery => 3::smallint, p_review_date => '2026-10-29'::date, p_request_id => null, p_external_source => null, p_external_id => null)`,
        ),
      );
      await old.admin(
        `insert into public.review_logs (user_id, vocabulary_id, request_id, kind, action, reviewed_on, reviewed_at, mastery_before, mastery_after, scheduler)
         values ($1, $2, gen_random_uuid(), 'review', 'remember', '2026-10-20', '2026-10-20T08:00:00Z', 3, 4, 'mastery_v1')`,
        [user, row!.id],
      );
      const v18 = migrations[at]!;
      await old.db.exec(v18.sql);
      await old.db.exec(v18.sql);
      expect(await old.admin('select public.app_schema_version() as v')).toEqual([{ v: 18 }]);
      // The answer saved before the update has no database time, so no limit counts it.
      expect(await old.as(user, (s) => s.query('select kind, recorded_at from public.game_pending_answers(10)'))).toEqual([
        { kind: 'review', recorded_at: null },
      ]);
    } finally {
      await old.close();
    }
  }, 120_000);
});
