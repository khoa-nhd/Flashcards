import { describe, expect, it } from 'vitest';
import { reviewRules } from '../../config/review.config.js';
import { addDays } from '../../shared/dates.js';
import type { HistoryEvent } from '../../shared/export-format.js';
import { FSRS_RATINGS, fsrsDueDay, fsrsReview, type FsrsState } from '../../shared/scheduler/fsrs.js';
import { DEFAULT_RATING_MAP } from '../../shared/scheduler/rating-map.js';
import {
  SIMULATION_DAYS,
  replayThroughFsrs,
  simulate,
  standingReviews,
  type SimulationOptions,
  type SimulationWord,
} from '../../shared/scheduler/simulation.js';
import { NOW, TIME_ZONE, TODAY, pageId } from '../helpers/fixtures.js';

const DAY_MS = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

let sequence = 0;
function event(word: number, overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  sequence += 1;
  const reviewedAt = overrides.reviewedAt ?? NOW.toISOString();
  return {
    id: `event-${sequence}`,
    vocabularyId: pageId(word),
    kind: 'review',
    action: 'remember',
    mode: 'flashcard',
    reviewedAt,
    reviewedOn: TODAY,
    durationMs: null,
    masteryBefore: 1,
    masteryAfter: 2,
    reviewDateBefore: null,
    reviewDateAfter: null,
    sessionId: null,
    undoesId: null,
    scheduler: 'mastery_v1',
    rating: null,
    confidence: null,
    answerCorrect: null,
    submittedAnswer: null,
    grading: null,
    ...overrides,
  };
}

/** A saved answer `days` from now (negative is the past), on the matching calendar day. */
const reviewed = (word: number, days: number, action: 'remember' | 'not_remember' = 'remember') =>
  event(word, { action, reviewedAt: at(days).toISOString(), reviewedOn: addDays(TODAY, days) });

const word = (n: number, mastery: number, reviewDate: string | null): SimulationWord => ({
  id: pageId(n),
  word: `word-${n}`,
  mastery,
  reviewDate,
});

const options = (overrides: Partial<SimulationOptions> = {}): SimulationOptions => ({
  rules: reviewRules,
  ratingMap: DEFAULT_RATING_MAP,
  settings: { requestRetention: 0.9 },
  now: NOW,
  timeZone: TIME_ZONE,
  ...overrides,
});

const sum = (days: Array<{ mastery: number; fsrs: number }>, side: 'mastery' | 'fsrs') =>
  days.reduce((total, day) => total + day[side], 0);

describe('which answers count', () => {
  it('keeps flashcard reviews that still stand, oldest first', () => {
    const first = reviewed(1, -5);
    const second = reviewed(1, -2, 'not_remember');
    const { reviews, leftOut } = standingReviews([second, first]);
    expect(reviews.map((review) => [review.action, review.reviewedOn])).toEqual([
      ['remember', addDays(TODAY, -5)],
      ['not_remember', addDays(TODAY, -2)],
    ]);
    expect(leftOut).toEqual({ undone: 0, practice: 0 });
  });

  it('leaves out an answer that was taken back, together with the record of taking it back', () => {
    const kept = reviewed(1, -3);
    const takenBack = reviewed(1, -1);
    const undo = event(1, { kind: 'undo', undoesId: takenBack.id, reviewedAt: at(-1).toISOString() });
    const { reviews, leftOut } = standingReviews([kept, takenBack, undo]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.reviewedOn).toBe(addDays(TODAY, -3));
    expect(leftOut.undone).toBe(2);
  });

  it('leaves out practice: it never moved a schedule, so it is not replayed into one', () => {
    const practice = event(1, { kind: 'practice', mode: 'typing', answerCorrect: true });
    expect(standingReviews([practice])).toEqual({ reviews: [], leftOut: { undone: 0, practice: 1 } });
  });
});

describe('replaying saved answers through FSRS', () => {
  it('is nothing at all for a word with no saved answer', () => {
    expect(replayThroughFsrs([], { requestRetention: 0.9 }, DEFAULT_RATING_MAP)).toBeNull();
  });

  it('is the same as having given those answers to FSRS at the time', () => {
    const { reviews } = standingReviews([reviewed(1, -9), reviewed(1, -6, 'not_remember'), reviewed(1, -2)]);
    let live: FsrsState | null = null;
    live = fsrsReview(live, FSRS_RATINGS.good, at(-9));
    live = fsrsReview(live, FSRS_RATINGS.again, at(-6));
    live = fsrsReview(live, FSRS_RATINGS.good, at(-2));
    expect(replayThroughFsrs(reviews, { requestRetention: 0.9 }, DEFAULT_RATING_MAP)).toEqual(live);
  });

  it('starts the word as new at its first saved answer, assuming nothing before it', () => {
    const { reviews } = standingReviews([reviewed(1, -4)]);
    const state = replayThroughFsrs(reviews, { requestRetention: 0.9 }, DEFAULT_RATING_MAP);
    expect(state).toEqual(fsrsReview(null, FSRS_RATINGS.good, at(-4)));
    expect(state?.reps).toBe(1);
  });
});

describe('the comparison', () => {
  // Word 1: answered once two days ago. Word 2: never answered. Word 3: retired. Word 4: no date yet.
  const words = [word(1, 4, '2026-10-12'), word(2, 2, '2026-10-11'), word(3, 10, '2026-10-01'), word(4, 1, null)];
  const taken = reviewed(2, -1);
  const events = [
    reviewed(1, -2),
    taken,
    event(2, { kind: 'undo', undoesId: taken.id }),
    event(4, { kind: 'practice', mode: 'recall', answerCorrect: false }),
    // A word that is in the trash now: its answers are real, but it is not scheduled at all.
    reviewed(99, -3),
    // The retired word's history is real too, and equally beside the point.
    reviewed(3, -8),
  ];
  const result = simulate(words, events, options());

  it('says exactly which saved answers it rests on', () => {
    expect(result.history).toEqual({
      reviews: 1,
      firstDay: '2026-10-07',
      lastDay: '2026-10-07',
      leftOut: { undone: 2, practice: 1, otherWords: 2 },
    });
    expect(result.words).toEqual({ active: 3, replayed: 1, unseen: 2, retired: 1 });
    expect(result).toMatchObject({ retention: 0.9, today: TODAY, days: SIMULATION_DAYS });
  });

  it('puts the live mastery date beside the date FSRS reaches from the saved answers', () => {
    const replayed = fsrsReview(null, FSRS_RATINGS.good, at(-2));
    expect(result.cards.find((card) => card.id === pageId(1))).toEqual({
      id: pageId(1),
      word: 'word-1',
      mastery: 4,
      reviews: 1,
      masteryDue: '2026-10-12',
      fsrsDue: fsrsDueDay(replayed, TIME_ZONE),
      fsrsIntervalDays: replayed.scheduledDays,
      differenceDays: -2,
    });
    expect(fsrsDueDay(replayed, TIME_ZONE)).toBe('2026-10-10');
  });

  it('leaves a word with no saved answer on its mastery date: no FSRS state is made up for it', () => {
    expect(result.cards.find((card) => card.id === pageId(2))).toMatchObject({
      reviews: 0,
      masteryDue: '2026-10-11',
      fsrsDue: '2026-10-11',
      fsrsIntervalDays: null,
      differenceDays: 0,
    });
    // No date at all means due now, under both.
    expect(result.cards.find((card) => card.id === pageId(4))).toMatchObject({ masteryDue: TODAY, fsrsDue: TODAY });
  });

  it('leaves retired words out of both sides', () => {
    expect(result.cards.map((card) => card.id)).not.toContain(pageId(3));
  });

  it('counts each word once, on the day it next falls due', () => {
    const { days, later } = result.nextDue;
    expect(days).toHaveLength(SIMULATION_DAYS);
    expect(days[0]).toEqual({ date: TODAY, mastery: 1, fsrs: 1 });
    expect(days[1]).toEqual({ date: '2026-10-10', mastery: 0, fsrs: 1 });
    expect(days[2]).toEqual({ date: '2026-10-11', mastery: 1, fsrs: 1 });
    expect(days[3]).toEqual({ date: '2026-10-12', mastery: 1, fsrs: 0 });
    expect(sum(days, 'mastery') + later.mastery).toBe(3);
    expect(sum(days, 'fsrs') + later.fsrs).toBe(3);
  });

  it('lists the words soonest first by FSRS', () => {
    expect(result.cards.map((card) => card.word)).toEqual(['word-4', 'word-1', 'word-2']);
  });

  it('counts an overdue word on the first day, and one beyond the window as later', () => {
    const overdue = simulate([word(1, 3, '2026-09-01'), word(2, 3, '2027-01-01')], [], options());
    expect(overdue.nextDue.days[0]).toEqual({ date: TODAY, mastery: 1, fsrs: 1 });
    expect(overdue.nextDue.later).toEqual({ mastery: 1, fsrs: 1 });
    // The table still shows the real date, not the day it was counted on.
    expect(overdue.cards.find((card) => card.id === pageId(1))?.masteryDue).toBe('2026-09-01');
  });

  it('changes nothing it was given', () => {
    const frozenWords = words.map((item) => Object.freeze({ ...item }));
    const frozenEvents = events.map((item) => Object.freeze({ ...item }));
    expect(() => simulate(Object.freeze(frozenWords), Object.freeze(frozenEvents), options())).not.toThrow();
  });

  it('is empty, not broken, when there is nothing to go on', () => {
    const empty = simulate([], [], options());
    expect(empty.words).toEqual({ active: 0, replayed: 0, unseen: 0, retired: 0 });
    expect(empty.history).toEqual({
      reviews: 0,
      firstDay: null,
      lastDay: null,
      leftOut: { undone: 0, practice: 0, otherWords: 0 },
    });
    expect(empty.cards).toEqual([]);
    expect(sum(empty.nextDue.days, 'mastery') + sum(empty.nextDue.days, 'fsrs')).toBe(0);
  });

  it('lists at most the limit, while the counts still cover every word', () => {
    const many = Array.from({ length: 12 }, (_, index) => word(index + 1, 2, TODAY));
    const limited = simulate(many, [], options({ limit: 5 }));
    expect(limited.cards).toHaveLength(5);
    expect(limited.words.active).toBe(12);
    expect(limited.nextDue.days[0]).toMatchObject({ mastery: 12, fsrs: 12 });
  });
});

describe('trying a different target retention', () => {
  const words = [word(1, 5, '2026-10-20')];
  const events = [reviewed(1, -30), reviewed(1, -26), reviewed(1, -15)];
  const dueAt = (retention: number) =>
    simulate(words, events, options({ settings: { requestRetention: retention } })).cards[0]!;

  it('moves only the FSRS side: a higher target brings the word back sooner', () => {
    const relaxed = dueAt(0.8);
    const standard = dueAt(0.9);
    const strict = dueAt(0.97);
    expect(relaxed.fsrsDue > standard.fsrsDue).toBe(true);
    expect(standard.fsrsDue > strict.fsrsDue).toBe(true);
    for (const card of [relaxed, standard, strict]) expect(card.masteryDue).toBe('2026-10-20');
  });

  it('reports the target it used', () => {
    expect(simulate(words, events, options({ settings: { requestRetention: 0.85 } })).retention).toBe(0.85);
  });

  it('refuses a target outside the supported range rather than guessing', () => {
    expect(() => simulate(words, events, options({ settings: { requestRetention: 0.5 } }))).toThrow(RangeError);
  });
});

describe('if every answer from here on were Remember', () => {
  it('follows the real mastery rule: each success adds the old level in days', () => {
    // Mastery 3, due today: reviewed on day 0, 3, 7, 12, 18 and 25; the next would be day 33.
    const { ifAllRemembered } = simulate([word(1, 3, TODAY)], [], options());
    const reviewedOn = ifAllRemembered!.days.filter((day) => day.mastery > 0).map((day) => day.date);
    expect(reviewedOn).toEqual([0, 3, 7, 12, 18, 25].map((offset) => addDays(TODAY, offset)));
    expect(ifAllRemembered!.totals.mastery).toBe(6);
  });

  it('counts a mastery-0 word twice on its first day, as the rule really has it', () => {
    // Remember at mastery 0 adds zero days: due again the same day, then one day on, then two, …
    const { ifAllRemembered } = simulate([word(1, 0, TODAY)], [], options({ days: 4 }));
    expect(ifAllRemembered!.days.map((day) => day.mastery)).toEqual([2, 1, 0, 1]);
  });

  it('asks FSRS for each next date in turn, starting from the replayed state', () => {
    const events = [reviewed(1, -2)];
    const { ifAllRemembered } = simulate([word(1, 4, '2026-10-12')], events, options());

    // The same walk, done here by hand with the library.
    let state: FsrsState | null = fsrsReview(null, FSRS_RATINGS.good, at(-2));
    const expected: string[] = [];
    const last = addDays(TODAY, SIMULATION_DAYS - 1);
    for (;;) {
      const due = new Date(state.due);
      const when = due.getTime() > NOW.getTime() ? due : NOW;
      const day = fsrsDueDay({ ...state, due: when.toISOString() }, TIME_ZONE);
      if (day > last) break;
      expected.push(day);
      state = fsrsReview(state, FSRS_RATINGS.good, when);
    }
    expect(ifAllRemembered!.days.filter((day) => day.fsrs > 0).map((day) => day.date)).toEqual(expected);
    expect(ifAllRemembered!.totals.fsrs).toBe(expected.length);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('brings a word FSRS has not seen up on its mastery date first', () => {
    const { ifAllRemembered } = simulate([word(1, 2, '2026-10-14')], [], options());
    const fsrsDays = ifAllRemembered!.days.filter((day) => day.fsrs > 0).map((day) => day.date);
    expect(fsrsDays[0]).toBe('2026-10-14');
    // From there FSRS spaces it: the first interval for a new word answered Good.
    const first = fsrsReview(null, FSRS_RATINGS.good, at(5));
    expect(fsrsDays[1]).toBe(fsrsDueDay(first, TIME_ZONE));
  });

  it('stops when mastery retires the word, under both schedules', () => {
    const { ifAllRemembered } = simulate([word(1, 9, TODAY)], [], options());
    expect(ifAllRemembered!.totals).toEqual({ mastery: 1, fsrs: 1 });
  });

  it('adds up: the totals are the days', () => {
    const words = [word(1, 1, TODAY), word(2, 4, '2026-10-15'), word(3, 7, '2026-09-30')];
    const { ifAllRemembered } = simulate(words, [reviewed(1, -3), reviewed(3, -10)], options());
    expect(ifAllRemembered!.totals).toEqual({
      mastery: sum(ifAllRemembered!.days, 'mastery'),
      fsrs: sum(ifAllRemembered!.days, 'fsrs'),
    });
  });

  it('is left out altogether while the Remember rule is unconfirmed', () => {
    const { ifAllRemembered, nextDue } = simulate([word(1, 3, TODAY)], [], options({ rules: { ...reviewRules, remember: null } }));
    expect(ifAllRemembered).toBeNull();
    // What is due next does not depend on that rule.
    expect(nextDue.days[0]).toMatchObject({ mastery: 1, fsrs: 1 });
  });
});
