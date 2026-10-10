/**
 * The one place the FSRS library is used. Everything else sees plain data: a
 * stored card state goes in with a rating and a time, and the next stored
 * state comes out. Nothing here knows about the database, the interface, or
 * the mastery-based schedule.
 *
 * Library: ts-fsrs (MIT). Its own version string is recorded with every state
 * it produces, so a later change of library or algorithm is identifiable.
 */
import { FSRSVersion, createEmptyCard, fsrs, type Card, type FSRS, type Grade } from 'ts-fsrs';
import { z } from 'zod';
import { calendarDateInTimeZone, type IsoDate } from '../dates.js';

/** The four answers FSRS understands. There is no other failing grade than Again. */
export const FSRS_RATINGS = { again: 1, hard: 2, good: 3, easy: 4 } as const;
export type FsrsRating = (typeof FSRS_RATINGS)[keyof typeof FSRS_RATINGS];

export const FSRS_RATING_NAMES: Record<FsrsRating, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

/** As the library reports itself, for example "v5.4.2 using FSRS-6.0". */
export const FSRS_ENGINE: string = FSRSVersion;

/**
 * An FSRS card as the app stores it. Timestamps are ISO strings; `state` is
 * the library's own numbering (0 new, 1 learning, 2 review, 3 relearning).
 */
export const fsrsStateSchema = z.object({
  due: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Expected a timestamp'),
  stability: z.number().positive(),
  difficulty: z.number().min(1).max(10),
  scheduledDays: z.number().int().min(0),
  learningSteps: z.number().int().min(0),
  reps: z.number().int().min(0),
  lapses: z.number().int().min(0),
  state: z.number().int().min(0).max(3),
  lastReview: z.string().nullable(),
});

export type FsrsState = z.infer<typeof fsrsStateSchema>;

export interface FsrsSettings {
  /** The share of reviews the schedule aims to have remembered, from 0 to 1. */
  requestRetention: number;
}

/** Bounds on the target retention. Outside them the workload becomes impractical either way. */
export const FSRS_RETENTION = { min: 0.7, max: 0.97, default: 0.9 } as const;

export const DEFAULT_FSRS_SETTINGS: FsrsSettings = { requestRetention: FSRS_RETENTION.default };

export function isValidRetention(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= FSRS_RETENTION.min && value <= FSRS_RETENTION.max;
}

const schedulers = new Map<number, FSRS>();

function schedulerFor(settings: FsrsSettings): FSRS {
  if (!isValidRetention(settings.requestRetention)) {
    throw new RangeError(`Target retention must be between ${FSRS_RETENTION.min} and ${FSRS_RETENTION.max}.`);
  }
  let scheduler = schedulers.get(settings.requestRetention);
  if (scheduler === undefined) {
    scheduler = fsrs({
      request_retention: settings.requestRetention,
      // The app works in whole calendar days, as the mastery schedule does: no
      // same-day (re)learning steps, so every interval is at least one day.
      enable_short_term: false,
      // No random spread: the same answers always give the same dates.
      enable_fuzz: false,
    });
    schedulers.set(settings.requestRetention, scheduler);
  }
  return scheduler;
}

function toCard(state: FsrsState): Card {
  return {
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    // Deprecated in the library, which now derives it from `last_review`.
    elapsed_days: 0,
    scheduled_days: state.scheduledDays,
    learning_steps: state.learningSteps,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    last_review: state.lastReview === null ? undefined : new Date(state.lastReview),
  };
}

function fromCard(card: Card): FsrsState {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review === undefined ? null : card.last_review.toISOString(),
  };
}

/**
 * Applies one answer. `previous` is `null` for a card FSRS has never seen: it
 * then starts as a new card at `now`, with no history assumed for it.
 */
export function fsrsReview(
  previous: FsrsState | null,
  rating: FsrsRating,
  now: Date,
  settings: FsrsSettings = DEFAULT_FSRS_SETTINGS,
): FsrsState {
  const card = previous === null ? createEmptyCard(now) : toCard(previous);
  return fromCard(schedulerFor(settings).next(card, now, rating as Grade).card);
}

/** The calendar day a card falls due on, in the reviewer's time zone. */
export function fsrsDueDay(state: FsrsState, timeZone: string): IsoDate {
  return calendarDateInTimeZone(new Date(state.due), timeZone);
}
