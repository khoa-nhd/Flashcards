import type { IsoDate } from './dates.js';

/** A vocabulary row after mapping and validation, independent of where it came from. */
export interface VocabularyRecord {
  id: string;
  word: string;
  /** `null` when the mastery property is empty. */
  mastery: number | null;
  /** `null` when the due date is empty or unreadable. */
  nextReview: IsoDate | null;
  /** Display fields keyed by `CardFieldConfig.key`; `null` when empty. */
  fields: Record<string, string | null>;
}

/** The Notion properties that drive review eligibility and scheduling. */
export interface NotionPropertyConfig {
  word: string;
  mastery: string;
  nextReview: string;
}

/** One optional piece of card content and where it may appear. */
export interface CardFieldConfig {
  key: string;
  /** Exact Notion property name. */
  property: string;
  label: string;
  side: 'front' | 'back';
  /**
   * `details` fields obey the mastery rule (withheld above the threshold);
   * `always` fields are shown at every mastery.
   */
  visibility: 'always' | 'details';
}
