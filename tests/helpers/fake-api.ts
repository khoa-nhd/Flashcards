/** A complete in-memory stand-in for the server, for component tests. */
import { vi } from 'vitest';
import type {
  AccountSettings,
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
  Sense,
  VocabularyEntry,
  VocabularyListResponse,
  WeakWordView,
  WeakWordsResponse,
} from '../../shared/api.js';
import { NO_CAPABILITIES } from '../../shared/api.js';
import { EXPORT_FORMAT, EXPORT_VERSION } from '../../shared/export-format.js';
import { collectionKey, orderPair, tidyName } from '../../shared/library.js';
import {
  LIBRARY_RELATION_TO_EDGE,
  type MapEdgeKind,
  type PersonalMapResponse,
  type VocabMapDocument,
  type VocabMapEdge,
  type VocabMapNode,
  type VocabMapSummary,
} from '../../shared/vocab-map.js';
import { NO_GOAL, planDay, type PlanInput } from '../../shared/session-planner.js';
import {
  DISCOVERY_LIMITS,
  sentenceAround,
  tidyDiscoveryContent,
  tidyDiscoveryLabel,
  tidyDiscoveryTitle,
  type DiscoveryContentKind,
  type DiscoveryMark,
  type DiscoveryMarkView,
  type DiscoverySource,
  type DiscoverySourceDocument,
  type DiscoverySourceKind,
} from '../../shared/discovery.js';
import { sentenceContaining } from '../../shared/sentences.js';
import { judge } from '../../shared/study-modes.js';
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
    rootId: null,
    senses: [],
    sensesVersion: 0,
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
    capabilities: NO_CAPABILITIES,
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
  analytics?: Partial<AnalyticsResponse>;
  weakWords?: Partial<WeakWordsResponse>;
  /** The figures the day's plan is worked out from; the plan itself comes from the real planner. */
  plan?: Partial<PlanFigures>;
  /** What the server says it did with a practice answer. */
  practiceOutcome?: PracticeResponse['outcome'];
  /** Collections, further examples and links the account starts with. */
  library?: Partial<LibraryResponse>;
  /** Maps the account starts with; their saved nodes' text is read from `entries`. */
  maps?: VocabMapDocument[];
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
  reviewDays = [],
  analytics: analyticsOverrides = {},
  weakWords: weakWordsOverrides = {},
  plan: planFigures = {},
  practiceOutcome = 'recorded',
  library: libraryStart = {},
  maps: mapStart = [],
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

  // Vocabulary maps, kept in memory. The rules live on the server; this keeps
  // the shapes honest and, above all, the line between a saved word and a
  // suggestion: only saveCandidate crosses it.
  const mapDocs = new Map<string, VocabMapDocument>(
    mapStart.map((doc) => [doc.id, { ...doc, nodes: doc.nodes.map((node) => ({ ...node })), edges: doc.edges.map((edge) => ({ ...edge })) }]),
  );
  let mapCounter = 0;
  let nodeCounter = 0;
  let edgeCounter = 0;
  const wordOf = (id: string): { id: string; word: string; meaning: string | null } | null => {
    const found = store.find((item) => item.id === id);
    return found === undefined ? null : { id: found.id, word: found.word, meaning: found.meaning };
  };
  const summaryOf = (doc: VocabMapDocument): VocabMapSummary => ({
    id: doc.id,
    type: doc.type,
    title: doc.title,
    description: doc.description,
    revision: doc.revision,
    nodeCount: doc.nodes.length,
    edgeCount: doc.edges.length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
  const bump = (doc: VocabMapDocument) => {
    doc.revision += 1;
    doc.updatedAt = new Date().toISOString();
  };
  const documentOf = (id: string): VocabMapDocument => {
    const doc = mapDocs.get(id);
    if (doc === undefined) throw new ApiError('not_found', 'That map is not yours.', 404);
    // Saved nodes' text is read live from the words, never copied into the map.
    return {
      ...doc,
      nodeCount: doc.nodes.length,
      edgeCount: doc.edges.length,
      nodes: doc.nodes.map((node) =>
        node.kind === 'saved' && node.vocabularyId !== null ? { ...node, word: wordOf(node.vocabularyId) } : { ...node },
      ),
      edges: doc.edges.map((edge) => ({ ...edge })),
    };
  };

  const find = (id: string) => {
    const found = store.find((item) => item.id === id);
    if (!found) throw new ApiError('not_found', 'That word is not in the vocabulary database.', 404);
    return found;
  };

  // Discovery & Input, kept like the server's rows: sources hold their
  // content and their marks, and only saveSelection / saveMark cross into
  // vocabulary — exactly the two explicit presses. Marking, dismissing,
  // moving a position, previewing and generating touch only these rows and
  // never a schedule, a log or a practice answer.
  /** The wire mark plus the submission key the server keeps for idempotency. */
  type FakeMark = DiscoveryMark & { requestId: string | null };

  interface DiscoveryRow {
    id: string;
    kind: DiscoverySourceKind;
    title: string;
    origin: string;
    contentKind: DiscoveryContentKind;
    position: { offset?: number; seconds?: number };
    revision: number;
    createdAt: string;
    updatedAt: string;
    content: string;
    requestId: string | null;
    marks: FakeMark[];
  }

  const discovery: DiscoveryRow[] = [];
  let discoveryCounter = 900;
  let discoveryMarkCounter = 400;
  const discoveryId = () => `disc-${String((discoveryCounter += 1)).padStart(4, '0')}`;
  const discoveryMarkId = () => `dmark-${String((discoveryMarkCounter += 1)).padStart(4, '0')}`;
  const iso = () => new Date().toISOString();
  const discoveryByRequest = new Map<string, DiscoveryRow>();
  const entryByRequest = new Map<string, VocabularyEntry>();
  const clampOffset = (offset: number | undefined, content: string): number | null =>
    offset === undefined ? null : Math.max(0, Math.min(offset, Math.max(0, content.length - 1)));
  const allDiscoveryMarks = (): Array<{ mark: FakeMark; source: DiscoveryRow }> =>
    discovery.flatMap((source) => source.marks.map((mark) => ({ mark, source })));
  const discoverySummary = (row: DiscoveryRow): DiscoverySource => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    origin: row.origin,
    contentKind: row.contentKind,
    position: { ...row.position },
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    markedCount: row.marks.filter((mark) => mark.savedAt === null).length,
    savedCount: row.marks.filter((mark) => mark.savedAt !== null).length,
  });
  const discoveryDocument = (row: DiscoveryRow): DiscoverySourceDocument => ({
    ...discoverySummary(row),
    content: row.content,
    marks: row.marks.map((mark) => ({ ...mark })),
  });
  const discoveryMarkView = (mark: DiscoveryMark, source: DiscoveryRow): DiscoveryMarkView => ({
    ...mark,
    sourceTitle: source.title,
    sourceKind: source.kind,
  });
  const requireSourceRow = (id: string): DiscoveryRow => {
    const found = discovery.find((row) => row.id === id);
    if (found === undefined) throw new ApiError('not_found', 'That source is not yours.', 404);
    return found;
  };
  const requireMarkRow = (id: string): { mark: FakeMark; source: DiscoveryRow } => {
    const found = allDiscoveryMarks().find((entry) => entry.mark.id === id);
    if (found === undefined) throw new ApiError('not_found', 'That selection is not yours.', 404);
    return found;
  };
  /** The word path, as the server runs it: same submission answers once, duplicate refused with the existing words in hand. */
  const wordForSelection = (input: {
    word: string;
    requestId: string;
    meaning?: string | undefined;
    definition?: string | undefined;
    example?: string | undefined;
    dateAdded?: string | undefined;
    mastery?: number | undefined;
    reviewDate?: string | null | undefined;
    allowDuplicate?: boolean | undefined;
  }): VocabularyEntry => {
    const repeated = entryByRequest.get(input.requestId);
    if (repeated !== undefined) return { ...repeated };
    const tidy = input.word.trim().replace(/\s+/g, ' ');
    const clash = store.find((item) => normalizeWord(item.word) === normalizeWord(tidy));
    if (clash !== undefined && input.allowDuplicate !== true) {
      throw new ApiError('duplicate', `"${tidy}" is already in your vocabulary.`, 409, [{ ...clash }]);
    }
    const created = entry(nextId++, {
      word: tidy,
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
    entryByRequest.set(input.requestId, created);
    return { ...created };
  };

  const api = {
    // Echoes the selection it was asked for, as the server does.
    fetchQueue: vi.fn<AppApi['fetchQueue']>(async (options) => {
      const wanted = options?.collection ?? null;
      const collection =
        wanted === null
          ? null
          : { id: wanted, name: library.collections.find((item) => item.id === wanted)?.name ?? 'Collection' };
      return queueResponse(cards, { focus: options?.focus ?? null, collection, ...queue });
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

    // ---- Senses (schema version 13) ----
    listSenses: vi.fn<AppApi['listSenses']>(async (vocabularyId) =>
      find(vocabularyId).senses.map((sense) => ({ ...sense })),
    ),
    getSense: vi.fn<AppApi['getSense']>(async (vocabularyId, senseId) => {
      const sense = find(vocabularyId).senses.find((item) => item.id === senseId);
      if (!sense) throw new ApiError('not_found', 'That sense is not part of this word.', 404);
      return { ...sense };
    }),
    addSense: vi.fn<AppApi['addSense']>(async (vocabularyId, input) => {
      const current = find(vocabularyId);
      const sense: Sense = {
        id: `sense-${nextId++}`,
        position: current.senses.reduce((highest, item) => Math.max(highest, item.position), -1) + 1,
        meaning: input.meaning ?? null,
        definition: input.definition ?? null,
        example: input.example ?? null,
        archived: false,
        version: 1,
      };
      current.senses.push(sense);
      current.sensesVersion += 1;
      return { ...sense };
    }),
    updateEntrySense: vi.fn<AppApi['updateEntrySense']>(async (senseId, input) => {
      for (const current of store) {
        const sense = current.senses.find((item) => item.id === senseId);
        if (!sense) continue;
        if (sense.version !== input.ifMatch) {
          throw new ApiError('conflict', 'This sense was modified by another request. Please reload and try again.', 409);
        }
        if (input.meaning !== undefined) sense.meaning = input.meaning;
        if (input.definition !== undefined) sense.definition = input.definition;
        if (input.example !== undefined) sense.example = input.example;
        sense.version += 1;
        current.sensesVersion += 1;
        return { ...sense };
      }
      throw new ApiError('not_found', 'That sense is not part of this word.', 404);
    }),
    reorderSenses: vi.fn<AppApi['reorderSenses']>(async (vocabularyId, input) => {
      const current = find(vocabularyId);
      if (current.sensesVersion !== input.ifMatch) {
        throw new ApiError('conflict', 'The sense list was modified by another request. Please reload and try again.', 409);
      }
      const live = current.senses.filter((item) => !item.archived);
      const complete =
        input.senseIds.length === live.length && input.senseIds.every((id) => live.some((item) => item.id === id));
      if (!complete) {
        throw new ApiError('invalid_request', 'That order does not name every sense of this word exactly once.', 400);
      }
      input.senseIds.forEach((id, index) => {
        const sense = live.find((item) => item.id === id);
        if (sense) sense.position = index;
      });
      current.sensesVersion += 1;
    }),
    archiveSense: vi.fn<AppApi['archiveSense']>(async (senseId, input) => {
      for (const current of store) {
        const sense = current.senses.find((item) => item.id === senseId);
        if (!sense) continue;
        if (sense.version !== input.ifMatch || sense.archived) {
          throw new ApiError('conflict', 'This sense was modified by another request. Please reload and try again.', 409);
        }
        sense.archived = true;
        sense.version += 1;
        current.sensesVersion += 1;
        return;
      }
      throw new ApiError('not_found', 'That sense is not part of this word.', 404);
    }),
    restoreSense: vi.fn<AppApi['restoreSense']>(async (senseId, input) => {
      for (const current of store) {
        const sense = current.senses.find((item) => item.id === senseId);
        if (!sense) continue;
        if (sense.version !== input.ifMatch || !sense.archived) {
          throw new ApiError('conflict', 'This sense was modified by another request. Please reload and try again.', 409);
        }
        sense.position = current.senses.reduce((highest, item) => Math.max(highest, item.position), -1) + 1;
        sense.archived = false;
        sense.version += 1;
        current.sensesVersion += 1;
        return;
      }
      throw new ApiError('not_found', 'That sense is not part of this word.', 404);
    }),

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
      settings: { timeZone: TIME_ZONE, dailyGoal: goal, fsrsRequestRetention: null, scheduler: scheduler.active },
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
        senses: item.senses.map((sense) => ({ ...sense })),
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

    // ---- Vocabulary maps ----
    fetchMaps: vi.fn<AppApi['fetchMaps']>(async () =>
      [...mapDocs.values()].map(summaryOf).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    ),
    createMap: vi.fn<AppApi['createMap']>(async (request) => {
      const now = new Date().toISOString();
      const doc: VocabMapDocument = {
        id: pageId(700 + (mapCounter += 1)),
        type: request.type,
        title: request.title,
        description: request.description ?? '',
        revision: 1,
        nodeCount: 0,
        edgeCount: 0,
        createdAt: now,
        updatedAt: now,
        nodes: [],
        edges: [],
      };
      mapDocs.set(doc.id, doc);
      return summaryOf(doc);
    }),
    fetchMap: vi.fn<AppApi['fetchMap']>(async (id) => documentOf(id)),
    updateMap: vi.fn<AppApi['updateMap']>(async (id, request) => {
      const doc = mapDocs.get(id);
      if (doc === undefined) throw new ApiError('not_found', 'That map is not yours.', 404);
      if (request.ifMatch !== undefined && request.ifMatch !== doc.revision) {
        throw new ApiError('conflict', 'This map was changed somewhere else since you opened it.', 409);
      }
      if (request.title !== undefined) doc.title = request.title;
      if (request.description !== undefined) doc.description = request.description;
      bump(doc);
      return summaryOf(doc);
    }),
    deleteMap: vi.fn<AppApi['deleteMap']>(async (id) => {
      mapDocs.delete(id);
    }),
    addNode: vi.fn<AppApi['addNode']>(async (mapId, request) => {
      const doc = mapDocs.get(mapId);
      if (doc === undefined) throw new ApiError('not_found', 'That map is not yours.', 404);
      if (request.kind === 'candidate') {
        if (request.label === undefined || request.label.trim() === '') {
          throw new ApiError('invalid_request', 'A suggested node needs the word it suggests.', 400);
        }
        const label = request.label.trim();
        const existing = doc.nodes.find((node) => node.kind === 'candidate' && node.label === label);
        if (existing !== undefined) return { ...existing };
        const node: VocabMapNode = {
          id: `node-${(nodeCounter += 1)}`,
          kind: 'candidate',
          vocabularyId: null,
          senseId: null,
          label,
          note: request.note ?? '',
          group: request.group ?? null,
          step: request.step ?? (doc.type === 'scenario' ? doc.nodes.length + 1 : null),
          x: null,
          y: null,
          word: null,
          sense: null,
        };
        doc.nodes.push(node);
        bump(doc);
        return { ...node };
      }
      const word = request.vocabularyId === undefined ? null : wordOf(request.vocabularyId);
      if (word === null) throw new ApiError('not_found', 'That word is not in your vocabulary.', 404);
      const node: VocabMapNode = {
        id: `node-${(nodeCounter += 1)}`,
        kind: 'saved',
        vocabularyId: word.id,
        senseId: request.senseId ?? null,
        label: null,
        note: request.note ?? '',
        group: request.group ?? null,
        step: request.step ?? (doc.type === 'scenario' ? doc.nodes.length + 1 : null),
        x: null,
        y: null,
        word,
        sense: null,
      };
      doc.nodes.push(node);
      bump(doc);
      return { ...node };
    }),
    updateNode: vi.fn<AppApi['updateNode']>(async (mapId, nodeId, request) => {
      const doc = mapDocs.get(mapId);
      const node = doc?.nodes.find((item) => item.id === nodeId);
      if (doc === undefined || node === undefined) throw new ApiError('not_found', 'That node is not on this map.', 404);
      if (request.ifMatch !== undefined && request.ifMatch !== doc.revision) {
        throw new ApiError('conflict', 'This map was changed somewhere else since you opened it.', 409);
      }
      if (request.label !== undefined && node.kind === 'candidate') node.label = request.label;
      if (request.note !== undefined) node.note = request.note;
      if (request.group !== undefined) node.group = request.group;
      if (request.step !== undefined) node.step = request.step;
      bump(doc);
      return { ...node };
    }),
    removeNode: vi.fn<AppApi['removeNode']>(async (mapId, nodeId) => {
      const doc = mapDocs.get(mapId);
      if (doc === undefined) throw new ApiError('not_found', 'That map is not yours.', 404);
      doc.nodes = doc.nodes.filter((node) => node.id !== nodeId);
      doc.edges = doc.edges.filter((edge) => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId);
      bump(doc);
    }),
    saveCandidate: vi.fn<AppApi['saveCandidate']>(async (mapId, nodeId) => {
      const doc = mapDocs.get(mapId);
      const node = doc?.nodes.find((item) => item.id === nodeId);
      if (doc === undefined || node === undefined) throw new ApiError('not_found', 'That node is not on this map.', 404);
      if (node.kind !== 'candidate' || node.label === null) {
        throw new ApiError('invalid_request', 'Only a suggested node can be saved as a word.', 400);
      }
      // The ordinary word path, exactly one word: no meaning, edited afterwards.
      const word = { id: pageId(nextId++), word: node.label, meaning: null };
      store.push({ ...entry(nextId, { id: word.id, word: word.word, meaning: null }) });
      node.kind = 'saved';
      node.vocabularyId = word.id;
      node.label = null;
      node.word = word;
      bump(doc);
      return { node: { ...node }, entryId: word.id };
    }),
    addEdge: vi.fn<AppApi['addEdge']>(async (mapId, request) => {
      const doc = mapDocs.get(mapId);
      if (doc === undefined) throw new ApiError('not_found', 'That map is not yours.', 404);
      const existing = doc.edges.find(
        (edge) => edge.fromNodeId === request.fromNodeId && edge.toNodeId === request.toNodeId && edge.kind === request.kind,
      );
      if (existing !== undefined) return { ...existing };
      const edge: VocabMapEdge = {
        id: `edge-${(edgeCounter += 1)}`,
        fromNodeId: request.fromNodeId,
        toNodeId: request.toNodeId,
        kind: request.kind,
        pattern: request.pattern ?? '',
        note: request.note ?? '',
      };
      doc.edges.push(edge);
      bump(doc);
      return { ...edge };
    }),
    updateEdge: vi.fn<AppApi['updateEdge']>(async (mapId, edgeId, request) => {
      const doc = mapDocs.get(mapId);
      const edge = doc?.edges.find((item) => item.id === edgeId);
      if (doc === undefined || edge === undefined) throw new ApiError('not_found', 'That relationship is not on this map.', 404);
      if (request.pattern !== undefined) edge.pattern = request.pattern;
      if (request.note !== undefined) edge.note = request.note;
      bump(doc);
      return { ...edge };
    }),
    removeEdge: vi.fn<AppApi['removeEdge']>(async (mapId, edgeId) => {
      const doc = mapDocs.get(mapId);
      if (doc === undefined) throw new ApiError('not_found', 'That map is not yours.', 404);
      doc.edges = doc.edges.filter((edge) => edge.id !== edgeId);
      bump(doc);
    }),
    saveLayout: vi.fn<AppApi['saveLayout']>(async (mapId, request) => {
      const doc = mapDocs.get(mapId);
      if (doc === undefined) throw new ApiError('not_found', 'That map is not yours.', 404);
      if (request.ifMatch !== undefined && request.ifMatch !== doc.revision) {
        throw new ApiError('conflict', 'This map was changed somewhere else since you opened it.', 409);
      }
      for (const position of request.positions) {
        const node = doc.nodes.find((item) => item.id === position.nodeId);
        if (node !== undefined) {
          node.x = position.x;
          node.y = position.y;
        }
      }
      bump(doc);
      return summaryOf(doc);
    }),
    generateMap: vi.fn<AppApi['generateMap']>(async (request) => {
      // The seeds, exactly as the server gathers them: the named word, or the
      // words of the named collection, or nothing at all behind a topic.
      const seeds: Array<{ id: string; word: string; meaning: string | null }> = [];
      if (request.vocabularyId !== undefined) {
        const one = wordOf(request.vocabularyId);
        if (one !== null) seeds.push(one);
      }
      const collection =
        request.collectionId === undefined ? undefined : library.collections.find((one) => one.id === request.collectionId);
      if (collection !== undefined) {
        for (const id of collection.wordIds) {
          const one = wordOf(id);
          if (one !== null) seeds.push(one);
        }
      }
      const now = new Date().toISOString();
      const doc: VocabMapDocument = {
        id: pageId(700 + (mapCounter += 1)),
        type: request.type,
        // The map's name: the request's own title, else the seed word, the collection, or the topic.
        title: request.title ?? request.topic ?? seeds[0]?.word ?? collection?.name ?? 'New map',
        description: request.topic === undefined ? '' : `From the topic “${request.topic}”`,
        revision: 1,
        nodeCount: 0,
        edgeCount: 0,
        createdAt: now,
        updatedAt: now,
        nodes: [],
        edges: [],
      };
      mapDocs.set(doc.id, doc);
      // Every seed word lands saved; the model's other words stay suggestions.
      for (const word of seeds) {
        doc.nodes.push({
          id: `node-${(nodeCounter += 1)}`,
          kind: 'saved',
          vocabularyId: word.id,
          senseId: null,
          label: null,
          note: '',
          group: null,
          step: null,
          x: null,
          y: null,
          word,
          sense: null,
        });
      }
      doc.nodes.push({
        id: `node-${(nodeCounter += 1)}`,
        kind: 'candidate',
        vocabularyId: null,
        senseId: null,
        label: 'suggested-word',
        note: 'from the model',
        group: null,
        step: null,
        x: null,
        y: null,
        word: null,
        sense: null,
      });
      return documentOf(doc.id);
    }),
    expandMap: vi.fn<AppApi['expandMap']>(async (mapId, request) => {
      const doc = mapDocs.get(mapId);
      if (doc === undefined) throw new ApiError('not_found', 'That map is not yours.', 404);
      const suggestions = {
        nodes: [{ label: 'expanded-word', note: 'from the model', group: null }],
        edges: [] as Array<{ fromLabel: string; toLabel: string; kind: MapEdgeKind; pattern: string; note: string }>,
      };
      if (request.apply !== true) return { suggestions, applied: false };
      if (!doc.nodes.some((node) => node.kind === 'candidate' && node.label === 'expanded-word')) {
        doc.nodes.push({
          id: `node-${(nodeCounter += 1)}`,
          kind: 'candidate',
          vocabularyId: null,
          senseId: null,
          label: 'expanded-word',
          note: 'from the model',
          group: null,
          step: null,
          x: null,
          y: null,
          word: null,
          sense: null,
        });
        bump(doc);
      }
      return { suggestions, applied: true };
    }),
    fetchPersonalMap: vi.fn<AppApi['fetchPersonalMap']>(async (): Promise<PersonalMapResponse> => {
      const nodes: VocabMapNode[] = store.slice(0, 60).map((item) => ({
        id: `personal-${item.id}`,
        kind: 'saved',
        vocabularyId: item.id,
        senseId: null,
        label: null,
        note: '',
        group: library.collections.find((collection) => collection.wordIds.includes(item.id))?.name ?? null,
        step: null,
        x: null,
        y: null,
        word: { id: item.id, word: item.word, meaning: item.meaning },
        sense: null,
      }));
      const byWord = new Map(nodes.map((node) => [node.vocabularyId as string, node.id]));
      const edges: VocabMapEdge[] = library.relations.flatMap((relation) => {
        const kind = LIBRARY_RELATION_TO_EDGE[relation.kind];
        const from = byWord.get(relation.a);
        const to = byWord.get(relation.b);
        if (kind === undefined || from === undefined || to === undefined) return [];
        return [{ id: `personal-${relation.id}`, fromNodeId: from, toNodeId: to, kind, pattern: '', note: '' }];
      });
      return {
        personal: {
          id: 'personal',
          type: 'personal',
          title: 'Your vocabulary at a glance',
          description: `${store.length} words · ${mapDocs.size} maps · ${library.collections.length} collections · ${library.relations.length} saved relationships. Drawn live from what you already have; nothing here is a claim about mastery.`,
          revision: 1,
          nodeCount: nodes.length,
          edgeCount: edges.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          nodes,
          edges,
        },
        stats: {
          words: store.length,
          maps: mapDocs.size,
          collections: library.collections.length,
          relations: library.relations.length,
          senses: store.reduce((total, item) => total + item.senses.length, 0),
        },
      };
    }),

    // Judges with the real rules, from the words the test supplied.
    submitPractice: vi.fn<AppApi['submitPractice']>(async (request) => {
      const found = store.find((item) => item.id === request.pageId);
      const judged = found === undefined ? null : judge(request.mode, found, request.answer);
      if (judged === null) throw new ApiError('invalid_request', 'That answer does not fit this study mode.', 400);
      return { outcome: practiceOutcome, correct: judged.correct, typed: judged.typed, expected: judged.expected };
    }),
    fetchPlan: vi.fn<AppApi['fetchPlan']>(async () => dayPlan({ ...planFigures, goal })),
    saveGoal: vi.fn<AppApi['saveGoal']>(async (next) => {
      goal = next;
      return dayPlan({ ...planFigures, goal });
    }),
    saveSettings: vi.fn<AppApi['saveSettings']>(async ({ timeZone, fsrsRetention }) => {
      if (timeZone !== undefined) settings.timeZone = timeZone;
      if (fsrsRetention !== undefined) settings.fsrsRetention = fsrsRetention;
      return { ...settings };
    }),

    // The sentence comes from the reader's own text, like the server does it;
    // the two fields stand in for the model's draft. Tests wanting a different
    // reply (or a failure) mockResolvedValueOnce / mockRejectedValueOnce on it.
    extractSense: vi.fn<AppApi['extractSense']>(async (request) => {
      const sentence = sentenceContaining(request.text, request.word);
      if (sentence === null) throw new ApiError('invalid_request', 'That word was not found in the text.', 400);
      return { sentence, definition: `definition of ${request.word}`, meaning: `nghĩa của ${request.word}` };
    }),

    // The drafts stand in for the model's reply, shaped like the server's;
    // tests wanting a different family (or a failure) use
    // mockResolvedValueOnce / mockRejectedValueOnce on them.
    wordFamily: vi.fn<AppApi['wordFamily']>(async (request) => ({
      family: [
        { word: request.word, gloss: request.meaning ?? null, root: true },
        { word: `${request.word}s`, gloss: null, root: false },
      ],
    })),
    suggestExamples: vi.fn<AppApi['suggestExamples']>(async (request) => ({
      examples: request.collocations.map((collocation) => ({
        sentence: `She put it to good use: ${collocation}.`,
        uses: collocation,
      })),
    })),
    examPlan: vi.fn<AppApi['examPlan']>(async (request) => ({
      sections: [
        { mode: 'recognition', count: Math.min(10, request.words.length), minutes: null },
        { mode: 'typing', count: Math.min(8, request.words.length), minutes: 10 },
      ],
      reason: 'A short mixed exam over the words you asked for.',
    })),

    // ---- Discovery & Input: the same rules the server enforces ----
    // Reads and text-only writes; the two saves below are the only paths to
    // a word, each with the same duplicate rule the Add form meets.
    listSources: vi.fn<AppApi['listSources']>(async () =>
      [...discovery]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .map((row) => discoverySummary(row)),
    ),

    createSource: vi.fn<AppApi['createSource']>(async (request) => {
      const byRequest = request.requestId === undefined ? undefined : discoveryByRequest.get(request.requestId);
      if (byRequest !== undefined) return discoverySummary(byRequest);
      const title = tidyDiscoveryTitle(request.title);
      if (title === '') throw new ApiError('invalid_request', 'A source needs a title.', 400);
      if (request.suggestions !== undefined && request.kind !== 'generated') {
        throw new ApiError('invalid_request', 'Suggested words belong to generated content.', 400);
      }
      const content = tidyDiscoveryContent(request.content);
      const suggestions = request.suggestions ?? [];
      const lower = content.toLowerCase();
      for (const suggestion of suggestions) {
        if (!lower.includes(suggestion.word.toLowerCase())) {
          throw new ApiError('invalid_request', `The suggested word "${suggestion.word}" must appear in the text.`, 400);
        }
      }
      const id = discoveryId();
      const row: DiscoveryRow = {
        id,
        kind: request.kind,
        title,
        origin: request.origin ?? '',
        contentKind: request.contentKind ?? 'plain',
        position: request.position === undefined ? {} : { ...request.position },
        revision: 1,
        createdAt: iso(),
        updatedAt: iso(),
        content,
        requestId: request.requestId ?? null,
        // Generated content arrives as candidates: marks that reference no
        // vocabulary, waiting exactly like any other marked selection.
        marks: suggestions.map((suggestion) => ({
          id: discoveryMarkId(),
          sourceId: id,
          label: tidyDiscoveryLabel(suggestion.word),
          context: suggestion.sentence ?? sentenceContaining(content, suggestion.word) ?? '',
          offset: null,
          cueStart: null,
          cueEnd: null,
          note: suggestion.note ?? '',
          vocabularyId: null,
          savedAt: null,
          createdAt: iso(),
          requestId: null,
        })),
      };
      discovery.unshift(row);
      if (row.requestId !== null) discoveryByRequest.set(row.requestId, row);
      return discoverySummary(row);
    }),

    fetchSource: vi.fn<AppApi['fetchSource']>(async (id) => discoveryDocument(requireSourceRow(id))),

    updateSource: vi.fn<AppApi['updateSource']>(async (id, request) => {
      const row = requireSourceRow(id);
      if (request.position !== undefined) {
        // Restorable state: last write wins, and the revision an edit is
        // checked against never moves for it.
        row.position = { ...request.position };
        row.updatedAt = iso();
      }
      if (request.title !== undefined) {
        if (request.ifMatch !== undefined && request.ifMatch !== row.revision) {
          throw new ApiError('conflict', 'This source changed since you opened it. Reload and try again.', 409);
        }
        const title = tidyDiscoveryTitle(request.title);
        if (title === '') throw new ApiError('invalid_request', 'A source needs a title.', 400);
        row.title = title;
        row.revision += 1;
        row.updatedAt = iso();
      }
      return discoverySummary(row);
    }),

    deleteSource: vi.fn<AppApi['deleteSource']>(async (id) => {
      const row = requireSourceRow(id);
      discovery.splice(discovery.indexOf(row), 1);
    }),

    listMarks: vi.fn<AppApi['listMarks']>(async () =>
      allDiscoveryMarks()
        .filter(({ mark }) => mark.savedAt === null)
        .sort((a, b) => a.mark.createdAt.localeCompare(b.mark.createdAt) || a.mark.id.localeCompare(b.mark.id))
        .map(({ mark, source }) => discoveryMarkView(mark, source)),
    ),

    markSelection: vi.fn<AppApi['markSelection']>(async (sourceId, request) => {
      const row = requireSourceRow(sourceId);
      if (request.sourceId !== sourceId) {
        throw new ApiError('invalid_request', 'That selection does not belong to this source.', 400);
      }
      if (request.label.trim() === '') throw new ApiError('invalid_request', 'Select something first.', 400);
      if ((request.cueStart === undefined) !== (request.cueEnd === undefined)) {
        throw new ApiError('invalid_request', 'A cue needs both its start and its end.', 400);
      }
      const byRequest = allDiscoveryMarks().find(({ mark }) => mark.requestId !== null && mark.requestId === request.requestId);
      if (byRequest !== undefined) return { ...byRequest.mark };
      const label = tidyDiscoveryLabel(request.label);
      const waiting = row.marks.find((mark) => mark.savedAt === null && mark.label === label);
      if (waiting !== undefined) return { ...waiting };
      const offset = clampOffset(request.offset, row.content);
      const mark: FakeMark = {
        id: discoveryMarkId(),
        sourceId: row.id,
        label,
        context: (request.context ?? (offset === null ? '' : sentenceAround(row.content, offset))).slice(0, DISCOVERY_LIMITS.context),
        offset,
        cueStart: request.cueStart ?? null,
        cueEnd: request.cueEnd ?? null,
        note: request.note ?? '',
        vocabularyId: null,
        savedAt: null,
        createdAt: iso(),
        requestId: request.requestId,
      };
      row.marks.push(mark);
      return { ...mark };
    }),

    dismissMark: vi.fn<AppApi['dismissMark']>(async (markId) => {
      const found = requireMarkRow(markId);
      if (found.mark.savedAt !== null) {
        throw new ApiError('conflict', 'That selection is saved with its word and stays with it.', 409);
      }
      const row = found.source;
      row.marks.splice(row.marks.indexOf(found.mark), 1);
    }),

    saveSelection: vi.fn<AppApi['saveSelection']>(async (request) => {
      const row = requireSourceRow(request.sourceId);
      const label = tidyDiscoveryLabel(request.word);
      const offset = clampOffset(request.offset, row.content);
      const context = (request.context ?? (offset === null ? '' : sentenceAround(row.content, offset))).slice(
        0,
        DISCOVERY_LIMITS.context,
      );
      // The ordinary word creation: a duplicate is refused with the existing
      // words, and only allowDuplicate keeps both — never a silent second one.
      const saved = wordForSelection({ ...request, word: label, example: request.example || context || undefined });
      const savedAt = iso();
      const waiting = row.marks.find((mark) => mark.savedAt === null && mark.label === label);
      if (waiting !== undefined) {
        waiting.vocabularyId = saved.id;
        waiting.savedAt = savedAt;
        return { entry: { ...saved }, mark: { ...waiting } };
      }
      const byRequest = allDiscoveryMarks().find(({ mark }) => mark.requestId !== null && mark.requestId === request.requestId);
      if (byRequest !== undefined) {
        if (byRequest.mark.vocabularyId === null) {
          byRequest.mark.vocabularyId = saved.id;
          byRequest.mark.savedAt = savedAt;
        }
        return { entry: { ...saved }, mark: { ...byRequest.mark } };
      }
      const mark: FakeMark = {
        id: discoveryMarkId(),
        sourceId: row.id,
        label,
        context,
        offset,
        cueStart: request.cueStart ?? null,
        cueEnd: request.cueEnd ?? null,
        note: request.note ?? '',
        vocabularyId: saved.id,
        savedAt,
        createdAt: savedAt,
        requestId: request.requestId,
      };
      row.marks.push(mark);
      return { entry: { ...saved }, mark: { ...mark } };
    }),

    saveMark: vi.fn<AppApi['saveMark']>(async (markId, request) => {
      const found = requireMarkRow(markId);
      const mark = found.mark;
      if (mark.savedAt !== null && mark.vocabularyId !== null) {
        // Pressed again after it landed: the same word and mark stand.
        const already = store.find((item) => item.id === mark.vocabularyId);
        if (already === undefined) throw new ApiError('not_found', 'That word is not in the vocabulary database.', 404);
        return { entry: { ...already }, mark: { ...mark } };
      }
      // The mark's own selection is the word — the form cannot name another.
      const saved = wordForSelection({ ...request, word: mark.label, example: request.example || mark.context || undefined });
      mark.vocabularyId = saved.id;
      mark.savedAt = iso();
      return { entry: { ...saved }, mark: { ...mark } };
    }),

    findWordContext: vi.fn<AppApi['findWordContext']>(async (vocabularyId) => {
      const found = allDiscoveryMarks().find(({ mark }) => mark.vocabularyId === vocabularyId);
      if (found === undefined) throw new ApiError('not_found', 'That word did not come from a source you still have.', 404);
      return { source: discoverySummary(found.source), mark: { ...found.mark } };
    }),

    // The draft stands in for the model's reply, shaped like the server's;
    // tests wanting a different reading (or a failure) use
    // mockResolvedValueOnce / mockRejectedValueOnce on it.
    generateDraft: vi.fn<AppApi['generateDraft']>(async () => ({
      draft: {
        title: 'A draft reading',
        text:
          'In a candid conversation over dinner, the travellers changed their plans for the better and watched the harbour lights come on. ' +
          'They agreed that honest talk is rarer than good weather, and twice as welcome when it arrives.',
        suggestions: [
          { word: 'candid', sentence: 'In a candid conversation over dinner, the travellers changed their plans for the better.', note: 'openly direct' },
        ],
      },
    })),

    // A preview only: this stores nothing, exactly like the server's fetch.
    fetchUrl: vi.fn<AppApi['fetchUrl']>(async (url) => ({
      title: 'A fetched page',
      text: 'A page worth reading, brought back as plain text so you can choose what to keep from it.',
      origin: url,
    })),
  } satisfies AppApi;

  return { api, saves, store };
}
