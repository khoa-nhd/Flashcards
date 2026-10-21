/**
 * Memory strength, the FSRS-only queue and statuses. Strength is a display
 * scale read from FSRS stability; it never decides when a word is due.
 */
import { describe, expect, it } from 'vitest';
import { buildFsrsQueue, checkFsrsEligibility } from '../../shared/review-logic.js';
import {
  isDetailCollapsed,
  memoryStrength,
  stabilityForLevel,
  strengthBand,
  strengthLevelOf,
  strengthPercent,
  type StrengthLevel,
} from '../../shared/scheduler/strength.js';
import { classifyFsrsStatus, isFsrsReviewable } from '../../shared/vocabulary-status.js';
import { TODAY } from '../helpers/fixtures.js';

describe('the strength level', () => {
  it.each([
    [null, 1],
    [0.5, 1],
    [0.99, 1],
    [1, 2],
    [2.9, 2],
    [3, 3],
    [7, 4],
    [14, 5],
    [29.9, 5],
    [30, 6],
    [60, 7],
    [120, 8],
    [240, 9],
    [364.9, 9],
    [365, 10],
    [5000, 10],
  ])('stability %s days is level %i', (stability, level) => {
    expect(strengthLevelOf(stability)).toBe(level);
  });

  it('reads anything unusable as new', () => {
    expect(strengthLevelOf(Number.NaN)).toBe(1);
    expect(strengthLevelOf(-3)).toBe(1);
    expect(strengthLevelOf(undefined)).toBe(1);
  });

  it('names five bands over the ten levels', () => {
    const bands = ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as StrengthLevel[]).map(strengthBand);
    expect(bands).toEqual(['New', 'Learning', 'Learning', 'Familiar', 'Familiar', 'Strong', 'Strong', 'Strong', 'Strong', 'Master']);
  });

  it('fills a ten-step bar from empty at level 1 to full at level 10', () => {
    expect(strengthPercent(1)).toBe(0);
    expect(strengthPercent(10)).toBe(100);
    expect(strengthPercent(6)).toBeCloseTo(55.56, 2);
  });

  it('folds the definition and example away from level 6, above level 5 as the owner asked', () => {
    expect(isDetailCollapsed(5)).toBe(false);
    expect(isDetailCollapsed(6)).toBe(true);
    expect(isDetailCollapsed(10)).toBe(true);
  });

  it('gives back the smallest stability of a level, which lands in that level again', () => {
    for (let level = 2; level <= 10; level += 1) expect(strengthLevelOf(stabilityForLevel(level))).toBe(level);
    expect(stabilityForLevel(42)).toBe(365);
  });

  it('describes a word FSRS has not seen as new, with no history assumed', () => {
    expect(memoryStrength(null)).toEqual({
      level: 1,
      label: 'New',
      percent: 0,
      stabilityDays: null,
      difficulty: null,
      reps: 0,
      lapses: 0,
      lastReview: null,
      retrievability: null,
      nextIntervalDays: null,
    });
  });

  it('describes a seen word from its FSRS state alone', () => {
    const strength = memoryStrength(
      { stability: 57, difficulty: 2.1, reps: 5, lapses: 1, lastReview: '2026-10-01T00:00:00.000Z', scheduledDays: 57 },
      { retrievability: 0.88 },
    );
    expect(strength).toMatchObject({ level: 6, label: 'Strong', stabilityDays: 57, reps: 5, lapses: 1, retrievability: 0.88, nextIntervalDays: 57 });
  });
});

describe('the queue under FSRS alone', () => {
  const word = (id: string, dueOn: string | null, suspended = false) => ({ id, dueOn, suspended });

  it('takes every word due today or earlier, earliest first, and nothing archived', () => {
    const { queue, excluded } = buildFsrsQueue(
      [word('later', '2026-10-20'), word('today', TODAY), word('old', '2026-09-01'), word('archived', '2026-09-01', true), word('none', null)],
      TODAY,
    );
    expect(queue.map((item) => item.id)).toEqual(['old', 'today']);
    expect(excluded.map((item) => [item.record.id, item.reason])).toEqual([
      ['later', 'not_due'],
      ['archived', 'suspended'],
      ['none', 'missing_due_date'],
    ]);
  });

  it('keeps the source order for words due the same day, and drops a repeated id', () => {
    const { queue, excluded } = buildFsrsQueue([word('b', TODAY), word('a', TODAY), word('b', TODAY)], TODAY);
    expect(queue.map((item) => item.id)).toEqual(['b', 'a']);
    expect(excluded).toEqual([{ record: word('b', TODAY), reason: 'duplicate' }]);
  });

  it('takes a word early only when the review allows it, and an archived one never', () => {
    expect(checkFsrsEligibility(word('x', '2026-10-20'), TODAY)).toEqual({ eligible: false, reason: 'not_due' });
    expect(checkFsrsEligibility(word('x', '2026-10-20'), TODAY, { allowNotDue: true })).toEqual({ eligible: true });
    expect(checkFsrsEligibility(word('x', TODAY, true), TODAY, { allowNotDue: true })).toEqual({ eligible: false, reason: 'suspended' });
  });
});

describe('statuses under FSRS alone', () => {
  it.each([
    [{ dueOn: TODAY, hasFsrs: false }, 'new', true],
    [{ dueOn: TODAY, hasFsrs: true }, 'due_today', true],
    [{ dueOn: '2026-10-01', hasFsrs: true }, 'overdue', true],
    [{ dueOn: '2026-10-01', hasFsrs: false }, 'overdue', true],
    [{ dueOn: '2026-10-20', hasFsrs: true }, 'upcoming', false],
    [{ dueOn: '2026-10-20', hasFsrs: false }, 'upcoming', false],
    [{ dueOn: '2026-10-01', hasFsrs: true, suspended: true }, 'suspended', false],
    [{ dueOn: null, hasFsrs: false }, 'invalid', false],
  ] as const)('%o is %s', (input, status, reviewable) => {
    expect(classifyFsrsStatus(input, TODAY)).toBe(status);
    expect(isFsrsReviewable(status)).toBe(reviewable);
  });

  it('never calls a word mastered: nothing retires on its own', () => {
    expect(classifyFsrsStatus({ dueOn: '2027-12-01', hasFsrs: true }, TODAY)).toBe('upcoming');
  });
});
