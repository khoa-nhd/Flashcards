/**
 * Which schedule is in charge of when a word is next due.
 *
 * Every saved answer moves two schedules, each in its own place: the mastery
 * schedule (mastery and a review date) and an FSRS state. Only one of them
 * decides what is due, and an account chooses which. Because both are always
 * kept up to date, changing the choice converts nothing and loses nothing.
 *
 * Mastery itself is not part of the choice: it counts the same way and retires
 * a word at the same level whichever schedule is in charge.
 */
import { calendarDateInTimeZone, type IsoDate } from '../dates.js';

export const SCHEDULERS = ['mastery_v1', 'fsrs'] as const;
export type SchedulerId = (typeof SCHEDULERS)[number];

/** What every account starts with, and what stays in charge until it opts in to something else. */
export const DEFAULT_SCHEDULER: SchedulerId = 'mastery_v1';

export const SCHEDULER_NAMES: Record<SchedulerId, string> = {
  mastery_v1: 'Mastery schedule',
  fsrs: 'FSRS',
};

export function isSchedulerId(value: unknown): value is SchedulerId {
  return typeof value === 'string' && (SCHEDULERS as readonly string[]).includes(value);
}

/** The two dates a word carries: its mastery review date, and the instant FSRS has it due (if FSRS has seen it). */
export interface ScheduledWord {
  reviewDate: IsoDate | null;
  /** An ISO timestamp, or empty for a word that has not been answered since FSRS started being calculated. */
  fsrsDue?: string | null;
}

/**
 * Whether FSRS is what decides this word. A word FSRS has never seen has no
 * state and none is made up for it: it stays on its mastery date until its
 * first answer gives it one.
 */
export function isScheduledByFsrs(scheduler: SchedulerId, word: ScheduledWord): boolean {
  return scheduler === 'fsrs' && typeof word.fsrsDue === 'string' && !Number.isNaN(Date.parse(word.fsrsDue));
}

/**
 * The day a word is next due under the schedule in charge, in the reviewer's
 * time zone. An FSRS due time counts for the whole of the calendar day it
 * falls on, the way a mastery review date does.
 */
export function dueDateUnder(scheduler: SchedulerId, word: ScheduledWord, timeZone: string): IsoDate | null {
  return isScheduledByFsrs(scheduler, word)
    ? calendarDateInTimeZone(new Date(word.fsrsDue as string), timeZone)
    : word.reviewDate;
}
