/**
 * The chest routes: chống gian lận is only as good as what these prove — the
 * server, not the browser, decides what falls out; a retried request opens one
 * chest, not two; and a burst of clicks is stopped before it reaches the rolls.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/create-app.js';
import { loadConfig } from '../../server/env.js';
import {
  EMPTY_SNAPSHOT,
  GACHA_OPENS_PER_WINDOW,
  GachaService,
  createMemoryGachaStore,
  resetGachaRateLimit,
  type GachaSnapshot,
  type GachaStore,
} from '../../server/gacha-service.js';
import { apiErrorSchema, gachaApiStateSchema, gachaOpenResponseSchema } from '../../shared/api.js';
import { GACHA_KEYS_PER_DAY, GACHA_KEY_CAP, seededRandom } from '../../shared/gacha.js';
import { NOW, TIME_ZONE, TODAY } from '../helpers/fixtures.js';

let accounts = 0;

function setup(state: Partial<GachaSnapshot> = {}) {
  accounts += 1;
  const store: GachaStore = createMemoryGachaStore({ ...EMPTY_SNAPSHOT, ...state });
  const gacha = new GachaService({
    store,
    accountId: `account-${accounts}`,
    timeZone: TIME_ZONE,
    now: () => NOW,
    random: seededRandom(4242),
  });
  const app = createApp({ config: loadConfig({ DATA_MODE: 'mock' }), service: null, gacha });
  return { app, store, gacha };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  resetGachaRateLimit();
});

describe('GET /api/gacha', () => {
  it('grants the daily keys once and then keeps quiet', async () => {
    const { app } = setup({ keys: 2, lastGrantDay: null });
    const first = gachaApiStateSchema.parse(await (await app.request('/api/gacha')).json());
    expect(first.keys).toBe(2 + GACHA_KEYS_PER_DAY);
    expect(first.dailyKeysAvailable).toBe(false);

    const second = gachaApiStateSchema.parse(await (await app.request('/api/gacha')).json());
    expect(second.keys).toBe(2 + GACHA_KEYS_PER_DAY);
  });

  it('does not grant twice on the same day', async () => {
    const { app } = setup({ keys: 7, lastGrantDay: TODAY });
    const state = gachaApiStateSchema.parse(await (await app.request('/api/gacha')).json());
    expect(state.keys).toBe(7);
  });

  it('never grants past the key cap', async () => {
    const { app } = setup({ keys: GACHA_KEY_CAP - 1, lastGrantDay: null });
    const state = gachaApiStateSchema.parse(await (await app.request('/api/gacha')).json());
    expect(state.keys).toBe(GACHA_KEY_CAP);
  });
});

describe('POST /api/gacha/open', () => {
  it('spends one key, rolls on the server and records the item', async () => {
    const { app } = setup({ keys: 5, lastGrantDay: TODAY });
    const response = await app.request('/api/gacha/open', post({ chestId: 'wooden', count: 1, requestId: requestId(1) }));
    expect(response.status).toBe(200);
    const body = gachaOpenResponseSchema.parse(await response.json());
    expect(body.results).toHaveLength(1);
    expect(body.state.keys).toBe(4);
    expect(body.state.opens).toBe(1);
    expect(body.state.inventory.length + body.results.filter((result) => result.duplicate).length).toBeGreaterThan(0);
  });

  it('opens ten and charges for ten', async () => {
    const { app } = setup({ keys: 12, lastGrantDay: TODAY });
    const body = gachaOpenResponseSchema.parse(
      await (await app.request('/api/gacha/open', post({ chestId: 'wooden', count: 10, requestId: requestId(2) }))).json(),
    );
    expect(body.results).toHaveLength(10);
    expect(body.state.keys).toBe(2);
    expect(body.state.opens).toBe(10);
  });

  it('answers the same opening for a retried request id, spending nothing more', async () => {
    const { app } = setup({ keys: 5, lastGrantDay: TODAY });
    const body = { chestId: 'silver', count: 1, requestId: requestId(3) };
    const first = gachaOpenResponseSchema.parse(await (await app.request('/api/gacha/open', post(body))).json());
    const again = gachaOpenResponseSchema.parse(await (await app.request('/api/gacha/open', post(body))).json());
    expect(again.results).toEqual(first.results);
    expect(again.state.keys).toBe(first.state.keys);
    expect(again.state.opens).toBe(first.state.opens);
  });

  it('refuses a chest the account cannot afford', async () => {
    const { app } = setup({ keys: 2, lastGrantDay: TODAY });
    const response = await app.request('/api/gacha/open', post({ chestId: 'golden', count: 1, requestId: requestId(4) }));
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('insufficient_keys');
  });

  it('refuses an unknown chest and an impossible batch', async () => {
    const { app } = setup({ keys: 50, lastGrantDay: TODAY });
    for (const body of [
      { chestId: 'plastic', count: 1, requestId: requestId(5) },
      { chestId: 'wooden', count: 11, requestId: requestId(6) },
      { chestId: 'wooden', count: 0, requestId: requestId(7) },
      { chestId: 'wooden', count: 1, requestId: 'not-a-uuid' },
    ]) {
      const response = await app.request('/api/gacha/open', post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('stops a burst of clicks with a Retry-After, before it reaches the rolls', async () => {
    const { app } = setup({ keys: 40, lastGrantDay: TODAY });
    let limited: Response | null = null;
    for (let index = 0; index < GACHA_OPENS_PER_WINDOW + 1; index += 1) {
      const response = await app.request(
        '/api/gacha/open',
        post({ chestId: 'wooden', count: 1, requestId: requestId(100 + index) }),
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(apiErrorSchema.parse(await limited!.json()).error.code).toBe('too_many_requests');
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('lets only one of two racing openings with one key through', async () => {
    const { app } = setup({ keys: 1, lastGrantDay: TODAY });
    const [a, b] = await Promise.all([
      app.request('/api/gacha/open', post({ chestId: 'wooden', count: 1, requestId: requestId(200) })),
      app.request('/api/gacha/open', post({ chestId: 'wooden', count: 1, requestId: requestId(201) })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const state = gachaApiStateSchema.parse(await (await app.request('/api/gacha')).json());
    expect(state.keys).toBe(0);
    expect(state.opens).toBe(1);
  });
});

describe('POST /api/gacha/exchange', () => {
  it('turns shards into a key', async () => {
    const { app } = setup({ keys: 0, shards: 25, lastGrantDay: TODAY });
    const body = gachaOpenResponseSchema.parse(
      await (await app.request('/api/gacha/exchange', post({ keys: 1, requestId: requestId(300) }))).json(),
    );
    expect(body.state.keys).toBe(1);
    expect(body.state.shards).toBe(15);
    expect(body.results).toEqual([]);
  });

  it('refuses when there are not enough shards', async () => {
    const { app } = setup({ keys: 0, shards: 3, lastGrantDay: TODAY });
    const response = await app.request('/api/gacha/exchange', post({ keys: 1, requestId: requestId(301) }));
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('not_enough_shards');
  });
});

describe('without the newest database', () => {
  it('says the chests need an update rather than pretending they exist', async () => {
    const app = createApp({ config: loadConfig({ DATA_MODE: 'mock' }), service: null, gacha: null });
    const response = await app.request('/api/gacha');
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('not_supported');
  });
});
