/** Tunable interaction settings. */
export const SWIPE = {
  /** Horizontal distance a swipe must travel before it counts as an answer. */
  thresholdPx: 88,
  /** Movement below this is treated as a tap, not a drag. */
  slopPx: 12,
} as const;

export const TIMEOUTS = {
  queueMs: 60_000,
  /** Longer than the server's own timeouts, so the server answers first when it can. */
  actionMs: 40_000,
  quickMs: 15_000,
} as const;

/** How long the "flip the card first" hint stays visible. */
export const HINT_DURATION_MS = 2200;
