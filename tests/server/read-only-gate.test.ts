/**
 * The saving switch (REVIEW_WRITES_ENABLED) applies to every write, not only
 * reviews and vocabulary. A frozen account can still read everything, and
 * three stored settings — the daily goal, which schedule is in charge, and
 * the account's own settings — are refused with read_only like every other
 * write. Through the HTTP API on the real schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, createSupabaseTestApp, createTestUser, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;

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
});

const TODAY = '2026-10-09';
const on = (day: string, database: TestDatabase = db, users: TestUser[] = [alice, bob], env?: Record<string, string>) =>
  createSupabaseTestApp(database, users, { now: () => new Date(`${day}T05:00:00Z`), env });

const errorCode = async (response: Response): Promise<string> => ((await response.json()) as { error: { code: string } }).error.code;

/** Every write path that used to slip past the switch. */
const writes = (app: TestApp, user: TestUser) => [
  call(app, user, '/api/goal', { method: 'PUT', body: { reviews: 20, minutes: null } }),
  call(app, user, '/api/scheduler', { method: 'PUT', body: { scheduler: 'fsrs' } }),
  call(app, user, '/api/settings', { method: 'PUT', body: { timeZone: 'Asia/Bangkok' } }),
];

describe('with saving switched off', () => {
  it('refuses the goal, the scheduler choice and the account settings with read_only', async () => {
    const frozen = on(TODAY, db, [alice, bob], { REVIEW_WRITES_ENABLED: 'false' });
    for (const response of await Promise.all(writes(frozen, alice))) {
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('read_only');
    }
  });

  it('leaves everything exactly as it was: the goal unset, the schedule unchanged, reads fine', async () => {
    const frozen = on(TODAY, db, [alice, bob], { REVIEW_WRITES_ENABLED: 'false' });
    await writes(frozen, alice);
    const plan = (await (await call(frozen, alice, '/api/plan')).json()) as { goal: { reviews: number | null } };
    expect(plan.goal.reviews).toBeNull();
    const scheduler = (await (await call(frozen, alice, '/api/scheduler')).json()) as { active: string };
    expect(scheduler.active).toBe('mastery_v1');
    expect((await call(frozen, alice, '/api/settings')).status).toBe(200);
  });
});

describe('with saving switched on', () => {
  it('accepts the same three writes and stores them', async () => {
    const app = on(TODAY);
    const goal = (await (await call(app, alice, '/api/goal', { method: 'PUT', body: { reviews: 20, minutes: null } })).json()) as {
      goal: { reviews: number | null };
    };
    expect(goal.goal.reviews).toBe(20);
    const scheduler = (await (
      await call(app, alice, '/api/scheduler', { method: 'PUT', body: { scheduler: 'fsrs' } })
    ).json()) as { active: string };
    expect(scheduler.active).toBe('fsrs');
    const settings = (await (
      await call(app, alice, '/api/settings', { method: 'PUT', body: { timeZone: 'Asia/Bangkok' } })
    ).json()) as { timeZone: string };
    expect(settings.timeZone).toBe('Asia/Bangkok');
  });

  it('the same database can still be written through an app with saving on', async () => {
    const app = on(TODAY);
    const frozen = on(TODAY, db, [alice, bob], { REVIEW_WRITES_ENABLED: 'false' });
    const refused = await call(frozen, alice, '/api/goal', { method: 'PUT', body: { reviews: 20, minutes: null } });
    expect(refused.status).toBe(403);
    // The same database, saving on: the write goes through.
    const accepted = await call(app, alice, '/api/goal', { method: 'PUT', body: { reviews: 20, minutes: null } });
    expect(accepted.status).toBe(200);
  });
});
