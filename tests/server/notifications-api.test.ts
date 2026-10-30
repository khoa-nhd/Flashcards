/**
 * Reminders through the real routes and sessions: an account keeps its own
 * choices and devices; the timer's endpoint answers only CRON_TOKEN.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notificationsResponseSchema } from '../../shared/api.js';
import { createApp } from '../../server/create-app.js';
import { loadConfig } from '../../server/env.js';
import { SUPABASE_ENV, call, createSupabaseTestApp, createTestUser, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const VAPID = {
  VAPID_PUBLIC_KEY: 'BPublicKeyForTests0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  VAPID_PRIVATE_KEY: 'private-key-for-tests',
};

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
  app = createSupabaseTestApp(db, [alice, bob], { env: VAPID });
});

const view = async (user: TestUser) => notificationsResponseSchema.parse(await (await call(app, user, '/api/notifications')).json());
const device = { endpoint: 'https://push.example/alice', keys: { p256dh: 'key', auth: 'auth' } };

describe('an account’s reminders', () => {
  it('start with the plan’s defaults and the server’s public key', async () => {
    expect(await view(alice)).toMatchObject({
      available: true,
      publicKey: VAPID.VAPID_PUBLIC_KEY,
      settings: { streak: true, league: true, reminder: true, social: true, reminderAt: '19:00', quietFrom: '23:00', quietUntil: '07:00' },
      devices: [],
    });
  });

  it('keep the account’s own choices and devices', async () => {
    const saved = await call(app, alice, '/api/notifications', { method: 'PUT', body: { league: false, reminderAt: '08:30' } });
    expect(notificationsResponseSchema.parse(await saved.json()).settings).toMatchObject({
      league: false,
      reminderAt: '08:30',
      streak: true,
    });
    await call(app, alice, '/api/notifications/subscribe', { method: 'POST', body: device });
    expect((await view(alice)).devices).toEqual([device.endpoint]);
    expect(await view(bob)).toMatchObject({ devices: [], settings: { league: true } });
    await call(app, alice, '/api/notifications/unsubscribe', { method: 'POST', body: { endpoint: device.endpoint } });
    expect((await view(alice)).devices).toEqual([]);
  });

  it('refuse a time that is not one, and an address that is not https', async () => {
    expect((await call(app, alice, '/api/notifications', { method: 'PUT', body: { reminderAt: '25:00' } })).status).toBe(400);
    expect(
      (await call(app, alice, '/api/notifications/subscribe', { method: 'POST', body: { ...device, endpoint: 'http://push.example/x' } }))
        .status,
    ).toBe(400);
  });

  it('say why when the server has no VAPID keys', async () => {
    const plain = createSupabaseTestApp(db, [alice], {});
    const reply = notificationsResponseSchema.parse(await (await call(plain, alice, '/api/notifications')).json());
    expect(reply).toMatchObject({ available: false, reason: expect.stringContaining('VAPID') });
  });
});

describe('the timer’s endpoint', () => {
  const secret = 'c'.repeat(40);
  const timerApp = (run = async () => ({ people: 0, sent: 0, gone: 0, failed: 0 })) =>
    createApp({ config: loadConfig({ ...SUPABASE_ENV, CRON_TOKEN: secret }), service: null, reminders: { run } });
  const hit = (target: ReturnType<typeof timerApp>, token: string | null) =>
    target.request('/api/cron/notify', { method: 'POST', headers: token === null ? {} : { Authorization: `Bearer ${token}` } });

  it('runs for the secret, and only for it', async () => {
    let runs = 0;
    const target = timerApp(async () => {
      runs += 1;
      return { people: 2, sent: 1, gone: 0, failed: 0 };
    });
    expect((await hit(target, null)).status).toBe(401);
    expect((await hit(target, 'x'.repeat(40))).status).toBe(401);
    expect(runs).toBe(0);
    const ok = await hit(target, secret);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ people: 2, sent: 1, gone: 0, failed: 0 });
  });

  it('says it is not set up without a secret', async () => {
    const bare = createApp({ config: loadConfig(SUPABASE_ENV), service: null });
    expect((await bare.request('/api/cron/notify', { method: 'POST' })).status).toBe(503);
  });
});
