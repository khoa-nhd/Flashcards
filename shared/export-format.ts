/**
 * The file a full export produces. Documented for people in
 * docs/export-format.md; this is the same thing for the compiler.
 *
 * An export is everything one account can read about itself. It is a copy for
 * the owner to keep, not a database backup: it has no other accounts, no
 * sign-in details, and nothing in the app restores review history from it.
 */
import type { IsoDate } from './dates.js';
import type { Collection, ExtraExample, Relation } from './library.js';
import type { SchedulerId } from './scheduler/active.js';
import type { FsrsState } from './scheduler/fsrs.js';
import type { DailyGoal } from './session-planner.js';

export const EXPORT_FORMAT = 'vocabulary-flashcards-export';
/** Raised whenever a field is renamed or removed, so a reader can tell what it holds. */
export const EXPORT_VERSION = 1;

/** One row of the review history, exactly as recorded. */
export interface HistoryEvent {
  id: string;
  vocabularyId: string;
  /** `review`: a flashcard answer. `undo`: one being taken back. `practice`: an answer in another study mode. */
  kind: 'review' | 'undo' | 'practice';
  action: 'remember' | 'not_remember';
  mode: string;
  /** When it was saved (UTC), and the reviewer's own calendar day at that moment. */
  reviewedAt: string;
  reviewedOn: IsoDate;
  durationMs: number | null;
  masteryBefore: number;
  masteryAfter: number;
  reviewDateBefore: IsoDate | null;
  reviewDateAfter: IsoDate | null;
  sessionId: string | null;
  /** For an undo, the id of the review it takes back. */
  undoesId: string | null;
  /** Which schedule was in charge of what was due when this was saved. Both were updated either way. */
  scheduler: SchedulerId;
  /** The FSRS rating the answer was given as (1 Again … 4 Easy), where one was calculated. */
  rating: number | null;
  /** 1 low, 2 medium, 3 high; what the reviewer said before seeing the answer. */
  confidence: number | null;
  /** For practice: whether the answer was right, what was typed, and who judged it. */
  answerCorrect: boolean | null;
  submittedAnswer: string | null;
  grading: 'self' | 'auto' | null;
}

export interface ExportedWord {
  id: string;
  word: string;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  dateAdded: IsoDate | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The mastery schedule: the level, and the review date it gives. Stored values, whichever schedule is in charge. */
  mastery: number | null;
  reviewDate: IsoDate | null;
  /** The FSRS state kept beside it, where the word has been answered since FSRS started being calculated. */
  fsrs: FsrsState | null;
  /** True for a word in the trash. Its collections, examples and links are not listed until it is restored. */
  inTrash: boolean;
}

export interface AccountExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  settings: {
    timeZone: string;
    dailyGoal: DailyGoal;
    /** `null` where FSRS is not being calculated. */
    fsrsRequestRetention: number | null;
    /** Which of a word's two schedules decides when it is due: `mastery_v1` or `fsrs`. */
    scheduler: SchedulerId;
  };
  counts: {
    words: number;
    wordsInTrash: number;
    collections: number;
    examples: number;
    relations: number;
    historyEvents: number;
  };
  vocabulary: ExportedWord[];
  collections: Collection[];
  examples: ExtraExample[];
  relations: Relation[];
  reviewHistory: HistoryEvent[];
}
