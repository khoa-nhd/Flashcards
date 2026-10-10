/**
 * The single place that describes YOUR Notion vocabulary system: which
 * properties to read and what the review buttons do.
 *
 * Status of each value is tracked in docs/review-logic.md. Markers used here:
 *   VERIFIED    — read from the Notion database itself (schema, formulas, the
 *                 "Need review" view) on 2026-10-10.
 *   STATED      — given by the owner. Button steps cannot be read from Notion,
 *                 so these rest on the owner's word and on the stored data.
 *   UNCONFIRMED — still unknown; display only.
 *
 * Saving also requires REVIEW_WRITES_ENABLED=true in the environment.
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

  // STATED by the owner (2026-10-10), and consistent with every stored row:
  // "Nhớ" raises Mastery by exactly 1 and sets Review Date to the day of the
  // review plus the OLD Mastery in calendar days. Mastery never exceeds 10.
  remember: {
    masteryAfter: (mastery) => Math.min(mastery + 1, 10),
    schedule: { base: 'today', intervalDays: ({ masteryBefore }) => masteryBefore },
  },

  // STATED by the owner: "Không nhớ" leaves Mastery alone and sets Review Date
  // to the day after the review.
  notRemember: {
    masteryAfter: (mastery) => mastery,
    schedule: { base: 'today', intervalDays: () => 1 },
  },
};

/** Shown by the inspect script until resolved. None of these block saving. */
export const pendingConfirmation: string[] = [
  'Overdue words: the buttons are taken to count days from the day you review, not from the old Review Date. Stored data cannot distinguish the two; one test word settles it (docs/review-logic.md, section 10).',
  '"Hiện đáp án" and the "Answer Shown" checkbox: the app never touches the checkbox. If "Nhớ" / "Không nhớ" untick it in Notion, say so.',
  'Card layout: "Vietnamese Meaning" is shown on the back as the answer.',
];
