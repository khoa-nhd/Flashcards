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
  EXAMPLE_COLUMNS,
  FOREIGN_KEY_VIOLATION,
  LATEST_SCHEMA_VERSION,
  RELATION_COLUMNS,
  UNIQUE_VIOLATION,
  collectionItemRowSchema,
  collectionRowSchema,
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
  sessionSummaryRowSchema,
  settingsColumns,
  settingsFromRow,
  toDatabaseError,
  undoResultSchema,
  type CardRow,
  type SettingsRow,
  type VocabularyDatabase,
} from '../../server/supabase/supabase-database.js';
import { isSchedulerId } from '../../shared/scheduler/active.js';
import type { Row, Session, TestDatabase } from './test-database.js';

/** Rows are read as JSON, which gives dates and timestamps the same text form the hosted API returns. */
const cardsQuery = (columns: string, where: string, order: string) =>
  `select to_jsonb(c) as card from (select ${columns} from public.vocabulary_cards where ${where} order by ${order}) c`;

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
      const rows = await run((session) =>
        session.query<{ id: string; created: boolean }>(
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

    async listCorrectPracticeModes(vocabularyId) {
      const rows = await run((session) =>
        session.query<{ review_mode: string }>(
          `select review_mode from public.review_logs
            where vocabulary_id = $1::uuid and kind = 'practice' and answer_correct
            order by id`,
          [vocabularyId],
        ),
      );
      return rows.map((row) => row.review_mode);
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
  };

  return database;
}
