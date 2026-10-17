import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/bootstrap.js';
import { createApp } from '../../server/create-app.js';
import { loadConfig, type AppConfig } from '../../server/env.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { ReviewService } from '../../server/review-service.js';
import { DatabaseError } from '../../server/supabase/supabase-database.js';
import { apiErrorSchema, queueResponseSchema, reviewActionResponseSchema } from '../../shared/api.js';
import { FakeRepository, NOW, TEST_FIELDS, TIME_ZONE, pageId, record } from '../helpers/fixtures.js';

const shown = { mastery: 3, nextReview: '2026-10-01' };

function setup(configOverrides: Partial<AppConfig> = {}, env: Record<string, string> = {}) {
  const repository = new FakeRepository([record(1, shown), record(2)]);
  const service = new ReviewService({
    repository,
    rules: sampleRules,
    cardFields: TEST_FIELDS,
    timeZone: TIME_ZONE,
    writesRequested: true,
    now: () => NOW,
  });
  const config = { ...loadConfig({ DATA_MODE: 'mock', ...env }), ...configOverrides };
  const app = createApp({ config, service });
  return { app, repository, service, config };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const validAction = {
  pageId: pageId(1),
  action: 'remember',
  expected: shown,
  requestId: '11111111-1111-4111-8111-111111111111',
};

describe('GET /api/review-queue', () => {
  it('returns a queue that satisfies the shared schema', async () => {
    const { app } = setup();
    const response = await app.request('/api/review-queue');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const queue = queueResponseSchema.parse(await response.json());
    expect(queue.cards.map((item) => item.id)).toEqual([pageId(1), pageId(2)]);
  });

  it('answers 503 with the reasons when the server is not configured', async () => {
    const config = loadConfig({ DATA_MODE: 'supabase' });
    const app = createApp({ config, service: null });
    const response = await app.request('/api/review-queue');
    expect(response.status).toBe(503);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('setup_incomplete');
    expect(body.error.message).toContain('SUPABASE_URL');
  });

  it('refuses to run on a data source that no longer exists, rather than guess another', async () => {
    const { app, config } = buildApp({ DATA_MODE: 'notion', NODE_ENV: 'production' });
    expect(config.issues).toEqual(expect.arrayContaining([expect.stringContaining('DATA_MODE must be')]));
    const response = await app.request('/api/review-queue', { headers: { Authorization: 'Bearer a.b.c' } });
    expect(response.status).toBe(503);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('setup_incomplete');
  });
});

describe('POST /api/review-action', () => {
  it('applies a valid answer', async () => {
    const { app, repository } = setup();
    const response = await app.request('/api/review-action', post(validAction));
    expect(response.status).toBe(200);
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'applied',
      state: { mastery: 4, nextReview: '2026-10-13' },
    });
    expect(repository.updates).toHaveLength(1);
  });

  it('still accepts an answer from a page loaded before request ids existed', async () => {
    const { app, repository } = setup();
    const { requestId: _requestId, ...older } = validAction;
    void _requestId;
    const response = await app.request('/api/review-action', post(older));
    expect(response.status).toBe(200);
    expect(reviewActionResponseSchema.parse(await response.json()).outcome).toBe('applied');
    // Sent again, it is recognised by the state it expected, as it always was.
    const retry = await app.request('/api/review-action', post(older));
    expect(reviewActionResponseSchema.parse(await retry.json()).outcome).toBe('already_applied');
    expect(repository.updates).toHaveLength(1);
  });

  it.each([
    ['an unknown action', { ...validAction, action: 'forget' }],
    ['a request id that is not a UUID', { ...validAction, requestId: 'again' }],
    ['a negative duration', { ...validAction, durationMs: -1 }],
    ['a malformed page id', { ...validAction, pageId: 'not-an-id' }],
    ['a missing expected state', { pageId: pageId(1), action: 'remember' }],
    ['a non-numeric mastery', { ...validAction, expected: { mastery: '3', nextReview: '2026-10-01' } }],
    ['an invalid date', { ...validAction, expected: { mastery: 3, nextReview: '2026-02-30' } }],
    ['an empty body', {}],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    const { app, repository } = setup();
    const response = await app.request('/api/review-action', post(body));
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('invalid_request');
    expect(repository.updates).toEqual([]);
  });

  it('rejects attempts to set arbitrary properties', async () => {
    const { app, repository } = setup();
    for (const extra of [{ properties: { Word: 'hacked' } }, { mastery: 10 }, { nextReview: '2030-01-01' }]) {
      const response = await app.request('/api/review-action', post({ ...validAction, ...extra }));
      expect(response.status).toBe(400);
    }
    expect(repository.updates).toEqual([]);
  });

  it('rejects a body that is not JSON', async () => {
    const { app } = setup();
    const response = await app.request('/api/review-action', post('{not json'));
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('invalid_json');
  });

  it('rejects an oversized body', async () => {
    const { app } = setup();
    const response = await app.request('/api/review-action', post({ ...validAction, padding: 'x'.repeat(200_000) }));
    expect(response.status).toBe(413);
  });

  it('answers 409 with the current state on a conflict', async () => {
    const { app, repository } = setup();
    repository.editElsewhere(pageId(1), { mastery: 7 });
    const response = await app.request('/api/review-action', post(validAction));
    expect(response.status).toBe(409);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('conflict');
    expect(body.current).toEqual({ mastery: 7, nextReview: '2026-10-01' });
  });

  it('answers 404 for a record outside the database', async () => {
    const { app } = setup();
    const response = await app.request('/api/review-action', post({ ...validAction, pageId: pageId(77) }));
    expect(response.status).toBe(404);
  });

  it('reports a database outage as temporary, and a missing schema as a setup problem', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, repository } = setup();
    repository.getRecord = async () => {
      throw new DatabaseError('unavailable', 'The database is temporarily unavailable.', '57P03');
    };
    const outage = await app.request('/api/review-action', post(validAction));
    expect(outage.status).toBe(503);
    expect(apiErrorSchema.parse(await outage.json()).error.code).toBe('database_unavailable');

    repository.getRecord = async () => {
      throw new DatabaseError('schema_missing', 'The database schema is not installed.', '42P01');
    };
    const missing = await app.request('/api/review-action', post(validAction));
    expect(missing.status).toBe(503);
    expect(apiErrorSchema.parse(await missing.json()).error.code).toBe('setup_incomplete');
    expect(repository.updates).toEqual([]);
  });

  it('hides the detail of unexpected errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, repository } = setup();
    repository.getRecord = async () => {
      throw new Error('secret_abc123 leaked from a stack trace');
    };
    const response = await app.request('/api/review-action', post(validAction));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('secret_abc123');
    expect(apiErrorSchema.parse(JSON.parse(text)).error.code).toBe('internal_error');
  });

  it('refuses cross-site requests', async () => {
    const { app, repository } = setup();
    const response = await app.request(
      'http://flashcards.test/api/review-action',
      post(validAction, { Origin: 'https://evil.example', Host: 'flashcards.test' }),
    );
    expect(response.status).toBe(403);
    expect(repository.updates).toEqual([]);
    const sameSite = await app.request(
      'http://flashcards.test/api/review-action',
      post(validAction, { Origin: 'http://flashcards.test', Host: 'flashcards.test' }),
    );
    expect(sameSite.status).toBe(200);
  });
});

describe('access', () => {
  it('needs no sign-in for the built-in sample words', async () => {
    const { app } = setup();
    expect((await app.request('/api/review-queue')).status).toBe(200);
    expect(await (await app.request('/api/config')).json()).toEqual({ mode: 'mock', auth: 'none', supabase: null });
  });

  it('has no shared-password endpoints any more', async () => {
    const { app } = setup();
    expect((await app.request('/api/login', post({ password: 'anything' }))).status).toBe(404);
    expect((await app.request('/api/logout', post({}))).status).toBe(404);
  });

  it('keeps the health endpoint public but free of sensitive detail', async () => {
    const { app } = setup();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: 'mock', access: 'open', writesRequested: true, issues: [] });
  });

  it('reports the sample data’s time zone, and does not pretend it can be changed', async () => {
    const { app, config } = setup();
    expect(await (await app.request('/api/settings')).json()).toEqual({
      timeZone: config.timeZone,
      timeZoneEditable: false,
      email: null,
      database: null,
      fsrsRetention: null,
      countReviewsTowardMastery: true,
    });
    const change = await app.request('/api/settings', { ...post({ timeZone: 'UTC' }), method: 'PUT' });
    expect(change.status).toBe(409);
  });
});

describe('unknown routes', () => {
  it('answers 404 as JSON', async () => {
    const { app } = setup();
    const response = await app.request('/api/nope');
    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('not_found');
  });
});
