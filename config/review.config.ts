/**
 * The single place that describes how reviewing works: which cards are due,
 * what each answer does, and what a card shows.
 *
 * These rules were defined by the owner's original vocabulary system and are
 * carried over unchanged. Where each one comes from is recorded in
 * docs/review-logic.md. Markers used here:
 *   VERIFIED    — read from the original system's own formulas and views.
 *   STATED      — given by the owner, and consistent with every stored word.
 *   UNCONFIRMED — still unknown; display only.
 *
 * Changing a value here changes how every account's reviews are scheduled.
 */
import type { ReviewRules } from '../shared/review-logic.js';
import { FSRS_RATINGS } from '../shared/scheduler/fsrs.js';
import { assertRatingMap, type RatingMap } from '../shared/scheduler/rating-map.js';
import type { CardFieldConfig, NewWordDefaults } from '../shared/vocabulary.js';

/**
 * How the two answers are rated for FSRS, which is calculated in the
 * background beside the schedule above and does not decide what is due.
 * Remember is Good rather than Easy on purpose; see shared/scheduler/rating-map.ts.
 */
export const fsrsRatingMap: RatingMap = assertRatingMap({
  remember: FSRS_RATINGS.good,
  not_remember: FSRS_RATINGS.again,
});

/**
 * What a word created in the app starts with: mastery 1 and no review date.
 * An empty review date counts as due, so a new word is reviewable at once.
 * Both can be changed per word in the Add form.
 */
export const newWordDefaults: NewWordDefaults = {
  mastery: 1, // VERIFIED from the original new-word template; no word has ever been below 1
  reviewDate: 'empty', // VERIFIED from the same template
};

export const cardFields: CardFieldConfig[] = [
  // UNCONFIRMED placement: the meaning is taken to be the answer the card reveals.
  { key: 'meaning', label: 'Vietnamese meaning', side: 'back', visibility: 'always' },
  // VERIFIED: the definition and the example are shown only while mastery is
  // at most 5. `details` makes the server withhold them above that level.
  { key: 'definition', label: 'Definition', side: 'back', visibility: 'details' },
  { key: 'example', label: 'Example', side: 'back', visibility: 'details' },
];

/**
 * VERIFIED: a word is due when
 *   mastery < 10 and (it has no review date, or its review date is today or earlier)
 * and due words are ordered by review date, earliest first.
 *
 * "Today" is the calendar day in the account's own time zone, never the
 * server's. See docs/review-logic.md, section 2.
 */
export const reviewRules: ReviewRules = {
  retiredAtMastery: 10, // VERIFIED: mastery < 10
  hideDetailsAboveMastery: 5, // VERIFIED: mastery <= 5 shows definition and example
  includeDueToday: true, // VERIFIED: review date <= today
  includeMissingDueDate: true, // VERIFIED: an empty review date counts as due
  missingMastery: 'exclude', // UNCONFIRMED, and moot: the database does not allow an empty mastery
  sortDirection: 'ascending', // VERIFIED: earliest review date first

  // STATED by the owner (2026-10-10), and consistent with every stored word:
  // "Nhớ" (Remember) raises mastery by exactly 1 and sets the review date to
  // the day of the review plus the OLD mastery in calendar days. Mastery never
  // exceeds 10.
  remember: {
    masteryAfter: (mastery) => Math.min(mastery + 1, 10),
    schedule: { base: 'today', intervalDays: ({ masteryBefore }) => masteryBefore },
  },

  // STATED by the owner: "Không nhớ" (Not remember) leaves mastery alone and
  // sets the review date to the day after the review.
  notRemember: {
    masteryAfter: (mastery) => mastery,
    schedule: { base: 'today', intervalDays: () => 1 },
  },
};
