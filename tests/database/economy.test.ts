/**
 * The economy (schema version 19): stardust and items are written only by a
 * signed change, never below nothing; others see a profile's showcase and
 * nothing else; the boss is counted from practice alone.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, readMigrations, type Session, type TestDatabase } from '../helpers/test-database.js';

const KEY = 'e'.repeat(64);
const sign = (payload: string) => createHmac('sha256', KEY).update(payload, 'utf8').digest('hex');

let db: TestDatabase;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  await db.admin('delete from public.game_signing_key');
  await db.admin('delete from public.game_events');
  await db.admin(`insert into public.game_signing_key (key) values ($1)`, [KEY]);
  alice = await db.createUser('alice@example.com');
  bob = await db.createUser('bob@example.com');
});

const versionOf = async (user: string) =>
  Number((await db.admin<{ version: number }>('select version from public.game_state where user_id = $1', [user]))[0]?.version ?? 0);

const commit = async (user: string, change: Record<string, unknown>) => {
  const payload = JSON.stringify({ user, version: await versionOf(user), state: {}, ...change });
  return db.as(user, (s: Session) => s.query<{ outcome: string }>('select * from public.game_commit($1, $2)', [payload, sign(payload)]));
};

const apply = (user: string, op: Record<string, unknown>) => {
  const payload = JSON.stringify({ ...op, user, exp: new Date(Date.now() + 60_000).toISOString() });
  return db.as(user, (s) => s.query('select * from public.game_apply($1, $2)', [payload, sign(payload)]));
};

const code = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

const balance = async (user: string) =>
  Number((await db.admin<{ stardust: number }>('select stardust from public.game_state where user_id = $1', [user]))[0]?.stardust ?? 0);

describe('stardust and items', () => {
  it('are kept from a signed change, once each', async () => {
    const earn = {
      stardust: [{ source: 'reward', sourceId: 'r1', amount: 120, reason: 'quest' }],
      inventory: [{ item: 'frame_moon', source: 'shop' }],
    };
    await commit(alice, earn);
    await commit(alice, earn);
    expect(await balance(alice)).toBe(120);
    expect(await db.as(alice, (s) => s.query('select item_id from public.inventory'))).toEqual([{ item_id: 'frame_moon' }]);
    expect(await db.as(bob, (s) => s.query('select * from public.inventory'))).toEqual([]);
  });

  it('refuse a change that would leave less than none, and keep nothing of it', async () => {
    await commit(alice, { stardust: [{ source: 'reward', sourceId: 'r1', amount: 100, reason: 'quest' }] });
    const spend = {
      stardust: [{ source: 'shop', sourceId: 's1', amount: -150, reason: 'frame' }],
      inventory: [{ item: 'frame_aurora', source: 'shop' }],
    };
    expect(await code(commit(alice, spend))).toBe('23514');
    expect(await balance(alice)).toBe(100);
    expect(await db.as(alice, (s) => s.query('select * from public.inventory'))).toEqual([]);
  });

  it('cannot be written directly', async () => {
    for (const statement of [
      `insert into public.stardust_ledger (user_id, source, source_id, amount, reason) values (auth.uid(), 'reward', 'x', 99999, 'x')`,
      `insert into public.inventory (user_id, item_id, source) values (auth.uid(), 'pet_dragon', 'x')`,
      `update public.game_events set enabled = false`,
    ]) {
      expect(await code(db.as(alice, (s) => s.query(statement)))).toBe('42501');
    }
  });
});

describe('events', () => {
  it('are switched by an admin only, and read by everyone', async () => {
    expect(await code(apply(alice, { op: 'admin_event', event: 'sunday', enabled: false }))).toBe('42501');
    await db.admin('insert into public.app_admins (user_id) values ($1)', [alice]);
    await apply(alice, { op: 'admin_event', event: 'sunday', enabled: false });
    expect(await db.as(bob, (s) => s.query('select event, enabled from public.game_events'))).toEqual([
      { event: 'sunday', enabled: false },
    ]);
  });
});

describe('the boss and the showcase', () => {
  it('counts practice answers on the boss’s words, and only the caller’s', async () => {
    const [word] = await db.as(alice, (s) =>
      s.query<{ id: string }>(
        `select id from public.create_vocabulary(p_word => 'candid', p_word_key => 'candid', p_mastery => 1::smallint, p_review_date => '2026-10-29'::date, p_request_id => null, p_external_source => null, p_external_id => null)`,
      ),
    );
    await db.admin(
      `insert into public.review_logs (user_id, vocabulary_id, request_id, kind, action, review_mode, reviewed_on, reviewed_at, answer_correct, grading, mastery_before, mastery_after)
       values ($1, $2, gen_random_uuid(), 'practice', 'remember', 'typing', '2026-10-29', '2026-10-29T08:00:00Z', true, 'auto', 1, 1),
              ($1, $2, gen_random_uuid(), 'practice', 'not_remember', 'typing', '2026-10-29', '2026-10-29T08:01:00Z', false, 'auto', 1, 1),
              ($1, $2, gen_random_uuid(), 'practice', 'remember', 'typing', '2026-10-20', '2026-10-20T08:00:00Z', true, 'auto', 1, 1)`,
      [alice, word!.id],
    );
    const progress = (user: string) =>
      db.as(user, (s) => s.query(`select * from public.boss_progress($1::uuid[], '2026-10-26T00:00:00Z')`, [[word!.id]]));
    expect(await progress(alice)).toEqual([{ correct: 1, wrong: 1 }]);
    expect(await progress(bob)).toEqual([{ correct: 0, wrong: 0 }]);
  });

  it('shows a profile’s items and leading companions, unless blocked', async () => {
    await apply(alice, { op: 'profile', nickname: 'Alice Owl', frame: null, title: null, inLeagues: true });
    await commit(alice, {
      state: { pets: { active: ['pet_owl'], days: {}, goldReached: false } },
      inventory: [
        { item: 'pet_owl', source: 'starter' },
        { item: 'card_orion', source: 'chest' },
      ],
    });
    const showcase = () =>
      db.as(bob, (s) => s.query(`select item_id, is_leading from public.profile_showcase($1) order by item_id`, [alice]));
    expect(await showcase()).toEqual([
      { item_id: 'card_orion', is_leading: false },
      { item_id: 'pet_owl', is_leading: true },
    ]);
    await apply(alice, { op: 'block', other: bob });
    expect(await showcase()).toEqual([]);
  });
});

describe('upgrading to version 19', () => {
  it('runs on a database at version 18 with a game, keeps its XP, and can be run again', async () => {
    const migrations = readMigrations();
    const at = migrations.findIndex((migration) => migration.name.endsWith('_economy.sql'));
    const old = await createTestDatabase({ migrations: at });
    try {
      const user = await old.createUser('owner@example.test');
      await old.admin(`insert into public.game_signing_key (key) values ($1)`, [KEY]);
      const payload = JSON.stringify({
        user,
        version: 0,
        state: {},
        ledger: [
          { source: 'answer', sourceId: 'a', amount: 40, base: 40, bonus: 0, reason: 'due', at: '2026-10-29T08:00:00Z', on: '2026-10-29' },
        ],
      });
      await old.as(user, (s) => s.query('select * from public.game_commit($1, $2)', [payload, sign(payload)]));
      await old.db.exec(migrations[at]!.sql);
      await old.db.exec(migrations[at]!.sql);
      expect(await old.admin('select public.app_schema_version() as v')).toEqual([{ v: 19 }]);
      expect(await old.admin('select total_xp::int as xp, stardust::int as stardust from public.game_state')).toEqual([
        { xp: 40, stardust: 0 },
      ]);
    } finally {
      await old.close();
    }
  }, 120_000);
});
