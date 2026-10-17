/**
 * How a word earns its way out of the weak list again: the recovery rule.
 *
 * The list itself is unchanged. On top of it, a word is "recovering" while it
 * keeps being remembered: each day it earns at most one point, a day the
 * reviewer just got wrong takes a point back, and once the word has enough
 * points it has recovered and its old failures no longer count against it.
 *
 * The evidence is deliberately wide: a scheduled review, a weak-word review
 * taken with counting off, and any practice mode all count. A self-graded
 * answer is worth half a point, so a day of two self-graded remembers is one
 * point. Nothing is guessed: a word with no answers has no points.
 *
 * This module is pure: the same days always give the same recovery.
 */
import { addDays, compareDates, daysBetween, type IsoDate } from './dates.js';
import type { CardHistory, Severity } from './weak-words.js';

/** How far back a point stays valid. */
export const WEAK_RECOVERY_WINDOW_DAYS = 30;
/** How far back a remembered answer keeps the word's age from counting. */
export const WEAK_RECOVERY_FORGIVE_OVERDUE_DAYS = 7;
/** Points a word needs, by how heavy it is: a High word needs one more. */
export const WEAK_RECOVERY_THRESHOLD: Record<Severity, number> = { high: 4, medium: 3, low: 3 };

/** One day of one word's answers, review and practice together. */
export interface WeakWordDayRow {
  vocabularyId: string;
  day: IsoDate;
  /** Scheduled reviews answered that day. */
  reviewAnswers: number;
  /** Scheduled reviews answered "Not remember" that day. */
  reviewFails: number;
  /** Practice answers that day. */
  practiceAnswers: number;
  /** Practice answers wrong that day. */
  practiceFails: number;
  /** Correct answers' weight that day, capped at one: 1 for an auto-graded answer, 0.5 for self-graded. */
  dayPoints: number;
  /** The last answer of the day: 'remember' or 'not_remember'. */
  lastAction: 'remember' | 'not_remember' | null;
}

export interface RecoveryOptions {
  /** How heavy the word is when its current cycle begins: High needs one more point. */
  severity: Severity;
  /** The reviewer's today, for the overdue-forgiveness window. */
  today: IsoDate;
}

export interface RecoveryProgress {
  /** Points in the current cycle, after fails and after points have expired. */
  points: number;
  /** Points this word needs; `0` while it has no cycle of its own yet. */
  threshold: number;
  /** True when the word graduated and has not slipped since. */
  recovered: boolean;
  /** The day the word last graduated, or `null` if it never has. */
  lastGraduatedOn: IsoDate | null;
  /** The last day it was remembered, review or practice. */
  lastRememberedOn: IsoDate | null;
  /** The last day it was forgotten, review or practice. */
  lastFailedOn: IsoDate | null;
  /** The last answer, as the weak list reads it. */
  lastAction: 'remember' | 'not_remember' | null;
  /** True when the last answer was a remembered one inside the forgiveness window. */
  forgivesOverdue: boolean;
}

/**
 * Walks the days oldest first and returns the word's recovery. Points are
 * kept as the days they came from, so a fail takes the oldest point back and a
 * point older than the window drops off on its own.
 */
export function computeRecovery(days: readonly WeakWordDayRow[], options: RecoveryOptions): RecoveryProgress {
  const threshold = WEAK_RECOVERY_THRESHOLD[options.severity];
  const ordered = [...days].sort((a, b) => compareDates(a.day, b.day));

  const pointDays: IsoDate[] = [];
  let lastGraduatedOn: IsoDate | null = null;
  let failedSinceGraduation = false;
  let lastRememberedOn: IsoDate | null = null;
  let lastFailedOn: IsoDate | null = null;
  let lastAction: 'remember' | 'not_remember' | null = null;

  for (const row of ordered) {
    // A point is good for the window from the day it was earned.
    while (pointDays.length > 0) {
      const oldest = pointDays[0];
      if (oldest === undefined || daysBetween(oldest, row.day) < WEAK_RECOVERY_WINDOW_DAYS) break;
      pointDays.shift();
    }
    if (row.dayPoints >= 1) pointDays.push(row.day);

    const fails = row.reviewFails + row.practiceFails;
    for (let index = 0; index < fails; index += 1) {
      pointDays.shift();
      failedSinceGraduation = true;
    }

    const remembered = row.dayPoints > 0;
    if (remembered) lastRememberedOn = row.day;
    if (fails > 0) lastFailedOn = row.day;
    if (row.lastAction !== null) lastAction = row.lastAction;

    if (pointDays.length >= threshold) {
      lastGraduatedOn = row.day;
      pointDays.length = 0;
      failedSinceGraduation = false;
    }
  }

  const recovered = lastGraduatedOn !== null && pointDays.length === 0 && !failedSinceGraduation;
  const forgivesOverdue =
    lastAction === 'remember' &&
    lastRememberedOn !== null &&
    daysBetween(lastRememberedOn, options.today) < WEAK_RECOVERY_FORGIVE_OVERDUE_DAYS;

  return {
    points: pointDays.length,
    threshold,
    recovered,
    lastGraduatedOn,
    lastRememberedOn,
    lastFailedOn,
    lastAction,
    forgivesOverdue,
  };
}

/**
 * The weak-list history of one word, built from its days. Practice is counted
 * in the recent window (and in the last answer), while only scheduled reviews
 * make a "forgotten day"; once the word has graduated, its old failures are
 * gone, so a slip after that starts the list fresh.
 */
export function cardHistoryFromDays(
  days: readonly WeakWordDayRow[],
  options: { since: IsoDate; lastGraduatedOn: IsoDate | null },
): CardHistory {
  let reviews = 0;
  let failures = 0;
  let recentReviews = 0;
  let recentFailures = 0;
  let failedDays = 0;
  let lastReviewedOn: IsoDate | null = null;
  let lastFailedOn: IsoDate | null = null;
  let lastAction: 'remember' | 'not_remember' | null = null;

  for (const row of [...days].sort((a, b) => compareDates(a.day, b.day))) {
    // Once the word has graduated, everything before that is gone: a slip after
    // it starts the list fresh rather than carrying the old failures with it.
    if (options.lastGraduatedOn !== null && compareDates(row.day, options.lastGraduatedOn) <= 0) continue;
    reviews += row.reviewAnswers;
    failures += row.reviewFails;
    if (compareDates(row.day, options.since) >= 0) {
      recentReviews += row.reviewAnswers + row.practiceAnswers;
      recentFailures += row.reviewFails + row.practiceFails;
    }
    if (row.reviewFails > 0) failedDays += 1;
    lastReviewedOn = row.day;
    if (row.reviewFails + row.practiceFails > 0) lastFailedOn = row.day;
    if (row.lastAction !== null) lastAction = row.lastAction;
  }

  return { reviews, failures, recentReviews, recentFailures, failedDays, lastReviewedOn, lastFailedOn, lastAction };
}

/** The day that starts the window of answers a point may come from. */
export function recoveryWindowStart(today: IsoDate): IsoDate {
  return addDays(today, -(WEAK_RECOVERY_WINDOW_DAYS - 1));
}
