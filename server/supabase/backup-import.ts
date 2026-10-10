/**
 * Carries a backup file into one account, and checks afterwards that what is
 * stored is what the file says. Three rules hold throughout:
 *
 *  - Nothing already stored is ever overwritten or deleted. A word that was
 *    imported before is left as it is, and reported if it has since changed.
 *  - Nothing is invented. A row the schema cannot hold is reported and left
 *    out, and no review history is created for reviews nobody recorded.
 *  - It runs as the signed-in owner, through the same database interface as
 *    the app, so Row Level Security applies to the import too.
 */
import { FIELD_LIMITS } from '../../shared/api.js';
import { checksumOf, type Backup, type BackupEntry } from '../../shared/backup.js';
import { normalizeWord } from '../../shared/text.js';
import type { CardRow, VocabularyDatabase } from './supabase-database.js';

export interface UnusableEntry {
  externalId: string;
  word: string;
  reason: string;
}

export interface ImportPlan {
  /** Entries not yet in the account. */
  toCreate: BackupEntry[];
  /** Entries a previous run already imported. */
  alreadyImported: number;
  /** Entries that cannot be stored as they are. Never guessed at, never silently dropped. */
  unusable: UnusableEntry[];
}

export interface Mismatch {
  externalId: string;
  word: string;
  field: string;
  expected: string | number | null;
  stored: string | number | null;
}

export interface ReconcileReport {
  /** Entries in the backup that can be stored. */
  expected: number;
  /** Of those, how many are in the account. */
  found: number;
  /** In the backup, but not in the account. */
  missing: UnusableEntry[];
  /** In the account with a different value than the backup has. */
  mismatched: Mismatch[];
  /** Imported words now in the trash. They still count as found. */
  trashed: number;
  /** Words in the account that did not come from this source (for example added in the new app). */
  notFromBackup: number;
  /** How many words sit at each mastery level, in the backup and in the account. */
  mastery: { backup: Record<string, number>; stored: Record<string, number> };
  /** True when every usable entry is stored with identical values. */
  identical: boolean;
}

/** Throws unless the file's contents still match the checksum written at export time. */
export async function assertIntact(backup: Backup): Promise<void> {
  if (backup.count !== backup.entries.length) {
    throw new Error(`The backup says it holds ${backup.count} words but contains ${backup.entries.length}.`);
  }
  if ((await checksumOf(backup.entries)) !== backup.sha256) {
    throw new Error('The backup does not match its checksum. It was changed or damaged after it was exported.');
  }
  const ids = new Set(backup.entries.map((entry) => entry.externalId));
  if (ids.size !== backup.entries.length) throw new Error('The backup lists the same record more than once.');
}

function whyUnusable(entry: BackupEntry): string | null {
  if (entry.mastery === null) return 'Mastery is empty.';
  if (!Number.isInteger(entry.mastery) || entry.mastery < 0 || entry.mastery > 10) {
    return 'Mastery is not a whole number from 0 to 10.';
  }
  if (entry.word.trim() === '') return 'The word is blank.';
  if (entry.word.trim().length > FIELD_LIMITS.word) return `The word is longer than ${FIELD_LIMITS.word} characters.`;
  for (const key of ['meaning', 'definition', 'example'] as const) {
    if ((entry[key] ?? '').length > FIELD_LIMITS.text) return `The ${key} is longer than ${FIELD_LIMITS.text} characters.`;
  }
  return null;
}

/** An empty text and a missing one are the same thing: no value. The schema stores that as null. */
const textOf = (value: string | null): string | null => (value === null || value === '' ? null : value);

function split(backup: Backup): { usable: BackupEntry[]; unusable: UnusableEntry[] } {
  const usable: BackupEntry[] = [];
  const unusable: UnusableEntry[] = [];
  for (const entry of backup.entries) {
    const reason = whyUnusable(entry);
    if (reason === null) usable.push(entry);
    else unusable.push({ externalId: entry.externalId, word: entry.word, reason });
  }
  return { usable, unusable };
}

/** Works out what an import would do, without changing anything. */
export async function planImport(database: VocabularyDatabase, backup: Backup): Promise<ImportPlan> {
  await assertIntact(backup);
  const { usable, unusable } = split(backup);
  const present = new Set((await database.listImported(backup.source)).map((row) => row.externalId));
  const toCreate = usable.filter((entry) => !present.has(entry.externalId));
  return { toCreate, alreadyImported: usable.length - toCreate.length, unusable };
}

/**
 * Creates the planned words one at a time. Each is created together with its
 * review state in one transaction, keyed by its original id, so stopping
 * half-way and running again simply continues.
 */
export async function applyImport(
  database: VocabularyDatabase,
  backup: Backup,
  plan: ImportPlan,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<{ created: number; alreadyThere: number }> {
  let created = 0;
  let alreadyThere = 0;
  for (const [index, entry] of plan.toCreate.entries()) {
    const word = entry.word.trim();
    const result = await database.createCard({
      word,
      wordKey: normalizeWord(word),
      // Checked by planImport; the cast only tells the compiler what it cannot see.
      mastery: entry.mastery as number,
      meaning: textOf(entry.meaning),
      definition: textOf(entry.definition),
      example: textOf(entry.example),
      dateAdded: entry.dateAdded,
      reviewDate: entry.reviewDate,
      requestId: null,
      external: { source: backup.source, id: entry.externalId, createdAt: entry.createdTime },
    });
    if (result.created) created += 1;
    else alreadyThere += 1;
    onProgress(index + 1, plan.toCreate.length);
  }
  return { created, alreadyThere };
}

const tally = (levels: Array<number | null>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const level of levels) {
    const key = level === null ? 'empty' : String(level);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

const sameInstant = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : new Date(a).getTime() === new Date(b).getTime();

/** Compares every usable backup entry with what the account holds, field by field. */
export async function reconcile(database: VocabularyDatabase, backup: Backup): Promise<ReconcileReport> {
  await assertIntact(backup);
  const { usable } = split(backup);

  const [live, trashedCards, imported] = await Promise.all([
    database.listCards(),
    database.listTrashedCards(),
    database.listImported(backup.source),
  ]);
  const cards = new Map<string, CardRow>([...live, ...trashedCards].map((card) => [card.id, card]));
  const cardOf = new Map(imported.map((row) => [row.externalId, cards.get(row.id) ?? null]));

  const missing: UnusableEntry[] = [];
  const mismatched: Mismatch[] = [];
  const stored: CardRow[] = [];
  let trashed = 0;

  for (const entry of usable) {
    const card = cardOf.get(entry.externalId) ?? null;
    if (card === null) {
      missing.push({ externalId: entry.externalId, word: entry.word, reason: 'Not in the account.' });
      continue;
    }
    stored.push(card);
    if (card.deleted_at !== null) trashed += 1;

    const compare = (field: string, expected: string | number | null, actual: string | number | null) => {
      if (expected !== actual) {
        mismatched.push({ externalId: entry.externalId, word: entry.word, field, expected, stored: actual });
      }
    };
    compare('word', entry.word.trim(), card.word);
    compare('meaning', textOf(entry.meaning), card.meaning);
    compare('definition', textOf(entry.definition), card.definition);
    compare('example', textOf(entry.example), card.example);
    compare('mastery', entry.mastery, card.mastery);
    compare('reviewDate', entry.reviewDate, card.review_date);
    compare('dateAdded', entry.dateAdded, card.date_added);
    if (entry.createdTime !== null && !sameInstant(entry.createdTime, card.created_at)) {
      mismatched.push({
        externalId: entry.externalId,
        word: entry.word,
        field: 'createdTime',
        expected: entry.createdTime,
        stored: card.created_at,
      });
    }
  }

  const importedIds = new Set(imported.map((row) => row.id));
  return {
    expected: usable.length,
    found: stored.length,
    missing,
    mismatched,
    trashed,
    notFromBackup: [...cards.keys()].filter((id) => !importedIds.has(id)).length,
    mastery: { backup: tally(usable.map((entry) => entry.mastery)), stored: tally(stored.map((card) => card.mastery)) },
    identical: missing.length === 0 && mismatched.length === 0,
  };
}
