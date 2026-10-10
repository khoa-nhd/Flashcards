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
  CARD_COLUMNS,
  DatabaseError,
  cardRowSchema,
  reviewWriteResultSchema,
  toDatabaseError,
  type CardRow,
  type VocabularyDatabase,
} from '../../server/supabase/supabase-database.js';
import type { Row, Session, TestDatabase } from './test-database.js';

/** Rows are read as JSON, which gives dates and timestamps the same text form the hosted API returns. */
const cardsQuery = (where: string, order: string) =>
  `select to_jsonb(c) as card from (select ${CARD_COLUMNS} from public.vocabulary_cards where ${where} order by ${order}) c`;

export function createPgVocabularyDatabase(db: TestDatabase, userId: string): VocabularyDatabase {
  const run = async <T>(work: (session: Session) => Promise<T>): Promise<T> => {
    try {
      return await db.as(userId, work);
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw toDatabaseError({ code: (error as { code?: string }).code });
    }
  };

  const cards = async (where: string, order: string, params: unknown[] = []): Promise<CardRow[]> => {
    const rows = await run((session) => session.query<{ card: unknown }>(cardsQuery(where, order), params));
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
