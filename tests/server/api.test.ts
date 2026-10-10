import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/create-app.js';
import { loadConfig, type AppConfig } from '../../server/env.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { NotionRequestError } from '../../server/notion/notion-errors.js';
import { ReviewService } from '../../server/review-service.js';
import { apiErrorSchema, queueResponseSchema, reviewActionResponseSchema } from '../../shared/api.js';
import { FakeRepository, NOW, TIME_ZONE, pageId, record } from '../helpers/fixtures.js';
import { TEST_FIELDS } from '../helpers/notion-fixtures.js';

const ACCESS_PASSWORD = 'correct horse battery staple';
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
  const app = createApp({ config, service, now: () => NOW });
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
    const config = loadConfig({ DATA_MODE: 'notion' });
    const app = createApp({ config, service: null });
    const response = await app.request('/api/review-queue');
    expect(response.status).toBe(503);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('setup_incomplete');
    expect(body.error.message).toContain('NOTION_API_KEY');
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
    repository.editInNotion(pageId(1), { mastery: 7 });
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

  it('passes on Notion rate limiting with a Retry-After header', async () => {
    const { app, repository } = setup();
    repository.getRecord = async () => {
      throw new NotionRequestError('rate_limited', 'Notion is rate limiting requests.', 7);
    };
    const response = await app.request('/api/review-action', post(validAction));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('rate_limited');
  });

  it('maps a Notion outage to 502 and a timeout to 504', async () => {
    const { app, repository } = setup();
    repository.getRecord = async () => {
      throw new NotionRequestError('unavailable', 'Notion is temporarily unavailable.');
    };
    expect((await app.request('/api/review-action', post(validAction))).status).toBe(502);
    repository.getRecord = async () => {
      throw new NotionRequestError('timeout', 'Notion took too long to respond.');
    };
    expect((await app.request('/api/review-action', post(validAction))).status).toBe(504);
  });

  it('hides the detail of unexpected errors', async () => {
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

describe('access control', () => {
  const login = (app: ReturnType<typeof setup>['app'], password: string) =>
    app.request('/api/login', post({ password }));

  const cookieFrom = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  it('is open on a local development server with no password', async () => {
    const { app } = setup();
    expect((await app.request('/api/review-queue')).status).toBe(200);
  });

  it('fails closed in production when nothing protects the app', async () => {
    const { app, repository } = setup({ isProduction: true });
    const queue = await app.request('/api/review-queue');
    expect(queue.status).toBe(503);
    expect(apiErrorSchema.parse(await queue.json()).error.code).toBe('access_not_configured');
    expect((await app.request('/api/review-action', post(validAction))).status).toBe(503);
    expect(repository.updates).toEqual([]);
  });

  it('can be opened in production only by an explicit opt-out', async () => {
    const { app } = setup({ isProduction: true, allowUnauthenticated: true });
    expect((await app.request('/api/review-queue')).status).toBe(200);
  });

  it('requires the password for both reading and writing', async () => {
    const { app, repository } = setup({ accessPassword: ACCESS_PASSWORD });
    const queue = await app.request('/api/review-queue');
    expect(queue.status).toBe(401);
    expect(apiErrorSchema.parse(await queue.json()).error.code).toBe('unauthorized');
    expect((await app.request('/api/review-action', post(validAction))).status).toBe(401);
    expect(repository.updates).toEqual([]);
  });

  it('grants a session cookie for the right password', async () => {
    const { app } = setup({ accessPassword: ACCESS_PASSWORD, isProduction: true });
    const response = await login(app, ACCESS_PASSWORD);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).not.toContain(ACCESS_PASSWORD);

    const queue = await app.request('/api/review-queue', { headers: { Cookie: cookieFrom(response) } });
    expect(queue.status).toBe(200);
  });

  it('rejects a wrong password and a forged or expired cookie', async () => {
    const { app, config } = setup({ accessPassword: ACCESS_PASSWORD });
    expect((await login(app, 'wrong')).status).toBe(401);

    const forged = await app.request('/api/review-queue', {
      headers: { Cookie: 'flashcard_session=9999999999.forged-signature' },
    });
    expect(forged.status).toBe(401);

    // A cookie issued 31 days ago has outlived the 30-day session.
    const repository = new FakeRepository([record(1)]);
    const service = new ReviewService({
      repository,
      rules: sampleRules,
      cardFields: TEST_FIELDS,
      timeZone: TIME_ZONE,
      writesRequested: true,
    });
    const longAgo = new Date(NOW.getTime() - 31 * 86_400_000);
    const past = createApp({ config, service, now: () => longAgo });
    const stale = cookieFrom(await login(past, ACCESS_PASSWORD));
    expect((await app.request('/api/review-queue', { headers: { Cookie: stale } })).status).toBe(401);
  });

  it('throttles repeated wrong passwords', async () => {
    const { app } = setup({ accessPassword: ACCESS_PASSWORD });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(app, `guess-${attempt}`)).status).toBe(401);
    }
    const blocked = await login(app, ACCESS_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('keeps the health endpoint public but free of sensitive detail', async () => {
    const { app } = setup({ accessPassword: ACCESS_PASSWORD }, { NOTION_API_KEY: 'secret_test_value' });
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, access: 'password' });
    expect(text).not.toContain('secret_test_value');
    expect(text).not.toContain(ACCESS_PASSWORD);
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
