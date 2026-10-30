import { cardFields, fsrsRatingMap, newWordDefaults, reviewRules } from '../config/review.config.js';
import { calendarDateInTimeZone } from '../shared/dates.js';
import { DEFAULT_FSRS_SETTINGS } from '../shared/scheduler/fsrs.js';
import { AnalyticsService } from './analytics-service.js';
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
import { StudyGoalsService, createStudyGoalStore } from './study-goals-service.js';
import { CompetitionService } from './competition-service.js';
import { GameService, createMemoryGameStore } from './game-service.js';
import { createMemoryCompetitionStore } from './mock/mock-competition.js';
import { SUGGESTED_STUDY_GOALS } from '../shared/study-goals.js';
import { VocabularyService } from './vocabulary-service.js';

/** Wires configuration, data source and routes together. Shared by every entry point. */
export function buildApp(env: Record<string, string | undefined> = process.env): {
  app: ReturnType<typeof createApp>;
  config: AppConfig;
} {
  const config = loadConfig(env);

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
            gameSigningKey: config.gameSigningKey,
            adminEmails: config.adminEmails,
          });
    return { app: createApp({ config, service: null, accounts }), config };
  }

  // Sample words kept in memory, shared by everyone who opens the app.
  if (config.issues.length > 0 || config.timeZone === null) {
    return { app: createApp({ config, service: null }), config };
  }
  const { timeZone } = config;
  // `npm run dev:mock-fsrs`: the sample words with FSRS as the only schedule, as schema version 15 has it.
  const fsrsOnly = env.MOCK_FSRS_ONLY === 'true';
  const repository = new MockVocabularyRepository(calendarDateInTimeZone(new Date(), timeZone), undefined, {
    fsrsOnly,
    timeZone,
  });
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
  });
  const vocabulary = new VocabularyService({
    catalog: repository,
    rules: sampleRules,
    defaults: newWordDefaults,
    timeZone,
    writesRequested: true,
    scheduler,
    fsrsOnly,
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
      // Sample data keeps no account, so there is nowhere to remember a choice; a review counts by default.
      countReviewsTowardMastery: true,
    }),
  });
  // The sample data has no account either, so its goals and its game are kept in memory too.
  const goalStore = createStudyGoalStore();
  const gameStore = createMemoryGameStore({ answers: () => repository.gameAnswers(), metrics: () => repository.gameMetrics() });
  const game = new GameService({
    store: gameStore,
    account: 'sample',
    repository,
    catalog: repository,
    goals: () => goalStore.get() ?? SUGGESTED_STUDY_GOALS,
    timeZone,
  });
  const studyGoals = fsrsOnly
    ? new StudyGoalsService({
        repository,
        catalog: repository,
        timeZone,
        store: goalStore,
        coveredDays: (facts) => game.coveredDays(facts),
      })
    : null;
  const competition = new CompetitionService({
    store: createMemoryCompetitionStore({
      account: 'sample',
      xpBetween: (from, to) => gameStore.xpBetween(from, to),
      totalXp: () => gameStore.xpBetween('1970-01-01T00:00:00Z', '9999-01-01T00:00:00Z'),
      metDays: () => [],
      give: (reward) => gameStore.give(reward),
    }),
    account: 'sample',
    // The sample data has no sign-in, so its moderation page is open to try.
    email: 'sample@example.test',
    adminEmails: ['sample@example.test'],
    timeZone,
  });
  return { app: createApp({ config, service, vocabulary, analytics, library, exporter, studyGoals, game, competition }), config };
}

let shared: ReturnType<typeof buildApp> | undefined;

/** One app per loaded copy of this module, built on first use. */
export function getApp(): ReturnType<typeof buildApp> {
  shared ??= buildApp();
  return shared;
}
