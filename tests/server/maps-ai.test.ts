/**
 * Maps drafted with the model, through the HTTP API on the real schema. The
 * model is a stand-in fetch — no network, no key beyond a test string — and
 * every test here stands on one of three promises:
 *
 *   the model is asked for labels, never ids, and only ever sees what the
 *   learner offered; what comes back is a draft the service vets kind by
 *   kind, dropping whatever does not suit the map or cannot be resolved;
 *   and nothing the model suggests becomes vocabulary — seeds land as saved
 *   words by their own canonical ids, everything else stays a candidate
 *   until the learner saves it on purpose.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { entryResponseSchema, vocabularyListResponseSchema, type VocabularyEntry } from '../../shared/api.js';
import { mapResponseSchema, type VocabMapDocument, type VocabMapSummary } from '../../shared/vocab-map.js';
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

const errorCodeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(status);
  return (await settled.json()) as T;
}

const send = (app: TestApp, user: TestUser, method: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
  call(app, user, path, { method, body });

const wordsOf = async (app: TestApp, user: TestUser): Promise<VocabularyEntry[]> =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;

const generate = (app: TestApp, user: TestUser, body: Record<string, unknown>) =>
  send(app, user, 'POST', '/api/maps/generate', { requestId: newId(), ...body });

const newMap = async (app: TestApp, user: TestUser, body: Record<string, unknown> = {}): Promise<VocabMapSummary> =>
  (await ok<{ map: VocabMapSummary }>(send(app, user, 'POST', '/api/maps', { type: 'semantic', title: 'Test map', requestId: newId(), ...body }), 201)).map;

const documentOf = async (app: TestApp, user: TestUser, id: string): Promise<VocabMapDocument> =>
  mapResponseSchema.parse(await (await call(app, user, `/api/maps/${id}`)).json()).map;

/** One seed word, a model draft around it, and the two edges only one of which may survive. */
const DRAFT = JSON.stringify({
  nodes: [
    { label: 'candid', note: null, group: null },
    { label: 'frank', note: 'openly direct', group: null },
    { label: 'reserved', note: null, group: null },
  ],
  edges: [
    { fromLabel: 'candid', toLabel: 'frank', kind: 'synonym', pattern: null, note: null },
    { fromLabel: 'candid', toLabel: 'reserved', kind: 'antonym', pattern: null, note: null },
    // Not a kind a semantic map holds; dropped.
    { fromLabel: 'candid', toLabel: 'frank', kind: 'verb_noun', pattern: null, note: null },
    // An end the learner never offered; dropped.
    { fromLabel: 'candid', toLabel: 'ghost', kind: 'synonym', pattern: null, note: null },
  ],
});

describe('generating a map from one of the learner\'s words', () => {
  it('lands the seed word saved and every other word a suggestion, and creates no vocabulary', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    const before = await wordsOf(app, alice);
    modelReplies(DRAFT);
    const reply = mapResponseSchema.parse(await (await generate(app, alice, { type: 'semantic', vocabularyId: candid.id })).json());
    const document = reply.map;

    const seed = document.nodes.find((node) => node.vocabularyId === candid.id);
    expect(seed?.kind).toBe('saved');
    expect(seed?.label).toBeNull();
    expect(seed?.word?.word).toBe('candid');

    const candidates = document.nodes.filter((node) => node.kind === 'candidate');
    expect(candidates.map((node) => node.label).sort()).toEqual(['frank', 'reserved']);
    expect(candidates.every((node) => node.vocabularyId === null)).toBe(true);

    // The two valid relationships survive; the wrong kind and the ghost do not.
    expect(document.edges).toHaveLength(2);
    expect(document.edges.map((edge) => edge.kind).sort()).toEqual(['antonym', 'synonym']);

    // Asking for a draft creates no words, whoever asks and however often.
    expect(await wordsOf(app, alice)).toHaveLength(before.length);
    expect(document.title).toBe('candid');
  });

  it('names the map from its topic when there is no seed word', async () => {
    const app = on();
    modelReplies(JSON.stringify({ nodes: [{ label: 'departure', note: null, group: null }], edges: [] }));
    const document = (mapResponseSchema.parse(await (await generate(app, alice, { type: 'thematic', topic: 'At the airport' })).json())).map;
    expect(document.title).toBe('At the airport');
    expect(document.description).toContain('At the airport');
    expect(document.nodes.map((node) => node.label)).toEqual(['departure']);
  });

  it('starts every member of a collection as a saved node, by their own ids', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid' });
    const lucid = await addWord(app, alice, { word: 'lucid' });
    const collection = await ok<{ collection: { id: string } }>(send(app, alice, 'POST', '/api/collections', { name: 'Clarity' }), 201);
    for (const word of [candid, lucid]) {
      await ok(send(app, alice, 'PUT', `/api/collections/${collection.collection.id}/words/${word.id}`, { member: true }));
    }
    modelReplies(
      JSON.stringify({
        nodes: [
          { label: 'candid', note: null, group: null },
          { label: 'lucid', note: null, group: null },
          { label: 'limpid', note: null, group: null },
        ],
        edges: [{ fromLabel: 'candid', toLabel: 'lucid', kind: 'synonym', pattern: null, note: null }],
      }),
    );
    const document = (mapResponseSchema.parse(await (await generate(app, alice, { type: 'semantic', collectionId: collection.collection.id })).json())).map;
    const saved = document.nodes.filter((node) => node.kind === 'saved').map((node) => node.vocabularyId);
    expect(saved.sort()).toEqual([candid.id, lucid.id].sort());
    expect(document.title).toBe('Clarity');
  });

  it('shows the model only what the learner offered, and asks in the map type\'s terms', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid' });
    await addWord(app, alice, { word: 'secretive' }); // never offered to the model
    const fetchMock = modelReplies(DRAFT);
    await generate(app, alice, { type: 'semantic', vocabularyId: candid.id });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const system = sent.messages.find((message) => message.role === 'system')?.content ?? '';
    const prompt = sent.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(prompt).toContain('candid');
    expect(prompt).not.toContain('secretive');
    expect(prompt).not.toContain(bob.email);
    // The system message teaches the kinds a semantic map holds.
    expect(system).toContain('synonym');
    expect(system).toContain('antonym');
  });
});

describe('every way the model draft can fail lands somewhere safe', () => {
  it('refuses a reply that is not the shape asked for, and creates nothing', async () => {
    const app = on();
    modelReplies(JSON.stringify({ words: ['candid'] }));
    const response = await generate(app, alice, { type: 'semantic', topic: 'Clarity' });
    expect(response.status).toBe(502);
    expect(await errorCodeOf(response)).toBe('ai_invalid');
    const listed = await ok<{ maps: VocabMapSummary[] }>(await call(app, alice, '/api/maps'));
    expect(listed.maps).toEqual([]);
  });

  it('falls back for each other failure the way the rest of the AI features do', async () => {
    const app = on();
    modelReplies('not json at all');
    const invalid = await generate(app, alice, { type: 'semantic', topic: 'Clarity' });
    expect(invalid.status).toBe(502);
    expect(await errorCodeOf(invalid)).toBe('ai_invalid');

    modelReplies('{}', 503);
    const down = await generate(app, alice, { type: 'semantic', topic: 'Clarity' });
    expect(down.status).toBe(503);
    expect(await errorCodeOf(down)).toBe('ai_unavailable');

    modelReplies('{}', 429);
    const limited = await generate(app, alice, { type: 'semantic', topic: 'Clarity' });
    expect(limited.status).toBe(429);
    expect(await errorCodeOf(limited)).toBe('rate_limited');
  });

  it('says plainly when no model is configured at all', async () => {
    const app = on({});
    const response = await generate(app, alice, { type: 'semantic', topic: 'Clarity' });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('not_supported');
  });

  it('keeps one account\'s asking to its allowance', async () => {
    const app = on();
    modelReplies(JSON.stringify({ nodes: [{ label: 'word', note: null, group: null }], edges: [] }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await generate(app, alice, { type: 'semantic', topic: `Topic ${attempt}` });
      expect(response.status).toBe(201);
    }
    const sixth = await generate(app, alice, { type: 'semantic', topic: 'One too many' });
    expect(sixth.status).toBe(429);
    expect(await errorCodeOf(sixth)).toBe('rate_limited');
    // Bob's allowance is his own.
    const bobs = await generate(app, bob, { type: 'semantic', topic: 'Bobs topic' });
    expect(bobs.status).toBe(201);
  }, 60_000);
});

describe('expanding an existing map', () => {
  const withTwoWords = async (app: TestApp, type = 'semantic') => {
    const candid = await addWord(app, alice, { word: 'candid' });
    const lucid = await addWord(app, alice, { word: 'lucid' });
    const map = await newMap(app, alice, { type });
    const first = await ok<{ node: VocabMapDocument['nodes'][number] }>(
      send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'saved', vocabularyId: candid.id, requestId: newId() }),
      201,
    );
    const second = await ok<{ node: VocabMapDocument['nodes'][number] }>(
      send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'saved', vocabularyId: lucid.id, requestId: newId() }),
      201,
    );
    const made = await ok<{ edge: VocabMapDocument['edges'][number] }>(
      send(app, alice, 'POST', `/api/maps/${map.id}/edges`, { fromNodeId: first.node.id, toNodeId: second.node.id, kind: 'synonym' }),
      201,
    );
    return { map, edge: made.edge };
  };

  const EXPANSION = JSON.stringify({
    nodes: [
      { label: 'candid', note: null, group: null }, // already there; not proposed twice
      { label: 'frank', note: 'openly direct', group: null },
      { label: 'forthright', note: null, group: null },
    ],
    edges: [
      // A different kind between nodes the learner already linked: added as its
      // own relationship, never replacing the one already there.
      { fromLabel: 'candid', toLabel: 'lucid', kind: 'related', pattern: null, note: null },
      { fromLabel: 'candid', toLabel: 'frank', kind: 'synonym', pattern: null, note: null },
      { fromLabel: 'candid', toLabel: 'ghost', kind: 'synonym', pattern: null, note: null },
    ],
  });

  it('proposes without writing: apply is off until the learner says otherwise', async () => {
    const app = on();
    const { map } = await withTwoWords(app);
    modelReplies(EXPANSION);
    const reply = await ok<{ suggestions: { nodes: Array<{ label: string }> }; applied: boolean }>(
      send(app, alice, 'POST', `/api/maps/${map.id}/expand`, {}),
    );
    expect(reply.applied).toBe(false);
    expect(reply.suggestions.nodes.map((node) => node.label).sort()).toEqual(['forthright', 'frank']);
    // The map itself has not moved.
    const document = await documentOf(app, alice, map.id);
    expect(document.nodes).toHaveLength(2);
    expect(document.edges).toHaveLength(1);
  });

  it('applies as candidates only: no word is made, and the learner\'s own edges stay', async () => {
    const app = on();
    const { map, edge } = await withTwoWords(app);
    const before = await wordsOf(app, alice);
    modelReplies(EXPANSION);
    const reply = await ok<{ applied: boolean }>(
      send(app, alice, 'POST', `/api/maps/${map.id}/expand`, { apply: true, requestId: newId() }),
    );
    expect(reply.applied).toBe(true);

    const document = await documentOf(app, alice, map.id);
    // Two suggestions became candidates; the seed label was not repeated.
    const candidates = document.nodes.filter((node) => node.kind === 'candidate');
    expect(candidates.map((node) => node.label).sort()).toEqual(['forthright', 'frank']);
    expect(candidates.every((node) => node.vocabularyId === null)).toBe(true);
    // Not one word was created by any of it.
    expect(await wordsOf(app, alice)).toHaveLength(before.length);
    // The learner's edge stays exactly as it was; the model's own edge between
    // the same two words is a different relationship and joins beside it; the
    // edge to a word nobody offered is gone. Nothing was overwritten.
    const kinds = document.edges.map((one) => one.kind).sort();
    expect(kinds).toEqual(['related', 'synonym', 'synonym']);
    expect(document.edges).toHaveLength(3);
    expect(document.edges.map((one) => one.id)).toContain(edge.id);
  });

  it('repeating an apply with the same request id doubles nothing', async () => {
    const app = on();
    const { map } = await withTwoWords(app);
    modelReplies(EXPANSION);
    const requestId = newId();
    await send(app, alice, 'POST', `/api/maps/${map.id}/expand`, { apply: true, requestId });
    const after = await documentOf(app, alice, map.id);
    // The stub still answers the same draft; a second apply must not duplicate.
    await send(app, alice, 'POST', `/api/maps/${map.id}/expand`, { apply: true, requestId });
    const twice = await documentOf(app, alice, map.id);
    expect(twice.nodes).toHaveLength(after.nodes.length);
    expect(twice.edges).toHaveLength(after.edges.length);
  });

  it('continues a scenario\'s order where the map leaves off', async () => {
    const app = on();
    const map = await newMap(app, alice, { type: 'scenario' });
    await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'candidate', label: 'Excuse me, where is the gate?', requestId: newId() });
    await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'candidate', label: 'Thank you.', requestId: newId() });
    modelReplies(JSON.stringify({ nodes: [{ label: 'One moment, please.', note: null, group: null }], edges: [] }));
    await send(app, alice, 'POST', `/api/maps/${map.id}/expand`, { apply: true, requestId: newId() });
    const document = await documentOf(app, alice, map.id);
    const added = document.nodes.find((node) => node.label === 'One moment, please.');
    expect(added?.step).toBe(3);
  });
});

describe('a frozen account may look at drafts and store none of them', () => {
  it('refuses to generate, and refuses to apply an expansion, but may ask', async () => {
    // The map exists (drawn on a writing app over the same database); the
    // account reading it now has saving switched off.
    const map = await newMap(on(AI_ENV), alice);
    const app = on({ ...AI_ENV, REVIEW_WRITES_ENABLED: 'false' });
    const refused = await generate(app, alice, { type: 'semantic', topic: 'Clarity' });
    expect(refused.status).toBe(403);
    expect(await errorCodeOf(refused)).toBe('read_only');

    modelReplies(JSON.stringify({ nodes: [{ label: 'frank', note: null, group: null }], edges: [] }));
    const asked = await ok<{ applied: boolean }>(send(app, alice, 'POST', `/api/maps/${map.id}/expand`, {}));
    expect(asked.applied).toBe(false);
    const applied = await send(app, alice, 'POST', `/api/maps/${map.id}/expand`, { apply: true, requestId: newId() });
    expect(applied.status).toBe(403);
    expect(await errorCodeOf(applied)).toBe('read_only');
  });
});
