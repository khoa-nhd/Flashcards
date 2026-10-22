/**
 * Which words need attention, and why. A pure scoring function: the same
 * inputs always give the same score, every point is attributable to a named
 * reason, and the weights are data that can be changed in one place.
 *
 * The factors are deliberately not equal. Forgetting a word on several
 * separate days outweighs one recent slip, and missing content only nudges a
 * word up the list; it never makes a word "weak" on its own evidence of
 * memory.
 */
import { daysBetween, type IsoDate } from './dates.js';

/** How a word has gone in review, from saved answers. Absent for a word never reviewed. */
export interface CardHistory {
  reviews: number;
  failures: number;
  /** Within the recent window (see `WEAK_WORD_WINDOW_DAYS`). */
  recentReviews: number;
  recentFailures: number;
  /** Distinct days with at least one failure. */
  failedDays: number;
  lastReviewedOn: IsoDate | null;
  lastFailedOn: IsoDate | null;
  lastAction: 'remember' | 'not_remember' | null;
}

export interface WeakWordInput {
  id: string;
  word: string;
  mastery: number | null;
  /** When the word is next due; `null` means due now. */
  reviewDate: IsoDate | null;
  /** True when the schedule will not show the word again (fully mastered). */
  retired: boolean;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  history: CardHistory | null;
  /**
   * The reviewer has shown they still know the word within the last week, so
   * the word's age on the schedule is not held against it. Set by the caller
   * that has the recovery history; `false` when there is none.
   */
  overdueForgiven?: boolean;
  /**
   * What `mastery` holds: the mastery schedule's level, or under FSRS alone the
   * memory strength level (1 to 10, display only). Mastery when absent.
   */
  scale?: 'mastery' | 'strength';
  /** Under FSRS alone: FSRS's estimate of recall now (0 to 1), `null` for a word it has not seen. */
  recall?: number | null;
  /** Under FSRS alone: how many times the word has lapsed. */
  lapses?: number;
}

export type WeakReasonCode =
  | 'repeated_failures'
  | 'recent_failures'
  | 'low_recent_accuracy'
  | 'slipped_after_progress'
  | 'long_overdue'
  | 'incomplete';

export interface WeakReason {
  code: WeakReasonCode;
  /** This reason's share of the score. */
  points: number;
  /** A sentence that stands on its own, with the numbers that produced it. */
  detail: string;
}

export type Severity = 'high' | 'medium' | 'low';

export interface WeakWord {
  id: string;
  word: string;
  mastery: number | null;
  score: number;
  severity: Severity;
  /** Heaviest first; `reasons[0]` is the main one. */
  reasons: WeakReason[];
  /** Recent performance, for display. `null` when the word has no saved reviews. */
  recent: { reviews: number; remembered: number } | null;
  action: string;
}

/** How far back "recent" looks. */
export const WEAK_WORD_WINDOW_DAYS = 30;

export interface WeakWordWeights {
  /** Per distinct day the word was forgotten on, from the second such day, up to `repeatedFailureDaysCap` days. */
  perRepeatedFailureDay: number;
  repeatedFailureDaysCap: number;
  /** Per failure inside the recent window, up to `recentFailuresCap`. */
  perRecentFailure: number;
  recentFailuresCap: number;
  /** When at least `lowAccuracyMinReviews` recent reviews show accuracy under `lowAccuracyBelow`. */
  lowRecentAccuracy: number;
  lowAccuracyMinReviews: number;
  lowAccuracyBelow: number;
  /** When a word at `progressMastery` or above was forgotten at its latest review. */
  slippedAfterProgress: number;
  progressMastery: number;
  /** When due for `longOverdueDays` or more, plus `perExtraOverdueWeek` per further week up to `overdueWeeksCap`. */
  longOverdue: number;
  longOverdueDays: number;
  perExtraOverdueWeek: number;
  overdueWeeksCap: number;
  /** Per missing field (meaning, definition, example), up to `incompleteCap` fields. */
  perMissingField: number;
  incompleteCap: number;
  severity: { high: number; medium: number };
}

export const DEFAULT_WEAK_WORD_WEIGHTS: WeakWordWeights = {
  perRepeatedFailureDay: 3,
  repeatedFailureDaysCap: 5,
  perRecentFailure: 2,
  recentFailuresCap: 3,
  lowRecentAccuracy: 3,
  lowAccuracyMinReviews: 3,
  lowAccuracyBelow: 0.6,
  slippedAfterProgress: 3,
  progressMastery: 6,
  longOverdue: 2,
  longOverdueDays: 7,
  perExtraOverdueWeek: 1,
  overdueWeeksCap: 3,
  perMissingField: 1,
  incompleteCap: 2,
  severity: { high: 8, medium: 4 },
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const ACTIONS: Record<WeakReasonCode, string> = {
  repeated_failures: 'Review it now, and add an example that makes it stick.',
  recent_failures: 'Review it again soon.',
  low_recent_accuracy: 'Review it now and check that the definition is clear.',
  slipped_after_progress: 'Review it again: it was known and has slipped.',
  long_overdue: 'Review it: it has been waiting a long time.',
  incomplete: 'Fill in what is missing so the card can be reviewed properly.',
};

/** Scores one word. Returns `null` when nothing counts against it. */
export function scoreWeakWord(
  input: WeakWordInput,
  today: IsoDate,
  weights: WeakWordWeights = DEFAULT_WEAK_WORD_WEIGHTS,
): WeakWord | null {
  const reasons: WeakReason[] = [];
  const add = (code: WeakReasonCode, points: number, detail: string) => {
    if (points > 0) reasons.push({ code, points, detail });
  };
  const { history } = input;

  if (history !== null) {
    // The first day a word is forgotten is ordinary; it is the repeat that marks it out.
    const repeatedDays = Math.min(history.failedDays, weights.repeatedFailureDaysCap) - 1;
    if (repeatedDays > 0) {
      add(
        'repeated_failures',
        repeatedDays * weights.perRepeatedFailureDay,
        `Forgotten on ${plural(history.failedDays, 'separate day')}.`,
      );
    }

    if (history.recentFailures > 0) {
      add(
        'recent_failures',
        Math.min(history.recentFailures, weights.recentFailuresCap) * weights.perRecentFailure,
        `Not remembered ${plural(history.recentFailures, 'time')} in the last ${WEAK_WORD_WINDOW_DAYS} days.`,
      );
    }

    if (history.recentReviews >= weights.lowAccuracyMinReviews) {
      const remembered = history.recentReviews - history.recentFailures;
      if (remembered / history.recentReviews < weights.lowAccuracyBelow) {
        add(
          'low_recent_accuracy',
          weights.lowRecentAccuracy,
          `Remembered ${remembered} of the last ${history.recentReviews} reviews.`,
        );
      }
    }

    if (history.lastAction === 'not_remember' && (input.mastery ?? 0) >= weights.progressMastery) {
      add(
        'slipped_after_progress',
        weights.slippedAfterProgress,
        input.scale === 'strength'
          ? `At memory strength ${input.mastery} of 10, but not remembered at the latest review.`
          : `At mastery ${input.mastery}, but not remembered at the latest review.`,
      );
    }
  }

  if (!input.overdueForgiven && !input.retired && input.reviewDate !== null) {
    const overdue = daysBetween(input.reviewDate, today);
    if (overdue >= weights.longOverdueDays) {
      const extraWeeks = Math.min(Math.floor((overdue - weights.longOverdueDays) / 7), weights.overdueWeeksCap);
      add('long_overdue', weights.longOverdue + extraWeeks * weights.perExtraOverdueWeek, `Due for ${plural(overdue, 'day')}.`);
    }
  }

  const missing = [
    input.meaning === null ? 'meaning' : null,
    input.definition === null ? 'definition' : null,
    input.example === null ? 'example' : null,
  ].filter((field): field is string => field !== null);
  if (missing.length > 0) {
    add(
      'incomplete',
      Math.min(missing.length, weights.incompleteCap) * weights.perMissingField,
      `Missing ${missing.join(' and ')}.`,
    );
  }

  if (reasons.length === 0) return null;
  // Heaviest first; a tie keeps the order above, which already puts memory evidence before housekeeping.
  reasons.sort((a, b) => b.points - a.points);
  const score = reasons.reduce((total, reason) => total + reason.points, 0);
  const main = reasons[0] as WeakReason;

  return {
    id: input.id,
    word: input.word,
    mastery: input.mastery,
    score,
    severity: score >= weights.severity.high ? 'high' : score >= weights.severity.medium ? 'medium' : 'low',
    reasons,
    recent:
      history === null
        ? null
        : { reviews: history.recentReviews, remembered: history.recentReviews - history.recentFailures },
    action: ACTIONS[main.code],
  };
}

/**
 * Under FSRS alone, the same words in the order the owner chose (2026-10-21):
 * the lowest estimated recall now first; on a tie, the word that has lapsed
 * more often; then the one that has been due longest. A word FSRS has not
 * seen has no estimate and comes after those that have one. Ties after that
 * go by word, so the order is stable.
 */
export function rankWeakWordsByRecall(
  inputs: readonly WeakWordInput[],
  today: IsoDate,
  weights: WeakWordWeights = DEFAULT_WEAK_WORD_WEIGHTS,
): WeakWord[] {
  const byId = new Map(inputs.map((input) => [input.id, input]));
  const recall = (word: WeakWord) => byId.get(word.id)?.recall ?? null;
  const lapses = (word: WeakWord) => byId.get(word.id)?.lapses ?? 0;
  const due = (word: WeakWord) => byId.get(word.id)?.reviewDate ?? null;
  return inputs
    .map((input) => scoreWeakWord(input, today, weights))
    .filter((word): word is WeakWord => word !== null)
    .sort((a, b) => {
      const ra = recall(a);
      const rb = recall(b);
      if (ra !== rb) {
        if (ra === null) return 1;
        if (rb === null) return -1;
        return ra - rb;
      }
      const lapsed = lapses(b) - lapses(a);
      if (lapsed !== 0) return lapsed;
      const da = due(a);
      const db = due(b);
      if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        return da < db ? -1 : 1;
      }
      return a.word.localeCompare(b.word);
    });
}

/** Every word with something against it, sorted by mastery then by weakness. Ties are broken by word so the order is stable. */
export function rankWeakWords(
  inputs: readonly WeakWordInput[],
  today: IsoDate,
  weights: WeakWordWeights = DEFAULT_WEAK_WORD_WEIGHTS,
): WeakWord[] {
  return inputs
    .map((input) => scoreWeakWord(input, today, weights))
    .filter((word): word is WeakWord => word !== null)
    .sort(
      (a, b) =>
        (a.mastery ?? -1) - (b.mastery ?? -1) ||
        b.score - a.score ||
        a.word.localeCompare(b.word),
    );
}
