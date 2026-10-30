/**
 * Badges: long-run achievements in tiers (docs/gamification-plan.md, 1.4).
 * Earned from the account's own totals, so an account that already has a long
 * history earns every tier it has reached the first time the game looks.
 */

export type BadgeId =
  | 'words_studied'
  | 'mastered'
  | 'reviews'
  | 'practice'
  | 'streak'
  | 'hours'
  | 'night_owl'
  | 'combo'
  | 'boss';

export interface BadgeMetrics {
  wordsStudied: number;
  mastered: number;
  reviews: number;
  practice: number;
  longestStreak: number;
  /** Total time spent answering, in milliseconds. */
  durationMs: number;
  /** Answers given from 23:00 to 03:59, the account's own time. */
  nightAnswers: number;
  longestCombo: number;
  /** Weekly bosses beaten (phase 3). */
  bosses: number;
}

export interface BadgeDefinition {
  id: BadgeId;
  /** Ascending; tier `n` is reached at `tiers[n - 1]`. */
  tiers: readonly number[];
  value: (metrics: BadgeMetrics) => number;
}

const HOUR_MS = 3_600_000;

export const BADGES: readonly BadgeDefinition[] = [
  { id: 'words_studied', tiers: [50, 100, 500, 1000, 5000], value: (m) => m.wordsStudied },
  { id: 'mastered', tiers: [10, 50, 200, 1000], value: (m) => m.mastered },
  { id: 'reviews', tiers: [100, 1000, 10_000, 50_000], value: (m) => m.reviews },
  { id: 'practice', tiers: [100, 1000, 5000], value: (m) => m.practice },
  { id: 'streak', tiers: [7, 30, 100, 365], value: (m) => m.longestStreak },
  { id: 'hours', tiers: [1, 10, 100, 500], value: (m) => Math.floor(m.durationMs / HOUR_MS) },
  { id: 'night_owl', tiers: [10, 50], value: (m) => m.nightAnswers },
  { id: 'combo', tiers: [25, 50, 100, 250], value: (m) => m.longestCombo },
  { id: 'boss', tiers: [1, 5, 20, 52], value: (m) => m.bosses },
];

export const badgeById = (id: string): BadgeDefinition | undefined => BADGES.find((badge) => badge.id === id);

/** The highest tier the metrics reach for a badge: 0 for none yet. */
export function tierReached(badge: BadgeDefinition, metrics: BadgeMetrics): number {
  const value = badge.value(metrics);
  return badge.tiers.filter((threshold) => value >= threshold).length;
}

/** Every tier reached and not yet held, as "badge:tier" pairs, lowest first. */
export function newTiers(metrics: BadgeMetrics, held: ReadonlySet<string>): Array<{ badge: BadgeId; tier: number }> {
  const earned: Array<{ badge: BadgeId; tier: number }> = [];
  for (const badge of BADGES) {
    const reached = tierReached(badge, metrics);
    for (let tier = 1; tier <= reached; tier += 1) {
      if (!held.has(`${badge.id}:${tier}`)) earned.push({ badge: badge.id, tier });
    }
  }
  return earned;
}
