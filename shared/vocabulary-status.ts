/**
 * Classifies a word for the dashboard, the Vocabulary Bank filters and the
 * calendar. It is built on the same rules object as the review queue, so
 * "due" here can never drift from what the Review tab actually shows.
 */
import { compareDates, isIsoDate, type IsoDate } from './dates.js';
import { resolveMastery, type ReviewRules } from './review-logic.js';
import type { ReviewStatus } from './vocabulary.js';

export function classifyReviewStatus(
  record: { mastery: number | null; reviewDate: IsoDate | null },
  today: IsoDate,
  rules: ReviewRules,
): ReviewStatus {
  const mastery = resolveMastery(record.mastery, rules);
  if (mastery === null || !Number.isInteger(mastery) || mastery < 0) return 'invalid';
  if (mastery >= rules.retiredAtMastery) return 'mastered';
  if (record.reviewDate === null || !isIsoDate(record.reviewDate)) return 'unscheduled';

  const order = compareDates(record.reviewDate, today);
  if (order < 0) return 'overdue';
  if (order === 0) return rules.includeDueToday ? 'due_today' : 'upcoming';
  return 'upcoming';
}

/** Whether a word with this status is in the review queue right now. */
export function isReviewableNow(status: ReviewStatus, rules: ReviewRules): boolean {
  if (status === 'overdue' || status === 'due_today') return true;
  return status === 'unscheduled' && rules.includeMissingDueDate;
}
