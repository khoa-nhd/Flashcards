/**
 * Importing a list of words and exporting an account, through the HTTP API on
 * the real schema. Import may only ever add new words, the way the Add form
 * does; export may only ever read, and only the caller's own data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  entryResponseSchema,
  importResponseSchema,
  vocabularyListResponseSchema,
  type ImportResponse,
  type VocabularyEntry,
} from '../../shared/api.js';
import { EXPORT_FORMAT, EXPORT_VERSION, type AccountExport } from '../../shared/export-format.js';
import { checkRows, guessMapping, parseImportText, toImportRows } from '../../shared/import.js';
import { toCsv } from '../../src/lib/export.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { MASTERY_ERA_MIGRATIONS, createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  db = await createTestDatabase({ migrations: MASTERY_ERA_MIGRATIONS });
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

const item = (word: string, extra: Record<string, unknown> = {}) => ({ requestId: newId(), word, ...extra });
const post = (app: TestApp, user: TestUser | null, items: unknown) =>
  call(app, user, '/api/vocabulary/import', { method: 'POST', body: { items } });

async function imported(app: TestApp, user: TestUser, items: unknown[]): Promise<ImportResponse> {
  const response = await post(app, user, items);
  expect(response.status, await response.clone().text()).toBe(200);
  return importResponseSchema.parse(await response.json());
}

const wordsOf = async (app: TestApp, user: TestUser) =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;
const exportOf = async (app: TestApp, user: TestUser) =>
  (await (await call(app, user, '/api/export')).json()) as AccountExport;

describe('importing words', () => {
  it('adds each new word the way the Add form would: tidied, at the starting mastery, with no review date', async () => {
    const app = on(TODAY);
    const { results, stopped } = await imported(app, alice, [
      item('  take   off ', { meaning: ' cất cánh ', definition: 'To leave the ground.', example: 'The plane will take off.' }),
      item('candid', { dateAdded: '2026-09-01' }),
    ]);
    expect(stopped).toBeNull();
    expect(results.map((result) => result.outcome)).toEqual(['imported', 'imported']);
    expect(results[0]?.entry).toMatchObject({
      word: 'take off',
      meaning: 'cất cánh',
      definition: 'To leave the ground.',
      example: 'The plane will take off.',
      mastery: 1,
      reviewDate: null,
      dateAdded: TODAY,
      reviewStatus: 'unscheduled',
      reviewable: true,
    });
    expect(results[1]?.entry).toMatchObject({ word: 'candid', meaning: null, dateAdded: '2026-09-01', mastery: 1, reviewDate: null });
    expect((await wordsOf(app, alice)).map((entry) => entry.word).sort()).toEqual(['candid', 'take off']);
  });

  it('makes up no review history and no FSRS state for an imported word', async () => {
    const app = on(TODAY);
    await imported(app, alice, [item('candid'), item('lucid')]);
    expect(await db.admin('select count(*)::int as count from public.review_logs')).toEqual([{ count: 0 }]);
    expect(await db.admin('select count(*)::int as count from public.card_states where fsrs_due is not null')).toEqual([{ count: 0 }]);
    expect(await db.admin('select distinct mastery, review_date, scheduler from public.card_states')).toEqual([
      { mastery: 1, review_date: null, scheduler: 'mastery_v1' },
    ]);
  });

  it('reports a word that already exists and does not import it again', async () => {
    const app = on(TODAY);
    const existing = await addWord(app, alice, { word: 'Candid', meaning: 'thẳng thắn', mastery: 6, reviewDate: '2026-10-20' });
    const { results } = await imported(app, alice, [item('candid', { meaning: 'something else' }), item('lucid')]);
    expect(results.map((result) => result.outcome)).toEqual(['duplicate', 'imported']);
    expect(results[0]).toMatchObject({ entry: null, message: '"Candid" is already in your vocabulary.' });

    const words = await wordsOf(app, alice);
    expect(words).toHaveLength(2);
    // The existing word is untouched: nothing was merged into it.
    expect(words.find((entry) => entry.id === existing.id)).toMatchObject({ word: 'Candid', meaning: 'thẳng thắn', mastery: 6, reviewDate: '2026-10-20' });
  });

  it('imports a duplicate as a separate word only when the owner said so for that row', async () => {
    const app = on(TODAY);
    const existing = await addWord(app, alice, { word: 'bank', meaning: 'ngân hàng' });
    const { results } = await imported(app, alice, [item('bank', { meaning: 'bờ sông', allowDuplicate: true })]);
    expect(results[0]?.outcome).toBe('imported');
    const banks = (await wordsOf(app, alice)).filter((entry) => entry.word === 'bank');
    expect(banks.map((entry) => entry.meaning).sort()).toEqual(['bờ sông', 'ngân hàng']);
    expect(banks.map((entry) => entry.id)).toContain(existing.id);
  });

  it('treats a word repeated within the batch as a duplicate of the one just imported', async () => {
    const app = on(TODAY);
    const { results } = await imported(app, alice, [item('lucid'), item('Lucid '), item('LUCID', { allowDuplicate: true })]);
    expect(results.map((result) => result.outcome)).toEqual(['imported', 'duplicate', 'imported']);
    expect(await wordsOf(app, alice)).toHaveLength(2);
  });

  it('judges each row on its own, so a bad one costs only itself', async () => {
    const app = on(TODAY);
    const { results, stopped } = await imported(app, alice, [
      item('good'),
      item('   '),
      item('dated', { dateAdded: '09/10/2026' }),
      { word: 'no request id' },
      item('long', { example: 'x'.repeat(6001) }),
      'not even an object',
      item('also good'),
    ]);
    expect(stopped).toBeNull();
    expect(results.map((result) => result.outcome)).toEqual(['imported', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'imported']);
    expect(results.filter((result) => result.outcome === 'invalid').every((result) => result.message !== null && result.entry === null)).toBe(true);
    expect((await wordsOf(app, alice)).map((entry) => entry.word).sort()).toEqual(['also good', 'good']);
  });

  it.each([
    ['a mastery', { mastery: 10 }],
    ['a review date', { reviewDate: '2030-01-01' }],
    ['an id', { id: '00000000-0000-4000-8000-000000000001' }],
    ['an owner', { user_id: '00000000-0000-4000-8000-000000000002' }],
  ])('refuses a row that tries to bring %s with it', async (_name, extra) => {
    const app = on(TODAY);
    const { results } = await imported(app, alice, [item('candid', extra)]);
    expect(results[0]?.outcome).toBe('invalid');
    expect(await wordsOf(app, alice)).toEqual([]);
  });

  it('imports nothing twice when the same batch is sent again', async () => {
    const app = on(TODAY);
    const batch = [item('candid'), item('lucid', { meaning: 'sáng suốt' })];
    const first = await imported(app, alice, batch);
    const second = await imported(app, alice, batch);
    expect(first.results.map((result) => result.outcome)).toEqual(['imported', 'imported']);
    expect(second.results.map((result) => result.outcome)).toEqual(['already_imported', 'already_imported']);
    expect(second.results.map((result) => result.entry?.id)).toEqual(first.results.map((result) => result.entry?.id));
    expect(await wordsOf(app, alice)).toHaveLength(2);
    // The same holds on another server instance, as after a restart or from another device.
    const third = await imported(on(TODAY), alice, batch);
    expect(third.results.map((result) => result.outcome)).toEqual(['already_imported', 'already_imported']);
    expect(await wordsOf(app, alice)).toHaveLength(2);
  });

  it('says how far it got when the database fails part-way, and finishes cleanly on a retry', async () => {
    let creates = 0;
    let failing = true;
    const flaky = createSupabaseTestApp(db, [alice, bob], {
      now: () => new Date(`${TODAY}T05:00:00Z`),
      wrap: (database) => ({
        ...database,
        async createCard(card) {
          creates += 1;
          if (failing && creates === 3) throw new Error('connection lost');
          return database.createCard(card);
        },
      }),
    });
    const batch = [item('one'), item('two'), item('three'), item('four')];
    const first = await imported(flaky, alice, batch);
    expect(first.results.map((result) => result.outcome)).toEqual(['imported', 'imported']);
    expect(first.stopped).toMatchObject({ index: 2 });
    expect((await wordsOf(flaky, alice)).map((entry) => entry.word).sort()).toEqual(['one', 'two']);

    failing = false;
    const second = await imported(flaky, alice, batch);
    expect(second.stopped).toBeNull();
    expect(second.results.map((result) => result.outcome)).toEqual(['already_imported', 'already_imported', 'imported', 'imported']);
    expect((await wordsOf(flaky, alice)).map((entry) => entry.word).sort()).toEqual(['four', 'one', 'three', 'two']);
  });

  it('takes at most fifty rows in one request, and not none', async () => {
    const app = on(TODAY);
    expect((await post(app, alice, Array.from({ length: 51 }, (_, index) => item(`w${index}`)))).status).toBe(400);
    expect((await post(app, alice, [])).status).toBe(400);
    expect((await call(app, alice, '/api/vocabulary/import', { method: 'POST', body: { items: 'candid' } })).status).toBe(400);
    expect(await wordsOf(app, alice)).toEqual([]);
    expect((await imported(app, alice, Array.from({ length: 50 }, (_, index) => item(`w${index}`)))).results).toHaveLength(50);
  });

  it('adds only to the account that asked, and is closed to a visitor who is not signed in', async () => {
    const app = on(TODAY);
    await addWord(app, bob, { word: 'candid' });
    // Bob having the word does not make it a duplicate for Alice.
    expect((await imported(app, alice, [item('candid')])).results[0]?.outcome).toBe('imported');
    expect(await wordsOf(app, bob)).toHaveLength(1);
    expect(await wordsOf(app, alice)).toHaveLength(1);
    expect((await post(app, null, [item('lucid')])).status).toBe(401);
  });

  it('imports nothing while saving is switched off', async () => {
    const frozen = on(TODAY, db, [alice, bob], { REVIEW_WRITES_ENABLED: 'false' });
    expect((await post(frozen, alice, [item('candid')])).status).toBe(403);
    expect(await wordsOf(on(TODAY), alice)).toEqual([]);
  });
});

describe('exporting an account', () => {
  async function busyAccount(app: TestApp) {
    const candid = await addWord(app, alice, { word: 'candid', meaning: 'thẳng thắn', example: 'A candid reply.', mastery: 3, reviewDate: TODAY });
    const lucid = await addWord(app, alice, { word: 'lucid', meaning: 'sáng suốt', mastery: 2, reviewDate: '2026-10-20' });
    const gone = await addWord(app, alice, { word: 'gone' });
    await call(app, alice, `/api/vocabulary/${gone.id}`, { method: 'DELETE' });

    const reviewId = newId();
    const sessionId = newId();
    await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: candid.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY }, requestId: reviewId, sessionId, durationMs: 4200, confidence: 2 },
    });
    await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: reviewId, requestId: newId() } });
    await call(app, alice, '/api/review-action', {
      method: 'POST',
      body: { pageId: candid.id, action: 'not_remember', expected: { mastery: 3, nextReview: TODAY }, requestId: newId(), sessionId },
    });
    await call(app, alice, '/api/practice', {
      method: 'POST',
      body: { pageId: lucid.id, mode: 'typing', answer: { kind: 'typed', text: 'lucit' }, requestId: newId() },
    });

    const collection = (
      (await (await call(app, alice, '/api/collections', { method: 'POST', body: { name: 'Exam' } })).json()) as { collection: { id: string } }
    ).collection;
    await call(app, alice, `/api/collections/${collection.id}/words/${candid.id}`, { method: 'PUT', body: { member: true } });
    await call(app, alice, `/api/vocabulary/${candid.id}/examples`, { method: 'POST', body: { sentence: 'Another candid one.', source: 'a book' } });
    await call(app, alice, '/api/relations', { method: 'POST', body: { fromId: candid.id, toId: lucid.id, kind: 'related' } });
    await call(app, alice, '/api/goal', { method: 'PUT', body: { reviews: 20, minutes: null } });
    return { candid, lucid, gone, collection };
  }

  it('holds everything the account can read about itself, in the documented shape', async () => {
    const app = on(TODAY);
    const { candid, lucid, gone, collection } = await busyAccount(app);
    const exported = await exportOf(app, alice);

    expect(exported).toMatchObject({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: '2026-10-09T05:00:00.000Z',
      settings: { timeZone: 'Asia/Ho_Chi_Minh', dailyGoal: { reviews: 20, minutes: null }, fsrsRequestRetention: 0.9 },
      counts: { words: 2, wordsInTrash: 1, collections: 1, examples: 1, relations: 1, historyEvents: 4 },
    });

    const words = new Map(exported.vocabulary.map((word) => [word.word, word]));
    expect(words.get('candid')).toMatchObject({
      id: candid.id,
      meaning: 'thẳng thắn',
      example: 'A candid reply.',
      mastery: 3,
      reviewDate: '2026-10-10',
      inTrash: false,
    });
    // Reviewed since FSRS began to be calculated, so it has a state; the other word has none, and none is made up.
    expect(words.get('candid')?.fsrs).toMatchObject({ reps: 1 });
    expect(words.get('lucid')).toMatchObject({ id: lucid.id, mastery: 2, reviewDate: '2026-10-20', fsrs: null, inTrash: false });
    expect(words.get('gone')).toMatchObject({ id: gone.id, inTrash: true });

    expect(exported.collections).toEqual([{ id: collection.id, name: 'Exam', wordIds: [candid.id] }]);
    expect(exported.examples).toMatchObject([{ vocabularyId: candid.id, sentence: 'Another candid one.', source: 'a book', preferred: false }]);
    expect(exported.relations).toHaveLength(1);
  });

  it('gives the review history as it was recorded: the answer, its undo, the answer after it, and practice', async () => {
    const app = on(TODAY);
    const { candid, lucid } = await busyAccount(app);
    const history = (await exportOf(app, alice)).reviewHistory;
    expect(history.map((event) => [event.kind, event.action, event.mode, event.vocabularyId])).toEqual([
      ['review', 'remember', 'flashcard', candid.id],
      ['undo', 'remember', 'flashcard', candid.id],
      ['review', 'not_remember', 'flashcard', candid.id],
      ['practice', 'not_remember', 'typing', lucid.id],
    ]);
    const [first, undo, , practice] = history;
    expect(first).toMatchObject({
      reviewedOn: TODAY,
      durationMs: 4200,
      masteryBefore: 3,
      masteryAfter: 4,
      reviewDateBefore: TODAY,
      reviewDateAfter: '2026-10-12',
      confidence: 2,
      rating: 3,
      undoesId: null,
      answerCorrect: null,
    });
    expect(undo).toMatchObject({ undoesId: first?.id, masteryBefore: 4, masteryAfter: 3 });
    expect(first?.sessionId).toBe(undo?.sessionId);
    expect(practice).toMatchObject({
      answerCorrect: false,
      submittedAnswer: 'lucit',
      grading: 'auto',
      masteryBefore: 2,
      masteryAfter: 2,
      reviewDateBefore: '2026-10-20',
      reviewDateAfter: '2026-10-20',
    });
  });

  it('contains nothing of any other account, and nothing that signs anyone in', async () => {
    const app = on(TODAY);
    await busyAccount(app);
    await addWord(app, bob, { word: 'bobs-word', meaning: 'của bob' });
    const mine = JSON.stringify(await exportOf(app, alice));
    expect(mine).not.toContain('bobs-word');
    expect(mine).not.toContain(bob.id);
    expect(mine).not.toContain(alice.token);
    expect(mine).not.toMatch(/password|access_token|refresh_token|sb_publishable|service_role/i);

    const theirs = await exportOf(app, bob);
    expect(theirs.counts).toEqual({ words: 1, wordsInTrash: 0, collections: 0, examples: 0, relations: 0, historyEvents: 0 });
    expect(theirs.vocabulary.map((word) => word.word)).toEqual(['bobs-word']);
  });

  it('only reads: exporting changes nothing at all', async () => {
    const app = on(TODAY);
    await busyAccount(app);
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          ['vocabulary', 'card_states', 'review_logs', 'user_settings', 'collections', 'collection_items', 'vocabulary_examples', 'vocabulary_relations', 'study_sessions'].map(
            (table) => db.admin(`select * from public.${table} order by 1, 2`),
          ),
        ),
      );
    const before = await snapshot();
    await exportOf(app, alice);
    await exportOf(app, alice);
    expect(await snapshot()).toBe(before);
  });

  it('is closed to a visitor who is not signed in', async () => {
    expect((await call(on(TODAY), null, '/api/export')).status).toBe(401);
  });

  it('is empty, not broken, for a new account', async () => {
    const exported = await exportOf(on(TODAY), alice);
    expect(exported).toMatchObject({
      format: EXPORT_FORMAT,
      counts: { words: 0, wordsInTrash: 0, collections: 0, examples: 0, relations: 0, historyEvents: 0 },
      vocabulary: [],
      reviewHistory: [],
      settings: { dailyGoal: { reviews: null, minutes: null } },
    });
  });
});

describe('exporting from an older database', () => {
  let old: TestDatabase;
  let carol: TestUser;

  beforeAll(async () => {
    old = await createTestDatabase({ migrations: 1 });
    carol = await createTestUser(old, 'carol');
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  it('exports what a first-version database holds, and says the rest is not there', async () => {
    const app = on(TODAY, old, [carol]);
    const word = await addWord(app, carol, { word: 'candid', mastery: 3, reviewDate: TODAY });
    await call(app, carol, '/api/review-action', {
      method: 'POST',
      body: { pageId: word.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY }, requestId: newId() },
    });
    const exported = await exportOf(app, carol);
    expect(exported.counts).toEqual({ words: 1, wordsInTrash: 0, collections: 0, examples: 0, relations: 0, historyEvents: 1 });
    expect(exported.vocabulary[0]).toMatchObject({ word: 'candid', mastery: 4, fsrs: null });
    expect(exported.reviewHistory[0]).toMatchObject({
      kind: 'review',
      action: 'remember',
      masteryBefore: 3,
      masteryAfter: 4,
      sessionId: null,
      undoesId: null,
      rating: null,
      confidence: null,
      answerCorrect: null,
    });
    expect(exported.settings).toMatchObject({ dailyGoal: { reviews: null, minutes: null }, fsrsRequestRetention: null });
  });
});

describe('a round trip: export, then import into an empty account', () => {
  async function source(app: TestApp) {
    await addWord(app, alice, {
      word: 'candid',
      meaning: 'thẳng thắn, bộc trực',
      definition: 'Honest and direct, "even" when uncomfortable.',
      example: 'He gave a candid account.\nShe was candid too.',
      dateAdded: '2026-09-01',
      mastery: 7,
      reviewDate: '2026-10-20',
    });
    await addWord(app, alice, { word: 'take off', meaning: 'cất cánh', dateAdded: '2026-09-02' });
  }

  const content = (entries: VocabularyEntry[]) =>
    entries
      .map(({ word, meaning, definition, example, dateAdded }) => ({ word, meaning, definition, example, dateAdded }))
      .sort((a, b) => a.word.localeCompare(b.word));

  async function importText(app: TestApp, user: TestUser, text: string, hasHeader: boolean) {
    const parsed = parseImportText(text);
    const header = parsed.header ?? (hasHeader ? parsed.rows[0]! : null);
    const mapping = guessMapping((parsed.rows[0] ?? header ?? []).length, header);
    const rows = checkRows(toImportRows(parsed.rows, mapping, hasHeader), await wordsOf(app, user));
    const items = rows
      .filter((row) => row.status === 'new')
      .map(({ word, meaning, definition, example, dateAdded }) => ({
        requestId: newId(),
        word,
        ...(meaning === null ? {} : { meaning }),
        ...(definition === null ? {} : { definition }),
        ...(example === null ? {} : { example }),
        ...(dateAdded === null ? {} : { dateAdded }),
      }));
    return { rows, result: items.length === 0 ? null : await imported(app, user, items) };
  }

  it('carries the content across through the CSV export, and leaves the schedule behind', async () => {
    const app = on(TODAY);
    await source(app);
    const original = await wordsOf(app, alice);
    const { result } = await importText(app, bob, toCsv(original), true);
    expect(result?.results.map((item) => item.outcome)).toEqual(['imported', 'imported']);

    const copy = await wordsOf(app, bob);
    expect(content(copy)).toEqual(content(original));
    // The mastery of 7 and its review date stayed with the original: a copy starts as new words.
    expect(copy.map((entry) => [entry.mastery, entry.reviewDate])).toEqual([
      [1, null],
      [1, null],
    ]);
  });

  it('carries the content across through the full JSON export', async () => {
    const app = on(TODAY);
    await source(app);
    const original = await wordsOf(app, alice);
    const { result } = await importText(app, bob, JSON.stringify(await exportOf(app, alice)), false);
    expect(result?.results.map((item) => item.outcome)).toEqual(['imported', 'imported']);
    expect(content(await wordsOf(app, bob))).toEqual(content(original));
  });

  it('finds nothing to import when the export is brought back into the account it came from', async () => {
    const app = on(TODAY);
    await source(app);
    const { rows, result } = await importText(app, alice, toCsv(await wordsOf(app, alice)), true);
    expect(rows.map((row) => row.status)).toEqual(['duplicate', 'duplicate']);
    expect(result).toBeNull();
    expect(await wordsOf(app, alice)).toHaveLength(2);
  });
});
