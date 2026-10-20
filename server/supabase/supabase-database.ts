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
import { senseSchema } from '../../shared/api.js';
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
  // From schema version 11: the word this one was formed from.
  root_id: z.string().nullable().optional(),
  // From schema version 13: every sense of the word, archived ones included,
  // and the version bumped on each sense change.
  senses: z.array(senseSchema).optional(),
  senses_version: z.number().int().optional(),
});

export type CardRow = z.infer<typeof cardRowSchema>;

export const CARD_COLUMNS =
  'id, word, word_key, meaning, definition, example, date_added, created_at, updated_at, deleted_at, mastery, review_date';

const FSRS_COLUMNS =
  'fsrs_due, fsrs_stability, fsrs_difficulty, fsrs_last_review, fsrs_reps, fsrs_lapses, fsrs_state, fsrs_scheduled_days, fsrs_learning_steps, fsrs_version';

/** The columns a card is read with, which depends on what the database has. */
export const cardColumns = (schemaVersion: number): string =>
  `${CARD_COLUMNS}${schemaVersion >= 3 ? `, ${FSRS_COLUMNS}` : ''}${schemaVersion >= 11 ? ', root_id' : ''}${schemaVersion >= 13 ? ', senses, senses_version' : ''}`;

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
  /**
   * The word's senses, to be written in the same transaction as the word
   * itself where the database can (schema version 14). Positions run from
   * zero in the order given. A store that cannot honours them afterwards.
   */
  senses?: ReadonlyArray<{ meaning: string | null; definition: string | null; example: string | null; requestId: string }>;
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
export const LATEST_SCHEMA_VERSION = 19;

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

/**
 * The codes the sense functions raise themselves: no such row for this user,
 * and a version that has moved on. Both are refused before anything is
 * written; the stores turn them into the same answers the old checks gave.
 */
export const NOT_FOUND_IN_DB = 'P0002';
export const STALE_VERSION_IN_DB = 'P0003';

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
  root_id: string | null;
  expectSensesVersion: number;
}>;

/** A sense row as read from the database. */
export const senseRowSchema = z.object({
  id: z.string(),
  vocabulary_id: z.string(),
  position: z.number().int(),
  meaning: z.string().nullable(),
  definition: z.string().nullable(),
  example: z.string().nullable(),
  archived_at: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SenseRow = z.infer<typeof senseRowSchema>;

export const senseColumns = 'id, vocabulary_id, position, meaning, definition, example, archived_at, version, created_at, updated_at';

// ---- Vocabulary map rows (schema version 18) ----

export const vocabMapRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  description: z.string(),
  revision: z.number().int(),
  request_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type VocabMapRow = z.infer<typeof vocabMapRowSchema>;

export const vocabMapNodeRowSchema = z.object({
  id: z.string(),
  map_id: z.string(),
  kind: z.string(),
  vocabulary_id: z.string().nullable(),
  sense_id: z.string().nullable(),
  label: z.string().nullable(),
  note: z.string(),
  group_key: z.string().nullable(),
  step: z.number().int().nullable(),
  x: z.number().int().nullable(),
  y: z.number().int().nullable(),
  request_id: z.string().nullable(),
  created_at: z.string(),
});
export type VocabMapNodeRow = z.infer<typeof vocabMapNodeRowSchema>;

export const vocabMapEdgeRowSchema = z.object({
  id: z.string(),
  map_id: z.string(),
  from_node_id: z.string(),
  to_node_id: z.string(),
  kind: z.string(),
  pattern: z.string(),
  note: z.string(),
  created_at: z.string(),
});
export type VocabMapEdgeRow = z.infer<typeof vocabMapEdgeRowSchema>;

export const MAP_COLUMNS = 'id, type, title, description, revision, request_id, created_at, updated_at';
export const MAP_NODE_COLUMNS =
  'id, map_id, kind, vocabulary_id, sense_id, label, note, group_key, step, x, y, request_id, created_at';
export const MAP_EDGE_COLUMNS = 'id, map_id, from_node_id, to_node_id, kind, pattern, note, created_at';

// ---- Discovery rows (schema version 19) ----

export const discoverySourceRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  origin: z.string(),
  content: z.string(),
  content_kind: z.string(),
  /** jsonb: whatever was written. The adapter keeps only the two keys a position has. */
  position: z.record(z.string(), z.unknown()),
  revision: z.number().int(),
  request_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DiscoverySourceRow = z.infer<typeof discoverySourceRowSchema>;

export const discoveryMarkRowSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  label: z.string(),
  context: z.string(),
  char_offset: z.number().int().nullable(),
  cue_start: z.number().int().nullable(),
  cue_end: z.number().int().nullable(),
  note: z.string(),
  vocabulary_id: z.string().nullable(),
  saved_at: z.string().nullable(),
  request_id: z.string().nullable(),
  created_at: z.string(),
});
export type DiscoveryMarkRow = z.infer<typeof discoveryMarkRowSchema>;

export const DISCOVERY_SOURCE_COLUMNS =
  'id, kind, title, origin, content, content_kind, position, revision, request_id, created_at, updated_at';
export const DISCOVERY_MARK_COLUMNS =
  'id, source_id, label, context, char_offset, cue_start, cue_end, note, vocabulary_id, saved_at, request_id, created_at';

/**
 * How an import finishes the senses of a row. `resume` marks the call as the
 * import's completion step — the one write path allowed to add a sense on a
 * word in the trash, through resume_vocabulary_sense (schema version 15) —
 * and `archived` carries the archive state the file named for the row. On a
 * schema-14 database the call falls back to the version 14 pair of
 * statements, which behaved the same way.
 */
export interface SenseWriteOptions {
  resume?: boolean;
  archived?: boolean;
}

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
  // ---- Senses (schema version 13; add, reorder and restore are one
  // database-atomic call from schema version 14) ----
  /** List every sense of a vocabulary entry, archived ones included, ordered by position. */
  listSenses(vocabularyId: string): Promise<SenseRow[]>;
  /** Get a single sense by ID. */
  getSense(id: string): Promise<SenseRow | null>;
  /**
   * Add a new sense. Returns the created sense. Needs schema version 14.
   * The import's completion step passes `SenseWriteOptions`; on schema
   * version 15 that is the resume_vocabulary_sense call, which may land a
   * sense on a word in the trash and set the file's archive flag with it.
   */
  createSense(
    vocabularyId: string,
    sense: { meaning: string | null; definition: string | null; example: string | null; requestId: string },
    options?: SenseWriteOptions,
  ): Promise<{ sense: SenseRow; created: boolean }>;
  /** Update an existing sense. Needs schema version 13. */
  updateSense(id: string, patch: { meaning?: string | null; definition?: string | null; example?: string | null; expectedVersion: number }): Promise<SenseRow | 'stale' | 'not_found'>;
  /** Reorder senses: all of them move, or none does. Needs schema version 14. */
  reorderSenses(vocabularyId: string, senseIds: string[], expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'>;
  /** Archive (soft-delete) a sense. Needs schema version 13. */
  archiveSense(id: string, expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'>;
  /** Restore an archived sense at the end of the order. Needs schema version 14. */
  restoreSense(id: string, expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'>;
  // ---- Vocabulary maps (schema version 18). None of these touch a word,
  // its schedule or its review history; a map's nodes reference vocabulary
  // by id and are removed with it, never the other way round. ----
  /** The caller's maps, most recently touched first. */
  listVocabMaps(): Promise<VocabMapRow[]>;
  getVocabMap(id: string): Promise<VocabMapRow | null>;
  findVocabMapByRequestId(requestId: string): Promise<VocabMapRow | null>;
  /** `duplicate`: the account already created a map with this request id. */
  insertVocabMap(input: { type: string; title: string; description: string; requestId: string | null }): Promise<VocabMapRow | 'duplicate'>;
  /** `null`: no such map of the caller's. */
  updateVocabMap(id: string, patch: { title?: string; description?: string }): Promise<VocabMapRow | null>;
  /** The revision moves on by one, in one statement; the row as it now stands. */
  bumpVocabMap(id: string): Promise<VocabMapRow | null>;
  /** Removes the map, its nodes and its edges. Never a word. */
  deleteVocabMap(id: string): Promise<boolean>;
  listVocabMapNodes(mapId: string): Promise<VocabMapNodeRow[]>;
  /**
   * `duplicate`: the map already holds a node with this request id, this
   * candidate label, or this word at this sense — the unique indexes refuse
   * a second copy however many times it is offered.
   */
  insertVocabMapNode(node: {
    mapId: string;
    kind: string;
    vocabularyId: string | null;
    senseId: string | null;
    label: string | null;
    note: string;
    group: string | null;
    step: number | null;
    x: number | null;
    y: number | null;
    requestId: string | null;
  }): Promise<VocabMapNodeRow | 'duplicate'>;
  findVocabMapNodeByRequestId(mapId: string, requestId: string): Promise<VocabMapNodeRow | null>;
  findVocabMapNodeByLabel(mapId: string, label: string): Promise<VocabMapNodeRow | null>;
  /** `null`: no such node on the caller's map. */
  patchVocabMapNode(
    mapId: string,
    id: string,
    patch: { label?: string; note?: string; group?: string | null; step?: number | null; x?: number | null; y?: number | null },
  ): Promise<VocabMapNodeRow | null>;
  /** Turns a candidate into a saved node pointing at a real word of the caller's. */
  promoteVocabMapNode(mapId: string, id: string, vocabularyId: string): Promise<VocabMapNodeRow | null>;
  deleteVocabMapNode(mapId: string, id: string): Promise<boolean>;
  listVocabMapEdges(mapId: string): Promise<VocabMapEdgeRow[]>;
  /** `duplicate`: the same link, in the same direction, of the same kind is already there. */
  insertVocabMapEdge(edge: {
    mapId: string;
    fromNodeId: string;
    toNodeId: string;
    kind: string;
    pattern: string;
    note: string;
  }): Promise<VocabMapEdgeRow | 'duplicate'>;
  patchVocabMapEdge(mapId: string, id: string, patch: { pattern?: string; note?: string }): Promise<VocabMapEdgeRow | null>;
  deleteVocabMapEdge(mapId: string, id: string): Promise<boolean>;
  /** How many senses the account holds, for the personal map's overview. */
  countSenses(): Promise<number>;

  // ---- Discovery (schema version 19) ----

  listDiscoverySources(): Promise<DiscoverySourceRow[]>;
  getDiscoverySource(id: string): Promise<DiscoverySourceRow | null>;
  findDiscoverySourceByRequestId(requestId: string): Promise<DiscoverySourceRow | null>;
  /** `duplicate`: this account already created a source with this request id. */
  insertDiscoverySource(input: {
    kind: string;
    title: string;
    origin: string;
    content: string;
    contentKind: string;
    position: { offset?: number; seconds?: number };
    requestId: string | null;
  }): Promise<DiscoverySourceRow | 'duplicate'>;
  updateDiscoverySource(id: string, patch: { title?: string }): Promise<DiscoverySourceRow | null>;
  /** A restorable position: written as jsonb, the revision untouched. */
  updateDiscoveryPosition(id: string, position: { offset?: number; seconds?: number }): Promise<DiscoverySourceRow | null>;
  /** One call, one transaction: the revision cannot be lost between two clients. */
  bumpDiscoverySource(id: string): Promise<DiscoverySourceRow | null>;
  deleteDiscoverySource(id: string): Promise<boolean>;

  listDiscoveryMarks(sourceId?: string): Promise<DiscoveryMarkRow[]>;
  getDiscoveryMark(id: string): Promise<DiscoveryMarkRow | null>;
  /** `duplicate`: the same request id, or the same still-marked label in this source, already exists. */
  insertDiscoveryMark(input: {
    sourceId: string;
    label: string;
    context: string;
    offset: number | null;
    cueStart: number | null;
    cueEnd: number | null;
    note: string;
    vocabularyId: string | null;
    savedAt: string | null;
    requestId: string | null;
  }): Promise<DiscoveryMarkRow | 'duplicate'>;
  findDiscoveryMarkByRequestId(requestId: string): Promise<DiscoveryMarkRow | null>;
  findDiscoveryMarkByLabel(sourceId: string, label: string): Promise<DiscoveryMarkRow | null>;
  findDiscoveryMarkByVocabulary(vocabularyId: string): Promise<DiscoveryMarkRow | null>;
  patchDiscoveryMark(id: string, patch: { note?: string; vocabularyId?: string; savedAt: string }): Promise<DiscoveryMarkRow | null>;
  deleteDiscoveryMark(id: string): Promise<boolean>;
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

export type DatabaseFailure = 'unauthorized' | 'forbidden' | 'schema_missing' | 'invalid' | 'conflict' | 'unavailable';

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
  // The caller said which senses version it expected, and they have moved on.
  if (code === 'P0003') {
    return new DatabaseError('conflict', 'This word changed while you were editing it. Reload and try again.', logged);
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
      // A row that carries its senses writes them with the word, in one
      // transaction: no failure between them can leave a word without them.
      const withSenses = card.senses !== undefined && card.senses.length > 0;
      if (withSenses && schemaVersion < 14) {
        throw new DatabaseError('schema_missing', 'Senses on creation need schema version 14. Apply the newest migration.');
      }
      const { data, error, status } = await (withSenses
        ? client.rpc('create_vocabulary_with_senses', {
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
            p_senses: (card.senses ?? []).map((sense) => ({
              meaning: sense.meaning,
              definition: sense.definition,
              example: sense.example,
              request_id: sense.requestId,
            })),
          })
        : client.rpc('create_vocabulary', {
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
          }));
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

    // ---- Senses (schema version 13) ----
    async listSenses(vocabularyId) {
      if (schemaVersion < 13) return [];
      // Every sense, archived ones included: a restored sense has to be findable.
      const { data, error, status } = await client
        .from('vocabulary_senses')
        .select(senseColumns)
        .eq('vocabulary_id', vocabularyId)
        .order('position');
      if (error) throw toDatabaseError(error, status);
      return z.array(senseRowSchema).safeParse(data ?? []).data ?? [];
    },

    async getSense(id) {
      if (schemaVersion < 13) return null;
      const { data, error, status } = await client
        .from('vocabulary_senses')
        .select(senseColumns)
        .eq('id', id)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : senseRowSchema.parse(data);
    },

    async createSense(vocabularyId, sense, options) {
      if (schemaVersion < 14) {
        throw new DatabaseError('schema_missing', 'Adding a sense needs schema version 14. Apply the newest migration.');
      }
      if (options?.resume === true && schemaVersion >= 15) {
        // The import's completion call: one statement that claims the word
        // whatever state it is in — a run being finished after the word was
        // moved to the trash is the case the ordinary add refuses — adds the
        // sense the request id has not landed yet, and sets the archive flag
        // the file carries in the same breath. Content already stored is
        // never rewritten.
        const { data, error, status } = await client.rpc('resume_vocabulary_sense', {
          p_vocabulary_id: vocabularyId,
          p_meaning: sense.meaning,
          p_definition: sense.definition,
          p_example: sense.example,
          p_request_id: sense.requestId,
          p_archived: options.archived === true,
        });
        if (error) {
          if (error.code === NOT_FOUND_IN_DB) {
            throw new DatabaseError('invalid', 'That word is not in this vocabulary.', error.code);
          }
          throw toDatabaseError(error, status);
        }
        const row = z.array(z.object({ id: z.string(), created: z.boolean() })).safeParse(data);
        if (!row.success || row.data[0] === undefined) {
          throw new DatabaseError('unavailable', 'The database did not confirm the new sense.');
        }
        const written = await client.from('vocabulary_senses').select(senseColumns).eq('id', row.data[0].id).single();
        if (written.error) throw toDatabaseError(written.error, written.status);
        return { sense: senseRowSchema.parse(written.data), created: row.data[0].created };
      }
      // One call: the word is claimed, the position is chosen and the sense is
      // written while the claim is held, so two adds — or an add and a
      // reorder — cannot take one position or write around each other. A
      // retry of the same action carries the same request id and lands on the
      // same sense. From schema version 15 the word must be live; an import
      // finishing over a trashed word goes through the resume call above.
      const { data, error, status } = await client.rpc('add_vocabulary_sense', {
        p_vocabulary_id: vocabularyId,
        p_meaning: sense.meaning,
        p_definition: sense.definition,
        p_example: sense.example,
        p_request_id: sense.requestId,
      });
      if (error) {
        if (error.code === NOT_FOUND_IN_DB) {
          throw new DatabaseError('invalid', 'That word is not in this vocabulary.', error.code);
        }
        throw toDatabaseError(error, status);
      }
      const row = z.array(z.object({ id: z.string(), created: z.boolean() })).safeParse(data);
      if (!row.success || row.data[0] === undefined) {
        throw new DatabaseError('unavailable', 'The database did not confirm the new sense.');
      }
      const written = await client.from('vocabulary_senses').select(senseColumns).eq('id', row.data[0].id).single();
      if (written.error) throw toDatabaseError(written.error, written.status);
      const stored = senseRowSchema.parse(written.data);
      if (options?.resume === true && options.archived === true && stored.archived_at === null) {
        // Schema 14's pair of statements: the flag lands as its own update,
        // which the version guards against a second writer.
        const flagged = await client
          .from('vocabulary_senses')
          .update({ archived_at: new Date().toISOString(), version: stored.version + 1 })
          .eq('id', stored.id)
          .eq('version', stored.version)
          .is('archived_at', null)
          .select('id')
          .maybeSingle();
        if (flagged.error) throw toDatabaseError(flagged.error, flagged.status);
        if (flagged.data === null) {
          const recheck = await this.getSense(stored.id);
          if (recheck === null || recheck.archived_at === null) {
            throw new DatabaseError('conflict', 'The archive flag for this imported sense could not be applied.');
          }
        }
      }
      return { sense: stored, created: row.data[0].created };
    },

    async updateSense(id, patch) {
      if (schemaVersion < 13) {
        throw new DatabaseError('schema_missing', 'Senses need schema version 13. Apply the newest migration.');
      }
      if (schemaVersion >= 15) {
        // One call, one transaction: the word is claimed and must be live,
        // and the version sits in the same statement that writes the change,
        // so a second change in between matches no row and nothing is
        // overwritten. A trashed word's senses are refused here, not only in
        // the service.
        const { error, status } = await client.rpc('update_vocabulary_sense', {
          p_sense_id: id,
          p_expected_version: patch.expectedVersion,
          p_changes: {
            ...(patch.meaning !== undefined ? { meaning: patch.meaning } : {}),
            ...(patch.definition !== undefined ? { definition: patch.definition } : {}),
            ...(patch.example !== undefined ? { example: patch.example } : {}),
          },
        });
        if (error) {
          if (error.code === NOT_FOUND_IN_DB) return 'not_found';
          if (error.code === STALE_VERSION_IN_DB) return 'stale';
          throw toDatabaseError(error, status);
        }
        const written = await this.getSense(id);
        if (written === null) throw new DatabaseError('unavailable', 'The updated sense could not be read back.');
        return written;
      }
      // One statement with the version in its condition: a second change in
      // between matches no row, and nothing is overwritten.
      const { data, error, status } = await client
        .from('vocabulary_senses')
        .update({
          ...(patch.meaning !== undefined ? { meaning: patch.meaning } : {}),
          ...(patch.definition !== undefined ? { definition: patch.definition } : {}),
          ...(patch.example !== undefined ? { example: patch.example } : {}),
          version: patch.expectedVersion + 1,
        })
        .eq('id', id)
        .eq('version', patch.expectedVersion)
        .is('archived_at', null)
        .select(senseColumns)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      if (data !== null) return senseRowSchema.parse(data);
      const current = await this.getSense(id);
      return current === null ? 'not_found' : 'stale';
    },

    async reorderSenses(vocabularyId, senseIds, expectedVersion) {
      if (schemaVersion < 14) {
        throw new DatabaseError('schema_missing', 'Reordering senses needs schema version 14. Apply the newest migration.');
      }
      // One call, one transaction: the word is claimed, the version checked,
      // the order checked against the senses stored (so an add or restore
      // that landed in between is refused, not routed around), and only then
      // are the rows moved. Everything succeeds or nothing does.
      const { error, status } = await client.rpc('reorder_vocabulary_senses', {
        p_vocabulary_id: vocabularyId,
        p_sense_ids: senseIds,
        p_expected_version: expectedVersion,
      });
      if (error) {
        if (error.code === NOT_FOUND_IN_DB) return 'not_found';
        if (error.code === STALE_VERSION_IN_DB) return 'stale';
        throw toDatabaseError(error, status);
      }
      return 'ok';
    },

    async archiveSense(id, expectedVersion) {
      if (schemaVersion < 13) {
        throw new DatabaseError('schema_missing', 'Senses need schema version 13. Apply the newest migration.');
      }
      if (schemaVersion >= 15) {
        // One call, one transaction: the word is claimed and must be live,
        // and only the flag and the version move — the sense keeps its
        // identity, its content and its position. A trashed word's senses
        // are refused here, not only in the service.
        const { error, status } = await client.rpc('archive_vocabulary_sense', {
          p_sense_id: id,
          p_expected_version: expectedVersion,
        });
        if (error) {
          if (error.code === NOT_FOUND_IN_DB) return 'not_found';
          if (error.code === STALE_VERSION_IN_DB) return 'stale';
          throw toDatabaseError(error, status);
        }
        return 'ok';
      }
      const { data, error, status } = await client
        .from('vocabulary_senses')
        .update({ archived_at: new Date().toISOString(), version: expectedVersion + 1 })
        .eq('id', id)
        .eq('version', expectedVersion)
        .is('archived_at', null)
        .select('id')
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      if (data !== null) return 'ok';
      const current = await this.getSense(id);
      return current === null ? 'not_found' : 'stale';
    },

    async restoreSense(id, expectedVersion) {
      if (schemaVersion < 14) {
        throw new DatabaseError('schema_missing', 'Restoring a sense needs schema version 14. Apply the newest migration.');
      }
      // One call, one transaction: the word is claimed before the sense is
      // placed at the end, so a reorder in flight finishes first and the
      // placement sees what it left behind.
      const { error, status } = await client.rpc('restore_vocabulary_sense', {
        p_sense_id: id,
        p_expected_version: expectedVersion,
      });
      if (error) {
        if (error.code === NOT_FOUND_IN_DB) return 'not_found';
        if (error.code === STALE_VERSION_IN_DB) return 'stale';
        throw toDatabaseError(error, status);
      }
      return 'ok';
    },

    listVocabMaps: () =>
      readTable(
        (from, to) =>
          client
            .from('vocabulary_maps')
            .select(MAP_COLUMNS)
            .order('updated_at', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
        vocabMapRowSchema,
      ),

    async getVocabMap(id) {
      const { data, error, status } = await client.from('vocabulary_maps').select(MAP_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : vocabMapRowSchema.parse(data);
    },

    async findVocabMapByRequestId(requestId) {
      const { data, error, status } = await client
        .from('vocabulary_maps')
        .select(MAP_COLUMNS)
        .eq('request_id', requestId)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : vocabMapRowSchema.parse(data);
    },

    async insertVocabMap(input) {
      const { data, error, status } = await client
        .from('vocabulary_maps')
        .insert({ type: input.type, title: input.title, description: input.description, request_id: input.requestId })
        .select(MAP_COLUMNS)
        .single();
      if (error?.code === UNIQUE_VIOLATION) return 'duplicate';
      if (error) throw toDatabaseError(error, status);
      return vocabMapRowSchema.parse(data);
    },

    async updateVocabMap(id, patch) {
      const changes: { title?: string; description?: string } = {};
      if (patch.title !== undefined) changes.title = patch.title;
      if (patch.description !== undefined) changes.description = patch.description;
      const { data, error, status } = await client
        .from('vocabulary_maps')
        .update(changes)
        .eq('id', id)
        .select(MAP_COLUMNS);
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : vocabMapRowSchema.parse(row);
    },

    async bumpVocabMap(id) {
      // One call, one transaction: the revision cannot be lost between two clients.
      const { data, error, status } = await client.rpc('bump_vocabulary_map_revision', { p_map_id: id });
      if (error) throw toDatabaseError(error, status);
      const parsed = vocabMapRowSchema.safeParse(data);
      return parsed.success ? parsed.data : null;
    },

    async deleteVocabMap(id) {
      const { data, error, status } = await client.from('vocabulary_maps').delete().eq('id', id).select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },

    listVocabMapNodes: (mapId) =>
      readTable(
        (from, to) =>
          client
            .from('vocabulary_map_nodes')
            .select(MAP_NODE_COLUMNS)
            .eq('map_id', mapId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        vocabMapNodeRowSchema,
      ),

    async insertVocabMapNode(node) {
      const { data, error, status } = await client
        .from('vocabulary_map_nodes')
        .insert({
          map_id: node.mapId,
          kind: node.kind,
          vocabulary_id: node.vocabularyId,
          sense_id: node.senseId,
          label: node.label,
          note: node.note,
          group_key: node.group,
          step: node.step,
          x: node.x,
          y: node.y,
          request_id: node.requestId,
        })
        .select(MAP_NODE_COLUMNS)
        .single();
      // Every way a second copy could land — the request id, the candidate's
      // text, the same word at the same sense — is one unique index, and one
      // answer: the node that exists is the node.
      if (error?.code === UNIQUE_VIOLATION) return 'duplicate';
      // A word or sense that is not the caller's: the composite keys refuse it.
      if (error?.code === FOREIGN_KEY_VIOLATION) {
        throw new DatabaseError('invalid', 'That word is not one this account can put on a map.');
      }
      if (error) throw toDatabaseError(error, status);
      return vocabMapNodeRowSchema.parse(data);
    },

    async findVocabMapNodeByRequestId(mapId, requestId) {
      const { data, error, status } = await client
        .from('vocabulary_map_nodes')
        .select(MAP_NODE_COLUMNS)
        .eq('map_id', mapId)
        .eq('request_id', requestId)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : vocabMapNodeRowSchema.parse(data);
    },

    async findVocabMapNodeByLabel(mapId, label) {
      const { data, error, status } = await client
        .from('vocabulary_map_nodes')
        .select(MAP_NODE_COLUMNS)
        .eq('map_id', mapId)
        .eq('label', label)
        .eq('kind', 'candidate')
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : vocabMapNodeRowSchema.parse(data);
    },

    async patchVocabMapNode(mapId, id, patch) {
      const changes: {
        label?: string;
        note?: string;
        group_key?: string | null;
        step?: number | null;
        x?: number | null;
        y?: number | null;
      } = {};
      if (patch.label !== undefined) changes.label = patch.label;
      if (patch.note !== undefined) changes.note = patch.note;
      if (patch.group !== undefined) changes.group_key = patch.group;
      if (patch.step !== undefined) changes.step = patch.step;
      if (patch.x !== undefined) changes.x = patch.x;
      if (patch.y !== undefined) changes.y = patch.y;
      const { data, error, status } = await client
        .from('vocabulary_map_nodes')
        .update(changes)
        .eq('map_id', mapId)
        .eq('id', id)
        .select(MAP_NODE_COLUMNS);
      if (error?.code === UNIQUE_VIOLATION) {
        throw new DatabaseError('conflict', 'That would put the same thing on this map twice.');
      }
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : vocabMapNodeRowSchema.parse(row);
    },

    async promoteVocabMapNode(mapId, id, vocabularyId) {
      const { data, error, status } = await client
        .from('vocabulary_map_nodes')
        .update({ kind: 'saved', vocabulary_id: vocabularyId, label: null })
        .eq('map_id', mapId)
        .eq('id', id)
        .select(MAP_NODE_COLUMNS);
      if (error?.code === FOREIGN_KEY_VIOLATION) {
        throw new DatabaseError('invalid', 'That word is not one this account can put on a map.');
      }
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : vocabMapNodeRowSchema.parse(row);
    },

    async deleteVocabMapNode(mapId, id) {
      // The edges touching it go with it, through the foreign keys.
      const { data, error, status } = await client
        .from('vocabulary_map_nodes')
        .delete()
        .eq('map_id', mapId)
        .eq('id', id)
        .select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },

    listVocabMapEdges: (mapId) =>
      readTable(
        (from, to) =>
          client
            .from('vocabulary_map_edges')
            .select(MAP_EDGE_COLUMNS)
            .eq('map_id', mapId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        vocabMapEdgeRowSchema,
      ),

    async insertVocabMapEdge(edge) {
      const { data, error, status } = await client
        .from('vocabulary_map_edges')
        .insert({
          map_id: edge.mapId,
          from_node_id: edge.fromNodeId,
          to_node_id: edge.toNodeId,
          kind: edge.kind,
          pattern: edge.pattern,
          note: edge.note,
        })
        .select(MAP_EDGE_COLUMNS)
        .single();
      if (error?.code === UNIQUE_VIOLATION) return 'duplicate';
      // An endpoint on someone else's map, or a node of another map: refused.
      if (error?.code === FOREIGN_KEY_VIOLATION) {
        throw new DatabaseError('invalid', 'Both ends of a relationship must be nodes of this map.');
      }
      if (error) throw toDatabaseError(error, status);
      return vocabMapEdgeRowSchema.parse(data);
    },

    async patchVocabMapEdge(mapId, id, patch) {
      const changes: { pattern?: string; note?: string } = {};
      if (patch.pattern !== undefined) changes.pattern = patch.pattern;
      if (patch.note !== undefined) changes.note = patch.note;
      const { data, error, status } = await client
        .from('vocabulary_map_edges')
        .update(changes)
        .eq('map_id', mapId)
        .eq('id', id)
        .select(MAP_EDGE_COLUMNS);
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : vocabMapEdgeRowSchema.parse(row);
    },

    async deleteVocabMapEdge(mapId, id) {
      const { data, error, status } = await client
        .from('vocabulary_map_edges')
        .delete()
        .eq('map_id', mapId)
        .eq('id', id)
        .select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },

    async countSenses() {
      const { count, error, status } = await client
        .from('vocabulary_senses')
        .select('id', { count: 'exact', head: true });
      if (error) throw toDatabaseError(error, status);
      return count ?? 0;
    },

    // ---- Discovery (schema version 19) ----

    listDiscoverySources: () =>
      readTable(
        (from, to) =>
          client
            .from('discovery_sources')
            .select(DISCOVERY_SOURCE_COLUMNS)
            .order('updated_at', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
        discoverySourceRowSchema,
      ),

    async getDiscoverySource(id) {
      const { data, error, status } = await client
        .from('discovery_sources')
        .select(DISCOVERY_SOURCE_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : discoverySourceRowSchema.parse(data);
    },

    async findDiscoverySourceByRequestId(requestId) {
      const { data, error, status } = await client
        .from('discovery_sources')
        .select(DISCOVERY_SOURCE_COLUMNS)
        .eq('request_id', requestId)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : discoverySourceRowSchema.parse(data);
    },

    async insertDiscoverySource(input) {
      const { data, error, status } = await client
        .from('discovery_sources')
        .insert({
          kind: input.kind,
          title: input.title,
          origin: input.origin,
          content: input.content,
          content_kind: input.contentKind,
          position: input.position,
          request_id: input.requestId,
        })
        .select(DISCOVERY_SOURCE_COLUMNS)
        .single();
      if (error?.code === UNIQUE_VIOLATION) return 'duplicate';
      if (error) throw toDatabaseError(error, status);
      return discoverySourceRowSchema.parse(data);
    },

    async updateDiscoverySource(id, patch) {
      const changes: { title?: string } = {};
      if (patch.title !== undefined) changes.title = patch.title;
      const { data, error, status } = await client
        .from('discovery_sources')
        .update(changes)
        .eq('id', id)
        .select(DISCOVERY_SOURCE_COLUMNS);
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : discoverySourceRowSchema.parse(row);
    },

    async updateDiscoveryPosition(id, position) {
      const { data, error, status } = await client
        .from('discovery_sources')
        .update({ position })
        .eq('id', id)
        .select(DISCOVERY_SOURCE_COLUMNS);
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : discoverySourceRowSchema.parse(row);
    },

    async bumpDiscoverySource(id) {
      // One call, one transaction: the revision cannot be lost between two clients.
      const { data, error, status } = await client.rpc('bump_discovery_source_revision', { p_source_id: id });
      if (error) throw toDatabaseError(error, status);
      const parsed = discoverySourceRowSchema.safeParse(data);
      return parsed.success ? parsed.data : null;
    },

    async deleteDiscoverySource(id) {
      const { data, error, status } = await client.from('discovery_sources').delete().eq('id', id).select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },

    listDiscoveryMarks: (sourceId) =>
      readTable(
        (from, to) => {
          const query = client
            .from('discovery_marks')
            .select(DISCOVERY_MARK_COLUMNS)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to);
          return sourceId === undefined ? query : query.eq('source_id', sourceId);
        },
        discoveryMarkRowSchema,
      ),

    async getDiscoveryMark(id) {
      const { data, error, status } = await client
        .from('discovery_marks')
        .select(DISCOVERY_MARK_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : discoveryMarkRowSchema.parse(data);
    },

    async insertDiscoveryMark(input) {
      const { data, error, status } = await client
        .from('discovery_marks')
        .insert({
          source_id: input.sourceId,
          label: input.label,
          context: input.context,
          char_offset: input.offset,
          cue_start: input.cueStart,
          cue_end: input.cueEnd,
          note: input.note,
          vocabulary_id: input.vocabularyId,
          saved_at: input.savedAt,
          request_id: input.requestId,
        })
        .select(DISCOVERY_MARK_COLUMNS)
        .single();
      // The request id, or the same still-waiting label in this source: one
      // unique answer — the mark that exists is the mark.
      if (error?.code === UNIQUE_VIOLATION) return 'duplicate';
      // A source or word that is not the caller's: the composite keys refuse it.
      if (error?.code === FOREIGN_KEY_VIOLATION) {
        throw new DatabaseError('invalid', 'That source or word is not one this account can attach a selection to.');
      }
      if (error) throw toDatabaseError(error, status);
      return discoveryMarkRowSchema.parse(data);
    },

    async findDiscoveryMarkByRequestId(requestId) {
      const { data, error, status } = await client
        .from('discovery_marks')
        .select(DISCOVERY_MARK_COLUMNS)
        .eq('request_id', requestId)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : discoveryMarkRowSchema.parse(data);
    },

    async findDiscoveryMarkByLabel(sourceId, label) {
      const { data, error, status } = await client
        .from('discovery_marks')
        .select(DISCOVERY_MARK_COLUMNS)
        .eq('source_id', sourceId)
        .eq('label', label)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : discoveryMarkRowSchema.parse(data);
    },

    async findDiscoveryMarkByVocabulary(vocabularyId) {
      const { data, error, status } = await client
        .from('discovery_marks')
        .select(DISCOVERY_MARK_COLUMNS)
        .eq('vocabulary_id', vocabularyId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw toDatabaseError(error, status);
      return data === null ? null : discoveryMarkRowSchema.parse(data);
    },

    async patchDiscoveryMark(id, patch) {
      const changes: { note?: string; vocabulary_id?: string; saved_at?: string } = {};
      if (patch.note !== undefined) changes.note = patch.note;
      if (patch.vocabularyId !== undefined) changes.vocabulary_id = patch.vocabularyId;
      if (patch.savedAt !== undefined) changes.saved_at = patch.savedAt;
      const { data, error, status } = await client
        .from('discovery_marks')
        .update(changes)
        .eq('id', id)
        .select(DISCOVERY_MARK_COLUMNS);
      if (error?.code === FOREIGN_KEY_VIOLATION) {
        throw new DatabaseError('invalid', 'That word is not one this account can attach a selection to.');
      }
      if (error) throw toDatabaseError(error, status);
      const row = (data ?? [])[0];
      return row === undefined ? null : discoveryMarkRowSchema.parse(row);
    },

    async deleteDiscoveryMark(id) {
      const { data, error, status } = await client.from('discovery_marks').delete().eq('id', id).select('id');
      if (error) throw toDatabaseError(error, status);
      return (data ?? []).length > 0;
    },
  };
}
