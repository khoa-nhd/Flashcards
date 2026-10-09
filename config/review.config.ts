/**
 * The single place that describes YOUR Notion vocabulary system: which
 * properties to read and what the review buttons do.
 *
 * Status of each value is tracked in docs/review-logic.md. Markers used here:
 *   STATED      — taken from the project brief, not yet checked against Notion.
 *   PLACEHOLDER — a guess at a name so the app has something to look for. The
 *                 server validates these against the real schema on first use
 *                 and reports exactly which ones are wrong.
 *   UNCONFIRMED — unknown. While either action rule is `null` the app stays a
 *                 read-only preview and never writes to Notion.
 */
import type { ReviewRules } from '../shared/review-logic.js';
import type { CardFieldConfig, NotionPropertyConfig } from '../shared/vocabulary.js';

export const notionProperties: NotionPropertyConfig = {
  word: 'Word', // PLACEHOLDER — the title property
  mastery: 'Mastery', // PLACEHOLDER — number
  nextReview: 'Next Review', // PLACEHOLDER — date
};

export const cardFields: CardFieldConfig[] = [
  // PLACEHOLDER names. Fields whose property does not exist are dropped with a warning.
  { key: 'partOfSpeech', property: 'Part of Speech', label: 'Part of speech', side: 'front', visibility: 'always' },
  { key: 'pronunciation', property: 'Pronunciation', label: 'Pronunciation', side: 'front', visibility: 'always' },
  // STATED: definition and example are hidden when mastery > 5.
  { key: 'definition', property: 'Definition', label: 'Definition', side: 'back', visibility: 'details' },
  { key: 'example', property: 'Example', label: 'Example', side: 'back', visibility: 'details' },
];

export const reviewRules: ReviewRules = {
  retiredAtMastery: 10, // STATED: mastery 10 never enters the queue.
  hideDetailsAboveMastery: 5, // STATED: mastery > 5 hides definition and example.
  includeDueToday: true, // STATED ("due or overdue"); exact date comparison UNCONFIRMED.
  includeMissingDueDate: false, // UNCONFIRMED: are rows without a due date reviewable?
  missingMastery: 'exclude', // UNCONFIRMED: is an empty mastery treated as 0?
  sortDirection: 'ascending', // UNCONFIRMED: most-overdue first is assumed.

  // UNCONFIRMED — what the "Remember" button does. Example shape only:
  //   remember: {
  //     masteryAfter: (mastery) => Math.min(mastery + 1, 10),
  //     schedule: { base: 'today', intervalDays: ({ masteryAfter }) => /* your rule */ },
  //   },
  remember: null,

  // UNCONFIRMED — what the "Not Remember" button does. The brief says "move the
  // next review date forward by one day" without raising mastery, but not
  // whether the day is counted from today or from the existing due date:
  //   notRemember: {
  //     masteryAfter: (mastery) => mastery,
  //     schedule: { base: 'today' /* or 'currentDueDate' */, intervalDays: () => 1 },
  //   },
  notRemember: null,
};

/** Shown by the health endpoint and the inspect script until resolved. */
export const pendingConfirmation: string[] = [
  'Remember: mastery change and next-review-date formula',
  'Not Remember: whether +1 day counts from today or from the existing due date',
  'Property names for word, mastery, next review date and the card fields',
  'Queue: sort direction, due-today comparison, rows with empty date or mastery',
  'Any other property the review buttons update (e.g. a last-reviewed date)',
];
