/**
 * The single place that describes YOUR Notion vocabulary system: which
 * properties to read and what the review buttons do.
 *
 * Status of each value is tracked in docs/review-logic.md. Markers used here:
 *   VERIFIED    — read from the Notion database itself (schema, formulas, the
 *                 "Need review" view) on 2026-10-10.
 *   STATED      — taken from the project brief, consistent with Notion so far.
 *   UNCONFIRMED — still unknown. While either action rule is `null` the app
 *                 stays a read-only preview and never writes to Notion.
 */
import type { ReviewRules } from '../shared/review-logic.js';
import type { CardFieldConfig, NotionPropertyConfig } from '../shared/vocabulary.js';

// VERIFIED: property names and types.
export const notionProperties: NotionPropertyConfig = {
  word: 'Word', // title
  mastery: 'Mastery', // number
  nextReview: 'Review Date', // date (every existing value is date-only)
};

export const cardFields: CardFieldConfig[] = [
  // UNCONFIRMED placement: assumed to be the answer revealed by "Hiện đáp án".
  { key: 'meaning', property: 'Vietnamese Meaning', label: 'Vietnamese meaning', side: 'back', visibility: 'always' },
  // VERIFIED: "Review Definition" = if(Mastery <= 5, Definition, "") and
  // "Review Example" = if(Mastery <= 5, Example Sentences, ""). Reading the
  // formulas means Notion itself decides what is hidden; `details` makes the
  // server apply the same threshold again, so the stricter of the two wins.
  { key: 'definition', property: 'Review Definition', label: 'Definition', side: 'back', visibility: 'details' },
  { key: 'example', property: 'Review Example', label: 'Example', side: 'back', visibility: 'details' },
];

/**
 * VERIFIED against the "Due for Review" formula, which the "Need review" view
 * filters on:
 *   prop("Mastery") < 10 and (empty(prop("Review Date")) or dateStart(prop("Review Date")) <= today())
 * and against that view's sort (Review Date, ascending).
 *
 * The app applies this rule itself instead of reading the formula's value,
 * because through the API Notion evaluates today() in UTC, while in the Notion
 * app it follows your own clock. See docs/review-logic.md, section 2.
 */
export const reviewRules: ReviewRules = {
  retiredAtMastery: 10, // VERIFIED: Mastery < 10
  hideDetailsAboveMastery: 5, // VERIFIED: Mastery <= 5 shows definition and example
  includeDueToday: true, // VERIFIED: Review Date <= today()
  includeMissingDueDate: true, // VERIFIED: empty(Review Date) counts as due
  missingMastery: 'exclude', // UNCONFIRMED, and currently moot: no row has an empty Mastery
  sortDirection: 'ascending', // VERIFIED: "Need review" sorts Review Date ascending

  // UNCONFIRMED — what the "Nhớ" button does. The stored data is consistent
  // with "Mastery + 1, Review Date = today + (old Mastery) days", but that is
  // an inference, not something Notion's API can show. Awaiting confirmation:
  //   remember: {
  //     masteryAfter: (mastery) => mastery + 1,
  //     schedule: { base: 'today', intervalDays: ({ masteryBefore }) => masteryBefore },
  //   },
  remember: null,

  // UNCONFIRMED — what the "Không nhớ" button does. Awaiting confirmation:
  //   notRemember: {
  //     masteryAfter: (mastery) => mastery,
  //     schedule: { base: 'today', intervalDays: () => 1 },
  //   },
  notRemember: null,
};

/** Shown by the inspect script until resolved. */
export const pendingConfirmation: string[] = [
  '"Nhớ": the exact steps (Mastery change, Review Date formula, anything else it edits)',
  '"Không nhớ": the exact steps (does Mastery stay the same? is the date today + 1?)',
  '"Hiện đáp án" and the "Answer Shown" checkbox: what they do, and whether the two answer buttons reset it',
  'Card layout: is "Vietnamese Meaning" the answer, and do definition and example belong on the back?',
];
