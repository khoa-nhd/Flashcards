import type { IsoDate } from './dates.js';
import type { FsrsState } from './scheduler/fsrs.js';

/** A vocabulary row after mapping and validation, independent of where it came from. */
export interface VocabularyRecord {
  id: string;
  word: string;
  /** `null` when no mastery is stored. */
  mastery: number | null;
  /** `null` when the due date is empty or unreadable. */
  nextReview: IsoDate | null;
  /** Display fields keyed by `CardFieldConfig.key`; `null` when empty. */
  fields: Record<string, string | null>;
  /** The card's FSRS state, where one is kept and the card has one. It never decides what is due. */
  fsrs?: StoredFsrs | null;
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
  mastery: number;
  /** `empty` leaves the review date blank, which the queue rule treats as due now. */
  reviewDate: 'empty' | 'today';
}

/**
 * Where a word stands in the review cycle. Exactly one applies to every entry:
 * - `mastered`: mastery has reached the completion level.
 * - `overdue` / `due_today`: reviewable now, scheduled before today / today.
 * - `unscheduled`: not mastered and no review date.
 * - `upcoming`: scheduled for a later day.
 * - `invalid`: mastery is empty or not a usable number, so it cannot be scheduled.
 */
export type ReviewStatus = 'mastered' | 'overdue' | 'due_today' | 'unscheduled' | 'upcoming' | 'invalid';

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
