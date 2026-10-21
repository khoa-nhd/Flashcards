import { describe, expect, it } from 'vitest';
import { SUGGESTED_STUDY_GOALS, evaluateDay, streakOf, studyGoalsProblem } from '../../shared/study-goals.js';
import { TODAY } from '../helpers/fixtures.js';

const goals = { newWords: 10, reviews: 30, maintenanceMode: false };

describe('the two daily goals', () => {
  it('suggests 10 new words and 30 reviews', () => {
    expect(SUGGESTED_STUDY_GOALS).toEqual({ newWords: 10, reviews: 30, maintenanceMode: false });
  });

  it('is met only when both are', () => {
    expect(evaluateDay({ goals, newDone: 10, reviewsDone: 30, dueLeft: 5, newLeft: 50 }).met).toBe(true);
    expect(evaluateDay({ goals, newDone: 9, reviewsDone: 30, dueLeft: 5, newLeft: 50 }).met).toBe(false);
    expect(evaluateDay({ goals, newDone: 10, reviewsDone: 29, dueLeft: 5, newLeft: 50 }).met).toBe(false);
  });

  it('meets the review goal once nothing is left due, however few were due', () => {
    const day = evaluateDay({ goals, newDone: 10, reviewsDone: 4, dueLeft: 0, newLeft: 50 });
    expect(day.reviews).toEqual({ target: 30, done: 4, remaining: 26, met: true, exhausted: true });
    expect(day.met).toBe(true);
  });

  it('does not meet the new-word goal just because no new words are left', () => {
    const day = evaluateDay({ goals, newDone: 2, reviewsDone: 30, dueLeft: 0, newLeft: 0 });
    expect(day.newWords).toEqual({ target: 10, done: 2, remaining: 8, met: false, exhausted: true });
    expect(day.met).toBe(false);
  });

  it('lets maintenance mode set the new-word goal to 0, which is met at once', () => {
    const maintenance = { newWords: 0, reviews: 30, maintenanceMode: true };
    expect(studyGoalsProblem(maintenance)).toBeNull();
    expect(evaluateDay({ goals: maintenance, newDone: 0, reviewsDone: 30, dueLeft: 3, newLeft: 0 }).met).toBe(true);
  });

  it('refuses a goal of 0 new words outside maintenance mode, a review goal of 0, and odd numbers', () => {
    expect(studyGoalsProblem({ ...goals, newWords: 0 })).toContain('maintenance mode');
    expect(studyGoalsProblem({ ...goals, reviews: 0 })).toContain('at least 1');
    expect(studyGoalsProblem({ ...goals, newWords: 2.5 })).toContain('whole number');
    expect(studyGoalsProblem({ ...goals, reviews: 1001 })).toContain('whole number');
    expect(studyGoalsProblem(goals)).toBeNull();
  });
});

describe('the streak', () => {
  const days = (...offsets: number[]) =>
    offsets.map((offset) => {
      const date = new Date(`${TODAY}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - offset);
      return date.toISOString().slice(0, 10);
    });

  it('counts back from today once today is met', () => {
    expect(streakOf(days(1, 2, 3), TODAY, true)).toEqual({ current: 4, longest: 4, metToday: true });
  });

  it('still stands from yesterday while today is not met yet', () => {
    expect(streakOf(days(1, 2), TODAY, false)).toEqual({ current: 2, longest: 2, metToday: false });
  });

  it('breaks on a day that was not met', () => {
    expect(streakOf(days(1, 3, 4, 5), TODAY, true)).toEqual({ current: 2, longest: 3, metToday: true });
    expect(streakOf(days(2, 3), TODAY, false)).toMatchObject({ current: 0, longest: 2 });
  });

  it('is empty with nothing met', () => {
    expect(streakOf([], TODAY, false)).toEqual({ current: 0, longest: 0, metToday: false });
  });

  it('ignores a recorded today in favour of what today is now, and days after today', () => {
    expect(streakOf([...days(0, 1), '2099-01-01'], TODAY, false)).toEqual({ current: 1, longest: 1, metToday: false });
  });
});
