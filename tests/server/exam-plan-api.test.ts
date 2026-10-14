/**
 * A suggested exam structure through the HTTP API on the real schema: the
 * words are resolved behind row-level security, the model is told only which
 * words can take which kind of question, and every way it can fail lands the
 * builder unchanged — sections picked by hand.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  call,
  createSupabaseTestApp,
  createTestUser,
  newId,
  type TestApp,
  type TestUser,
} from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { entryResponseSchema, type VocabularyEntry } from '../../shared/api.js';

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
const ask = (app: TestApp, user: TestUser, words: string[]) =>
  call(app, user, '/api/ai/exam-plan', { method: 'POST', body: { words } });

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

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

const planOf = (sections: object[], reason = 'A short mixed exam.') =>
  JSON.stringify({ sections, reason });

const userMessageOf = (fetchMock: ReturnType<typeof modelReplies>): string => {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const sent = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
  return sent.messages.find((message) => message.role === 'user')?.content ?? '';
};

describe('asking for a structure', () => {
  it('answers with the plan, drawn over exactly the words the caller asked for', async () => {
    const app = on(TODAY, AI_ENV);
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn', example: 'A candid answer.' });
    const lucid = await addWord(app, alice, { word: 'lucid', meaning: 'sáng suốt', example: 'A lucid style.' });
    const tenacious = await addWord(app, alice, { word: 'tenacious', meaning: 'bền bỉ', example: 'Tenacious work.' });
    const ephemeral = await addWord(app, alice, { word: 'ephemeral', meaning: 'phù du', example: 'Ephemeral fame.' });
    await addWord(app, alice, { word: 'gregarious', meaning: 'thích giao du' });
    // Four asked for: enough for recognition to have its wrong choices among them.
    const fetchMock = modelReplies(planOf([{ mode: 'recognition', count: 3, minutes: null }], 'Mixed recall over your words.'));

    const response = await ask(app, alice, [candid.id, lucid.id, tenacious.id, ephemeral.id]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sections: [{ mode: 'recognition', count: 3, minutes: null }],
      reason: 'Mixed recall over your words.',
    });
    // The prompt carries each word, its meaning, and which modes it can take —
    // the account's other word (not asked for) never appears.
    const prompt = userMessageOf(fetchMock);
    expect(prompt).toContain('candid');
    expect(prompt).toContain('thẳng thắn');
    expect(prompt).not.toContain('gregarious');
  });

  it('drops a section no word can take instead of passing it on broken', async () => {
    const app = on(TODAY, AI_ENV);
    // No example saved, so nothing in the pool can be asked as a fill-in-the-blank.
    const lucid = await addWord(app, alice, { word: 'lucid', meaning: 'sáng suốt' });
    modelReplies(planOf([{ mode: 'cloze', count: 10, minutes: null }]));
    const response = await ask(app, alice, [lucid.id]);
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe('ai_invalid');
  });

  it('clamps the plan into the builder’s own limits', async () => {
    const app = on(TODAY, AI_ENV);
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    modelReplies(planOf([{ mode: 'typing', count: 50, minutes: 120 }]));
    const response = await ask(app, alice, [candid.id]);
    expect(response.status).toBe(200);
    // One word behind the section: the count comes down to what can be asked.
    expect(await response.json()).toEqual({
      sections: [{ mode: 'typing', count: 1, minutes: 120 }],
      reason: 'A short mixed exam.',
    });
  });

  it('refuses words that are not in the caller’s vocabulary', async () => {
    const app = on(TODAY, AI_ENV);
    const bobWord = await addWord(app, bob, { word: 'shared', meaning: 'dùng chung' });
    // An unknown id, and one of another account's — neither resolves behind row-level security.
    expect((await ask(app, alice, ['99999999-9999-4999-8999-999999999999'])).status).toBe(400);
    expect((await ask(app, alice, [bobWord.id])).status).toBe(400);
    expect((await ask(app, alice, [])).status).toBe(400);
  });

  it('lands in the fallback for each other way the model can fail', async () => {
    const app = on(TODAY, AI_ENV);
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    modelReplies('not json at all');
    const invalid = await ask(app, alice, [candid.id]);
    expect(invalid.status).toBe(502);
    expect(await errorCode(invalid)).toBe('ai_invalid');

    modelReplies('{}', 503);
    const down = await ask(app, alice, [candid.id]);
    expect(down.status).toBe(503);
    expect(await errorCode(down)).toBe('ai_unavailable');

    modelReplies('{}', 429);
    const limited = await ask(app, alice, [candid.id]);
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
  });

  it('says the feature is not there when the server holds no key', async () => {
    const app = on(TODAY);
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    const response = await ask(app, alice, [candid.id]);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('not_supported');
  });

  it('asks no questions at all when saving is switched off', async () => {
    const app = on(TODAY, AI_ENV);
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    // The same store, frozen: the plan itself is only ever a draft, but asking
    // for one costs quota, so it is refused before the model is reached at all.
    const frozen = on(TODAY, { ...AI_ENV, REVIEW_WRITES_ENABLED: 'false' });
    const fetchMock = modelReplies('{}');
    const response = await ask(frozen, alice, [candid.id]);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('read_only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops one account after its own handful of requests, leaving the other’s', async () => {
    const app = on(TODAY, AI_ENV);
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    const shared = await addWord(app, bob, { word: 'lucid', meaning: 'sáng suốt' });
    modelReplies(planOf([{ mode: 'typing', count: 5, minutes: null }]));
    for (let i = 0; i < 5; i += 1) {
      expect((await ask(app, alice, [candid.id])).status).toBe(200);
    }
    expect((await ask(app, alice, [candid.id])).status).toBe(429);
    expect((await ask(app, bob, [shared.id])).status).toBe(200);
  });
});
