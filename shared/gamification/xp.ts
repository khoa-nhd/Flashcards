/**
 * What one answer is worth (docs/gamification-plan.md, 1.1). The amount never
 * depends on whether the word was remembered: rewarding "Remember" would make
 * people press it for XP, and the schedule would be wrong.
 */

/** One saved answer, as the game reads it from the history. */
export interface AnswerEvent {
  /** The history row's id; an undo names the row it took back. */
  id: string;
  kind: 'review' | 'practice' | 'undo';
  undoes: string | null;
  /** When the answer was given (ISO timestamp). */
  at: string;
  /** The reviewer's calendar day it was given on. */
  on: string;
  /** The word's first answer ever. */
  isNew: boolean;
  /** Whether the answer moved the schedule. */
  counted: boolean;
  /** Whether the word was due when answered. */
  wasDue: boolean;
  durationMs: number | null;
  /** The study mode, for practice answers (recognition, typing, cloze, listening) and reviews (flashcard). */
  mode: string | null;
  /** This answer took the word to the Master band (stability of a year or more). */
  mastered: boolean;
  /** When the database recorded the answer, by its own clock; absent for answers saved before version 18. */
  recordedAt?: string | null;
}

export type AnswerReason = 'due' | 'new' | 'early' | 'extra' | 'practice';

export const XP = {
  due: 10,
  /** Studying a word for the first time, including the 2 for having added it. */
  new: 17,
  early: 5,
  extra: 5,
  practice: 5,
  goalDay: 50,
  allQuests: 50,
} as const;

/** Why an answer earns what it does, from how it was saved. `null` for an undo. */
export function answerReason(event: AnswerEvent): AnswerReason | null {
  if (event.kind === 'undo') return null;
  if (event.kind === 'practice') return 'practice';
  if (event.isNew) return 'new';
  if (!event.counted) return 'extra';
  return event.wasDue ? 'due' : 'early';
}

/**
 * Limits on earning, so XP compares fairly between strangers (plan, 2.0). An
 * answer past a limit is still saved and still moves the schedule; it only
 * earns nothing and counts towards no quest. Both go by the database's clock.
 *
 * - An answer less than `minGapMs` after the previous one earns nothing.
 * - At most `perMinute` answers earn XP in any minute.
 */
export const RATE_LIMIT = { minGapMs: 600, perMinute: 90 } as const;

/** Answers further apart than this end the combo. */
export const COMBO_GAP_MS = 2 * 60 * 1000;

/** The bonus a combo of `count` answers in a row gives, in percent. */
export function comboBonus(count: number): number {
  if (count >= 50) return 50;
  if (count >= 25) return 25;
  if (count >= 10) return 10;
  return 0;
}

/** Days without a single answer after which coming back is rewarded. */
export const COMEBACK_AFTER_DAYS = 3;
export const COMEBACK_BONUS = 100;
export const COMEBACK_HOURS = 24;

/**
 * Bonuses add up, never multiply (the owner's rule): +50% combo and +100%
 * comeback make +150%, so the answer is worth 2.5 times its base.
 */
export function withBonus(base: number, bonusPercent: number): number {
  return Math.round(base * (1 + Math.max(0, bonusPercent) / 100));
}
