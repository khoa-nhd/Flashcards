import type { SkippedRecord, VocabularyStatus } from '../shared/api.js';
import type { IsoDate } from '../shared/dates.js';
import type { ReviewAction, ReviewState } from '../shared/review-logic.js';
import type { VocabularyRecord } from '../shared/vocabulary.js';

export interface SetupReport {
  /** Problems that prevent reading the queue at all. */
  readIssues: string[];
  /** Problems that only prevent saving review results. */
  writeIssues: string[];
  /** Non-blocking notes, e.g. an optional field that could not be found. */
  warnings: string[];
  /** Problems that only prevent creating and editing whole records; reviews still save. */
  entryWriteIssues?: string[];
}

/** One review answer, with the new state already computed by the scheduler. */
export interface ReviewWrite {
  id: string;
  /** Identifies this answer, so a store that records answers can recognise a retry. */
  requestId: string;
  action: ReviewAction;
  /** The state the answer was computed from. A store that can will refuse if it no longer holds. */
  expected: ReviewState;
  next: ReviewState;
  /** The reviewer's calendar day. */
  reviewedOn: IsoDate;
  durationMs: number | null;
}

export type ReviewWriteResult =
  | { outcome: 'applied' | 'already_applied' | 'conflict'; state: ReviewState }
  | { outcome: 'not_found' };

export type DataMode = 'mock' | 'notion' | 'supabase';

/** Where vocabulary lives. */
export interface VocabularyRepository {
  readonly mode: DataMode;
  checkSetup(): Promise<SetupReport>;
  /**
   * Records that might be due on `today`. May return more than the exact
   * queue (the rules engine does the authoritative filtering) but never less.
   */
  listDueCandidates(today: IsoDate): Promise<{ records: VocabularyRecord[]; invalid: SkippedRecord[] }>;
  /** Whether the collection is empty, fully mastered, or still has words to learn. */
  vocabularyStatus(): Promise<VocabularyStatus>;
  /** The record's latest state, or `null` if it is not a live row of this database. */
  getRecord(pageId: string): Promise<VocabularyRecord | null>;
  /** Saves one answer and returns the state the store confirms afterwards. */
  applyReview(write: ReviewWrite): Promise<ReviewWriteResult>;
  /** The state an earlier answer with this request id left the word in, if the store records answers. */
  findReview(requestId: string): Promise<ReviewState | null>;
}
