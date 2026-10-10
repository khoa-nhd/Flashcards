import type { Capabilities, SessionSummary, SkippedRecord, VocabularyStatus } from '../shared/api.js';
import type { DailyStat } from '../shared/analytics.js';
import type { IsoDate } from '../shared/dates.js';
import type { ReviewAction, ReviewState } from '../shared/review-logic.js';
import type { CardHistory } from '../shared/weak-words.js';
import type { ScheduleCard } from '../shared/scheduler/comparison.js';
import type { FsrsRating, FsrsState } from '../shared/scheduler/fsrs.js';
import type { StoredFsrs, VocabularyRecord } from '../shared/vocabulary.js';

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
  /** The sitting the answer belongs to, where the store keeps sessions. */
  sessionId: string | null;
  /** What FSRS made of the answer, to be saved with it where the store keeps FSRS state. */
  fsrs?: FsrsWrite | null;
}

export interface FsrsWrite {
  /** The FSRS rating the answer was given as. */
  rating: FsrsRating;
  /** The engine that computed `after`. */
  engine: string;
  before: StoredFsrs | null;
  after: FsrsState;
}

export type ReviewWriteResult =
  /** `undone`: this request was saved earlier and then taken back; it is not saved again. */
  | { outcome: 'applied' | 'already_applied' | 'undone' | 'conflict'; state: ReviewState }
  | { outcome: 'not_found' };

export type UndoResult =
  | { outcome: 'undone' | 'already_undone'; id: string; state: ReviewState }
  /** A newer answer stands, or the word was changed since: nothing was undone. */
  | { outcome: 'not_latest' | 'conflict'; id: string; state: ReviewState | null }
  | { outcome: 'not_found' }
  /** The store cannot undo (it keeps no history, or its schema is behind). */
  | { outcome: 'unsupported' };

export type DataMode = 'mock' | 'supabase';

/** Where vocabulary lives. */
export interface VocabularyRepository {
  readonly mode: DataMode;
  /** What this store supports right now. */
  readonly capabilities: Capabilities;
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
  /** Takes back one saved answer and restores the state before it, or explains why not. */
  undoReview(input: { reviewRequestId: string; requestId: string }): Promise<UndoResult>;
  /** What a session saved; `null` if there is no such session or the store keeps none. */
  sessionSummary(sessionId: string): Promise<SessionSummary | null>;
  /** Every live word with both of its schedules, for comparing them. */
  listSchedules(): Promise<ScheduleCard[]>;
  /** Saved reviews per day and study mode in a range of the reviewer's days. Empty where no history is kept. */
  reviewDailyStats(from: IsoDate, to: IsoDate): Promise<DailyStat[]>;
  /** How each reviewed word has gone, by word id. Empty where no history is kept. */
  cardReviewStats(since: IsoDate): Promise<Map<string, CardHistory>>;
}
