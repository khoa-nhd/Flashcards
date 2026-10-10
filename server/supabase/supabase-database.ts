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
});

export type CardRow = z.infer<typeof cardRowSchema>;

export const CARD_COLUMNS =
  'id, word, word_key, meaning, definition, example, date_added, created_at, updated_at, deleted_at, mastery, review_date';

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
}

export const reviewWriteResultSchema = z.object({
  outcome: z.enum(['applied', 'already_applied', 'conflict', 'not_found']),
  mastery: z.number().int().nullable(),
  review_date: dateSchema,
});

export type ReviewWriteRow = z.infer<typeof reviewWriteResultSchema>;

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

export function createSupabaseDatabase(client: Client): VocabularyDatabase {
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

  const cards = () => client.from('vocabulary_cards').select(CARD_COLUMNS);

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
