/**
 * The blueprint's integration promise walked as one story at the HTTP API on
 * the real schema (§7, Trách nhiệm liên miền): a word found while reading
 * travels to the Library, is drawn on a map, is answered once, and shows up
 * in Progress — and at every step the cross-domain rules hold: seeing saves
 * nothing, saving a map saves no word, only the answer moves the learning
 * record, and every block reads the same word from the same place, for one
 * account alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  analyticsResponseSchema,
  entryResponseSchema,
  vocabularyListResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import {
  discoveryContextResponseSchema,
  discoveryListResponseSchema,
  discoverySaveResponseSchema,
} from '../../shared/discovery.js';
import { mapResponseSchema } from '../../shared/vocab-map.js';
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

const TODAY = '2026-10-09';

/** The app as it is at noon in Vietnam on that day. */
const on = () => createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${TODAY}T05:00:00Z`) });

const ok = async <T>(response: Response | Promise<Response>, status = 200): Promise<T> => {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(status);
  return (await settled.json()) as T;
};

const send = (app: TestApp, user: TestUser, method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, body?: unknown) =>
  call(app, user, path, { method, body });

const wordsOf = async (app: TestApp, user: TestUser): Promise<VocabularyEntry[]> =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;

const sourcesOf = async (app: TestApp, user: TestUser) =>
  discoveryListResponseSchema.parse(await (await call(app, user, '/api/discovery')).json()).sources;

const analyticsOf = async (app: TestApp, user: TestUser) =>
  analyticsResponseSchema.parse(await (await call(app, user, '/api/analytics')).json());

const documentOf = async (app: TestApp, user: TestUser, mapId: string) =>
  mapResponseSchema.parse(await (await call(app, user, `/api/maps/${mapId}`)).json()).map;

describe('one word through every block, one truth each', () => {
  it('walks a word from a text to an answer without any block writing another block’s records', async () => {
    const app = on();

    // Nothing seen, nothing saved, nothing answered.
    expect(await wordsOf(app, alice)).toHaveLength(0);
    expect(await sourcesOf(app, alice)).toHaveLength(0);
    const untouched = await analyticsOf(app, alice);
    expect(untouched.periods.today.reviews).toBe(0);
    expect(untouched.firstReviewOn).toBeNull();

    // Reading: a source exists — and the word does not.
    const content = 'She was candid about the mistake, which surprised everyone.';
    const source = (
      await ok<{ source: { id: string } }>(
        send(app, alice, 'POST', '/api/discovery', {
          kind: 'text',
          title: 'A candid note',
          content,
          requestId: newId(),
        }),
        201,
      )
    ).source;
    expect(await wordsOf(app, alice)).toHaveLength(0);
    expect((await analyticsOf(app, alice)).periods.today.reviews).toBe(0);

    // The one press that saves: into the Library, with its source behind it.
    const saved = discoverySaveResponseSchema.parse(
      await ok(
        send(app, alice, 'POST', '/api/discovery/save', {
          word: 'candid',
          sourceId: source.id,
          offset: content.indexOf('candid'),
          requestId: newId(),
        }),
        201,
      ),
    ).entry;
    const words = await wordsOf(app, alice);
    expect(words.map((word) => word.word)).toEqual(['candid']);
    const context = discoveryContextResponseSchema.parse(
      await (await call(app, alice, `/api/discovery/context?vocabularyId=${saved.id}`)).json(),
    );
    expect(context.source.title).toBe('A candid note');
    // Saving is still not answering: the learning record stands untouched.
    const savedOnly = await analyticsOf(app, alice);
    expect(savedOnly.periods.today.reviews).toBe(0);
    expect(savedOnly.firstReviewOn).toBeNull();

    // Drawing: the map takes the word; the Library does not grow by a word.
    const map = (
      await ok<{ map: { id: string } }>(
        send(app, alice, 'POST', '/api/maps', { type: 'semantic', title: 'Candour', requestId: newId() }),
        201,
      )
    ).map;
    await ok(
      send(app, alice, 'POST', `/api/maps/${map.id}/nodes`, {
        kind: 'saved',
        vocabularyId: saved.id,
        requestId: newId(),
      }),
      201,
    );
    expect(await wordsOf(app, alice)).toHaveLength(1);
    expect((await analyticsOf(app, alice)).periods.today.reviews).toBe(0);
    const drawn = await documentOf(app, alice, map.id);
    expect(drawn.nodeCount).toBe(1);

    // The answer: the one act that moves the learning record.
    const current = entryResponseSchema.parse(await (await call(app, alice, `/api/vocabulary/${saved.id}`)).json()).entry;
    const answered = await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: {
        pageId: saved.id,
        action: 'remember',
        expected: { mastery: current.mastery, nextReview: current.reviewDate },
        requestId: newId(),
      },
    });
    expect(answered.status, await answered.clone().text()).toBe(200);
    const evidenced = await analyticsOf(app, alice);
    expect(evidenced.periods.today.reviews).toBe(1);
    expect(evidenced.firstReviewOn).toBe(TODAY);

    // Every block still agrees on the same word — and the answer wrote only
    // its own record: the source and the map stand exactly where they were.
    const still = await wordsOf(app, alice);
    expect(still).toHaveLength(1);
    expect(still[0]?.id).toBe(saved.id);
    expect(still[0]?.mastery ?? 0).toBeGreaterThan(current.mastery ?? 0);

    const afterContext = discoveryContextResponseSchema.parse(
      await (await call(app, alice, `/api/discovery/context?vocabularyId=${saved.id}`)).json(),
    );
    expect(afterContext.source.id).toBe(source.id);
    expect(await sourcesOf(app, alice)).toHaveLength(1);

    const afterMap = await documentOf(app, alice, map.id);
    expect(afterMap.revision).toBe(drawn.revision);
    expect(afterMap.nodeCount).toBe(1);

    // Another learner sees none of it: no shared sources of truth.
    expect(await wordsOf(app, bob)).toHaveLength(0);
    expect(await sourcesOf(app, bob)).toHaveLength(0);
    expect((await analyticsOf(app, bob)).periods.today.reviews).toBe(0);
  });
});
