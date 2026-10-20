import { cardFields, fsrsRatingMap, newWordDefaults, reviewRules } from '../config/review.config.js';
import { calendarDateInTimeZone } from '../shared/dates.js';
import { DEFAULT_FSRS_SETTINGS } from '../shared/scheduler/fsrs.js';
import { AnalyticsService } from './analytics-service.js';
import { createAiAdapter } from './ai/adapter.js';
import { createTokenBucket } from './ai/rate-limit.js';
import { WRITING_COACH_RATE, createWritingCoach } from './ai/writing-coach.js';
import { createApp } from './create-app.js';
import { createGoalStore } from './goal-store.js';
import { DiscoveryService } from './discovery-service.js';
import { createMemoryDiscoveryStore } from './discovery-store.js';
import { loadConfig, type AppConfig } from './env.js';
import { ExportService } from './export-service.js';
import { LibraryService } from './library-service.js';
import { createMemoryLibraryStore } from './library-store.js';
import { MockVocabularyRepository, mockCardFields } from './mock/mock-repository.js';
import { sampleRules } from './mock/sample-rules.js';
import { ReviewService } from './review-service.js';
import { createSchedulerStore } from './scheduler-store.js';
import { createSupabaseAccounts } from './supabase/supabase-accounts.js';
import { VocabMapsService, type MapWordSource } from './vocab-maps-service.js';
import { createMemoryVocabMapsStore } from './vocab-maps-store.js';
import { VocabularyService } from './vocabulary-service.js';

/** Wires configuration, data source and routes together. Shared by every entry point. */
export function buildApp(env: Record<string, string | undefined> = process.env): {
  app: ReturnType<typeof createApp>;
  config: AppConfig;
} {
  const config = loadConfig(env);

  // The Writing Coach, if this server has a model to ask. One coach and one
  // token bucket serve the whole process; without a key practice is judged
  // and recorded exactly as before, just without a note.
  const coach =
    config.ai === null
      ? null
      : createWritingCoach({ adapter: createAiAdapter(config.ai), limiter: createTokenBucket(WRITING_COACH_RATE) });

  if (config.mode === 'supabase') {
    // Each request is served as the account that made it, so there are no shared services.
    // If the configuration is incomplete the app answers 503 with the reasons; there is
    // no other data source to reach for instead.
    const accounts =
      config.supabase === null || config.issues.length > 0
        ? null
        : createSupabaseAccounts({
            url: config.supabase.url,
            publicKey: config.supabase.publicKey,
            rules: reviewRules,
            cardFields,
            defaults: newWordDefaults,
            ratingMap: fsrsRatingMap,
            defaultTimeZone: config.timeZone,
            writesRequested: config.writesRequested,
            coach,
          });
    return { app: createApp({ config, service: null, accounts }), config };
  }

  // Sample words kept in memory, shared by everyone who opens the app.
  if (config.issues.length > 0 || config.timeZone === null) {
    return { app: createApp({ config, service: null }), config };
  }
  const { timeZone } = config;
  const repository = new MockVocabularyRepository(calendarDateInTimeZone(new Date(), timeZone));
  // The sample data has no account, so its choice of schedule is kept in memory with everything else.
  const scheduler = createSchedulerStore();
  const service = new ReviewService({
    repository,
    rules: sampleRules,
    cardFields: mockCardFields,
    timeZone,
    writesRequested: true,
    fsrs: { settings: DEFAULT_FSRS_SETTINGS, ratingMap: fsrsRatingMap },
    scheduler,
    coach,
  });
  const vocabulary = new VocabularyService({
    catalog: repository,
    rules: sampleRules,
    defaults: newWordDefaults,
    timeZone,
    writesRequested: true,
    scheduler,
    capabilities: repository.capabilities,
  });
  // The sample data has no account, so its goal is kept in memory with everything else.
  const goals = createGoalStore();
  const analytics = new AnalyticsService({
    repository,
    catalog: repository,
    rules: sampleRules,
    timeZone,
    goals,
    scheduler,
    // The sample data is kept in memory for everyone; its goal follows the same switch.
    writesRequested: true,
  });
  const libraryStore = createMemoryLibraryStore((id) => repository.ownsWord(id));
  const library = new LibraryService({
    store: libraryStore,
    catalog: repository,
    writesRequested: true,
  });
  // What the map service needs to know about words, over the sample data.
  // Saved nodes hold an id; this is where the text behind it is read, so a
  // renamed word shows up in every map without the map being touched.
  const mapWords: MapWordSource = {
    async words(ids) {
      const found: Array<{ id: string; word: string; meaning: string | null }> = [];
      for (const id of ids) {
        const entry = await repository.getEntry(id);
        if (entry !== null) found.push({ id: entry.id, word: entry.word, meaning: entry.meaning });
      }
      return found;
    },
    async sense(id) {
      // The sample store keeps senses on their word, so the owning word is
      // found by looking, exactly as the sense lookup itself does.
      const { entries } = await repository.listEntries();
      for (const entry of entries) {
        const sense = entry.senses?.find((candidate) => candidate.id === id);
        if (sense !== undefined) return { id: sense.id, vocabularyId: entry.id, meaning: sense.meaning };
      }
      return null;
    },
    async ownsWord(id) {
      return repository.ownsWord(id);
    },
    async overview() {
      const [{ entries }, library] = await Promise.all([repository.listEntries(), libraryStore.load()]);
      return {
        words: entries.map((entry) => ({
          id: entry.id,
          word: entry.word,
          meaning: entry.meaning,
          updatedAt: entry.lastEditedTime ?? entry.createdTime ?? entry.dateAdded ?? '',
        })),
        collections: library.collections.map((collection) => ({ id: collection.id, name: collection.name })),
        memberships: library.items.map((item) => ({ collectionId: item.collectionId, vocabularyId: item.vocabularyId })),
        relations: library.relations.map((relation) => ({ lowId: relation.lowId, highId: relation.highId, kind: relation.kind })),
        senses: entries.reduce((total, entry) => total + (entry.senses?.length ?? 0), 0),
      };
    },
    async saveWord(request) {
      const { entry } = await vocabulary.create({ word: request.word, requestId: request.requestId });
      return { id: entry.id };
    },
  };
  const maps = new VocabMapsService({
    store: createMemoryVocabMapsStore(),
    words: mapWords,
    writesRequested: true,
  });
  // Discovery keeps its sources and selections here too — the sample words
  // belong to nobody, so nothing is shared and nothing persists by itself.
  const discovery = new DiscoveryService({
    store: createMemoryDiscoveryStore(),
    vocabulary,
    library: {
      async findCollection(id) {
        const [{ entries }, data] = await Promise.all([repository.listEntries(), libraryStore.load()]);
        const collection = data.collections.find((candidate) => candidate.id === id);
        if (collection === undefined) return null;
        const words = new Map(entries.map((entry) => [entry.id, entry.word]));
        const members: string[] = [];
        for (const item of data.items) {
          if (item.collectionId !== id) continue;
          const word = words.get(item.vocabularyId);
          if (word !== undefined) members.push(word);
        }
        return { name: collection.name, words: members };
      },
    },
    writesRequested: config.writesRequested,
  });
  const exporter = new ExportService({
    repository,
    catalog: repository,
    library,
    settings: () => ({
      timeZone,
      dailyGoal: goals.get(),
      fsrsRetention: DEFAULT_FSRS_SETTINGS.requestRetention,
      scheduler: scheduler.get(),
    }),
  });
  return { app: createApp({ config, service, vocabulary, analytics, library, maps, discovery, exporter }), config };
}

let shared: ReturnType<typeof buildApp> | undefined;

/** One app per loaded copy of this module, built on first use. */
export function getApp(): ReturnType<typeof buildApp> {
  shared ??= buildApp();
  return shared;
}
