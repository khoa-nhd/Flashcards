/**
 * Moving a backup into an account, against the real schema with Row Level
 * Security on: nothing lost, nothing changed, nothing invented, and safe to
 * run again.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cardFields, reviewRules } from '../../config/review.config.js';
import { applyImport, assertIntact, planImport, reconcile } from '../../server/supabase/backup-import.js';
import { queueResponseSchema, vocabularyListResponseSchema } from '../../shared/api.js';
import { BACKUP_FORMAT, backupSchema, checksumOf, type Backup, type BackupEntry } from '../../shared/backup.js';
import { calendarDateInTimeZone } from '../../shared/dates.js';
import { areDetailsVisible, buildQueue } from '../../shared/review-logic.js';
import type { VocabularyRecord } from '../../shared/vocabulary.js';
import { classifyReviewStatus } from '../../shared/vocabulary-status.js';
import { NOW, TODAY } from '../helpers/fixtures.js';
import { createPgVocabularyDatabase } from '../helpers/pg-vocabulary-database.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestUser } from '../helpers/supabase-app.js';
import { MASTERY_ERA_MIGRATIONS, MASTERY_ERA_SCHEMA_VERSION, createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let owner: TestUser;
let other: TestUser;

beforeAll(async () => {
  db = await createTestDatabase({ migrations: MASTERY_ERA_MIGRATIONS });
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  owner = await createTestUser(db, 'owner');
  other = await createTestUser(db, 'other');
});

const externalId = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

function entry(n: number, overrides: Partial<BackupEntry> = {}): BackupEntry {
  return {
    externalId: externalId(n),
    word: `word-${n}`,
    meaning: `nghĩa ${n}`,
    definition: `definition of word-${n}`,
    example: `An example for word-${n}.\nOn two lines, with “quotes” and a comma, too.`,
    mastery: n % 11,
    reviewDate: '2026-10-09',
    dateAdded: '2026-09-01',
    createdTime: '2026-09-01T03:15:00.000Z',
    lastEditedTime: '2026-10-08T12:00:00.000Z',
    url: `https://app.notion.com/p/${n}`,
    ...overrides,
  };
}

async function backupOf(entries: BackupEntry[], overrides: Partial<Backup> = {}): Promise<Backup> {
  return backupSchema.parse({
    format: BACKUP_FORMAT,
    source: 'notion',
    exportedAt: '2026-10-10T09:00:00.000Z',
    timeZone: 'Asia/Ho_Chi_Minh',
    count: entries.length,
    sha256: await checksumOf(entries),
    entries,
    skipped: [],
    ...overrides,
  });
}

const databaseOf = (user: TestUser) => createPgVocabularyDatabase(db, user.id, MASTERY_ERA_SCHEMA_VERSION);

async function importAll(user: TestUser, backup: Backup) {
  const database = databaseOf(user);
  const plan = await planImport(database, backup);
  return { plan, result: await applyImport(database, backup, plan) };
}

const VARIED: BackupEntry[] = [
  entry(1, { mastery: 0, reviewDate: null }),
  entry(2, { mastery: 3, reviewDate: '2026-10-01' }),
  entry(3, { mastery: 5, meaning: null, definition: null, example: null, dateAdded: null }),
  entry(4, { mastery: 8, reviewDate: '2026-11-20' }),
  entry(5, { mastery: 10, reviewDate: '2026-08-01' }),
  entry(6, { mastery: 6, word: 'café au lait', meaning: 'cà phê sữa' }),
  entry(7, { mastery: 2, createdTime: null }),
];

describe('importing a backup', () => {
  it('stores every word with identical values, and no review history', async () => {
    const backup = await backupOf(VARIED);
    const { plan, result } = await importAll(owner, backup);
    expect(plan).toMatchObject({ alreadyImported: 0, unusable: [] });
    expect(plan.toCreate).toHaveLength(7);
    expect(result).toEqual({ created: 7, alreadyThere: 0 });

    const report = await reconcile(databaseOf(owner), backup);
    expect(report).toMatchObject({ expected: 7, found: 7, missing: [], mismatched: [], trashed: 0, notFromBackup: 0, identical: true });
    expect(report.mastery.stored).toEqual(report.mastery.backup);

    // Past reviews were never recorded anywhere, so none are made up now.
    expect(await db.admin('select 1 from public.review_logs')).toEqual([]);
    // Fields for a future scheduler stay empty; mastery remains the schedule in force.
    const states = await db.admin('select scheduler, fsrs_stability, fsrs_due, fsrs_state from public.card_states');
    expect(states).toHaveLength(7);
    for (const state of states) {
      expect(state).toEqual({ scheduler: 'mastery_v1', fsrs_stability: null, fsrs_due: null, fsrs_state: null });
    }
  });

  it('stores an empty text as no value, and still counts it as identical', async () => {
    const backup = await backupOf([entry(1, { meaning: '', definition: '', example: '' })]);
    const { result } = await importAll(owner, backup);
    expect(result.created).toBe(1);
    expect(await db.admin('select meaning, definition, example from public.vocabulary')).toEqual([
      { meaning: null, definition: null, example: null },
    ]);
    expect((await reconcile(databaseOf(owner), backup)).identical).toBe(true);
  });

  it('changes nothing when run again', async () => {
    const backup = await backupOf(VARIED);
    await importAll(owner, backup);
    const before = await db.admin('select id, updated_at from public.vocabulary order by id');

    const again = await importAll(owner, backup);
    expect(again.plan).toMatchObject({ toCreate: [], alreadyImported: 7 });
    expect(again.result).toEqual({ created: 0, alreadyThere: 0 });
    expect(await db.admin('select id, updated_at from public.vocabulary order by id')).toEqual(before);
  });

  it('continues an import that stopped half-way', async () => {
    const backup = await backupOf(VARIED);
    const database = databaseOf(owner);
    const plan = await planImport(database, backup);
    await applyImport(database, backup, { ...plan, toCreate: plan.toCreate.slice(0, 3) });
    expect((await reconcile(database, backup)).missing).toHaveLength(4);

    const rest = await importAll(owner, backup);
    expect(rest.plan).toMatchObject({ alreadyImported: 3 });
    expect(rest.result.created).toBe(4);
    expect((await reconcile(database, backup)).identical).toBe(true);
    expect(await db.admin('select 1 from public.vocabulary')).toHaveLength(7);
  });

  it('adds only what is new when a later backup has more words', async () => {
    await importAll(owner, await backupOf(VARIED.slice(0, 5)));
    const later = await backupOf(VARIED);
    const { plan, result } = await importAll(owner, later);
    expect(plan.alreadyImported).toBe(5);
    expect(result.created).toBe(2);
    expect((await reconcile(databaseOf(owner), later)).identical).toBe(true);
  });

  it('reports a row it cannot store instead of guessing a value for it', async () => {
    const backup = await backupOf([entry(1), entry(2, { mastery: null }), entry(3, { mastery: 12 }), entry(4, { mastery: 2.5 })]);
    const { plan, result } = await importAll(owner, backup);
    expect(plan.unusable.map((item) => [item.externalId, item.reason])).toEqual([
      [externalId(2), 'Mastery is empty.'],
      [externalId(3), 'Mastery is not a whole number from 0 to 10.'],
      [externalId(4), 'Mastery is not a whole number from 0 to 10.'],
    ]);
    expect(result.created).toBe(1);
    expect(await db.admin('select 1 from public.vocabulary')).toHaveLength(1);
  });

  it('refuses a file that was edited or damaged after export', async () => {
    const backup = await backupOf(VARIED);
    const tampered: Backup = { ...backup, entries: backup.entries.map((item, i) => (i === 1 ? { ...item, mastery: 9 } : item)) };
    await expect(planImport(databaseOf(owner), tampered)).rejects.toThrow('does not match its checksum');
    await expect(assertIntact({ ...backup, count: 99 })).rejects.toThrow('says it holds 99 words');
    await expect(assertIntact(await backupOf([entry(1), entry(1)]))).rejects.toThrow('more than once');
    expect(await db.admin('select 1 from public.vocabulary')).toEqual([]);
  });

  it('belongs to the account that imported it and to no other', async () => {
    const backup = await backupOf(VARIED);
    await importAll(owner, backup);

    expect(await databaseOf(other).listCards()).toEqual([]);
    expect(await databaseOf(other).listImported('notion')).toEqual([]);
    expect((await reconcile(databaseOf(other), backup)).missing).toHaveLength(7);

    // A second account importing the same file gets its own copies.
    const second = await importAll(other, backup);
    expect(second.result.created).toBe(7);
    const owners = await db.admin('select user_id, count(*)::int as n from public.vocabulary group by user_id');
    expect(owners.map((row) => row.n)).toEqual([7, 7]);
  });
});

describe('reconciling after the app has been used', () => {
  it('reports what changed since the import, and never overwrites it', async () => {
    const backup = await backupOf(VARIED);
    await importAll(owner, backup);
    const app = createSupabaseTestApp(db, [owner]);
    const list = vocabularyListResponseSchema.parse(await (await call(app, owner, '/api/vocabulary')).json());
    const reviewed = list.entries.find((item) => item.word === 'word-2')!;
    await call(app, owner, '/api/review-action', {
      method: 'POST',
      body: { pageId: reviewed.id, action: 'remember', expected: { mastery: 3, nextReview: '2026-10-01' }, requestId: newId() },
    });
    await call(app, owner, '/api/vocabulary', { method: 'POST', body: { word: 'brand new', requestId: newId() } });
    const trashedWord = list.entries.find((item) => item.word === 'word-4')!;
    await call(app, owner, `/api/vocabulary/${trashedWord.id}`, { method: 'DELETE' });

    const report = await reconcile(databaseOf(owner), backup);
    expect(report).toMatchObject({ expected: 7, found: 7, missing: [], trashed: 1, notFromBackup: 1, identical: false });
    expect(report.mismatched).toEqual([
      { externalId: externalId(2), word: 'word-2', field: 'mastery', expected: 3, stored: 4 },
      { externalId: externalId(2), word: 'word-2', field: 'reviewDate', expected: '2026-10-01', stored: '2026-10-12' },
    ]);

    // Importing again leaves the newer review state alone.
    const again = await importAll(owner, backup);
    expect(again.result.created).toBe(0);
    const state = await db.admin('select mastery from public.card_states where vocabulary_id = $1', [reviewed.id]);
    expect(state).toEqual([{ mastery: 4 }]);
  });
});

/**
 * What the original system computed for a set of words, computed here from
 * the backup alone with the same rules engine, to compare against what the
 * Supabase-backed app serves after importing them.
 */
function expectedFrom(backup: Backup, today: string) {
  const records: VocabularyRecord[] = backup.entries.map((item) => ({
    id: item.externalId,
    word: item.word,
    mastery: item.mastery,
    nextReview: item.reviewDate,
    fields: { meaning: item.meaning, definition: item.definition, example: item.example },
  }));
  const { queue } = buildQueue(records, today, reviewRules);
  return {
    queueWords: queue.map((record) => record.word),
    cards: new Map(
      queue.map((record) => {
        const visible = areDetailsVisible(record.mastery ?? 0, reviewRules);
        const back = cardFields
          .filter((field) => field.side === 'back' && (field.visibility !== 'details' || visible))
          .map((field) => record.fields[field.key])
          .filter((value): value is string => value !== null && value !== undefined);
        return [record.word, back];
      }),
    ),
    statuses: new Map(
      backup.entries.map((item) => [
        item.word,
        classifyReviewStatus({ mastery: item.mastery, reviewDate: item.reviewDate }, today, reviewRules),
      ]),
    ),
  };
}

async function servedAfterImport(backup: Backup, now: Date) {
  await importAll(owner, backup);
  await databaseOf(owner).saveTimeZone(backup.timeZone);
  const app = createSupabaseTestApp(db, [owner], { now: () => now });
  return {
    queue: queueResponseSchema.parse(await (await call(app, owner, '/api/review-queue')).json()),
    list: vocabularyListResponseSchema.parse(await (await call(app, owner, '/api/vocabulary')).json()),
  };
}

describe('the app after an import', () => {
  it('serves the same queue, the same card contents and the same statuses as before', async () => {
    const backup = await backupOf(VARIED);
    const expected = expectedFrom(backup, TODAY);
    const { queue, list } = await servedAfterImport(backup, NOW);

    expect(queue.today).toBe(TODAY);
    expect([...queue.cards.map((card) => card.word)].sort()).toEqual([...expected.queueWords].sort());
    for (const card of queue.cards) expect(card.back.map((field) => field.value)).toEqual(expected.cards.get(card.word));
    expect(new Map(list.entries.map((item) => [item.word, item.reviewStatus]))).toEqual(expected.statuses);
    expect(list.entries.filter((item) => item.reviewable).map((item) => item.word).sort()).toEqual([...expected.queueWords].sort());
  });
});

/**
 * The owner's real export, when one is present on this machine. `backups/` is
 * never committed, so elsewhere this is skipped. Nothing from the file is
 * printed: assertions compare counts and report only on failure.
 */
const backupFiles = existsSync('backups')
  ? readdirSync('backups').filter((name) => /^notion-export-.*\.json$/.test(name)).sort()
  : [];
const latest = backupFiles.at(-1);

describe.skipIf(latest === undefined)('the real exported vocabulary', () => {
  const load = () => backupSchema.parse(JSON.parse(readFileSync(join('backups', latest ?? ''), 'utf8')));

  it('is intact and every word in it can be stored', async () => {
    const backup = load();
    await assertIntact(backup);
    const plan = await planImport(databaseOf(owner), backup);
    expect(plan.unusable).toEqual([]);
    expect(plan.toCreate).toHaveLength(backup.count);
    expect(backup.skipped).toEqual([]);
  });

  it('imports into the real schema with every field identical', async () => {
    const backup = load();
    const { result } = await importAll(owner, backup);
    expect(result.created).toBe(backup.count);

    const report = await reconcile(databaseOf(owner), backup);
    expect(report.found).toBe(backup.count);
    expect(report.missing).toHaveLength(0);
    expect(report.mismatched).toHaveLength(0);
    expect(report.mastery.stored).toEqual(report.mastery.backup);
    expect(report.identical).toBe(true);

    expect((await importAll(owner, backup)).result.created).toBe(0);
  });

  it('is then served with the same queue, card contents and statuses the rules give for the original', async () => {
    const backup = load();
    // "Today" as it was for the owner when the export was taken.
    const exportedAt = new Date(backup.exportedAt);
    const today = calendarDateInTimeZone(exportedAt, backup.timeZone);
    const expected = expectedFrom(backup, today);
    const { queue, list } = await servedAfterImport(backup, exportedAt);

    expect(queue.today).toBe(today);
    expect(list.entries).toHaveLength(backup.count);
    expect(queue.cards).toHaveLength(expected.queueWords.length);
    expect(queue.cards.map((card) => card.word).sort()).toEqual([...expected.queueWords].sort());
    for (const card of queue.cards) expect(card.back.map((field) => field.value)).toEqual(expected.cards.get(card.word));
    expect(new Map(list.entries.map((item) => [item.word, item.reviewStatus]))).toEqual(expected.statuses);
  });
});
