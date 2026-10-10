/**
 * The review rules engine. Everything here is a pure function of its inputs so
 * it can be tested without a database, a clock, or a browser.
 *
 * This file deliberately contains NO numbers describing the owner's schedule.
 * The actual rules are data (`ReviewRules`) supplied from
 * `config/review.config.ts`; see docs/review-logic.md for their status.
 */
import { addDays, compareDates, isIsoDate, type IsoDate } from './dates.js';

export type ReviewAction = 'remember' | 'not_remember';

export const REVIEW_ACTIONS: readonly ReviewAction[] = ['remember', 'not_remember'];

/** The part of a vocabulary record that a review action changes. */
export interface ReviewState {
  mastery: number;
  nextReview: IsoDate | null;
}

export interface ScheduleRule {
  /** The date the interval is counted from. */
  base: 'today' | 'currentDueDate';
  /** Whole days to add to the base date. */
  intervalDays: (context: { masteryBefore: number; masteryAfter: number }) => number;
}

export interface ActionRule {
  masteryAfter: (masteryBefore: number) => number;
  schedule: ScheduleRule;
}

export interface ReviewRules {
  /** Records at or above this mastery are finished and never enter the queue. */
  retiredAtMastery: number;
  /** Definition/example style details are withheld above this mastery. */
  hideDetailsAboveMastery: number;
  /** Whether a record due exactly today is eligible. */
  includeDueToday: boolean;
  /** Whether a record without a due date is eligible. */
  includeMissingDueDate: boolean;
  /** How to treat a record whose mastery is empty. */
  missingMastery: 'exclude' | { treatAs: number };
  sortDirection: 'ascending' | 'descending';
  /** `null` means the rule has not been confirmed and must not be applied. */
  remember: ActionRule | null;
  notRemember: ActionRule | null;
}

export class RuleNotConfirmedError extends Error {
  constructor(public readonly action: ReviewAction) {
    super(`The "${action}" review rule has not been confirmed yet.`);
    this.name = 'RuleNotConfirmedError';
  }
}

export function ruleFor(action: ReviewAction, rules: ReviewRules): ActionRule | null {
  return action === 'remember' ? rules.remember : rules.notRemember;
}

export function areWriteRulesConfirmed(rules: ReviewRules): boolean {
  return rules.remember !== null && rules.notRemember !== null;
}

export function resolveMastery(mastery: number | null, rules: ReviewRules): number | null {
  if (mastery !== null) return Number.isFinite(mastery) ? mastery : null;
  return rules.missingMastery === 'exclude' ? null : rules.missingMastery.treatAs;
}

export type IneligibleReason =
  | 'retired'
  | 'not_due'
  | 'missing_due_date'
  | 'missing_mastery'
  | 'invalid_mastery';

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

export function checkEligibility(
  record: { mastery: number | null; nextReview: IsoDate | null },
  today: IsoDate,
  rules: ReviewRules,
): Eligibility {
  const mastery = resolveMastery(record.mastery, rules);
  if (mastery === null) return { eligible: false, reason: 'missing_mastery' };
  // The schedule counts whole days from the mastery level, so anything else cannot be reviewed.
  if (!Number.isInteger(mastery) || mastery < 0) return { eligible: false, reason: 'invalid_mastery' };
  if (mastery >= rules.retiredAtMastery) return { eligible: false, reason: 'retired' };
  if (record.nextReview === null || !isIsoDate(record.nextReview)) {
    return rules.includeMissingDueDate
      ? { eligible: true }
      : { eligible: false, reason: 'missing_due_date' };
  }
  const order = compareDates(record.nextReview, today);
  const due = order < 0 || (order === 0 && rules.includeDueToday);
  return due ? { eligible: true } : { eligible: false, reason: 'not_due' };
}

export interface QueueCandidate {
  id: string;
  mastery: number | null;
  nextReview: IsoDate | null;
}

export interface QueueResult<T> {
  queue: T[];
  excluded: Array<{ record: T; reason: IneligibleReason | 'duplicate' }>;
}

/**
 * Builds the review queue: drops duplicate ids (first occurrence wins), keeps
 * eligible records, then orders by due date. The sort is stable, so records
 * sharing a due date stay in the order the source returned them.
 */
export function buildQueue<T extends QueueCandidate>(
  records: readonly T[],
  today: IsoDate,
  rules: ReviewRules,
): QueueResult<T> {
  const seen = new Set<string>();
  const queue: T[] = [];
  const excluded: QueueResult<T>['excluded'] = [];

  for (const record of records) {
    if (seen.has(record.id)) {
      excluded.push({ record, reason: 'duplicate' });
      continue;
    }
    seen.add(record.id);
    const eligibility = checkEligibility(record, today, rules);
    if (eligibility.eligible) queue.push(record);
    else excluded.push({ record, reason: eligibility.reason });
  }

  const direction = rules.sortDirection === 'ascending' ? 1 : -1;
  queue.sort((a, b) => {
    // Records without a date (only present when the rules admit them) go last.
    if (a.nextReview === null || b.nextReview === null) {
      return a.nextReview === b.nextReview ? 0 : a.nextReview === null ? 1 : -1;
    }
    return direction * compareDates(a.nextReview, b.nextReview);
  });

  return { queue, excluded };
}

/** Whether definition/example style details may be shown at this mastery. */
export function areDetailsVisible(mastery: number, rules: ReviewRules): boolean {
  return mastery <= rules.hideDetailsAboveMastery;
}

/** The state a record should have after `action`. Never mutates its input. */
export function applyAction(
  action: ReviewAction,
  state: ReviewState,
  today: IsoDate,
  rules: ReviewRules,
): ReviewState {
  const rule = ruleFor(action, rules);
  if (rule === null) throw new RuleNotConfirmedError(action);

  const masteryAfter = rule.masteryAfter(state.mastery);
  if (!Number.isFinite(masteryAfter)) {
    throw new RangeError(`Rule for "${action}" produced an invalid mastery: ${masteryAfter}`);
  }

  const interval = rule.schedule.intervalDays({ masteryBefore: state.mastery, masteryAfter });
  if (!Number.isInteger(interval)) {
    throw new RangeError(`Rule for "${action}" produced a non-whole interval: ${interval}`);
  }

  let base: IsoDate;
  if (rule.schedule.base === 'today') {
    base = today;
  } else {
    if (state.nextReview === null) {
      throw new RangeError(`Rule for "${action}" needs a current due date, but the record has none.`);
    }
    base = state.nextReview;
  }

  return { mastery: masteryAfter, nextReview: addDays(base, interval) };
}

export function isSameState(a: ReviewState, b: ReviewState): boolean {
  return a.mastery === b.mastery && a.nextReview === b.nextReview;
}

export type Reconciliation = 'apply' | 'already_applied' | 'conflict';

/**
 * Decides what to do with a review request given the record's state right now
 * (`current`) and the state the reviewer was looking at (`expected`).
 *
 * - `apply`: nothing has changed since the card was shown; safe to write.
 * - `already_applied`: the record already holds exactly the result of this
 *   action — an earlier attempt landed even though its response was lost.
 * - `conflict`: the record changed some other way; writing would stack a
 *   second update on top of someone else's, so nothing is written.
 */
export function reconcile(
  action: ReviewAction,
  expected: ReviewState,
  current: ReviewState,
  today: IsoDate,
  rules: ReviewRules,
): Reconciliation {
  if (isSameState(current, expected)) return 'apply';
  if (ruleFor(action, rules) === null) return 'conflict';
  try {
    if (isSameState(current, applyAction(action, expected, today, rules))) return 'already_applied';
  } catch {
    // An unusable expected state cannot prove the action landed.
  }
  return 'conflict';
}
