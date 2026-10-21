/**
 * Memory strength: the product's display-only scale derived from FSRS
 * stability. It never decides when a word is due. FSRS owns scheduling;
 * this scale only helps a learner see how durable a word has become.
 */
import type { FsrsState } from './fsrs.js';

export const STRENGTH_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type StrengthLevel = (typeof STRENGTH_LEVELS)[number];

export const STRENGTH_BANDS = ['New', 'Learning', 'Familiar', 'Strong', 'Master'] as const;
export type StrengthBand = (typeof STRENGTH_BANDS)[number];

/** The smallest stability, in days, that qualifies for each level. */
export const STABILITY_THRESHOLDS: Record<StrengthLevel, number> = {
  1: 0,
  2: 1,
  3: 3,
  4: 7,
  5: 14,
  6: 30,
  7: 60,
  8: 120,
  9: 240,
  10: 365,
};

/**
 * The one stability value used when a legacy word has to be mapped once and
 * has no usable review history. After the first real answer FSRS takes over.
 */
export function stabilityForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(10, Math.round(level))) as StrengthLevel;
  return STABILITY_THRESHOLDS[clamped];
}

/** The level a stability falls in. `null` means FSRS has never seen the word. */
export function strengthLevelOf(stability: number | null | undefined): StrengthLevel {
  if (stability === null || stability === undefined || !Number.isFinite(stability) || stability < 1) return 1;
  for (let level = 10; level >= 2; level -= 1) {
    if (stability >= STABILITY_THRESHOLDS[level as StrengthLevel]) return level as StrengthLevel;
  }
  return 1;
}

export function strengthBand(level: StrengthLevel): StrengthBand {
  if (level <= 1) return 'New';
  if (level <= 3) return 'Learning';
  if (level <= 5) return 'Familiar';
  if (level <= 9) return 'Strong';
  return 'Master';
}

/** From 0 to 100, for a ten-segment progress bar. Level 1 is empty, level 10 is full. */
export function strengthPercent(level: StrengthLevel): number {
  return ((level - 1) * 100) / 9;
}

/** Definitions and examples are folded away once a word is well established. */
export function isDetailCollapsed(level: StrengthLevel): boolean {
  return level >= 6;
}

/** The full display model for one word, whether or not FSRS has seen it. */
export interface MemoryStrength {
  level: StrengthLevel;
  label: StrengthBand;
  percent: number;
  stabilityDays: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  lastReview: string | null;
  /** The library's estimate of recall right now, 0 to 1, where it can give one. */
  retrievability: number | null;
  nextIntervalDays: number | null;
}

export interface MemoryStrengthOptions {
  retrievability?: number | null;
}

/** Builds the display model from FSRS state alone. No scheduling is involved. */
export function memoryStrength(
  state: Pick<FsrsState, 'stability' | 'difficulty' | 'reps' | 'lapses' | 'lastReview' | 'scheduledDays'> | null,
  options: MemoryStrengthOptions = {},
): MemoryStrength {
  const level = strengthLevelOf(state?.stability ?? null);
  return {
    level,
    label: strengthBand(level),
    percent: strengthPercent(level),
    stabilityDays: state?.stability ?? null,
    difficulty: state?.difficulty ?? null,
    reps: state?.reps ?? 0,
    lapses: state?.lapses ?? 0,
    lastReview: state?.lastReview ?? null,
    retrievability: options.retrievability ?? null,
    nextIntervalDays: state?.scheduledDays ?? null,
  };
}
