/**
 * Generated discovery content drafted with the model, through the HTTP API
 * on the real schema. The model is a stand-in fetch — no network, no key
 * beyond a test string — and every test here stands on three promises:
 *
 *   the model is asked for only what the learner offered: a topic, plain
 *   words, a collection's name with its words — never an id, never a row,
 *   never any other account data;
 *   what comes back is a draft — schema-validated, vetted word by word
 *   against its own text — and it is stored nowhere: accepting it is a
 *   separate, ordinary creation the learner presses, which overwrites no
 *   existing source;
 *   generating changes nothing: no vocabulary, no collection, no source.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiDiscoveryDraftSchema } from '../../shared/ai.js';
import { vocabularyListResponseSchema, type VocabularyEntry } from '../../shared/api.js';
import { discoveryListResponseSchema, discoveryMarksResponseSchema } from '../../shared/discovery.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
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
const on = (env: Record<string, string> = AI_ENV) =>
  createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${TODAY}T05:00:00Z`), env });

/** The model endpoint as the adapter sees it: a chat reply carrying JSON. */
function modelReplies(content: string, status = 200) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ok = async <T>(response: Response | Promise<Response>, status = 200): Promise<T> => {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(status);
  return (await settled.json()) as T;
};

const send = (app: TestApp, user: TestUser, method: 'POST' | 'PUT', path: string, body?: unknown) =>
  call(app, user, path, { method, body });

const errorCodeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

const wordsOf = async (app: TestApp, user: TestUser): Promise<VocabularyEntry[]> =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;

const sourcesOf = async (app: TestApp, user: TestUser) =>
  discoveryListResponseSchema.parse(await (await call(app, user, '/api/discovery')).json()).sources;

const draftResponseSchema = z.object({
  draft: aiDiscoveryDraftSchema.extend({
    suggestions: z.array(z.object({ word: z.string(), sentence: z.string().optional(), note: z.string().optional() })),
  }),
});

const generate = (app: TestApp, user: TestUser, body: Record<string, unknown>) =>
  send(app, user, 'POST', '/api/discovery/generate', { requestId: newId(), ...body });

const TEXT =
  'Marta expected a quiet evening, but the candid answer over dinner changed everyone’s plans for the weekend. ' +
  'They walked to the harbour and watched the ferries leave without them, laughing at how quickly the day had turned. ' +
  'Later she wrote in her notebook that honest talk is rarer than good weather, and twice as welcome when it arrives.';

const DRAFT = JSON.stringify({
  title: 'A candid afternoon',
  text: TEXT,
  suggestions: [
    { word: 'candid', sentence: 'the candid answer over dinner', note: 'openly direct' },
    { word: 'harbour', sentence: null, note: null },
  ],
});

const DRAFT_WITH_A_LIE = JSON.stringify({
  title: 'A candid afternoon',
  text: TEXT,
  suggestions: [{ word: 'ghostly', sentence: null, note: null }],
});

// ---------------------------------------------------------------------------

describe('asking for a draft reading', () => {
  it('answers with a draft and keeps nothing of it', async () => {
    const app = on();
    modelReplies(DRAFT);
    const reply = draftResponseSchema.parse(await (await generate(app, alice, { topic: 'travel mishaps' })).json());
    expect(reply.draft.title).toBe('A candid afternoon');
    expect(reply.draft.suggestions.map((suggestion) => suggestion.word)).toEqual(['candid', 'harbour']);
    expect(reply.draft.suggestions[0]!.note).toBe('openly direct');

    // Stored nowhere: no source, no word — accepting is a later press.
    expect(await sourcesOf(app, alice)).toEqual([]);
    expect(await wordsOf(app, alice)).toEqual([]);
  });

  it('works from a collection the model hears named, with plain words — never an id', async () => {
    const app = on();
    const candid = await ok<{ entry: VocabularyEntry }>(
      send(app, alice, 'POST', '/api/vocabulary', { requestId: newId(), word: 'candid', meaning: 'thẳng thắn' }),
      201,
    );
    const lucid = await ok<{ entry: VocabularyEntry }>(
      send(app, alice, 'POST', '/api/vocabulary', { requestId: newId(), word: 'lucid' }),
      201,
    );
    const collection = await ok<{ collection: { id: string } }>(
      send(app, alice, 'POST', '/api/collections', { name: 'Focus collection' }),
      201,
    );
    await ok(send(app, alice, 'PUT', `/api/collections/${collection.collection.id}/words/${candid.entry.id}`, { member: true }));
    await ok(send(app, alice, 'PUT', `/api/collections/${collection.collection.id}/words/${lucid.entry.id}`, { member: true }));

    const fetchMock = modelReplies(DRAFT);
    const reply = draftResponseSchema.parse(
      await (await generate(app, alice, { collectionId: collection.collection.id, length: 'medium' })).json(),
    );
    expect(reply.draft.suggestions.length).toBeGreaterThan(0);

    // What crossed the wire: the name and the plain words, and nothing else
    // that identifies a row — no collection id, no vocabulary ids.
    const sent = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(sent).toContain('Focus collection');
    expect(sent).toContain('candid');
    expect(sent).not.toContain(collection.collection.id);
    expect(sent).not.toContain(candid.entry.id);
    expect(sent).not.toContain(lucid.entry.id);

    // The collection is exactly as it was: same name, same two words.
    const library = (await call(app, alice, '/api/library')).json() as Promise<{ collections: Array<{ id: string; name: string; wordIds: string[] }> }>;
    const collections = (await library).collections;
    const still = collections.find((entry) => entry.id === collection.collection.id);
    expect(still?.name).toBe('Focus collection');
    expect(still?.wordIds).toHaveLength(2);
    expect(await wordsOf(app, alice)).toHaveLength(2);
    expect(await sourcesOf(app, alice)).toEqual([]);
  });

  it('works from a handful of typed words, and those words are what the model hears', async () => {
    const app = on();
    const fetchMock = modelReplies(DRAFT);
    const reply = draftResponseSchema.parse(
      await (await generate(app, alice, { words: ['candid', 'harbour'], length: 'short' })).json(),
    );
    expect(reply.draft.suggestions.length).toBeGreaterThan(0);

    // Words the learner typed — not saved anywhere — cross as plain words.
    const sent = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(sent).toContain('candid');
    expect(sent).toContain('harbour');

    // Asking for a draft is not an act of saving: no source, no word.
    expect(await sourcesOf(app, alice)).toEqual([]);
    expect(await wordsOf(app, alice)).toEqual([]);
  });

  it('refuses a collection that belongs to somebody else', async () => {
    const app = on();
    const collection = await ok<{ collection: { id: string } }>(
      send(app, bob, 'POST', '/api/collections', { name: 'Bob’s' }),
      201,
    );
    const refused = await generate(app, alice, { collectionId: collection.collection.id });
    expect(refused.status).toBe(404);
    expect(await errorCodeOf(refused)).toBe('not_found');
  });

  it('insists on exactly one thing to write from', async () => {
    const app = on();
    for (const body of [{}, { topic: 'travel', words: ['candid'] }, { topic: 'travel', collectionId: newId() }]) {
      const refused = await generate(app, alice, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects a draft whose suggestions are not in its own text, and keeps nothing', async () => {
    const app = on();
    modelReplies(DRAFT_WITH_A_LIE);
    const refused = await generate(app, alice, { topic: 'travel mishaps' });
    expect(refused.status).toBe(502);
    expect(await errorCodeOf(refused)).toBe('ai_invalid');
    expect(await sourcesOf(app, alice)).toEqual([]);
    expect(await wordsOf(app, alice)).toEqual([]);
  });

  it('answers a reply it cannot read with ai_invalid rather than a crash', async () => {
    const app = on();
    modelReplies('not json at all');
    const refused = await generate(app, alice, { topic: 'travel mishaps' });
    expect(refused.status).toBe(502);
    expect(await errorCodeOf(refused)).toBe('ai_invalid');
  });

  it('asks no model at all when saving is switched off', async () => {
    const app = on({ ...AI_ENV, REVIEW_WRITES_ENABLED: 'false' });
    const fetchMock = modelReplies(DRAFT);
    const refused = await generate(app, alice, { topic: 'travel mishaps' });
    expect(refused.status).toBe(403);
    expect(await errorCodeOf(refused)).toBe('read_only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says AI is not configured here, in one honest code', async () => {
    const app = on({});
    const refused = await generate(app, alice, { topic: 'travel mishaps' });
    expect(refused.status).toBe(409);
    expect(await errorCodeOf(refused)).toBe('not_supported');
  });

  it('rate limits one account after the allowance, and lets the words through', async () => {
    const app = on();
    const fetchMock = modelReplies(DRAFT);
    for (let round = 0; round < 5; round += 1) {
      const response = await generate(app, alice, { topic: 'travel mishaps' });
      expect(response.status).toBe(200);
    }
    const limited = await generate(app, alice, { topic: 'travel mishaps' });
    expect(limited.status).toBe(429);
    expect(await errorCodeOf(limited)).toBe('rate_limited');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Another account counts for itself.
    expect((await generate(app, bob, { topic: 'travel mishaps' })).status).toBe(200);
  });
});

describe('accepting a preview', () => {
  it('is an ordinary creation: candidates become marks, nothing is saved, no source is overwritten', async () => {
    const app = on();
    // A source the learner already has — accepting a draft must not touch it.
    const earlier = await ok<{ source: { id: string; revision: number } }>(
      send(app, alice, 'POST', '/api/discovery', {
        kind: 'text',
        title: 'An earlier reading',
        content: 'Words worth finding in a much older source.',
        requestId: newId(),
      }),
      201,
    );

    modelReplies(DRAFT);
    const reply = draftResponseSchema.parse(await (await generate(app, alice, { topic: 'travel mishaps' })).json());

    const created = await ok<{ source: { id: string } }>(
      send(app, alice, 'POST', '/api/discovery', {
        kind: 'generated',
        title: reply.draft.title,
        origin: 'ai',
        content: reply.draft.text,
        suggestions: reply.draft.suggestions.map((suggestion) => ({
          word: suggestion.word,
          sentence: suggestion.sentence,
          note: suggestion.note,
        })),
        requestId: newId(),
      }),
      201,
    );
    expect(created.source.id).not.toBe(earlier.source.id);

    // Suggestions are marks — waiting, referenced by no vocabulary at all.
    expect(await wordsOf(app, alice)).toEqual([]);
    const waiting = discoveryMarksResponseSchema.parse(await (await call(app, alice, '/api/discovery/marks')).json()).marks;
    expect(waiting.map((mark) => mark.label).sort()).toEqual(['candid', 'harbour']);
    expect(waiting.every((mark) => mark.vocabularyId === null)).toBe(true);

    // The earlier source is untouched: same title, same revision, still listed.
    const sources = await sourcesOf(app, alice);
    expect(sources).toHaveLength(2);
    const stillEarlier = sources.find((source) => source.id === earlier.source.id);
    expect(stillEarlier?.title).toBe('An earlier reading');
    expect(stillEarlier?.revision).toBe(1);
  });
});
