/**
 * The FSRS adapter, checked against the library itself: what the app stores
 * and reloads must schedule exactly as the library's own card object would.
 */
import { FSRSVersion, Rating, State, createEmptyCard, fsrs, type Card, type Grade } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { fsrsRatingMap } from '../../config/review.config.js';
import { addDays } from '../../shared/dates.js';
import {
  DEFAULT_FSRS_SETTINGS,
  FSRS_ENGINE,
  FSRS_RATINGS,
  FSRS_RETENTION,
  fsrsDueDay,
  fsrsReview,
  fsrsStateSchema,
  isValidRetention,
  type FsrsRating,
  type FsrsState,
} from '../../shared/scheduler/fsrs.js';
import { DEFAULT_RATING_MAP, assertRatingMap, ratingFor, ratingMapProblem } from '../../shared/scheduler/rating-map.js';

const at = (iso: string) => new Date(iso);
const DAY = 86_400_000;
const START = at('2026-10-09T05:00:00.000Z');

/** The library with the app's fixed options, driven directly, as the reference. */
const reference = (retention = 0.9) => fsrs({ request_retention: retention, enable_short_term: false, enable_fuzz: false });

describe('the library the adapter is written against', () => {
  it('is the version and algorithm that were verified', () => {
    expect(FSRS_ENGINE).toBe(FSRSVersion);
    expect(FSRS_ENGINE).toBe('v5.4.2 using FSRS-6.0');
  });

  it('numbers its ratings and states the way the adapter stores them', () => {
    expect([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]).toEqual([1, 2, 3, 4]);
    expect(FSRS_RATINGS).toEqual({ again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy });
    expect([State.New, State.Learning, State.Review, State.Relearning]).toEqual([0, 1, 2, 3]);
  });

  it('still has the card fields the adapter reads and writes', () => {
    expect(Object.keys(createEmptyCard(START)).sort()).toEqual(
      ['difficulty', 'due', 'elapsed_days', 'lapses', 'last_review', 'learning_steps', 'reps', 'scheduled_days', 'stability', 'state'].sort(),
    );
  });
});

describe('a card FSRS has never seen', () => {
  it('starts as a new card at the moment of its first review, with nothing assumed', () => {
    const expected = reference().next(createEmptyCard(START), START, Rating.Good).card;
    const state = fsrsReview(null, FSRS_RATINGS.good, START);
    expect(state).toEqual({
      due: expected.due.toISOString(),
      stability: expected.stability,
      difficulty: expected.difficulty,
      scheduledDays: expected.scheduled_days,
      learningSteps: expected.learning_steps,
      reps: 1,
      lapses: 0,
      state: State.Review,
      lastReview: START.toISOString(),
    });
    expect(fsrsStateSchema.parse(state)).toEqual(state);
  });

  it.each([
    [FSRS_RATINGS.again, 'Again'],
    [FSRS_RATINGS.hard, 'Hard'],
    [FSRS_RATINGS.good, 'Good'],
    [FSRS_RATINGS.easy, 'Easy'],
  ] as const)('is due at least a day later after %i (%s), never the same day', (rating, _name) => {
    void _name;
    const state = fsrsReview(null, rating, START);
    expect(state.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(Date.parse(state.due) - START.getTime()).toBe(state.scheduledDays * DAY);
    // No same-day learning steps: the card goes straight to review.
    expect(state.state).toBe(State.Review);
    expect(state.learningSteps).toBe(0);
  });

  it('waits longer the better the answer', () => {
    const days = ([1, 2, 3, 4] as FsrsRating[]).map((rating) => fsrsReview(null, rating, START).scheduledDays);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(days[3]).toBeGreaterThan(days[0] ?? 0);
  });
});

describe('a sequence of reviews', () => {
  /** Answers in order, each on the day the previous one made the card due. */
  function replay(ratings: FsrsRating[], retention = 0.9) {
    let stored: FsrsState | null = null;
    let card: Card = createEmptyCard(START);
    let now = START;
    const scheduler = reference(retention);
    for (const rating of ratings) {
      stored = fsrsReview(stored, rating, now, { requestRetention: retention });
      card = scheduler.next(card, now, rating as Grade).card;
      now = card.due;
    }
    return { stored: stored as FsrsState, card };
  }

  it('matches the library exactly when the state is stored and reloaded between every review', () => {
    for (const ratings of [
      [3, 3, 3, 3, 3],
      [3, 1, 3, 3, 1, 3],
      [4, 4, 2, 3],
      [1, 1, 3, 2, 4, 3, 3],
    ] as FsrsRating[][]) {
      const { stored, card } = replay(ratings);
      expect(stored.due).toBe(card.due.toISOString());
      expect(stored.stability).toBe(card.stability);
      expect(stored.difficulty).toBe(card.difficulty);
      expect([stored.reps, stored.lapses, stored.state, stored.scheduledDays]).toEqual([
        card.reps,
        card.lapses,
        card.state,
        card.scheduled_days,
      ]);
    }
  });

  it('survives a round trip through JSON, which is how it is stored', () => {
    const first = fsrsReview(null, 3, START);
    const reloaded = fsrsStateSchema.parse(JSON.parse(JSON.stringify(first)));
    const later = at(first.due);
    expect(fsrsReview(reloaded, 3, later)).toEqual(fsrsReview(first, 3, later));
  });

  it('grows the interval with successes and counts a lapse on Again', () => {
    const { stored: steady } = replay([3, 3, 3, 3]);
    const { stored: once } = replay([3]);
    expect(steady.scheduledDays).toBeGreaterThan(once.scheduledDays);
    expect(steady.lapses).toBe(0);

    const { stored: lapsed } = replay([3, 3, 1]);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.reps).toBe(3);
    expect(lapsed.scheduledDays).toBeLessThan(replay([3, 3, 3]).stored.scheduledDays);
  });

  it('counts every review, including several on the same day', () => {
    let state = fsrsReview(null, 1, START);
    state = fsrsReview(state, 1, at('2026-10-09T05:10:00.000Z'));
    state = fsrsReview(state, 3, at('2026-10-09T09:00:00.000Z'));
    expect(state.reps).toBe(3);
    expect(state.lastReview).toBe('2026-10-09T09:00:00.000Z');
    expect(Date.parse(state.due)).toBeGreaterThan(Date.parse('2026-10-09T09:00:00.000Z'));
  });

  it('takes a late review into account instead of assuming it was on time', () => {
    const first = fsrsReview(null, 3, START);
    const onTime = fsrsReview(first, 3, at(first.due));
    const late = fsrsReview(first, 3, new Date(Date.parse(first.due) + 20 * DAY));
    // Remembering after a longer gap is stronger evidence, so the next gap is longer.
    expect(late.stability).toBeGreaterThan(onTime.stability);
  });

  it('gives the same result for the same inputs every time', () => {
    const a = replay([3, 1, 3, 4]).stored;
    const b = replay([3, 1, 3, 4]).stored;
    expect(a).toEqual(b);
  });
});

describe('target retention', () => {
  it('shortens intervals when a higher retention is asked for', () => {
    const relaxed = fsrsReview(fsrsReview(null, 3, START, { requestRetention: 0.8 }), 3, at('2026-10-20T05:00:00Z'), { requestRetention: 0.8 });
    const strict = fsrsReview(fsrsReview(null, 3, START, { requestRetention: 0.95 }), 3, at('2026-10-20T05:00:00Z'), { requestRetention: 0.95 });
    expect(strict.scheduledDays).toBeLessThan(relaxed.scheduledDays);
  });

  it('is limited to a sensible range', () => {
    expect(DEFAULT_FSRS_SETTINGS.requestRetention).toBe(0.9);
    expect(isValidRetention(FSRS_RETENTION.min)).toBe(true);
    expect(isValidRetention(FSRS_RETENTION.max)).toBe(true);
    for (const bad of [0.69, 0.98, 1, 0, Number.NaN, '0.9', null]) expect(isValidRetention(bad)).toBe(false);
    expect(() => fsrsReview(null, 3, START, { requestRetention: 0.5 })).toThrow(RangeError);
  });
});

describe('the day a card is due', () => {
  it('is read in the reviewer’s time zone, not the server’s', () => {
    // Reviewed at 18:30 UTC on the 9th: already the 10th in Vietnam.
    const state = fsrsReview(null, 3, at('2026-10-09T18:30:00.000Z'));
    const days = state.scheduledDays;
    expect(fsrsDueDay(state, 'UTC')).toBe(addDays('2026-10-09', days));
    expect(fsrsDueDay(state, 'Asia/Ho_Chi_Minh')).toBe(addDays('2026-10-10', days));
  });

  it('keeps the same local day across a daylight-saving change', () => {
    // New York leaves daylight time on 1 November 2026; a review at 21:00 local on 30 October.
    const reviewed = at('2026-10-31T01:00:00.000Z');
    const state = fsrsReview(null, 4, reviewed);
    expect(fsrsDueDay({ ...state, due: '2026-11-01T05:30:00.000Z' }, 'America/New_York')).toBe('2026-11-01');
    expect(fsrsDueDay({ ...state, due: '2026-11-01T04:30:00.000Z' }, 'America/New_York')).toBe('2026-11-01');
    expect(fsrsDueDay({ ...state, due: '2026-11-01T03:30:00.000Z' }, 'America/New_York')).toBe('2026-10-31');
  });
});

describe('mapping the two answers to FSRS ratings', () => {
  it('maps Remember to Good and Not remember to Again', () => {
    expect(fsrsRatingMap).toEqual({ remember: 3, not_remember: 1 });
    expect(fsrsRatingMap).toEqual(DEFAULT_RATING_MAP);
    expect(ratingFor('remember')).toBe(FSRS_RATINGS.good);
    expect(ratingFor('not_remember')).toBe(FSRS_RATINGS.again);
  });

  it('can be configured, within what FSRS can represent', () => {
    expect(ratingFor('remember', { remember: 4, not_remember: 1 })).toBe(4);
    expect(ratingMapProblem({ remember: 2, not_remember: 1 })).toBeNull();
    expect(ratingMapProblem({ remember: 3, not_remember: 2 })).toContain('Again');
    expect(ratingMapProblem({ remember: 1, not_remember: 1 })).toContain('lapse');
    expect(() => assertRatingMap({ remember: 3, not_remember: 3 })).toThrow(RangeError);
  });

  it('never treats Remember as a lapse nor Not remember as a success', () => {
    const remembered = fsrsReview(fsrsReview(null, 3, START), ratingFor('remember'), at('2026-10-12T05:00:00Z'));
    const forgotten = fsrsReview(fsrsReview(null, 3, START), ratingFor('not_remember'), at('2026-10-12T05:00:00Z'));
    expect(remembered.lapses).toBe(0);
    expect(forgotten.lapses).toBe(1);
    expect(forgotten.scheduledDays).toBeLessThan(remembered.scheduledDays);
  });
});
