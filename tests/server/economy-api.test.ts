/**
 * The economy (schema version 19) through the real routes, sessions and
 * schema: the shop takes only stardust the account has, nothing is bought
 * twice, a first companion is chosen once, chests open as they are claimed,
 * and only owned frames can be worn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectionResponseSchema, gameResponseSchema, profileResponseSchema, shopResponseSchema } from '../../shared/api.js';
import { call, createSupabaseTestApp, createTestUser, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const KEY = 'k'.repeat(64);

let db: TestDatabase;
let alice: TestUser;
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
  app = createSupabaseTestApp(db, [alice], { env: { GAME_SIGNING_KEY: KEY }, now: () => new Date() });
});

/** Gives stardust as a claimed reward would have. */
const grant = async (amount: number) => {
  await call(app, alice, '/api/game');
  await db.admin(
    `insert into public.stardust_ledger (user_id, source, source_id, amount, reason) values ($1, 'reward', gen_random_uuid()::text, $2, 'test')`,
    [alice.id, amount],
  );
  await db.admin(
    'update public.game_state set stardust = (select sum(amount) from public.stardust_ledger where user_id = $1) where user_id = $1',
    [alice.id],
  );
};

const shop = async () => shopResponseSchema.parse(await (await call(app, alice, '/api/shop')).json());
const buy = (body: unknown) => call(app, alice, '/api/shop/buy', { method: 'POST', body });
const collection = async () => collectionResponseSchema.parse(await (await call(app, alice, '/api/collection')).json());

describe('the shop', () => {
  it('offers four items and the services, and sells only for stardust the account has', async () => {
    const before = await shop();
    expect(before).toMatchObject({ available: true, stardust: 0 });
    expect(before.items).toHaveLength(4);
    expect(before.services.map((service) => service.kind)).toEqual(['freeze', 'boost', 'repair', 'slot']);

    const item = before.items[0]!;
    const poor = await buy({ kind: 'item', item: item.item });
    expect(poor.status).toBe(409);
    expect(await poor.json()).toMatchObject({ error: { code: 'insufficient' } });

    await grant(item.price + 10);
    const bought = await buy({ kind: 'item', item: item.item });
    expect(bought.status).toBe(200);
    const after = shopResponseSchema.parse(await bought.json());
    expect(after.stardust).toBe(10);
    expect(after.items.find((each) => each.item === item.item)?.owned).toBe(true);
    expect((await buy({ kind: 'item', item: item.item })).status).toBe(409);
  });

  it('refuses what is not on sale today', async () => {
    await grant(5000);
    const today = new Set((await shop()).items.map((each) => each.item));
    const elsewhere = ['frame_moon', 'frame_frost', 'frame_dusk', 'frame_aurora', 'frame_comet'].find((id) => !today.has(id))!;
    expect((await buy({ kind: 'item', item: elsewhere })).status).toBe(400);
  });

  it('sells a boost that doubles XP for 15 minutes', async () => {
    await grant(150);
    expect((await buy({ kind: 'boost' })).status).toBe(200);
    const game = gameResponseSchema.parse(await (await call(app, alice, '/api/game')).json());
    expect(Date.parse(game.economy!.boostUntil!) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(game.economy!.stardust).toBe(0);
  });
});

describe('the collection', () => {
  it('gives a first companion once, and leads only owned companions within the slots', async () => {
    expect((await collection()).leading).toEqual([]);
    const chosen = await call(app, alice, '/api/collection/starter', { method: 'POST', body: { pet: 'pet_owl' } });
    expect(collectionResponseSchema.parse(await chosen.json())).toMatchObject({ leading: ['pet_owl'], slots: 1 });
    expect((await call(app, alice, '/api/collection/starter', { method: 'POST', body: { pet: 'pet_fox' } })).status).toBe(409);
    expect((await call(app, alice, '/api/collection/equip', { method: 'POST', body: { pets: ['pet_fox'] } })).status).toBe(400);
    expect((await call(app, alice, '/api/collection/equip', { method: 'POST', body: { pets: [] } })).status).toBe(200);
    expect((await collection()).leading).toEqual([]);
  });

  it('wears on the profile only a frame the account owns', async () => {
    await call(app, alice, '/api/profile');
    expect((await call(app, alice, '/api/profile', { method: 'PUT', body: { frame: 'frame_moon' } })).status).toBe(400);
    await db.admin(`insert into public.inventory (user_id, item_id, source) values ($1, 'frame_moon', 'test')`, [alice.id]);
    const worn = await call(app, alice, '/api/profile', { method: 'PUT', body: { frame: 'frame_moon' } });
    expect(profileResponseSchema.parse(await worn.json()).frame).toBe('frame_moon');
  });
});

describe('chests', () => {
  it('open as they are claimed, once', async () => {
    await call(app, alice, '/api/game');
    await db.admin(
      `insert into public.game_rewards (id, user_id, kind, payload) values (gen_random_uuid(), $1, 'chest', '{"rarity":"rare"}')`,
      [alice.id],
    );
    const reply = await call(app, alice, '/api/game/claim', { method: 'POST', body: { ids: 'all' } });
    const body: unknown = await reply.json();
    expect(reply.status, JSON.stringify(body)).toBe(200);
    const claimed = gameResponseSchema.parse(body);
    expect(claimed.opened).toHaveLength(1);
    expect(claimed.opened![0]!.contents.rarity).toBe('rare');
    expect(claimed.economy!.stardust).toBeGreaterThanOrEqual(100);
    const again = gameResponseSchema.parse(
      await (await call(app, alice, '/api/game/claim', { method: 'POST', body: { ids: 'all' } })).json(),
    );
    expect(again.opened).toEqual([]);
    expect(again.economy!.stardust).toBe(claimed.economy!.stardust);
  });
});

describe('the weekly boss', () => {
  it('says why there is none without enough weak words', async () => {
    const boss = (await (await call(app, alice, '/api/boss')).json()) as { available: boolean; reason: string };
    expect(boss).toMatchObject({ available: false, reason: expect.stringContaining('five weak words') });
  });
});
