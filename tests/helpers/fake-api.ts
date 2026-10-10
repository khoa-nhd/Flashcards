/** A complete in-memory stand-in for the server, for component tests. */
import { vi } from 'vitest';
import type {
  AccountSettings,
  AnalyticsResponse,
  QueueResponse,
  SchedulerReport,
  ReviewActionResponse,
  ReviewCard,
  VocabularyEntry,
  VocabularyListResponse,
  WeakWordView,
  WeakWordsResponse,
} from '../../shared/api.js';
import { ApiError, type AppApi } from '../../src/lib/api-client.js';
import { TIME_ZONE, TODAY, deferred, pageId, queueResponse, type Deferred } from './fixtures.js';

export function entry(n: number, overrides: Partial<VocabularyEntry> = {}): VocabularyEntry {
  return {
    id: pageId(n),
    word: `word-${n}`,
    meaning: `nghĩa ${n}`,
    definition: `definition of word-${n}`,
    example: `example for word-${n}`,
    mastery: 3,
    reviewDate: TODAY,
    dateAdded: '2026-10-01',
    reviewStatus: 'due_today',
    reviewable: true,
    createdTime: '2026-10-01T02:00:00.000Z',
    lastEditedTime: '2026-10-05T02:00:00.000Z',
    ...overrides,
  };
}

export function vocabularyList(
  entries: VocabularyEntry[],
  overrides: Partial<VocabularyListResponse> = {},
): VocabularyListResponse {
  return {
    entries,
    today: TODAY,
    timeZone: TIME_ZONE,
    mode: 'supabase',
    writesEnabled: true,
    skipped: [],
    defaults: { mastery: 1, reviewDate: 'empty' },
    ...overrides,
  };
}

export interface FakeApiOptions {
  cards?: ReviewCard[];
  queue?: Partial<QueueResponse>;
  entries?: VocabularyEntry[];
  list?: Partial<VocabularyListResponse>;
  /** Words already in the trash. */
  trashed?: VocabularyEntry[];
  account?: Partial<AccountSettings>;
  scheduler?: Partial<SchedulerReport>;
  analytics?: Partial<AnalyticsResponse>;
  weakWords?: Partial<WeakWordsResponse>;
}

/** A scheduler report for a store where FSRS is not available: the quietest starting point. */
export function schedulerReport(overrides: Partial<SchedulerReport> = {}): SchedulerReport {
  return {
    active: 'mastery_v1',
    today: TODAY,
    timeZone: TIME_ZONE,
    fsrs: {
      available: false,
      engine: 'v5.4.2 using FSRS-6.0',
      requestRetention: 0.9,
      ratings: { remember: 'Good', notRemember: 'Again' },
    },
    totalCards: 0,
    comparable: 0,
    cards: [],
    workload: [],
    ...overrides,
  };
}

type PeriodStats = AnalyticsResponse['periods']['today'];

/** One period of review figures; nothing reviewed unless a test says otherwise. */
export function periodStats(overrides: Partial<PeriodStats> = {}): PeriodStats {
  return {
    from: TODAY,
    to: TODAY,
    reviews: 0,
    remembered: 0,
    notRemembered: 0,
    accuracy: null,
    repeatReviews: 0,
    retention: null,
    durationMs: 0,
    timedReviews: 0,
    averageMs: null,
    activeDays: 0,
    ...overrides,
  };
}

/** Review activity for a store that keeps history but has none yet. */
export function analyticsResponse(overrides: Partial<AnalyticsResponse> = {}): AnalyticsResponse {
  return {
    available: true,
    today: TODAY,
    timeZone: TIME_ZONE,
    minSample: 5,
    periods: { today: periodStats(), week: periodStats(), month: periodStats() },
    streak: { current: 0, longest: 0 },
    byMode: [],
    days: [],
    firstReviewOn: null,
    windowDays: 90,
    ...overrides,
  };
}

export function weakWord(n: number, overrides: Partial<WeakWordView> = {}): WeakWordView {
  return {
    id: pageId(n),
    word: `word-${n}`,
    mastery: 3,
    score: 5,
    severity: 'medium',
    reasons: [{ code: 'recent_failures', points: 4, detail: 'Not remembered 2 times in the last 30 days.' }],
    recent: { reviews: 4, remembered: 2 },
    action: 'Review it again soon.',
    reviewable: true,
    ...overrides,
  };
}

/** No weak words unless a test supplies some; the total follows the words given. */
export function weakWordsResponse(overrides: Partial<WeakWordsResponse> = {}): WeakWordsResponse {
  const words = overrides.words ?? [];
  return { historyAvailable: true, today: TODAY, windowDays: 30, total: words.length, ...overrides, words };
}

export function createFakeApi({
  cards = [],
  queue = {},
  entries = [],
  list = {},
  trashed = [],
  account = {},
  scheduler: schedulerOverrides = {},
  analytics: analyticsOverrides = {},
  weakWords: weakWordsOverrides = {},
}: FakeApiOptions = {}) {
  const analytics = analyticsResponse(analyticsOverrides);
  const weak = weakWordsResponse(weakWordsOverrides);
  const scheduler = schedulerReport(schedulerOverrides);
  /** Review saves stay pending until a test settles them. */
  const saves: Array<Deferred<ReviewActionResponse>> = [];
  const store = entries.map((item) => ({ ...item }));
  const trash = new Map<string, VocabularyEntry>(trashed.map((item) => [item.id, { ...item }]));
  const settings: AccountSettings = {
    timeZone: TIME_ZONE,
    timeZoneEditable: true,
    email: 'me@example.test',
    database: null,
    fsrsRetention: null,
    ...account,
  };
  let nextId = 500;

  const find = (id: string) => {
    const found = store.find((item) => item.id === id);
    if (!found) throw new ApiError('not_found', 'That word is not in the vocabulary database.', 404);
    return found;
  };

  const api = {
    // Echoes the focus it was asked for, as the server does.
    fetchQueue: vi.fn<AppApi['fetchQueue']>(async (options) =>
      queueResponse(cards, { focus: options?.focus ?? null, ...queue }),
    ),
    submitAction: vi.fn<AppApi['submitAction']>(() => {
      const pending = deferred<ReviewActionResponse>();
      saves.push(pending);
      return pending.promise;
    }),
    // Succeeds by default; a test that cares about the outcome replaces it.
    undoAction: vi.fn<AppApi['undoAction']>(async () => ({
      outcome: 'undone',
      pageId: cards[0]?.id ?? pageId(1),
      state: { mastery: 3, nextReview: TODAY },
    })),
    fetchSessionSummary: vi.fn<AppApi['fetchSessionSummary']>(async () => {
      throw new ApiError('not_found', 'No answers were saved in that session.', 404);
    }),
    fetchVocabulary: vi.fn<AppApi['fetchVocabulary']>(async () => vocabularyList(store.map((item) => ({ ...item })), list)),
    fetchEntry: vi.fn<AppApi['fetchEntry']>(async (id) => ({ ...find(id) })),
    createEntry: vi.fn<AppApi['createEntry']>(async (input) => {
      const created = entry(nextId++, {
        word: input.word.trim(),
        meaning: input.meaning?.trim() || null,
        definition: input.definition?.trim() || null,
        example: input.example?.trim() || null,
        dateAdded: input.dateAdded ?? TODAY,
        mastery: input.mastery ?? 1,
        reviewDate: input.reviewDate ?? null,
        reviewStatus: input.reviewDate ? 'upcoming' : 'unscheduled',
        reviewable: !input.reviewDate,
      });
      store.unshift(created);
      return { ...created };
    }),
    updateEntry: vi.fn<AppApi['updateEntry']>(async (id, input) => {
      const current = find(id);
      const text = (value: string | undefined, before: string | null) =>
        value === undefined ? before : value.trim() === '' ? null : value.trim();
      Object.assign(current, {
        word: input.word?.trim() ?? current.word,
        meaning: text(input.meaning, current.meaning),
        definition: text(input.definition, current.definition),
        example: text(input.example, current.example),
        dateAdded: input.dateAdded === undefined ? current.dateAdded : input.dateAdded,
        mastery: input.schedule?.mastery ?? current.mastery,
        reviewDate: input.schedule === undefined ? current.reviewDate : input.schedule.reviewDate,
      });
      return { ...current };
    }),
    deleteEntry: vi.fn<AppApi['deleteEntry']>(async (id) => {
      const current = find(id);
      store.splice(store.indexOf(current), 1);
      trash.set(id, current);
    }),
    restoreEntry: vi.fn<AppApi['restoreEntry']>(async (id) => {
      const restored = trash.get(id);
      if (!restored) throw new ApiError('not_found', 'That word is not in the vocabulary database.', 404);
      trash.delete(id);
      store.unshift(restored);
      return { ...restored };
    }),
    fetchTrash: vi.fn<AppApi['fetchTrash']>(async () => [...trash.values()].map((item) => ({ ...item }))),

    fetchSettings: vi.fn<AppApi['fetchSettings']>(async () => ({ ...settings })),
    fetchScheduler: vi.fn<AppApi['fetchScheduler']>(async () => ({ ...scheduler })),
    fetchAnalytics: vi.fn<AppApi['fetchAnalytics']>(async () => ({ ...analytics })),
    fetchWeakWords: vi.fn<AppApi['fetchWeakWords']>(async () => ({ ...weak })),
    saveSettings: vi.fn<AppApi['saveSettings']>(async ({ timeZone, fsrsRetention }) => {
      if (timeZone !== undefined) settings.timeZone = timeZone;
      if (fsrsRetention !== undefined) settings.fsrsRetention = fsrsRetention;
      return { ...settings };
    }),
  } satisfies AppApi;

  return { api, saves, store };
}
