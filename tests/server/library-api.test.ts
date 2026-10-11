/**
 * Collections, further examples and relationships between words, through the
 * HTTP API on the real schema. Two things run through every part: one account
 * can never reach another's, and nothing here changes or deletes a word.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_CAPABILITIES,
  entryResponseSchema,
  libraryResponseSchema,
  queueResponseSchema,
  vocabularyListResponseSchema,
  type LibraryResponse,
  type VocabularyEntry,
} from '../../shared/api.js';
import { collectionKey, orderPair, otherEnd, tidyName } from '../../shared/library.js';
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
const on = (day: string, database: TestDatabase = db, users: TestUser[] = [alice, bob], env?: Record<string, string>) =>
  createSupabaseTestApp(database, users, { now: () => new Date(`${day}T05:00:00Z`), env });

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const send = (app: TestApp, user: TestUser | null, method: Method, path: string, body?: unknown) =>
  call(app, user, path, { method, body });

async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(status);
  return (await settled.json()) as T;
}

const libraryOf = async (app: TestApp, user: TestUser): Promise<LibraryResponse> =>
  libraryResponseSchema.parse(await (await call(app, user, '/api/library')).json());

interface Made {
  id: string;
  name: string;
  wordIds: string[];
}
const newCollection = async (app: TestApp, user: TestUser, name: string) =>
  (await ok<{ collection: Made }>(send(app, user, 'POST', '/api/collections', { name }), 201)).collection;
const put = (app: TestApp, user: TestUser | null, collectionId: string, wordId: string, member: boolean) =>
  send(app, user, 'PUT', `/api/collections/${collectionId}/words/${wordId}`, { member });

/** A word exactly as the database holds it, schedule included. */
const stored = (id: string) =>
  db.admin(
    `select v.word, v.meaning, v.example, v.deleted_at, v.updated_at, c.mastery, c.review_date::text as review_date, c.updated_at as state_at
       from public.vocabulary v join public.card_states c on c.vocabulary_id = v.id where v.id = $1`,
    [id],
  );

describe('before anything is organised', () => {
  it('has nothing, and says the store can keep it', async () => {
    expect(await libraryOf(on(TODAY), alice)).toEqual({ available: true, collections: [], examples: [], relations: [] });
  });

  it('is refused to a visitor who is not signed in', async () => {
    const app = on(TODAY);
    expect((await call(app, null, '/api/library')).status).toBe(401);
    expect((await send(app, null, 'POST', '/api/collections', { name: 'IELTS' })).status).toBe(401);
  });
});

describe('collections', () => {
  it('are created with a tidied name and start empty', async () => {
    const app = on(TODAY);
    const made = await newCollection(app, alice, '  Books   and  reading ');
    expect(made).toMatchObject({ name: 'Books and reading', wordIds: [] });
    expect((await libraryOf(app, alice)).collections).toEqual([made]);
  });

  it('are listed by name', async () => {
    const app = on(TODAY);
    for (const name of ['School', 'books', 'IELTS']) await newCollection(app, alice, name);
    expect((await libraryOf(app, alice)).collections.map((collection) => collection.name)).toEqual(['books', 'IELTS', 'School']);
  });

  it('cannot share a name, whatever the case or spacing', async () => {
    const app = on(TODAY);
    await newCollection(app, alice, 'IELTS');
    for (const name of ['IELTS', 'ielts', '  Ielts  ']) {
      const response = await send(app, alice, 'POST', '/api/collections', { name });
      expect(response.status, name).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('duplicate');
    }
    expect((await libraryOf(app, alice)).collections).toHaveLength(1);
    // Another account is free to use the same name.
    await newCollection(app, bob, 'IELTS');
  });

  it.each([[''], ['   '], ['x'.repeat(81)]])('refuse the name %j', async (name) => {
    const app = on(TODAY);
    expect((await send(app, alice, 'POST', '/api/collections', { name })).status).toBe(400);
    expect((await libraryOf(app, alice)).collections).toEqual([]);
  });

  it('can be renamed, keeping their words', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const made = await newCollection(app, alice, 'Exam');
    await ok(put(app, alice, made.id, word.id, true));
    const renamed = await ok<{ collection: Made }>(send(app, alice, 'PATCH', `/api/collections/${made.id}`, { name: 'IELTS' }));
    expect(renamed.collection).toEqual({ id: made.id, name: 'IELTS', wordIds: [word.id] });
  });

  it('cannot be renamed onto another collection’s name, but can change their own case', async () => {
    const app = on(TODAY);
    const first = await newCollection(app, alice, 'IELTS');
    await newCollection(app, alice, 'Books');
    expect((await send(app, alice, 'PATCH', `/api/collections/${first.id}`, { name: 'books' })).status).toBe(409);
    await ok(send(app, alice, 'PATCH', `/api/collections/${first.id}`, { name: 'Ielts' }));
    expect((await libraryOf(app, alice)).collections.map((collection) => collection.name)).toEqual(['Books', 'Ielts']);
  });

  it('hold the words put in them; a word may be in several', async () => {
    const app = on(TODAY);
    const candid = await addWord(app, alice, { word: 'candid' });
    const lucid = await addWord(app, alice, { word: 'lucid' });
    const exam = await newCollection(app, alice, 'Exam');
    const books = await newCollection(app, alice, 'Books');
    await ok(put(app, alice, exam.id, candid.id, true));
    await ok(put(app, alice, exam.id, lucid.id, true));
    await ok(put(app, alice, books.id, candid.id, true));

    const { collections } = await libraryOf(app, alice);
    expect(collections.find((collection) => collection.id === exam.id)?.wordIds.sort()).toEqual([candid.id, lucid.id].sort());
    expect(collections.find((collection) => collection.id === books.id)?.wordIds).toEqual([candid.id]);
  });

  it('adding a word twice, or removing one that is not there, changes nothing', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const other = await addWord(app, alice, { word: 'lucid' });
    const made = await newCollection(app, alice, 'Exam');
    await ok(put(app, alice, made.id, word.id, true));
    await ok(put(app, alice, made.id, word.id, true));
    await ok(put(app, alice, made.id, other.id, false));
    expect((await libraryOf(app, alice)).collections[0]?.wordIds).toEqual([word.id]);
    await ok(put(app, alice, made.id, word.id, false));
    expect((await libraryOf(app, alice)).collections[0]?.wordIds).toEqual([]);
  });

  it('deleting one removes it and its memberships, and leaves every word exactly as it was', async () => {
    const app = on(TODAY);
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn', mastery: 4, reviewDate: '2026-10-20' });
    const lucid = await addWord(app, alice, { word: 'lucid' });
    const exam = await newCollection(app, alice, 'Exam');
    const books = await newCollection(app, alice, 'Books');
    await ok(put(app, alice, exam.id, candid.id, true));
    await ok(put(app, alice, exam.id, lucid.id, true));
    await ok(put(app, alice, books.id, candid.id, true));
    const before = [await stored(candid.id), await stored(lucid.id)];

    expect(await ok(send(app, alice, 'DELETE', `/api/collections/${exam.id}`))).toEqual({ id: exam.id, deleted: true });

    expect([await stored(candid.id), await stored(lucid.id)]).toEqual(before);
    const words = vocabularyListResponseSchema.parse(await (await call(app, alice, '/api/vocabulary')).json()).entries;
    expect(words.map((entry) => entry.word).sort()).toEqual(['candid', 'lucid']);
    // The other collection still has its word.
    expect((await libraryOf(app, alice)).collections).toEqual([{ id: books.id, name: 'Books', wordIds: [candid.id] }]);
    expect(await db.admin('select count(*)::int as count from public.collection_items')).toEqual([{ count: 1 }]);
    expect((await send(app, alice, 'DELETE', `/api/collections/${exam.id}`)).status).toBe(404);
  });

  it('leave a trashed word out of their lists, and show it again when it is restored', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const made = await newCollection(app, alice, 'Exam');
    await ok(put(app, alice, made.id, word.id, true));
    await send(app, alice, 'DELETE', `/api/vocabulary/${word.id}`);
    expect((await libraryOf(app, alice)).collections[0]?.wordIds).toEqual([]);
    await send(app, alice, 'POST', `/api/vocabulary/${word.id}/restore`);
    expect((await libraryOf(app, alice)).collections[0]?.wordIds).toEqual([word.id]);
  });

  it('refuse a word that is in the trash or does not exist, and a collection that does not', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const gone = await addWord(app, alice, { word: 'gone' });
    await send(app, alice, 'DELETE', `/api/vocabulary/${gone.id}`);
    const made = await newCollection(app, alice, 'Exam');
    expect((await put(app, alice, made.id, gone.id, true)).status).toBe(404);
    expect((await put(app, alice, made.id, newId(), true)).status).toBe(404);
    expect((await put(app, alice, newId(), word.id, true)).status).toBe(404);
    expect((await put(app, alice, 'not-an-id', word.id, true)).status).toBe(400);
    expect((await send(app, alice, 'PATCH', `/api/collections/${newId()}`, { name: 'X' })).status).toBe(404);
  });
});

describe('reviewing one collection', () => {
  const queueOf = async (app: TestApp, user: TestUser, query: string) =>
    queueResponseSchema.parse(await (await call(app, user, `/api/review-queue${query}`)).json());

  it('shows only the due words in it, in the usual order', async () => {
    const app = on(TODAY);
    const late = await addWord(app, alice, { word: 'late', mastery: 2, reviewDate: '2026-10-01' });
    const now = await addWord(app, alice, { word: 'now', mastery: 2, reviewDate: TODAY });
    const later = await addWord(app, alice, { word: 'later', mastery: 2, reviewDate: '2026-10-20' });
    await addWord(app, alice, { word: 'outside', mastery: 2, reviewDate: '2026-10-02' });
    const made = await newCollection(app, alice, 'Exam');
    for (const word of [now, later, late]) await ok(put(app, alice, made.id, word.id, true));

    const queue = await queueOf(app, alice, `?collection=${made.id}`);
    expect(queue.cards.map((card) => card.word)).toEqual(['late', 'now']);
    expect(queue).toMatchObject({ focus: null, collection: { id: made.id, name: 'Exam' }, vocabulary: 'in_progress' });
    // The word that is in the collection but not due is not brought forward.
    expect(queue.cards.map((card) => card.word)).not.toContain('later');
    expect((await queueOf(app, alice, '')).collection).toBeNull();
  });

  it('is empty for an empty collection, without claiming nothing at all is due', async () => {
    const app = on(TODAY);
    await addWord(app, alice, { word: 'due' });
    const made = await newCollection(app, alice, 'Empty');
    expect(await queueOf(app, alice, `?collection=${made.id}`)).toMatchObject({ cards: [], vocabulary: 'in_progress' });
  });

  it('refuses a collection that is not the caller’s, an unknown one, and a second way of narrowing', async () => {
    const app = on(TODAY);
    const theirs = await newCollection(app, bob, 'Bob');
    expect((await call(app, alice, `/api/review-queue?collection=${theirs.id}`)).status).toBe(404);
    expect((await call(app, alice, `/api/review-queue?collection=${newId()}`)).status).toBe(404);
    expect((await call(app, alice, '/api/review-queue?collection=nope')).status).toBe(400);
    const mine = await newCollection(app, alice, 'Mine');
    expect((await call(app, alice, `/api/review-queue?collection=${mine.id}&focus=weak`)).status).toBe(400);
  });
});

describe('further examples', () => {
  interface Example {
    id: string;
    vocabularyId: string;
    sentence: string;
    source: string | null;
    preferred: boolean;
  }
  const add = (app: TestApp, user: TestUser, wordId: string, body: Record<string, unknown>) =>
    send(app, user, 'POST', `/api/vocabulary/${wordId}/examples`, body);
  const added = async (app: TestApp, user: TestUser, wordId: string, body: Record<string, unknown>) =>
    (await ok<{ example: Example }>(add(app, user, wordId, body), 201)).example;

  it('are added to a word with an optional note of where they came from', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid', example: 'The original example.' });
    const first = await added(app, alice, word.id, { sentence: '  A candid reply.  ', source: ' The Economist ' });
    const second = await added(app, alice, word.id, { sentence: 'Be candid with me.' });
    expect(first).toMatchObject({ vocabularyId: word.id, sentence: 'A candid reply.', source: 'The Economist', preferred: false });
    expect(second).toMatchObject({ source: null, preferred: false });
    expect((await libraryOf(app, alice)).examples).toEqual([first, second]);
  });

  it('never replace or alter the word’s own example', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid', example: 'The original example.' });
    const before = await stored(word.id);
    const extra = await added(app, alice, word.id, { sentence: 'Another one.', preferred: true });
    await ok(send(app, alice, 'PATCH', `/api/examples/${extra.id}`, { sentence: 'Another one, edited.' }));
    await ok(send(app, alice, 'DELETE', `/api/examples/${extra.id}`));
    expect(await stored(word.id)).toEqual(before);
  });

  it('have at most one preferred example per word, and choosing another moves the mark', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const other = await addWord(app, alice, { word: 'lucid' });
    const a = await added(app, alice, word.id, { sentence: 'One.', preferred: true });
    const b = await added(app, alice, word.id, { sentence: 'Two.' });
    const elsewhere = await added(app, alice, other.id, { sentence: 'Three.', preferred: true });
    expect(a.preferred).toBe(true);

    await ok(send(app, alice, 'PATCH', `/api/examples/${b.id}`, { preferred: true }));
    const preferred = (await libraryOf(app, alice)).examples.filter((example) => example.preferred).map((example) => example.id);
    // The mark moved within the word; the other word's preferred example is untouched.
    expect(preferred.sort()).toEqual([b.id, elsewhere.id].sort());

    await ok(send(app, alice, 'PATCH', `/api/examples/${b.id}`, { preferred: false }));
    expect((await libraryOf(app, alice)).examples.filter((example) => example.vocabularyId === word.id && example.preferred)).toEqual([]);
  });

  it('can be edited, have their note cleared, and be deleted', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const extra = await added(app, alice, word.id, { sentence: 'Draft.', source: 'a book' });
    const edited = await ok<{ example: Example }>(
      send(app, alice, 'PATCH', `/api/examples/${extra.id}`, { sentence: 'Final.', source: null }),
    );
    expect(edited.example).toEqual({ ...extra, sentence: 'Final.', source: null });
    expect(await ok(send(app, alice, 'DELETE', `/api/examples/${extra.id}`))).toEqual({ id: extra.id, deleted: true });
    expect((await libraryOf(app, alice)).examples).toEqual([]);
    expect((await send(app, alice, 'DELETE', `/api/examples/${extra.id}`)).status).toBe(404);
  });

  it.each([
    ['an empty sentence', { sentence: '   ' }],
    ['an over-long sentence', { sentence: 'x'.repeat(2001) }],
    ['an over-long source', { sentence: 'Fine.', source: 'x'.repeat(301) }],
    ['no sentence', { source: 'a book' }],
    ['a field that does not exist', { sentence: 'Fine.', mastery: 10 }],
  ])('refuse %s', async (_name, body) => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    expect((await add(app, alice, word.id, body)).status).toBe(400);
    expect((await libraryOf(app, alice)).examples).toEqual([]);
  });

  it('refuse a word that is in the trash or does not exist, and hide the examples of a trashed word', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const extra = await added(app, alice, word.id, { sentence: 'Kept.' });
    await send(app, alice, 'DELETE', `/api/vocabulary/${word.id}`);
    expect((await add(app, alice, word.id, { sentence: 'No.' })).status).toBe(404);
    expect((await add(app, alice, newId(), { sentence: 'No.' })).status).toBe(404);
    expect((await libraryOf(app, alice)).examples).toEqual([]);
    expect((await send(app, alice, 'PATCH', `/api/examples/${extra.id}`, { sentence: 'No.' })).status).toBe(404);
    await send(app, alice, 'POST', `/api/vocabulary/${word.id}/restore`);
    expect((await libraryOf(app, alice)).examples).toEqual([extra]);
  });
});

describe('relationships between words', () => {
  interface Link {
    id: string;
    kind: string;
    a: string;
    b: string;
  }
  const link = (app: TestApp, user: TestUser | null, fromId: string, toId: string, kind: string) =>
    send(app, user, 'POST', '/api/relations', { fromId, toId, kind });
  const linked = async (app: TestApp, user: TestUser, fromId: string, toId: string, kind: string) =>
    (await ok<{ relation: Link }>(link(app, user, fromId, toId, kind), 201)).relation;

  it('link two of the account’s words with a stated kind', async () => {
    const app = on(TODAY);
    const big = await addWord(app, alice, { word: 'big' });
    const large = await addWord(app, alice, { word: 'large' });
    const made = await linked(app, alice, big.id, large.id, 'synonym');
    expect(made.kind).toBe('synonym');
    expect([made.a, made.b].sort()).toEqual([big.id, large.id].sort());
    expect((await libraryOf(app, alice)).relations).toEqual([made]);
  });

  it('are the same link whichever word they are entered from, and are never duplicated', async () => {
    const app = on(TODAY);
    const big = await addWord(app, alice, { word: 'big' });
    const large = await addWord(app, alice, { word: 'large' });
    const first = await linked(app, alice, big.id, large.id, 'synonym');
    const reversed = await linked(app, alice, large.id, big.id, 'synonym');
    const again = await linked(app, alice, big.id, large.id, 'synonym');
    expect(reversed).toEqual(first);
    expect(again).toEqual(first);
    expect(await db.admin('select count(*)::int as count from public.vocabulary_relations')).toEqual([{ count: 1 }]);
  });

  it('may link the same pair in more than one way', async () => {
    const app = on(TODAY);
    const affect = await addWord(app, alice, { word: 'affect' });
    const effect = await addWord(app, alice, { word: 'effect' });
    await linked(app, alice, affect.id, effect.id, 'confused');
    await linked(app, alice, affect.id, effect.id, 'related');
    expect((await libraryOf(app, alice)).relations.map((relation) => relation.kind).sort()).toEqual(['confused', 'related']);
  });

  it('accept each kind the app knows and no other', async () => {
    const app = on(TODAY);
    const one = await addWord(app, alice, { word: 'one' });
    const two = await addWord(app, alice, { word: 'two' });
    for (const kind of ['synonym', 'antonym', 'word_family', 'collocation', 'related', 'confused']) {
      await linked(app, alice, one.id, two.id, kind);
    }
    for (const kind of ['', 'hypernym', 'SYNONYM']) {
      expect((await link(app, alice, one.id, two.id, kind)).status, kind).toBe(400);
    }
    expect((await libraryOf(app, alice)).relations).toHaveLength(6);
  });

  it('cannot relate a word to itself', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    expect((await link(app, alice, word.id, word.id, 'synonym')).status).toBe(400);
    expect((await libraryOf(app, alice)).relations).toEqual([]);
  });

  it('are never created by the app on its own', async () => {
    const app = on(TODAY);
    // Two words that plainly go together: nothing links them until their owner does.
    await addWord(app, alice, { word: 'happy', meaning: 'vui' });
    await addWord(app, alice, { word: 'glad', meaning: 'vui' });
    expect((await libraryOf(app, alice)).relations).toEqual([]);
    expect(await db.admin('select count(*)::int as count from public.vocabulary_relations')).toEqual([{ count: 0 }]);
  });

  it('can be removed, leaving both words as they were', async () => {
    const app = on(TODAY);
    const big = await addWord(app, alice, { word: 'big', mastery: 5, reviewDate: '2026-10-20' });
    const large = await addWord(app, alice, { word: 'large' });
    const before = [await stored(big.id), await stored(large.id)];
    const made = await linked(app, alice, big.id, large.id, 'synonym');
    expect(await ok(send(app, alice, 'DELETE', `/api/relations/${made.id}`))).toEqual({ id: made.id, deleted: true });
    expect((await libraryOf(app, alice)).relations).toEqual([]);
    expect([await stored(big.id), await stored(large.id)]).toEqual(before);
    expect((await send(app, alice, 'DELETE', `/api/relations/${made.id}`)).status).toBe(404);
  });

  it('refuse a word in the trash, and hide a link while either word is trashed', async () => {
    const app = on(TODAY);
    const big = await addWord(app, alice, { word: 'big' });
    const large = await addWord(app, alice, { word: 'large' });
    const huge = await addWord(app, alice, { word: 'huge' });
    const made = await linked(app, alice, big.id, large.id, 'synonym');
    await send(app, alice, 'DELETE', `/api/vocabulary/${large.id}`);
    expect((await link(app, alice, huge.id, large.id, 'synonym')).status).toBe(404);
    expect((await libraryOf(app, alice)).relations).toEqual([]);
    await send(app, alice, 'POST', `/api/vocabulary/${large.id}/restore`);
    expect((await libraryOf(app, alice)).relations).toEqual([made]);
  });
});

describe('one account and another', () => {
  it('see only their own collections, examples and links', async () => {
    const app = on(TODAY);
    const mine = await addWord(app, alice, { word: 'mine' });
    const also = await addWord(app, alice, { word: 'also-mine' });
    const made = await newCollection(app, alice, 'Private');
    await ok(put(app, alice, made.id, mine.id, true));
    await ok(send(app, alice, 'POST', `/api/vocabulary/${mine.id}/examples`, { sentence: 'Mine.' }), 201);
    await ok(send(app, alice, 'POST', '/api/relations', { fromId: mine.id, toId: also.id, kind: 'related' }), 201);

    expect(await libraryOf(app, bob)).toEqual({ available: true, collections: [], examples: [], relations: [] });
    for (const table of ['collections', 'collection_items', 'vocabulary_examples', 'vocabulary_relations']) {
      expect(await db.as(bob.id, (s) => s.query(`select * from public.${table}`)), table).toEqual([]);
      await expect(db.asAnon((s) => s.query(`select * from public.${table}`)), table).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('cannot put their word in another’s collection, or another’s word in theirs', async () => {
    const app = on(TODAY);
    const alices = await addWord(app, alice, { word: 'alices' });
    const bobs = await addWord(app, bob, { word: 'bobs' });
    const aliceCollection = await newCollection(app, alice, 'Alice');
    const bobCollection = await newCollection(app, bob, 'Bob');

    expect((await put(app, bob, aliceCollection.id, bobs.id, true)).status).toBe(404);
    expect((await put(app, bob, bobCollection.id, alices.id, true)).status).toBe(404);
    expect(await db.admin('select count(*)::int as count from public.collection_items')).toEqual([{ count: 0 }]);
    // At the database too, with no application code in the way.
    for (const [collection, word] of [
      [aliceCollection.id, bobs.id],
      [bobCollection.id, alices.id],
      [aliceCollection.id, alices.id],
    ]) {
      await expect(
        db.as(bob.id, (s) => s.query('insert into public.collection_items (collection_id, vocabulary_id) values ($1, $2)', [collection, word])),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|42501)$/) });
    }
  });

  it('cannot change, empty or delete another’s collection', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const made = await newCollection(app, alice, 'Private');
    await ok(put(app, alice, made.id, word.id, true));

    expect((await send(app, bob, 'PATCH', `/api/collections/${made.id}`, { name: 'Taken' })).status).toBe(404);
    expect((await send(app, bob, 'DELETE', `/api/collections/${made.id}`)).status).toBe(404);
    expect((await put(app, bob, made.id, word.id, false)).status).toBe(404);
    await db.as(bob.id, (s) => s.query('delete from public.collections'));
    await db.as(bob.id, (s) => s.query('delete from public.collection_items'));
    await db.as(bob.id, (s) => s.query(`update public.collections set name = 'Taken', name_key = 'taken'`));
    expect((await libraryOf(app, alice)).collections).toEqual([{ id: made.id, name: 'Private', wordIds: [word.id] }]);
  });

  it('cannot add to, edit or remove another’s examples and links, or link to another’s word', async () => {
    const app = on(TODAY);
    const alices = await addWord(app, alice, { word: 'alices' });
    const second = await addWord(app, alice, { word: 'second' });
    const bobs = await addWord(app, bob, { word: 'bobs' });
    const example = (await ok<{ example: { id: string } }>(
      send(app, alice, 'POST', `/api/vocabulary/${alices.id}/examples`, { sentence: 'Mine.' }),
      201,
    )).example;
    const relation = (await ok<{ relation: { id: string } }>(
      send(app, alice, 'POST', '/api/relations', { fromId: alices.id, toId: second.id, kind: 'related' }),
      201,
    )).relation;

    expect((await send(app, bob, 'POST', `/api/vocabulary/${alices.id}/examples`, { sentence: 'Hi.' })).status).toBe(404);
    expect((await send(app, bob, 'PATCH', `/api/examples/${example.id}`, { sentence: 'Hi.' })).status).toBe(404);
    expect((await send(app, bob, 'PATCH', `/api/examples/${example.id}`, { preferred: true })).status).toBe(404);
    expect((await send(app, bob, 'DELETE', `/api/examples/${example.id}`)).status).toBe(404);
    expect((await send(app, bob, 'DELETE', `/api/relations/${relation.id}`)).status).toBe(404);
    expect((await send(app, bob, 'POST', '/api/relations', { fromId: bobs.id, toId: alices.id, kind: 'synonym' })).status).toBe(404);
    await expect(
      db.as(bob.id, (s) =>
        s.query(`insert into public.vocabulary_relations (low_id, high_id, kind) values ($1, $2, 'synonym')`, orderPair(bobs.id, alices.id)!),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(db.as(bob.id, (s) => s.query('select public.set_preferred_example($1, true) as done', [example.id]))).resolves.toEqual([
      { done: false },
    ]);

    const mine = await libraryOf(app, alice);
    expect(mine.examples).toHaveLength(1);
    expect(mine.examples[0]).toMatchObject({ sentence: 'Mine.', preferred: false });
    expect(mine.relations).toHaveLength(1);
  });
});

describe('what the database itself insists on', () => {
  it('stores a pair in one order only, and at most once per kind', async () => {
    const app = on(TODAY);
    const one = await addWord(app, alice, { word: 'one' });
    const two = await addWord(app, alice, { word: 'two' });
    const [low, high] = orderPair(one.id, two.id)!;
    const insert = (a: string, b: string, kind = 'synonym') =>
      db.as(alice.id, (s) => s.query('insert into public.vocabulary_relations (low_id, high_id, kind) values ($1, $2, $3)', [a, b, kind]));
    await expect(insert(high, low)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(low, low)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(low, high, 'hypernym')).rejects.toMatchObject({ code: '23514' });
    await insert(low, high);
    await expect(insert(low, high)).rejects.toMatchObject({ code: '23505' });
  });

  it('allows one preferred example per word', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const insert = () =>
      db.as(alice.id, (s) =>
        s.query(`insert into public.vocabulary_examples (vocabulary_id, sentence, preferred) values ($1, 'x', true)`, [word.id]),
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });

  it('holds names and sentences to their limits', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    await expect(
      db.as(alice.id, (s) => s.query(`insert into public.collections (name, name_key) values (' padded ', 'padded')`)),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.as(alice.id, (s) => s.query(`insert into public.collections (name, name_key) values ($1, 'long')`, ['x'.repeat(81)])),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.as(alice.id, (s) => s.query(`insert into public.vocabulary_examples (vocabulary_id, sentence) values ($1, '')`, [word.id])),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('still gives nobody a way to delete a word, a schedule or a review', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const made = await newCollection(app, alice, 'Exam');
    await ok(put(app, alice, made.id, word.id, true));
    for (const table of ['vocabulary', 'card_states', 'review_logs']) {
      await expect(db.as(alice.id, (s) => s.query(`delete from public.${table}`)), table).rejects.toMatchObject({ code: '42501' });
    }
    expect(await stored(word.id)).toHaveLength(1);
  });
});

describe('the helpers both sides share', () => {
  it('compare collection names without regard to case or spacing', () => {
    expect(tidyName('  Books   and reading ')).toBe('Books and reading');
    expect(collectionKey(' IELTS ')).toBe(collectionKey('ielts'));
    expect(collectionKey('Books')).not.toBe(collectionKey('Book'));
  });

  it('order a pair the same way from either end', () => {
    expect(orderPair('b', 'a')).toEqual(['a', 'b']);
    expect(orderPair('a', 'b')).toEqual(['a', 'b']);
    expect(orderPair('a', 'a')).toBeNull();
    expect(otherEnd({ a: 'x', b: 'y' }, 'x')).toBe('y');
    expect(otherEnd({ a: 'x', b: 'y' }, 'y')).toBe('x');
    expect(otherEnd({ a: 'x', b: 'y' }, 'z')).toBeNull();
  });
});

describe('where none of this can be kept', () => {
  let old: TestDatabase;
  let carol: TestUser;

  beforeAll(async () => {
    old = await createTestDatabase({ migrations: 6 });
    carol = await createTestUser(old, 'carol');
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  it('a database one migration behind says so, and everything else keeps working', async () => {
    const app = on(TODAY, old, [carol]);
    const word = await addWord(app, carol, { word: 'candid' });
    expect(await libraryOf(app, carol)).toEqual({ available: false, collections: [], examples: [], relations: [] });
    const refused = await send(app, carol, 'POST', '/api/collections', { name: 'IELTS' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('not_supported');
    expect((await send(app, carol, 'POST', `/api/vocabulary/${word.id}/examples`, { sentence: 'x' })).status).toBe(409);

    const queue = queueResponseSchema.parse(await (await call(app, carol, '/api/review-queue')).json());
    expect(queue.cards.map((card) => card.word)).toEqual(['candid']);
    expect(queue.capabilities).toEqual({ ...NO_CAPABILITIES, sessions: true, undo: true, fsrs: true, analytics: true, goals: true, confidence: true, practice: true });
    expect((await call(app, carol, `/api/review-queue?collection=${newId()}`)).status).toBe(404);
  });

  it('with saving switched off, everything can be read and nothing changed', async () => {
    const app = on(TODAY);
    const word = await addWord(app, alice, { word: 'candid' });
    const made = await newCollection(app, alice, 'Exam');
    const frozen = on(TODAY, db, [alice, bob], { REVIEW_WRITES_ENABLED: 'false' });
    expect((await libraryOf(frozen, alice)).collections).toHaveLength(1);
    for (const response of [
      await send(frozen, alice, 'POST', '/api/collections', { name: 'New' }),
      await send(frozen, alice, 'DELETE', `/api/collections/${made.id}`),
      await put(frozen, alice, made.id, word.id, true),
      await send(frozen, alice, 'POST', `/api/vocabulary/${word.id}/examples`, { sentence: 'x' }),
    ]) {
      expect(response.status).toBe(403);
    }
    expect((await libraryOf(app, alice)).collections).toEqual([{ id: made.id, name: 'Exam', wordIds: [] }]);
  });
});
