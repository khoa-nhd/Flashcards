/**
 * Classifies a word for the dashboard, the Vocabulary Bank filters and the
 * calendar. In FSRS-only mode the due day comes from FSRS state (or the
 * fallback `dueOn` for a word FSRS has never seen). The legacy mastery
 * classifier is kept for older databases and older clients during the
 * phased rollout.
 */
import { compareDates, isIsoDate, type IsoDate } from './dates.js';
import { resolveMastery, type ReviewRules } from './review-logic.js';
import type { ReviewStatus } from './vocabulary.js';

export interface FsrsStatusInput {
  /** The day FSRS (or the fallback) has the word due. */
  dueOn: IsoDate | null;
  /** True when FSRS has a state for this word. */
  hasFsrs?: boolean;
  suspended?: boolean;
}

/**
 * FSRS-first status. A word with no FSRS state is `new` while it is due and
 * `upcoming` once its fallback due day is in the future. Archived words are
 * `suspended` even if their due day has passed.
 */
export function classifyFsrsStatus(record: FsrsStatusInput, today: IsoDate): ReviewStatus {
  if (record.suspended === true) return 'suspended';
  if (record.dueOn === null || !isIsoDate(record.dueOn)) return 'invalid';
  const order = compareDates(record.dueOn, today);
  if (order < 0) return 'overdue';
  if (order === 0) return record.hasFsrs === true ? 'due_today' : 'new';
  return 'upcoming';
}

/** Whether a status is reviewable under the FSRS-first rules. */
export function isFsrsReviewable(status: ReviewStatus): boolean {
  return status === 'new' || status === 'overdue' || status === 'due_today';
}

/** Legacy mastery classifier, used only where FSRS is not available. */
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

/** Whether a legacy status is reviewable under the mastery rules. */
export function isReviewableNow(status: ReviewStatus, rules: ReviewRules): boolean {
  if (status === 'overdue' || status === 'due_today') return true;
  return status === 'unscheduled' && rules.includeMissingDueDate;
}
