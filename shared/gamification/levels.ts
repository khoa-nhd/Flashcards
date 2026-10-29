/**
 * Levels from total XP (docs/gamification-plan.md, 1.2). Each level costs
 * about 15% more than the one before it, rounded per level, and there is no
 * top level. Pure, so the server and the page always agree.
 */

/** XP needed to go from level `level` to the next one. */
export function xpToNext(level: number): number {
  return Math.round(100 * 1.15 ** (Math.max(1, level) - 1));
}

export interface LevelProgress {
  level: number;
  /** XP earned since this level was reached. */
  into: number;
  /** XP this level takes to finish. */
  needed: number;
}

/** The level a total of XP stands at, and how far into it. A negative total counts as none. */
export function levelOf(totalXp: number): LevelProgress {
  let level = 1;
  let left = Math.max(0, Math.floor(totalXp));
  for (;;) {
    const needed = xpToNext(level);
    if (left < needed) return { level, into: left, needed };
    left -= needed;
    level += 1;
  }
}

/** Total XP at which `level` is reached. */
export function xpForLevel(level: number): number {
  let total = 0;
  for (let at = 1; at < level; at += 1) total += xpToNext(at);
  return total;
}
