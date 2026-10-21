/** A complete in-memory stand-in for the server, for component tests. */
import { vi } from 'vitest';
import type {
  AccountSettings,
  AiConversation,
  AiMessage,
  AnalyticsResponse,
  DayPlanResponse,
  ImportResponse,
  LibraryResponse,
  PracticeResponse,
  QueueResponse,
  SchedulerReport,
  SimulationResponse,
  ReviewActionResponse,
  ReviewCard,
  ReviewDaysResponse,
  VocabularyEntry,
  VocabularyListResponse,
  WeakWordView,
  WeakWordsResponse,
} from '../../shared/api.js';
import { EXPORT_FORMAT, EXPORT_VERSION } from '../../shared/export-format.js';
import { collectionKey, orderPair, tidyName } from '../../shared/library.js';
import { NO_GOAL, planDay, type PlanInput } from '../../shared/session-planner.js';
import { PRACTICE_MASTERY_MAX, STUDY_MODES, judge, practiceMasteryOf, type StudyMode } from '../../shared/study-modes.js';
import { normalizeWord } from '../../shared/text.js';
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
    suspended: false,
    revision: 0,
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
  /** The what-if comparison Settings shows on request. */
  simulation?: Partial<SimulationResponse>;
  /** Saved reviews per day, for the calendar. */
  reviewDays?: ReviewDaysResponse['days'];
  /** Correct practice answers already recorded, by word id and study mode. */
  practiceCorrect?: Record<string, Partial<Record<StudyMode, number>>>;
  /** False to stand in for a database that does not record practice. */
  practiceMasteryAvailable?: boolean;
  analytics?: Partial<AnalyticsResponse>;
  weakWords?: Partial<WeakWordsResponse>;
  /** The figures the day's plan is worked out from; the plan itself comes from the real planner. */
  plan?: Partial<PlanFigures>;
  /** What the server says it did with a practice answer. */
  practiceOutcome?: PracticeResponse['outcome'];
  /** Collections, further examples and links the account starts with. */
  library?: Partial<LibraryResponse>;
}

export interface PlanFigures extends PlanInput {
  /** False for a store that cannot keep a goal. */
  available: boolean;
}

/** A day with nothing reviewed, nothing due and no goal. */
export function dayPlan(figures: Partial<PlanFigures> = {}): DayPlanResponse {
  const { available = true, ...input } = figures;
  return {
    available,
    today: TODAY,
    timeZone: TIME_ZONE,
    ...planDay({
      goal: NO_GOAL,
      done: { reviews: 0, durationMs: 0 },
      due: { total: 0, overdue: 0 },
      averageMs: null,
      ...input,
    }),
  };
}

/** A comparison for a store with no saved answers: everything stays on its mastery date. */
export function simulationResponse(overrides: Partial<SimulationResponse> = {}): SimulationResponse {
  return {
    available: true,
    today: TODAY,
    timeZone: TIME_ZONE,
    retention: 0.9,
    days: 30,
    history: { reviews: 0, firstDay: null, lastDay: null, leftOut: { undone: 0, practice: 0, otherWords: 0 } },
    words: { active: 0, replayed: 0, unseen: 0, retired: 0 },
    nextDue: { days: [], later: { mastery: 0, fsrs: 0 } },
    ifAllRemembered: { days: [], totals: { mastery: 0, fsrs: 0 } },
    cards: [],
    ...overrides,
  };
}

/** A scheduler report for a store where FSRS is not available: the quietest starting point. */
export function schedulerReport(overrides: Partial<SchedulerReport> = {}): SchedulerReport {
  return {
    active: 'mastery_v1',
    fsrsOnly: false,
    switchable: false,
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
    weeks: [],
    firstReviewOn: null,
    windowDays: 90,
    calibration: { available: false, levels: [] },
    practice: { available: false, modes: [], today: { answers: 0, correct: 0 } },
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
  simulation: simulationOverrides = {},
  practiceCorrect: practiceCorrectStart = {},
  practiceMasteryAvailable = true,
  reviewDays = [],
  analytics: analyticsOverrides = {},
  weakWords: weakWordsOverrides = {},
  plan: planFigures = {},
  practiceOutcome = 'recorded',
  library: libraryStart = {},
}: FakeApiOptions = {}) {
  // Copied, so one test's changes never reach the data another test passed in.
  const library = {
    available: libraryStart.available ?? true,
    collections: (libraryStart.collections ?? []).map((item) => ({ ...item, wordIds: [...item.wordIds] })),
    examples: (libraryStart.examples ?? []).map((item) => ({ ...item })),
    relations: (libraryStart.relations ?? []).map((item) => ({ ...item })),
  };
  let goal = planFigures.goal ?? NO_GOAL;
  const analytics = analyticsResponse(analyticsOverrides);
  const weak = weakWordsResponse(weakWordsOverrides);
  const scheduler = schedulerReport(schedulerOverrides);
  const simulated = simulationResponse(simulationOverrides);
  /** Correct practice answers so far, by word and mode, and the requests already counted. */
  const practiceCorrect = new Map<string, number>(
    Object.entries(practiceCorrectStart).flatMap(([id, byMode]) =>
      Object.entries(byMode).map(([mode, correct]): [string, number] => [`${id} ${mode}`, correct ?? 0]),
    ),
  );
  const practised = new Set<string>();
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
    countReviewsTowardMastery: true,
    fsrsOnly: false,
    goals: null,
    maxReviewsPerDay: null,
    uiLanguage: 'vi',
    ...account,
  };
  let nextId = 500;
  const chats = new Map<string, { conversation: AiConversation; messages: AiMessage[] }>();

  const find = (id: string) => {
    const found = store.find((item) => item.id === id);
    if (!found) throw new ApiError('not_found', 'That word is not in the vocabulary database.', 404);
    return found;
  };

  const api = {
    // Echoes the selection it was asked for, as the server does.
    fetchQueue: vi.fn<AppApi['fetchQueue']>(async (options) => {
      const scope = options?.scope ?? { kind: 'all' };
      return queueResponse(cards, {
        focus: scope.kind === 'weak' ? 'weak' : null,
        selection: scope.kind === 'selection',
        ...queue,
      });
    }),
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
    // Like the server: refuses where the choice cannot be kept, otherwise remembers it.
    chooseScheduler: vi.fn<AppApi['chooseScheduler']>(async (next) => {
      if (!scheduler.switchable) {
        throw new ApiError('not_supported', 'The schedule cannot be changed yet: the database needs its latest update.', 409);
      }
      scheduler.active = next;
      return { ...scheduler };
    }),
    fetchSimulation: vi.fn<AppApi['fetchSimulation']>(async (retention) => ({
      ...simulated,
      retention: retention ?? simulated.retention,
    })),
    fetchAnalytics: vi.fn<AppApi['fetchAnalytics']>(async () => ({ ...analytics })),
    fetchWeakWords: vi.fn<AppApi['fetchWeakWords']>(async () => ({ ...weak })),
    fetchReviewDays: vi.fn<AppApi['fetchReviewDays']>(async (from, to) => ({
      available: true,
      from,
      to,
      days: reviewDays.filter((day) => day.date >= from && day.date <= to),
    })),
    // Creates each row through the same stand-in the Add form uses, and reports like the server.
    importWords: vi.fn<AppApi['importWords']>(async (items) => {
      const results: ImportResponse['results'] = [];
      for (const item of items) {
        const taken = store.some((existing) => normalizeWord(existing.word) === normalizeWord(item.word));
        if (taken && item.allowDuplicate !== true) {
          results.push({ outcome: 'duplicate', entry: null, message: `"${item.word}" is already in your vocabulary.` });
          continue;
        }
        const created = entry(nextId++, {
          word: item.word,
          meaning: item.meaning ?? null,
          definition: item.definition ?? null,
          example: item.example ?? null,
          dateAdded: item.dateAdded ?? TODAY,
          mastery: 1,
          reviewDate: null,
          reviewStatus: 'unscheduled',
          reviewable: true,
        });
        store.unshift(created);
        results.push({ outcome: 'imported', entry: { ...created }, message: null });
      }
      return { results, stopped: null };
    }),
    fetchExport: vi.fn<AppApi['fetchExport']>(async () => ({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: `${TODAY}T05:00:00.000Z`,
      settings: {
        timeZone: TIME_ZONE,
        dailyGoal: goal,
        fsrsRequestRetention: null,
        scheduler: scheduler.active,
        countReviewsTowardMastery: true,
      },
      counts: {
        words: store.length,
        wordsInTrash: trash.size,
        collections: library.collections.length,
        examples: library.examples.length,
        relations: library.relations.length,
        historyEvents: 0,
      },
      vocabulary: store.map((item) => ({
        id: item.id,
        word: item.word,
        meaning: item.meaning,
        definition: item.definition,
        example: item.example,
        dateAdded: item.dateAdded,
        createdAt: item.createdTime,
        updatedAt: item.lastEditedTime,
        mastery: item.mastery,
        reviewDate: item.reviewDate,
        fsrs: null,
        inTrash: false,
      })),
      collections: library.collections.map((item) => ({ ...item, wordIds: [...item.wordIds] })),
      examples: library.examples.map((item) => ({ ...item })),
      relations: library.relations.map((item) => ({ ...item })),
      reviewHistory: [],
    })),

    fetchLibrary: vi.fn<AppApi['fetchLibrary']>(async () => ({
      available: library.available,
      collections: library.collections.map((item) => ({ ...item, wordIds: [...item.wordIds] })),
      examples: library.examples.map((item) => ({ ...item })),
      relations: library.relations.map((item) => ({ ...item })),
    })),
    createCollection: vi.fn<AppApi['createCollection']>(async (name) => {
      const tidy = tidyName(name);
      if (library.collections.some((item) => collectionKey(item.name) === collectionKey(tidy))) {
        throw new ApiError('duplicate', `You already have a collection called “${tidy}”.`, 409);
      }
      const made = { id: pageId(nextId++), name: tidy, wordIds: [] as string[] };
      library.collections.push(made);
      return { ...made };
    }),
    renameCollection: vi.fn<AppApi['renameCollection']>(async (id, name) => {
      const found = library.collections.find((item) => item.id === id);
      if (!found) throw new ApiError('not_found', 'There is no such collection.', 404);
      found.name = tidyName(name);
      return { ...found, wordIds: [...found.wordIds] };
    }),
    deleteCollection: vi.fn<AppApi['deleteCollection']>(async (id) => {
      library.collections = library.collections.filter((item) => item.id !== id);
    }),
    setMembership: vi.fn<AppApi['setMembership']>(async (collectionId, wordId, member) => {
      const found = library.collections.find((item) => item.id === collectionId);
      if (!found) throw new ApiError('not_found', 'There is no such collection.', 404);
      found.wordIds = found.wordIds.filter((existing) => existing !== wordId);
      if (member) found.wordIds.push(wordId);
      return { ...found, wordIds: [...found.wordIds] };
    }),
    addExample: vi.fn<AppApi['addExample']>(async (wordId, input) => {
      const made = {
        id: pageId(nextId++),
        vocabularyId: wordId,
        sentence: input.sentence.trim(),
        source: input.source?.trim() || null,
        preferred: input.preferred === true,
      };
      library.examples.push(made);
      return { ...made };
    }),
    updateExample: vi.fn<AppApi['updateExample']>(async (id, input) => {
      const found = library.examples.find((item) => item.id === id);
      if (!found) throw new ApiError('not_found', 'There is no such example.', 404);
      if (input.preferred === true) {
        for (const other of library.examples) if (other.vocabularyId === found.vocabularyId) other.preferred = false;
      }
      Object.assign(found, {
        sentence: input.sentence?.trim() ?? found.sentence,
        source: input.source === undefined ? found.source : input.source?.trim() || null,
        preferred: input.preferred ?? found.preferred,
      });
      return { ...found };
    }),
    deleteExample: vi.fn<AppApi['deleteExample']>(async (id) => {
      library.examples = library.examples.filter((item) => item.id !== id);
    }),
    addRelation: vi.fn<AppApi['addRelation']>(async (fromId, toId, kind) => {
      const pair = orderPair(fromId, toId);
      if (pair === null) throw new ApiError('invalid_request', 'A word cannot be related to itself.', 400);
      const existing = library.relations.find((item) => item.a === pair[0] && item.b === pair[1] && item.kind === kind);
      if (existing) return { ...existing };
      const made = { id: pageId(nextId++), kind, a: pair[0], b: pair[1] };
      library.relations.push(made);
      return { ...made };
    }),
    deleteRelation: vi.fn<AppApi['deleteRelation']>(async (id) => {
      library.relations = library.relations.filter((item) => item.id !== id);
    }),

    // Judges with the real rules, from the words the test supplied.
    submitPractice: vi.fn<AppApi['submitPractice']>(async (request) => {
      const found = store.find((item) => item.id === request.pageId);
      const judged = found === undefined ? null : judge(request.mode, found, request.answer);
      if (judged === null) throw new ApiError('invalid_request', 'That answer does not fit this study mode.', 400);
      const recorded = practiceOutcome !== 'dry_run';
      // Counted the way the server counts: once per request id, correct answers only.
      const key = `${request.pageId} ${request.mode}`;
      if (recorded && judged.correct && !practised.has(request.requestId)) {
        practised.add(request.requestId);
        practiceCorrect.set(key, (practiceCorrect.get(key) ?? 0) + 1);
      }
      return {
        outcome: practiceOutcome,
        correct: judged.correct,
        typed: judged.typed,
        expected: judged.expected,
        modeMastery: recorded ? practiceMasteryOf(practiceCorrect.get(key) ?? 0) : null,
      };
    }),
    fetchPracticeMastery: vi.fn<AppApi['fetchPracticeMastery']>(async (id) => ({
      available: practiceMasteryAvailable,
      max: PRACTICE_MASTERY_MAX,
      modes: practiceMasteryAvailable
        ? STUDY_MODES.map((mode) => {
            const correct = practiceCorrect.get(`${id} ${mode}`) ?? 0;
            return { mode, correct, mastery: practiceMasteryOf(correct) };
          })
        : [],
    })),
    fetchPracticeHistory: vi.fn<AppApi['fetchPracticeHistory']>(async () => ({
      available: practiceMasteryAvailable,
      answers: [],
    })),
    fetchPlan: vi.fn<AppApi['fetchPlan']>(async () => dayPlan({ ...planFigures, goal })),
    saveGoal: vi.fn<AppApi['saveGoal']>(async (next) => {
      goal = next;
      return dayPlan({ ...planFigures, goal });
    }),
    saveSettings: vi.fn<AppApi['saveSettings']>(async ({ timeZone, fsrsRetention, countReviewsTowardMastery, countReviewsTowardSchedule, maxReviewsPerDay, uiLanguage }) => {
      if (timeZone !== undefined) settings.timeZone = timeZone;
      if (fsrsRetention !== undefined) settings.fsrsRetention = fsrsRetention;
      if (countReviewsTowardMastery !== undefined) settings.countReviewsTowardMastery = countReviewsTowardMastery;
      if (countReviewsTowardSchedule !== undefined) settings.countReviewsTowardSchedule = countReviewsTowardSchedule;
      if (maxReviewsPerDay !== undefined) settings.maxReviewsPerDay = maxReviewsPerDay;
      if (uiLanguage !== undefined) settings.uiLanguage = uiLanguage;
      return { ...settings };
    }),

    // ---- AI Chat: kept in memory; a reply repeats the message, sent in awkwardly cut pieces ----
    listConversations: vi.fn<AppApi['listConversations']>(async () => ({ conversations: [...chats.values()].map((chat) => chat.conversation) })),
    createConversation: vi.fn<AppApi['createConversation']>(async (mode, title) => {
      const at = new Date().toISOString();
      const conversation = { id: pageId(nextId++), mode, title: title ?? 'New conversation', createdAt: at, updatedAt: at };
      chats.set(conversation.id, { conversation, messages: [] });
      return conversation;
    }),
    getConversation: vi.fn<AppApi['getConversation']>(async (id) => {
      const chat = chats.get(id);
      if (chat === undefined) throw new ApiError('not_found', 'Conversation not found.', 404);
      return { conversation: chat.conversation, messages: [...chat.messages] };
    }),
    updateConversation: vi.fn<AppApi['updateConversation']>(async (id, title) => {
      const chat = chats.get(id);
      if (chat !== undefined) chat.conversation = { ...chat.conversation, title };
    }),
    deleteConversation: vi.fn<AppApi['deleteConversation']>(async (id) => {
      chats.delete(id);
    }),
    sendMessage: vi.fn<AppApi['sendMessage']>(async (id, content) => {
      const chat = chats.get(id);
      if (chat === undefined) throw new ApiError('not_found', 'Conversation not found.', 404);
      const reply = `You said **${content}**.`;
      const at = new Date().toISOString();
      if (chat.messages.length === 0) chat.conversation = { ...chat.conversation, title: content.slice(0, 60) };
      chat.messages.push(
        { id: pageId(nextId++), role: 'user', content, metadata: {}, createdAt: at },
        { id: pageId(nextId++), role: 'assistant', content: reply, metadata: {}, createdAt: at },
      );
      const events =
        `data: ${JSON.stringify({ type: 'delta', delta: reply.slice(0, 5) })}\n\n` +
        `data: ${JSON.stringify({ type: 'delta', delta: reply.slice(5) })}\n\n` +
        `data: ${JSON.stringify({ type: 'done', usage: null, finishReason: 'stop' })}\n\n`;
      const bytes = new TextEncoder().encode(events);
      // Cut mid-event, as a network may.
      const cut = Math.floor(bytes.length / 3);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut, cut * 2));
          controller.enqueue(bytes.slice(cut * 2));
          controller.close();
        },
      });
    }),
    markMessageSaved: vi.fn<AppApi['markMessageSaved']>(async (conversationId, messageId, vocabularyId) => {
      const chat = chats.get(conversationId);
      const message = chat?.messages.find((item) => item.id === messageId);
      if (message === undefined) return { saved: false };
      const metadata = typeof message.metadata === 'object' && message.metadata !== null ? message.metadata : {};
      message.metadata = { ...metadata, vocabularyId, savedAt: new Date().toISOString() };
      return { saved: true };
    }),
  } satisfies AppApi;

  return { api, saves, store, chats };
}
