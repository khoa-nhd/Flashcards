import { describe, expect, it } from 'vitest';
import {
  addMonths,
  additionsByPeriod,
  busiestDays,
  computeSummary,
  countByDateAdded,
  isMonth,
  masteryDistribution,
  monthGrid,
  startOfWeek,
  strengthDistribution,
  type MetricEntry,
} from '../../shared/metrics.js';
import type { ReviewStatus } from '../../shared/vocabulary.js';

// Friday 9 October 2026. Its week runs Monday 5 to Sunday 11.
const TODAY = '2026-10-09';

const entry = (reviewStatus: ReviewStatus, dateAdded: string | null = '2026-09-01', mastery: number | null = 3): MetricEntry => ({
  reviewStatus,
  dateAdded,
  mastery,
});

describe('computeSummary', () => {
  const entries: MetricEntry[] = [
    entry('mastered', '2026-08-01', 10),
    entry('mastered', '2026-08-02', 10),
    entry('due_today', TODAY, 1),
    entry('due_today', '2026-10-05', 2),
    entry('overdue', '2026-10-04', 3),
    entry('unscheduled', '2026-10-11', 1),
    entry('upcoming', '2026-10-12', 4),
    entry('upcoming', null, 5),
    entry('invalid', '2026-09-15', null),
  ];
  const summary = computeSummary(entries, TODAY);

  it('counts the total, mastered and learning words', () => {
    expect(summary.total).toBe(9);
    expect(summary.mastered).toBe(2);
    expect(summary.learning).toBe(6);
    expect(summary.invalid).toBe(1);
  });

  it('splits learning words into four states that never overlap', () => {
    expect(summary).toMatchObject({ dueToday: 2, overdue: 1, unscheduled: 1, upcoming: 2 });
    expect(summary.dueToday + summary.overdue + summary.unscheduled + summary.upcoming).toBe(summary.learning);
    expect(summary.mastered + summary.learning + summary.new + summary.suspended + summary.invalid).toBe(summary.total);
  });

  it('never counts a mastered word as pending review', () => {
    const allMastered = computeSummary([entry('mastered', TODAY, 10), entry('mastered', TODAY, 10)], TODAY);
    expect(allMastered).toMatchObject({ mastered: 2, learning: 0, dueToday: 0, overdue: 0, upcoming: 0 });
  });

  it('counts words added today', () => {
    expect(summary.addedToday).toBe(1);
  });

  it('counts words added in the current Monday-to-Sunday week, including its ends', () => {
    // 5 Oct (Monday), 9 Oct (today) and 11 Oct (Sunday) are in; 4 Oct and 12 Oct are not.
    expect(summary.addedThisWeek).toBe(3);
  });

  it('reports words without a Date Added instead of dating them', () => {
    expect(summary.missingDateAdded).toBe(1);
    const undated = computeSummary([entry('upcoming', null)], TODAY);
    expect(undated).toMatchObject({ total: 1, addedToday: 0, addedThisWeek: 0, missingDateAdded: 1 });
  });

  it('treats an invalid Date Added as missing', () => {
    expect(computeSummary([entry('upcoming', 'yesterday')], TODAY).missingDateAdded).toBe(1);
  });

  it('is all zeros for an empty vocabulary', () => {
    expect(computeSummary([], TODAY)).toEqual({
      total: 0,
      mastered: 0,
      learning: 0,
      invalid: 0,
      new: 0,
      suspended: 0,
      dueToday: 0,
      overdue: 0,
      unscheduled: 0,
      upcoming: 0,
      addedToday: 0,
      addedThisWeek: 0,
      missingDateAdded: 0,
    });
  });
});

describe('startOfWeek', () => {
  it('returns the Monday on or before a date', () => {
    expect(startOfWeek('2026-10-09')).toBe('2026-10-05'); // Friday
    expect(startOfWeek('2026-10-05')).toBe('2026-10-05'); // Monday
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05'); // Sunday
    expect(startOfWeek('2026-10-12')).toBe('2026-10-12'); // next Monday
    expect(startOfWeek('2027-01-01')).toBe('2026-12-28'); // across a year end
  });
});

describe('masteryDistribution', () => {
  it('has a bucket for every level from 0 to 10, including empty ones', () => {
    const { buckets, other } = masteryDistribution([
      entry('upcoming', null, 0),
      entry('upcoming', null, 3),
      entry('upcoming', null, 3),
      entry('mastered', null, 10),
    ]);
    expect(buckets.map((bucket) => bucket.count)).toEqual([1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1]);
    expect(buckets.map((bucket) => bucket.mastery)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(other).toBe(0);
  });

  it('counts unusable masteries separately rather than as zero', () => {
    const { buckets, other } = masteryDistribution([
      entry('invalid', null, null),
      entry('invalid', null, 2.5),
      entry('invalid', null, 12),
      entry('invalid', null, -1),
    ]);
    expect(buckets.every((bucket) => bucket.count === 0)).toBe(true);
    expect(other).toBe(4);
  });
});

describe('additionsByPeriod', () => {
  const entries = [
    entry('upcoming', '2026-10-09'),
    entry('upcoming', '2026-10-09'),
    entry('upcoming', '2026-10-07'),
    entry('upcoming', '2026-10-04'),
    entry('upcoming', '2026-09-30'),
    entry('upcoming', '2026-08-15'),
    entry('upcoming', null),
  ];

  it('counts per day, with explicit zeros for days without additions', () => {
    expect(additionsByPeriod(entries, 'day', 4, TODAY)).toEqual([
      { start: '2026-10-06', end: '2026-10-06', count: 0 },
      { start: '2026-10-07', end: '2026-10-07', count: 1 },
      { start: '2026-10-08', end: '2026-10-08', count: 0 },
      { start: '2026-10-09', end: '2026-10-09', count: 2 },
    ]);
  });

  it('counts per Monday-to-Sunday week', () => {
    expect(additionsByPeriod(entries, 'week', 3, TODAY)).toEqual([
      { start: '2026-09-21', end: '2026-09-27', count: 0 },
      { start: '2026-09-28', end: '2026-10-04', count: 2 },
      { start: '2026-10-05', end: '2026-10-11', count: 3 },
    ]);
  });

  it('counts per calendar month', () => {
    expect(additionsByPeriod(entries, 'month', 3, TODAY)).toEqual([
      { start: '2026-08-01', end: '2026-08-31', count: 1 },
      { start: '2026-09-01', end: '2026-09-30', count: 1 },
      { start: '2026-10-01', end: '2026-10-31', count: 4 },
    ]);
  });

  it('handles February in a leap year and a year boundary', () => {
    const feb = additionsByPeriod([entry('upcoming', '2028-02-29')], 'month', 2, '2028-03-10');
    expect(feb[0]).toEqual({ start: '2028-02-01', end: '2028-02-29', count: 1 });
    const january = additionsByPeriod([entry('upcoming', '2026-12-31')], 'month', 2, '2027-01-05');
    expect(january).toEqual([
      { start: '2026-12-01', end: '2026-12-31', count: 1 },
      { start: '2027-01-01', end: '2027-01-31', count: 0 },
    ]);
  });

  it('leaves out words without a Date Added', () => {
    const total = additionsByPeriod(entries, 'month', 12, TODAY).reduce((sum, period) => sum + period.count, 0);
    expect(total).toBe(6);
  });
});

describe('countByDateAdded and busiestDays', () => {
  const entries = [
    entry('upcoming', '2026-10-09'),
    entry('upcoming', '2026-10-09'),
    entry('upcoming', '2026-10-07'),
    entry('upcoming', '2026-10-01'),
    entry('upcoming', '2026-10-01'),
    entry('upcoming', null),
  ];

  it('counts words per date', () => {
    expect(Object.fromEntries(countByDateAdded(entries))).toEqual({
      '2026-10-09': 2,
      '2026-10-07': 1,
      '2026-10-01': 2,
    });
  });

  it('ranks days by additions, the more recent first on a tie', () => {
    expect(busiestDays(entries, 2)).toEqual([
      { date: '2026-10-09', count: 2 },
      { date: '2026-10-01', count: 2 },
    ]);
    expect(busiestDays([], 5)).toEqual([]);
  });
});

describe('monthGrid', () => {
  const flat = (month: string) => monthGrid(month).flat();

  it('starts each week on Monday and covers the whole month', () => {
    const weeks = monthGrid('2026-10'); // 1 October 2026 is a Thursday
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]?.[0]).toEqual({ date: '2026-09-28', inMonth: false });
    expect(weeks[0]?.[3]).toEqual({ date: '2026-10-01', inMonth: true });
    expect(weeks[4]?.[6]).toEqual({ date: '2026-11-01', inMonth: false });
    expect(flat('2026-10').filter((day) => day.inMonth)).toHaveLength(31);
  });

  it('gives February 29 days in a leap year and 28 otherwise', () => {
    expect(flat('2028-02').filter((day) => day.inMonth)).toHaveLength(29);
    expect(flat('2026-02').filter((day) => day.inMonth)).toHaveLength(28);
    expect(flat('2028-02').some((day) => day.date === '2028-02-29' && day.inMonth)).toBe(true);
  });

  it('fits a month that starts on Monday in four or five weeks without padding in front', () => {
    const weeks = monthGrid('2027-02'); // 1 February 2027 is a Monday, 28 days
    expect(weeks).toHaveLength(4);
    expect(weeks[0]?.[0]).toEqual({ date: '2027-02-01', inMonth: true });
  });

  it('needs six weeks for a long month starting late in the week', () => {
    expect(monthGrid('2026-08')).toHaveLength(6); // 1 August 2026 is a Saturday
  });
});

describe('month helpers', () => {
  it('shifts months across year ends', () => {
    expect(addMonths('2026-10', 1)).toBe('2026-11');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', -14)).toBe('2025-08');
  });

  it('recognises valid months only', () => {
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
    expect(isMonth('october')).toBe(false);
    expect(isMonth(null)).toBe(false);
  });
});

describe('under FSRS alone', () => {
  const fsrs = (reviewStatus: ReviewStatus, level: number, suspended = false): MetricEntry => ({
    reviewStatus,
    dateAdded: '2026-09-01',
    mastery: level,
    memory: { level },
    suspended,
  });
  const entries = [
    fsrs('new', 1),
    fsrs('new', 1),
    fsrs('due_today', 3),
    fsrs('overdue', 6),
    fsrs('upcoming', 10),
    fsrs('upcoming', 8),
    fsrs('suspended', 9, true),
  ];

  it('counts new and archived words apart, and every word exactly once', () => {
    const summary = computeSummary(entries, TODAY);
    expect(summary).toMatchObject({ total: 7, new: 2, suspended: 1, mastered: 0, learning: 4, dueToday: 1, overdue: 1, upcoming: 2 });
    expect(summary.mastered + summary.learning + summary.new + summary.suspended + summary.invalid).toBe(summary.total);
  });

  it('spreads the words over the ten strength levels and five bands, leaving archived ones out', () => {
    const { levels, bands } = strengthDistribution(entries);
    expect(levels.map((item) => item.count)).toEqual([2, 0, 1, 0, 0, 1, 0, 1, 0, 1]);
    expect(bands).toEqual([
      { band: 'New', count: 2 },
      { band: 'Learning', count: 1 },
      { band: 'Familiar', count: 0 },
      { band: 'Strong', count: 2 },
      { band: 'Master', count: 1 },
    ]);
  });

  it('skips a word with no usable strength', () => {
    const { levels } = strengthDistribution([{ reviewStatus: 'new', dateAdded: null, mastery: null }]);
    expect(levels.every((item) => item.count === 0)).toBe(true);
  });
});
