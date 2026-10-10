import { describe, expect, it } from 'vitest';
import { compareSchedules, type ScheduleCard } from '../../shared/scheduler/comparison.js';
import type { FsrsState } from '../../shared/scheduler/fsrs.js';

const TODAY = '2026-10-09';
const ZONE = 'Asia/Ho_Chi_Minh';

/** An FSRS state due at noon local time on `day`. */
const dueOn = (day: string, scheduledDays = 5): FsrsState => ({
  due: `${day}T05:00:00.000Z`,
  stability: 4,
  difficulty: 5,
  scheduledDays,
  learningSteps: 0,
  reps: 2,
  lapses: 0,
  state: 2,
  lastReview: '2026-10-01T05:00:00.000Z',
});

const card = (n: number, overrides: Partial<ScheduleCard> = {}): ScheduleCard => ({
  id: `id-${n}`,
  word: `word-${n}`,
  mastery: 3,
  reviewDate: TODAY,
  fsrs: null,
  ...overrides,
});

const compare = (cards: ScheduleCard[], days = 5) => compareSchedules(cards, TODAY, ZONE, { retiredAtMastery: 10, days });

describe('compareSchedules', () => {
  it('leaves out words FSRS has not seen instead of guessing a date for them', () => {
    const result = compare([card(1), card(2, { fsrs: dueOn('2026-10-11') })]);
    expect(result).toMatchObject({ totalCards: 2, comparable: 1 });
    expect(result.cards.map((item) => item.id)).toEqual(['id-2']);
    expect(result.workload.reduce((total, day) => total + day.legacy + day.fsrs, 0)).toBe(2);
  });

  it('reports each schedule’s day and how far apart they are', () => {
    const [later, sooner] = compare([
      card(1, { reviewDate: '2026-10-10', fsrs: dueOn('2026-10-13', 7) }),
      card(2, { reviewDate: '2026-10-12', fsrs: dueOn('2026-10-10', 2) }),
    ]).cards.sort((a, b) => a.id.localeCompare(b.id));
    expect(later).toMatchObject({ legacyDue: '2026-10-10', fsrsDue: '2026-10-13', fsrsIntervalDays: 7, differenceDays: 3 });
    expect(sooner).toMatchObject({ legacyDue: '2026-10-12', fsrsDue: '2026-10-10', differenceDays: -2 });
  });

  it('reads the FSRS day in the reviewer’s time zone', () => {
    // 18:00 UTC on the 10th is already the 11th in Vietnam.
    const state = { ...dueOn('2026-10-10'), due: '2026-10-10T18:00:00.000Z' };
    expect(compare([card(1, { fsrs: state })]).cards[0]?.fsrsDue).toBe('2026-10-11');
    expect(compareSchedules([card(1, { fsrs: state })], TODAY, 'UTC', { retiredAtMastery: 10 }).cards[0]?.fsrsDue).toBe('2026-10-10');
  });

  it('treats a word with no review date as due now, and a mastered word as never due again', () => {
    const [undated, mastered] = compare([
      card(1, { reviewDate: null, fsrs: dueOn('2026-10-12') }),
      card(2, { mastery: 10, reviewDate: '2026-10-01', fsrs: dueOn('2026-10-12') }),
    ]).cards.sort((a, b) => a.id.localeCompare(b.id));
    expect(undated).toMatchObject({ legacyDue: TODAY, differenceDays: 3 });
    expect(mastered).toMatchObject({ legacyDue: null, differenceDays: null });
  });

  it('counts the reviews falling due on each coming day, with anything overdue on the first', () => {
    const { workload } = compare([
      card(1, { reviewDate: '2026-10-01', fsrs: dueOn('2026-10-02') }),
      card(2, { reviewDate: TODAY, fsrs: dueOn('2026-10-11') }),
      card(3, { reviewDate: '2026-10-11', fsrs: dueOn('2026-10-11') }),
      card(4, { reviewDate: '2026-10-13', fsrs: dueOn('2026-11-30') }),
      card(5, { mastery: 10, reviewDate: TODAY, fsrs: dueOn('2026-10-13') }),
    ]);
    expect(workload).toEqual([
      { date: '2026-10-09', legacy: 2, fsrs: 1 },
      { date: '2026-10-10', legacy: 0, fsrs: 0 },
      { date: '2026-10-11', legacy: 1, fsrs: 2 },
      { date: '2026-10-12', legacy: 0, fsrs: 0 },
      { date: '2026-10-13', legacy: 1, fsrs: 1 },
    ]);
  });

  it('lists the soonest FSRS dates first and can be limited', () => {
    const cards = [3, 1, 2].map((n) => card(n, { fsrs: dueOn(`2026-10-1${n}`) }));
    expect(compare(cards).cards.map((item) => item.id)).toEqual(['id-1', 'id-2', 'id-3']);
    const limited = compareSchedules(cards, TODAY, ZONE, { retiredAtMastery: 10, limit: 2 });
    expect(limited.cards).toHaveLength(2);
    expect(limited.comparable).toBe(3);
  });

  it('copes with no words at all', () => {
    expect(compare([])).toEqual({
      totalCards: 0,
      comparable: 0,
      cards: [],
      workload: ['09', '10', '11', '12', '13'].map((day) => ({ date: `2026-10-${day}`, legacy: 0, fsrs: 0 })),
    });
  });
});
