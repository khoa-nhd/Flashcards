/**
 * A what-if comparison of the two schedules, for looking at before choosing
 * between them. It is computed from two things only: where every word stands
 * on the mastery schedule right now, and the answers that were actually saved.
 *
 * - The mastery side is the live schedule itself; nothing is simulated.
 * - The FSRS side replays each word's saved answers, in order and at the times
 *   they were given, through FSRS at a chosen target retention. A word with no
 *   saved answer gets no FSRS state: it keeps its mastery date, which is also
 *   what happens to it if FSRS is put in charge.
 *
 * Nothing here reads or writes a stored FSRS state or a due date, and no
 * answer is ever assumed to have happened. The one forward-looking part, "if
 * every answer were Remember", is a stated scenario about spacing; it says
 * nothing about how well anything will be remembered.
 */
import { addDays, calendarDateInTimeZone, compareDates, daysBetween, type IsoDate } from '../dates.js';
import type { HistoryEvent } from '../export-format.js';
import { applyAction, type ReviewAction, type ReviewRules, type ReviewState } from '../review-logic.js';
import { fsrsDueDay, fsrsReview, type FsrsSettings, type FsrsState } from './fsrs.js';
import { ratingFor, type RatingMap } from './rating-map.js';

/** How far ahead the comparison looks. */
export const SIMULATION_DAYS = 30;
/** The most words listed one by one; the counts always cover all of them. */
export const SIMULATION_CARD_LIMIT = 200;

const DAY_MS = 86_400_000;
/** No word can be reviewed more often than this inside the window; it only stops a broken rule from looping. */
const MAX_REVIEWS_PER_WORD = 200;

/** A live word as the mastery schedule has it now. */
export interface SimulationWord {
  id: string;
  word: string;
  mastery: number;
  /** Empty means due now. */
  reviewDate: IsoDate | null;
}

/** One saved flashcard answer that still stands. */
export interface StandingReview {
  vocabularyId: string;
  action: ReviewAction;
  /** The instant it was given. */
  reviewedAt: string;
  /** The reviewer's calendar day it was given on. */
  reviewedOn: IsoDate;
}

export interface LeftOut {
  /** Answers taken back with Undo, and the undo records themselves. */
  undone: number;
  /** Practice answers: they never move a schedule, so they are not replayed into one. */
  practice: number;
}

/**
 * The answers a schedule was actually moved by: flashcard reviews that were
 * not taken back, oldest first.
 */
export function standingReviews(events: readonly HistoryEvent[]): { reviews: StandingReview[]; leftOut: LeftOut } {
  const undone = new Set<string>();
  for (const event of events) {
    if (event.kind === 'undo' && event.undoesId !== null) undone.add(event.undoesId);
  }
  const reviews: StandingReview[] = [];
  const leftOut: LeftOut = { undone: 0, practice: 0 };
  for (const event of events) {
    if (event.kind === 'practice') leftOut.practice += 1;
    else if (event.kind === 'undo' || undone.has(event.id)) leftOut.undone += 1;
    else {
      reviews.push({
        vocabularyId: event.vocabularyId,
        action: event.action,
        reviewedAt: event.reviewedAt,
        reviewedOn: event.reviewedOn,
      });
    }
  }
  reviews.sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt));
  return { reviews, leftOut };
}

/**
 * One word's saved answers put through FSRS from the start. The word enters
 * as a new card at its first saved answer: whatever happened before the
 * history begins is unknown, and nothing is assumed about it.
 */
export function replayThroughFsrs(
  reviews: readonly StandingReview[],
  settings: FsrsSettings,
  ratingMap: RatingMap,
): FsrsState | null {
  let state: FsrsState | null = null;
  for (const review of reviews) {
    state = fsrsReview(state, ratingFor(review.action, ratingMap), new Date(review.reviewedAt), settings);
  }
  return state;
}

export interface SimulationDay {
  date: IsoDate;
  mastery: number;
  fsrs: number;
}

export interface SimulatedCard {
  id: string;
  word: string;
  mastery: number;
  /** Saved answers replayed for this word. Zero means FSRS has nothing on it. */
  reviews: number;
  /** When the mastery schedule shows it next. */
  masteryDue: IsoDate;
  /** When FSRS would. For a word with no saved answer this is its mastery date, which it keeps until first answered. */
  fsrsDue: IsoDate;
  /** The interval FSRS chose after the last replayed answer; empty where nothing was replayed. */
  fsrsIntervalDays: number | null;
  /** FSRS day minus mastery day: positive means FSRS waits longer. */
  differenceDays: number;
}

export interface Simulation {
  /** The target retention FSRS was run at. */
  retention: number;
  today: IsoDate;
  days: number;
  /** The saved answers the FSRS side rests on. */
  history: {
    reviews: number;
    firstDay: IsoDate | null;
    lastDay: IsoDate | null;
    leftOut: LeftOut & {
      /** Standing answers to words that are in the trash or already retired, which are not scheduled at all. */
      otherWords: number;
    };
  };
  words: {
    /** Live words the mastery level has not retired: the ones either schedule would show again. */
    active: number;
    /** Of those, words with at least one saved answer to replay. */
    replayed: number;
    /** Of those, words with none. They stay on their mastery dates under both. */
    unseen: number;
    retired: number;
  };
  /** Where each active word next falls due. Anything already due counts on the first day. */
  nextDue: { days: SimulationDay[]; later: { mastery: number; fsrs: number } };
  /**
   * Reviews each schedule would ask for inside the window if every one of
   * them were answered Remember on the day it fell due. Empty when the
   * Remember rule is not confirmed.
   */
  ifAllRemembered: { days: SimulationDay[]; totals: { mastery: number; fsrs: number } } | null;
  cards: SimulatedCard[];
}

export interface SimulationOptions {
  rules: ReviewRules;
  ratingMap: RatingMap;
  /** Carries the target retention to try. */
  settings: FsrsSettings;
  now: Date;
  timeZone: string;
  days?: number;
  limit?: number;
}

export function simulate(
  words: readonly SimulationWord[],
  events: readonly HistoryEvent[],
  { rules, ratingMap, settings, now, timeZone, days = SIMULATION_DAYS, limit = SIMULATION_CARD_LIMIT }: SimulationOptions,
): Simulation {
  const today = calendarDateInTimeZone(now, timeZone);
  const lastDay = addDays(today, days - 1);
  const { reviews, leftOut } = standingReviews(events);

  const active = words.filter((word) => word.mastery < rules.retiredAtMastery);
  const activeIds = new Set(active.map((word) => word.id));
  const byWord = new Map<string, StandingReview[]>();
  let used = 0;
  let firstDay: IsoDate | null = null;
  let lastReviewDay: IsoDate | null = null;
  for (const review of reviews) {
    if (!activeIds.has(review.vocabularyId)) continue;
    used += 1;
    const list = byWord.get(review.vocabularyId) ?? [];
    list.push(review);
    byWord.set(review.vocabularyId, list);
    if (firstDay === null || compareDates(review.reviewedOn, firstDay) < 0) firstDay = review.reviewedOn;
    if (lastReviewDay === null || compareDates(review.reviewedOn, lastReviewDay) > 0) lastReviewDay = review.reviewedOn;
  }

  const emptyDays = (): SimulationDay[] =>
    Array.from({ length: days }, (_, offset) => ({ date: addDays(today, offset), mastery: 0, fsrs: 0 }));
  const nextDue = { days: emptyDays(), later: { mastery: 0, fsrs: 0 } };
  const scenario = rules.remember === null ? null : { days: emptyDays(), totals: { mastery: 0, fsrs: 0 } };
  const notBeforeToday = (day: IsoDate): IsoDate => (compareDates(day, today) < 0 ? today : day);
  const count = (target: SimulationDay[], day: IsoDate, side: 'mastery' | 'fsrs'): boolean => {
    if (compareDates(day, lastDay) > 0) return false;
    const slot = target[daysBetween(today, notBeforeToday(day))];
    if (slot === undefined) return false;
    slot[side] += 1;
    return true;
  };

  const cards: SimulatedCard[] = [];
  let replayed = 0;
  for (const word of active) {
    const history = byWord.get(word.id) ?? [];
    const state = replayThroughFsrs(history, settings, ratingMap);
    if (state !== null) replayed += 1;

    const masteryDue = word.reviewDate ?? today;
    const fsrsDue = state === null ? masteryDue : fsrsDueDay(state, timeZone);
    if (!count(nextDue.days, masteryDue, 'mastery')) nextDue.later.mastery += 1;
    if (!count(nextDue.days, fsrsDue, 'fsrs')) nextDue.later.fsrs += 1;
    cards.push({
      id: word.id,
      word: word.word,
      mastery: word.mastery,
      reviews: history.length,
      masteryDue,
      fsrsDue,
      fsrsIntervalDays: state === null ? null : state.scheduledDays,
      differenceDays: daysBetween(masteryDue, fsrsDue),
    });

    if (scenario === null) continue;

    // The mastery schedule, answered Remember every time it comes up, by the real rules.
    let legacy: ReviewState = { mastery: word.mastery, nextReview: notBeforeToday(masteryDue) };
    for (let step = 0; step < MAX_REVIEWS_PER_WORD && legacy.mastery < rules.retiredAtMastery; step += 1) {
      const day = legacy.nextReview ?? today;
      if (!count(scenario.days, day, 'mastery')) break;
      scenario.totals.mastery += 1;
      legacy = applyAction('remember', { mastery: legacy.mastery, nextReview: day }, day, rules);
    }

    // FSRS, the same way. Mastery still counts beside it and still retires the word.
    let mastery = word.mastery;
    let card = state;
    for (let step = 0; step < MAX_REVIEWS_PER_WORD && mastery < rules.retiredAtMastery; step += 1) {
      let at: Date;
      if (card === null) {
        // Not seen by FSRS yet: it comes up on its mastery date, and that answer is its first.
        at = new Date(now.getTime() + daysBetween(today, notBeforeToday(masteryDue)) * DAY_MS);
      } else {
        const dueAt = new Date(card.due);
        at = dueAt.getTime() > now.getTime() ? dueAt : now;
      }
      const day = calendarDateInTimeZone(at, timeZone);
      if (!count(scenario.days, day, 'fsrs')) break;
      scenario.totals.fsrs += 1;
      card = fsrsReview(card, ratingFor('remember', ratingMap), at, settings);
      mastery = applyAction('remember', { mastery, nextReview: day }, day, rules).mastery;
    }
  }

  cards.sort(
    (a, b) => compareDates(a.fsrsDue, b.fsrsDue) || compareDates(a.masteryDue, b.masteryDue) || a.word.localeCompare(b.word),
  );

  return {
    retention: settings.requestRetention,
    today,
    days,
    history: {
      reviews: used,
      firstDay,
      lastDay: lastReviewDay,
      leftOut: { ...leftOut, otherWords: reviews.length - used },
    },
    words: {
      active: active.length,
      replayed,
      unseen: active.length - replayed,
      retired: words.length - active.length,
    },
    nextDue,
    ifAllRemembered: scenario,
    cards: cards.slice(0, limit),
  };
}
