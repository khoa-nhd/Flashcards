/**
 * The two daily goals under FSRS alone, and the streak they make. The owner's
 * rules (2026-10-21, docs/fsrs-only-redesign.md):
 *
 * - New words: words added to the vocabulary that day (the owner's rule,
 *   2026-10-22, replacing "brought into study"). Maintenance mode lets it be 0.
 * - Reviews: due words reviewed that day. Met as well once nothing is left to
 *   study today: no word due and no new word waiting (the owner's rule,
 *   2026-10-23: a word added after the reviews ran out reopens the goal).
 * - A day counts towards the streak only when both are met.
 * - The goals never stop a session; they only decide the streak.
 *
 * A day that was met stays met: what was earned is never taken back later the
 * same day, and a changed goal never rewrites an earlier day.
 */
import { addDays, compareDates, type IsoDate } from './dates.js';

export interface StudyGoals {
  newWords: number;
  reviews: number;
  practice: number;
  maintenanceMode: boolean;
}

/** What onboarding suggests. */
export const SUGGESTED_STUDY_GOALS: StudyGoals = { newWords: 10, reviews: 30, practice: 20, maintenanceMode: false };

export const STUDY_GOAL_MAX = 1000;

/** Why a pair of goals cannot be kept, or `null` when it can. */
export function studyGoalsProblem(goals: StudyGoals): string | null {
  const whole = (value: number) => Number.isInteger(value) && value >= 0 && value <= STUDY_GOAL_MAX;
  if (!whole(goals.newWords) || !whole(goals.reviews) || !whole(goals.practice)) return `Each goal is a whole number from 0 to ${STUDY_GOAL_MAX}.`;
  if (goals.newWords === 0 && !goals.maintenanceMode) {
    return 'A new-word goal of 0 needs maintenance mode, for when there is nothing left to add.';
  }
  if (goals.reviews === 0) return 'The review goal must be at least 1.';
  return null;
}

export interface GoalPart {
  target: number;
  done: number;
  remaining: number;
  met: boolean;
  /** Nothing of this kind is left today. */
  exhausted: boolean;
}

export interface DayInput {
  goals: StudyGoals;
  /** Words added today. */
  newDone: number;
  /** Due words reviewed today. */
  reviewsDone: number;
  /** Words still due now. */
  dueLeft: number;
  /** Practice answers done today. */
  practiceDone: number;
  /** New words that can be studied today, never studied yet. Leave it out to count none. */
  newWaiting?: number;
  /** Words never studied yet, archived ones left out. Leave it out where it does not limit the goal. */
  newLeft?: number;
}

export interface DayResult {
  newWords: GoalPart;
  reviews: GoalPart;
  practice: GoalPart;
  met: boolean;
}

export function evaluateDay({ goals, newDone, reviewsDone, dueLeft, practiceDone, newWaiting = 0, newLeft }: DayInput): DayResult {
  const part = (target: number, done: number, met: boolean, exhausted: boolean): GoalPart => ({
    target,
    done,
    remaining: Math.max(0, target - done),
    met,
    exhausted,
  });
  // No new words left does not meet the new-word goal: maintenance mode is the way to a goal of 0.
  const newWords = part(goals.newWords, newDone, newDone >= goals.newWords, newLeft === 0);
  // Nothing left to study today meets the review goal, however few were due. A new word
  // waiting to be studied still leaves something to do, so it keeps the goal open.
  const nothingLeft = dueLeft === 0 && newWaiting === 0;
  const reviews = part(goals.reviews, reviewsDone, reviewsDone >= goals.reviews || nothingLeft, nothingLeft);
  const practice = part(goals.practice, practiceDone, practiceDone >= goals.practice, false);
  return { newWords, reviews, practice, met: newWords.met && reviews.met && practice.met };
}

export interface Streak {
  current: number;
  longest: number;
  metToday: boolean;
}

/**
 * The run of met days. Today only adds to it once met; until then the streak
 * still stands from yesterday, so it is not lost before the day is over.
 */
export function streakOf(metDays: readonly IsoDate[], today: IsoDate, metToday: boolean): Streak {
  const met = new Set(metDays.filter((day) => compareDates(day, today) < 0));
  if (metToday) met.add(today);

  let current = 0;
  for (let day = metToday ? today : addDays(today, -1); met.has(day); day = addDays(day, -1)) current += 1;

  let longest = 0;
  let run = 0;
  let previous: IsoDate | null = null;
  for (const day of [...met].sort(compareDates)) {
    run = previous !== null && addDays(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { current, longest, metToday };
}
