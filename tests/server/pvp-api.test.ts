/**
 * Word duels through the real routes, sessions, schema and Row Level Security
 * (schema version 21): two accounts are paired, both see the same match, a
 * third sees nothing, answers are judged against sealed answers, and a friend
 * can be invited.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { entryResponseSchema, pvpLobbySchema, pvpMatchSchema, pvpTickSchema } from '../../shared/api.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, readMigrations, type TestDatabase } from '../helpers/test-database.js';

const KEY = 'k'.repeat(64);

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
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
  carol = await createTestUser(db, 'carol');
  app = createSupabaseTestApp(db, [alice, bob, carol], { env: { GAME_SIGNING_KEY: KEY }, now: () => new Date() });
  for (const [user, words] of [
    [alice, ['candid', 'lucid', 'vivid', 'placid']],
    [bob, ['brisk', 'stark', 'terse', 'wry']],
  ] as const) {
    for (const word of words) {
      const reply = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), word, meaning: `nghĩa của ${word}` } });
      entryResponseSchema.parse(await reply.json());
    }
  }
});

const post = (user: TestUser, path: string, body: unknown = {}) => call(app, user, path, { method: 'POST', body });
const lobby = async (user: TestUser) => pvpLobbySchema.parse(await (await call(app, user, '/api/pvp')).json());
const tick = async (user: TestUser) => pvpTickSchema.parse(await (await post(user, '/api/pvp/tick')).json());
const view = async (user: TestUser, id: string) => pvpMatchSchema.parse(await (await post(user, `/api/pvp/match/${id}`)).json());

describe('a ranked match between two players', () => {
  it('pairs them, shows both the same match, and keeps it from anyone else', async () => {
    expect(await lobby(alice)).toMatchObject({ available: true, rating: 1000, consented: false });
    expect((await post(alice, '/api/pvp/queue', { mode: 'ranked' })).status).toBe(409);
    await post(alice, '/api/pvp/consent');
    await post(bob, '/api/pvp/consent');
    expect(pvpTickSchema.parse(await (await post(alice, '/api/pvp/queue', { mode: 'ranked' })).json()).state).toBe('waiting');
    const paired = pvpTickSchema.parse(await (await post(bob, '/api/pvp/queue', { mode: 'ranked' })).json());
    expect(paired.state).toBe('match');
    const found = await tick(alice);
    expect(found).toEqual({ state: 'match', matchId: paired.matchId });

    const forBob = await view(bob, paired.matchId!);
    const forAlice = await view(alice, paired.matchId!);
    expect(forBob.mode).toBe('ranked');
    expect(forAlice.question?.prompt).toBe(forBob.question?.prompt);
    expect(forAlice.them.nickname).toBe(forBob.me.nickname);

    // Carol is in neither side: the match, its questions and its answers are not hers to read.
    expect(await db.as(carol.id, (s) => s.query('select * from public.pvp_matches'))).toEqual([]);
    expect(await db.as(carol.id, (s) => s.query('select * from public.pvp_questions'))).toEqual([]);
    expect((await post(carol, `/api/pvp/match/${paired.matchId}`)).status).toBe(404);

    // The players read the questions, but each answer only as a sealed value.
    const rows = await db.as(alice.id, (s) => s.query<Record<string, unknown>>('select * from public.pvp_questions order by idx limit 1'));
    expect(Object.keys(rows[0]!).sort()).toEqual(['direction', 'idx', 'match_id', 'options', 'prompt', 'sealed']);
  });

  it('judges answers on the server, and ends with both rated once when one gives up', async () => {
    await post(alice, '/api/pvp/consent');
    await post(bob, '/api/pvp/consent');
    await post(alice, '/api/pvp/queue', { mode: 'ranked' });
    const { matchId } = pvpTickSchema.parse(await (await post(bob, '/api/pvp/queue', { mode: 'ranked' })).json());
    const before = await view(alice, matchId!);
    const reply = pvpMatchSchema.parse(await (await post(alice, `/api/pvp/match/${matchId}/answer`, { index: 0, choice: 0 })).json());
    expect(reply.last).toMatchObject({ index: 0 });
    expect(reply.question?.index).toBe(1);
    expect(reply.them.hp + reply.me.hp).toBeLessThanOrEqual(before.them.hp + before.me.hp);

    const gone = pvpMatchSchema.parse(await (await post(bob, `/api/pvp/match/${matchId}/forfeit`)).json());
    expect(gone).toMatchObject({ finished: true, result: 'lost', reason: 'left' });
    const won = await view(alice, matchId!);
    expect(won).toMatchObject({ finished: true, result: 'won' });
    expect(won.reward!.ratingTo).toBeGreaterThan(1000);
    expect((await lobby(alice)).rating).toBe(won.reward!.ratingTo);
    expect((await lobby(bob)).rating).toBeLessThan(1000);
    const rewards = await db.admin<{ user: string }>(`select user_id::text as user from public.game_rewards where kind = 'pvp'`);
    expect(rewards).toHaveLength(2);
    // A word Bob brought, offered to Alice to add.
    expect(won.words.some((word) => ['brisk', 'stark', 'terse', 'wry'].includes(word.word))).toBe(true);
    expect((await lobby(alice)).headToHead).toEqual([expect.objectContaining({ wins: 1, losses: 0 })]);
  });
});

describe('a match with a friend', () => {
  it('needs the two to follow each other, and starts when the friend accepts', async () => {
    const nickname = async (user: TestUser) => ((await (await call(app, user, '/api/profile')).json()) as { nickname: string }).nickname;
    const bobName = await nickname(bob);
    const aliceName = await nickname(alice);
    expect((await post(alice, '/api/pvp/invite', { nickname: bobName })).status).toBe(400);
    await post(alice, '/api/friends/follow', { nickname: bobName });
    await post(bob, '/api/friends/follow', { nickname: aliceName });
    expect((await post(alice, '/api/pvp/invite', { nickname: bobName })).status).toBe(200);
    expect((await lobby(bob)).invites).toEqual([expect.objectContaining({ nickname: aliceName })]);
    const accepted = pvpTickSchema.parse(await (await post(bob, '/api/pvp/accept', { nickname: aliceName })).json());
    expect(accepted.state).toBe('match');
    expect((await view(alice, accepted.matchId!)).mode).toBe('friend');
  });
});

describe('upgrading to version 21', () => {
  it('runs on a database at version 20, and can be run again', async () => {
    const migrations = readMigrations();
    const at = migrations.findIndex((migration) => migration.name.endsWith('_pvp.sql'));
    const old = await createTestDatabase({ migrations: at });
    try {
      await old.db.exec(migrations[at]!.sql);
      await old.db.exec(migrations[at]!.sql);
      expect(await old.admin('select public.app_schema_version() as v')).toEqual([{ v: 21 }]);
    } finally {
      await old.close();
    }
  }, 120_000);
});
