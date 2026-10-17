import { describe, expect, it } from 'vitest';
import {
  WEAK_RECOVERY_THRESHOLD,
  WEAK_RECOVERY_WINDOW_DAYS,
  cardHistoryFromDays,
  computeRecovery,
  recoveryWindowStart,
  type WeakWordDayRow,
} from '../../shared/weak-recovery.js';

const TODAY = '2026-10-09';

const day = (value: string, overrides: Partial<WeakWordDayRow> = {}): WeakWordDayRow => ({
  vocabularyId: 'word-1',
  day: value,
  reviewAnswers: 0,
  reviewFails: 0,
  practiceAnswers: 0,
  practiceFails: 0,
  dayPoints: 0,
  lastAction: null,
  ...overrides,
});

const days = (rows: readonly WeakWordDayRow[]) => computeRecovery(rows, { severity: 'medium', today: TODAY });

describe('points', () => {
  it('gives no points to a word with no answers', () => {
    expect(days([])).toMatchObject({ points: 0, threshold: 3, recovered: false });
  });

  it('gives one point for a day with one auto-graded remember', () => {
    expect(days([day('2026-10-06', { dayPoints: 1, lastAction: 'remember' })])).toMatchObject({ points: 1 });
  });

  it('needs two self-graded remembers to make a point', () => {
    expect(days([day('2026-10-06', { dayPoints: 0.5, lastAction: 'remember' })])).toMatchObject({ points: 0 });
    expect(days([day('2026-10-06', { dayPoints: 1, lastAction: 'remember' })])).toMatchObject({ points: 1 });
  });

  it('needs one more point when the word is High', () => {
    const result = computeRecovery(
      [1, 2, 3].map((offset) => day(`2026-10-0${offset}`, { dayPoints: 1, lastAction: 'remember' })),
      { severity: 'high', today: TODAY },
    );
    expect(result).toMatchObject({ points: 3, threshold: 4, recovered: false });
    expect(WEAK_RECOVERY_THRESHOLD).toEqual({ high: 4, medium: 3, low: 3 });
  });
});

describe('a forgotten answer', () => {
  it('takes the oldest point back', () => {
    const result = days([
      day('2026-10-06', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-07', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-08', { practiceFails: 1, lastAction: 'not_remember' }),
    ]);
    expect(result).toMatchObject({ points: 1, lastFailedOn: '2026-10-08' });
  });

  it('takes back a point earned the same day', () => {
    const result = days([day('2026-10-06', { dayPoints: 1, reviewFails: 1, lastAction: 'not_remember' })]);
    expect(result).toMatchObject({ points: 0 });
  });

  it('never goes below zero', () => {
    const result = days([day('2026-10-06', { reviewFails: 3, lastAction: 'not_remember' })]);
    expect(result).toMatchObject({ points: 0 });
  });
});

describe('graduation and the clean slate', () => {
  it('graduates at three points and starts again from nothing', () => {
    const result = days([
      day('2026-10-06', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-07', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-08', { dayPoints: 1, lastAction: 'remember' }),
    ]);
    expect(result).toMatchObject({ points: 0, recovered: true, lastGraduatedOn: '2026-10-08' });
  });

  it('is not recovered when it slipped after graduating', () => {
    const result = days([
      day('2026-10-06', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-07', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-08', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-09', { reviewFails: 1, lastAction: 'not_remember' }),
    ]);
    expect(result).toMatchObject({ points: 0, recovered: false, lastGraduatedOn: '2026-10-08' });
  });

  it('keeps the most recent graduation and starts a new cycle', () => {
    const result = days([
      day('2026-10-01', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-02', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-03', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-04', { reviewFails: 1, lastAction: 'not_remember' }),
      day('2026-10-05', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-06', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-07', { dayPoints: 1, lastAction: 'remember' }),
    ]);
    expect(result).toMatchObject({ points: 0, recovered: true, lastGraduatedOn: '2026-10-07' });
  });
});

describe('the window', () => {
  it('drops a point that is older than the window', () => {
    const result = days([
      day('2026-09-08', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-08', { dayPoints: 1, lastAction: 'remember' }),
    ]);
    expect(result).toMatchObject({ points: 1 });
    expect(WEAK_RECOVERY_WINDOW_DAYS).toBe(30);
  });

  it('starts the window on the day it began', () => {
    expect(recoveryWindowStart(TODAY)).toBe('2026-09-10');
  });
});

describe('overdue forgiveness', () => {
  it('forgives the word when it was remembered inside the week', () => {
    const result = days([day('2026-10-07', { dayPoints: 1, lastAction: 'remember' })]);
    expect(result.forgivesOverdue).toBe(true);
  });

  it('does not forgive it when the last answer was a forget', () => {
    const result = days([
      day('2026-10-07', { dayPoints: 1, lastAction: 'remember' }),
      day('2026-10-08', { reviewFails: 1, lastAction: 'not_remember' }),
    ]);
    expect(result.forgivesOverdue).toBe(false);
  });

  it('does not forgive a remember from more than a week ago', () => {
    const result = days([day('2026-10-01', { dayPoints: 1, lastAction: 'remember' })]);
    expect(result.forgivesOverdue).toBe(false);
  });
});

describe('the weak-list history built from days', () => {
  const since = recoveryWindowStart(TODAY);

  it('counts practice in the recent window and keeps forgotten days to reviews', () => {
    const rows = [
      day('2026-10-06', { reviewAnswers: 1, reviewFails: 1, lastAction: 'not_remember' }),
      day('2026-10-07', { practiceAnswers: 2, practiceFails: 1, lastAction: 'not_remember' }),
      day('2026-10-08', { practiceAnswers: 1, lastAction: 'remember' }),
    ];
    const history = cardHistoryFromDays(rows, { since, lastGraduatedOn: null });
    expect(history).toMatchObject({
      reviews: 1,
      failures: 1,
      recentReviews: 4,
      recentFailures: 2,
      failedDays: 1,
      lastAction: 'remember',
      lastReviewedOn: '2026-10-08',
      lastFailedOn: '2026-10-07',
    });
  });

  it('forgets failures from before the last graduation', () => {
    const rows = [
      day('2026-10-01', { reviewFails: 1, lastAction: 'not_remember' }),
      day('2026-10-02', { reviewFails: 1, lastAction: 'not_remember' }),
      day('2026-10-06', { reviewFails: 1, lastAction: 'not_remember' }),
    ];
    const history = cardHistoryFromDays(rows, { since, lastGraduatedOn: '2026-10-05' });
    expect(history.failedDays).toBe(1);
  });

  it('has no history for a word with no answers', () => {
    expect(cardHistoryFromDays([], { since, lastGraduatedOn: null })).toEqual({
      reviews: 0,
      failures: 0,
      recentReviews: 0,
      recentFailures: 0,
      failedDays: 0,
      lastReviewedOn: null,
      lastFailedOn: null,
      lastAction: null,
    });
  });
});
