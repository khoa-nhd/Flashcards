import type { AnalyticsResponse, WeakWordsResponse } from '../shared/api.js';
import { MIN_SAMPLE, analyseReviews } from '../shared/analytics.js';
import { addDays, calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import type { ReviewRules } from '../shared/review-logic.js';
import { classifyReviewStatus, isReviewableNow } from '../shared/vocabulary-status.js';
import { WEAK_WORD_WINDOW_DAYS, rankWeakWords, type WeakWordInput } from '../shared/weak-words.js';
import type { VocabularyCatalog } from './vocabulary-catalog.js';
import type { VocabularyRepository } from './vocabulary-repository.js';

export interface AnalyticsServiceOptions {
  repository: VocabularyRepository;
  catalog: VocabularyCatalog;
  rules: ReviewRules;
  timeZone: string;
  now?: () => Date;
}

/** How far back review activity is loaded. */
const WINDOW_DAYS = 90;
/** The most weak words sent at once; the total is always reported. */
const WEAK_WORD_LIMIT = 100;

/**
 * Reads only. Everything is computed from answers that were saved and still
 * stand, for the one account the repository belongs to.
 */
export class AnalyticsService {
  private readonly now: () => Date;

  constructor(private readonly options: AnalyticsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  async reviewAnalytics(): Promise<AnalyticsResponse> {
    const { repository, timeZone } = this.options;
    const today = this.today();
    const available = repository.capabilities.analytics;
    const rows = available ? await repository.reviewDailyStats(addDays(today, -(WINDOW_DAYS - 1)), today) : [];
    const { today: day, week, month, ...rest } = analyseReviews(rows, today, WINDOW_DAYS);
    return { available, today, timeZone, minSample: MIN_SAMPLE, periods: { today: day, week, month }, ...rest };
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
      const status = classifyReviewStatus(entry, today, rules);
      reviewable.set(entry.id, isReviewableNow(status, rules));
      return {
        id: entry.id,
        word: entry.word,
        mastery: entry.mastery,
        reviewDate: entry.reviewDate,
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
