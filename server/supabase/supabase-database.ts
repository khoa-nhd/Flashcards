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
import { fsrsStateSchema, type FsrsState } from '../../shared/scheduler/fsrs.js';
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
}

export interface StoredSettings {
  timeZone: string;
  /** `null` on a database that predates the setting. */
  fsrsRetention: number | null;
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
export const LATEST_SCHEMA_VERSION = 4;

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
  /** The account's settings in one read, or `null` if it has none yet. */
  getSettings(): Promise<StoredSettings | null>;
  /** Needs schema version 3. */
  saveFsrsRetention(value: number): Promise<number>;
  getTimeZone(): Promise<string | null>;
  /** Stores the zone only if the user has none yet; returns the one in effect. */
  ensureTimeZone(timeZone: string): Promise<string>;
  saveTimeZone(timeZone: string): Promise<string>;
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

    async getSettings() {
      const wanted = schemaVersion >= 3 ? 'time_zone, fsrs_request_retention' : 'time_zone';
      const { data, error, status } = await client.from('user_settings').select(wanted).maybeSingle();
      if (error) throw toDatabaseError(error, status);
      if (data === null) return null;
      const row = data as unknown as { time_zone: string; fsrs_request_retention?: number | string | null };
      const retention = row.fsrs_request_retention == null ? null : Number(row.fsrs_request_retention);
      return { timeZone: row.time_zone, fsrsRetention: retention !== null && Number.isFinite(retention) ? retention : null };
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
