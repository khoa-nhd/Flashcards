/**
 * The only file that talks to Supabase. It exposes a narrow interface so the
 * rest of the server (and the tests) never depend on the SDK.
 *
 * Every call runs as the signed-in user: the client is created from the public
 * key plus that user's access token, so Row Level Security decides what each
 * request can see and change. No privileged key exists anywhere in this app.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isIsoDate, type IsoDate } from '../../shared/dates.js';
import { DEFAULT_SCHEDULER, isSchedulerId, type SchedulerId } from '../../shared/scheduler/active.js';
import { fsrsStateSchema, type FsrsState } from '../../shared/scheduler/fsrs.js';
import type { DailyGoal } from '../../shared/session-planner.js';
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
});

export type CardRow = z.infer<typeof cardRowSchema>;

export const CARD_COLUMNS =
  'id, word, word_key, meaning, definition, example, date_added, created_at, updated_at, deleted_at, mastery, review_date';

const FSRS_COLUMNS =
  'fsrs_due, fsrs_stability, fsrs_difficulty, fsrs_last_review, fsrs_reps, fsrs_lapses, fsrs_state, fsrs_scheduled_days, fsrs_learning_steps, fsrs_version';

/** The columns a card is read with, which depends on what the database has. */
export const cardColumns = (schemaVersion: number): string =>
  schemaVersion >= 3 ? `${CARD_COLUMNS}, ${FSRS_COLUMNS}` : CARD_COLUMNS;

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

export interface NewCard {
  word: string;
  wordKey: string;
  mastery: number;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  dateAdded: IsoDate | null;
  reviewDate: IsoDate | null;
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
export const LATEST_SCHEMA_VERSION = 10;

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
  /** From schema version 10: the Writing Challenge's coach note. */
  ai_feedback: z.string().nullable().optional(),
  /** From schema version 10: one model sentence from the coach. */
  model_answer: z.string().nullable().optional(),
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
    ...(schemaVersion >= 10 ? ['ai_feedback, model_answer'] : []),
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
  /** The Writing Challenge's coach note, from schema version 10. */
  aiFeedback?: string | null;
  /** One model sentence from the coach, from schema version 10. */
  modelAnswer?: string | null;
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
  /** From schema version 9; absent where the store is behind. */
  last_confidence: z.number().int().nullable().optional(),
});

export type CardStatRow = z.infer<typeof cardStatRowSchema>;

/** The card-stat columns a database at this version has. */
export const cardStatColumns = (schemaVersion: number): string =>
  [
    'vocabulary_id, reviews, failures, recent_reviews, recent_failures',
    'failed_days, last_reviewed_on, last_failed_on, last_action',
    ...(schemaVersion >= 9 ? ['last_confidence'] : []),
  ].join(', ');

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
  /** Answers since `since` that carried a confidence rating, by rating. Needs schema version 5. */
  confidenceStats(since: IsoDate): Promise<ConfidenceStatRow[]>;
  /** The account's settings in one read, or `null` if it has none yet. */
  getSettings(): Promise<StoredSettings | null>;
  /** Needs schema version 5. */
  saveDailyGoal(goal: DailyGoal): Promise<DailyGoal>;
  /** Needs schema version 3. */
  saveFsrsRetention(value: number): Promise<number>;
  /** Needs schema version 8. */
  saveScheduler(value: SchedulerId): Promise<SchedulerId>;
  getTimeZone(): Promise<string | null>;
  /** Stores the zone only if the user has none yet; returns the one in effect. */
  ensureTimeZone(timeZone: string): Promise<string>;
  saveTimeZone(timeZone: string): Promise<string>;
}

/** A settings row as read; which columns it has depends on the schema version. */
export interface SettingsRow {
  time_zone: string;
  fsrs_request_retention?: number | string | null;
  daily_goal_reviews?: number | null;
  daily_goal_minutes?: number | null;
  /** From schema version 8. */
  scheduler?: string | null;
}

/** The settings columns a database at this version has. */
export const settingsColumns = (schemaVersion: number): string =>
  [
    'time_zone',
    ...(schemaVersion >= 3 ? ['fsrs_request_retention'] : []),
    ...(schemaVersion >= 5 ? ['daily_goal_reviews', 'daily_goal_minutes'] : []),
    ...(schemaVersion >= 8 ? ['scheduler'] : []),
  ].join(', ');

export function settingsFromRow(row: SettingsRow, schemaVersion: number): StoredSettings {
  const retention = row.fsrs_request_retention == null ? null : Number(row.fsrs_request_retention);
  return {
    timeZone: row.time_zone,
    fsrsRetention: retention !== null && Number.isFinite(retention) ? retention : null,
    dailyGoal:
      schemaVersion >= 5 ? { reviews: row.daily_goal_reviews ?? null, minutes: row.daily_goal_minutes ?? null } : null,
    // Anything unrecognised is read as the default: the mastery schedule is never left by accident.
    scheduler: schemaVersion >= 8 ? (isSchedulerId(row.scheduler) ? row.scheduler : DEFAULT_SCHEDULER) : null,
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
    // A coach's note, where one was asked for. An older `record_practice` simply
    // does not read these keys, and a database without the columns never gets them.
    ai_feedback: args.aiFeedback ?? null,
    model_answer: args.modelAnswer ?? null,
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
      return row.data[0];
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
      // The column list keeps an older database from being asked for a column it does not have.
      const { data, error, status } = await client
        .rpc('card_review_stats', { p_since: since })
        .select(cardStatColumns(schemaVersion));
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(cardStatRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned statistics in an unexpected shape.');
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
      const rows = z.array(z.object({ outcome: practiceOutcomeSchema })).safeParse(data);
      if (!rows.success || rows.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the practice answer.');
      }
      return rows.data[0].outcome;
    },

    async practiceDailyStats(from, to) {
      const { data, error, status } = await client.rpc('practice_daily_stats', { p_from: from, p_to: to });
      if (error) throw toDatabaseError(error, status);
      const rows = z.array(practiceStatRowSchema).safeParse(data ?? []);
      if (!rows.success) throw new DatabaseError('unavailable', 'The database returned statistics in an unexpected shape.');
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
