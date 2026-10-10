/**
 * How the app's two answers become FSRS ratings. FSRS has four (Again, Hard,
 * Good, Easy) and exactly one of them, Again, means "forgotten".
 *
 * The mapping is deliberately conservative: Remember is Good, not Easy, so a
 * word is never pushed further out than a plain successful recall justifies.
 * It lives in config/review.config.ts and is checked by `assertRatingMap`.
 */
import type { ReviewAction } from '../review-logic.js';
import { FSRS_RATINGS, type FsrsRating } from './fsrs.js';

export interface RatingMap {
  remember: FsrsRating;
  not_remember: FsrsRating;
}

export const DEFAULT_RATING_MAP: RatingMap = {
  remember: FSRS_RATINGS.good,
  not_remember: FSRS_RATINGS.again,
};

/** Why a mapping cannot be used, or `null` when it can. */
export function ratingMapProblem(map: RatingMap): string | null {
  if (map.not_remember !== FSRS_RATINGS.again) {
    return 'Not remember must map to Again: it is the only FSRS rating that records a lapse.';
  }
  if (map.remember === FSRS_RATINGS.again) {
    return 'Remember cannot map to Again: that would record every success as a lapse.';
  }
  return null;
}

export function assertRatingMap(map: RatingMap): RatingMap {
  const problem = ratingMapProblem(map);
  if (problem !== null) throw new RangeError(problem);
  return map;
}

export function ratingFor(action: ReviewAction, map: RatingMap = DEFAULT_RATING_MAP): FsrsRating {
  return action === 'remember' ? map.remember : map.not_remember;
}
