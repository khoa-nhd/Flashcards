import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULER,
  SCHEDULERS,
  dueDateUnder,
  isScheduledByFsrs,
  isSchedulerId,
} from '../../shared/scheduler/active.js';
import {
  DEFAULT_FSRS_SETTINGS,
  FSRS_RATINGS,
  MIN_REVIEWS_FOR_ESTIMATE,
  fsrsRetrievability,
  fsrsReview,
  type FsrsState,
} from '../../shared/scheduler/fsrs.js';
import { createSchedulerStore, MASTERY_ONLY } from '../../server/scheduler-store.js';
import { NOW } from '../helpers/fixtures.js';

const DAY_MS = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe('the schedule in charge', () => {
  it('is the mastery schedule unless something else is chosen', () => {
    expect(DEFAULT_SCHEDULER).toBe('mastery_v1');
    expect(SCHEDULERS).toEqual(['mastery_v1', 'fsrs']);
  });

  it('recognises only the two schedules', () => {
    expect(isSchedulerId('mastery_v1')).toBe(true);
    expect(isSchedulerId('fsrs')).toBe(true);
    for (const other of ['FSRS', 'sm2', '', null, undefined, 1]) expect(isSchedulerId(other)).toBe(false);
  });
});

describe('the day a word is next due', () => {
  const word = { reviewDate: '2026-10-20', fsrsDue: '2026-10-12T05:00:00.000Z' };

  it('is the mastery review date under the mastery schedule, whatever FSRS has', () => {
    expect(dueDateUnder('mastery_v1', word, 'UTC')).toBe('2026-10-20');
    expect(isScheduledByFsrs('mastery_v1', word)).toBe(false);
  });

  it('is the day FSRS has it due under FSRS', () => {
    expect(dueDateUnder('fsrs', word, 'UTC')).toBe('2026-10-12');
    expect(isScheduledByFsrs('fsrs', word)).toBe(true);
  });

  it('is the calendar day in the reviewer’s own time zone', () => {
    const lateEvening = { reviewDate: null, fsrsDue: '2026-10-12T18:30:00.000Z' };
    expect(dueDateUnder('fsrs', lateEvening, 'UTC')).toBe('2026-10-12');
    // Half past one the next morning in Ho Chi Minh City.
    expect(dueDateUnder('fsrs', lateEvening, 'Asia/Ho_Chi_Minh')).toBe('2026-10-13');
    // Still the afternoon before in Los Angeles.
    expect(dueDateUnder('fsrs', lateEvening, 'America/Los_Angeles')).toBe('2026-10-12');
  });

  it('stays the mastery date for a word FSRS has never seen: none is made up', () => {
    for (const fsrsDue of [null, undefined, '', 'not a time']) {
      const unseen = { reviewDate: '2026-10-20', fsrsDue };
      expect(isScheduledByFsrs('fsrs', unseen)).toBe(false);
      expect(dueDateUnder('fsrs', unseen, 'UTC')).toBe('2026-10-20');
    }
    expect(dueDateUnder('fsrs', { reviewDate: null }, 'UTC')).toBeNull();
  });
});

describe('where the choice is kept', () => {
  it('starts on the mastery schedule and remembers what is saved', async () => {
    const store = createSchedulerStore();
    expect(store.available).toBe(true);
    expect(store.get()).toBe('mastery_v1');
    expect(await store.save('fsrs')).toBe('fsrs');
    expect(store.get()).toBe('fsrs');
  });

  it('holds what the store confirmed, not what was asked for', async () => {
    const store = createSchedulerStore('fsrs', async () => 'mastery_v1');
    expect(await store.save('fsrs')).toBe('mastery_v1');
    expect(store.get()).toBe('mastery_v1');
  });

  it('keeps the old choice when saving fails', async () => {
    const store = createSchedulerStore('mastery_v1', async () => {
      throw new Error('database down');
    });
    await expect(store.save('fsrs')).rejects.toThrow('database down');
    expect(store.get()).toBe('mastery_v1');
  });

  it('is only ever the mastery schedule where there is nowhere to keep a choice', async () => {
    expect(MASTERY_ONLY.available).toBe(false);
    expect(MASTERY_ONLY.get()).toBe('mastery_v1');
    await expect(MASTERY_ONLY.save('fsrs')).rejects.toThrow();
  });
});

describe('FSRS’s estimate of recall', () => {
  /** A word answered Good three times, the last one at NOW. */
  function seasoned(): FsrsState {
    let state = fsrsReview(null, FSRS_RATINGS.good, at(-20));
    state = fsrsReview(state, FSRS_RATINGS.good, at(-17));
    return fsrsReview(state, FSRS_RATINGS.good, at(-8));
  }

  it('is nothing where there is no state to estimate from', () => {
    expect(fsrsRetrievability(null, NOW)).toBeNull();
  });

  it('is withheld until the word has been answered often enough', () => {
    const once = fsrsReview(null, FSRS_RATINGS.good, at(-3));
    expect(once.reps).toBeLessThan(MIN_REVIEWS_FOR_ESTIMATE);
    expect(fsrsRetrievability(once, NOW)).toBeNull();
    const twice = fsrsReview(once, FSRS_RATINGS.good, at(-1));
    expect(fsrsRetrievability(twice, NOW)).not.toBeNull();
  });

  it('is certain at the moment of a review and falls from there, as the library’s curve does', () => {
    const state = seasoned();
    const lastReview = new Date(state.lastReview!);
    expect(fsrsRetrievability(state, lastReview)).toBe(1);
    const afterAWeek = fsrsRetrievability(state, new Date(lastReview.getTime() + 7 * DAY_MS))!;
    const afterAMonth = fsrsRetrievability(state, new Date(lastReview.getTime() + 30 * DAY_MS))!;
    expect(afterAWeek).toBeLessThan(1);
    expect(afterAMonth).toBeLessThan(afterAWeek);
    expect(afterAMonth).toBeGreaterThan(0);
  });

  it('is the target retention on the day the word falls due: that is what "due" means in FSRS', () => {
    // No random spread and whole-day intervals, so the match is as close as rounding the interval to a day allows.
    for (const requestRetention of [0.8, 0.9, 0.95]) {
      const settings = { requestRetention };
      let state = fsrsReview(null, FSRS_RATINGS.good, at(-40), settings);
      state = fsrsReview(state, FSRS_RATINGS.good, new Date(state.due), settings);
      state = fsrsReview(state, FSRS_RATINGS.good, new Date(state.due), settings);
      const onDueDay = fsrsRetrievability(state, new Date(state.due), settings)!;
      expect(Math.abs(onDueDay - requestRetention)).toBeLessThan(0.02);
    }
  });

  it('does not depend on the target: the target moves the date, not how fast a word fades', () => {
    const state = seasoned();
    const when = at(5);
    expect(fsrsRetrievability(state, when, { requestRetention: 0.8 })).toBe(
      fsrsRetrievability(state, when, DEFAULT_FSRS_SETTINGS),
    );
  });

  it('never claims more than certainty for a time before the last review', () => {
    const state = seasoned();
    expect(fsrsRetrievability(state, at(-30))).toBe(1);
  });
});
