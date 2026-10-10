import { describe, expect, it } from 'vitest';
import { MIN_SAMPLE, analyseReviews, type DailyStat } from '../../shared/analytics.js';

const TODAY = '2026-10-09';

function stat(day: string, overrides: Partial<DailyStat> = {}): DailyStat {
  const reviews = overrides.reviews ?? 10;
  const remembered = overrides.remembered ?? reviews;
  return {
    day,
    mode: 'flashcard',
    reviews,
    remembered,
    notRemembered: reviews - remembered,
    repeatReviews: 0,
    repeatRemembered: 0,
    durationMs: 0,
    timedReviews: 0,
    cards: reviews,
    ...overrides,
  };
}

describe('with no saved reviews', () => {
  const empty = analyseReviews([], TODAY);

  it('reports zeros and offers no percentages', () => {
    for (const period of [empty.today, empty.week, empty.month]) {
      expect(period).toMatchObject({
        reviews: 0,
        remembered: 0,
        notRemembered: 0,
        accuracy: null,
        retention: null,
        averageMs: null,
        activeDays: 0,
      });
    }
    expect(empty.streak).toEqual({ current: 0, longest: 0 });
    expect(empty.byMode).toEqual([]);
    expect(empty.firstReviewOn).toBeNull();
  });

  it('still lists every day of the window, oldest first', () => {
    expect(empty.days).toHaveLength(90);
    expect(empty.days[0]?.date).toBe('2026-07-12');
    expect(empty.days.at(-1)).toEqual({ date: TODAY, reviews: 0, remembered: 0, notRemembered: 0, durationMs: 0 });
  });
});

describe('accuracy', () => {
  it('is remembered ÷ all answers in the period', () => {
    const { today, week } = analyseReviews(
      [stat(TODAY, { reviews: 8, remembered: 6 }), stat('2026-10-08', { reviews: 12, remembered: 3 })],
      TODAY,
    );
    expect(today).toMatchObject({ reviews: 8, remembered: 6, notRemembered: 2, accuracy: 0.75 });
    expect(week).toMatchObject({ reviews: 20, remembered: 9, accuracy: 0.45 });
  });

  it('is withheld below the minimum sample, however good it looks', () => {
    const few = analyseReviews([stat(TODAY, { reviews: MIN_SAMPLE - 1, remembered: MIN_SAMPLE - 1 })], TODAY);
    expect(few.today.reviews).toBe(MIN_SAMPLE - 1);
    expect(few.today.accuracy).toBeNull();
    const enough = analyseReviews([stat(TODAY, { reviews: MIN_SAMPLE, remembered: MIN_SAMPLE })], TODAY);
    expect(enough.today.accuracy).toBe(1);
  });
});

describe('observed retention', () => {
  it('counts only words that had been reviewed before', () => {
    const { week } = analyseReviews(
      [stat(TODAY, { reviews: 20, remembered: 18, repeatReviews: 10, repeatRemembered: 6 })],
      TODAY,
    );
    // Ten first encounters, all remembered, do not flatter the figure.
    expect(week.accuracy).toBe(0.9);
    expect(week.retention).toBe(0.6);
    expect(week.repeatReviews).toBe(10);
  });

  it('is withheld when too few repeat reviews exist, even with many reviews overall', () => {
    const { week } = analyseReviews(
      [stat(TODAY, { reviews: 40, remembered: 40, repeatReviews: 2, repeatRemembered: 2 })],
      TODAY,
    );
    expect(week.accuracy).toBe(1);
    expect(week.retention).toBeNull();
  });
});

describe('time windows', () => {
  const rows = [
    stat('2026-10-09', { reviews: 5 }),
    stat('2026-10-03', { reviews: 7 }),
    stat('2026-10-02', { reviews: 11 }),
    stat('2026-09-10', { reviews: 13 }),
    stat('2026-09-09', { reviews: 17 }),
    stat('2026-07-12', { reviews: 19 }),
    stat('2026-07-11', { reviews: 23 }),
    stat('2026-10-10', { reviews: 29 }),
  ];
  const result = analyseReviews(rows, TODAY);

  it('makes "this week" the seven days ending today', () => {
    expect(result.week).toMatchObject({ from: '2026-10-03', to: TODAY, reviews: 12, activeDays: 2 });
  });

  it('makes "this month" the thirty days ending today', () => {
    expect(result.month).toMatchObject({ from: '2026-09-10', to: TODAY, reviews: 36, activeDays: 4 });
  });

  it('ignores anything before the window or after today', () => {
    expect(result.days[0]).toMatchObject({ date: '2026-07-12', reviews: 19 });
    expect(result.days.reduce((total, day) => total + day.reviews, 0)).toBe(5 + 7 + 11 + 13 + 17 + 19);
    expect(result.firstReviewOn).toBe('2026-07-12');
  });

  it('follows the day it is given, which is the reviewer’s own calendar day', () => {
    // The same rows, for someone for whom it is already the 10th.
    expect(analyseReviews(rows, '2026-10-10').today.reviews).toBe(29);
    expect(analyseReviews(rows, '2026-10-10').week.from).toBe('2026-10-04');
  });
});

describe('time spent', () => {
  it('averages over the reviews that reported a time, not over all of them', () => {
    const { today } = analyseReviews([stat(TODAY, { reviews: 10, durationMs: 40_000, timedReviews: 8 })], TODAY);
    expect(today).toMatchObject({ durationMs: 40_000, timedReviews: 8, averageMs: 5000 });
  });

  it('has no average when no review reported a time', () => {
    expect(analyseReviews([stat(TODAY)], TODAY).today.averageMs).toBeNull();
  });
});

describe('streaks', () => {
  const days = (...list: string[]) => list.map((day) => stat(day));

  it('counts consecutive days ending today', () => {
    expect(analyseReviews(days('2026-10-09', '2026-10-08', '2026-10-07', '2026-10-05'), TODAY).streak).toEqual({
      current: 3,
      longest: 3,
    });
  });

  it('is still alive when today has not been reviewed yet', () => {
    expect(analyseReviews(days('2026-10-08', '2026-10-07'), TODAY).streak.current).toBe(2);
  });

  it('is over after a full day without a review', () => {
    expect(analyseReviews(days('2026-10-07', '2026-10-06', '2026-10-05'), TODAY).streak).toEqual({ current: 0, longest: 3 });
  });

  it('counts a day once however many modes were used on it', () => {
    const rows = [stat(TODAY), stat(TODAY, { mode: 'typing' }), stat('2026-10-08')];
    expect(analyseReviews(rows, TODAY).streak.current).toBe(2);
    expect(analyseReviews(rows, TODAY).week.activeDays).toBe(2);
  });
});

describe('study modes', () => {
  it('are reported separately, busiest first, each with its own accuracy', () => {
    const result = analyseReviews(
      [
        stat(TODAY, { mode: 'flashcard', reviews: 20, remembered: 18 }),
        stat('2026-10-08', { mode: 'flashcard', reviews: 10, remembered: 9 }),
        stat(TODAY, { mode: 'typing', reviews: 10, remembered: 4 }),
        stat(TODAY, { mode: 'cloze', reviews: 2, remembered: 2 }),
      ],
      TODAY,
    );
    expect(result.byMode).toEqual([
      { mode: 'flashcard', reviews: 30, remembered: 27, accuracy: 0.9 },
      { mode: 'typing', reviews: 10, remembered: 4, accuracy: 0.4 },
      { mode: 'cloze', reviews: 2, remembered: 2, accuracy: null },
    ]);
    // The combined figure exists too, but the modes are never folded into one another.
    expect(result.month.accuracy).toBeCloseTo(33 / 42);
  });
});
