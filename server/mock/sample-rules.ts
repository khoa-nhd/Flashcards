import type { ReviewRules } from '../../shared/review-logic.js';

/**
 * ILLUSTRATIVE RULES — NOT the owner's schedule.
 *
 * They exist so the interface can be exercised against sample data and so the
 * rules engine has something concrete to be tested with. They are only ever
 * used in mock mode and tests; real accounts use config/review.config.ts.
 */
export const sampleRules: ReviewRules = {
  retiredAtMastery: 10,
  hideDetailsAboveMastery: 5,
  includeDueToday: true,
  includeMissingDueDate: false,
  missingMastery: 'exclude',
  sortDirection: 'ascending',
  remember: {
    masteryAfter: (mastery) => Math.min(mastery + 1, 10),
    schedule: { base: 'today', intervalDays: ({ masteryAfter }) => masteryAfter },
  },
  notRemember: {
    masteryAfter: (mastery) => mastery,
    schedule: { base: 'today', intervalDays: () => 1 },
  },
};
