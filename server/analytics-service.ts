import type {
  AnalyticsResponse,
  Confidence,
  DayPlanResponse,
  ReviewDaysResponse,
  WeakWordsResponse,
} from '../shared/api.js';
import { RECENTLY_ADDED_DAYS, REVIEW_DAYS_MAX } from '../shared/api.js';
import { MIN_SAMPLE, analyseReviews } from '../shared/analytics.js';
import { addDays, calendarDateInTimeZone, compareDates, daysBetween, type IsoDate } from '../shared/dates.js';
import type { ReviewRules } from '../shared/review-logic.js';
import { dueDateUnder } from '../shared/scheduler/active.js';
import { goalProblem, planDay, type DailyGoal } from '../shared/session-planner.js';
import { classifyReviewStatus, isReviewableNow } from '../shared/vocabulary-status.js';
import { WEAK_WORD_WINDOW_DAYS, rankWeakWords, type WeakWordInput } from '../shared/weak-words.js';
import { HttpError } from './errors.js';
import { NO_GOAL_STORE, type GoalStore } from './goal-store.js';
import { MASTERY_ONLY, type SchedulerStore } from './scheduler-store.js';
import type { EntryData, VocabularyCatalog } from './vocabulary-catalog.js';
import type { VocabularyRepository } from './vocabulary-repository.js';

export interface AnalyticsServiceOptions {
  repository: VocabularyRepository;
  catalog: VocabularyCatalog;
  rules: ReviewRules;
  timeZone: string;
  /** Where the daily goal is kept. Without one, the plan simply has no goal. */
  goals?: GoalStore;
  /** Which schedule decides when a word is due. Without one, the mastery schedule. */
  scheduler?: SchedulerStore;
  /**
   * Whether saving is switched on at all (REVIEW_WRITES_ENABLED). The goal is
   * a stored setting like any other write, so it obeys the same switch.
   * Defaults to on, so a store built without the flag keeps working.
   */
  writesRequested?: boolean;
  now?: () => Date;
}

/** How far back review activity is loaded. */
const WINDOW_DAYS = 90;
/** The period the reviewer's pace and confidence are judged over. */
const RECENT_DAYS = 30;
/** The most weak words sent at once; the total is always reported. */
const WEAK_WORD_LIMIT = 100;

const CONFIDENCE_LEVELS: Confidence[] = [1, 2, 3];

/**
 * Reads only, except for storing the goal itself. Everything is computed from
 * answers that were saved and still stand, for the one account the repository
 * belongs to.
 */
export class AnalyticsService {
  private readonly now: () => Date;
  private readonly goals: GoalStore;
  private readonly scheduler: SchedulerStore;
  /** Saving is on unless the caller says otherwise; the flag is REVIEW_WRITES_ENABLED. */
  private readonly writesRequested: boolean;

  constructor(private readonly options: AnalyticsServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.goals = options.goals ?? NO_GOAL_STORE;
    this.scheduler = options.scheduler ?? MASTERY_ONLY;
    this.writesRequested = options.writesRequested ?? true;
  }

  /** A word's mastery with the review date the schedule in charge gives it: what "due" is judged by. */
  private scheduled(entry: EntryData): { mastery: number | null; reviewDate: IsoDate | null } {
    return {
      mastery: entry.mastery,
      reviewDate: dueDateUnder(this.scheduler.get(), entry, this.options.timeZone),
    };
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  async reviewAnalytics(): Promise<AnalyticsResponse> {
    const { repository, timeZone } = this.options;
    const today = this.today();
    const available = repository.capabilities.analytics;
    const keepsConfidence = repository.capabilities.confidence;
    const keepsPractice = repository.capabilities.practice;
    const recentStart = addDays(today, -(RECENT_DAYS - 1));
    const [rows, rated, practised] = await Promise.all([
      available ? repository.reviewDailyStats(addDays(today, -(WINDOW_DAYS - 1)), today) : [],
      keepsConfidence ? repository.confidenceStats(recentStart) : [],
      keepsPractice ? repository.practiceDailyStats(recentStart, today) : [],
    ]);

    // One total per mode: recognising a meaning and producing a word are different skills.
    const modes = new Map<string, { answers: number; correct: number }>();
    const practisedToday = { answers: 0, correct: 0 };
    for (const row of practised) {
      const mode = modes.get(row.mode) ?? { answers: 0, correct: 0 };
      mode.answers += row.answers;
      mode.correct += row.correct;
      modes.set(row.mode, mode);
      if (row.day === today) {
        practisedToday.answers += row.answers;
        practisedToday.correct += row.correct;
      }
    }
    const { today: day, week, month, ...rest } = analyseReviews(rows, today, WINDOW_DAYS);
    return {
      available,
      today,
      timeZone,
      minSample: MIN_SAMPLE,
      periods: { today: day, week, month },
      ...rest,
      calibration: {
        available: keepsConfidence,
        // Every level, so a level nobody has used reads as zero rather than as missing.
        levels: CONFIDENCE_LEVELS.map((confidence) => {
          const found = rated.find((level) => level.confidence === confidence);
          const reviews = found?.reviews ?? 0;
          const remembered = found?.remembered ?? 0;
          return { confidence, reviews, remembered, accuracy: reviews >= MIN_SAMPLE ? remembered / reviews : null };
        }),
      },
      practice: {
        available: keepsPractice,
        modes: [...modes]
          .map(([mode, totals]) => ({
            mode,
            ...totals,
            accuracy: totals.answers >= MIN_SAMPLE ? totals.correct / totals.answers : null,
          }))
          .sort((a, b) => b.answers - a.answers || a.mode.localeCompare(b.mode)),
        today: practisedToday,
      },
    };
  }

  /**
   * Saved reviews on each of the reviewer's days in a range, for the calendar.
   * Only days with at least one review are listed. Answers taken back with
   * Undo are not counted, as everywhere else.
   */
  async reviewDays(from: IsoDate, to: IsoDate): Promise<ReviewDaysResponse> {
    const { repository } = this.options;
    if (compareDates(from, to) > 0) {
      throw new HttpError(400, 'invalid_request', 'The range must start on or before the day it ends.');
    }
    if (daysBetween(from, to) >= REVIEW_DAYS_MAX) {
      throw new HttpError(400, 'invalid_request', `The range can cover at most ${REVIEW_DAYS_MAX} days.`);
    }
    const available = repository.capabilities.analytics;
    const byDay = new Map<IsoDate, { date: IsoDate; reviews: number; remembered: number }>();
    for (const row of available ? await repository.reviewDailyStats(from, to) : []) {
      const day = byDay.get(row.day) ?? { date: row.day, reviews: 0, remembered: 0 };
      day.reviews += row.reviews;
      day.remembered += row.remembered;
      byDay.set(row.day, day);
    }
    return {
      available,
      from,
      to,
      days: [...byDay.values()].filter((day) => day.reviews > 0).sort((a, b) => compareDates(a.date, b.date)),
    };
  }

  /**
   * Today's reviewing set against the daily goal. The goal is a yardstick
   * only: nothing here selects, hides or reschedules a card.
   */
  async dayPlan(): Promise<DayPlanResponse> {
    const { repository, catalog, rules, timeZone } = this.options;
    const today = this.today();
    const [{ entries }, rows] = await Promise.all([
      catalog.listEntries(),
      repository.capabilities.analytics ? repository.reviewDailyStats(addDays(today, -(RECENT_DAYS - 1)), today) : [],
    ]);

    let total = 0;
    let overdue = 0;
    for (const entry of entries) {
      const status = classifyReviewStatus(this.scheduled(entry), today, rules);
      if (isReviewableNow(status, rules)) total += 1;
      if (status === 'overdue') overdue += 1;
    }

    const { today: day, month } = analyseReviews(rows, today, RECENT_DAYS);
    return {
      available: this.goals.available,
      today,
      timeZone,
      ...planDay({
        goal: this.goals.get(),
        done: { reviews: day.reviews, durationMs: day.durationMs },
        due: { total, overdue },
        // The reviewer's own pace, and only once there is enough of it to go by.
        averageMs: month.timedReviews >= MIN_SAMPLE ? month.averageMs : null,
      }),
    };
  }

  async saveGoal(goal: DailyGoal): Promise<DayPlanResponse> {
    if (!this.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    if (!this.goals.available) {
      throw new HttpError(409, 'not_supported', 'A daily goal cannot be kept yet: the database needs its latest update.');
    }
    const problem = goalProblem(goal);
    if (problem !== null) throw new HttpError(400, 'invalid_request', problem);
    await this.goals.save(goal);
    return this.dayPlan();
  }

  /** Live words added within the last few days, today included. */
  async recentlyAddedIds(): Promise<string[]> {
    const today = this.today();
    const since = addDays(today, -(RECENTLY_ADDED_DAYS - 1));
    const { entries } = await this.options.catalog.listEntries();
    return entries
      .filter(
        (entry) =>
          entry.dateAdded !== null && compareDates(entry.dateAdded, since) >= 0 && compareDates(entry.dateAdded, today) <= 0,
      )
      .map((entry) => entry.id);
  }

  /** Every live word with something against it, weakest first, each with its reasons. */
  async weakWords(): Promise<WeakWordsResponse> {
    const { repository, catalog, rules } = this.options;
    const today = this.today();
    const historyAvailable = repository.capabilities.analytics;
    const [{ entries }, histories] = await Promise.all([
      catalog.listEntries(),
      historyAvailable ? repository.cardReviewStats(addDays(today, -(WEAK_WORD_WINDOW_DAYS - 1))) : new Map(),
    ]);

    const reviewable = new Map<string, boolean>();
    const inputs: WeakWordInput[] = entries.map((entry) => {
      const scheduled = this.scheduled(entry);
      const status = classifyReviewStatus(scheduled, today, rules);
      reviewable.set(entry.id, isReviewableNow(status, rules));
      return {
        id: entry.id,
        word: entry.word,
        mastery: entry.mastery,
        reviewDate: scheduled.reviewDate,
        retired: status === 'mastered',
        meaning: entry.meaning,
        definition: entry.definition,
        example: entry.example,
        history: histories.get(entry.id) ?? null,
      };
    });

    const ranked = rankWeakWords(inputs, today);
    return {
      historyAvailable,
      today,
      windowDays: WEAK_WORD_WINDOW_DAYS,
      total: ranked.length,
      words: ranked.slice(0, WEAK_WORD_LIMIT).map((word) => ({ ...word, reviewable: reviewable.get(word.id) ?? false })),
    };
  }
}
