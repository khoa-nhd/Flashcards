import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createAppApi, fetchAppConfig, type ApiAuth } from '../../src/lib/api-client.js';
import { vocabularyList } from '../helpers/fake-api.js';

type Reply = { status: number; body: unknown };

/** Replaces `fetch` with one that answers from a script and records what it was sent. */
function stubFetch(...replies: Reply[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const queue = [...replies];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const reply = queue.shift() ?? { status: 500, body: null };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
  return calls;
}

function signedIn(tokens: Array<string | null>) {
  const auth = {
    token: vi.fn<ApiAuth['token']>(async () => tokens.shift() ?? null),
    onRejected: vi.fn<ApiAuth['onRejected']>(),
  };
  return auth;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const refused: Reply = { status: 401, body: { error: { code: 'unauthorized', message: 'Your session has expired. Sign in again.' } } };
const list = vocabularyList([]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('without accounts', () => {
  it('sends no credentials of its own', async () => {
    const calls = stubFetch(ok(list));
    await createAppApi().fetchVocabulary();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
    expect(calls[0]?.headers).not.toHaveProperty('X-Time-Zone');
  });

  it('reports a 401 as it is, for the password screen to handle', async () => {
    stubFetch({ status: 401, body: { error: { code: 'unauthorized', message: 'Enter the access password to continue.' } } });
    await expect(createAppApi().fetchVocabulary()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });
});

describe('with accounts', () => {
  it('sends the signed-in user’s token and the device time zone with every request', async () => {
    const calls = stubFetch(ok(list));
    const auth = signedIn(['token.one.x']);
    await createAppApi(auth).fetchVocabulary();
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer token.one.x' });
    expect(calls[0]?.headers['X-Time-Zone']).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(auth.onRejected).not.toHaveBeenCalled();
  });

  it('renews a refused token once and repeats the request', async () => {
    const calls = stubFetch(refused, ok({ outcome: 'applied', state: { mastery: 4, nextReview: '2026-10-12' } }));
    const auth = signedIn(['token.old.x', 'token.new.x']);
    const body = {
      pageId: '00000000-0000-4000-8000-000000000001',
      action: 'remember' as const,
      expected: { mastery: 3, nextReview: '2026-10-09' },
      requestId: '11111111-1111-4111-8111-111111111111',
    };
    await expect(createAppApi(auth).submitAction(body)).resolves.toMatchObject({ outcome: 'applied' });

    expect(calls.map((call) => call.headers.Authorization)).toEqual(['Bearer token.old.x', 'Bearer token.new.x']);
    expect(auth.token).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    // The repeat carries the same request id, so the server would recognise it either way.
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(auth.onRejected).not.toHaveBeenCalled();
  });

  it('ends the session when a renewed token is refused as well', async () => {
    const calls = stubFetch(refused, refused);
    const auth = signedIn(['token.old.x', 'token.new.x']);
    await expect(createAppApi(auth).fetchVocabulary()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    expect(calls).toHaveLength(2);
    expect(auth.onRejected).toHaveBeenCalledTimes(1);
  });

  it('ends the session when the token cannot be renewed', async () => {
    const calls = stubFetch(refused);
    const auth = signedIn(['token.old.x', null]);
    await expect(createAppApi(auth).fetchVocabulary()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls).toHaveLength(1);
    expect(auth.onRejected).toHaveBeenCalledTimes(1);
  });

  it('sends nothing at all when nobody is signed in', async () => {
    const calls = stubFetch(ok(list));
    const auth = signedIn([null]);
    await expect(createAppApi(auth).fetchVocabulary()).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual([]);
    expect(auth.onRejected).toHaveBeenCalledTimes(1);
  });

  it('treats being offline as a connection problem, not as being signed out', async () => {
    const calls = stubFetch(ok(list));
    const auth = {
      token: vi.fn<ApiAuth['token']>(async () => {
        throw new Error('offline');
      }),
      onRejected: vi.fn<ApiAuth['onRejected']>(),
    };
    await expect(createAppApi(auth).fetchVocabulary()).rejects.toMatchObject({ code: 'network' });
    expect(calls).toEqual([]);
    expect(auth.onRejected).not.toHaveBeenCalled();
  });

  it('does not end the session over an ordinary error', async () => {
    stubFetch({ status: 503, body: { error: { code: 'database_unavailable', message: 'Try again shortly.' } } });
    const auth = signedIn(['token.one.x']);
    await expect(createAppApi(auth).fetchVocabulary()).rejects.toMatchObject({ code: 'database_unavailable', status: 503 });
    expect(auth.onRejected).not.toHaveBeenCalled();
  });

  it('reads and saves account settings, and lists the trash', async () => {
    const settings = { timeZone: 'UTC', timeZoneEditable: true, email: 'me@example.test' };
    const calls = stubFetch(ok(settings), ok({ ...settings, timeZone: 'Asia/Tokyo' }), ok({ entries: [] }));
    const api = createAppApi(signedIn(['a.b.c', 'a.b.c', 'a.b.c']));

    await expect(api.fetchSettings()).resolves.toEqual(settings);
    await expect(api.saveSettings({ timeZone: 'Asia/Tokyo' })).resolves.toMatchObject({ timeZone: 'Asia/Tokyo' });
    await expect(api.fetchTrash()).resolves.toEqual([]);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/settings', 'PUT /api/settings', 'GET /api/trash']);
    expect(calls[1]?.body).toEqual({ timeZone: 'Asia/Tokyo' });
  });
});

describe('asking how to sign in', () => {
  it('is done without a token, before anyone is signed in', async () => {
    const config = { mode: 'supabase', auth: 'account', supabase: { url: 'https://project.supabase.co', publicKey: 'sb_publishable_x' } };
    const calls = stubFetch(ok(config));
    await expect(fetchAppConfig()).resolves.toEqual(config);
    expect(calls[0]?.url).toBe('/api/config');
    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
  });
});
