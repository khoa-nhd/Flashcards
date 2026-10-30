/**
 * The only file that talks to Supabase. It exposes a narrow interface so the
 * rest of the server (and the tests) never depend on the SDK.
 *
 * Every call runs as the signed-in user: the client is created from the public
 * key plus that user's access token, so Row Level Security decides what each
 * request can see and change. No privileged key exists anywhere in this app.
 */
import type { NotificationSettings } from '../../shared/api.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isIsoDate, type IsoDate } from '../../shared/dates.js';
import type { ReviewAction } from '../../shared/review-logic.js';
import { DEFAULT_SCHEDULER, isSchedulerId, type SchedulerId } from '../../shared/scheduler/active.js';
import { fsrsStateSchema, type FsrsState } from '../../shared/scheduler/fsrs.js';
import type { DailyGoal } from '../../shared/session-planner.js';
import type { StudyDayRow } from '../vocabulary-repository.js';
import type { Database } from './database.types.js';

const dateSchema = z.string().refine(isIsoDate).nullable();

export const cardRowSchema = z.object({
  id: z.string(),
  word: z.string(),
  word_key: z.string(),
  meaning: z.string().nullable(),
  definition: z.string().nullable(),
  example: z.string().nullable(),
  date_added: dateSchema,
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  mastery: z.number().int(),
  review_date: dateSchema,
  // From schema version 3. All empty for a card FSRS has not seen yet.
  fsrs_due: z.string().nullable().optional(),
  fsrs_stability: z.number().nullable().optional(),
  fsrs_difficulty: z.number().nullable().optional(),
  fsrs_last_review: z.string().nullable().optional(),
  fsrs_reps: z.number().int().nullable().optional(),
  fsrs_lapses: z.number().int().nullable().optional(),
  fsrs_state: z.number().int().nullable().optional(),
  fsrs_scheduled_days: z.number().int().nullable().optional(),
  fsrs_learning_steps: z.number().int().nullable().optional(),
  fsrs_version: z.string().nullable().optional(),
  // From schema version 15. The fallback due day, revision and archive state.
  due_on: dateSchema.optional(),
  revision: z.number().int().min(0).nullable().optional(),
  suspended_at: z.string().nullable().optional(),
  suspended_reason: z.string().nullable().optional(),
});

export type CardRow = z.infer<typeof cardRowSchema>;

export const CARD_COLUMNS =
  'id, word, word_key, meaning, definition, example, date_added, created_at, updated_at, deleted_at, mastery, review_date';

const FSRS_COLUMNS =
  'fsrs_due, fsrs_stability, fsrs_difficulty, fsrs_last_review, fsrs_reps, fsrs_lapses, fsrs_state, fsrs_scheduled_days, fsrs_learning_steps, fsrs_version';

/** Columns added with the FSRS-only phase. */
export const CARD_COLUMNS_V15 = 'due_on, revision, suspended_at, suspended_reason';

/** The columns a card is read with, which depends on what the database has. */
export const cardColumns = (schemaVersion: number): string =>
  [
    CARD_COLUMNS,
    ...(schemaVersion >= 3 ? [FSRS_COLUMNS] : []),
    ...(schemaVersion >= 15 ? [CARD_COLUMNS_V15] : []),
  ].join(', ');

/** An FSRS state as the database stores it, with the engine that produced it. */
export interface FsrsRow {
  due: string;
  stability: number;
  difficulty: number;
  last_review: string | null;
  reps: number;
  lapses: number;
  state: number;
  scheduled_days: number;
  learning_steps: number;
  version: string;
}

export function fsrsStateToRow(state: FsrsState, version: string): FsrsRow {
  return {
    due: state.due,
    stability: state.stability,
    difficulty: state.difficulty,
    last_review: state.lastReview,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    scheduled_days: state.scheduledDays,
    learning_steps: state.learningSteps,
    version,
  };
}

/** The FSRS state on a card row, or `null` when the card has none (or the database predates it). */
export function fsrsOfCard(row: CardRow): { state: FsrsState; version: string } | null {
  if (row.fsrs_due == null || row.fsrs_stability == null || row.fsrs_difficulty == null) return null;
  const parsed = fsrsStateSchema.safeParse({
    // The database prints timestamps its own way; the app always carries ISO strings.
    due: new Date(row.fsrs_due).toISOString(),
    stability: row.fsrs_stability,
    difficulty: row.fsrs_difficulty,
    scheduledDays: row.fsrs_scheduled_days ?? 0,
    learningSteps: row.fsrs_learning_steps ?? 0,
    reps: row.fsrs_reps ?? 0,
    lapses: row.fsrs_lapses ?? 0,
    state: row.fsrs_state ?? 2,
    lastReview: row.fsrs_last_review == null ? null : new Date(row.fsrs_last_review).toISOString(),
  });
  return parsed.success ? { state: parsed.data, version: row.fsrs_version ?? '' } : null;
}

/**
 * An FSRS state as the version 15 functions return it (the card's columns as
 * JSON), or `null` when there is none or it is not a complete state.
 */
export function fsrsFromJson(value: unknown): { state: FsrsState; version: string } | null {
  if (value === null || typeof value !== 'object') return null;
  const json = value as Record<string, unknown>;
  const at = (raw: unknown) => (typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : null);
  const due = at(json.due);
  if (due === null) return null;
  const parsed = fsrsStateSchema.safeParse({
    due,
    stability: json.stability,
    difficulty: json.difficulty,
    scheduledDays: json.scheduled_days ?? 0,
    learningSteps: json.learning_steps ?? 0,
    reps: json.reps ?? 0,
    lapses: json.lapses ?? 0,
    state: json.state ?? 2,
    lastReview: at(json.last_review),
  });
  return parsed.success ? { state: parsed.data, version: typeof json.version === 'string' ? json.version : '' } : null;
}

/** What `record_fsrs_review` reports (schema version 15). */
export const fsrsReviewRowSchema = z.object({
  outcome: z.enum(['applied', 'already_applied', 'undone', 'conflict', 'suspended', 'not_found']),
  revision: z.coerce.number().int().min(0).nullable(),
  due_on: dateSchema,
  fsrs: z.unknown().nullable(),
});

export type FsrsReviewRow = z.infer<typeof fsrsReviewRowSchema>;

/** What `undo_fsrs_review` reports (schema version 15). */
export const fsrsUndoRowSchema = z.object({
  outcome: z.enum(['undone', 'already_undone', 'not_latest', 'conflict', 'not_found']),
  vocabulary_id: z.string().nullable(),
  revision: z.coerce.number().int().min(0).nullable(),
  due_on: dateSchema,
  fsrs: z.unknown().nullable(),
});

export type FsrsUndoRow = z.infer<typeof fsrsUndoRowSchema>;

/** What `study_day_counts` reports (schema version 15). */
export const studyDayCountsRowSchema = z.object({
  new_words: z.coerce.number().int().min(0),
  reviews: z.coerce.number().int().min(0),
  practice: z.coerce.number().int().min(0),
});

// ---- The game (schema version 17) ----

const timestamp = z.string().min(1);
const isoDay = z.string().refine(isIsoDate);

export const gameAnswerRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['review', 'practice', 'undo']),
  undoes: z.string().nullable(),
  answered_at: timestamp,
  answered_on: isoDay,
  is_new: z.boolean(),
  counted: z.boolean(),
  was_due: z.boolean(),
  duration_ms: z.number().int().nullable(),
  mode: z.string().nullable(),
  mastered: z.boolean(),
  // Version 18 and later.
  recorded_at: timestamp.nullable().optional(),
});

export const gameMetricsRowSchema = z.object({
  words_studied: z.coerce.number().int(),
  mastered: z.coerce.number().int(),
  reviews: z.coerce.number().int(),
  practice: z.coerce.number().int(),
  duration_ms: z.coerce.number(),
  night_answers: z.coerce.number().int(),
});

export const gameStateRowSchema = z.object({
  version: z.coerce.number().int(),
  total_xp: z.coerce.number().int(),
  state: z.record(z.string(), z.unknown()),
  // Version 19 and later.
  stardust: z.coerce.number().int().optional(),
});

export const gameEventRowSchema = z.object({ event: z.string(), enabled: z.boolean() });

export const notificationSettingsRowSchema = z.object({
  streak: z.boolean(),
  league: z.boolean(),
  reminder: z.boolean(),
  social: z.boolean(),
  reminder_at: z.string(),
  quiet_from: z.string(),
  quiet_until: z.string(),
});

export function notificationSettingsFromRow(row: unknown): NotificationSettings {
  const parsed = notificationSettingsRowSchema.safeParse(row);
  if (!parsed.success) throw new DatabaseError('unavailable', 'The database returned reminder settings in an unexpected shape.');
  const { reminder_at, quiet_from, quiet_until, ...kinds } = parsed.data;
  return { ...kinds, reminderAt: reminder_at.slice(0, 5), quietFrom: quiet_from.slice(0, 5), quietUntil: quiet_until.slice(0, 5) };
}

export function notificationSettingsToRow(settings: NotificationSettings) {
  return {
    streak: settings.streak,
    league: settings.league,
    reminder: settings.reminder,
    social: settings.social,
    reminder_at: settings.reminderAt,
    quiet_from: settings.quietFrom,
    quiet_until: settings.quietUntil,
  };
}

export const gameQuestRowSchema = z.object({
  period: z.enum(['day', 'week']),
  period_start: isoDay,
  slot: z.coerce.number().int(),
  kind: z.string(),
  target: z.coerce.number().int(),
  reward: z.coerce.number().int(),
  progress: z.coerce.number().int(),
  completed_at: timestamp.nullable(),
});

export const gameBadgeRowSchema = z.object({ badge: z.string(), tier: z.coerce.number().int(), earned_at: timestamp });
export const gameFreezeRowSchema = z.object({ id: z.string(), granted_on: isoDay, used_on: isoDay.nullable() });
export const gameRewardRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  created_at: timestamp,
});
export const gameLedgerRowSchema = z.object({
  source_id: z.string(),
  amount: z.coerce.number().int(),
  reason: z.string(),
  earned_on: isoDay,
});
/**
 * The competition's functions (schema version 18). Each returns rows; the
 * competition service parses them. Only these names can be called.
 */
export const COMPETITION_FUNCTIONS = [
  'competition_me',
  'game_apply',
  'league_board',
  'league_unsettled',
  'league_weeks_to_settle',
  'profile_by_nickname',
  'profile_search',
  'profile_badges',
  'streak_days',
  'friends_list',
  'challenges_list',
  'is_app_admin',
  'admin_reports',
  // Version 19.
  'profile_showcase',
  'boss_progress',
] as const;
export type CompetitionFunction = (typeof COMPETITION_FUNCTIONS)[number];

export const gameCommitRowSchema = z.object({
  outcome: z.enum(['ok', 'stale']),
  version: z.coerce.number().int(),
  total_xp: z.coerce.number().int(),
});

export interface GameSnapshotRows {
  state: z.infer<typeof gameStateRowSchema> | null;
  quests: Array<z.infer<typeof gameQuestRowSchema>>;
  badges: Array<z.infer<typeof gameBadgeRowSchema>>;
  freezes: Array<z.infer<typeof gameFreezeRowSchema>>;
  rewards: Array<z.infer<typeof gameRewardRowSchema>>;
  /** Items owned (version 19); empty before. */
  inventory: string[];
}

/** One answer as `record_fsrs_review` takes it. */
export interface FsrsReviewArgs {
  id: string;
  requestId: string;
  sessionId: string | null;
  action: ReviewAction;
  expectedRevision: number;
  countsTowardSchedule: boolean;
  rating: number | null;
  version: string | null;
  after: FsrsRow | null;
  reviewedOn: IsoDate;
  reviewedAt: string | null;
  durationMs: number | null;
  confidence: number | null;
}

export interface NewCard {
  word: string;
  wordKey: string;
  mastery: number;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  dateAdded: IsoDate | null;
  reviewDate: IsoDate | null;
  /** Fallback due day for a word FSRS has never seen. */
  dueOn?: IsoDate | null;
  requestId: string | null;
  external?: { source: string; id: string; createdAt: string | null };
}

export interface ReviewWriteArgs {
  id: string;
  requestId: string;
  action: string;
  expectedMastery: number;
  expectedReviewDate: IsoDate | null;
  newMastery: number;
  newReviewDate: IsoDate | null;
  reviewedOn: IsoDate;
  durationMs: number | null;
  /** What FSRS made of the answer, saved with it. Needs schema version 3. */
  fsrs?: { rating: number; version: string; before: FsrsRow | null; after: FsrsRow } | null;
  /** How sure the reviewer was beforehand: 1, 2 or 3. Stored from schema version 5. */
  confidence?: number | null;
}

export interface StoredSettings {
  timeZone: string;
  /** `null` on a database that predates the setting. */
  fsrsRetention: number | null;
  /** `null` on a database that cannot keep a goal yet. */
  dailyGoal: DailyGoal | null;
  /** Which schedule is in charge; `null` on a database that cannot keep the choice yet. */
  scheduler: SchedulerId | null;
  /** Whether a review moves a word; `null` on a database that cannot keep the choice yet. */
  countReviewsTowardMastery: boolean | null;
  /** FSRS-first goals, where the database keeps them. */
  studyGoals: { newWords: number; reviews: number; practice: number; maintenanceMode: boolean } | null;
  maxReviewsPerDay: number | null;
  /** `null` follows the browser. */
  uiLanguage: 'vi' | 'en' | null;
}

export const reviewWriteResultSchema = z.object({
  outcome: z.enum(['applied', 'already_applied', 'undone', 'conflict', 'not_found']),
  mastery: z.number().int().nullable(),
  review_date: dateSchema,
});

export type ReviewWriteRow = z.infer<typeof reviewWriteResultSchema>;

/**
 * The newest migration this server knows how to use. A database that is
 * behind still serves everything its own version supports.
 */
export const LATEST_SCHEMA_VERSION = 20;

/**
 * The newest migration Settings asks the owner to run. Version 15 makes FSRS
 * the only schedule and converts the data for it; it is held back until the
 * screens for it exist (docs/fsrs-only-progress.md), so the app does not ask
 * for it yet. Raise this to LATEST_SCHEMA_VERSION when they do.
 */
export const RECOMMENDED_SCHEMA_VERSION = 20;

/** One row of the review history. Columns newer than the database's schema version are simply absent. */
export const reviewLogRowSchema = z.object({
  id: z.string(),
  vocabulary_id: z.string(),
  action: z.string(),
  review_mode: z.string(),
  reviewed_at: z.string(),
  reviewed_on: z.string().refine(isIsoDate),
  duration_ms: z.number().int().nullable(),
  mastery_before: z.number().int(),
  mastery_after: z.number().int(),
  review_date_before: dateSchema,
  review_date_after: dateSchema,
  /** Which schedule was in charge. Present at every version; only ever the mastery schedule before version 8. */
  scheduler: z.string().optional(),
  kind: z.string().optional(),
  session_id: z.string().nullable().optional(),
  undoes_log_id: z.string().nullable().optional(),
  rating: z.number().int().nullable().optional(),
  confidence: z.number().int().nullable().optional(),
  answer_correct: z.boolean().nullable().optional(),
  submitted_answer: z.string().nullable().optional(),
  grading: z.string().nullable().optional(),
});
export type ReviewLogRow = z.infer<typeof reviewLogRowSchema>;

/** The history columns a database at this version has. */
export const reviewLogColumns = (schemaVersion: number): string =>
  [
    'id, vocabulary_id, action, review_mode, reviewed_at, reviewed_on, duration_ms',
    'mastery_before, mastery_after, review_date_before, review_date_after, scheduler',
    ...(schemaVersion >= 2 ? ['kind, session_id, undoes_log_id'] : []),
    ...(schemaVersion >= 3 ? ['rating'] : []),
    ...(schemaVersion >= 5 ? ['confidence'] : []),
    ...(schemaVersion >= 6 ? ['answer_correct, submitted_answer, grading'] : []),
  ].join(', ');

export const collectionRowSchema = z.object({ id: z.string(), name: z.string() });
export type CollectionRow = z.infer<typeof collectionRowSchema>;

export const collectionItemRowSchema = z.object({ collection_id: z.string(), vocabulary_id: z.string() });
export type CollectionItemRow = z.infer<typeof collectionItemRowSchema>;

export const exampleRowSchema = z.object({
  id: z.string(),
  vocabulary_id: z.string(),
  sentence: z.string(),
  source: z.string().nullable(),
  preferred: z.boolean(),
});
export type ExampleRow = z.infer<typeof exampleRowSchema>;

export const relationRowSchema = z.object({ id: z.string(), low_id: z.string(), high_id: z.string(), kind: z.string() });
export type RelationRow = z.infer<typeof relationRowSchema>;

export const EXAMPLE_COLUMNS = 'id, vocabulary_id, sentence, source, preferred';
export const RELATION_COLUMNS = 'id, low_id, high_id, kind';

/** PostgreSQL's codes for "that value already exists" and "that row is not there to point at". */
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';

/** One practice answer as the database records it. */
export interface PracticeWriteArgs {
  id: string;
  requestId: string;
  sessionId: string | null;
  mode: string;
  correct: boolean;
  grading: 'self' | 'auto';
  submitted: string | null;
  reviewedOn: IsoDate;
  durationMs: number | null;
  confidence: number | null;
}

export const practiceOutcomeSchema = z.enum(['recorded', 'already_recorded', 'not_found']);
export type PracticeOutcome = z.infer<typeof practiceOutcomeSchema>;

export const practiceStatRowSchema = z.object({
  day: z.string().refine(isIsoDate),
  review_mode: z.string(),
  answers: z.number().int(),
  correct: z.number().int(),
  duration_ms: z.number().int(),
  timed_answers: z.number().int(),
  cards: z.number().int(),
});

export type PracticeStatRow = z.infer<typeof practiceStatRowSchema>;

export const practiceHistoryRowSchema = z.object({
  vocabulary_id: z.string(),
  review_mode: z.string(),
  answer_correct: z.boolean(),
  grading: z.string(),
  submitted_answer: z.string().nullable(),
  reviewed_on: z.string().refine(isIsoDate),
  reviewed_at: z.string(),
  duration_ms: z.number().int().nullable(),
  confidence: z.number().int().nullable(),
  session_id: z.string().uuid().nullable(),
});

export type PracticeHistoryRow = z.infer<typeof practiceHistoryRowSchema>;

export const confidenceStatRowSchema = z.object({
  confidence: z.number().int().min(1).max(3),
  reviews: z.number().int(),
  remembered: z.number().int(),
});

export type ConfidenceStatRow = z.infer<typeof confidenceStatRowSchema>;

export const dailyStatRowSchema = z.object({
  day: z.string().refine(isIsoDate),
  review_mode: z.string(),
  reviews: z.number().int(),
  remembered: z.number().int(),
  not_remembered: z.number().int(),
  repeat_reviews: z.number().int(),
  repeat_remembered: z.number().int(),
  duration_ms: z.number().int(),
  timed_reviews: z.number().int(),
  cards: z.number().int(),
});

export type DailyStatRow = z.infer<typeof dailyStatRowSchema>;

export const cardStatRowSchema = z.object({
  vocabulary_id: z.string(),
  reviews: z.number().int(),
  failures: z.number().int(),
  recent_reviews: z.number().int(),
  recent_failures: z.number().int(),
  failed_days: z.number().int(),
  last_reviewed_on: dateSchema,
  last_failed_on: dateSchema,
  last_action: z.string().nullable(),
});

export type CardStatRow = z.infer<typeof cardStatRowSchema>;

/** One day of one word's answers, review and practice together. */
export const weakWordDayRowSchema = z.object({
  vocabulary_id: z.string(),
  day: z.string().refine(isIsoDate),
  review_answers: z.number().int(),
  review_fails: z.number().int(),
  practice_answers: z.number().int(),
  practice_fails: z.number().int(),
  day_points: z.number(),
  last_action: z.string().nullable(),
});

export type WeakWordDayDbRow = z.infer<typeof weakWordDayRowSchema>;

export const undoResultSchema = z.object({
  outcome: z.enum(['undone', 'already_undone', 'not_latest', 'conflict', 'not_found']),
  vocabulary_id: z.string().nullable(),
  mastery: z.number().int().nullable(),
  review_date: dateSchema,
});

export type UndoRow = z.infer<typeof undoResultSchema>;

export const sessionSummaryRowSchema = z.object({
  session_id: z.string(),
  started_at: z.string(),
  last_review_at: z.string().nullable(),
  reviewed: z.number().int(),
  remembered: z.number().int(),
  not_remembered: z.number().int(),
  first_time: z.number().int(),
  undone: z.number().int(),
  duration_ms: z.number().int(),
  timed_reviews: z.number().int(),
});

export type SessionSummaryRow = z.infer<typeof sessionSummaryRowSchema>;

export const vocabularyAnalysisRowSchema = z.object({
  id: z.string(),
  vocabulary_id: z.string(),
  pronunciation: z.string().nullable(),
  part_of_speech: z.string().nullable(),
  cefr_level: z.string().nullable(),
  confidence: z.number().nullable(),
  english_definition: z.string().nullable(),
  vietnamese_meaning: z.string().nullable(),
  senses: z.unknown(),
  examples: z.unknown(),
  word_family: z.unknown(),
  collocations: z.unknown(),
  synonyms: z.unknown(),
  antonyms: z.unknown(),
  usage_notes: z.string().nullable(),
  common_mistakes: z.string().nullable(),
  revision_summary: z.string().nullable(),
  model: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type VocabularyAnalysisRow = z.infer<typeof vocabularyAnalysisRowSchema>;

/** AI conversation row as returned by the database. */
export const aiConversationRowSchema = z.object({
  id: z.string().uuid(),
  mode: z.enum(['general', 'vocabulary_expert']),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AiConversationRow = z.infer<typeof aiConversationRowSchema>;

/** AI message row as returned by the database. */
export const aiMessageRowSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type AiMessageRow = z.infer<typeof aiMessageRowSchema>;

/** Rate limit check result row as returned by the database. */
export const rateLimitCheckRowSchema = z.object({
  allowed: z.boolean(),
  retry_after_seconds: z.number().int(),
  current_count: z.number().int(),
  limit: z.number().int(),
});
export type RateLimitCheckRow = z.infer<typeof rateLimitCheckRowSchema>;

/** Keys the edit function accepts. Anything else is refused by the database itself. */
export type CardPatch = Partial<{
  word: string;
  word_key: string;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  date_added: string | null;
  mastery: number;
  review_date: string | null;
}>;

export interface VocabularyDatabase {
  /** Live words, oldest first. */
  listCards(): Promise<CardRow[]>;
  /** Trashed words, most recently trashed first. */
  listTrashedCards(): Promise<CardRow[]>;
  /** Live words below `retiredAt` that are due on or before `today`, or have no date. */
  listDueCards(today: IsoDate, retiredAt: number): Promise<CardRow[]>;
  /** One word, trashed or not. */
  getCard(id: string): Promise<CardRow | null>;
  findCardsByWordKey(wordKey: string): Promise<CardRow[]>;
  findCardByRequestId(requestId: string): Promise<CardRow | null>;
  /** Which words came from an import of `source`, trashed ones included. Used to reconcile a migration. */
  listImported(source: string): Promise<Array<{ id: string; externalId: string }>>;
  countCards(options?: { masteryBelow?: number }): Promise<number>;
  createCard(card: NewCard): Promise<{ id: string; created: boolean }>;
  /** False when there is no such live word. */
  updateCard(id: string, patch: CardPatch): Promise<boolean>;
  /** Archives or resumes words in bulk. Returns the words that changed, as they now are. Needs schema version 15. */
  setCardsSuspended?(ids: readonly string[], suspended: boolean): Promise<CardRow[]>;
  /** Saves an answer under FSRS alone. Needs schema version 15. */
  recordFsrsReview?(args: FsrsReviewArgs): Promise<FsrsReviewRow>;
  /** Takes an answer back under FSRS alone. Needs schema version 15. */
  undoFsrsReview?(args: { reviewRequestId: string; requestId: string }): Promise<FsrsUndoRow>;
  /** Needs schema version 15. */
  studyDayCounts?(day: IsoDate): Promise<{ new_words: number; reviews: number; practice: number }>;
  /** Needs schema version 15. Returns whether the day is met now. */
  recordStudyDay?(row: StudyDayRow): Promise<boolean>;
  /** Needs schema version 15. Oldest first. */
  listMetStudyDays?(): Promise<IsoDate[]>;
  /** Needs schema version 17: the game's stored rows, quests for the day and the week given. */
  gameSnapshot?(today: IsoDate, weekStart: IsoDate): Promise<GameSnapshotRows>;
  /** Needs schema version 17: answers not yet counted, oldest first. */
  gamePendingAnswers?(limit: number): Promise<Array<z.infer<typeof gameAnswerRowSchema>>>;
  /** Needs schema version 17: what the ledger gave the answers named. */
  gameLedger?(answerIds: readonly string[]): Promise<Array<z.infer<typeof gameLedgerRowSchema>>>;
  /** Needs schema version 17. */
  gameBadgeMetrics?(): Promise<z.infer<typeof gameMetricsRowSchema>>;
  /** Needs schema version 17: applies a change the server signed. */
  gameCommit?(payload: string, signature: string): Promise<z.infer<typeof gameCommitRowSchema>>;
  /** Needs schema version 18: one of the competition's functions, with named arguments; its rows as JSON. */
  competitionCall?(fn: CompetitionFunction, args: Record<string, string | string[] | null>): Promise<unknown[]>;
  /** Needs schema version 20: the account's reminder choices; null before it chose any. */
  notificationSettings?(): Promise<NotificationSettings | null>;
  saveNotificationSettings?(settings: NotificationSettings): Promise<void>;
  pushDevices?(): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>>;
  addPushDevice?(device: { endpoint: string; p256dh: string; auth: string }): Promise<void>;
  removePushDevice?(endpoint: string): Promise<void>;
  /** Needs schema version 19: the events an admin switched on or off; one not listed is on. */
  gameEvents?(): Promise<Array<z.infer<typeof gameEventRowSchema>>>;
  setCardTrashed(id: string, trashed: boolean): Promise<boolean>;
  applyReview(args: ReviewWriteArgs): Promise<ReviewWriteRow>;
  findReviewByRequestId(requestId: string): Promise<{ mastery: number; reviewDate: IsoDate | null } | null>;
  /** The newest migration applied to the database; 1 when only the first one is. */
  schemaVersion(): Promise<number>;
  /** Saves an answer as part of a session. Needs schema version 2. */
  recordReview(args: ReviewWriteArgs & { sessionId: string | null }): Promise<ReviewWriteRow>;
  /** Reverses one answer, named by the request id it was saved with. Needs schema version 2. */
  undoReview(args: { reviewRequestId: string; requestId: string }): Promise<UndoRow>;
  /** What a session saved, or `null` if the caller has no such session. Needs schema version 2. */
  sessionSummary(sessionId: string): Promise<SessionSummaryRow | null>;
  /** Saved reviews per day and study mode, undone ones excluded. Needs schema version 4. */
  reviewDailyStats(from: IsoDate, to: IsoDate): Promise<DailyStatRow[]>;
  /** How each reviewed word has gone, overall and since `since`. Needs schema version 4. */
  cardReviewStats(since: IsoDate): Promise<CardStatRow[]>;
  /** One day of one word's answers, review and practice together. Needs schema version 14. */
  weakWordDays(): Promise<WeakWordDayDbRow[]>;
  /** Every row of the caller's review history, oldest first. Reads only. */
  listReviewLogs(): Promise<ReviewLogRow[]>;
  // ---- Collections, further examples, relationships. All need schema version 7. ----
  /** The caller's collections, by name. */
  listCollections(): Promise<CollectionRow[]>;
  listCollectionItems(): Promise<CollectionItemRow[]>;
  insertCollection(name: string, nameKey: string): Promise<CollectionRow | 'duplicate'>;
  /** `null` when there is no such collection of the caller's. */
  renameCollection(id: string, name: string, nameKey: string): Promise<CollectionRow | 'duplicate' | null>;
  deleteCollection(id: string): Promise<boolean>;
  /** False when the collection or the word is not the caller's. Adding a word twice is not an error. */
  addCollectionItem(collectionId: string, vocabularyId: string): Promise<boolean>;
  /** False when there is no such collection of the caller's. */
  removeCollectionItem(collectionId: string, vocabularyId: string): Promise<boolean>;
  listExamples(): Promise<ExampleRow[]>;
  getExample(id: string): Promise<ExampleRow | null>;
  /** `null` when the word is not the caller's. */
  insertExample(vocabularyId: string, sentence: string, source: string | null): Promise<ExampleRow | null>;
  updateExample(id: string, changes: { sentence?: string; source?: string | null }): Promise<ExampleRow | null>;
  setPreferredExample(id: string, preferred: boolean): Promise<boolean>;
  deleteExample(id: string): Promise<boolean>;
  listRelations(): Promise<RelationRow[]>;
  /** The link, the existing one if the pair is already linked this way, or `null` when a word is not the caller's. */
  insertRelation(lowId: string, highId: string, kind: string): Promise<RelationRow | null>;
  deleteRelation(id: string): Promise<boolean>;
  /** Records one practice answer. It never changes a word's schedule. Needs schema version 6. */
  recordPractice(args: PracticeWriteArgs): Promise<PracticeOutcome>;
  /** Practice answers per day and study mode. Needs schema version 6. */
  practiceDailyStats(from: IsoDate, to: IsoDate): Promise<PracticeStatRow[]>;
  /** Practice history per word, with enough detail for True Mastery. Needs schema version 7. */
  practiceHistory(since: IsoDate | null): Promise<PracticeHistoryRow[]>;
  /** Answers since `since` that carried a confidence rating, by rating. Needs schema version 5. */
  confidenceStats(since: IsoDate): Promise<ConfidenceStatRow[]>;
  /** The study mode of each correct practice answer recorded for one word. Needs schema version 6. */
  listCorrectPracticeModes(vocabularyId: string): Promise<string[]>;
  /** Vocabulary Analysis: upsert analysis for a vocabulary entry. Needs schema version 11. */
  upsertVocabularyAnalysis(args: {
    vocabularyId: string;
    pronunciation?: string | null;
    partOfSpeech?: string | null;
    cefrLevel?: string | null;
    confidence?: number | null;
    englishDefinition?: string | null;
    vietnameseMeaning?: string | null;
    senses?: Record<string, unknown>[];
    examples?: Record<string, unknown>[];
    wordFamily?: Record<string, unknown>[];
    collocations?: Record<string, unknown>[];
    synonyms?: Record<string, unknown>[];
    antonyms?: Record<string, unknown>[];
    usageNotes?: string | null;
    commonMistakes?: string | null;
    revisionSummary?: string | null;
    model?: string | null;
  }): Promise<VocabularyAnalysisRow>;
  /** Vocabulary Analysis: get analysis for a vocabulary entry. Needs schema version 11. */
  getVocabularyAnalysis(vocabularyId: string): Promise<VocabularyAnalysisRow | null>;
  /** Vocabulary Analysis: delete analysis for a vocabulary entry. Needs schema version 11. */
  deleteVocabularyAnalysis(vocabularyId: string): Promise<boolean>;
  /** The account's settings in one read, or `null` if it has none yet. */
  getSettings(): Promise<StoredSettings | null>;
  /** Needs schema version 5. */
  saveDailyGoal(goal: DailyGoal): Promise<DailyGoal>;
  /** Needs schema version 3. */
  saveFsrsRetention(value: number): Promise<number>;
  /** Needs schema version 8. */
  saveScheduler(value: SchedulerId): Promise<SchedulerId>;
  /** Needs schema version 13. */
  saveCountReviewsTowardMastery(value: boolean): Promise<boolean>;
  /** Needs schema version 15. */
  saveStudyGoals?(goal: { newWords: number; reviews: number; practice: number; maintenanceMode: boolean }): Promise<{
    newWords: number;
    reviews: number;
    practice: number;
    maintenanceMode: boolean;
  }>;
  /** Needs schema version 15. */
  saveMaxReviewsPerDay?(value: number | null): Promise<number | null>;
  /** Needs schema version 15. */
  saveUiLanguage?(value: 'vi' | 'en' | null): Promise<'vi' | 'en' | null>;
  getTimeZone(): Promise<string | null>;
  /** Stores the zone only if the user has none yet; returns the one in effect. */
  ensureTimeZone(timeZone: string): Promise<string>;
  saveTimeZone(timeZone: string): Promise<string>;
  // ---- AI Conversations (schema version 10) ----
  /** Lists the caller's conversations, most recently updated first. */
  listAiConversations(limit?: number, offset?: number): Promise<AiConversationRow[]>;
  /** Creates a new conversation for the caller. */
  createAiConversation(mode: 'general' | 'vocabulary_expert', title?: string): Promise<AiConversationRow>;
  /** Gets one conversation by id, only if it belongs to the caller. */
  getAiConversation(id: string): Promise<AiConversationRow | null>;
  /** Updates the title of a conversation owned by the caller. */
  updateAiConversationTitle(id: string, title: string): Promise<boolean>;
  /** Deletes a conversation and its messages (cascade via FK). */
  deleteAiConversation(id: string): Promise<boolean>;
  /** Lists messages for a conversation owned by the caller, oldest first. */
  listAiMessages(conversationId: string, limit?: number, offset?: number): Promise<AiMessageRow[]>;
  /** Appends a message to a conversation owned by the caller. Returns the created message row. */
  insertAiMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<AiMessageRow>;
  /** Marks one assistant message as saved to a word. Needs schema version 12. */
  markAiMessageSaved(conversationId: string, messageId: string, vocabularyId: string): Promise<boolean>;
  /** Checks and increments rate limit counters for the caller. */
  checkAiRateLimit(
    mode: 'general' | 'vocabulary_expert',
    window: 'minute' | 'day',
    limit: number,
  ): Promise<RateLimitCheckRow>;
}

/**
 * What `record_practice` answered. The function returns one column, and how
 * the API hands back a one-column result is not something to depend on: a row
 * object, a bare value, or either of those in a list are all read here.
 */
export function practiceOutcomeOf(data: unknown): z.infer<typeof practiceOutcomeSchema> | null {
  const first: unknown = Array.isArray(data) ? data[0] : data;
  const value: unknown = typeof first === 'object' && first !== null ? (first as { outcome?: unknown }).outcome : first;
  const outcome = practiceOutcomeSchema.safeParse(value);
  return outcome.success ? outcome.data : null;
}

/** A settings row as read; which columns it has depends on the schema version. */
export interface SettingsRow {
  time_zone: string;
  fsrs_request_retention?: number | string | null;
  daily_goal_reviews?: number | null;
  daily_goal_minutes?: number | null;
  /** From schema version 8. */
  scheduler?: string | null;
  /** From schema version 13. */
  count_reviews_toward_mastery?: boolean | null;
  /** From schema version 15. */
  study_goal_new_words?: number | null;
  study_goal_reviews?: number | null;
  /** From schema version 16. */
  study_goal_practice?: number | null;
  maintenance_mode?: boolean | null;
  max_reviews_per_day?: number | null;
  ui_language?: string | null;
}

/** The settings columns a database at this version has. */
export const settingsColumns = (schemaVersion: number): string =>
  [
    'time_zone',
    ...(schemaVersion >= 3 ? ['fsrs_request_retention'] : []),
    ...(schemaVersion >= 5 ? ['daily_goal_reviews', 'daily_goal_minutes'] : []),
    ...(schemaVersion >= 8 ? ['scheduler'] : []),
    ...(schemaVersion >= 13 ? ['count_reviews_toward_mastery'] : []),
    ...(schemaVersion >= 15
      ? [
          'study_goal_new_words',
          'study_goal_reviews',
          'maintenance_mode',
          'max_reviews_per_day',
          'ui_language',
        ]
      : []),
    ...(schemaVersion >= 16 ? ['study_goal_practice'] : []),
  ].join(', ');

export function settingsFromRow(row: SettingsRow, schemaVersion: number): StoredSettings {
  const retention = row.fsrs_request_retention == null ? null : Number(row.fsrs_request_retention);
  const language = row.ui_language === 'en' || row.ui_language === 'vi' ? row.ui_language : null;
  return {
    timeZone: row.time_zone,
    fsrsRetention: retention !== null && Number.isFinite(retention) ? retention : null,
    dailyGoal:
      schemaVersion >= 5 ? { reviews: row.daily_goal_reviews ?? null, minutes: row.daily_goal_minutes ?? null } : null,
    // From version 15 the stored choice is migrated to FSRS. An older database
    // still reads as the legacy schedule so nothing is silently switched.
    scheduler:
      schemaVersion >= 15
        ? 'fsrs'
        : schemaVersion >= 8
          ? isSchedulerId(row.scheduler)
            ? row.scheduler
            : DEFAULT_SCHEDULER
          : null,
    // A database that cannot keep the choice counts every review, as it always did.
    // From version 15 the same choice decides whether an answer moves the FSRS schedule.
    countReviewsTowardMastery: schemaVersion >= 13 ? row.count_reviews_toward_mastery !== false : null,
    // Null until the reviewer has chosen; the app then suggests a pair.
    studyGoals:
      schemaVersion >= 15 && row.study_goal_new_words != null && row.study_goal_reviews != null
        ? {
            newWords: row.study_goal_new_words,
            reviews: row.study_goal_reviews,
            // The practice goal is kept from version 16; before that the suggestion stands.
            practice: schemaVersion >= 16 ? (row.study_goal_practice ?? 20) : 20,
            maintenanceMode: row.maintenance_mode === true,
          }
        : null,
    maxReviewsPerDay: schemaVersion >= 15 ? (row.max_reviews_per_day ?? null) : null,
    uiLanguage: schemaVersion >= 15 ? language : null,
  };
}

/** A practice answer in the form `record_practice` reads. Shared with the test database so both send the same thing. */
export function practiceEvent(args: PracticeWriteArgs): Record<string, string | number | boolean | null> {
  return {
    vocabulary_id: args.id,
    request_id: args.requestId,
    session_id: args.sessionId,
    review_mode: args.mode,
    answer_correct: args.correct,
    grading: args.grading,
    submitted_answer: args.submitted,
    reviewed_on: args.reviewedOn,
    duration_ms: args.durationMs,
    confidence: args.confidence,
  };
}

export type DatabaseFailure = 'unauthorized' | 'forbidden' | 'schema_missing' | 'invalid' | 'unavailable';

/** A database failure reduced to what the rest of the server needs to know. */
export class DatabaseError extends Error {
  constructor(
    public readonly failure: DatabaseFailure,
    message: string,
    /** The database's own error code, for the server log. Never its message, which can quote stored values. */
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

interface PostgrestFailure {
  code?: string;
  message?: string;
}

/** Maps a PostgREST / PostgreSQL error to a failure the API can report honestly. */
export function toDatabaseError(error: PostgrestFailure, status?: number): DatabaseError {
  const code = error.code ?? '';
  const logged = code === '' ? (status === undefined ? null : `HTTP ${status}`) : code;
  // Expired or invalid access token.
  if (status === 401 || code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303') {
    return new DatabaseError('unauthorized', 'Your session has expired. Sign in again.', logged);
  }
  // Missing table, view or function: the migrations have not been applied.
  if (code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205') {
    return new DatabaseError(
      'schema_missing',
      'The database schema is not installed. Apply the migrations in supabase/migrations.',
      logged,
    );
  }
  // game_commit before its signing key is set (schema version 17).
  if (code === '55000') {
    return new DatabaseError(
      'schema_missing',
      'XP and levels are not set up in the database yet: set the game signing key (docs/gamification-plan.md).',
      logged,
    );
  }
  // Insufficient privilege or a row-level security violation.
  if (code === '42501' || status === 403) {
    return new DatabaseError('forbidden', 'The database refused this change.', logged);
  }
  // A value the schema does not accept: check, not-null, foreign key, bad input.
  if (code.startsWith('22') || code.startsWith('23')) {
    return new DatabaseError('invalid', 'The database rejected a value in this change.', logged);
  }
  return new DatabaseError('unavailable', 'The database is temporarily unavailable.', logged);
}

/** PostgREST returns at most this many rows per request by default, so lists are read in pages. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;

function parseRows(rows: unknown): CardRow[] {
  const parsed = z.array(cardRowSchema).safeParse(rows);
  if (!parsed.success) throw new DatabaseError('unavailable', 'The database returned rows in an unexpected shape.');
  return parsed.data;
}

type Client = SupabaseClient<Database>;

/** A client that acts as one signed-in user for the length of one request. */
export function createUserClient(url: string, publicKey: string, accessToken: string): Client {
  return createClient<Database>(url, publicKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function createSupabaseDatabase(
  client: Client,
  /** What the database has. Decides which columns are asked for, so an older database is never asked for new ones. */
  schemaVersion: number = LATEST_SCHEMA_VERSION,
): VocabularyDatabase {
  const columns = cardColumns(schemaVersion);
  /** Reads a filtered list to the end, one page at a time. */
  const readAll = async (
    page: (from: number, to: number) => PromiseLike<{ data: unknown; error: PostgrestFailure | null; status: number }>,
  ): Promise<CardRow[]> => {
    const rows: CardRow[] = [];
    for (let index = 0; index < MAX_PAGES; index += 1) {
      const { data, error, status } = await page(index * PAGE_SIZE, (index + 1) * PAGE_SIZE - 1);
      if (error) throw toDatabaseError(error, status);
      const batch = parseRows(data ?? []);
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) return rows;
    }
    throw new DatabaseError('unavailable', `Stopped after ${MAX_PAGES} pages of results.`);
  };

  const cards = () => client.from('vocabulary_cards').select(columns);

  /** Reads a whole table of the caller's own rows, a page at a time, in a fixed order. */
  const readTable = async <T>(
    page: (from: number, to: number) => PromiseLike<{ data: unknown; error: PostgrestFailure | null; status: number }>,
    schema: z.ZodType<T>,
  ): Promise<T[]> => {
    const rows: T[] = [];
    for (let index = 0; index < MAX_PAGES; index += 1) {
      const { data, error, status } = await page(index * PAGE_SIZE, (index + 1) * PAGE_SIZE - 1);
      if (error) throw toDatabaseError(error, status);
      const batch = z.array(schema).safeParse(data ?? []);
      if (!batch.success) throw new DatabaseError('unavailable', 'The database returned rows in an unexpected shape.');
      rows.push(...batch.data);
      if (batch.data.length < PAGE_SIZE) return rows;
    }
    throw new DatabaseError('unavailable', `Stopped after ${MAX_PAGES} pages of results.`);
  };

  return {
    listCards: () =>
      readAll((from, to) =>
        cards().is('deleted_at', null).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to),
      ),

    listTrashedCards: () =>
      readAll((from, to) =>
        cards().not('deleted_at', 'is', null).order('deleted_at', { ascending: false }).order('id', { ascending: true }).range(from, to),
      ),

    listDueCards: (today, retiredAt) =>
      readAll((from, to) =>
        cards()
          .is('deleted_at', null)
          .lt('mastery', retiredAt)
          .or(`review_date.is.null,review_date.lte.${today}`)
          // Most overdue first; words with no date last; then a fixed order so pages never overlap.
          .order('review_date', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),

    async getCard(id) {
      const { data, error, status } = await cards().eq('id', id).maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : (parseRows([data])[0] ?? null);
    },

    async findCardsByWordKey(wordKey) {
      const { data, error, status } = await cards().is('deleted_at', null).eq('word_key', wordKey).order('created_at');
      if (error) throw toDatabaseError(error, status);
      return parseRows(data ?? []);
    },

    async findCardByRequestId(requestId) {
      const found = await client.from('vocabulary').select('id').eq('request_id', requestId).maybeSingle();
      if (found.error) throw toDatabaseError(found.error, found.status);
      return found.data === null ? null : this.getCard(found.data.id);
    },

    async listImported(source) {
      const imported: Array<{ id: string; externalId: string }> = [];
      for (let index = 0; index < MAX_PAGES; index += 1) {
        const { data, error, status } = await client
          .from('vocabulary')
          .select('id, external_id')
          .eq('external_source', source)
          .order('id', { ascending: true })
          .range(index * PAGE_SIZE, (index + 1) * PAGE_SIZE - 1);
        if (error) throw toDatabaseError(error, status);
        for (const row of data ?? []) {
          if (row.external_id !== null) imported.push({ id: row.id, externalId: row.external_id });
        }
        if ((data ?? []).length < PAGE_SIZE) return imported;
      }
      throw new DatabaseError('unavailable', `Stopped after ${MAX_PAGES} pages of results.`);
    },

    async countCards(options = {}) {
      let query = client.from('vocabulary_cards').select('id', { count: 'exact', head: true }).is('deleted_at', null);
      if (options.masteryBelow !== undefined) query = query.lt('mastery', options.masteryBelow);
      const { count, error, status } = await query;
      if (error) throw toDatabaseError(error, status);
      return count ?? 0;
    },

    async createCard(card) {
      const { data, error, status } = await client.rpc('create_vocabulary', {
        p_word: card.word,
        p_word_key: card.wordKey,
        p_mastery: card.mastery,
        p_meaning: card.meaning,
        p_definition: card.definition,
        p_example: card.example,
        p_date_added: card.dateAdded,
        p_review_date: card.reviewDate,
        p_request_id: card.requestId,
        p_external_source: card.external?.source ?? null,
        p_external_id: card.external?.id ?? null,
        p_created_at: card.external?.createdAt ?? null,
      });
      if (error) throw toDatabaseError(error, status);
      const row = z.array(z.object({ id: z.string(), created: z.boolean() })).safeParse(data);
      if (!row.success || row.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the new word.');
      }
      // From version 15 a trigger copies the review date into `due_on`, the day the word first comes up.
      return row.data[0];
    },

    async setCardsSuspended(ids, suspended) {
      if (schemaVersion < 15) return [];
      const { data, error, status } = await client.rpc('set_cards_suspended', { p_ids: [...ids], p_suspended: suspended });
      if (error) throw toDatabaseError(error, status);
      const parsed = z.array(z.object({ vocabulary_id: z.string() })).safeParse(data ?? []);
      if (!parsed.success) throw new DatabaseError('unavailable', 'The database did not confirm the archive.');
      const changed = new Set(parsed.data.map((row) => row.vocabulary_id));
      if (changed.size === 0) return [];
      const { data: rows, error: readError, status: readStatus } = await client
        .from('vocabulary_cards')
        .select(columns)
        .in('id', [...changed]);
      if (readError) throw toDatabaseError(readError, readStatus);
      return parseRows(rows ?? []);
    },

    async updateCard(id, patch) {
      const { data, error, status } = await client.rpc('update_vocabulary', { p_id: id, p_patch: patch });
      if (error) throw toDatabaseError(error, status);
      return data === true;
    },

    async setCardTrashed(id, trashed) {
      let query = client
        .from('vocabulary')
        .update({ deleted_at: trashed ? new Date().toISOString() : null })
        .eq('id', id);
      // Trashing twice must not move the timestamp; restoring a live word is a no-op.
      query = trashed ? query.is('deleted_at', null) : query.not('deleted_at', 'is', null);
      const { data, error, status } = await query.select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },

    async applyReview(args) {
      const { data, error, status } = await client.rpc('apply_review', {
        p_vocabulary_id: args.id,
        p_request_id: args.requestId,
        p_action: args.action,
        p_expected_mastery: args.expectedMastery,
        p_expected_review_date: args.expectedReviewDate,
        p_new_mastery: args.newMastery,
        p_new_review_date: args.newReviewDate,
        p_reviewed_on: args.reviewedOn,
        p_duration_ms: args.durationMs,
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(reviewWriteResultSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the review.');
      }
      return rows.data[0];
    },

    async findReviewByRequestId(requestId) {
      const { data, error, status } = await client
        .from('review_logs')
        .select('mastery_after, review_date_after')
        .eq('request_id', requestId)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : { mastery: data.mastery_after, reviewDate: data.review_date_after };
    },

    async schemaVersion() {
      const { data, error, status } = await client.rpc('app_schema_version');
      // The marker itself arrived with the second migration: no function means version 1.
      if (error?.code === 'PGRST202' || error?.code === '42883') return 1;
      if (error) throw toDatabaseError(error, status);
      return typeof data === 'number' && Number.isInteger(data) && data >= 1 ? data : 1;
    },

    async recordReview(args) {
      const { data, error, status } = await client.rpc('record_review', {
        p_event: {
          vocabulary_id: args.id,
          request_id: args.requestId,
          session_id: args.sessionId,
          action: args.action,
          expected_mastery: args.expectedMastery,
          expected_review_date: args.expectedReviewDate,
          new_mastery: args.newMastery,
          new_review_date: args.newReviewDate,
          reviewed_on: args.reviewedOn,
          duration_ms: args.durationMs,
          ...(args.fsrs == null ? {} : { fsrs: args.fsrs }),
          ...(args.confidence == null ? {} : { confidence: args.confidence }),
        },
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(reviewWriteResultSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the review.');
      }
      return rows.data[0];
    },

    async reviewDailyStats(from, to) {
      const { data, error, status } = await client.rpc('review_daily_stats', { p_from: from, p_to: to });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(dailyStatRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned statistics in an unexpected shape.');
      return rows.data;
    },

    async cardReviewStats(since) {
      const { data, error, status } = await client.rpc('card_review_stats', { p_since: since });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(cardStatRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned statistics in an unexpected shape.');
      return rows.data;
    },

    async weakWordDays() {
      const { data, error, status } = await client.rpc('weak_word_days');
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(weakWordDayRowSchema).safeParse(data ?? []);
      if (!rows.success) {
        throw new DatabaseError('unavailable', 'The database returned weak-word days in an unexpected shape.');
      }
      return rows.data;
    },

    listReviewLogs: () =>
      readTable(
        (from, to) =>
          client
            .from('review_logs')
            .select(reviewLogColumns(schemaVersion))
            .order('reviewed_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        reviewLogRowSchema,
      ),

    listCollections: () =>
      readTable(
        (from, to) => client.from('collections').select('id, name').order('name_key').order('id').range(from, to),
        collectionRowSchema,
      ),

    listCollectionItems: () =>
      readTable(
        (from, to) =>
          client
            .from('collection_items')
            .select('collection_id, vocabulary_id')
            .order('collection_id')
            .order('vocabulary_id')
            .range(from, to),
        collectionItemRowSchema,
      ),

    async insertCollection(name, nameKey) {
      const { data, error, status } = await client
        .from('collections')
        .insert({ name, name_key: nameKey })
        .select('id, name')
        .single();
      if (error?.code === UNIQUE_VIOLATION) return 'duplicate';
      if (error) throw toDatabaseError(error, status);
      return collectionRowSchema.parse(data);
    },

    async renameCollection(id, name, nameKey) {
      const { data, error, status } = await client
        .from('collections')
        .update({ name, name_key: nameKey })
        .eq('id', id)
        .select('id, name');
      if (error?.code === UNIQUE_VIOLATION) return 'duplicate';
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : collectionRowSchema.parse(row);
    },

    async deleteCollection(id) {
      const { data, error, status } = await client.from('collections').delete().eq('id', id).select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },

    async addCollectionItem(collectionId, vocabularyId) {
      const { error, status } = await client
        .from('collection_items')
        .upsert(
          { collection_id: collectionId, vocabulary_id: vocabularyId },
          { onConflict: 'collection_id,vocabulary_id', ignoreDuplicates: true },
        );
      // The composite foreign keys refuse a collection or a word that is not the caller's own.
      if (error?.code === FOREIGN_KEY_VIOLATION) return false;
      if (error) throw toDatabaseError(error, status);
      return true;
    },

    async removeCollectionItem(collectionId, vocabularyId) {
      const owned = await client.from('collections').select('id').eq('id', collectionId).maybeSingle();
      if (owned.error) throw toDatabaseError(owned.error, owned.status);
      if (owned.data === null) return false;
      const { error, status } = await client
        .from('collection_items')
        .delete()
        .eq('collection_id', collectionId)
        .eq('vocabulary_id', vocabularyId);
      if (error) throw toDatabaseError(error, status);
      return true;
    },

    listExamples: () =>
      readTable(
        (from, to) =>
          client
            .from('vocabulary_examples')
            .select(EXAMPLE_COLUMNS)
            .order('vocabulary_id')
            .order('created_at')
            .order('id')
            .range(from, to),
        exampleRowSchema,
      ),

    async getExample(id) {
      const { data, error, status } = await client.from('vocabulary_examples').select(EXAMPLE_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : exampleRowSchema.parse(data);
    },

    async insertExample(vocabularyId, sentence, source) {
      const { data, error, status } = await client
        .from('vocabulary_examples')
        .insert({ vocabulary_id: vocabularyId, sentence, source })
        .select(EXAMPLE_COLUMNS)
        .single();
      if (error?.code === FOREIGN_KEY_VIOLATION) return null;
      if (error) throw toDatabaseError(error, status);
      return exampleRowSchema.parse(data);
    },

    async updateExample(id, changes) {
      const { data, error, status } = await client
        .from('vocabulary_examples')
        .update(changes)
        .eq('id', id)
        .select(EXAMPLE_COLUMNS);
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : exampleRowSchema.parse(row);
    },

    async setPreferredExample(id, preferred) {
      const { data, error, status } = await client.rpc('set_preferred_example', { p_example_id: id, p_preferred: preferred });
      if (error) throw toDatabaseError(error, status);
      return data === true;
    },

    async deleteExample(id) {
      const { data, error, status } = await client.from('vocabulary_examples').delete().eq('id', id).select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },

    listRelations: () =>
      readTable(
        (from, to) =>
          client
            .from('vocabulary_relations')
            .select(RELATION_COLUMNS)
            .order('low_id')
            .order('high_id')
            .order('kind')
            .range(from, to),
        relationRowSchema,
      ),

    async insertRelation(lowId, highId, kind) {
      const created = await client
        .from('vocabulary_relations')
        .insert({ low_id: lowId, high_id: highId, kind })
        .select(RELATION_COLUMNS)
        .single();
      if (created.error?.code === FOREIGN_KEY_VIOLATION) return null;
      if (created.error?.code === UNIQUE_VIOLATION) {
        // Already linked this way: the link that exists is the answer.
        const existing = await client
          .from('vocabulary_relations')
          .select(RELATION_COLUMNS)
          .eq('low_id', lowId)
          .eq('high_id', highId)
          .eq('kind', kind)
          .maybeSingle();
        if (existing.error) throw toDatabaseError(existing.error, existing.status);
        return existing.data === null ? null : relationRowSchema.parse(existing.data);
      }
      if (created.error) throw toDatabaseError(created.error, created.status);
      return relationRowSchema.parse(created.data);
    },

    async deleteRelation(id) {
      const { data, error, status } = await client.from('vocabulary_relations').delete().eq('id', id).select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },

    async recordPractice(args) {
      const { data, error, status } = await client.rpc('record_practice', { p_event: practiceEvent(args) });
      if (error) throw toDatabaseError(error, status);
      const outcome = practiceOutcomeOf(data);
      if (outcome === null) throw new DatabaseError('unavailable', 'The database did not confirm the practice answer.');
      return outcome;
    },

    async listCorrectPracticeModes(vocabularyId) {
      const rows = await readTable(
        (from, to) =>
          client
            .from('review_logs')
            .select('review_mode')
            .eq('vocabulary_id', vocabularyId)
            .eq('kind', 'practice')
            .eq('answer_correct', true)
            .order('id', { ascending: true })
            .range(from, to),
        z.object({ review_mode: z.string() }),
      );
      return rows.map((row) => row.review_mode);
    },

    async practiceDailyStats(from, to) {
      const { data, error, status } = await client.rpc('practice_daily_stats', { p_from: from, p_to: to });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(practiceStatRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned statistics in an unexpected shape.');
      return rows.data;
    },

    async practiceHistory(since) {
      const { data, error, status } = await client.rpc('practice_history', { p_since: since });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(practiceHistoryRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned practice history in an unexpected shape.');
      return rows.data;
    },

    async confidenceStats(since) {
      const { data, error, status } = await client.rpc('confidence_stats', { p_since: since });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(confidenceStatRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned statistics in an unexpected shape.');
      return rows.data;
    },

    async getSettings() {
      const wanted = settingsColumns(schemaVersion);
      const { data, error, status } = await client.from('user_settings').select(wanted).maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : settingsFromRow(data as unknown as SettingsRow, schemaVersion);
    },

    async upsertVocabularyAnalysis(args) {
      const { data, error, status } = await client.rpc('upsert_vocabulary_analysis', {
        p_vocabulary_id: args.vocabularyId,
        p_pronunciation: args.pronunciation ?? null,
        p_part_of_speech: args.partOfSpeech ?? null,
        p_cefr_level: args.cefrLevel ?? null,
        p_confidence: args.confidence ?? null,
        p_english_definition: args.englishDefinition ?? null,
        p_vietnamese_meaning: args.vietnameseMeaning ?? null,
        p_senses: args.senses ?? [],
        p_examples: args.examples ?? [],
        p_word_family: args.wordFamily ?? [],
        p_collocations: args.collocations ?? [],
        p_synonyms: args.synonyms ?? [],
        p_antonyms: args.antonyms ?? [],
        p_usage_notes: args.usageNotes ?? null,
        p_common_mistakes: args.commonMistakes ?? null,
        p_revision_summary: args.revisionSummary ?? null,
        p_model: args.model ?? null,
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(vocabularyAnalysisRowSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the vocabulary analysis.');
      }
      return rows.data[0];
    },

    async getVocabularyAnalysis(vocabularyId) {
      const { data, error, status } = await client.rpc('get_vocabulary_analysis', { p_vocabulary_id: vocabularyId });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(vocabularyAnalysisRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned vocabulary analysis in an unexpected shape.');
      return rows.data[0] ?? null;
    },

    async deleteVocabularyAnalysis(vocabularyId) {
      const { data, error, status } = await client.rpc('delete_vocabulary_analysis', { p_vocabulary_id: vocabularyId });
      if (error) throw toDatabaseError(error, status);
      return data === true;
    },

    // ---- AI Conversations (schema version 10) ----

    async listAiConversations(limit = 50, offset = 0) {
      const { data, error, status } = await client.rpc('list_ai_conversations', {
        p_limit: limit,
        p_offset: offset,
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(aiConversationRowSchema).safeParse(data ?? []);
      if (!rows.success) {
        throw new DatabaseError('unavailable', 'The database returned conversations in an unexpected shape.');
      }
      return rows.data;
    },

    async createAiConversation(mode, title) {
      const { data, error, status } = await client.rpc('create_ai_conversation', {
        p_mode: mode,
        p_title: title ?? 'New conversation',
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(aiConversationRowSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the new conversation.');
      }
      return rows.data[0];
    },

    async getAiConversation(id) {
      const { data, error, status } = await client.rpc('get_ai_conversation', { p_id: id });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(aiConversationRowSchema).safeParse(data ?? []);
      if (!rows.success) {
        throw new DatabaseError('unavailable', 'The database returned a conversation in an unexpected shape.');
      }
      return rows.data[0] ?? null;
    },

    async updateAiConversationTitle(id, title) {
      const { data, error, status } = await client.rpc('update_ai_conversation_title', { p_id: id, p_title: title });
      if (error) throw toDatabaseError(error, status);
      return data === true;
    },

    async deleteAiConversation(id) {
      const { data, error, status } = await client.rpc('delete_ai_conversation', { p_id: id });
      if (error) throw toDatabaseError(error, status);
      return data === true;
    },

    async listAiMessages(conversationId, limit = 200, offset = 0) {
      const { data, error, status } = await client.rpc('list_ai_messages', {
        p_conversation_id: conversationId,
        p_limit: limit,
        p_offset: offset,
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(aiMessageRowSchema).safeParse(data ?? []);
      if (!rows.success) {
        throw new DatabaseError('unavailable', 'The database returned messages in an unexpected shape.');
      }
      return rows.data;
    },

    async insertAiMessage(conversationId, role, content, metadata) {
      const { data, error, status } = await client.rpc('insert_ai_message', {
        p_conversation_id: conversationId,
        p_role: role,
        p_content: content,
        p_metadata: metadata ?? {},
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(aiMessageRowSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the new message.');
      }
      return rows.data[0];
    },

    async markAiMessageSaved(conversationId, messageId, vocabularyId) {
      const { data, error, status } = await client.rpc('mark_ai_message_saved', {
        p_conversation_id: conversationId,
        p_message_id: messageId,
        p_vocabulary_id: vocabularyId,
      });
      if (error) throw toDatabaseError(error, status);
      return data === true;
    },

    async checkAiRateLimit(mode, window, limit) {
      const { data, error, status } = await client.rpc('check_ai_rate_limit', {
        p_mode: mode,
        p_window: window,
        p_limit: limit,
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(rateLimitCheckRowSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not return a rate limit result.');
      }
      return rows.data[0];
    },

    async saveDailyGoal(goal) {
      const { data, error, status } = await client
        .from('user_settings')
        .upsert({ daily_goal_reviews: goal.reviews, daily_goal_minutes: goal.minutes }, { onConflict: 'user_id' })
        .select('daily_goal_reviews, daily_goal_minutes')
        .single();
      if (error) throw toDatabaseError(error, status);
      return { reviews: data.daily_goal_reviews, minutes: data.daily_goal_minutes };
    },

    async saveFsrsRetention(value) {
      const { data, error, status } = await client
        .from('user_settings')
        .upsert({ fsrs_request_retention: value }, { onConflict: 'user_id' })
        .select('fsrs_request_retention')
        .single();
      if (error) throw toDatabaseError(error, status);
      return Number(data.fsrs_request_retention);
    },

    async saveScheduler(value) {
      const { data, error, status } = await client
        .from('user_settings')
        .upsert({ scheduler: value }, { onConflict: 'user_id' })
        .select('scheduler')
        .single();
      if (error) throw toDatabaseError(error, status);
      if (!isSchedulerId(data.scheduler)) {
        throw new DatabaseError('unavailable', 'The database returned a schedule this app does not know.');
      }
      return data.scheduler;
    },

    async saveCountReviewsTowardMastery(value) {
      const { data, error, status } = await client
        .from('user_settings')
        .upsert(
          {
            count_reviews_toward_mastery: value,
          },
          { onConflict: 'user_id' },
        )
        .select('count_reviews_toward_mastery')
        .single();
      if (error) throw toDatabaseError(error, status);
      return data.count_reviews_toward_mastery === true;
    },

    async saveStudyGoals(goal) {
      if (schemaVersion < 15) {
        throw new DatabaseError('schema_missing', 'This database cannot keep study goals yet.');
      }
      const { data, error, status } = await client
        .from('user_settings')
        .upsert(
          {
            study_goal_new_words: goal.newWords,
            study_goal_reviews: goal.reviews,
            study_goal_practice: goal.practice,
            maintenance_mode: goal.maintenanceMode,
          },
          { onConflict: 'user_id' },
        )
        .select('study_goal_new_words, study_goal_reviews, study_goal_practice, maintenance_mode')
        .single();
      if (error) throw toDatabaseError(error, status);
      return {
        newWords: data.study_goal_new_words ?? 10,
        reviews: data.study_goal_reviews ?? 30,
        practice: data.study_goal_practice ?? 20,
        maintenanceMode: data.maintenance_mode === true,
      };
    },

    async saveMaxReviewsPerDay(value) {
      if (schemaVersion < 15) {
        throw new DatabaseError('schema_missing', 'This database cannot keep a review limit yet.');
      }
      const { data, error, status } = await client
        .from('user_settings')
        .upsert({ max_reviews_per_day: value }, { onConflict: 'user_id' })
        .select('max_reviews_per_day')
        .single();
      if (error) throw toDatabaseError(error, status);
      return data.max_reviews_per_day ?? null;
    },

    async saveUiLanguage(value) {
      if (schemaVersion < 15) {
        throw new DatabaseError('schema_missing', 'This database cannot keep an interface language yet.');
      }
      const { data, error, status } = await client
        .from('user_settings')
        .upsert({ ui_language: value }, { onConflict: 'user_id' })
        .select('ui_language')
        .single();
      if (error) throw toDatabaseError(error, status);
      return data.ui_language === 'en' || data.ui_language === 'vi' ? data.ui_language : null;
    },

    async recordFsrsReview(args) {
      if (schemaVersion < 15) throw new DatabaseError('schema_missing', 'This database cannot save answers under FSRS alone yet.');
      const { data, error, status } = await client.rpc('record_fsrs_review', {
        p_event: {
          vocabulary_id: args.id,
          request_id: args.requestId,
          session_id: args.sessionId,
          action: args.action,
          expected_revision: args.expectedRevision,
          counts_toward_schedule: args.countsTowardSchedule,
          reviewed_on: args.reviewedOn,
          duration_ms: args.durationMs,
          ...(args.reviewedAt === null ? {} : { reviewed_at: args.reviewedAt }),
          ...(args.rating === null ? {} : { rating: args.rating }),
          ...(args.version === null ? {} : { version: args.version }),
          ...(args.after === null ? {} : { after: args.after }),
          ...(args.confidence === null ? {} : { confidence: args.confidence }),
        },
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(fsrsReviewRowSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the review.');
      }
      return rows.data[0];
    },

    async studyDayCounts(day) {
      if (schemaVersion < 15) throw new DatabaseError('schema_missing', 'This database cannot count daily goals yet.');
      const { data, error, status } = await client.rpc('study_day_counts', { p_day: day });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(studyDayCountsRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned goal counts in an unexpected shape.');
      return rows.data[0] ?? { new_words: 0, reviews: 0, practice: 0 };
    },

    async recordStudyDay(row) {
      if (schemaVersion < 15) throw new DatabaseError('schema_missing', 'This database cannot keep daily goals yet.');
      const { data, error, status } = await client.rpc('record_study_day', {
        p_day: row.day,
        p_new_words: row.newWords,
        p_reviews: row.reviews,
        p_practice: row.practice ?? 0,
        p_new_goal: row.newGoal,
        p_review_goal: row.reviewGoal,
        p_practice_goal: row.practiceGoal ?? 0,
        p_met: row.met,
      });
      if (error) throw toDatabaseError(error, status);
      return data === true;
    },

    async listMetStudyDays() {
      if (schemaVersion < 15) return [];
      const { data, error, status } = await client.from('study_days').select('day').eq('met', true).order('day');
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(z.object({ day: z.string().refine(isIsoDate) })).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned days in an unexpected shape.');
      return rows.data.map((row) => row.day);
    },

    async gameSnapshot(today, weekStart) {
      if (schemaVersion < 17) throw new DatabaseError('schema_missing', 'This database cannot keep the game yet.');
      const parse = <T>(schema: z.ZodType<T>, data: unknown, what: string): T[] => {
        const rows = z.array(schema).safeParse(data ?? []);
        if (!rows.success) throw new DatabaseError('unavailable', `The database returned ${what} in an unexpected shape.`);
        return rows.data;
      };
      const [state, quests, badges, freezes, rewards, inventory] = await Promise.all([
        client.from('game_state').select(schemaVersion >= 19 ? 'version, total_xp, state, stardust' : 'version, total_xp, state').maybeSingle(),
        client
          .from('game_quests')
          .select('period, period_start, slot, kind, target, reward, progress, completed_at')
          .or(`and(period.eq.day,period_start.eq.${today}),and(period.eq.week,period_start.eq.${weekStart})`)
          .order('period')
          .order('slot'),
        client.from('game_badges').select('badge, tier, earned_at').order('earned_at'),
        client.from('game_freezes').select('id, granted_on, used_on').order('granted_on'),
        client.from('game_rewards').select('id, kind, payload, created_at').is('claimed_at', null).order('created_at').limit(200),
        schemaVersion >= 19 ? client.from('inventory').select('item_id').order('acquired_at') : Promise.resolve({ data: [], error: null, status: 200 }),
      ]);
      for (const result of [state, quests, badges, freezes, rewards, inventory]) {
        if (result.error) throw toDatabaseError(result.error, result.status);
      }
      const stateRow = state.data === null ? null : gameStateRowSchema.safeParse(state.data);
      if (stateRow !== null && !stateRow.success) throw new DatabaseError('unavailable', 'The database returned the game state in an unexpected shape.');
      return {
        state: stateRow === null ? null : stateRow.data,
        quests: parse(gameQuestRowSchema, quests.data, 'quests'),
        badges: parse(gameBadgeRowSchema, badges.data, 'badges'),
        freezes: parse(gameFreezeRowSchema, freezes.data, 'streak freezes'),
        rewards: parse(gameRewardRowSchema, rewards.data, 'rewards'),
        inventory: parse(z.object({ item_id: z.string() }), inventory.data, 'items').map((row) => row.item_id),
      };
    },

    async notificationSettings() {
      if (schemaVersion < 20) throw new DatabaseError('schema_missing', 'Reminders need the latest database update (version 20).');
      const { data, error, status } = await client
        .from('notification_settings')
        .select('streak, league, reminder, social, reminder_at, quiet_from, quiet_until')
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : notificationSettingsFromRow(data);
    },

    async saveNotificationSettings(settings) {
      if (schemaVersion < 20) throw new DatabaseError('schema_missing', 'Reminders need the latest database update (version 20).');
      const { error, status } = await client.from('notification_settings').upsert(notificationSettingsToRow(settings), { onConflict: 'user_id' });
      if (error) throw toDatabaseError(error, status);
    },

    async pushDevices() {
      if (schemaVersion < 20) throw new DatabaseError('schema_missing', 'Reminders need the latest database update (version 20).');
      const { data, error, status } = await client.from('push_subscriptions').select('endpoint, p256dh, auth').order('created_at');
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(z.object({ endpoint: z.string(), p256dh: z.string(), auth: z.string() })).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned devices in an unexpected shape.');
      return rows.data;
    },

    async addPushDevice(device) {
      if (schemaVersion < 20) throw new DatabaseError('schema_missing', 'Reminders need the latest database update (version 20).');
      // A device another account had is taken over by this one: the browser now belongs to whoever subscribed last.
      const { error, status } = await client.rpc('push_take_device', { p_endpoint: device.endpoint, p_p256dh: device.p256dh, p_auth: device.auth });
      if (error) throw toDatabaseError(error, status);
    },

    async removePushDevice(endpoint) {
      if (schemaVersion < 20) throw new DatabaseError('schema_missing', 'Reminders need the latest database update (version 20).');
      const { error, status } = await client.from('push_subscriptions').delete().eq('endpoint', endpoint);
      if (error) throw toDatabaseError(error, status);
    },

    async gameEvents() {
      if (schemaVersion < 19) throw new DatabaseError('schema_missing', 'Events need the latest database update (version 19).');
      const { data, error, status } = await client.from('game_events').select('event, enabled');
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(gameEventRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned events in an unexpected shape.');
      return rows.data;
    },

    async gamePendingAnswers(limit) {
      if (schemaVersion < 17) throw new DatabaseError('schema_missing', 'This database cannot keep the game yet.');
      const { data, error, status } = await client.rpc('game_pending_answers', { p_limit: limit });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(gameAnswerRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned answers in an unexpected shape.');
      return rows.data;
    },

    async gameLedger(answerIds) {
      if (schemaVersion < 17) throw new DatabaseError('schema_missing', 'This database cannot keep the game yet.');
      if (answerIds.length === 0) return [];
      const { data, error, status } = await client
        .from('xp_ledger')
        .select('source_id, amount, reason, earned_on')
        .eq('source', 'answer')
        .in('source_id', [...answerIds]);
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(gameLedgerRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned XP in an unexpected shape.');
      return rows.data;
    },

    async gameBadgeMetrics() {
      if (schemaVersion < 17) throw new DatabaseError('schema_missing', 'This database cannot keep the game yet.');
      const { data, error, status } = await client.rpc('game_badge_metrics');
      if (error) throw toDatabaseError(error, status);
      const row = z.array(gameMetricsRowSchema).safeParse(data ?? []);
      if (!row.success || row.data[0] === undefined) throw new DatabaseError('unavailable', 'The database returned totals in an unexpected shape.');
      return row.data[0];
    },

    async gameCommit(payload, signature) {
      if (schemaVersion < 17) throw new DatabaseError('schema_missing', 'This database cannot keep the game yet.');
      const { data, error, status } = await client.rpc('game_commit', { p_payload: payload, p_signature: signature });
      if (error) throw toDatabaseError(error, status);
      const row = z.array(gameCommitRowSchema).safeParse(data ?? []);
      if (!row.success || row.data[0] === undefined) throw new DatabaseError('unavailable', 'The database answered the game change in an unexpected shape.');
      return row.data[0];
    },

    async competitionCall(fn, args) {
      if (schemaVersion < 18) throw new DatabaseError('schema_missing', 'Leagues and friends need the latest database update (version 18).');
      if (!COMPETITION_FUNCTIONS.includes(fn)) throw new DatabaseError('invalid', 'That is not one of the competition functions.');
      const { data, error, status } = await client.rpc(fn, args);
      if (error) throw toDatabaseError(error, status);
      if (!Array.isArray(data)) throw new DatabaseError('unavailable', 'The database answered in an unexpected shape.');
      return data;
    },

    async undoFsrsReview(args) {
      if (schemaVersion < 15) throw new DatabaseError('schema_missing', 'This database cannot take answers back under FSRS alone yet.');
      const { data, error, status } = await client.rpc('undo_fsrs_review', {
        p_review_request_id: args.reviewRequestId,
        p_request_id: args.requestId,
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(fsrsUndoRowSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the undo.');
      }
      return rows.data[0];
    },

    async undoReview(args) {
      const { data, error, status } = await client.rpc('undo_review', {
        p_review_request_id: args.reviewRequestId,
        p_request_id: args.requestId,
      });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(undoResultSchema).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the undo.');
      }
      return rows.data[0];
    },

    async sessionSummary(sessionId) {
      const { data, error, status } = await client.rpc('session_summary', { p_session_id: sessionId });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(sessionSummaryRowSchema).safeParse(data);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned a summary in an unexpected shape.');
      return rows.data[0] ?? null;
    },

    async getTimeZone() {
      const { data, error, status } = await client.from('user_settings').select('time_zone').maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data?.time_zone ?? null;
    },

    async ensureTimeZone(timeZone) {
      // ignoreDuplicates: a row that already exists, perhaps written by another device a moment ago, wins.
      const { error, status } = await client
        .from('user_settings')
        .upsert({ time_zone: timeZone }, { onConflict: 'user_id', ignoreDuplicates: true });
      if (error) throw toDatabaseError(error, status);
      return (await this.getTimeZone()) ?? timeZone;
    },

    async saveTimeZone(timeZone) {
      const { data, error, status } = await client
        .from('user_settings')
        .upsert({ time_zone: timeZone }, { onConflict: 'user_id' })
        .select('time_zone')
        .single();
      if (error) throw toDatabaseError(error, status);
      return data.time_zone;
    },
  };
}


