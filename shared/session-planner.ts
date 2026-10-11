/**
 * Today's reviewing set against the reviewer's own daily goal. Pure
 * arithmetic on saved figures.
 *
 * A goal is only ever a yardstick. Nothing here chooses, hides, reorders or
 * reschedules a card: the queue stays exactly what the schedule says is due,
 * most overdue first, and words left over when the goal is reached stay due.
 */

/** A daily target. Either part may be left out; both set means both are wanted. */
export interface DailyGoal {
  /** Answers to save in a day. */
  reviews: number | null;
  /** Minutes on cards in a day. */
  minutes: number | null;
}

export const NO_GOAL: DailyGoal = { reviews: null, minutes: null };

/** The same bounds the database checks. */
export const GOAL_LIMITS = { reviews: { min: 1, max: 1000 }, minutes: { min: 1, max: 600 } } as const;

/** The durations offered as one-tap choices. Anything within the limits can be typed instead. */
export const GOAL_MINUTE_PRESETS = [10, 20, 30] as const;

const whole = (value: number, { min, max }: { min: number; max: number }) =>
  Number.isInteger(value) && value >= min && value <= max;

/** Why a goal cannot be stored, or `null` when it can. */
export function goalProblem(goal: DailyGoal): string | null {
  if (goal.reviews !== null && !whole(goal.reviews, GOAL_LIMITS.reviews)) {
    return `A review goal is a whole number from ${GOAL_LIMITS.reviews.min} to ${GOAL_LIMITS.reviews.max}.`;
  }
  if (goal.minutes !== null && !whole(goal.minutes, GOAL_LIMITS.minutes)) {
    return `A time goal is a whole number of minutes from ${GOAL_LIMITS.minutes.min} to ${GOAL_LIMITS.minutes.max}.`;
  }
  return null;
}

export interface PlanInput {
  goal: DailyGoal;
  /** Saved today, from answers that still stand. */
  done: { reviews: number; durationMs: number };
  /** Waiting in the review queue right now. */
  due: { total: number; overdue: number };
  /**
   * The reviewer's own mean time per card, from recent timed answers; `null`
   * when there are too few to go by. Nothing is assumed in its place.
   */
  averageMs: number | null;
}

export interface GoalProgress {
  target: number;
  done: number;
  remaining: number;
  met: boolean;
}

export interface DayPlan {
  goal: DailyGoal;
  done: { reviews: number; durationMs: number };
  due: { total: number; overdue: number };
  averageMs: number | null;
  /** Progress on the review-count part of the goal, when it is set. */
  reviews: GoalProgress | null;
  /** Progress on the time part, in milliseconds, when it is set. */
  time: GoalProgress | null;
  /** Every part that is set has been reached. `null` when no goal is set. */
  met: boolean | null;
  /** How long everything due would take at the reviewer's own pace; `null` when that pace is not known. */
  estimatedDueMs: number | null;
  /**
   * How many more answers reach the goal: the larger of what each part still
   * needs. `null` with no goal, or when a time goal cannot be turned into a
   * number of cards because the reviewer's pace is not known.
   */
  cardsToGoal: number | null;
  /**
   * Due cards beyond what reaching the goal takes. They are not hidden or
   * postponed: this only says the workload is larger than the target.
   */
  beyondGoal: number | null;
}

export function planDay({ goal, done, due, averageMs }: PlanInput): DayPlan {
  const pace = averageMs !== null && averageMs > 0 ? averageMs : null;

  const reviews: GoalProgress | null =
    goal.reviews === null
      ? null
      : {
          target: goal.reviews,
          done: done.reviews,
          remaining: Math.max(0, goal.reviews - done.reviews),
          met: done.reviews >= goal.reviews,
        };

  const targetMs = goal.minutes === null ? null : goal.minutes * 60_000;
  const time: GoalProgress | null =
    targetMs === null
      ? null
      : {
          target: targetMs,
          done: done.durationMs,
          remaining: Math.max(0, targetMs - done.durationMs),
          met: done.durationMs >= targetMs,
        };

  const parts = [reviews, time].filter((part): part is GoalProgress => part !== null);
  const met = parts.length === 0 ? null : parts.every((part) => part.met);

  let cardsToGoal: number | null = null;
  if (parts.length > 0) {
    const forReviews = reviews === null ? 0 : reviews.remaining;
    // A time goal still to be met needs a pace to become a number of cards.
    const forTime = time === null || time.met ? 0 : pace === null ? null : Math.ceil(time.remaining / pace);
    cardsToGoal = forTime === null ? null : Math.max(forReviews, forTime);
  }

  return {
    goal,
    done,
    due,
    averageMs: pace,
    reviews,
    time,
    met,
    estimatedDueMs: pace === null ? null : Math.round(pace * due.total),
    cardsToGoal,
    beyondGoal: cardsToGoal === null ? null : Math.max(0, due.total - cardsToGoal),
  };
}
