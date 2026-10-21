/**
 * Vocabulary maps over the HTTP API on the real schema: every kind of map a
 * learner may draw, the line between a saved word and a suggestion, the
 * relationships each kind accepts, the one call that turns a suggestion into
 * a word, and every boundary — another reader's map, a stale revision, a
 * frozen account — landing where it should.
 *
 * Three rules are proved here above all: saving a map saves no vocabulary;
 * a suggestion stays map data until saving it on purpose (the single call
 * that creates a word); and no map reading or writing touches a word's
 * schedule, mastery or review history.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { entryResponseSchema, vocabularyListResponseSchema, type VocabularyEntry } from '../../shared/api.js';
import {
  CREATABLE_MAP_TYPES,
  VOCAB_MAP_LIMITS,
  mapResponseSchema,
  mapsListResponseSchema,
  personalMapResponseSchema,
  saveCandidateResponseSchema,
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
const on = (env?: Record<string, string>) =>
  createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${TODAY}T05:00:00Z`), env });

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

const send = (app: TestApp, user: TestUser, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
  call(app, user, path, { method, body });

const errorCodeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

const errorMessageOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { message: string } }).error.message;

const newMap = async (app: TestApp, user: TestUser, body: Record<string, unknown> = {}) =>
  (await ok<{ map: VocabMapSummary }>(send(app, user, 'POST', '/api/maps', { type: 'semantic', title: 'Test map', requestId: newId(), ...body }), 201)).map;

const documentOf = async (app: TestApp, user: TestUser, id: string): Promise<VocabMapDocument> =>
  mapResponseSchema.parse(await (await call(app, user, `/api/maps/${id}`)).json()).map;

const addNode = async (app: TestApp, user: TestUser, mapId: string, body: Record<string, unknown>) =>
  (await ok<{ node: VocabMapDocument['nodes'][number] }>(send(app, user, 'POST', `/api/maps/${mapId}/nodes`, { requestId: newId(), ...body }), 201)).node;

const addEdge = async (app: TestApp, user: TestUser, mapId: string, body: Record<string, unknown>) =>
  (await ok<{ edge: VocabMapDocument['edges'][number] }>(send(app, user, 'POST', `/api/maps/${mapId}/edges`, body), 201)).edge;

const wordsOf = async (app: TestApp, user: TestUser): Promise<VocabularyEntry[]> =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;

// ---------------------------------------------------------------------------

describe('a map of every kind a learner may draw', () => {
  it('starts one empty map of each kind, titled and listed', async () => {
    const app = on();
    for (const [index, type] of CREATABLE_MAP_TYPES.entries()) {
      const map = await newMap(app, alice, { type, title: `Map ${index}` });
      expect(map.type).toBe(type);
      expect(map.revision).toBe(1);
      const document = await documentOf(app, alice, map.id);
      expect(document.nodes).toEqual([]);
      expect(document.edges).toEqual([]);
    }
    const listed = mapsListResponseSchema.parse(await (await call(app, alice, '/api/maps')).json()).maps;
    expect(listed).toHaveLength(CREATABLE_MAP_TYPES.length);
  });

  it('has no way to store a personal map: it is drawn from the library, never created', async () => {
    const app = on();
    const response = await send(app, alice, 'POST', '/api/maps', { type: 'personal', title: 'Mine' });
    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('invalid_request');
    const generate = await send(app, alice, 'POST', '/api/maps/generate', { type: 'personal' });
    expect(generate.status).toBe(400);
  });

  it('refuses a blank title', async () => {
    const app = on();
    const response = await send(app, alice, 'POST', '/api/maps', { type: 'semantic', title: '   ', requestId: newId() });
    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('invalid_request');
  });
});

describe('maps belong to whoever drew them', () => {
  it('shows one reader nothing of another reader\'s map', async () => {
    const app = on();
    const map = await newMap(app, alice, { title: 'Alices map' });
    const listed = mapsListResponseSchema.parse(await (await call(app, bob, '/api/maps')).json()).maps;
    expect(listed.map((one) => one.id)).not.toContain(map.id);
    expect((await call(app, bob, `/api/maps/${map.id}`)).status).toBe(404);
    expect((await send(app, bob, 'PATCH', `/api/maps/${map.id}`, { title: 'stolen' })).status).toBe(404);
    expect((await send(app, bob, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'candidate', label: 'intruder' })).status).toBe(404);
    expect((await send(app, bob, 'DELETE', `/api/maps/${map.id}`)).status).toBe(404);
    // Alice's map is untouched by any of it.
    expect((await documentOf(app, alice, map.id)).title).toBe('Alices map');
  });

  it('refuses to point a node at a word from another reader', async () => {
    const app = on();
    const map = await newMap(app, alice);
    const bobsWord = await addWord(app, bob, { word: 'bobs' });
    const response = await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'saved', vocabularyId: bobsWord.id });
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
  });
});

describe('a saved node is a word read live; a suggestion is map data', () => {
  it('stores no text beside a saved word, and reads the word as it stands now', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn' });
    const map = await newMap(app, alice);
    const node = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: candid.id });
    expect(node.kind).toBe('saved');
    expect(node.vocabularyId).toBe(candid.id);
    expect(node.label).toBeNull();
    expect(node.word).toEqual({ id: candid.id, word: 'candid', meaning: 'thẳng thắn' });

    // Renaming the word updates the map without touching it: the map still
    // stores no label, and the rename does not move the map's revision.
    const beforeRename = (await documentOf(app, alice, map.id)).revision;
    const renamed = await send(app, alice, 'PATCH', `/api/vocabulary/${candid.id}`, { word: 'blunt' });
    expect(renamed.status).toBe(200);
    const after = await documentOf(app, alice, map.id);
    expect(after.nodes[0]?.label).toBeNull();
    expect(after.nodes[0]?.word?.word).toBe('blunt');
    expect(after.revision).toBe(beforeRename);
  });

  it('keeps a suggestion visibly separate: its own text, no word id', async () => {
    const app = on();
    const map = await newMap(app, alice);
    const node = await addNode(app, alice, map.id, { kind: 'candidate', label: 'fastidious', note: 'picky about details' });
    expect(node.kind).toBe('candidate');
    expect(node.label).toBe('fastidious');
    expect(node.vocabularyId).toBeNull();
    expect(node.word).toBeNull();
  });

  it('refuses the shapes that would blur the line', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid' });
    const map = await newMap(app, alice);
    // A suggestion without its word.
    expect((await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'candidate' })).status).toBe(400);
    // A suggestion carrying a word id.
    expect((await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'candidate', label: 'x', vocabularyId: candid.id })).status).toBe(400);
    // A saved node carrying its own text — its text is read live, never stored.
    const labelled = await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'saved', vocabularyId: candid.id, label: 'candid' });
    expect(labelled.status).toBe(400);
    expect(await errorCodeOf(labelled)).toBe('invalid_request');
    // Editing a saved node's text is impossible for the same reason.
    const node = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: candid.id });
    const patched = await send(app, alice, 'PATCH', `/api/maps/${map.id}/nodes/${node.id}`, { label: 'renamed' });
    expect(patched.status).toBe(400);
  });

  it('lets a candidate be corrected, and dedupes the same word twice', async () => {
    const app = on();
    const map = await newMap(app, alice);
    const first = await addNode(app, alice, map.id, { kind: 'candidate', label: 'recieve' });
    const patched = await ok<{ node: { label: string } }>(
      send(app, alice, 'PATCH', `/api/maps/${map.id}/nodes/${first.id}`, { label: 'receive' }),
    );
    expect(patched.node.label).toBe('receive');
    // The same suggestion again returns the node already there: one per map.
    const again = await addNode(app, alice, map.id, { kind: 'candidate', label: 'receive' });
    expect(again.id).toBe(first.id);
  });

  it('pins one meaning of a word where the relationship is about that meaning', async () => {
    const app = on();
    const word = await addWord(app, alice, { word: 'bank', meaning: 'ngân hàng' });
    const createdSense = await ok<{ sense: { id: string } }>(
      send(app, alice, 'POST', `/api/vocabulary/${word.id}/senses`, { requestId: newId(), meaning: 'bờ sông' }),
      201,
    );
    const senseId = createdSense.sense.id;
    expect(senseId).not.toBe('');
    const map = await newMap(app, alice);
    const node = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: word.id, senseId });
    expect(node.sense).toEqual({ id: senseId, meaning: 'bờ sông' });
    // A sense from a different word is refused.
    const other = await addWord(app, alice, { word: 'lucid' });
    const wrong = await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'saved', vocabularyId: other.id, senseId });
    expect(wrong.status).toBe(400);
  });
});

describe('relationships, by the kind of map that accepts them', () => {
  it('accepts only the kinds the map\'s type holds, and says which those are', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'candid' });
    const b = await addWord(app, alice, { word: 'frank' });
    const map = await newMap(app, alice, { type: 'semantic' });
    const one = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    const two = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: b.id });
    await addEdge(app, alice, map.id, { fromNodeId: one.id, toNodeId: two.id, kind: 'synonym' });
    const refused = await send(app, alice, 'POST', `/api/maps/${map.id}/edges`, { fromNodeId: one.id, toNodeId: two.id, kind: 'verb_noun' });
    expect(refused.status).toBe(400);
    expect(await errorMessageOf(refused)).toContain('synonym');
  });

  it('refuses a kind from another map’s table on family, theme and function maps', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'decide' });
    const b = await addWord(app, alice, { word: 'decision' });
    const cases = [
      ['word_family', 'verb_noun', 'inflection'],
      ['thematic', 'contrast', 'subtopic'],
      ['function', 'step', 'phrase_variant'],
    ] as const;
    for (const [type, wrong, allowed] of cases) {
      const map = await newMap(app, alice, { type });
      const one = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
      const two = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: b.id });
      const refused = await send(app, alice, 'POST', `/api/maps/${map.id}/edges`, {
        fromNodeId: one.id,
        toNodeId: two.id,
        kind: wrong,
      });
      expect(refused.status, `${type} accepted ${wrong}`).toBe(400);
      expect(await errorMessageOf(refused)).toContain(allowed);
    }
  });

  it('stores a collocation as the combination itself, and insists on one', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'make' });
    const b = await addWord(app, alice, { word: 'decision' });
    const map = await newMap(app, alice, { type: 'collocation' });
    const one = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    const two = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: b.id });
    const missing = await send(app, alice, 'POST', `/api/maps/${map.id}/edges`, { fromNodeId: one.id, toNodeId: two.id, kind: 'verb_noun' });
    expect(missing.status).toBe(400);
    const edge = await addEdge(app, alice, map.id, { fromNodeId: one.id, toNodeId: two.id, kind: 'verb_noun', pattern: 'make a decision' });
    expect(edge.pattern).toBe('make a decision');
  });

  it('insists a contrast says what the difference is', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'affect' });
    const b = await addWord(app, alice, { word: 'effect' });
    const map = await newMap(app, alice, { type: 'nuance' });
    const one = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    const two = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: b.id });
    const silent = await send(app, alice, 'POST', `/api/maps/${map.id}/edges`, { fromNodeId: one.id, toNodeId: two.id, kind: 'contrast' });
    expect(silent.status).toBe(400);
    const edge = await addEdge(app, alice, map.id, { fromNodeId: one.id, toNodeId: two.id, kind: 'contrast', note: 'Affect is the verb; effect is the thing caused.' });
    expect(edge.note).toContain('verb');
  });

  it('draws a two-way relationship once, whichever way it is drawn', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'big' });
    const b = await addWord(app, alice, { word: 'large' });
    const map = await newMap(app, alice, { type: 'semantic' });
    const one = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    const two = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: b.id });
    const first = await addEdge(app, alice, map.id, { fromNodeId: one.id, toNodeId: two.id, kind: 'synonym' });
    const second = await addEdge(app, alice, map.id, { fromNodeId: two.id, toNodeId: one.id, kind: 'synonym' });
    expect(second.id).toBe(first.id);
    expect((await documentOf(app, alice, map.id)).edges).toHaveLength(1);
  });

  it('refuses a node linked to itself', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'candid' });
    const map = await newMap(app, alice);
    const one = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    const response = await send(app, alice, 'POST', `/api/maps/${map.id}/edges`, { fromNodeId: one.id, toNodeId: one.id, kind: 'related' });
    expect(response.status).toBe(400);
  });

  it('keeps a scenario in order: a step points forwards, never back', async () => {
    const app = on();
    const map = await newMap(app, alice, { type: 'scenario' });
    const arrive = await addNode(app, alice, map.id, { kind: 'candidate', label: 'Excuse me, where is the gate?' });
    const order = await addNode(app, alice, map.id, { kind: 'candidate', label: 'I would like the chicken, please.' });
    const pay = await addNode(app, alice, map.id, { kind: 'candidate', label: 'Could I have the bill, please?' });
    // Each addition takes the next step, in the order it was added.
    expect([arrive.step, order.step, pay.step]).toEqual([1, 2, 3]);
    await addEdge(app, alice, map.id, { fromNodeId: arrive.id, toNodeId: order.id, kind: 'step' });
    const backwards = await send(app, alice, 'POST', `/api/maps/${map.id}/edges`, { fromNodeId: pay.id, toNodeId: order.id, kind: 'step' });
    expect(backwards.status).toBe(400);
  });

  it('removes a node\'s relationships with it, and leaves the words alone', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'candid' });
    const b = await addWord(app, alice, { word: 'frank' });
    const map = await newMap(app, alice);
    const one = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: b.id });
    await addEdge(app, alice, map.id, { fromNodeId: one.id, toNodeId: (await documentOf(app, alice, map.id)).nodes[1]?.id ?? '', kind: 'synonym' });
    await ok(send(app, alice, 'DELETE', `/api/maps/${map.id}/nodes/${one.id}`));
    const after = await documentOf(app, alice, map.id);
    expect(after.nodes).toHaveLength(1);
    expect(after.edges).toEqual([]);
    const words = await wordsOf(app, alice);
    expect(words.map((word) => word.word)).toContain('candid');
  });
});

describe('saving a suggestion is the one call that makes a word', () => {
  it('creates exactly one word, on that press and no other map action', async () => {
    const app = on();
    const map = await newMap(app, alice);
    const before = await wordsOf(app, alice);
    const node = await addNode(app, alice, map.id, { kind: 'candidate', label: 'meticulous', note: 'very careful' });
    // Drawing around the suggestion creates no vocabulary.
    await addNode(app, alice, map.id, { kind: 'candidate', label: 'zealous' });
    expect(await wordsOf(app, alice)).toHaveLength(before.length);

    const saved = saveCandidateResponseSchema.parse(
      await (await send(app, alice, 'POST', `/api/maps/${map.id}/nodes/${node.id}/save`, { requestId: newId() })).json(),
    );
    expect(saved.entryId).not.toBe('');
    expect(saved.node.kind).toBe('saved');
    expect(saved.node.label).toBeNull();
    expect(saved.node.word?.word).toBe('meticulous');

    const after = await wordsOf(app, alice);
    expect(after).toHaveLength(before.length + 1);
    // The new word is an ordinary word: nothing scheduled, no meaning yet.
    const made = after.find((word) => word.id === saved.entryId);
    expect(made?.word).toBe('meticulous');
    expect(made?.senses).toEqual([]);
    expect(made?.mastery).toBeLessThanOrEqual(1);
  });

  it('a second press on the same suggestion cannot make a second word', async () => {
    const app = on();
    const map = await newMap(app, alice);
    const node = await addNode(app, alice, map.id, { kind: 'candidate', label: 'oblique' });
    const before = await wordsOf(app, alice);
    const first = await send(app, alice, 'POST', `/api/maps/${map.id}/nodes/${node.id}/save`, { requestId: newId() });
    expect(first.status).toBe(201);
    const second = await send(app, alice, 'POST', `/api/maps/${map.id}/nodes/${node.id}/save`, { requestId: newId() });
    expect(second.status).toBe(400);
    expect(await wordsOf(app, alice)).toHaveLength(before.length + 1);
  });

  it('refuses a suggestion whose word is already saved, and makes no second copy', async () => {
    const app = on();
    await addWord(app, alice, { word: 'candid' });
    const map = await newMap(app, alice);
    const node = await addNode(app, alice, map.id, { kind: 'candidate', label: 'candid' });
    const before = await wordsOf(app, alice);
    const refused = await send(app, alice, 'POST', `/api/maps/${map.id}/nodes/${node.id}/save`, { requestId: newId() });
    // The ordinary word path's duplicate refusal reaches the caller unchanged.
    expect(refused.status).toBe(409);
    expect(await errorCodeOf(refused)).toBe('duplicate');
    expect(await wordsOf(app, alice)).toHaveLength(before.length);
    // And the suggestion stays a suggestion — the learner chooses another path.
    const document = await documentOf(app, alice, map.id);
    expect(document.nodes.find((one) => one.id === node.id)?.kind).toBe('candidate');
  });

  it('saves the node in place, keeping its relationships', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'zealous' });
    const map = await newMap(app, alice);
    const wordNode = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    const candidate = await addNode(app, alice, map.id, { kind: 'candidate', label: 'ardent', group: 'Feelings' });
    const edge = await addEdge(app, alice, map.id, { fromNodeId: wordNode.id, toNodeId: candidate.id, kind: 'synonym' });
    const saved = saveCandidateResponseSchema.parse(
      await (await send(app, alice, 'POST', `/api/maps/${map.id}/nodes/${candidate.id}/save`, { requestId: newId() })).json(),
    );
    expect(saved.node.kind).toBe('saved');
    const after = await documentOf(app, alice, map.id);
    const promoted = after.nodes.find((one) => one.id === candidate.id);
    expect(promoted?.kind).toBe('saved');
    expect(promoted?.group).toBe('Feelings');
    expect(after.edges.map((one) => one.id)).toContain(edge.id);
  });
});

describe('where the learner leaves the nodes, and the map says when it is behind', () => {
  it('stores the layout, and every structural change moves the revision on', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'candid' });
    const map = await newMap(app, alice);
    const node = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    await ok(send(app, alice, 'PUT', `/api/maps/${map.id}/layout`, { positions: [{ nodeId: node.id, x: 120, y: -40 }] }));
    const placed = await documentOf(app, alice, map.id);
    expect(placed.nodes[0]?.x).toBe(120);
    expect(placed.nodes[0]?.y).toBe(-40);
    expect(placed.revision).toBeGreaterThan(map.revision);
  });

  it('refuses a change made against a map that has since moved on', async () => {
    const app = on();
    const a = await addWord(app, alice, { word: 'candid' });
    const map = await newMap(app, alice);
    const node = await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: a.id });
    const stale = map.revision;
    await addNode(app, alice, map.id, { kind: 'candidate', label: 'later' }); // moves the revision on

    const renamed = await send(app, alice, 'PATCH', `/api/maps/${map.id}`, { title: 'Renamed', ifMatch: stale });
    expect(renamed.status).toBe(409);
    expect(await errorCodeOf(renamed)).toBe('conflict');

    const moved = await send(app, alice, 'PUT', `/api/maps/${map.id}/layout`, { positions: [{ nodeId: node.id, x: 1, y: 1 }], ifMatch: stale });
    expect(moved.status).toBe(409);

    // Without the lock the change lands; with the current revision it lands too.
    const current = (await documentOf(app, alice, map.id)).revision;
    const accepted = await send(app, alice, 'PATCH', `/api/maps/${map.id}`, { title: 'Renamed', ifMatch: current });
    expect(accepted.status).toBe(200);
  });

  it('repeats a creation for the same request id instead of making a second one', async () => {
    const app = on();
    const requestId = newId();
    const first = await ok<{ map: VocabMapSummary }>(send(app, alice, 'POST', '/api/maps', { type: 'semantic', title: 'Once', requestId }), 201);
    const second = await ok<{ map: VocabMapSummary }>(send(app, alice, 'POST', '/api/maps', { type: 'semantic', title: 'Once', requestId }), 201);
    expect(second.map.id).toBe(first.map.id);
    const listed = mapsListResponseSchema.parse(await (await call(app, alice, '/api/maps')).json()).maps;
    expect(listed).toHaveLength(1);
  });
});

describe('deleting a map keeps every word', () => {
  it('removes the diagram and its suggestions, and not one word', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid' });
    const lucid = await addWord(app, alice, { word: 'lucid' });
    const map = await newMap(app, alice);
    await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: candid.id });
    await addNode(app, alice, map.id, { kind: 'saved', vocabularyId: lucid.id });
    const suggestion = await addNode(app, alice, map.id, { kind: 'candidate', label: 'perspicacious' });
    expect(suggestion.label).toBe('perspicacious');

    await ok(send(app, alice, 'DELETE', `/api/maps/${map.id}`));
    expect((await call(app, alice, `/api/maps/${map.id}`)).status).toBe(404);
    const words = (await wordsOf(app, alice)).map((word) => word.word);
    expect(words).toContain('candid');
    expect(words).toContain('lucid');
    expect(words).not.toContain('perspicacious');
  });
});

describe('the personal map is the reader\'s library, drawn live', () => {
  it('draws words in their collections and links saved between them, and claims no mastery', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn', mastery: 5 });
    const lucid = await addWord(app, alice, { word: 'lucid', meaning: 'sáng rõ' });
    const collection = await ok<{ collection: { id: string } }>(send(app, alice, 'POST', '/api/collections', { name: 'Work' }), 201);
    await ok(send(app, alice, 'PUT', `/api/collections/${collection.collection.id}/words/${candid.id}`, { member: true }));
    await ok(send(app, alice, 'POST', '/api/relations', { fromId: candid.id, toId: lucid.id, kind: 'synonym' }), 201);

    const reply = personalMapResponseSchema.parse(await (await call(app, alice, '/api/maps/personal')).json());
    expect(reply.personal.type).toBe('personal');
    const candidNode = reply.personal.nodes.find((node) => node.vocabularyId === candid.id);
    expect(candidNode?.kind).toBe('saved');
    expect(candidNode?.group).toBe('Work');
    expect(reply.personal.edges.map((edge) => edge.kind)).toContain('synonym');
    // Each word's meaning is its first recorded sense, so two words carry two.
    expect(reply.stats).toEqual({ words: 2, maps: 0, collections: 1, relations: 1, senses: 2 });
    // It is a picture of the library, not a claim about learning: the words
    // carry their own figures and nothing here grades them.
    expect(reply.personal.description).toContain('nothing here is a claim about mastery');
    expect(candidNode?.word).toEqual({ id: candid.id, word: 'candid', meaning: 'thẳng thắn' });
  });

  it('is never stored, never listed, and opening it changes nothing', async () => {
    const app = on();
    const candid = await addWord(app, alice, { word: 'candid', mastery: 3, reviewDate: '2026-10-20' });
    const before = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${candid.id}`)).json()).entry;
    await call(app, alice, '/api/maps/personal');
    await call(app, alice, '/api/maps/personal');
    const after = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${candid.id}`)).json()).entry;
    expect(after).toEqual(before);
    const listed = mapsListResponseSchema.parse(await (await call(app, alice, '/api/maps')).json()).maps;
    expect(listed.map((map) => map.id)).not.toContain('personal');
    // And it cannot be expanded: there is nothing of its own to add to.
    const expand = await send(app, alice, 'POST', '/api/maps/personal/expand', {});
    expect(expand.status).toBe(400);
    expect(await errorCodeOf(expand)).toBe('invalid_request');
  });
});

describe('an account with saving switched off reads maps and draws nothing', () => {
  it('refuses to create, add, save or delete, and still lists and shows', async () => {
    const app = on({ REVIEW_WRITES_ENABLED: 'false' });
    const created = await send(app, alice, 'POST', '/api/maps', { type: 'semantic', title: 'Nope', requestId: newId() });
    expect(created.status).toBe(403);
    expect(await errorCodeOf(created)).toBe('read_only');
    const listed = await call(app, alice, '/api/maps');
    expect(listed.status).toBe(200);
    const personal = await call(app, alice, '/api/maps/personal');
    expect(personal.status).toBe(200);
  });
});

describe('a map has its limits, and says so plainly', () => {
  it('refuses one more node past the cap', async () => {
    const app = on();
    const map = await newMap(app, alice);
    for (let index = 0; index < VOCAB_MAP_LIMITS.nodes; index += 1) {
      await addNode(app, alice, map.id, { kind: 'candidate', label: `word-${index}` });
    }
    const full = await send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, { kind: 'candidate', label: 'one-too-many' });
    expect(full.status).toBe(409);
    expect(await errorCodeOf(full)).toBe('map_full');
  }, 60_000);
});
