/**
 * G6 — the nine integration journeys, each one whole-path rather than
 * unit-sized: a learner starts maps of every kind, draws one and returns to
 * it, saves work without saving words, drafts with the model and adds only
 * what they accept, looks at everything without touching a schedule, shares
 * nothing with a second account, retries a pressed-twice action and beats a
 * stale revision, follows a renamed word through their maps, and reads an
 * account whose saving is switched off. Each journey states the invariant it
 * is really about; the unit suites beside this one prove the edges.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { entryResponseSchema, vocabularyListResponseSchema, type VocabularyEntry } from '../../shared/api.js';
import {
  CREATABLE_MAP_TYPES,
  mapResponseSchema,
  mapsListResponseSchema,
  personalMapResponseSchema,
  type VocabMapDocument,
  type VocabMapSummary,
} from '../../shared/vocab-map.js';
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

async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(status);
  return (await settled.json()) as T;
}

const send = (app: TestApp, user: TestUser, method: 'POST' | 'GET' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
  call(app, user, path, { method, body });

const errorCodeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

const wordsOf = async (app: TestApp, user: TestUser): Promise<VocabularyEntry[]> =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;

const newMap = async (app: TestApp, user: TestUser, body: Record<string, unknown> = {}) =>
  (
    await ok<{ map: VocabMapSummary }>(
      send(app, user, 'POST', '/api/maps', { type: 'semantic', title: 'Journey map', requestId: newId(), ...body }),
      201,
    )
  ).map;

const documentOf = async (app: TestApp, user: TestUser, id: string): Promise<VocabMapDocument> =>
  mapResponseSchema.parse(await (await call(app, user, `/api/maps/${id}`)).json()).map;

const addNode = async (app: TestApp, user: TestUser, mapId: string, body: Record<string, unknown>) =>
  (await ok<{ node: VocabMapDocument['nodes'][number] }>(send(app, user, 'POST', `/api/maps/${mapId}/nodes`, { requestId: newId(), ...body }), 201)).node;

const addEdge = async (app: TestApp, user: TestUser, mapId: string, body: Record<string, unknown>) =>
  (await ok<{ edge: VocabMapDocument['edges'][number] }>(send(app, user, 'POST', `/api/maps/${mapId}/edges`, body), 201)).edge;

const listOf = async (app: TestApp, user: TestUser) =>
  mapsListResponseSchema.parse(await (await call(app, user, '/api/maps')).json()).maps;

/** A model draft around one word: two more words and a few links of mixed worth. */
const DRAFT = JSON.stringify({
  nodes: [
    { label: 'candid', note: null, group: null },
    { label: 'frank', note: 'openly direct', group: null },
    { label: 'reserved', note: null, group: null },
  ],
  edges: [
    { fromLabel: 'candid', toLabel: 'frank', kind: 'synonym', pattern: null, note: null },
    { fromLabel: 'candid', toLabel: 'reserved', kind: 'antonym', pattern: null, note: null },
  ],
});

// ---------------------------------------------------------------------------
// Journey A — every kind, from nothing
// ---------------------------------------------------------------------------

describe('Journey A — start a map of every kind, and the personal view beyond them', () => {
  it('opens each of the seven kinds empty and listed, and draws the eighth live without storing it', async () => {
    const app = on();
    await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });

    for (const type of CREATABLE_MAP_TYPES) {
      const map = await newMap(app, alice, { type, title: `My ${type} map` });
      expect(map.type).toBe(type);
      expect(map.revision).toBe(1);
      const document = await documentOf(app, alice, map.id);
      expect(document.nodes).toEqual([]);
      expect(document.edges).toEqual([]);
    }
    expect(await listOf(app, alice)).toHaveLength(CREATABLE_MAP_TYPES.length);

    // The personal map has no create route, is not in the list, and arrives
    // drawn from the library the moment it is asked for.
    const refused = await send(app, alice, 'POST', '/api/maps', { type: 'personal', title: 'Mine' });
    expect(refused.status).toBe(400);
    const reply = personalMapResponseSchema.parse(await (await call(app, alice, '/api/maps/personal')).json());
    expect(reply.personal.type).toBe('personal');
    expect(reply.personal.nodes).toHaveLength(1);
    expect(reply.stats).toMatchObject({ words: 1, maps: CREATABLE_MAP_TYPES.length });
    expect((await listOf(app, alice)).some((map) => map.type === 'personal')).toBe(false);
    const stored = await db.admin<{ n: number }>(`select count(*)::int as n from public.vocabulary_maps where type = 'personal'`);
    expect(stored[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Journey B — draw, close, return
// ---------------------------------------------------------------------------

describe('Journey B — draw a map, leave it, and find everything where it was', () => {
  it('keeps words, suggestions, groups, links and positions through a full close-and-return', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    const lucid = await addWord(app, alice, { word: 'lucid', meaning: 'sáng rõ' });
    const map = await newMap(app, alice, { type: 'thematic', title: 'Work talk' });

    const first = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: candid.id, group: 'Meetings' });
    const second = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: lucid.id, group: 'Writing' });
    const suggestion = await addNode(app, alice, map.id, { kind: 'candidate', label: 'concisely', group: 'Writing' });
    const link = await addEdge(app, alice, map.id, { fromNodeId: first.id, toNodeId: second.id, kind: 'related' });
    expect(link.kind).toBe('related');
    const drawn = (await documentOf(app, alice, map.id)).revision;
    await ok(
      send(app, alice, 'PUT', `/api/maps/${map.id}/layout`, {
        positions: [
          { nodeId: first.id, x: 40, y: 80 },
          { nodeId: suggestion.id, x: 220, y: 140 },
        ],
        ifMatch: drawn,
      }),
    );

    // Closing the tab and coming back: the same map, read fresh.
    const document = await documentOf(app, alice, map.id);
    expect(document.revision).toBeGreaterThan(1);
    expect(document.nodes).toHaveLength(3);
    expect(document.nodes.find((node) => node.id === first.id)).toMatchObject({ group: 'Meetings', x: 40, y: 80 });
    expect(document.nodes.find((node) => node.id === suggestion.id)).toMatchObject({ label: 'concisely', kind: 'candidate', x: 220 });
    expect(document.edges.map((edge) => edge.id)).toEqual([link.id]);
    // The saved words carry their live text, never a stored copy.
    expect(document.nodes.find((node) => node.id === first.id)?.word).toEqual({ id: candid.id, word: 'candid', meaning: 'thẳng thắn' });
    expect(await wordsOf(app, alice)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Journey C — save the map, not the words
// ---------------------------------------------------------------------------

describe('Journey C — saving a map saves no vocabulary, and the one press that does saves exactly one', () => {
  it('walks a map from creation through deletion with the word list changed only by the save press', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid' });
    const start = await wordsOf(app, alice);
    expect(start).toHaveLength(1);

    // Every ordinary map action: create, rename, add a suggestion, link it,
    // move it, correct the suggestion's text.
    const map = await newMap(app, alice, { type: 'nuance', title: 'Candid and frank' });
    await ok(send(app, alice, 'PATCH', `/api/maps/${map.id}`, { title: 'Close expressions', ifMatch: 1 }));
    const saved = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: candid.id });
    const suggestion = await addNode(app, alice, map.id, { kind: 'candidate', label: 'frank' });
    await addEdge(app, alice, map.id, { fromNodeId: saved.id, toNodeId: suggestion.id, kind: 'contrast', note: 'candid can sting' });
    await ok(send(app, alice, 'PATCH', `/api/maps/${map.id}/nodes/${suggestion.id}`, { label: 'forthright' }));
    expect(await wordsOf(app, alice)).toEqual(start);

    // The one press that creates a word — once.
    const promotion = await ok<{ entryId: string }>(
      send(app, alice, 'POST', `/api/maps/${map.id}/nodes/${suggestion.id}/save`, { requestId: newId() }),
      201,
    );
    const afterSave = await wordsOf(app, alice);
    expect(afterSave).toHaveLength(2);
    expect(afterSave.map((word) => word.word)).toContain('forthright');
    expect(afterSave.find((word) => word.id === promotion.entryId)).toBeDefined();
    // The map kept its link through the promotion.
    expect((await documentOf(app, alice, map.id)).edges).toHaveLength(1);

    // Deleting the diagram leaves both words standing.
    await ok(send(app, alice, 'DELETE', `/api/maps/${map.id}`));
    expect(await listOf(app, alice)).toHaveLength(0);
    expect((await wordsOf(app, alice)).map((word) => word.word).sort()).toEqual(['candid', 'forthright']);
  });
});

// ---------------------------------------------------------------------------
// Journey D — draft with the model, add only what is accepted
// ---------------------------------------------------------------------------

describe('Journey D — the model drafts and expands, the learner decides', () => {
  it('lands seeds saved and labels as candidates, previews without changing, applies without overwriting, twice', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });

    // 1. Generate: the seed is a saved word by its own id; the rest arrive as
    //    suggestions; the vocabulary count has not moved.
    modelReplies(DRAFT);
    const generated = await ok<{ map: VocabMapDocument }>(
      send(app, alice, 'POST', '/api/maps/generate', { type: 'semantic', vocabularyId: candid.id, requestId: newId() }),
      201,
    );
    expect(await wordsOf(app, alice)).toHaveLength(1);
    const draft = generated.map;
    const seed = draft.nodes.find((node) => node.kind === 'saved');
    expect(seed?.vocabularyId).toBe(candid.id);
    expect(draft.nodes.filter((node) => node.kind === 'candidate').length).toBeGreaterThanOrEqual(2);

    // 2. The learner draws their own link on top of the draft.
    const seedNode = draft.nodes.find((node) => node.vocabularyId === candid.id)!;
    const frank = draft.nodes.find((node) => node.label === 'frank')!;
    const own = await addEdge(app, alice, draft.id, { fromNodeId: seedNode.id, toNodeId: frank.id, kind: 'confused' });

    // 3. Preview the expansion: proposed, not stored — the map is exactly as
    //    the learner left it, own link included.
    const beforePreview = await documentOf(app, alice, draft.id);
    modelReplies(JSON.stringify({ nodes: [{ label: 'blunt', note: null, group: null }], edges: [] }));
    const preview = await ok<{ applied: boolean }>(send(app, alice, 'POST', `/api/maps/${draft.id}/expand`, {}));
    expect(preview.applied).toBe(false);
    const untouched = await documentOf(app, alice, draft.id);
    expect(untouched.nodes).toHaveLength(beforePreview.nodes.length);
    expect(untouched.edges.map((edge) => edge.id)).toEqual(beforePreview.edges.map((edge) => edge.id));
    expect(untouched.revision).toBe(beforePreview.revision);

    // 4. Apply: one suggestion joins as a candidate; the learner's own link
    //    survives; no word is created; a repeat of the same submission is a no-op.
    modelReplies(JSON.stringify({ nodes: [{ label: 'blunt', note: null, group: null }], edges: [] }));
    const requestId = newId();
    await ok(send(app, alice, 'POST', `/api/maps/${draft.id}/expand`, { apply: true, requestId }));
    const applied = await documentOf(app, alice, draft.id);
    expect(applied.nodes.filter((node) => node.kind === 'candidate').some((node) => node.label === 'blunt')).toBe(true);
    expect(applied.edges.map((edge) => edge.id)).toContain(own.id);
    const countAfterFirst = applied.nodes.length;
    modelReplies(JSON.stringify({ nodes: [{ label: 'blunt', note: null, group: null }], edges: [] }));
    await ok(send(app, alice, 'POST', `/api/maps/${draft.id}/expand`, { apply: true, requestId }));
    expect((await documentOf(app, alice, draft.id)).nodes).toHaveLength(countAfterFirst);

    // The whole journey created no vocabulary at all.
    expect(await wordsOf(app, alice)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Journey E — looking never learns
// ---------------------------------------------------------------------------

describe('Journey E — every map reading leaves the learning evidence byte-identical', () => {
  it('reads lists, documents, the personal view and an unapplied expansion without touching a schedule', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid', mastery: 4, reviewDate: '2026-10-20' });
    const map = await newMap(app, alice);
    await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: candid.id });

    const entryBefore = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${candid.id}`)).json()).entry;
    const cardsBefore = await db.admin('select * from card_states order by 1');
    const reviewsBefore = await db.admin<{ n: number }>('select count(*)::int as n from review_logs');

    // The whole reading surface, twice over.
    await listOf(app, alice);
    await documentOf(app, alice, map.id);
    await call(app, alice, '/api/maps/personal');
    await call(app, alice, '/api/maps/personal');
    modelReplies(JSON.stringify({ nodes: [{ label: 'anything', note: null, group: null }], edges: [] }));
    await send(app, alice, 'POST', `/api/maps/${map.id}/expand`, {});

    const entryAfter = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${candid.id}`)).json()).entry;
    const cardsAfter = await db.admin('select * from card_states order by 1');
    const reviewsAfter = await db.admin<{ n: number }>('select count(*)::int as n from review_logs');
    expect(entryAfter).toEqual(entryBefore);
    expect(cardsAfter).toEqual(cardsBefore);
    expect(reviewsAfter).toEqual(reviewsBefore);
  });
});

// ---------------------------------------------------------------------------
// Journey F — two accounts, two libraries
// ---------------------------------------------------------------------------

describe('Journey F — a second account finds nothing of the first', () => {
  it('lists, reads, writes, saves and deletes only its own, and leaves the first untouched', async () => {
    const app = on();
    const aliceWord = await addWord(app, alice, { word: 'candid' });
    const aliceMap = await newMap(app, alice, { title: 'Alice diagram' });
    const aliceNode = await addNode(app, alice, aliceMap.id, { kind: 'saved', vocabularyId: aliceWord.id });
    const aliceSuggestion = await addNode(app, alice, aliceMap.id, { kind: 'candidate', label: 'forthright' });
    const bobMap = await newMap(app, bob, { title: 'Bob diagram' });

    // Bob's list holds only Bob's map; his words are his words.
    const bobList = await listOf(app, bob);
    expect(bobList.map((map) => map.id)).toEqual([bobMap.id]);
    expect((await wordsOf(app, bob)).map((word) => word.word)).toEqual([]);

    // Every road into Alice's work is closed to him.
    expect((await call(app, bob, `/api/maps/${aliceMap.id}`)).status).toBe(404);
    expect((await send(app, bob, 'POST', `/api/maps/${aliceMap.id}/nodes`, { requestId: newId(), kind: 'candidate', label: 'sneak' })).status).toBe(404);
    expect((await send(app, bob, 'POST', `/api/maps/${aliceMap.id}/nodes/${aliceSuggestion.id}/save`, { requestId: newId() })).status).toBe(404);
    expect((await send(app, bob, 'PATCH', `/api/maps/${aliceMap.id}`, { title: 'Taken', ifMatch: 1 })).status).toBe(404);
    expect((await send(app, bob, 'DELETE', `/api/maps/${aliceMap.id}`)).status).toBe(404);

    // Alice's map is exactly as she left it, and Bob still has his own.
    const document = await documentOf(app, alice, aliceMap.id);
    expect(document.title).toBe('Alice diagram');
    expect(document.nodes.map((node) => node.id).sort()).toEqual([aliceNode.id, aliceSuggestion.id].sort());
    expect(await listOf(app, bob)).toHaveLength(1);
    expect((await wordsOf(app, alice)).map((word) => word.word)).toEqual(['candid']);
    expect(await wordsOf(app, bob)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Journey G — a pressed twice, a racing ahead
// ---------------------------------------------------------------------------

describe('Journey G — the same submission lands once, and a stale hand is refused', () => {
  it('creates once for a repeated request id, refuses an outdated change, and lets it in after a re-read', async () => {
    const app = on();
    const requestId = newId();
    const first = await ok<{ map: VocabMapSummary }>(send(app, alice, 'POST', '/api/maps', { type: 'scenario', title: 'Once', requestId }), 201);
    const second = await ok<{ map: VocabMapSummary }>(send(app, alice, 'POST', '/api/maps', { type: 'scenario', title: 'Once', requestId }), 201);
    expect(second.map.id).toBe(first.map.id);
    expect(await listOf(app, alice)).toHaveLength(1);

    // A link is its own idempotency: the same two ends and kind land once.
    const a = await addNode(app, alice, first.map.id, { kind: 'candidate', label: 'arrive', step: 1 });
    const b = await addNode(app, alice, first.map.id, { kind: 'candidate', label: 'order', step: 2 });
    const edgeAgain = await ok<{ edge: { id: string } }>(
      send(app, alice, 'POST', `/api/maps/${first.map.id}/edges`, { fromNodeId: a.id, toNodeId: b.id, kind: 'step' }),
      201,
    );
    const repeated = await ok<{ edge: { id: string } }>(
      send(app, alice, 'POST', `/api/maps/${first.map.id}/edges`, { fromNodeId: a.id, toNodeId: b.id, kind: 'step' }),
      201,
    );
    expect(repeated.edge.id).toBe(edgeAgain.edge.id);
    expect((await documentOf(app, alice, first.map.id)).edges).toHaveLength(1);

    // Two windows open the same map; one moves on, the other must re-read.
    const stale = (await documentOf(app, alice, first.map.id)).revision;
    await ok(send(app, alice, 'PATCH', `/api/maps/${first.map.id}`, { title: 'Moved on', ifMatch: stale }));
    const race = await send(app, alice, 'PUT', `/api/maps/${first.map.id}/layout`, {
      positions: [{ nodeId: a.id, x: 10, y: 10 }],
      ifMatch: stale,
    });
    expect(race.status).toBe(409);
    expect(await errorCodeOf(race)).toBe('conflict');

    const fresh = (await documentOf(app, alice, first.map.id)).revision;
    expect(fresh).toBeGreaterThan(stale);
    await ok(
      send(app, alice, 'PUT', `/api/maps/${first.map.id}/layout`, {
        positions: [{ nodeId: a.id, x: 10, y: 10 }],
        ifMatch: fresh,
      }),
    );
    expect((await documentOf(app, alice, first.map.id)).nodes.find((node) => node.id === a.id)).toMatchObject({ x: 10, y: 10 });
  });
});

// ---------------------------------------------------------------------------
// Journey H — words move, maps follow
// ---------------------------------------------------------------------------

describe('Journey H — a renamed word updates its maps, a saved suggestion keeps its links, a deleted map keeps its words', () => {
  it('walks one word through rename, promotion and diagram deletion with the links intact throughout', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    const map = await newMap(app, alice, { type: 'semantic', title: 'Its family' });
    const wordNode = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: candid.id });
    const suggestion = await addNode(app, alice, map.id, { kind: 'candidate', label: 'frank' });
    const edge = await addEdge(app, alice, map.id, { fromNodeId: wordNode.id, toNodeId: suggestion.id, kind: 'synonym' });

    // The word is renamed elsewhere in the app: the map follows without being
    // touched — same node, same links, and not one revision of its own.
    const drawn = (await documentOf(app, alice, map.id)).revision;
    expect((await send(app, alice, 'PATCH', `/api/vocabulary/${candid.id}`, { word: 'blunt' })).status).toBe(200);
    const afterRename = await documentOf(app, alice, map.id);
    expect(afterRename.nodes.find((node) => node.id === wordNode.id)?.word?.word).toBe('blunt');
    expect(afterRename.revision).toBe(drawn); // reading a rename is not a map change
    expect(afterRename.edges.map((one) => one.id)).toEqual([edge.id]);

    // The suggestion becomes a word in place; the link it had, it keeps.
    await ok(send(app, alice, 'POST', `/api/maps/${map.id}/nodes/${suggestion.id}/save`, { requestId: newId() }), 201);
    const afterSave = await documentOf(app, alice, map.id);
    expect(afterSave.nodes.find((node) => node.id === suggestion.id)).toMatchObject({ kind: 'saved', label: null });
    expect(afterSave.edges.map((one) => one.id)).toEqual([edge.id]);

    // The diagram is deleted; every word it held remains.
    await ok(send(app, alice, 'DELETE', `/api/maps/${map.id}`));
    expect((await wordsOf(app, alice)).map((word) => word.word).sort()).toEqual(['blunt', 'frank']);
  });
});

// ---------------------------------------------------------------------------
// Journey I — an account whose saving is switched off
// ---------------------------------------------------------------------------

describe('Journey I — read everything, change nothing', () => {
  it('answers every read and refuses every write, including the model’s', async () => {
    // The content is built through the ordinary, writing app…
    const writing = on();
    const candid = await addWord(writing, alice, { word: 'candid' });
    const map = await newMap(writing, alice);
    const node = await addNode(writing, alice, map.id, { kind: 'saved', vocabularyId: candid.id });

    // …and read back through the same account with saving switched off.
    const app = on({ ...AI_ENV, REVIEW_WRITES_ENABLED: 'false' });

    // Reads: every one of them answers, with what was drawn before.
    expect((await call(app, alice, '/api/maps')).status).toBe(200);
    const document = await documentOf(app, alice, map.id);
    expect(document.nodes.map((one) => one.id)).toEqual([node.id]);
    expect((await call(app, alice, '/api/maps/personal')).status).toBe(200);
    modelReplies(JSON.stringify({ nodes: [{ label: 'anything', note: null, group: null }], edges: [] }));
    expect((await send(app, alice, 'POST', `/api/maps/${map.id}/expand`, {})).status).toBe(200);

    // Writes: each one is refused with the account's own reason.
    const create = await send(app, alice, 'POST', '/api/maps', { type: 'semantic', title: 'Nope', requestId: newId() });
    expect(create.status).toBe(403);
    expect(await errorCodeOf(create)).toBe('read_only');
    expect(
      (await send(app, alice, 'PATCH', `/api/maps/${map.id}`, { title: 'Renamed', ifMatch: document.revision })).status,
    ).toBe(403);
    expect(
      (await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { requestId: newId(), kind: 'candidate', label: 'x' })).status,
    ).toBe(403);
    expect((await send(app, alice, 'DELETE', `/api/maps/${map.id}/nodes/${node.id}`)).status).toBe(403);
    expect((await send(app, alice, 'POST', `/api/maps/${map.id}/nodes/${node.id}/save`, { requestId: newId() })).status).toBe(403);
    expect((await send(app, alice, 'PUT', `/api/maps/${map.id}/layout`, { positions: [], ifMatch: document.revision })).status).toBe(403);
    expect((await send(app, alice, 'DELETE', `/api/maps/${map.id}`)).status).toBe(403);
    const generate = await send(app, alice, 'POST', '/api/maps/generate', { type: 'semantic', requestId: newId() });
    expect(generate.status).toBe(403);
    expect(await errorCodeOf(generate)).toBe('read_only');
    expect(
      (await send(app, alice, 'POST', `/api/maps/${map.id}/expand`, { apply: true, requestId: newId() })).status,
    ).toBe(403);

    // And neither the vocabulary nor the map has been touched by any refusal.
    expect(await wordsOf(app, alice)).toHaveLength(1);
    expect((await documentOf(app, alice, map.id)).nodes).toHaveLength(1);
  });
});
