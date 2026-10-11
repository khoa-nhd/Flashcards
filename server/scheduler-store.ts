import { DEFAULT_SCHEDULER, type SchedulerId } from '../shared/scheduler/active.js';

/** Where one account's choice of schedule is kept. */
export interface SchedulerStore {
  /** False where the choice cannot be kept; the mastery schedule is then always in charge. */
  readonly available: boolean;
  get(): SchedulerId;
  /** Stores the choice and returns what was stored. */
  save(next: SchedulerId): Promise<SchedulerId>;
}

/** For a store with nowhere to keep the choice: nothing but the mastery schedule, ever. */
export const MASTERY_ONLY: SchedulerStore = {
  available: false,
  get: () => DEFAULT_SCHEDULER,
  async save() {
    throw new Error('This store cannot keep a choice of schedule.');
  },
};

/**
 * A choice that was read with the account's settings, and is written back
 * through `persist`. Without `persist` it lives in memory only, which is what
 * the built-in sample data wants.
 */
export function createSchedulerStore(
  initial: SchedulerId = DEFAULT_SCHEDULER,
  persist: (next: SchedulerId) => Promise<SchedulerId> = async (next) => next,
): SchedulerStore {
  let current = initial;
  return {
    available: true,
    get: () => current,
    async save(next) {
      current = await persist(next);
      return current;
    },
  };
}
