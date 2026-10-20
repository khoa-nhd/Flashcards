/**
 * The app's database interface, served by the real PostgreSQL test database
 * instead of a hosted project. Every statement runs as the given user, under
 * Row Level Security, against the migrations exactly as written.
 *
 * It stands in for the one file that needs a hosted project
 * (server/supabase/supabase-database.ts), performing the same reads and
 * calling the same database functions, so everything above that file — the
 * repository, the services, the HTTP API, the import — is tested for real.
 */
import { z } from 'zod';
import {
  DatabaseError,
  DISCOVERY_MARK_COLUMNS,
  DISCOVERY_SOURCE_COLUMNS,
  EXAMPLE_COLUMNS,
  FOREIGN_KEY_VIOLATION,
  LATEST_SCHEMA_VERSION,
  MAP_COLUMNS,
  MAP_EDGE_COLUMNS,
  MAP_NODE_COLUMNS,
  NOT_FOUND_IN_DB,
  RELATION_COLUMNS,
  STALE_VERSION_IN_DB,
  UNIQUE_VIOLATION,
  collectionItemRowSchema,
  collectionRowSchema,
  discoveryMarkRowSchema,
  discoverySourceRowSchema,
  exampleRowSchema,
  relationRowSchema,
  reviewLogColumns,
  reviewLogRowSchema,
  cardColumns,
  cardStatRowSchema,
  confidenceStatRowSchema,
  dailyStatRowSchema,
  cardRowSchema,
  practiceEvent,
  practiceOutcomeSchema,
  practiceStatRowSchema,
  reviewWriteResultSchema,
  senseRowSchema,
  sessionSummaryRowSchema,
  settingsColumns,
  settingsFromRow,
  toDatabaseError,
  undoResultSchema,
  vocabMapEdgeRowSchema,
  vocabMapNodeRowSchema,
  vocabMapRowSchema,
  type CardRow,
  type SettingsRow,
  type VocabularyDatabase,
} from '../../server/supabase/supabase-database.js';
import { isSchedulerId } from '../../shared/scheduler/active.js';
import type { Row, Session, TestDatabase } from './test-database.js';

/** Rows are read as JSON, which gives dates and timestamps the same text form the hosted API returns. */
const cardsQuery = (columns: string, where: string, order: string) =>
  `select to_jsonb(c) as card from (select ${columns} from public.vocabulary_cards where ${where} order by ${order}) c`;

/** The map tables are read as plain columns, so their dates arrive as Dates; the hosted API sends the same moments as text. */
const textDates = <T>(row: T): T =>
  Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  ) as T;

export function createPgVocabularyDatabase(
  db: TestDatabase,
  userId: string,
  /** What the database has, as the real gateway is told; decides which columns are read. */
  schemaVersion: number = LATEST_SCHEMA_VERSION,
): VocabularyDatabase {
  const columns = cardColumns(schemaVersion);
  const run = async <T>(work: (session: Session) => Promise<T>): Promise<T> => {
    try {
      return await db.as(userId, work);
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw toDatabaseError({ code: (error as { code?: string }).code });
    }
  };

  /** Runs a statement that the database may refuse with `code`; answers `null` for that refusal and nothing else. */
  const attempt = async (code: string, work: (session: Session) => Promise<Row[]>): Promise<Row[] | null> => {
    try {
      return await db.as(userId, work);
    } catch (error) {
      const failure = error as { code?: string };
      if (failure.code === code) return null;
      throw error instanceof DatabaseError ? error : toDatabaseError({ code: failure.code });
    }
  };

  /**
   * Runs an insert into the map tables. A refused second copy answers
   * 'duplicate' — every unique index there means "the one that exists is the
   * answer". A foreign key naming something outside this account's own rows
   * is an invalid request, the same refusal the hosted gateway gives.
   */
  const insertInto = async (work: (session: Session) => Promise<Row[]>): Promise<Row[] | 'duplicate'> => {
    try {
      return await db.as(userId, work);
    } catch (error) {
      const failure = error as { code?: string };
      if (failure.code === UNIQUE_VIOLATION) return 'duplicate';
      if (failure.code === FOREIGN_KEY_VIOLATION) {
        throw new DatabaseError('invalid', 'That reference does not belong to this account.');
      }
      throw error instanceof DatabaseError ? error : toDatabaseError({ code: failure.code });
    }
  };

  const cards = async (where: string, order: string, params: unknown[] = []): Promise<CardRow[]> => {
    const rows = await run((session) => session.query<{ card: unknown }>(cardsQuery(columns, where, order), params));
    return z.array(cardRowSchema).parse(rows.map((row) => row.card));
  };

  const database: VocabularyDatabase = {
    listCards: () => cards('deleted_at is null', 'created_at, id'),

    listTrashedCards: () => cards('deleted_at is not null', 'deleted_at desc, id'),

    listDueCards: (today, retiredAt) =>
      cards(
        'deleted_at is null and mastery < $2 and (review_date is null or review_date <= $1::date)',
        'review_date asc nulls last, created_at, id',
        [today, retiredAt],
      ),

    async getCard(id) {
      return (await cards('id = $1::uuid', 'id', [id]))[0] ?? null;
    },

    findCardsByWordKey: (wordKey) => cards('deleted_at is null and word_key = $1', 'created_at, id', [wordKey]),

    async findCardByRequestId(requestId) {
      const found = await run((session) =>
        session.query<{ id: string }>('select id from public.vocabulary where request_id = $1::uuid', [requestId]),
      );
      return found[0] === undefined ? null : database.getCard(found[0].id);
    },

    async listImported(source) {
      const rows = await run((session) =>
        session.query<{ id: string; external_id: string }>(
          'select id, external_id from public.vocabulary where external_source = $1 order by id',
          [source],
        ),
      );
      return rows.map((row) => ({ id: row.id, externalId: row.external_id }));
    },

    async countCards(options = {}) {
      const rows = await run((session) =>
        session.query<{ count: number }>(
          `select count(*)::int as count from public.vocabulary_cards
            where deleted_at is null and ($1::int is null or mastery < $1::int)`,
          [options.masteryBelow ?? null],
        ),
      );
      return rows[0]?.count ?? 0;
    },

    async createCard(card) {
      // A row that carries its senses writes them with the word, in one
      // transaction: no failure between them can leave a word without them.
      const withSenses = card.senses !== undefined && card.senses.length > 0;
      if (withSenses && schemaVersion < 14) {
        throw new DatabaseError('schema_missing', 'Senses on creation need schema version 14. Apply the newest migration.');
      }
      const rows = await run((session) =>
        withSenses
          ? session.query<{ id: string; created: boolean }>(
              `select * from public.create_vocabulary_with_senses(
                 p_word => $1, p_word_key => $2, p_mastery => $3::smallint, p_meaning => $4, p_definition => $5,
                 p_example => $6, p_date_added => $7::date, p_review_date => $8::date, p_request_id => $9::uuid,
                 p_external_source => $10, p_external_id => $11, p_created_at => $12::timestamptz, p_senses => $13::jsonb)`,
              [
                card.word,
                card.wordKey,
                card.mastery,
                card.meaning,
                card.definition,
                card.example,
                card.dateAdded,
                card.reviewDate,
                card.requestId,
                card.external?.source ?? null,
                card.external?.id ?? null,
                card.external?.createdAt ?? null,
                JSON.stringify(
                  (card.senses ?? []).map((sense) => ({
                    meaning: sense.meaning,
                    definition: sense.definition,
                    example: sense.example,
                    request_id: sense.requestId,
                  })),
                ),
              ],
            )
          : session.query<{ id: string; created: boolean }>(
              `select * from public.create_vocabulary(
                 p_word => $1, p_word_key => $2, p_mastery => $3::smallint, p_meaning => $4, p_definition => $5,
                 p_example => $6, p_date_added => $7::date, p_review_date => $8::date, p_request_id => $9::uuid,
                 p_external_source => $10, p_external_id => $11, p_created_at => $12::timestamptz)`,
              [
                card.word,
                card.wordKey,
                card.mastery,
                card.meaning,
                card.definition,
                card.example,
                card.dateAdded,
                card.reviewDate,
                card.requestId,
                card.external?.source ?? null,
                card.external?.id ?? null,
                card.external?.createdAt ?? null,
              ],
            ),
      );
      if (rows[0] === undefined) throw new DatabaseError('unavailable', 'The database did not confirm the new word.');
      return rows[0];
    },

    async updateCard(id, patch) {
      const rows = await run((session) =>
        session.query<{ updated: boolean }>('select public.update_vocabulary($1::uuid, $2::jsonb) as updated', [
          id,
          JSON.stringify(patch),
        ]),
      );
      return rows[0]?.updated === true;
    },

    async setCardTrashed(id, trashed) {
      const rows = await run((session) =>
        session.query<Row>(
          `update public.vocabulary
              set deleted_at = case when $2::boolean then now() else null end
            where id = $1::uuid and (deleted_at is null) = $2::boolean
          returning id`,
          [id, trashed],
        ),
      );
      return rows.length > 0;
    },

    async applyReview(args) {
      const rows = await run((session) =>
        session.query<Row>(
          `select outcome, mastery, review_date::text as review_date
             from public.apply_review(
               p_vocabulary_id => $1::uuid, p_request_id => $2::uuid, p_action => $3,
               p_expected_mastery => $4::smallint, p_expected_review_date => $5::date,
               p_new_mastery => $6::smallint, p_new_review_date => $7::date,
               p_reviewed_on => $8::date, p_duration_ms => $9::integer)`,
          [
            args.id,
            args.requestId,
            args.action,
            args.expectedMastery,
            args.expectedReviewDate,
            args.newMastery,
            args.newReviewDate,
            args.reviewedOn,
            args.durationMs,
          ],
        ),
      );
      return reviewWriteResultSchema.parse(rows[0]);
    },

    async findReviewByRequestId(requestId) {
      const rows = await run((session) =>
        session.query<{ mastery_after: number; review_date_after: string | null }>(
          `select mastery_after, review_date_after::text as review_date_after
             from public.review_logs where request_id = $1::uuid`,
          [requestId],
        ),
      );
      return rows[0] === undefined ? null : { mastery: rows[0].mastery_after, reviewDate: rows[0].review_date_after };
    },

    async schemaVersion() {
      try {
        const rows = await db.as(userId, (session) =>
          session.query<{ version: number }>('select public.app_schema_version() as version'),
        );
        return rows[0]?.version ?? 1;
      } catch (error) {
        // No such function: only the first migration has been applied.
        if ((error as { code?: string }).code === '42883') return 1;
        throw error;
      }
    },

    async recordReview(args) {
      const rows = await run((session) =>
        session.query<Row>(
          `select outcome, mastery, review_date::text as review_date from public.record_review($1::jsonb)`,
          [
            JSON.stringify({
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
            }),
          ],
        ),
      );
      return reviewWriteResultSchema.parse(rows[0]);
    },

    async undoReview(args) {
      const rows = await run((session) =>
        session.query<Row>(
          `select outcome, vocabulary_id, mastery, review_date::text as review_date
             from public.undo_review($1::uuid, $2::uuid)`,
          [args.reviewRequestId, args.requestId],
        ),
      );
      return undoResultSchema.parse(rows[0]);
    },

    async sessionSummary(sessionId) {
      const rows = await run((session) =>
        session.query<{ summary: unknown }>(
          `select to_jsonb(s) as summary from public.session_summary($1::uuid) s`,
          [sessionId],
        ),
      );
      return rows[0] === undefined ? null : sessionSummaryRowSchema.parse(rows[0].summary);
    },

    async reviewDailyStats(from, to) {
      const rows = await run((session) =>
        session.query<{ stat: unknown }>(
          'select to_jsonb(s) as stat from public.review_daily_stats($1::date, $2::date) s',
          [from, to],
        ),
      );
      return z.array(dailyStatRowSchema).parse(rows.map((row) => row.stat));
    },

    async cardReviewStats(since) {
      const rows = await run((session) =>
        session.query<{ stat: unknown }>('select to_jsonb(s) as stat from public.card_review_stats($1::date) s', [since]),
      );
      return z.array(cardStatRowSchema).parse(rows.map((row) => row.stat));
    },

    async listReviewLogs() {
      // Read as JSON, which gives dates and timestamps the same text form the hosted API returns.
      const rows = await run((session) =>
        session.query<{ log: unknown }>(
          `select to_jsonb(l) as log from (select ${reviewLogColumns(schemaVersion)} from public.review_logs
             order by reviewed_at, id) l`,
        ),
      );
      return z.array(reviewLogRowSchema).parse(rows.map((row) => row.log));
    },

    async listCollections() {
      const rows = await run((session) => session.query('select id, name from public.collections order by name_key, id'));
      return z.array(collectionRowSchema).parse(rows);
    },

    async listCollectionItems() {
      const rows = await run((session) =>
        session.query('select collection_id, vocabulary_id from public.collection_items order by collection_id, vocabulary_id'),
      );
      return z.array(collectionItemRowSchema).parse(rows);
    },

    async insertCollection(name, nameKey) {
      const rows = await attempt(UNIQUE_VIOLATION, (session) =>
        session.query('insert into public.collections (name, name_key) values ($1, $2) returning id, name', [name, nameKey]),
      );
      return rows === null ? 'duplicate' : collectionRowSchema.parse(rows[0]);
    },

    async renameCollection(id, name, nameKey) {
      const rows = await attempt(UNIQUE_VIOLATION, (session) =>
        session.query('update public.collections set name = $2, name_key = $3 where id = $1::uuid returning id, name', [
          id,
          name,
          nameKey,
        ]),
      );
      if (rows === null) return 'duplicate';
      return rows[0] === undefined ? null : collectionRowSchema.parse(rows[0]);
    },

    async deleteCollection(id) {
      const rows = await run((session) => session.query('delete from public.collections where id = $1::uuid returning id', [id]));
      return rows.length > 0;
    },

    async addCollectionItem(collectionId, vocabularyId) {
      const rows = await attempt(FOREIGN_KEY_VIOLATION, (session) =>
        session.query(
          `insert into public.collection_items (collection_id, vocabulary_id) values ($1::uuid, $2::uuid)
           on conflict (collection_id, vocabulary_id) do nothing`,
          [collectionId, vocabularyId],
        ),
      );
      return rows !== null;
    },

    async removeCollectionItem(collectionId, vocabularyId) {
      return run(async (session) => {
        const owned = await session.query('select id from public.collections where id = $1::uuid', [collectionId]);
        if (owned.length === 0) return false;
        await session.query('delete from public.collection_items where collection_id = $1::uuid and vocabulary_id = $2::uuid', [
          collectionId,
          vocabularyId,
        ]);
        return true;
      });
    },

    async listExamples() {
      const rows = await run((session) =>
        session.query(`select ${EXAMPLE_COLUMNS} from public.vocabulary_examples order by vocabulary_id, created_at, id`),
      );
      return z.array(exampleRowSchema).parse(rows);
    },

    async getExample(id) {
      const rows = await run((session) =>
        session.query(`select ${EXAMPLE_COLUMNS} from public.vocabulary_examples where id = $1::uuid`, [id]),
      );
      return rows[0] === undefined ? null : exampleRowSchema.parse(rows[0]);
    },

    async insertExample(vocabularyId, sentence, source) {
      const rows = await attempt(FOREIGN_KEY_VIOLATION, (session) =>
        session.query(
          `insert into public.vocabulary_examples (vocabulary_id, sentence, source) values ($1::uuid, $2, $3)
           returning ${EXAMPLE_COLUMNS}`,
          [vocabularyId, sentence, source],
        ),
      );
      return rows === null ? null : exampleRowSchema.parse(rows[0]);
    },

    async updateExample(id, changes) {
      const rows = await run((session) =>
        session.query(
          `update public.vocabulary_examples
              set sentence = case when $2::boolean then $3 else sentence end,
                  source = case when $4::boolean then $5 else source end
            where id = $1::uuid
          returning ${EXAMPLE_COLUMNS}`,
          [id, changes.sentence !== undefined, changes.sentence ?? null, changes.source !== undefined, changes.source ?? null],
        ),
      );
      return rows[0] === undefined ? null : exampleRowSchema.parse(rows[0]);
    },

    async setPreferredExample(id, preferred) {
      const rows = await run((session) =>
        session.query<{ done: boolean }>('select public.set_preferred_example($1::uuid, $2::boolean) as done', [id, preferred]),
      );
      return rows[0]?.done === true;
    },

    async deleteExample(id) {
      const rows = await run((session) =>
        session.query('delete from public.vocabulary_examples where id = $1::uuid returning id', [id]),
      );
      return rows.length > 0;
    },

    async listRelations() {
      const rows = await run((session) =>
        session.query(`select ${RELATION_COLUMNS} from public.vocabulary_relations order by low_id, high_id, kind`),
      );
      return z.array(relationRowSchema).parse(rows);
    },

    async insertRelation(lowId, highId, kind) {
      const found = (session: Session) =>
        session.query(
          `select ${RELATION_COLUMNS} from public.vocabulary_relations where low_id = $1::uuid and high_id = $2::uuid and kind = $3`,
          [lowId, highId, kind],
        );
      const existing = await run(found);
      if (existing[0] !== undefined) return relationRowSchema.parse(existing[0]);
      const rows = await attempt(FOREIGN_KEY_VIOLATION, (session) =>
        session.query(
          `insert into public.vocabulary_relations (low_id, high_id, kind) values ($1::uuid, $2::uuid, $3)
           returning ${RELATION_COLUMNS}`,
          [lowId, highId, kind],
        ),
      );
      return rows === null ? null : relationRowSchema.parse(rows[0]);
    },

    async deleteRelation(id) {
      const rows = await run((session) =>
        session.query('delete from public.vocabulary_relations where id = $1::uuid returning id', [id]),
      );
      return rows.length > 0;
    },

    async recordPractice(args) {
      const rows = await run((session) =>
        session.query<{ outcome: string }>('select outcome from public.record_practice($1::jsonb)', [
          JSON.stringify(practiceEvent(args)),
        ]),
      );
      return practiceOutcomeSchema.parse(rows[0]?.outcome);
    },

    async practiceDailyStats(from, to) {
      const rows = await run((session) =>
        session.query<{ stat: unknown }>(
          'select to_jsonb(s) as stat from public.practice_daily_stats($1::date, $2::date) s',
          [from, to],
        ),
      );
      return z.array(practiceStatRowSchema).parse(rows.map((row) => row.stat));
    },

    async confidenceStats(since) {
      const rows = await run((session) =>
        session.query<{ stat: unknown }>('select to_jsonb(s) as stat from public.confidence_stats($1::date) s', [since]),
      );
      return z.array(confidenceStatRowSchema).parse(rows.map((row) => row.stat));
    },

    async getSettings() {
      // The same columns the real gateway asks for at this version, read as JSON like the hosted API returns them.
      const wanted = settingsColumns(schemaVersion);
      const rows = await run((session) =>
        session.query<{ settings: SettingsRow }>(
          `select to_jsonb(s) as settings from (select ${wanted} from public.user_settings) s`,
        ),
      );
      return rows[0] === undefined ? null : settingsFromRow(rows[0].settings, schemaVersion);
    },

    async saveDailyGoal(goal) {
      const rows = await run((session) =>
        session.query<{ reviews: number | null; minutes: number | null }>(
          `insert into public.user_settings (daily_goal_reviews, daily_goal_minutes) values ($1, $2)
           on conflict (user_id) do update
             set daily_goal_reviews = excluded.daily_goal_reviews, daily_goal_minutes = excluded.daily_goal_minutes
           returning daily_goal_reviews as reviews, daily_goal_minutes as minutes`,
          [goal.reviews, goal.minutes],
        ),
      );
      return rows[0] ?? goal;
    },

    async saveFsrsRetention(value) {
      const rows = await run((session) =>
        session.query<{ retention: number }>(
          `insert into public.user_settings (fsrs_request_retention) values ($1)
           on conflict (user_id) do update set fsrs_request_retention = excluded.fsrs_request_retention
           returning fsrs_request_retention::float8 as retention`,
          [value],
        ),
      );
      return rows[0]?.retention ?? value;
    },

    async saveScheduler(value) {
      const rows = await run((session) =>
        session.query<{ scheduler: string }>(
          `insert into public.user_settings (scheduler) values ($1)
           on conflict (user_id) do update set scheduler = excluded.scheduler
           returning scheduler`,
          [value],
        ),
      );
      return isSchedulerId(rows[0]?.scheduler) ? rows[0].scheduler : value;
    },

    async getTimeZone() {
      const rows = await run((session) => session.query<{ time_zone: string }>('select time_zone from public.user_settings'));
      return rows[0]?.time_zone ?? null;
    },

    async ensureTimeZone(timeZone) {
      await run((session) =>
        session.query('insert into public.user_settings (time_zone) values ($1) on conflict (user_id) do nothing', [
          timeZone,
        ]),
      );
      return (await database.getTimeZone()) ?? timeZone;
    },

    async saveTimeZone(timeZone) {
      const rows = await run((session) =>
        session.query<{ time_zone: string }>(
          `insert into public.user_settings (time_zone) values ($1)
           on conflict (user_id) do update set time_zone = excluded.time_zone
           returning time_zone`,
          [timeZone],
        ),
      );
      return rows[0]?.time_zone ?? timeZone;
    },

    // ---- Senses (schema version 13) ----
    async listSenses(vocabularyId) {
      if (schemaVersion < 13) return [];
      const rows = await run((session) =>
        session.query<{ sense: unknown }>(
          `select to_jsonb(s) as sense from public.vocabulary_senses s
            where s.vocabulary_id = $1::uuid order by s.position`,
          [vocabularyId],
        ),
      );
      return z.array(senseRowSchema).parse(rows.map((row) => row.sense));
    },

    async getSense(id) {
      if (schemaVersion < 13) return null;
      const rows = await run((session) =>
        session.query<{ sense: unknown }>('select to_jsonb(s) as sense from public.vocabulary_senses s where s.id = $1::uuid', [id]),
      );
      return rows[0] === undefined ? null : senseRowSchema.parse(rows[0].sense);
    },

    async createSense(vocabularyId, sense, options) {
      if (schemaVersion < 14) {
        throw new DatabaseError('schema_missing', 'Adding a sense needs schema version 14. Apply the newest migration.');
      }
      // One call: the word is claimed, the position is chosen and the sense
      // is written while the claim is held, so two adds cannot take one
      // position. A retry of the same action carries the same request id and
      // lands on the same sense.
      if (options?.resume === true && schemaVersion >= 15) {
        // The import's completion call: may land a sense on a word in the
        // trash — the case the ordinary add refuses — and sets the file's
        // archive flag in the same statement. Content already stored is
        // never rewritten.
        try {
          const rows = await db.as(userId, (session) =>
            session.query<{ id: string; created: boolean }>(
              'select * from public.resume_vocabulary_sense($1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::boolean)',
              [vocabularyId, sense.meaning, sense.definition, sense.example, sense.requestId, options.archived === true],
            ),
          );
          const made = rows[0];
          if (made === undefined) throw new DatabaseError('unavailable', 'The database did not confirm the new sense.');
          const stored = await database.getSense(made.id);
          if (stored === null) throw new DatabaseError('unavailable', 'The new sense could not be read back.');
          return { sense: stored, created: made.created };
        } catch (error) {
          if (error instanceof DatabaseError) throw error;
          const code = (error as { code?: string }).code;
          if (code === NOT_FOUND_IN_DB) {
            throw new DatabaseError('invalid', 'That word is not in this vocabulary.', code);
          }
          throw toDatabaseError({ code });
        }
      }
      try {
        const rows = await db.as(userId, (session) =>
          session.query<{ id: string; created: boolean }>(
            'select * from public.add_vocabulary_sense($1::uuid, $2::text, $3::text, $4::text, $5::uuid)',
            [vocabularyId, sense.meaning, sense.definition, sense.example, sense.requestId],
          ),
        );
        const made = rows[0];
        if (made === undefined) throw new DatabaseError('unavailable', 'The database did not confirm the new sense.');
        const stored = await database.getSense(made.id);
        if (stored === null) throw new DatabaseError('unavailable', 'The new sense could not be read back.');
        if (options?.resume === true && options.archived === true && stored.archived_at === null) {
          // Schema 14's pair of statements: the flag lands as its own update,
          // which the version guards against a second writer.
          const flagged = await run((session) =>
            session.query<Row>(
              `update public.vocabulary_senses set archived_at = now(), version = version + 1
                where id = $1::uuid and version = $2::int and archived_at is null
                returning id`,
              [stored.id, stored.version],
            ),
          );
          if (flagged.length === 0) {
            const recheck = await database.getSense(stored.id);
            if (recheck === null || recheck.archived_at === null) {
              throw new DatabaseError('conflict', 'The archive flag for this imported sense could not be applied.');
            }
          }
        }
        return { sense: stored, created: made.created };
      } catch (error) {
        if (error instanceof DatabaseError) throw error;
        const code = (error as { code?: string }).code;
        if (code === NOT_FOUND_IN_DB) {
          throw new DatabaseError('invalid', 'That word is not in this vocabulary.', code);
        }
        throw toDatabaseError({ code });
      }
    },

    async updateSense(id, patch) {
      if (schemaVersion < 13) {
        throw new DatabaseError('schema_missing', 'Senses need schema version 13. Apply the newest migration.');
      }
      if (schemaVersion >= 15) {
        // One call, one transaction: the word is claimed and must be live,
        // and the version sits in the same statement that writes the change.
        // A trashed word's senses are refused here, not only in the service.
        try {
          await db.as(userId, (session) =>
            session.query('select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)', [
              id,
              patch.expectedVersion,
              JSON.stringify({
                ...(patch.meaning !== undefined ? { meaning: patch.meaning } : {}),
                ...(patch.definition !== undefined ? { definition: patch.definition } : {}),
                ...(patch.example !== undefined ? { example: patch.example } : {}),
              }),
            ]),
          );
        } catch (error) {
          if (error instanceof DatabaseError) throw error;
          const code = (error as { code?: string }).code;
          if (code === NOT_FOUND_IN_DB) return 'not_found';
          if (code === STALE_VERSION_IN_DB) return 'stale';
          throw toDatabaseError({ code });
        }
        const written = await database.getSense(id);
        if (written === null) throw new DatabaseError('unavailable', 'The updated sense could not be read back.');
        return written;
      }
      // One statement with the version in its condition: a second change in
      // between matches no row, and nothing is overwritten.
      const rows = await run((session) =>
        session.query<{ sense: unknown }>(
          `update public.vocabulary_senses as t
              set meaning = case when $2::boolean then $3::text else t.meaning end,
                  definition = case when $4::boolean then $5::text else t.definition end,
                  example = case when $6::boolean then $7::text else t.example end,
                  version = t.version + 1
            where t.id = $1::uuid and t.version = $8::int and t.archived_at is null
            returning to_jsonb(t) as sense`,
          [
            id,
            patch.meaning !== undefined,
            patch.meaning ?? null,
            patch.definition !== undefined,
            patch.definition ?? null,
            patch.example !== undefined,
            patch.example ?? null,
            patch.expectedVersion,
          ],
        ),
      );
      if (rows[0] !== undefined) return senseRowSchema.parse(rows[0].sense);
      const current = await database.getSense(id);
      return current === null ? 'not_found' : 'stale';
    },

    async reorderSenses(vocabularyId, senseIds, expectedVersion) {
      if (schemaVersion < 14) {
        throw new DatabaseError('schema_missing', 'Reordering senses needs schema version 14. Apply the newest migration.');
      }
      // One call, one transaction: the word is claimed, the version checked,
      // the order checked against the senses stored, and only then are the
      // rows moved. Everything succeeds or nothing does.
      try {
        await db.as(userId, (session) =>
          session.query('select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)', [
            vocabularyId,
            JSON.stringify(senseIds),
            expectedVersion,
          ]),
        );
        return 'ok';
      } catch (error) {
        if (error instanceof DatabaseError) throw error;
        const code = (error as { code?: string }).code;
        if (code === NOT_FOUND_IN_DB) return 'not_found';
        if (code === STALE_VERSION_IN_DB) return 'stale';
        throw toDatabaseError({ code });
      }
    },

    async archiveSense(id, expectedVersion) {
      if (schemaVersion < 13) {
        throw new DatabaseError('schema_missing', 'Senses need schema version 13. Apply the newest migration.');
      }
      if (schemaVersion >= 15) {
        // One call, one transaction: the word is claimed and must be live,
        // and only the flag and the version move. A trashed word's senses
        // are refused here, not only in the service.
        try {
          await db.as(userId, (session) =>
            session.query('select public.archive_vocabulary_sense($1::uuid, $2::int)', [id, expectedVersion]),
          );
          return 'ok';
        } catch (error) {
          if (error instanceof DatabaseError) throw error;
          const code = (error as { code?: string }).code;
          if (code === NOT_FOUND_IN_DB) return 'not_found';
          if (code === STALE_VERSION_IN_DB) return 'stale';
          throw toDatabaseError({ code });
        }
      }
      const rows = await run((session) =>
        session.query<Row>(
          `update public.vocabulary_senses set archived_at = now(), version = version + 1
            where id = $1::uuid and version = $2::int and archived_at is null
            returning id`,
          [id, expectedVersion],
        ),
      );
      if (rows.length > 0) return 'ok';
      const current = await database.getSense(id);
      return current === null ? 'not_found' : 'stale';
    },

    async restoreSense(id, expectedVersion) {
      if (schemaVersion < 14) {
        throw new DatabaseError('schema_missing', 'Restoring a sense needs schema version 14. Apply the newest migration.');
      }
      // One call, one transaction: the word is claimed before the sense is
      // placed at the end, so a reorder in flight finishes first.
      try {
        await db.as(userId, (session) =>
          session.query('select public.restore_vocabulary_sense($1::uuid, $2::int)', [id, expectedVersion]),
        );
        return 'ok';
      } catch (error) {
        if (error instanceof DatabaseError) throw error;
        const code = (error as { code?: string }).code;
        if (code === NOT_FOUND_IN_DB) return 'not_found';
        if (code === STALE_VERSION_IN_DB) return 'stale';
        throw toDatabaseError({ code });
      }
    },

    // ---- Vocabulary maps (schema version 18) ----
    async listVocabMaps() {
      const rows = await run((session) =>
        session.query(`select ${MAP_COLUMNS} from public.vocabulary_maps order by updated_at desc, id`),
      );
      return z.array(vocabMapRowSchema).parse(rows.map(textDates));
    },

    async getVocabMap(id) {
      const rows = await run((session) =>
        session.query(`select ${MAP_COLUMNS} from public.vocabulary_maps where id = $1::uuid`, [id]),
      );
      return rows[0] === undefined ? null : vocabMapRowSchema.parse(textDates(rows[0]));
    },

    async findVocabMapByRequestId(requestId) {
      const rows = await run((session) =>
        session.query(`select ${MAP_COLUMNS} from public.vocabulary_maps where request_id = $1::uuid`, [requestId]),
      );
      return rows[0] === undefined ? null : vocabMapRowSchema.parse(textDates(rows[0]));
    },

    async insertVocabMap(input) {
      const rows = await insertInto((session) =>
        session.query(
          `insert into public.vocabulary_maps (type, title, description, request_id)
           values ($1, $2, $3, $4::uuid) returning ${MAP_COLUMNS}`,
          [input.type, input.title, input.description, input.requestId],
        ),
      );
      return rows === 'duplicate' ? 'duplicate' : vocabMapRowSchema.parse(textDates(rows[0]));
    },

    async updateVocabMap(id, patch) {
      const rows = await run((session) =>
        session.query(
          `update public.vocabulary_maps
              set title = case when $2::boolean then $3 else title end,
                  description = case when $4::boolean then $5 else description end
            where id = $1::uuid
            returning ${MAP_COLUMNS}`,
          [id, patch.title !== undefined, patch.title ?? null, patch.description !== undefined, patch.description ?? null],
        ),
      );
      return rows[0] === undefined ? null : vocabMapRowSchema.parse(textDates(rows[0]));
    },

    async bumpVocabMap(id) {
      // The same call the hosted gateway makes: one statement, one transaction.
      // A map the caller cannot reach updates nothing, and a composite
      // function still answers with one row of nulls — read as "nothing moved",
      // exactly as the hosted gateway's own parse reads it.
      const rows = await run((session) =>
        session.query<{ map: unknown }>('select to_jsonb(m) as map from public.bump_vocabulary_map_revision($1::uuid) m', [id]),
      );
      const parsed = vocabMapRowSchema.safeParse(textDates(rows[0]?.map));
      return parsed.success ? parsed.data : null;
    },

    async deleteVocabMap(id) {
      const rows = await run((session) =>
        session.query('delete from public.vocabulary_maps where id = $1::uuid returning id', [id]),
      );
      return rows.length > 0;
    },

    async listVocabMapNodes(mapId) {
      const rows = await run((session) =>
        session.query(`select ${MAP_NODE_COLUMNS} from public.vocabulary_map_nodes where map_id = $1::uuid order by created_at, id`, [
          mapId,
        ]),
      );
      return z.array(vocabMapNodeRowSchema).parse(rows.map(textDates));
    },

    async insertVocabMapNode(node) {
      const rows = await insertInto((session) =>
        session.query(
          `insert into public.vocabulary_map_nodes
             (map_id, kind, vocabulary_id, sense_id, label, note, group_key, step, x, y, request_id)
           values ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8::int, $9::int, $10::int, $11::uuid)
           returning ${MAP_NODE_COLUMNS}`,
          [
            node.mapId,
            node.kind,
            node.vocabularyId,
            node.senseId,
            node.label,
            node.note,
            node.group,
            node.step,
            node.x,
            node.y,
            node.requestId,
          ],
        ),
      );
      return rows === 'duplicate' ? 'duplicate' : vocabMapNodeRowSchema.parse(textDates(rows[0]));
    },

    async findVocabMapNodeByRequestId(mapId, requestId) {
      const rows = await run((session) =>
        session.query(`select ${MAP_NODE_COLUMNS} from public.vocabulary_map_nodes where map_id = $1::uuid and request_id = $2::uuid`, [
          mapId,
          requestId,
        ]),
      );
      return rows[0] === undefined ? null : vocabMapNodeRowSchema.parse(textDates(rows[0]));
    },

    async findVocabMapNodeByLabel(mapId, label) {
      const rows = await run((session) =>
        session.query(
          `select ${MAP_NODE_COLUMNS} from public.vocabulary_map_nodes
            where map_id = $1::uuid and label = $2 and kind = 'candidate'`,
          [mapId, label],
        ),
      );
      return rows[0] === undefined ? null : vocabMapNodeRowSchema.parse(textDates(rows[0]));
    },

    async patchVocabMapNode(mapId, id, patch) {
      try {
        const rows = await run((session) =>
          session.query(
            `update public.vocabulary_map_nodes
                set label = case when $3::boolean then $4 else label end,
                    note = case when $5::boolean then $6 else note end,
                    group_key = case when $7::boolean then $8::text else group_key end,
                    step = case when $9::boolean then $10::int else step end,
                    x = case when $11::boolean then $12::int else x end,
                    y = case when $13::boolean then $14::int else y end
              where map_id = $1::uuid and id = $2::uuid
              returning ${MAP_NODE_COLUMNS}`,
            [
              mapId,
              id,
              patch.label !== undefined,
              patch.label ?? null,
              patch.note !== undefined,
              patch.note ?? null,
              patch.group !== undefined,
              patch.group ?? null,
              patch.step !== undefined,
              patch.step ?? null,
              patch.x !== undefined,
              patch.x ?? null,
              patch.y !== undefined,
              patch.y ?? null,
            ],
          ),
        );
        return rows[0] === undefined ? null : vocabMapNodeRowSchema.parse(textDates(rows[0]));
      } catch (error) {
        // Setting a label or step that would repeat what the map already holds.
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new DatabaseError('conflict', 'That would put the same thing on this map twice.');
        }
        throw error;
      }
    },

    async promoteVocabMapNode(mapId, id, vocabularyId) {
      try {
        const rows = await run((session) =>
          session.query(
            `update public.vocabulary_map_nodes
                set kind = 'saved', vocabulary_id = $3::uuid, label = null
              where map_id = $1::uuid and id = $2::uuid
              returning ${MAP_NODE_COLUMNS}`,
            [mapId, id, vocabularyId],
          ),
        );
        return rows[0] === undefined ? null : vocabMapNodeRowSchema.parse(textDates(rows[0]));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === FOREIGN_KEY_VIOLATION) {
          throw new DatabaseError('invalid', 'That word is not one this account can put on a map.');
        }
        throw error;
      }
    },

    async deleteVocabMapNode(mapId, id) {
      const rows = await run((session) =>
        session.query('delete from public.vocabulary_map_nodes where map_id = $1::uuid and id = $2::uuid returning id', [mapId, id]),
      );
      return rows.length > 0;
    },

    async listVocabMapEdges(mapId) {
      const rows = await run((session) =>
        session.query(`select ${MAP_EDGE_COLUMNS} from public.vocabulary_map_edges where map_id = $1::uuid order by created_at, id`, [
          mapId,
        ]),
      );
      return z.array(vocabMapEdgeRowSchema).parse(rows.map(textDates));
    },

    async insertVocabMapEdge(edge) {
      try {
        const rows = await insertInto((session) =>
          session.query(
            `insert into public.vocabulary_map_edges (map_id, from_node_id, to_node_id, kind, pattern, note)
             values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) returning ${MAP_EDGE_COLUMNS}`,
            [edge.mapId, edge.fromNodeId, edge.toNodeId, edge.kind, edge.pattern, edge.note],
          ),
        );
        if (rows === 'duplicate') return 'duplicate';
        return vocabMapEdgeRowSchema.parse(textDates(rows[0]));
      } catch (error) {
        if (error instanceof DatabaseError && error.failure === 'invalid') {
          throw new DatabaseError('invalid', 'Both ends of a relationship must be nodes of this map.');
        }
        throw error;
      }
    },

    async patchVocabMapEdge(mapId, id, patch) {
      const rows = await run((session) =>
        session.query(
          `update public.vocabulary_map_edges
              set pattern = case when $3::boolean then $4 else pattern end,
                  note = case when $5::boolean then $6 else note end
            where map_id = $1::uuid and id = $2::uuid
            returning ${MAP_EDGE_COLUMNS}`,
          [mapId, id, patch.pattern !== undefined, patch.pattern ?? null, patch.note !== undefined, patch.note ?? null],
        ),
      );
      return rows[0] === undefined ? null : vocabMapEdgeRowSchema.parse(textDates(rows[0]));
    },

    async deleteVocabMapEdge(mapId, id) {
      const rows = await run((session) =>
        session.query('delete from public.vocabulary_map_edges where map_id = $1::uuid and id = $2::uuid returning id', [mapId, id]),
      );
      return rows.length > 0;
    },

    async countSenses() {
      const rows = await run((session) => session.query<{ count: number }>('select count(*)::int as count from public.vocabulary_senses'));
      return rows[0]?.count ?? 0;
    },

    // ---- Discovery (schema version 19) ----
    async listDiscoverySources() {
      const rows = await run((session) =>
        session.query(`select ${DISCOVERY_SOURCE_COLUMNS} from public.discovery_sources order by updated_at desc, id`),
      );
      return z.array(discoverySourceRowSchema).parse(rows.map(textDates));
    },

    async getDiscoverySource(id) {
      const rows = await run((session) =>
        session.query(`select ${DISCOVERY_SOURCE_COLUMNS} from public.discovery_sources where id = $1::uuid`, [id]),
      );
      return rows[0] === undefined ? null : discoverySourceRowSchema.parse(textDates(rows[0]));
    },

    async findDiscoverySourceByRequestId(requestId) {
      const rows = await run((session) =>
        session.query(`select ${DISCOVERY_SOURCE_COLUMNS} from public.discovery_sources where request_id = $1::uuid`, [requestId]),
      );
      return rows[0] === undefined ? null : discoverySourceRowSchema.parse(textDates(rows[0]));
    },

    async insertDiscoverySource(input) {
      const rows = await insertInto((session) =>
        session.query(
          `insert into public.discovery_sources (kind, title, origin, content, content_kind, position, request_id)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid) returning ${DISCOVERY_SOURCE_COLUMNS}`,
          [input.kind, input.title, input.origin, input.content, input.contentKind, JSON.stringify(input.position), input.requestId],
        ),
      );
      return rows === 'duplicate' ? 'duplicate' : discoverySourceRowSchema.parse(textDates(rows[0]));
    },

    async updateDiscoverySource(id, patch) {
      const rows = await run((session) =>
        session.query(
          `update public.discovery_sources
              set title = case when $2::boolean then $3 else title end
            where id = $1::uuid
            returning ${DISCOVERY_SOURCE_COLUMNS}`,
          [id, patch.title !== undefined, patch.title ?? null],
        ),
      );
      return rows[0] === undefined ? null : discoverySourceRowSchema.parse(textDates(rows[0]));
    },

    async updateDiscoveryPosition(id, position) {
      const rows = await run((session) =>
        session.query(
          `update public.discovery_sources set position = $2::jsonb where id = $1::uuid returning ${DISCOVERY_SOURCE_COLUMNS}`,
          [id, JSON.stringify(position)],
        ),
      );
      return rows[0] === undefined ? null : discoverySourceRowSchema.parse(textDates(rows[0]));
    },

    async bumpDiscoverySource(id) {
      // The same call the hosted gateway makes: one statement, one transaction.
      // A source the caller cannot reach updates nothing, and the function
      // still answers with one row of nulls — read as "nothing moved".
      const rows = await run((session) =>
        session.query<{ moved: unknown }>('select to_jsonb(m) as moved from public.bump_discovery_source_revision($1::uuid) m', [id]),
      );
      const parsed = discoverySourceRowSchema.safeParse(textDates(rows[0]?.moved));
      return parsed.success ? parsed.data : null;
    },

    async deleteDiscoverySource(id) {
      const rows = await run((session) =>
        session.query('delete from public.discovery_sources where id = $1::uuid returning id', [id]),
      );
      return rows.length > 0;
    },

    async listDiscoveryMarks(sourceId) {
      const rows = await run((session) =>
        sourceId === undefined
          ? session.query(`select ${DISCOVERY_MARK_COLUMNS} from public.discovery_marks order by created_at, id`)
          : session.query(`select ${DISCOVERY_MARK_COLUMNS} from public.discovery_marks where source_id = $1::uuid order by created_at, id`, [
              sourceId,
            ]),
      );
      return z.array(discoveryMarkRowSchema).parse(rows.map(textDates));
    },

    async getDiscoveryMark(id) {
      const rows = await run((session) =>
        session.query(`select ${DISCOVERY_MARK_COLUMNS} from public.discovery_marks where id = $1::uuid`, [id]),
      );
      return rows[0] === undefined ? null : discoveryMarkRowSchema.parse(textDates(rows[0]));
    },

    async insertDiscoveryMark(input) {
      const rows = await insertInto((session) =>
        session.query(
          `insert into public.discovery_marks
             (source_id, label, context, char_offset, cue_start, cue_end, note, vocabulary_id, saved_at, request_id)
           values ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9::timestamptz, $10::uuid)
           returning ${DISCOVERY_MARK_COLUMNS}`,
          [
            input.sourceId,
            input.label,
            input.context,
            input.offset,
            input.cueStart,
            input.cueEnd,
            input.note,
            input.vocabularyId,
            input.savedAt,
            input.requestId,
          ],
        ),
      );
      return rows === 'duplicate' ? 'duplicate' : discoveryMarkRowSchema.parse(textDates(rows[0]));
    },

    async findDiscoveryMarkByRequestId(requestId) {
      const rows = await run((session) =>
        session.query(`select ${DISCOVERY_MARK_COLUMNS} from public.discovery_marks where request_id = $1::uuid`, [requestId]),
      );
      return rows[0] === undefined ? null : discoveryMarkRowSchema.parse(textDates(rows[0]));
    },

    async findDiscoveryMarkByLabel(sourceId, label) {
      const rows = await run((session) =>
        session.query(`select ${DISCOVERY_MARK_COLUMNS} from public.discovery_marks where source_id = $1::uuid and label = $2`, [
          sourceId,
          label,
        ]),
      );
      return rows[0] === undefined ? null : discoveryMarkRowSchema.parse(textDates(rows[0]));
    },

    async findDiscoveryMarkByVocabulary(vocabularyId) {
      const rows = await run((session) =>
        session.query(
          `select ${DISCOVERY_MARK_COLUMNS} from public.discovery_marks where vocabulary_id = $1::uuid
           order by created_at desc, id desc limit 1`,
          [vocabularyId],
        ),
      );
      return rows[0] === undefined ? null : discoveryMarkRowSchema.parse(textDates(rows[0]));
    },

    async patchDiscoveryMark(id, patch) {
      const rows = await run((session) =>
        session.query(
          `update public.discovery_marks
              set note = case when $2::boolean then $3 else note end,
                  vocabulary_id = case when $4::boolean then $5::uuid else vocabulary_id end,
                  saved_at = case when $6::boolean then $7::timestamptz else saved_at end
            where id = $1::uuid
            returning ${DISCOVERY_MARK_COLUMNS}`,
          [
            id,
            patch.note !== undefined,
            patch.note ?? null,
            patch.vocabularyId !== undefined,
            patch.vocabularyId ?? null,
            patch.savedAt !== undefined,
            patch.savedAt ?? null,
          ],
        ),
      );
      return rows[0] === undefined ? null : discoveryMarkRowSchema.parse(textDates(rows[0]));
    },

    async deleteDiscoveryMark(id) {
      const rows = await run((session) => session.query('delete from public.discovery_marks where id = $1::uuid returning id', [id]));
      return rows.length > 0;
    },
  };

  return database;
}
