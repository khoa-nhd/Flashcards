import type { IsoDate } from './dates.js';
import type { FsrsState } from './scheduler/fsrs.js';

/** A vocabulary row after mapping and validation, independent of where it came from. */
export interface VocabularyRecord {
  id: string;
  word: string;
  /**
   * The display mirror of FSRS strength, kept for older callers and rollback.
   * Scheduling never reads it.
   */
  mastery: number | null;
  /** The due day mirror. FSRS sets it from its own state. */
  nextReview: IsoDate | null;
  /** Display fields keyed by `CardFieldConfig.key`; `null` when empty. */
  fields: Record<string, string | null>;
  /** The card's FSRS state, where one is kept and the card has one. This decides what is due. */
  fsrs?: StoredFsrs | null;
  /** A fallback due day for a word FSRS has never seen. */
  dueOn?: IsoDate | null;
  /** Increments on every saved answer. */
  revision?: number;
  /** Archived words stay stored but leave the queue and dashboard. */
  suspended?: boolean;
}

/** An FSRS state together with the engine that produced it. */
export interface StoredFsrs {
  state: FsrsState;
  engine: string;
}

/** The editable text fields of an entry besides the word itself. */
export const TEXT_FIELD_KEYS = ['meaning', 'definition', 'example'] as const;
export type TextFieldKey = (typeof TEXT_FIELD_KEYS)[number];

/** What a newly created word starts with when the form does not say otherwise. */
export interface NewWordDefaults {
  /** Legacy display mirror. An FSRS-only store ignores it. */
  mastery: number;
  /** `empty` leaves the review date blank, which the queue rule treats as due now. */
  reviewDate: 'empty' | 'today';
  /** FSRS-first fallback due day for a new word. */
  dueOn?: 'today';
  /** How many new words a large import offers to spread per day. */
  newWordsPerDay?: number;
}

/**
 * Where a word stands in the review cycle.
 * - `new`: no FSRS state yet and due now.
 * - `overdue` / `due_today`: reviewable now, scheduled before today / today.
 * - `unscheduled`: no usable due day.
 * - `upcoming`: scheduled for a later day.
 * - `suspended`: archived by hand; never in the queue.
 * - `invalid`: no FSRS state and no usable due day.
 * - `mastered`: legacy display only; FSRS-only mode never emits it.
 */
export type ReviewStatus =
  | 'new'
  | 'overdue'
  | 'due_today'
  | 'unscheduled'
  | 'upcoming'
  | 'suspended'
  | 'mastered'
  | 'invalid';

/** One optional piece of card content and where it may appear. */
export interface CardFieldConfig {
  /** Which stored field this is: a key of `VocabularyRecord.fields`. */
  key: string;
  label: string;
  side: 'front' | 'back';
  /**
   * `details` fields obey the mastery rule (withheld above the threshold);
   * `always` fields are shown at every mastery.
   */
  visibility: 'always' | 'details';
}
