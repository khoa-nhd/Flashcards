/**
 * Word families through the HTTP API on the real schema: the family comes
 * from the model behind an OpenAI-compatible endpoint (a stand-in fetch, no
 * network), every member is a draft the reader reviews before anything is
 * saved, and every way it can fail lands the browser in its fallback —
 * building the family by hand.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

const TODAY = '2026-10-09';
const AI_ENV = { AI_API_KEY: 'test-key', AI_MODEL: 'test-model' };
const on = (day: string, env?: Record<string, string>) =>
  createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${day}T05:00:00Z`), env });
const ask = (app: TestApp, user: TestUser, body: Record<string, unknown>) =>
  call(app, user, '/api/ai/word-family', { method: 'POST', body });

/** The model endpoint as the adapter sees it: a chat reply carrying JSON. */
function modelReplies(content: string, status = 200) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const errorCode = async (response: Response): Promise<string> => ((await response.json()) as { error: { code: string } }).error.code;

const FAMILY = JSON.stringify({
  family: [
    { word: 'decide', gloss: 'quyết định', root: true },
    { word: 'decision', gloss: 'sự quyết định', root: false },
    { word: 'decisive', gloss: 'quyết đoán', root: false },
  ],
});

describe('asking for the words formed from one root', () => {
  it('answers with the family the model suggests, the root among them', async () => {
    const app = on(TODAY, AI_ENV);
    const fetchMock = modelReplies(FAMILY);
    const response = await ask(app, alice, { word: 'decision', meaning: 'sự quyết định' });
    expect(await response.json()).toEqual(JSON.parse(FAMILY));
    // Only the one word and its meaning reach the model; nothing else about the
    // account ever leaves the server.
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const userMessage = sent.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(userMessage).toContain('decision');
    expect(userMessage).toContain('sự quyết định');
  });

  it('rejects a reply that is not shaped like a family, instead of guessing', async () => {
    const app = on(TODAY, AI_ENV);
    modelReplies(JSON.stringify({ words: ['decide'] }));
    const response = await ask(app, alice, { word: 'decision' });
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe('ai_invalid');
  });

  it('lands in the fallback for each other way the model can fail', async () => {
    const app = on(TODAY, AI_ENV);
    modelReplies('not json at all');
    const invalid = await ask(app, alice, { word: 'decision' });
    expect(invalid.status).toBe(502);
    expect(await errorCode(invalid)).toBe('ai_invalid');

    modelReplies('{}', 503);
    const down = await ask(app, alice, { word: 'decision' });
    expect(down.status).toBe(503);
    expect(await errorCode(down)).toBe('ai_unavailable');

    modelReplies('{}', 429);
    const limited = await ask(app, alice, { word: 'decision' });
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
  });

  it('says the feature is not there when the server holds no key', async () => {
    const app = on(TODAY);
    const response = await ask(app, alice, { word: 'decision' });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('not_supported');
  });

  it('asks no questions at all when saving is switched off', async () => {
    const app = on(TODAY, { ...AI_ENV, REVIEW_WRITES_ENABLED: 'false' });
    const fetchMock = modelReplies('{}');
    const response = await ask(app, alice, { word: 'decision' });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('read_only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops one account after its own handful of requests, leaving the other’s', async () => {
    const app = on(TODAY, AI_ENV);
    modelReplies(FAMILY);
    for (let i = 0; i < 5; i += 1) {
      expect((await ask(app, alice, { word: 'decision' })).status).toBe(200);
    }
    expect((await ask(app, alice, { word: 'decision' })).status).toBe(429);
    expect((await ask(app, bob, { word: 'decision' })).status).toBe(200);
  });
});
