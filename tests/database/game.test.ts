/**
 * The game's tables (schema version 17): only a change signed by the server
 * can write them, each account reads only its own rows, and the answers the
 * engine reads are classified the way the goals already count them.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type Session, type TestDatabase } from '../helpers/test-database.js';

const KEY = 'a'.repeat(64);
const sign = (payload: string, key = KEY) => createHmac('sha256', key).update(payload, 'utf8').digest('hex');

let db: TestDatabase;
let alice: string;
let bob: string;
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  await db.admin('delete from public.game_signing_key');
  await db.admin(`insert into public.game_signing_key (key) values ($1)`, [KEY]);
  alice = await db.createUser('alice@example.com');
  bob = await db.createUser('bob@example.com');
});

const change = (user: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    user,
    version: 0,
    state: { combo: 1 },
    ledger: [
      { source: 'answer', sourceId: 'log-1', amount: 10, base: 10, bonus: 0, reason: 'due', at: '2026-10-29T08:00:00Z', on: '2026-10-29' },
    ],
    quests: [{ period: 'day', start: '2026-10-29', slot: 0, kind: 'due_reviews', target: 5, reward: 30, progress: 1, completedAt: null }],
    badges: [{ badge: 'reviews', tier: 1 }],
    freezes: [{ id: uuid(), grantedOn: '2026-10-29', usedOn: null }],
    rewards: [{ id: uuid(), kind: 'level', payload: { level: 2 }, createdAt: '2026-10-29T08:00:00Z' }],
    claimed: [],
    ...overrides,
  });

const commit = (session: Session, payload: string, signature = sign(payload)) =>
  session.query<{ outcome: string; version: number; total_xp: number }>(`select * from public.game_commit($1, $2)`, [payload, signature]);

const code = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

describe('game_commit', () => {
  it('stores a signed change for the caller, and counts the total from the ledger', async () => {
    const [result] = await db.as(alice, (s) => commit(s, change(alice)));
    expect(result).toMatchObject({ outcome: 'ok' });
    expect(Number(result!.version)).toBe(1);
    expect(Number(result!.total_xp)).toBe(10);
    const rows = await db.as(alice, (s) =>
      s.query(`select (select count(*) from public.game_quests)::int as quests, (select count(*) from public.game_badges)::int as badges,
                      (select count(*) from public.game_freezes)::int as freezes, (select count(*) from public.game_rewards)::int as rewards`),
    );
    expect(rows).toEqual([{ quests: 1, badges: 1, freezes: 1, rewards: 1 }]);
  });

  it('refuses a change that is not signed with the server key', async () => {
    const payload = change(alice);
    expect(await code(db.as(alice, (s) => commit(s, payload, sign(payload, 'b'.repeat(64)))))).toBe('42501');
    // Signed, but altered afterwards: the signature no longer matches.
    const altered = payload.replace('"amount":10', '"amount":10000');
    expect(await code(db.as(alice, (s) => commit(s, altered, sign(payload))))).toBe('42501');
    expect(await db.admin('select * from public.xp_ledger')).toEqual([]);
  });

  it('refuses a change made out for another account', async () => {
    expect(await code(db.as(bob, (s) => commit(s, change(alice))))).toBe('42501');
  });

  it('does nothing for a change made from an older version, so a signed change cannot be replayed', async () => {
    const payload = change(alice);
    await db.as(alice, (s) => commit(s, payload));
    const [again] = await db.as(alice, (s) => commit(s, payload));
    expect(again).toMatchObject({ outcome: 'stale' });
    expect(Number(again!.total_xp)).toBe(10);
  });

  it('never counts the same answer twice, and keeps a completed quest completed', async () => {
    await db.as(alice, (s) => commit(s, change(alice)));
    await db.as(alice, (s) =>
      commit(
        s,
        change(alice, {
          version: 1,
          badges: [],
          freezes: [],
          rewards: [],
          quests: [{ period: 'day', start: '2026-10-29', slot: 0, kind: 'due_reviews', target: 5, reward: 30, progress: 5, completedAt: '2026-10-29T09:00:00Z' }],
        }),
      ),
    );
    const [state] = await db.as(alice, (s) => s.query<{ total_xp: number }>('select total_xp from public.game_state'));
    expect(Number(state!.total_xp)).toBe(10);
    expect(await db.as(alice, (s) => s.query('select progress, completed_at is not null as done from public.game_quests'))).toEqual([
      { progress: 5, done: true },
    ]);
  });

  it('marks claimed only the caller’s own unclaimed rewards', async () => {
    const reward = uuid();
    await db.as(alice, (s) => commit(s, change(alice, { rewards: [{ id: reward, kind: 'checkin', payload: { xp: 10 } }] })));
    await db.as(bob, (s) => commit(s, change(bob, { ledger: [], rewards: [], freezes: [], claimed: [reward] })));
    expect(await db.admin('select claimed_at is null as open from public.game_rewards')).toEqual([{ open: true }]);
    await db.as(alice, (s) => commit(s, change(alice, { version: 1, ledger: [], rewards: [], freezes: [], claimed: [reward] })));
    expect(await db.admin('select claimed_at is null as open from public.game_rewards')).toEqual([{ open: false }]);
  });

  it('says plainly when the signing key has not been set', async () => {
    await db.admin('delete from public.game_signing_key');
    expect(await code(db.as(alice, (s) => commit(s, change(alice))))).toBe('55000');
  });
});

describe('the game tables', () => {
  it('cannot be written directly, nor the signing key read', async () => {
    for (const statement of [
      `insert into public.xp_ledger (user_id, source, source_id, amount, base, reason, earned_at, earned_on) values ('${'0'.repeat(8)}-0000-4000-8000-000000000000', 'answer', 'x', 1000, 1000, 'due', now(), current_date)`,
      `update public.game_state set total_xp = 1000000`,
      `insert into public.game_rewards (id, user_id, kind) values (gen_random_uuid(), auth.uid(), 'quest')`,
      `select * from public.game_signing_key`,
    ]) {
      expect(await code(db.as(alice, (s) => s.query(statement)))).toBe('42501');
    }
  });

  it('shows each account only its own rows', async () => {
    await db.as(alice, (s) => commit(s, change(alice)));
    expect(await db.as(bob, (s) => s.query('select * from public.xp_ledger'))).toEqual([]);
    expect(await db.as(bob, (s) => s.query('select * from public.game_rewards'))).toEqual([]);
    expect(await db.as(alice, (s) => s.query('select source_id from public.xp_ledger'))).toEqual([{ source_id: 'log-1' }]);
  });
});

describe('game_pending_answers', () => {
  it('lists answers not yet in the ledger, with whether each was new, counted and due', async () => {
    const [word] = await db.as(alice, (s) =>
      s.query<{ id: string }>(
        `select id from public.create_vocabulary(p_word => 'candid', p_word_key => 'candid', p_mastery => 1::smallint, p_review_date => '2026-10-29'::date, p_request_id => null, p_external_source => null, p_external_id => null)`,
      ),
    );
    const due = { due: '2026-10-29T00:00:00Z', stability: 400, difficulty: 5, last_review: null, reps: 1, lapses: 0, state: 2, scheduled_days: 1, learning_steps: 0, version: 'v5' };
    const later = { ...due, due: '2026-11-20T00:00:00Z', stability: 10 };
    await db.admin(
      `insert into public.review_logs (user_id, vocabulary_id, request_id, kind, action, reviewed_on, reviewed_at, mastery_before, mastery_after, scheduler, fsrs_before, fsrs_after, counted_toward_schedule, counted_as_new)
       values ($1, $2, $3, 'review', 'remember', '2026-10-29', '2026-10-29T08:00:00Z', 1, 1, 'fsrs', null, $5::jsonb, true, true),
              ($1, $2, $4, 'review', 'remember', '2026-10-29', '2026-10-29T09:00:00Z', 1, 1, 'fsrs', $6::jsonb, $7::jsonb, true, false),
              ($1, $2, $8, 'review', 'not_remember', '2026-10-29', '2026-10-29T10:00:00Z', 1, 1, 'fsrs', $5::jsonb, $5::jsonb, false, false)`,
      [alice, word!.id, uuid(), uuid(), JSON.stringify(later), JSON.stringify({ ...due, stability: 100 }), JSON.stringify(due), uuid()],
    );
    const pending = await db.as(alice, (s) =>
      s.query(`select kind, is_new, counted, was_due, mastered from public.game_pending_answers(100)`),
    );
    expect(pending).toEqual([
      { kind: 'review', is_new: true, counted: true, was_due: false, mastered: false },
      { kind: 'review', is_new: false, counted: true, was_due: true, mastered: true },
      { kind: 'review', is_new: false, counted: false, was_due: false, mastered: false },
    ]);
    // Bob sees none of them.
    expect(await db.as(bob, (s) => s.query(`select * from public.game_pending_answers(100)`))).toEqual([]);
  });
});

describe('upgrading to version 17', () => {
  it('runs on a database at version 16 with history, and can be run again', async () => {
    const migrations = (await import('../helpers/test-database.js')).readMigrations();
    const at = migrations.findIndex((migration) => migration.name.endsWith('_gamification_core.sql'));
    const old = await createTestDatabase({ migrations: at });
    try {
      const user = await old.createUser('owner@example.test');
      const [word] = await old.as(user, (s) =>
        s.query<{ id: string }>(
          `select id from public.create_vocabulary(p_word => 'candid', p_word_key => 'candid', p_mastery => 3::smallint, p_review_date => '2026-10-29'::date, p_request_id => null, p_external_source => null, p_external_id => null)`,
        ),
      );
      await old.admin(
        `insert into public.review_logs (user_id, vocabulary_id, request_id, kind, action, reviewed_on, reviewed_at, mastery_before, mastery_after, scheduler)
         values ($1, $2, gen_random_uuid(), 'review', 'remember', '2026-10-20', '2026-10-20T08:00:00Z', 3, 4, 'mastery_v1')`,
        [user, word!.id],
      );
      const v17 = migrations[at]!;
      await old.db.exec(v17.sql);
      await old.db.exec(v17.sql);
      expect(await old.admin('select public.app_schema_version() as v')).toEqual([{ v: 17 }]);
      // The old answer is waiting to be counted, as a due review.
      expect(await old.as(user, (s) => s.query('select kind, is_new, counted, was_due from public.game_pending_answers(10)'))).toEqual([
        { kind: 'review', is_new: false, counted: true, was_due: true },
      ]);
    } finally {
      await old.close();
    }
  }, 120_000);
});
