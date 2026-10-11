import { describe, expect, it } from 'vitest';
import { GOAL_LIMITS, NO_GOAL, goalProblem, planDay, type PlanInput } from '../../shared/session-planner.js';

const MINUTE = 60_000;

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  goal: NO_GOAL,
  done: { reviews: 0, durationMs: 0 },
  due: { total: 0, overdue: 0 },
  averageMs: null,
  ...overrides,
});

describe('a day without a goal', () => {
  it('has nothing to be met or missed', () => {
    const plan = planDay(input({ due: { total: 12, overdue: 4 }, done: { reviews: 3, durationMs: 45_000 } }));
    expect(plan).toMatchObject({ reviews: null, time: null, met: null, cardsToGoal: null, beyondGoal: null });
    expect(plan.due).toEqual({ total: 12, overdue: 4 });
    expect(plan.done).toEqual({ reviews: 3, durationMs: 45_000 });
  });

  it('still estimates the work that is due, from the reviewer’s own pace', () => {
    expect(planDay(input({ due: { total: 12, overdue: 0 }, averageMs: 20_000 })).estimatedDueMs).toBe(240_000);
  });

  it('gives no estimate when the pace is not known, rather than assuming one', () => {
    expect(planDay(input({ due: { total: 12, overdue: 0 } })).estimatedDueMs).toBeNull();
    expect(planDay(input({ due: { total: 12, overdue: 0 }, averageMs: 0 })).estimatedDueMs).toBeNull();
  });
});

describe('a goal counted in reviews', () => {
  const goal = { reviews: 20, minutes: null };

  it('reports how far along it is and how many answers are left', () => {
    const plan = planDay(input({ goal, done: { reviews: 5, durationMs: 0 }, due: { total: 30, overdue: 2 } }));
    expect(plan.reviews).toEqual({ target: 20, done: 5, remaining: 15, met: false });
    expect(plan.time).toBeNull();
    expect(plan.met).toBe(false);
    expect(plan.cardsToGoal).toBe(15);
  });

  it('says how much of what is due lies beyond the goal, without removing any of it', () => {
    const plan = planDay(input({ goal, done: { reviews: 5, durationMs: 0 }, due: { total: 30, overdue: 2 } }));
    expect(plan.beyondGoal).toBe(15);
    expect(plan.due.total).toBe(30);
  });

  it('is met exactly at the target and stays met beyond it', () => {
    const at = planDay(input({ goal, done: { reviews: 20, durationMs: 0 }, due: { total: 7, overdue: 0 } }));
    expect(at.met).toBe(true);
    expect(at.reviews).toMatchObject({ remaining: 0, met: true });
    expect(at.cardsToGoal).toBe(0);
    // Everything still due is beyond the goal; all of it is still reported as due.
    expect(at.beyondGoal).toBe(7);

    const past = planDay(input({ goal, done: { reviews: 26, durationMs: 0 } }));
    expect(past.reviews).toMatchObject({ done: 26, remaining: 0, met: true });
  });

  it('needs no pace', () => {
    expect(planDay(input({ goal, due: { total: 3, overdue: 0 } })).cardsToGoal).toBe(20);
  });

  it('reports no excess when less is due than the goal asks for', () => {
    expect(planDay(input({ goal, due: { total: 3, overdue: 0 } })).beyondGoal).toBe(0);
  });
});

describe('a goal counted in minutes', () => {
  const goal = { reviews: null, minutes: 10 };

  it('measures time on cards against the target', () => {
    const plan = planDay(input({ goal, done: { reviews: 9, durationMs: 4 * MINUTE }, averageMs: 30_000 }));
    expect(plan.time).toEqual({ target: 10 * MINUTE, done: 4 * MINUTE, remaining: 6 * MINUTE, met: false });
    expect(plan.reviews).toBeNull();
    expect(plan.met).toBe(false);
  });

  it('turns the time left into cards at the reviewer’s own pace, rounding up', () => {
    const plan = planDay(
      input({ goal, done: { reviews: 9, durationMs: 4 * MINUTE }, due: { total: 20, overdue: 0 }, averageMs: 35_000 }),
    );
    // 360 s left at 35 s a card: 10.3, so 11 cards.
    expect(plan.cardsToGoal).toBe(11);
    expect(plan.beyondGoal).toBe(9);
  });

  it('does not guess a number of cards when the pace is not known', () => {
    const plan = planDay(input({ goal, done: { reviews: 2, durationMs: MINUTE }, due: { total: 20, overdue: 0 } }));
    expect(plan.time).toMatchObject({ remaining: 9 * MINUTE, met: false });
    expect(plan.cardsToGoal).toBeNull();
    expect(plan.beyondGoal).toBeNull();
  });

  it('is met without needing a pace', () => {
    const plan = planDay(input({ goal, done: { reviews: 30, durationMs: 11 * MINUTE }, due: { total: 4, overdue: 0 } }));
    expect(plan.met).toBe(true);
    expect(plan.cardsToGoal).toBe(0);
    expect(plan.beyondGoal).toBe(4);
  });
});

describe('a goal with both parts', () => {
  const goal = { reviews: 20, minutes: 10 };

  it('is met only when both are', () => {
    const reviewsOnly = planDay(input({ goal, done: { reviews: 20, durationMs: 3 * MINUTE }, averageMs: 9_000 }));
    expect(reviewsOnly.reviews?.met).toBe(true);
    expect(reviewsOnly.time?.met).toBe(false);
    expect(reviewsOnly.met).toBe(false);

    const timeOnly = planDay(input({ goal, done: { reviews: 12, durationMs: 10 * MINUTE }, averageMs: 50_000 }));
    expect(timeOnly.met).toBe(false);

    expect(planDay(input({ goal, done: { reviews: 20, durationMs: 10 * MINUTE } })).met).toBe(true);
  });

  it('needs as many more answers as the part that is further away', () => {
    // 15 reviews to go; 6 minutes at 60 s a card is 6 cards.
    const byReviews = planDay(input({ goal, done: { reviews: 5, durationMs: 4 * MINUTE }, averageMs: 60_000 }));
    expect(byReviews.cardsToGoal).toBe(15);
    // 2 reviews to go; 8 minutes at 30 s a card is 16 cards.
    const byTime = planDay(input({ goal, done: { reviews: 18, durationMs: 2 * MINUTE }, averageMs: 30_000 }));
    expect(byTime.cardsToGoal).toBe(16);
  });

  it('cannot say how many cards while the time part is open and the pace unknown', () => {
    expect(planDay(input({ goal, done: { reviews: 5, durationMs: MINUTE } })).cardsToGoal).toBeNull();
  });
});

describe('what a goal may be', () => {
  it('accepts either part alone, both, or none', () => {
    for (const goal of [NO_GOAL, { reviews: 20, minutes: null }, { reviews: null, minutes: 10 }, { reviews: 1, minutes: 600 }]) {
      expect(goalProblem(goal), JSON.stringify(goal)).toBeNull();
    }
  });

  it('refuses values outside the limits the database enforces', () => {
    expect(goalProblem({ reviews: 0, minutes: null })).toMatch(/review goal/);
    expect(goalProblem({ reviews: GOAL_LIMITS.reviews.max + 1, minutes: null })).toMatch(/review goal/);
    expect(goalProblem({ reviews: 2.5, minutes: null })).toMatch(/whole number/);
    expect(goalProblem({ reviews: null, minutes: 0 })).toMatch(/time goal/);
    expect(goalProblem({ reviews: null, minutes: GOAL_LIMITS.minutes.max + 1 })).toMatch(/time goal/);
    expect(goalProblem({ reviews: null, minutes: Number.NaN })).toMatch(/time goal/);
  });
});
