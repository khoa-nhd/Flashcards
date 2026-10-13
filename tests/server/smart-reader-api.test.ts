/**
 * Smart Reader through the HTTP API on the real schema: the sentence comes
 * from the reader's own text, the two suggested fields come from the model
 * behind an OpenAI-compatible endpoint (a stand-in fetch, no network), and
 * every way it can fail lands the browser in its fallback — entering the
 * word by hand.
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

const PASSAGE = 'The board gave a candid account of the loss. Everyone stayed.';
const extract = (app: TestApp, user: TestUser, body: Record<string, unknown>) =>
  call(app, user, '/api/ai/extract', { method: 'POST', body });

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

describe('asking what a picked word means', () => {
  it('answers with the sentence from the reader’s own text and the model’s two fields', async () => {
    const app = on(TODAY, AI_ENV);
    const fetchMock = modelReplies(JSON.stringify({ definition: 'Frank and honest.', meaning: 'thẳng thắn, bộc trực' }));
    const body = (await (await extract(app, alice, { text: PASSAGE, word: 'candid' })).json()) as Record<string, unknown>;
    expect(body).toEqual({
      sentence: 'The board gave a candid account of the loss.',
      definition: 'Frank and honest.',
      meaning: 'thẳng thắn, bộc trực',
    });
    // The whole passage never reaches the model: only the one sentence does.
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const userMessage = sent.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(userMessage).toContain('The board gave a candid account of the loss.');
    expect(userMessage).not.toContain('Everyone stayed');
  });

  it('keeps a null from the model as null: an unsure answer stays empty for the reader', async () => {
    const app = on(TODAY, AI_ENV);
    modelReplies(JSON.stringify({ definition: null, meaning: null }));
    const body = (await (await extract(app, alice, { text: PASSAGE, word: 'candid' })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ definition: null, meaning: null });
  });

  it('refuses a word the text does not hold, before any quota is spent', async () => {
    const app = on(TODAY, AI_ENV);
    const fetchMock = modelReplies('{}');
    const response = await extract(app, alice, { text: PASSAGE, word: 'serendipity' });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lands in the fallback for each way the model can fail', async () => {
    const app = on(TODAY, AI_ENV);
    modelReplies('not json at all');
    const invalid = await extract(app, alice, { text: PASSAGE, word: 'candid' });
    expect(invalid.status).toBe(502);
    expect(await errorCode(invalid)).toBe('ai_invalid');

    modelReplies('{}', 503);
    const down = await extract(app, alice, { text: PASSAGE, word: 'candid' });
    expect(down.status).toBe(503);
    expect(await errorCode(down)).toBe('ai_unavailable');

    modelReplies('{}', 429);
    const limited = await extract(app, alice, { text: PASSAGE, word: 'candid' });
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
  });

  it('says the feature is not there when the server holds no key', async () => {
    const app = on(TODAY);
    const response = await extract(app, alice, { text: PASSAGE, word: 'candid' });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('not_supported');
  });

  it('asks no questions at all when saving is switched off', async () => {
    const app = on(TODAY, { ...AI_ENV, REVIEW_WRITES_ENABLED: 'false' });
    const fetchMock = modelReplies('{}');
    const response = await extract(app, alice, { text: PASSAGE, word: 'candid' });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('read_only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops one account after its own handful of requests, leaving the other’s', async () => {
    const app = on(TODAY, AI_ENV);
    modelReplies(JSON.stringify({ definition: 'd', meaning: 'm' }));
    for (let i = 0; i < 5; i += 1) {
      expect((await extract(app, alice, { text: PASSAGE, word: 'candid' })).status).toBe(200);
    }
    expect((await extract(app, alice, { text: PASSAGE, word: 'candid' })).status).toBe(429);
    expect((await extract(app, bob, { text: PASSAGE, word: 'candid' })).status).toBe(200);
  });
});
