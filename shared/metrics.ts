/**
 * Every number shown on the dashboard, insights and calendar pages is computed
 * here, from the same entries the Vocabulary Bank lists. The definitions are
 * documented in docs/metrics.md; keep the two in step.
 *
 * All dates are calendar days in the review time zone. Nothing here reads a
 * clock: `today` is always passed in.
 */
import { addDays, compareDates, isIsoDate, type IsoDate } from './dates.js';
import type { ReviewStatus } from './vocabulary.js';

export interface MetricEntry {
  mastery: number | null;
  dateAdded: IsoDate | null;
  reviewStatus: ReviewStatus;
}

export interface SummaryMetrics {
  /** Every vocabulary record. Always `mastered + learning + invalid`. */
  total: number;
  /** Mastery has reached the completion level (10). */
  mastered: number;
  /** A usable mastery below the completion level. Always the sum of the four states below. */
  learning: number;
  /** Mastery is empty or not a whole number, so the word cannot be scheduled. */
  invalid: number;
  /** Learning, scheduled for exactly today. */
  dueToday: number;
  /** Learning, scheduled before today. Never also counted as due today. */
  overdue: number;
  /** Learning, with no review date. */
  unscheduled: number;
  /** Learning, scheduled after today. */
  upcoming: number;
  /** Date Added is today. */
  addedToday: number;
  /** Date Added falls in the current week, Monday to Sunday. */
  addedThisWeek: number;
  /** Date Added is empty. These are counted in no "added" figure. */
  missingDateAdded: number;
}

/** The Monday on or before `date`. */
export function startOfWeek(date: IsoDate): IsoDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

/** Shifts a `YYYY-MM` month by whole months. */
export function addMonths(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return shifted.toISOString().slice(0, 7);
}

export function computeSummary(entries: readonly MetricEntry[], today: IsoDate): SummaryMetrics {
  const summary: SummaryMetrics = {
    total: entries.length,
    mastered: 0,
    learning: 0,
    invalid: 0,
    dueToday: 0,
    overdue: 0,
    unscheduled: 0,
    upcoming: 0,
    addedToday: 0,
    addedThisWeek: 0,
    missingDateAdded: 0,
  };
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);

  for (const entry of entries) {
    switch (entry.reviewStatus) {
      case 'mastered':
        summary.mastered += 1;
        break;
      case 'invalid':
        summary.invalid += 1;
        break;
      case 'due_today':
        summary.dueToday += 1;
        break;
      case 'overdue':
        summary.overdue += 1;
        break;
      case 'unscheduled':
        summary.unscheduled += 1;
        break;
      case 'upcoming':
        summary.upcoming += 1;
        break;
    }

    if (entry.dateAdded === null || !isIsoDate(entry.dateAdded)) {
      summary.missingDateAdded += 1;
    } else {
      if (entry.dateAdded === today) summary.addedToday += 1;
      if (compareDates(entry.dateAdded, weekStart) >= 0 && compareDates(entry.dateAdded, weekEnd) <= 0) {
        summary.addedThisWeek += 1;
      }
    }
  }

  summary.learning = summary.dueToday + summary.overdue + summary.unscheduled + summary.upcoming;
  return summary;
}

export interface MasteryBucket {
  mastery: number;
  count: number;
}

/** One bucket per mastery level from 0 to `max`, plus how many entries fit none of them. */
export function masteryDistribution(
  entries: readonly MetricEntry[],
  max = 10,
): { buckets: MasteryBucket[]; other: number } {
  const buckets: MasteryBucket[] = Array.from({ length: max + 1 }, (_, mastery) => ({ mastery, count: 0 }));
  let other = 0;
  for (const entry of entries) {
    const bucket = entry.mastery !== null && Number.isInteger(entry.mastery) ? buckets[entry.mastery] : undefined;
    if (bucket) bucket.count += 1;
    else other += 1;
  }
  return { buckets, other };
}

/** How many words carry each Date Added. Entries without a valid date are left out. */
export function countByDateAdded(entries: readonly MetricEntry[]): Map<IsoDate, number> {
  const counts = new Map<IsoDate, number>();
  for (const entry of entries) {
    if (entry.dateAdded === null || !isIsoDate(entry.dateAdded)) continue;
    counts.set(entry.dateAdded, (counts.get(entry.dateAdded) ?? 0) + 1);
  }
  return counts;
}

export interface PeriodCount {
  /** First day of the period. */
  start: IsoDate;
  /** Last day of the period. */
  end: IsoDate;
  count: number;
}

export type Granularity = 'day' | 'week' | 'month';

/**
 * Words added per day, week (Monday to Sunday) or calendar month, for the
 * `periods` most recent periods ending with the one that contains `today`.
 * Periods with no additions are present with a count of zero, so a gap in the
 * chart always means "nothing was added", never "no data".
 */
export function additionsByPeriod(
  entries: readonly MetricEntry[],
  granularity: Granularity,
  periods: number,
  today: IsoDate,
): PeriodCount[] {
  const counts = countByDateAdded(entries);
  const result: PeriodCount[] = [];

  for (let back = periods - 1; back >= 0; back -= 1) {
    let start: IsoDate;
    let end: IsoDate;
    if (granularity === 'day') {
      start = addDays(today, -back);
      end = start;
    } else if (granularity === 'week') {
      start = addDays(startOfWeek(today), -7 * back);
      end = addDays(start, 6);
    } else {
      const month = addMonths(today.slice(0, 7), -back);
      start = `${month}-01`;
      end = addDays(`${addMonths(month, 1)}-01`, -1);
    }
    let count = 0;
    for (const [date, added] of counts) {
      if (compareDates(date, start) >= 0 && compareDates(date, end) <= 0) count += added;
    }
    result.push({ start, end, count });
  }
  return result;
}

/** The days on which the most words were added, most first; ties go to the more recent day. */
export function busiestDays(entries: readonly MetricEntry[], limit: number): Array<{ date: IsoDate; count: number }> {
  return [...countByDateAdded(entries)]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.count - a.count || compareDates(b.date, a.date))
    .slice(0, limit);
}

export interface CalendarDay {
  date: IsoDate;
  /** False for the leading and trailing days that belong to neighbouring months. */
  inMonth: boolean;
}

/** The weeks (Monday first) needed to show a `YYYY-MM` month in full. */
export function monthGrid(month: string): CalendarDay[][] {
  const first: IsoDate = `${month}-01`;
  const last = addDays(`${addMonths(month, 1)}-01`, -1);
  const weeks: CalendarDay[][] = [];
  let cursor = startOfWeek(first);
  while (compareDates(cursor, last) <= 0) {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push({ date: cursor, inMonth: cursor.slice(0, 7) === month });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** Whether a string is a real `YYYY-MM` month. */
export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
