import type { SkippedRecord } from '../shared/api.js';
import type { IsoDate } from '../shared/dates.js';
import type { ReviewState } from '../shared/review-logic.js';
import type { VocabularyRecord } from '../shared/vocabulary.js';

export interface SetupReport {
  /** Problems that prevent reading the queue at all. */
  readIssues: string[];
  /** Problems that only prevent saving review results. */
  writeIssues: string[];
  /** Non-blocking notes, e.g. an optional field that could not be found. */
  warnings: string[];
}

/** Where vocabulary lives. Implemented by Notion and by in-memory sample data. */
export interface VocabularyRepository {
  readonly mode: 'mock' | 'notion';
  checkSetup(): Promise<SetupReport>;
  /**
   * Records that might be due on `today`. May return more than the exact
   * queue (the rules engine does the authoritative filtering) but never less.
   */
  listDueCandidates(today: IsoDate): Promise<{ records: VocabularyRecord[]; invalid: SkippedRecord[] }>;
  /** The record's latest state, or `null` if it is not a live row of this database. */
  getRecord(pageId: string): Promise<VocabularyRecord | null>;
  /** Writes only the given review properties and returns the record as stored afterwards. */
  updateReviewState(pageId: string, changes: Partial<ReviewState>): Promise<VocabularyRecord>;
}
