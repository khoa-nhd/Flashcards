/**
 * Restoring multi-sense vocabulary through the supported restore path: the
 * account export, read back in the way the Import page reads a file. What has
 * to survive the round trip is every sense, in the order the owner kept them,
 * with each archive state; what must never happen is a doubled retry, a
 * touched-over existing word, or a word imported stripped of the senses the
 * file listed. The boundary is stated by the tests themselves: content comes
 * back, schedules and history do not — a restore adds words, it is not a
 * full-account recovery.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  entryResponseSchema,
  importResponseSchema,
  trashResponseSchema,
  vocabularyListResponseSchema,
  type ImportResponse,
  type VocabularyEntry,
} from '../../shared/api.js';
import type { AccountExport } from '../../shared/export-format.js';
import {
  checkRows,
  guessMapping,
  parseImportText,
  rowProblem,
  toImportRows,
  type ImportItem,
} from '../../shared/import.js';
import { toCsv } from '../../src/lib/export.js';
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

const TODAY = '2026-10-11';
const on = (day = TODAY) =>
  createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${day}T05:00:00Z`) });

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status, await response.clone().text()).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

async function fetchEntry(app: TestApp, user: TestUser, id: string): Promise<VocabularyEntry> {
  const response = await call(app, user, `/api/vocabulary/${id}`);
  expect(response.status).toBe(200);
  return entryResponseSchema.parse(await response.json()).entry;
}

const addSense = (app: TestApp, user: TestUser, wordId: string, body: Record<string, unknown>) =>
  call(app, user, `/api/vocabulary/${wordId}/senses`, { method: 'POST', body: { requestId: newId(), ...body } });

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

/** What a round trip has to reproduce: position, content and archive state — not ids. */
const sensesOf = (entry: VocabularyEntry) =>
  entry.senses.map(({ position, meaning, definition, example, archived }) => ({
    position,
    meaning,
    definition,
    example,
    archived,
  }));

const senseIdsOf = (entry: VocabularyEntry) => entry.senses.map((sense) => sense.id);

/**
 * Reads an export exactly the way the Import page reads a file, through the
 * same shared pipeline, and returns the items it would send — kept, so a
 * retry can resend the identical rows with their identical request ids.
 */
async function planRestore(
  app: TestApp,
  user: TestUser,
  text: string,
  options: { forceDuplicates?: boolean; hasHeader?: boolean } = {},
): Promise<{ rows: ReturnType<typeof checkRows>; items: ImportItem[] }> {
  const parsed = parseImportText(text);
  const hasHeader = options.hasHeader ?? false;
  const header = parsed.header ?? (hasHeader ? parsed.rows[0]! : null);
  const mapping = guessMapping((parsed.rows[0] ?? header ?? []).length, header);
  const rows = checkRows(toImportRows(parsed.rows, mapping, hasHeader, parsed.senses), await wordsOf(app, user));
  const items: ImportItem[] = rows
    .filter(
      (row) =>
        row.status === 'new' ||
        ((row.status === 'duplicate' || row.status === 'repeated') && options.forceDuplicates === true),
    )
    .map((row) => ({
      requestId: newId(),
      word: row.word,
      ...(row.meaning === null ? {} : { meaning: row.meaning }),
      ...(row.definition === null ? {} : { definition: row.definition }),
      ...(row.example === null ? {} : { example: row.example }),
      ...(row.dateAdded === null ? {} : { dateAdded: row.dateAdded }),
      ...(row.status === 'new' ? {} : { allowDuplicate: true }),
      ...(row.senses === undefined ? {} : { senses: row.senses }),
    }));
  return { rows, items };
}

async function restore(app: TestApp, user: TestUser, text: string, options?: Parameters<typeof planRestore>[3]) {
  const planned = await planRestore(app, user, text, options);
  const result = planned.items.length === 0 ? null : await imported(app, user, planned.items);
  return { ...planned, result };
}

/** A word with three senses: the leading one, and two more added behind it. */
async function seedBank(app: TestApp): Promise<VocabularyEntry> {
  const word = await addWord(app, alice, {
    word: 'bank',
    meaning: 'ngân hàng',
    definition: 'A business that keeps money safe.',
    dateAdded: '2026-09-01',
    mastery: 6,
    reviewDate: '2026-10-20',
  });
  await addSense(app, alice, word.id, { meaning: 'bờ sông', example: 'They sat on the bank.' });
  await addSense(app, alice, word.id, { definition: 'To put money into an account.' });
  return fetchEntry(app, alice, word.id);
}

describe('restoring a multi-sense vocabulary from its own export', () => {
  it('brings back a word with a single sense exactly as it was stored, as content', async () => {
    const app = on();
    const source = await addWord(app, alice, {
      word: 'candid',
      meaning: 'thẳng thắn',
      definition: 'Honest and direct.',
      example: 'He gave a candid answer.',
      dateAdded: '2026-09-01',
      mastery: 7,
      reviewDate: '2026-10-20',
    });
    const { result } = await restore(app, bob, JSON.stringify(await exportOf(app, alice)));
    expect(result?.results.map((row) => row.outcome)).toEqual(['imported']);

    const restored = await fetchEntry(app, bob, result!.results[0]!.entry!.id);
    expect(restored.word).toBe('candid');
    expect(sensesOf(restored)).toEqual(sensesOf(source));
    expect(restored).toMatchObject({ dateAdded: '2026-09-01' });
    // The boundary of a content restore: no schedule is invented for it.
    expect(restored.id).not.toBe(source.id);
    expect([restored.mastery, restored.reviewDate]).toEqual([1, null]);
    expect(await db.admin('select count(*)::int as count from public.review_logs')).toEqual([{ count: 0 }]);
  });

  it('brings back every sense of a word, each with its own content', async () => {
    const app = on();
    const source = await seedBank(app);
    expect(source.senses).toHaveLength(3);

    const { result } = await restore(app, bob, JSON.stringify(await exportOf(app, alice)));
    expect(result?.results.map((row) => row.outcome)).toEqual(['imported']);

    const restored = await fetchEntry(app, bob, result!.results[0]!.entry!.id);
    expect(sensesOf(restored)).toEqual(sensesOf(source));
    expect(restored.sensesVersion).toBe(3);
  });

  it('keeps an order the owner changed, not the order the senses were added in', async () => {
    const app = on();
    const word = await seedBank(app);
    const before = (await fetchEntry(app, alice, word.id)).senses;
    // Move the third sense to the front, then the first one last.
    const reorder = await call(app, alice, `/api/vocabulary/${word.id}/senses/order`, {
      method: 'PATCH',
      body: { senseIds: [before[2]!.id, before[0]!.id, before[1]!.id], ifMatch: (await fetchEntry(app, alice, word.id)).sensesVersion },
    });
    expect(reorder.status).toBe(200);
    const reordered = await fetchEntry(app, alice, word.id);
    expect(reordered.senses.map((sense) => sense.id)).toEqual([before[2]!.id, before[0]!.id, before[1]!.id]);

    const { result } = await restore(app, bob, JSON.stringify(await exportOf(app, alice)));
    const restored = await fetchEntry(app, bob, result!.results[0]!.entry!.id);
    // Same sequence after the restore, although the ids are new.
    expect(restored.senses.map(senseOfContent)).toEqual(reordered.senses.map(senseOfContent));
    expect(restored.senses.map((sense) => sense.position)).toEqual([0, 1, 2]);
  });

  it('keeps archived senses flagged, and the first live sense as the shown meaning', async () => {
    const app = on();
    const word = await seedBank(app);
    const first = (await fetchEntry(app, alice, word.id)).senses[0]!;
    const archive = await call(app, alice, `/api/vocabulary/${word.id}/senses/${first.id}/archive`, {
      method: 'POST',
      body: { ifMatch: first.version },
    });
    expect(archive.status).toBe(200);
    const source = await fetchEntry(app, alice, word.id);
    expect(sensesOf(source).map((sense) => sense.archived)).toEqual([true, false, false]);
    expect(source.meaning).toBe('bờ sông');

    const { result } = await restore(app, bob, JSON.stringify(await exportOf(app, alice)));
    expect(result?.results.map((row) => row.outcome)).toEqual(['imported']);

    const restored = await fetchEntry(app, bob, result!.results[0]!.entry!.id);
    expect(sensesOf(restored)).toEqual(sensesOf(source));
    expect(restored.meaning).toBe('bờ sông');
    // The archived one is still there, only out of the way.
    expect(restored.senses[0]).toMatchObject({ archived: true, position: 0 });
  });

  it('round-trips the minimal profiles: a bare word and a word with one field', async () => {
    const app = on();
    await addWord(app, alice, { word: 'empty' });
    await addWord(app, alice, { word: 'lone', meaning: 'đơn độc' });

    const { result } = await restore(app, bob, JSON.stringify(await exportOf(app, alice)));
    expect(result?.results.map((row) => row.outcome)).toEqual(['imported', 'imported']);

    const entries = await wordsOf(app, bob);
    const bare = await fetchEntry(app, bob, entries.find((entry) => entry.word === 'empty')!.id);
    const single = await fetchEntry(app, bob, entries.find((entry) => entry.word === 'lone')!.id);
    expect(bare).toMatchObject({ meaning: null, definition: null, example: null, sensesVersion: 0 });
    expect(bare.senses).toEqual([]);
    expect(sensesOf(single)).toEqual([
      { position: 0, meaning: 'đơn độc', definition: null, example: null, archived: false },
    ]);
  });
});

const senseOfContent = ({ meaning, definition, example }: { meaning: string | null; definition: string | null; example: string | null }) =>
  `${meaning ?? ''}|${definition ?? ''}|${example ?? ''}`;

describe('files made before senses existed', () => {
  it('reads a JSON export without a senses field, restoring the one sense it names', async () => {
    const app = on();
    await seedBank(app);
    const exported = await exportOf(app, alice);
    const legacy = {
      ...exported,
      vocabulary: exported.vocabulary.map((word) =>
        Object.fromEntries(Object.entries(word).filter(([key]) => key !== 'senses')),
      ),
    };

    const { result } = await restore(app, bob, JSON.stringify(legacy));
    expect(result?.results.map((row) => row.outcome)).toEqual(['imported']);

    const restored = await fetchEntry(app, bob, result!.results[0]!.entry!.id);
    // The file only names the leading content, so one sense comes back — the
    // documented limitation of reading a file made before senses existed.
    expect(restored.senses).toHaveLength(1);
    expect(sensesOf(restored)).toEqual([
      { position: 0, meaning: 'ngân hàng', definition: 'A business that keeps money safe.', example: null, archived: false },
    ]);
  });

  it('reads the CSV export, which carries only the shown meaning of each word', async () => {
    const app = on();
    const source = await seedBank(app);
    const csv = toCsv(await wordsOf(app, alice));

    const { rows, result } = await restore(app, bob, csv, { hasHeader: true });
    expect(rows.map((row) => row.status)).toEqual(['new']);
    expect(result?.results.map((row) => row.outcome)).toEqual(['imported']);

    const restored = await fetchEntry(app, bob, result!.results[0]!.entry!.id);
    expect(restored.senses).toHaveLength(1);
    expect(sensesOf(restored)).toEqual([sensesOf(source)[0]]);
  });
});

describe('when the file is not right', () => {
  it('refuses each bad row on its own and writes none of it', async () => {
    const app = on();
    const item = (word: string, extra: Record<string, unknown> = {}) => ({ requestId: newId(), word, ...extra });
    const { results, stopped } = await imported(app, bob, [
      item('fine', { meaning: 'đúng' }),
      item('unknown-field', { senses: [{ meaning: 'x', surprise: true }] }),
      item('too-long', { senses: [{ meaning: 'x'.repeat(6001) }] }),
      item('too-many', { senses: Array.from({ length: 26 }, (_, index) => ({ meaning: `sense ${index}` })) }),
      item('not-an-array', { senses: 'nope' }),
      item('not-an-object', { senses: [{ meaning: 'ok' }, 'nope'] }),
    ]);
    expect(stopped).toBeNull();
    expect(results.map((row) => row.outcome)).toEqual([
      'imported',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
    ]);
    expect(results.slice(1).every((row) => (row.message ?? '').length > 0)).toBe(true);

    // Only the good row exists. None of the refused words were created.
    expect((await wordsOf(app, bob)).map((entry) => entry.word)).toEqual(['fine']);
  });

  it('spots an unusable sense in the file itself, before anything is sent', () => {
    const row = {
      line: 2,
      word: 'bank',
      meaning: null,
      definition: null,
      example: null,
      dateAdded: null,
      senses: [{ meaning: 'x'.repeat(6001) }],
    };
    expect(rowProblem(row)).toMatch(/longer than 6000/);
    expect(rowProblem({ ...row, senses: Array.from({ length: 26 }, () => ({ meaning: 'x' })) })).toMatch(/at most 25/);
    expect(rowProblem({ ...row, senses: [{ meaning: 'ok' }] })).toBeNull();
  });
});

describe('sending the same file again', () => {
  it('lands on the same words and the same senses instead of doubling them', async () => {
    const app = on();
    await seedBank(app);
    const { items } = await planRestore(app, bob, JSON.stringify(await exportOf(app, alice)));

    const first = await imported(app, bob, items);
    expect(first.results.map((row) => row.outcome)).toEqual(['imported']);
    const restored = await fetchEntry(app, bob, first.results[0]!.entry!.id);
    const idsAfterFirst = senseIdsOf(restored);

    // The identical rows, with their identical request ids — a retry.
    const second = await imported(app, bob, items);
    expect(second.results.map((row) => row.outcome)).toEqual(['already_imported']);
    const again = await fetchEntry(app, bob, restored.id);
    expect(senseIdsOf(again)).toEqual(idsAfterFirst);
    expect(again.sensesVersion).toBe(restored.sensesVersion);
    expect((await wordsOf(app, bob)).filter((entry) => entry.word === 'bank')).toHaveLength(1);
  });

  it('finishes a run that stopped between the word and its senses', async () => {
    const app = on();
    const requestId = newId();
    // What an interruption leaves behind: the word with its request id, no senses.
    const first = await call(app, bob, '/api/vocabulary', { method: 'POST', body: { requestId, word: 'bank' } });
    expect(first.status).toBe(201);
    const bare = entryResponseSchema.parse(await first.json()).entry;
    expect(bare.senses).toEqual([]);

    // The same row again, with its senses, as the Import page resends it.
    const senses = [
      { meaning: 'ngân hàng' },
      { meaning: 'bờ sông' },
      { definition: 'To put money into an account.' },
    ];
    const { results, stopped } = await imported(app, bob, [{ requestId, word: 'bank', senses }]);
    expect(stopped).toBeNull();
    expect(results[0]?.outcome).toBe('already_imported');
    const filled = await fetchEntry(app, bob, bare.id);
    expect(sensesOf(filled)).toEqual([
      { position: 0, meaning: 'ngân hàng', definition: null, example: null, archived: false },
      { position: 1, meaning: 'bờ sông', definition: null, example: null, archived: false },
      { position: 2, meaning: null, definition: 'To put money into an account.', example: null, archived: false },
    ]);
    const ids = senseIdsOf(filled);

    // And the retry after the retry changes nothing at all.
    const again = await imported(app, bob, [{ requestId, word: 'bank', senses }]);
    expect(again.results[0]?.outcome).toBe('already_imported');
    const settled = await fetchEntry(app, bob, bare.id);
    expect(senseIdsOf(settled)).toEqual(ids);
    expect(settled.sensesVersion).toBe(filled.sensesVersion);
  });
});

describe('restoring over words that are already there', () => {
  it('leaves an overlapping word untouched, and a chosen duplicate becomes its own copy', async () => {
    const app = on();
    await seedBank(app);
    const exported = await exportOf(app, alice);

    // Bob already has his own bank, with his own senses.
    const bobBank = await addWord(app, bob, { word: 'BANK', meaning: 'tiền gửi' });
    await addSense(app, bob, bobBank.id, { meaning: 'bờ sông' });
    const bobBefore = await fetchEntry(app, bob, bobBank.id);

    // Not chosen: the overlapping row is left out, so nothing is sent at all.
    const plain = await planRestore(app, bob, JSON.stringify(exported));
    expect(plain.rows.map((row) => row.status)).toEqual(['duplicate']);
    expect(plain.items).toEqual([]);
    expect(await fetchEntry(app, bob, bobBank.id)).toMatchObject({
      sensesVersion: bobBefore.sensesVersion,
    });
    expect(senseIdsOf(await fetchEntry(app, bob, bobBank.id))).toEqual(senseIdsOf(bobBefore));

    // Chosen: imported as a separate word, its senses and all; Bob's stays his.
    const chosen = await planRestore(app, bob, JSON.stringify(exported), { forceDuplicates: true });
    const result = await imported(app, bob, chosen.items);
    expect(result.results.map((row) => row.outcome)).toEqual(['imported']);

    const banks = await wordsOf(app, bob);
    expect(banks).toHaveLength(2);
    const after = await fetchEntry(app, bob, bobBank.id);
    expect(senseIdsOf(after)).toEqual(senseIdsOf(bobBefore));
    expect(after).toMatchObject({ meaning: 'tiền gửi', sensesVersion: bobBefore.sensesVersion });
    const copy = await fetchEntry(app, bob, result.results[0]!.entry!.id);
    expect(sensesOf(copy).map(senseOfContent)).toHaveLength(3);
    expect(copy.meaning).toBe('ngân hàng');
  });
});

describe('who the restore belongs to', () => {
  it('restores only into the account that imported, leaving the source as it was', async () => {
    const app = on();
    const source = await seedBank(app);
    const exported = await exportOf(app, alice);

    const { result } = await restore(app, bob, JSON.stringify(exported));
    const restoredId = result!.results[0]!.entry!.id;
    expect(restoredId).not.toBe(source.id);

    // The source account is exactly as it was: same word, same senses, same version.
    const after = await fetchEntry(app, alice, source.id);
    expect(senseIdsOf(after)).toEqual(senseIdsOf(source));
    expect(after.sensesVersion).toBe(source.sensesVersion);

    // And it cannot see Bob's copy: the row and its senses belong to Bob.
    expect((await call(app, alice, `/api/vocabulary/${restoredId}`)).status).toBe(404);
    expect((await call(app, alice, `/api/vocabulary/${restoredId}/senses`)).status).toBe(404);
  });

  it('brings a trashed word’s senses back with its content, as a live word', async () => {
    const app = on();
    const source = await seedBank(app);
    expect((await call(app, alice, `/api/vocabulary/${source.id}`, { method: 'DELETE' })).status).toBe(200);

    const exported = await exportOf(app, alice);
    expect(exported.counts).toMatchObject({ words: 0, wordsInTrash: 1 });

    const { result } = await restore(app, bob, JSON.stringify(exported));
    expect(result?.results.map((row) => row.outcome)).toEqual(['imported']);
    const back = await fetchEntry(app, bob, result!.results[0]!.entry!.id);
    expect(sensesOf(back)).toEqual(sensesOf(source));

    // The trash stayed where it was: Alice still has the word in it, untouched.
    const trash = (await (await call(app, alice, '/api/trash')).json()) as { entries: VocabularyEntry[] };
    expect(trash.entries.map((entry) => entry.word)).toEqual(['bank']);
    const stored = await db.admin(
      `select id from public.vocabulary_senses where vocabulary_id = '${source.id}' order by position`,
    );
    expect(stored.map((row) => row.id)).toEqual(senseIdsOf(source));
  });
});

describe('a database whose migration has not been run', () => {
  let behind: TestDatabase;
  let owner: TestUser;
  let legacy: TestApp;

  beforeAll(async () => {
    behind = await createTestDatabase({ migrations: 12 });
  }, 60_000);

  afterAll(async () => {
    await behind.close();
  });

  beforeEach(async () => {
    await behind.admin('delete from auth.users');
    owner = await createTestUser(behind, 'owner');
    legacy = createSupabaseTestApp(behind, [owner]);
  });

  it('refuses a row carrying senses instead of importing the word without them', async () => {
    const { results, stopped } = await imported(legacy, owner, [
      { requestId: newId(), word: 'plain', meaning: 'đơn giản' },
      { requestId: newId(), word: 'rich', meaning: 'sự phong phú', senses: [{ meaning: 'nghĩa mới' }] },
    ]);
    expect(stopped).toBeNull();
    expect(results.map((row) => row.outcome)).toEqual(['imported', 'invalid']);
    expect(results[1]?.message).toMatch(/cannot store multiple senses/i);
    // Nothing half-made: the refused word was never created.
    expect((await wordsOf(legacy, owner)).map((entry) => entry.word)).toEqual(['plain']);
  });
});

describe('a database at schema 13: senses stored, their atomic forms not yet there', () => {
  let between: TestDatabase;
  let owner: TestUser;
  let app13: TestApp;

  beforeAll(async () => {
    between = await createTestDatabase({ migrations: 13 });
  }, 60_000);

  afterAll(async () => {
    await between.close();
  });

  beforeEach(async () => {
    await between.admin('delete from auth.users');
    owner = await createTestUser(between, 'owner');
    app13 = createSupabaseTestApp(between, [owner]);
  });

  it('refuses sense work with this code in front, instead of writing where the columns would drift', async () => {
    // Ordinary words are older than senses: adding one still works.
    const word = await addWord(app13, owner, { word: 'plain', meaning: 'đơn giản' });
    expect(word.word).toBe('plain');

    // A sense added to it is refused: this code adds them through the atomic
    // call, and schema 13 does not have it — so nothing is written that the
    // legacy columns would then disagree with.
    const refused = await call(app13, owner, `/api/vocabulary/${word.id}/senses`, {
      method: 'POST',
      body: { requestId: newId(), meaning: 'nghĩa mới' },
    });
    expect(refused.status).toBe(409);
    expect(apiErrorSchema.parse(await refused.json()).error.code).toBe('not_supported');

    // A row carrying senses is refused whole on import — the same answer an
    // older database gives — and the word it names is not half-made.
    const { results, stopped } = await imported(app13, owner, [
      { requestId: newId(), word: 'rich', senses: [{ meaning: 'nghĩa mới' }] },
    ]);
    expect(stopped).toBeNull();
    expect(results[0]).toMatchObject({ outcome: 'invalid' });
    expect((await wordsOf(app13, owner)).map((entry) => entry.word)).toEqual(['plain']);
  });
});

describe('when a restore fails part-way', () => {
  it('says which row was interrupted when its word could not be written, and the retry brings every row whole', async () => {
    let failing = true;
    const flaky = createSupabaseTestApp(db, [alice, bob], {
      now: () => new Date(`${TODAY}T05:00:00Z`),
      wrap: (database) => ({
        ...database,
        async createCard(card) {
          if (failing && card.word === 'broken') throw new Error('connection lost');
          return database.createCard(card);
        },
      }),
    });
    const batch = [
      { requestId: newId(), word: 'whole', senses: [{ meaning: 'đủ' }] },
      { requestId: newId(), word: 'broken', senses: [{ meaning: 'hỏng' }] },
      { requestId: newId(), word: 'after', senses: [{ meaning: 'sau' }] },
    ];
    const first = await imported(flaky, alice, batch);
    expect(first.results.map((row) => row.outcome)).toEqual(['imported']);
    expect(first.stopped).toMatchObject({ index: 1 });
    expect(first.stopped?.message).toMatch(/incomplete/i);
    // Not a hint of the interrupted row: nothing was written for it, and the
    // rows behind it were not attempted.
    expect((await wordsOf(flaky, alice)).map((entry) => entry.word)).toEqual(['whole']);

    failing = false;
    const second = await imported(flaky, alice, batch);
    expect(second.stopped).toBeNull();
    expect(second.results.map((row) => row.outcome)).toEqual(['already_imported', 'imported', 'imported']);
    const stored = await wordsOf(flaky, alice);
    expect(stored.map((entry) => entry.word).sort()).toEqual(['after', 'broken', 'whole']);
    for (const entry of stored) expect(entry.senses).toHaveLength(1);
  });

  it('leaves the interrupted row’s word complete with its senses, and finishes it on a retry', async () => {
    let failing = true;
    const flaky = createSupabaseTestApp(db, [alice, bob], {
      now: () => new Date(`${TODAY}T05:00:00Z`),
      wrap: (database) => ({
        ...database,
        async createSense(vocabularyId, sense, options) {
          if (failing) throw new Error('connection lost');
          return database.createSense(vocabularyId, sense, options);
        },
      }),
    });
    const row = { requestId: newId(), word: 'bank', senses: [{ meaning: 'ngân hàng' }, { meaning: 'bờ sông' }] };
    const first = await imported(flaky, alice, [row]);
    expect(first.results).toHaveLength(0);
    expect(first.stopped).toMatchObject({ index: 0 });

    // The word it left is not a husk: every sense the row named is there,
    // because the row's own write carries them together with it.
    const left = (await wordsOf(flaky, alice))[0]!;
    expect(left.word).toBe('bank');
    expect(sensesOf(left)).toEqual([
      { position: 0, meaning: 'ngân hàng', definition: null, example: null, archived: false },
      { position: 1, meaning: 'bờ sông', definition: null, example: null, archived: false },
    ]);

    failing = false;
    const second = await imported(flaky, alice, [row]);
    expect(second.stopped).toBeNull();
    expect(second.results.map((row2) => row2.outcome)).toEqual(['already_imported']);
    expect(await wordsOf(flaky, alice)).toHaveLength(1);
  });

  it('reports a failure while an imported sense is archived, and the retry lands the flag', async () => {
    let failing = true;
    // The completion call carries the file's archive state; failing it is the
    // same interruption the archive step used to take on its own.
    const flaky = createSupabaseTestApp(db, [alice, bob], {
      now: () => new Date(`${TODAY}T05:00:00Z`),
      wrap: (database) => ({
        ...database,
        async createSense(vocabularyId, sense, options) {
          if (failing && options?.archived === true) throw new Error('connection lost');
          return database.createSense(vocabularyId, sense, options);
        },
      }),
    });
    const row = { requestId: newId(), word: 'lie', senses: [{ meaning: 'nằm' }, { meaning: 'nói dối', archived: true }] };
    const first = await imported(flaky, alice, [row]);
    expect(first.results).toHaveLength(0);
    expect(first.stopped).toMatchObject({ index: 0 });

    // Both senses are stored; only the archive flag of the second is missing.
    expect(sensesOf((await wordsOf(flaky, alice))[0]!)).toEqual([
      { position: 0, meaning: 'nằm', definition: null, example: null, archived: false },
      { position: 1, meaning: 'nói dối', definition: null, example: null, archived: false },
    ]);

    failing = false;
    const second = await imported(flaky, alice, [row]);
    expect(second.results.map((row2) => row2.outcome)).toEqual(['already_imported']);
    expect(sensesOf((await wordsOf(flaky, alice))[0]!)).toEqual([
      { position: 0, meaning: 'nằm', definition: null, example: null, archived: false },
      { position: 1, meaning: 'nói dối', definition: null, example: null, archived: true },
    ]);
  });

  it('keeps a sense the owner added after a failed run, when the file is retried', async () => {
    let failing = true;
    const flaky = createSupabaseTestApp(db, [alice, bob], {
      now: () => new Date(`${TODAY}T05:00:00Z`),
      wrap: (database) => ({
        ...database,
        async createSense(vocabularyId, sense, options) {
          if (failing && options?.archived === true) throw new Error('connection lost');
          return database.createSense(vocabularyId, sense, options);
        },
      }),
    });
    const row = { requestId: newId(), word: 'lie', senses: [{ meaning: 'nằm' }, { meaning: 'nói dối', archived: true }] };
    await imported(flaky, alice, [row]);
    const left = (await wordsOf(flaky, alice))[0]!;
    const added = await addSense(flaky, alice, left.id, { meaning: 'một sense tự thêm' });
    expect(added.status).toBe(201);

    failing = false;
    const second = await imported(flaky, alice, [row]);
    expect(second.results.map((row2) => row2.outcome)).toEqual(['already_imported']);
    // The owner's sense kept its place at the end; the file's rows completed around it.
    expect(sensesOf((await wordsOf(flaky, alice))[0]!)).toEqual([
      { position: 0, meaning: 'nằm', definition: null, example: null, archived: false },
      { position: 1, meaning: 'nói dối', definition: null, example: null, archived: true },
      { position: 2, meaning: 'một sense tự thêm', definition: null, example: null, archived: false },
    ]);
  });

  it('finishes a word that was moved to the trash before the retry, and never a second copy', async () => {
    const app = on();
    const requestId = newId();
    // What an interruption leaves behind: the word with its request id, no senses.
    const created = await call(app, bob, '/api/vocabulary', { method: 'POST', body: { requestId, word: 'bank' } });
    expect(created.status).toBe(201);
    const bare = entryResponseSchema.parse(await created.json()).entry;
    expect(bare.senses).toEqual([]);

    // The owner moves the word to the trash before the row is sent again.
    const trashed = await call(app, bob, `/api/vocabulary/${bare.id}`, { method: 'DELETE' });
    expect(trashed.status).toBe(200);

    // The same row again, as the Import page resends it: it lands on the word
    // that exists — not a second copy — and its senses are completed on the
    // trashed word by the one call the database allows for exactly this.
    const senses = [{ meaning: 'ngân hàng' }, { meaning: 'bờ sông', archived: true }];
    const { results, stopped } = await imported(app, bob, [{ requestId, word: 'bank', senses }]);
    expect(stopped).toBeNull();
    expect(results[0]?.outcome).toBe('already_imported');

    // One word, still in the trash, carrying every sense the row named with
    // the archive state it named too.
    expect(await wordsOf(app, bob)).toHaveLength(0);
    const listed = trashResponseSchema.parse(await (await call(app, bob, '/api/trash')).json());
    expect(listed.entries).toHaveLength(1);
    const left = listed.entries[0]!;
    expect(left.id).toBe(bare.id);
    expect(sensesOf(left)).toEqual([
      { position: 0, meaning: 'ngân hàng', definition: null, example: null, archived: false },
      { position: 1, meaning: 'bờ sông', definition: null, example: null, archived: true },
    ]);

    // The ordinary sense operations refuse the trashed word: only the
    // import's completion call may write into it.
    const refused = await addSense(app, bob, bare.id, { meaning: 'một nghĩa nữa' });
    expect(refused.status).toBe(404);

    // Restored, the word and its senses are ordinary again.
    expect((await call(app, bob, `/api/vocabulary/${bare.id}/restore`, { method: 'POST' })).status).toBe(200);
    const back = await fetchEntry(app, bob, bare.id);
    expect(sensesOf(back)).toEqual(sensesOf(left));
  });

  it('keeps an owner’s edit when the same file is sent again', async () => {
    const app = on();
    const row = { requestId: newId(), word: 'candid', senses: [{ meaning: 'thẳng thắn' }] };
    expect((await imported(app, alice, [row])).results[0]?.outcome).toBe('imported');
    const stored = (await wordsOf(app, alice))[0]!;
    const sense = stored.senses[0]!;
    const edited = await call(app, alice, `/api/vocabulary/${stored.id}/senses/${sense.id}`, {
      method: 'PATCH',
      body: { ifMatch: sense.version, meaning: 'gan dạ, thẳng thắn' },
    });
    expect(edited.status).toBe(200);

    const again = await imported(app, alice, [row]);
    expect(again.results[0]?.outcome).toBe('already_imported');
    expect(sensesOf((await wordsOf(app, alice))[0]!)).toEqual([
      { position: 0, meaning: 'gan dạ, thẳng thắn', definition: null, example: null, archived: false },
    ]);
  });

  it('does not let a repeated row with a different body rewrite what the first one imported', async () => {
    const app = on();
    const request = newId();
    const first = await imported(app, alice, [{ requestId: request, word: 'candid', senses: [{ meaning: 'thẳng thắn' }] }]);
    expect(first.results[0]?.outcome).toBe('imported');

    const second = await imported(app, alice, [
      { requestId: request, word: 'candid', senses: [{ meaning: 'a meaning that never lands' }] },
    ]);
    expect(second.results[0]?.outcome).toBe('already_imported');
    expect(sensesOf((await wordsOf(app, alice))[0]!)).toEqual([
      { position: 0, meaning: 'thẳng thắn', definition: null, example: null, archived: false },
    ]);
    expect(await wordsOf(app, alice)).toHaveLength(1);
  });
});
