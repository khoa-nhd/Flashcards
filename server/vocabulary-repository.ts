import type { Capabilities, Confidence, SessionSummary, SkippedRecord, VocabularyStatus } from '../shared/api.js';
import type { DailyStat } from '../shared/analytics.js';
import type { IsoDate } from '../shared/dates.js';
import type { HistoryEvent } from '../shared/export-format.js';
import type { ReviewAction, ReviewState } from '../shared/review-logic.js';
import type { StudyMode } from '../shared/study-modes.js';
import type { CardHistory } from '../shared/weak-words.js';
import type { SchedulerId } from '../shared/scheduler/active.js';
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
  /** How sure the reviewer said they were beforehand, where the store keeps it. Never affects the result. */
  confidence?: Confidence | null;
  /**
   * Which schedule was in charge, for a store that has no settings of its own
   * to look it up in. The real database reads it from the account instead.
   */
  scheduler?: SchedulerId;
}

/** One answer given in a practice mode. Recording it never changes the word's schedule. */
export interface PracticeWrite {
  id: string;
  requestId: string;
  sessionId: string | null;
  mode: StudyMode;
  correct: boolean;
  /** Who decided it was right: the reviewer, or a comparison. */
  grading: 'self' | 'auto';
  /** What was typed, where something was. */
  submitted: string | null;
  reviewedOn: IsoDate;
  durationMs: number | null;
  confidence: Confidence | null;
}

/** `unsupported`: the store does not record practice (its schema is behind). */
export type PracticeWriteResult = 'recorded' | 'already_recorded' | 'not_found' | 'unsupported';

/** One day of practice in one study mode. */
export interface PracticeDailyStat {
  day: IsoDate;
  mode: string;
  answers: number;
  correct: number;
  durationMs: number;
  timedAnswers: number;
  cards: number;
}

/** How answers given at one level of confidence went. */
export interface ConfidenceStat {
  confidence: Confidence;
  reviews: number;
  remembered: number;
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
  /**
   * Every live word as a review record, whatever its review date. Used when
   * the mastery date is not what decides whether a word is due.
   */
  listLiveRecords(): Promise<{ records: VocabularyRecord[]; invalid: SkippedRecord[] }>;
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
  /** The whole review history, oldest first, exactly as recorded. For the account's own export. */
  listHistory(): Promise<HistoryEvent[]>;
  /** Records one practice answer, once per request id. It never changes mastery, the review date or FSRS state. */
  recordPractice(write: PracticeWrite): Promise<PracticeWriteResult>;
  /** Practice answers per day and study mode in a range of the reviewer's days. Empty where none are kept. */
  practiceDailyStats(from: IsoDate, to: IsoDate): Promise<PracticeDailyStat[]>;
  /** How many correct practice answers one word has in each study mode. Empty where none are kept. */
  practiceCorrectCounts(id: string): Promise<Map<string, number>>;
  /** Standing answers since `since` that carried a confidence rating, by rating. Empty where none are kept. */
  confidenceStats(since: IsoDate): Promise<ConfidenceStat[]>;
}
