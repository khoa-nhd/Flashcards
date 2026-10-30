/**
 * Turns a Supabase access token into a session that can only reach that
 * account's rows. The token is verified here first, and then used as the
 * credential for every query, so the database enforces the same boundary
 * again through Row Level Security.
 */
import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { isValidTimeZone } from '../../shared/dates.js';
import type { ReviewRules } from '../../shared/review-logic.js';
import { DEFAULT_FSRS_SETTINGS, isValidRetention } from '../../shared/scheduler/fsrs.js';
import { DEFAULT_RATING_MAP, type RatingMap } from '../../shared/scheduler/rating-map.js';
import type { CardFieldConfig, NewWordDefaults } from '../../shared/vocabulary.js';
import type { Account, AccountGateway } from '../accounts.js';
import { NO_GOAL } from '../../shared/session-planner.js';
import { AnalyticsService } from '../analytics-service.js';
import { ExportService } from '../export-service.js';
import { NO_GOAL_STORE, createGoalStore } from '../goal-store.js';
import { LibraryService } from '../library-service.js';
import { NO_LIBRARY_STORE } from '../library-store.js';
import { ReviewService } from '../review-service.js';
import { MASTERY_ONLY, createSchedulerStore } from '../scheduler-store.js';
import { VocabularyService } from '../vocabulary-service.js';
import {
  DatabaseError,
  LATEST_SCHEMA_VERSION,
  RECOMMENDED_SCHEMA_VERSION,
  createSupabaseDatabase,
  createUserClient,
  type StoredSettings,
  type VocabularyDatabase,
} from './supabase-database.js';
import { createSupabaseLibraryStore } from './supabase-library.js';
import { SupabaseVocabularyRepository } from './supabase-repository.js';
import { createAiService, loadAiConfig } from '../ai-service-impl.js';
import { StudyGoalsService, createStudyGoalStore } from '../study-goals-service.js';
import { CompetitionService, createDatabaseCompetitionStore } from '../competition-service.js';
import { GameService, createDatabaseGameStore } from '../game-service.js';
import { SUGGESTED_STUDY_GOALS } from '../../shared/study-goals.js';
import { AiError, AiErrorCode } from '../ai-service.js';

export interface TokenVerifier {
  /** The account the token belongs to, or `null` if it is not a valid user token. */
  verify(accessToken: string): Promise<Account | null>;
}

/** What a verified token says about its bearer. Only these claims are relied on. */
export function accountFromClaims(claims: Record<string, unknown>): Account | null {
  const { sub, role, email } = claims;
  // `anon` is the public key itself; `service_role` is never a person. Neither is an account.
  if (role !== 'authenticated') return null;
  if (typeof sub !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) {
    return null;
  }
  return { id: sub.toLowerCase(), email: typeof email === 'string' && email !== '' ? email : null };
}

/**
 * Verifies tokens against the project's own signing keys (fetched once and
 * cached by the SDK), or by asking the Auth server when the project still
 * signs with a shared secret.
 */
export function createSupabaseVerifier(url: string, publicKey: string, fetchImpl?: typeof fetch): TokenVerifier {
  const client = createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchImpl === undefined ? {} : { global: { fetch: fetchImpl } }),
  });

  // Not being able to check is different from a bad token: say so, rather than sign the user out.
  const unreachable = () => new DatabaseError('unavailable', 'The sign-in service is temporarily unavailable.');

  return {
    async verify(accessToken) {
      let result: Awaited<ReturnType<typeof client.auth.getClaims>>;
      try {
        result = await client.auth.getClaims(accessToken);
      } catch (error) {
        if (isAuthRetryableFetchError(error)) throw unreachable();
        // The SDK throws, rather than returns, when a token cannot even be decoded. That is simply a bad token.
        return null;
      }
      if (result.error) {
        if (isAuthRetryableFetchError(result.error)) throw unreachable();
        return null;
      }
      return result.data === null ? null : accountFromClaims(result.data.claims);
    },
  };
}

export interface SupabaseAccountsOptions {
  url: string;
  publicKey: string;
  rules: ReviewRules;
  cardFields: readonly CardFieldConfig[];
  defaults: NewWordDefaults;
  /** The zone a new account starts with when the browser does not offer a usable one. */
  defaultTimeZone: string | null;
  writesRequested: boolean;
  verifier?: TokenVerifier;
  /** How the two answers are rated for FSRS, which is calculated beside the real schedule. */
  ratingMap?: RatingMap;
  /**
   * Opens the database as the bearer of this token, told what the database
   * has so it never asks for more. Replaceable in tests.
   */
  connect?: (accessToken: string, schemaVersion?: number) => VocabularyDatabase;
  now?: () => Date;
  /** Signs the game's changes (GAME_SIGNING_KEY). Without it the game stays off. */
  gameSigningKey?: string | null;
  /** Accounts that may moderate (ADMIN_EMAILS); the database's `app_admins` must name them too. */
  adminEmails?: readonly string[];
}

const FALLBACK_TIME_ZONE = 'UTC';
const SCHEMA_RECHECK_MS = 60_000;

// Why a server has no AI chat does not change while it runs, so the reasons
// reach the log once rather than on every request. They name variables and
// constraints, never their values.
let aiConfigProblemLogged = false;

export function createSupabaseAccounts(options: SupabaseAccountsOptions): AccountGateway {
  const { url, publicKey, rules, cardFields, defaults, defaultTimeZone, writesRequested, now } = options;
  const verifier = options.verifier ?? createSupabaseVerifier(url, publicKey);
  const ratingMap = options.ratingMap ?? DEFAULT_RATING_MAP;
  const connect =
    options.connect ??
    ((accessToken, schemaVersion) => createSupabaseDatabase(createUserClient(url, publicKey, accessToken), schemaVersion));

  // The schema version belongs to the project, not to a user, so it is looked up
  // once and remembered. While it is behind, it is checked again every minute,
  // so a migration the owner has just run is picked up without a redeploy.
  let knownVersion: { value: number; at: number } | null = null;
  const schemaVersionOf = async (database: VocabularyDatabase): Promise<number> => {
    const at = (now ?? (() => new Date()))().getTime();
    const fresh = knownVersion !== null && at - knownVersion.at < SCHEMA_RECHECK_MS;
    if (knownVersion !== null && (knownVersion.value >= LATEST_SCHEMA_VERSION || fresh)) return knownVersion.value;
    knownVersion = { value: await database.schemaVersion(), at };
    return knownVersion.value;
  };

  // A session is opened for every request, and each one reads the account's
  // settings row. That row changes only when the account itself changes it, so
  // the read is remembered for a moment. Every write to it forgets the entry,
  // so an owner's own change is seen at once, and another device's within the
  // interval. The value is the database's own, not a default: nothing here
  // invents a time zone or a goal.
  const SETTINGS_TTL_MS = 30_000;
  const SETTINGS_CACHE_MAX = 5_000;
  const settingsCache = new Map<string, { value: StoredSettings; at: number }>();
  const forgetSettings = (accountId: string) => {
    settingsCache.delete(accountId);
  };
  const settingsOf = async (accountId: string, database: VocabularyDatabase): Promise<StoredSettings | null> => {
    const at = (now ?? (() => new Date()))().getTime();
    const cached = settingsCache.get(accountId);
    if (cached !== undefined && at - cached.at < SETTINGS_TTL_MS) return cached.value;
    const value = await database.getSettings();
    // Bound the map: a long-running server should not grow it without limit.
    if (settingsCache.size >= SETTINGS_CACHE_MAX && !settingsCache.has(accountId)) {
      const oldest = settingsCache.keys().next().value;
      if (oldest !== undefined) settingsCache.delete(oldest);
    }
    if (value !== null) settingsCache.set(accountId, { value, at });
    else settingsCache.delete(accountId);
    return value;
  };

  return {
    async open(accessToken, hints) {
      const account = await verifier.verify(accessToken);
      if (account === null) return null;

      // Built per request and never shared: nothing here can outlive, or leak into, another account's request.
      // The version is looked up first, then the database is opened knowing what it may ask for.
      const schemaVersion = await schemaVersionOf(connect(accessToken));
      const database = connect(accessToken, schemaVersion);

      const settings = await settingsOf(account.id, database);
      let timeZone = settings?.timeZone ?? null;
      if (timeZone === null) {
        const hinted = hints.timeZone !== null && isValidTimeZone(hints.timeZone) ? hints.timeZone : null;
        timeZone = await database.ensureTimeZone(hinted ?? defaultTimeZone ?? FALLBACK_TIME_ZONE);
        // A brand-new account now has a zone; remember it is set, so the next
        // request reads it instead of writing it again.
        settingsCache.set(account.id, {
          value: {
            timeZone,
            fsrsRetention: null,
            dailyGoal: null,
            scheduler: null,
            countReviewsTowardMastery: null,
            studyGoals: null,
            maxReviewsPerDay: null,
            uiLanguage: null,
          },
          at: (now ?? (() => new Date()))().getTime(),
        });
      }
      if (!isValidTimeZone(timeZone)) timeZone = FALLBACK_TIME_ZONE;

      // FSRS is calculated only where the database can hold its state.
      const stored = settings?.fsrsRetention ?? null;
      const fsrsRetention =
        schemaVersion < 3 ? null : stored !== null && isValidRetention(stored) ? stored : DEFAULT_FSRS_SETTINGS.requestRetention;
      const fsrs = fsrsRetention === null ? null : { settings: { requestRetention: fsrsRetention }, ratingMap };

      // Whether a review counts is the account's own choice, kept only where the database has
      // somewhere to put it. Anywhere else every review counts, as one always did.
      const countReviewsTowardMastery =
        schemaVersion < 13 ? true : (settings?.countReviewsTowardMastery ?? true);

      const repository = new SupabaseVocabularyRepository(database, rules, schemaVersion);
      // A goal is kept only where the database has somewhere to put it.
      const goals =
        settings?.dailyGoal == null && schemaVersion < 5
          ? NO_GOAL_STORE
          : createGoalStore(settings?.dailyGoal ?? NO_GOAL, (goal) => {
              forgetSettings(account.id);
              return database.saveDailyGoal(goal);
            });
      const library = new LibraryService({
        // Kept only where the database has the tables for it.
        store: schemaVersion >= 7 ? createSupabaseLibraryStore(database) : NO_LIBRARY_STORE,
        catalog: repository,
        writesRequested,
      });
      // Which schedule is in charge is the account's own choice, kept only where the database has
      // somewhere to put it. Anywhere else, and for every account that has not chosen, it is the mastery schedule.
      const scheduler =
        schemaVersion >= 8
          ? createSchedulerStore(settings?.scheduler ?? 'mastery_v1', (next) => {
              forgetSettings(account.id);
              return database.saveScheduler(next);
            })
          : MASTERY_ONLY;
      // FSRS-only: once the database is at v15, FSRS is the only scheduler.
      const fsrsOnly = repository.capabilities.fsrsOnly;
      // The game needs its tables (schema version 17) and the key that signs its changes.
      const gameKey = options.gameSigningKey ?? null;
      const game =
        repository.capabilities.game && gameKey !== null
          ? new GameService({
              store: createDatabaseGameStore(database, account.id, gameKey),
              account: account.id,
              repository,
              catalog: repository,
              goals: () => settings?.studyGoals ?? SUGGESTED_STUDY_GOALS,
              timeZone,
              now,
            })
          : null;
      const gameReason =
        game !== null
          ? null
          : !repository.capabilities.game
            ? 'XP and levels need the latest database update (version 17).'
            : 'XP and levels are not set up on the server yet (GAME_SIGNING_KEY).';
      // Leagues and friends sign their writes with the same key, and need version 18.
      const competition =
        repository.capabilities.competition && gameKey !== null
          ? new CompetitionService({
              store: createDatabaseCompetitionStore(database, account.id, gameKey),
              account: account.id,
              email: account.email,
              adminEmails: options.adminEmails ?? [],
              timeZone,
              now,
            })
          : null;
      const competitionReason =
        competition !== null
          ? null
          : !repository.capabilities.competition
            ? 'Leagues and friends need the latest database update (version 18).'
            : 'Leagues and friends are not set up on the server yet (GAME_SIGNING_KEY).';
      return {
        game,
        gameReason,
        competition,
        competitionReason,
        account,
        timeZone,
        database: { version: schemaVersion, latest: RECOMMENDED_SCHEMA_VERSION },
        fsrsRetention,
        countReviewsTowardMastery,
        fsrsOnly,
        goals: settings?.studyGoals ?? null,
        maxReviewsPerDay: settings?.maxReviewsPerDay ?? null,
        uiLanguage: settings?.uiLanguage ?? null,
        review: new ReviewService({
          repository,
          rules,
          cardFields,
          timeZone,
          writesRequested,
          fsrs,
          scheduler,
          maxReviewsPerDay: settings?.maxReviewsPerDay ?? null,
          now,
        }),
        vocabulary: new VocabularyService({ catalog: repository, rules, defaults, timeZone, writesRequested, scheduler, fsrsOnly, now }),
        studyGoals: fsrsOnly
          ? new StudyGoalsService({
              repository,
              catalog: repository,
              timeZone,
              now,
              coveredDays: game === null ? undefined : (facts) => game.coveredDays(facts),
              store: createStudyGoalStore(settings?.studyGoals ?? null, async (goals) => {
                const save = database.saveStudyGoals;
                if (save === undefined) throw new DatabaseError('schema_missing', 'Daily goals need the latest database update.');
                const saved = await save.call(database, goals);
                forgetSettings(account.id);
                return saved;
              }),
            })
          : null,
        analytics: new AnalyticsService({
          repository,
          catalog: repository,
          rules,
          timeZone,
          goals,
          scheduler,
          now,
        }),
        library,
        exporter: new ExportService({
          repository,
          catalog: repository,
          library,
          settings: () => ({
            timeZone,
            dailyGoal: goals.get(),
            fsrsRetention,
            scheduler: scheduler.get(),
            countReviewsTowardMastery,
          }),
          now,
        }),
        ai: (() => {
          try {
            loadAiConfig();
            return createAiService(repository);
          } catch (error) {
            if (error instanceof AiError && error.code === AiErrorCode.CONFIG_MISSING) {
              if (!aiConfigProblemLogged) {
                aiConfigProblemLogged = true;
                console.error(`AI chat is unavailable: ${error.message}`);
              }
              return null; // AI not configured; service will be unavailable
            }
            throw error;
          }
        })(),
        async saveTimeZone(next) {
          if (!isValidTimeZone(next)) throw new DatabaseError('invalid', 'That is not a time zone this app recognises.');
          const saved = await database.saveTimeZone(next);
          forgetSettings(account.id);
          return saved;
        },
        async saveFsrsRetention(next) {
          if (schemaVersion < 3) {
            throw new DatabaseError('invalid', 'This setting needs the latest database update.');
          }
          if (!isValidRetention(next)) throw new DatabaseError('invalid', 'That retention is outside the supported range.');
          const saved = await database.saveFsrsRetention(next);
          forgetSettings(account.id);
          return saved;
        },
        async saveCountReviewsTowardMastery(next) {
          if (schemaVersion < 13) {
            throw new DatabaseError('invalid', 'This setting needs the latest database update.');
          }
          const saved = await database.saveCountReviewsTowardMastery(next);
          forgetSettings(account.id);
          return saved;
        },
        async saveMaxReviewsPerDay(next) {
          const save = database.saveMaxReviewsPerDay;
          if (schemaVersion < 15 || save === undefined) {
            throw new DatabaseError('invalid', 'This setting needs the latest database update.');
          }
          if (next !== null && (!Number.isInteger(next) || next < 1 || next > 1000)) {
            throw new DatabaseError('invalid', 'The daily review limit must be a whole number from 1 to 1000.');
          }
          const saved = await save.call(database, next);
          forgetSettings(account.id);
          return saved;
        },
        async saveUiLanguage(next) {
          const save = database.saveUiLanguage;
          if (schemaVersion < 15 || save === undefined) {
            throw new DatabaseError('invalid', 'This setting needs the latest database update.');
          }
          const saved = await save.call(database, next);
          forgetSettings(account.id);
          return saved;
        },
      };
    },
  };
}
