/** Pure swipe geometry, kept apart from the DOM so it can be tested exactly. */

export type GestureAxis = 'undecided' | 'horizontal' | 'vertical';
export type SwipeDirection = 'left' | 'right';

/**
 * Locks a gesture to an axis once it has clearly moved. Until then it is still
 * a potential tap. Vertical wins ties so page scrolling is never hijacked.
 */
export function decideAxis(dx: number, dy: number, slopPx: number): GestureAxis {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (Math.max(horizontal, vertical) < slopPx) return 'undecided';
  return horizontal > vertical ? 'horizontal' : 'vertical';
}

/** The swipe a release at offset `dx` amounts to, or `null` if it fell short. */
export function swipeDirection(dx: number, thresholdPx: number): SwipeDirection | null {
  if (Math.abs(dx) < thresholdPx) return null;
  return dx > 0 ? 'right' : 'left';
}
