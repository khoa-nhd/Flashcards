/**
 * Review analytics, computed from saved answers only. The database hands over
 * one row per day and study mode (already limited to answers that still
 * stand); everything here is arithmetic on those rows, with every ratio's
 * denominator spelled out and no percentage offered on too few reviews.
 *
 * Definitions are mirrored for readers in docs/metrics.md.
 */
import { addDays, compareDates, type IsoDate } from './dates.js';

/** One day of reviewing in one study mode, as the database reports it. */
export interface DailyStat {
  day: IsoDate;
  mode: string;
  reviews: number;
  remembered: number;
  notRemembered: number;
  /** Answers to a word that had been reviewed before, and how many of those were remembered. */
  repeatReviews: number;
  repeatRemembered: number;
  /** Total time on the cards that reported one, and how many did. */
  durationMs: number;
  timedReviews: number;
  cards: number;
}

/**
 * Fewer reviews than this and a percentage would be noise, so none is shown.
 * Five is deliberately low: enough to stop "100% (1 of 1)", not a claim of
 * statistical confidence.
 */
export const MIN_SAMPLE = 5;

export interface PeriodStats {
  from: IsoDate;
  to: IsoDate;
  reviews: number;
  remembered: number;
  notRemembered: number;
  /** Accuracy: remembered ÷ all answers in the period. `null` below MIN_SAMPLE answers. */
  accuracy: number | null;
  repeatReviews: number;
  /**
   * Observed retention: remembered ÷ answers, counting only words that had
   * been reviewed before. It leaves out first encounters, which test nothing
   * that was retained. `null` below MIN_SAMPLE such answers. This is what
   * happened, not a prediction.
   */
  retention: number | null;
  durationMs: number;
  timedReviews: number;
  /** Mean time per review, over the reviews that reported a time. `null` when none did. */
  averageMs: number | null;
  /** Days in the period with at least one review. */
  activeDays: number;
}

export interface ModeStats {
  mode: string;
  reviews: number;
  remembered: number;
  accuracy: number | null;
}

export interface DayTotals {
  date: IsoDate;
  reviews: number;
  remembered: number;
  notRemembered: number;
  durationMs: number;
}

export interface ReviewAnalytics {
  today: PeriodStats;
  /** The seven days ending today. */
  week: PeriodStats;
  /** The thirty days ending today. */
  month: PeriodStats;
  streak: {
    /** Consecutive days with a review, ending today, or yesterday if today has none yet. */
    current: number;
    /** The longest run within the loaded window. */
    longest: number;
  };
  /** By study mode over the thirty days ending today. Different modes test different skills and are never merged. */
  byMode: ModeStats[];
  /** Every day of the window, oldest first, with zeros for days without reviews. */
  days: DayTotals[];
  /** The earliest day with a review in the window. */
  firstReviewOn: IsoDate | null;
  /** How many days back the figures above can see. */
  windowDays: number;
}

const ratio = (part: number, whole: number): number | null => (whole >= MIN_SAMPLE ? part / whole : null);

function period(rows: readonly DailyStat[], from: IsoDate, to: IsoDate): PeriodStats {
  const inside = rows.filter((row) => compareDates(row.day, from) >= 0 && compareDates(row.day, to) <= 0);
  const sum = (pick: (row: DailyStat) => number) => inside.reduce((total, row) => total + pick(row), 0);
  const reviews = sum((row) => row.reviews);
  const remembered = sum((row) => row.remembered);
  const repeatReviews = sum((row) => row.repeatReviews);
  const durationMs = sum((row) => row.durationMs);
  const timedReviews = sum((row) => row.timedReviews);
  return {
    from,
    to,
    reviews,
    remembered,
    notRemembered: sum((row) => row.notRemembered),
    accuracy: ratio(remembered, reviews),
    repeatReviews,
    retention: ratio(sum((row) => row.repeatRemembered), repeatReviews),
    durationMs,
    timedReviews,
    averageMs: timedReviews === 0 ? null : durationMs / timedReviews,
    activeDays: new Set(inside.filter((row) => row.reviews > 0).map((row) => row.day)).size,
  };
}

/** `today` is the reviewer's calendar day; `rows` may cover any range and are clipped to the window. */
export function analyseReviews(rows: readonly DailyStat[], today: IsoDate, windowDays = 90): ReviewAnalytics {
  const start = addDays(today, -(windowDays - 1));
  const visible = rows.filter((row) => compareDates(row.day, start) >= 0 && compareDates(row.day, today) <= 0);

  const byDay = new Map<IsoDate, DayTotals>();
  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = addDays(start, offset);
    byDay.set(date, { date, reviews: 0, remembered: 0, notRemembered: 0, durationMs: 0 });
  }
  for (const row of visible) {
    const day = byDay.get(row.day);
    if (!day) continue;
    day.reviews += row.reviews;
    day.remembered += row.remembered;
    day.notRemembered += row.notRemembered;
    day.durationMs += row.durationMs;
  }
  const days = [...byDay.values()];

  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.reviews > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // A streak is still alive on a day that has not had its review yet.
  let current = 0;
  let cursor = (byDay.get(today)?.reviews ?? 0) > 0 ? today : addDays(today, -1);
  while ((byDay.get(cursor)?.reviews ?? 0) > 0) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  const monthStart = addDays(today, -29);
  const modes = new Map<string, { reviews: number; remembered: number }>();
  for (const row of visible) {
    if (compareDates(row.day, monthStart) < 0) continue;
    const mode = modes.get(row.mode) ?? { reviews: 0, remembered: 0 };
    mode.reviews += row.reviews;
    mode.remembered += row.remembered;
    modes.set(row.mode, mode);
  }

  return {
    today: period(visible, today, today),
    week: period(visible, addDays(today, -6), today),
    month: period(visible, monthStart, today),
    streak: { current, longest },
    byMode: [...modes]
      .map(([mode, totals]) => ({ mode, ...totals, accuracy: ratio(totals.remembered, totals.reviews) }))
      .sort((a, b) => b.reviews - a.reviews || a.mode.localeCompare(b.mode)),
    days,
    firstReviewOn: days.find((day) => day.reviews > 0)?.date ?? null,
    windowDays,
  };
}
