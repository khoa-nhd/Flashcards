/**
 * The gacha tables and the one function that writes them, against real
 * PostgreSQL: one account's chests stay its own, and a repeated request id can
 * never open (or pay for) a second chest.
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../helpers/test-database.js';

const APPLY = `
  select public.apply_gacha_open(
    $1, $2, $3, $4, $5, $6, $7::date, $8::jsonb, $9::uuid, $10, $11, $12::jsonb
  ) as outcome
`;

interface Applied extends Record<string, unknown> {
  outcome: { outcome: string; results?: Array<{ itemId: string }> };
}

const items = JSON.stringify([{ item_id: 'paper-crane', rarity: 'common', quantity: 1 }]);
const results = JSON.stringify([{ itemId: 'paper-crane', rarity: 'common', duplicate: false, shards: 0 }]);

function opening(overrides: {
  expectedOpens?: number;
  keys?: number;
  shards?: number;
  opens?: number;
  requestId?: string;
  items?: string;
  results?: string;
} = {}) {
  return [
    overrides.expectedOpens ?? 0,
    overrides.keys ?? 4,
    overrides.shards ?? 0,
    1,
    1,
    overrides.opens ?? 1,
    '2026-11-04',
    overrides.items ?? items,
    overrides.requestId ?? '11111111-1111-4111-8111-111111111111',
    'wooden',
    1,
    overrides.results ?? results,
  ] as const;
}

describe('loot chests in the database', () => {
  it('writes the balance, the collection and the opening in one call', async () => {
    const db = await createTestDatabase();
    const user = await db.createUser('owner@example.test');

    const [applied] = await db.as(user, (s) => s.query<Applied>(APPLY, [...opening()]));
    expect(applied!.outcome).toEqual({ outcome: 'applied' });

    expect(await db.as(user, (s) => s.query(`select keys, shards, since_epic, since_legendary, opens from public.gacha_state`))).toEqual([
      { keys: 4, shards: 0, since_epic: 1, since_legendary: 1, opens: 1 },
    ]);
    expect(await db.as(user, (s) => s.query(`select item_id, rarity, quantity from public.gacha_inventory`))).toEqual([
      { item_id: 'paper-crane', rarity: 'common', quantity: 1 },
    ]);
    expect(await db.as(user, (s) => s.query(`select chest_id, count from public.gacha_opens`))).toEqual([{ chest_id: 'wooden', count: 1 }]);
    await db.close();
  });

  it('answers a repeated request id with the same results, without spending again', async () => {
    const db = await createTestDatabase();
    const user = await db.createUser('owner@example.test');
    await db.as(user, (s) => s.query(APPLY, [...opening()]));

    const [again] = await db.as(user, (s) => s.query<Applied>(APPLY, [...opening({ keys: 1, opens: 2 })]));
    expect(again!.outcome.outcome).toBe('replayed');
    expect(again!.outcome.results).toEqual([{ itemId: 'paper-crane', rarity: 'common', duplicate: false, shards: 0 }]);
    expect(await db.as(user, (s) => s.query(`select keys, opens from public.gacha_state`))).toEqual([{ keys: 4, opens: 1 }]);
    expect(await db.as(user, (s) => s.query(`select count(*)::int as n from public.gacha_opens`))).toEqual([{ n: 1 }]);
    await db.close();
  });

  it('refuses an opening built on a balance someone else already changed', async () => {
    const db = await createTestDatabase();
    const user = await db.createUser('owner@example.test');
    await db.as(user, (s) => s.query(APPLY, [...opening()]));

    const [stale] = await db.as(user, (s) =>
      s.query<Applied>(APPLY, [...opening({ expectedOpens: 0, opens: 5, keys: 0, requestId: '22222222-2222-4222-8222-222222222222' })]),
    );
    expect(stale!.outcome).toEqual({ outcome: 'conflict' });
    expect(await db.as(user, (s) => s.query(`select keys, opens from public.gacha_state`))).toEqual([{ keys: 4, opens: 1 }]);
    await db.close();
  });

  it('keeps one account’s chests away from another, and from signed-out visitors', async () => {
    const db = await createTestDatabase();
    const alice = await db.createUser('alice@example.test');
    const bob = await db.createUser('bob@example.test');
    await db.as(alice, (s) => s.query(APPLY, [...opening()]));

    expect(await db.as(alice, (s) => s.query(`select 1 from public.gacha_state`))).toHaveLength(1);
    expect(await db.as(bob, (s) => s.query(`select 1 from public.gacha_state`))).toHaveLength(0);
    expect(await db.as(bob, (s) => s.query(`select 1 from public.gacha_inventory`))).toHaveLength(0);
    expect(await db.as(bob, (s) => s.query(`select 1 from public.gacha_opens`))).toHaveLength(0);
    await expect(db.asAnon((s) => s.query(`select 1 from public.gacha_state`))).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asAnon((s) => s.query(APPLY, [...opening({ requestId: '33333333-3333-4333-8333-333333333333' })])),
    ).rejects.toMatchObject({ code: '42501' });
    await db.close();
  });

  it('reports which schema version a database has', async () => {
    const db = await createTestDatabase();
    expect(await db.admin('select public.app_schema_version() as v')).toEqual([{ v: 22 }]);
    await db.close();
  });
});
