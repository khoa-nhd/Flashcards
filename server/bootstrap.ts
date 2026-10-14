import { cardFields, fsrsRatingMap, newWordDefaults, reviewRules } from '../config/review.config.js';
import { calendarDateInTimeZone } from '../shared/dates.js';
import { DEFAULT_FSRS_SETTINGS } from '../shared/scheduler/fsrs.js';
import { AnalyticsService } from './analytics-service.js';
import { createAiAdapter } from './ai/adapter.js';
import { createTokenBucket } from './ai/rate-limit.js';
import { WRITING_COACH_RATE, createWritingCoach } from './ai/writing-coach.js';
import { createApp } from './create-app.js';
import { createGoalStore } from './goal-store.js';
import { loadConfig, type AppConfig } from './env.js';
import { ExportService } from './export-service.js';
import { LibraryService } from './library-service.js';
import { createMemoryLibraryStore } from './library-store.js';
import { MockVocabularyRepository, mockCardFields } from './mock/mock-repository.js';
import { sampleRules } from './mock/sample-rules.js';
import { ReviewService } from './review-service.js';
import { createSchedulerStore } from './scheduler-store.js';
import { createSupabaseAccounts } from './supabase/supabase-accounts.js';
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
  const library = new LibraryService({
    store: createMemoryLibraryStore((id) => repository.ownsWord(id)),
    catalog: repository,
    writesRequested: true,
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
  return { app: createApp({ config, service, vocabulary, analytics, library, exporter }), config };
}

let shared: ReturnType<typeof buildApp> | undefined;

/** One app per loaded copy of this module, built on first use. */
export function getApp(): ReturnType<typeof buildApp> {
  shared ??= buildApp();
  return shared;
}
