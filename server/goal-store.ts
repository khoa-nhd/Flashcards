import { NO_GOAL, type DailyGoal } from '../shared/session-planner.js';

/** Where one account's daily goal is kept. */
export interface GoalStore {
  /** False where a goal cannot be kept; `get` then always answers "no goal". */
  readonly available: boolean;
  get(): DailyGoal;
  /** Stores the goal and returns what was stored. */
  save(goal: DailyGoal): Promise<DailyGoal>;
}

/** For a store that has nowhere to keep a goal. */
export const NO_GOAL_STORE: GoalStore = {
  available: false,
  get: () => NO_GOAL,
  async save() {
    throw new Error('This store cannot keep a daily goal.');
  },
};

/**
 * A goal that was read with the account's settings, and is written back
 * through `persist`. Without `persist` it lives in memory only, which is what
 * the built-in sample data wants.
 */
export function createGoalStore(
  initial: DailyGoal = NO_GOAL,
  persist: (goal: DailyGoal) => Promise<DailyGoal> = async (goal) => goal,
): GoalStore {
  let current = initial;
  return {
    available: true,
    get: () => current,
    async save(goal) {
      current = await persist(goal);
      return current;
    },
  };
}
