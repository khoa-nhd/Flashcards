import type { SkippedRecord, VocabularyStatus } from '../../shared/api.js';
import type { IsoDate } from '../../shared/dates.js';
import type { ReviewRules } from '../../shared/review-logic.js';
import { normalizeWord } from '../../shared/text.js';
import type { VocabularyRecord } from '../../shared/vocabulary.js';
import type { EntryChanges, EntryData, NewEntry, VocabularyCatalog } from '../vocabulary-catalog.js';
import type { ReviewWrite, ReviewWriteResult, SetupReport, VocabularyRepository } from '../vocabulary-repository.js';
import type { CardPatch, CardRow, VocabularyDatabase } from './supabase-database.js';

function toEntry(row: CardRow): EntryData {
  return {
    id: row.id,
    word: row.word,
    meaning: row.meaning,
    definition: row.definition,
    example: row.example,
    mastery: row.mastery,
    reviewDate: row.review_date,
    dateAdded: row.date_added,
    // Text is stored plain, so an edit never loses formatting.
    formattedFields: [],
    url: null,
    createdTime: row.created_at,
    lastEditedTime: row.updated_at,
  };
}

/** A review card. The keys match the card field configuration. */
function toRecord(row: CardRow): VocabularyRecord {
  return {
    id: row.id,
    word: row.word,
    mastery: row.mastery,
    nextReview: row.review_date,
    fields: { meaning: row.meaning, definition: row.definition, example: row.example },
  };
}

const NO_ISSUES: SetupReport = { readIssues: [], writeIssues: [], warnings: [], entryWriteIssues: [] };

/**
 * Vocabulary stored in Supabase, for one signed-in user. Which rows that user
 * can reach is decided by the database (Row Level Security), not here.
 */
export class SupabaseVocabularyRepository implements VocabularyRepository, VocabularyCatalog {
  readonly mode = 'supabase' as const;

  constructor(
    private readonly database: VocabularyDatabase,
    private readonly rules: ReviewRules,
  ) {}

  async checkSetup(): Promise<SetupReport> {
    // The schema is this project's own; a missing migration surfaces as an error on first use.
    return NO_ISSUES;
  }

  // ---- Review queue ----

  async listDueCandidates(today: IsoDate): Promise<{ records: VocabularyRecord[]; invalid: SkippedRecord[] }> {
    // With rules that do not admit undated words the query returns a few extra
    // rows; the rules engine does the authoritative filtering either way.
    const rows = await this.database.listDueCards(today, this.rules.retiredAtMastery);
    return { records: rows.map(toRecord), invalid: [] };
  }

  async vocabularyStatus(): Promise<VocabularyStatus> {
    if ((await this.database.countCards({ masteryBelow: this.rules.retiredAtMastery })) > 0) return 'in_progress';
    return (await this.database.countCards()) > 0 ? 'all_mastered' : 'empty';
  }

  async getRecord(id: string): Promise<VocabularyRecord | null> {
    const row = await this.database.getCard(id);
    return row === null || row.deleted_at !== null ? null : toRecord(row);
  }

  async applyReview(write: ReviewWrite): Promise<ReviewWriteResult> {
    const result = await this.database.applyReview({
      id: write.id,
      requestId: write.requestId,
      action: write.action,
      expectedMastery: write.expected.mastery,
      expectedReviewDate: write.expected.nextReview,
      newMastery: write.next.mastery,
      newReviewDate: write.next.nextReview,
      reviewedOn: write.reviewedOn,
      durationMs: write.durationMs,
    });
    if (result.outcome === 'not_found' || result.mastery === null) return { outcome: 'not_found' };
    return { outcome: result.outcome, state: { mastery: result.mastery, nextReview: result.review_date } };
  }

  async findReview(requestId: string) {
    const found = await this.database.findReviewByRequestId(requestId);
    return found === null ? null : { mastery: found.mastery, nextReview: found.reviewDate };
  }

  // ---- Whole records ----

  async listEntries() {
    return { entries: (await this.database.listCards()).map(toEntry), invalid: [] };
  }

  async listTrashed(): Promise<EntryData[]> {
    return (await this.database.listTrashedCards()).map(toEntry);
  }

  async getEntry(id: string): Promise<EntryData | null> {
    const row = await this.database.getCard(id);
    return row === null || row.deleted_at !== null ? null : toEntry(row);
  }

  async findEntriesByWord(word: string): Promise<EntryData[]> {
    const wanted = normalizeWord(word);
    const rows = await this.database.findCardsByWordKey(wanted);
    // The stored key is trusted for the lookup; the comparison that counts is repeated here.
    return rows.filter((row) => normalizeWord(row.word) === wanted).map(toEntry);
  }

  async findByRequestId(requestId: string): Promise<EntryData | null> {
    const row = await this.database.findCardByRequestId(requestId);
    return row === null || row.deleted_at !== null ? null : toEntry(row);
  }

  async createEntry(entry: NewEntry): Promise<{ entry: EntryData; created: boolean }> {
    const { id, created } = await this.database.createCard({
      word: entry.word,
      wordKey: normalizeWord(entry.word),
      mastery: entry.mastery,
      meaning: entry.meaning,
      definition: entry.definition,
      example: entry.example,
      dateAdded: entry.dateAdded,
      reviewDate: entry.reviewDate,
      requestId: entry.requestId ?? null,
    });
    // Read back what was stored rather than echoing the request.
    const row = await this.database.getCard(id);
    if (row === null) throw new Error('The new word could not be read back.');
    return { entry: toEntry(row), created };
  }

  async updateEntry(id: string, changes: EntryChanges): Promise<EntryData> {
    const patch: CardPatch = {};
    if (changes.word !== undefined) {
      patch.word = changes.word;
      patch.word_key = normalizeWord(changes.word);
    }
    if (changes.meaning !== undefined) patch.meaning = changes.meaning;
    if (changes.definition !== undefined) patch.definition = changes.definition;
    if (changes.example !== undefined) patch.example = changes.example;
    if (changes.dateAdded !== undefined) patch.date_added = changes.dateAdded;
    if (changes.mastery !== undefined) patch.mastery = changes.mastery;
    if (changes.reviewDate !== undefined) patch.review_date = changes.reviewDate;

    const updated = await this.database.updateCard(id, patch);
    const row = updated ? await this.database.getCard(id) : null;
    if (row === null) throw new Error('The word could not be read back after the change.');
    return toEntry(row);
  }

  async trashEntry(id: string): Promise<boolean> {
    if (await this.database.setCardTrashed(id, true)) return true;
    // Already in the trash counts as done; a word that does not exist does not.
    const row = await this.database.getCard(id);
    return row !== null && row.deleted_at !== null;
  }

  async restoreEntry(id: string): Promise<EntryData | null> {
    await this.database.setCardTrashed(id, false);
    const row = await this.database.getCard(id);
    return row === null || row.deleted_at !== null ? null : toEntry(row);
  }
}
