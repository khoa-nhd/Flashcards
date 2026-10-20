/**
 * G4 — failure and recovery: what a failed statement leaves behind, and what
 * a retried import does. Faults are injected as triggers on the tables the
 * calls write, so the failure lands in the middle of a real operation rather
 * than around it. Every test asserts the state a user would find afterwards:
 * nothing half-written, no doubled senses, no review history disturbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createReleaseDatabase, type ReleaseDatabase } from '../helpers/pg-release-database.js';

let db: ReleaseDatabase;
let alice: string;

beforeAll(async () => {
  db = await createReleaseDatabase('rel012_recovery');
  alice = await db.createUser('alice@recovery.test');
});

afterAll(async () => {
  await db.drop();
});

/** The injected fault: a trigger that raises, wherever a test hangs it. */
const poison = async () =>
  db.admin(
    `create or replace function public.rel012_poison() returns trigger language plpgsql as
     $$ begin raise exception 'injected failure' using errcode = 'P0001'; end $$`,
  );

const failOn = async (table: string, when: string) => {
  await poison();
  await db.admin(`create trigger rel012_fail ${when} on public.${table} for each row execute function public.rel012_poison()`);
};

afterEach(async () => {
  for (const table of ['vocabulary_senses', 'vocabulary', 'card_states']) {
    await db.admin(`drop trigger if exists rel012_fail on public.${table}`);
  }
  await db.admin('drop function if exists public.rel012_poison');
});

/** Seeds a word with the given live senses, as the arranging owner. */
const seedWord = async (word: string, senses: string[]) => {
  const [row] = await db.admin<{ id: string }>(
    `insert into public.vocabulary (user_id, word, word_key) values ($1, $2, $2) returning id`,
    [alice, word],
  );
  for (const [position, meaning] of senses.entries()) {
    await db.admin(
      `insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id)
       values ($1, $2, $3, $4, 1, gen_random_uuid())`,
      [alice, row!.id, position, meaning],
    );
  }
  await db.admin('update public.vocabulary set senses_version = 1 where id = $1', [row!.id]);
  return row!.id;
};

const senseRows = (word: string) =>
  db.admin<{ id: string; position: number; meaning: string | null; version: number; archived_at: string | null; request_id: string }>(
    `select id, position, meaning, version, archived_at, request_id from public.vocabulary_senses where vocabulary_id = $1 order by position`,
    [word],
  );

const settlesAs = async <T>(promise: Promise<T>): Promise<{ rows: T } | { code: string }> =>
  promise.then(
    (rows) => ({ rows }),
    (error) => ({ code: (error as { code?: string }).code ?? 'no-code' }),
  );

describe('a failed statement leaves nothing behind', () => {
  it('gives back every position and the version when a reorder dies mid-flight', async () => {
    const word = await seedWord('reorder-fails', ['đầu', 'giữa', 'cuối']);
    const before = await senseRows(word);
    const ids = await db.admin<{ id: string }>(
      'select id from public.vocabulary_senses where vocabulary_id = $1 order by position',
      [word],
    );

    await failOn('vocabulary_senses', 'after update of position');
    const outcome = await settlesAs(
      db.as(alice, (s) =>
        s.query(`select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)`, [word, JSON.stringify([ids[2]!.id, ids[1]!.id, ids[0]!.id]), 1]),
      ),
    );
    expect(outcome).toEqual({ code: 'P0001' });

    expect(await senseRows(word)).toEqual(before);
    const [row] = await db.admin<{ senses_version: number }>('select senses_version from public.vocabulary where id = $1', [word]);
    expect(row!.senses_version).toBe(1);
  });

  it('leaves the word and its first sense agreeing when a legacy edit dies', async () => {
    const word = await seedWord('legacy-fails', ['nghĩa gốc']);

    // The legacy call patches the word's columns and the first live sense in
    // one transaction; the fault lands on the sense's half of it.
    await failOn('vocabulary_senses', 'before update of meaning');
    const outcome = await settlesAs(
      db.as(alice, (s) => s.query(`select public.update_vocabulary($1::uuid, $2::jsonb)`, [word, JSON.stringify({ meaning: 'nửa vời' })])),
    );
    expect(outcome).toEqual({ code: 'P0001' });

    const [row] = await db.admin<{ meaning: string | null }>('select meaning from public.vocabulary where id = $1', [word]);
    expect(row!.meaning).toBe('nghĩa gốc');
    expect((await senseRows(word))[0]!.meaning).toBe('nghĩa gốc');
  });

  it('leaves no word at all when an initial import dies among its senses', async () => {
    const request = crypto.randomUUID();
    const senses = JSON.stringify([
      { meaning: 'nghĩa một', definition: 'định nghĩa một', example: null },
      { meaning: 'nghĩa hai', definition: null, example: null },
    ]);

    await failOn('vocabulary_senses', 'after insert');
    const outcome = await settlesAs(
      db.as(alice, (s) =>
        s.query(
          `select id, created from public.create_vocabulary_with_senses(
             $1::text, $1::text, 3::smallint, null::text, null::text, null::text,
             current_date, null::date, $2::uuid, null::text, null::text, null::timestamptz, $3::jsonb)`,
          ['imported', request, senses],
        ),
      ),
    );
    expect(outcome).toEqual({ code: 'P0001' });

    // Not the word, not a single sense: the call was one statement, and it
    // failed as one.
    expect(await db.admin('select 1 from public.vocabulary where request_id = $1', [request])).toHaveLength(0);
    expect(await db.admin(`select 1 from public.vocabulary where word_key = 'imported'`)).toHaveLength(0);
    expect(await db.admin(`select 1 from public.vocabulary_senses where meaning in ('nghĩa một', 'nghĩa hai')`)).toHaveLength(0);
  });

  it('keeps the review history whole when a sense call fails over it', async () => {
    const word = await seedWord('history-kept', ['đã học']);
    await db.as(alice, (s) =>
      s.query(
        `insert into public.card_states (user_id, vocabulary_id, mastery, review_date) values ($1, $2, 4, current_date + 1)`,
        [alice, word],
      ),
    );
    await db.as(alice, (s) =>
      s.query(
        `insert into public.review_logs (user_id, vocabulary_id, action, request_id, reviewed_on, mastery_before, mastery_after)
         values ($1, $2, 'remember', $3, current_date, 3, 4)`,
        [alice, word, crypto.randomUUID()],
      ),
    );

    await failOn('vocabulary_senses', 'before insert');
    const outcome = await settlesAs(
      db.as(alice, (s) => s.query(`select public.add_vocabulary_sense($1::uuid, 'nghĩa mới', null, null, $2::uuid)`, [word, crypto.randomUUID()])),
    );
    expect(outcome).toEqual({ code: 'P0001' });

    const [card] = await db.admin<{ mastery: number }>('select mastery from public.card_states where vocabulary_id = $1', [word]);
    expect(card!.mastery).toBe(4);
    const logs = await db.admin<{ mastery_after: number }>('select mastery_after from public.review_logs where vocabulary_id = $1', [word]);
    expect(logs).toEqual([{ mastery_after: 4 }]);
    expect(await senseRows(word)).toHaveLength(1);
  });

  it('leaves the readers agreeing with the senses after a failed write', async () => {
    const word = await seedWord('projection-kept', ['nguyên bản']);

    await failOn('vocabulary_senses', 'before update');
    await settlesAs(
      db.as(alice, (s) => s.query(`select public.update_vocabulary($1::uuid, $2::jsonb)`, [word, JSON.stringify({ meaning: 'bị ngắt' })])),
    );
    await settlesAs(
      db.as(alice, (s) => s.query(`select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)`, [word, JSON.stringify([]), 1])),
    );

    const [row] = await db.admin<{ meaning: string | null; sense: string | null }>(
      `select v.meaning, (select meaning from public.vocabulary_senses where vocabulary_id = v.id and archived_at is null order by position limit 1) as sense
         from public.vocabulary v where v.id = $1`,
      [word],
    );
    expect(row).toMatchObject({ meaning: 'nguyên bản', sense: 'nguyên bản' });
  });
});

describe('an interrupted import', () => {
  it('finishes on the retry, and the second retry changes nothing', async () => {
    const request = crypto.randomUUID();
    // The documented intermediate state: the word landed, the senses did not
    // — the client died between the two calls of the import.
    const [word] = await db.as(alice, (s) =>
      s.query<{ id: string; created: boolean }>(
        `select * from public.create_vocabulary(
           $1::text, $1::text, 3::smallint, null::text, null::text, null::text,
           current_date, null::date, $2::uuid, null::text, null::text, null::timestamptz)`,
        ['partial', request],
      ),
    );
    expect(await senseRows(word!.id)).toHaveLength(0);

    // The retry completes it, row by row, each under its own request id.
    const rowRequests = [crypto.randomUUID(), crypto.randomUUID()];
    const bodies = ['nghĩa một', 'nghĩa hai'];
    for (const [index, rowRequest] of rowRequests.entries()) {
      const done = await db.as(alice, (s) =>
        s.query<{ id: string; created: boolean }>(
          `select id, created from public.resume_vocabulary_sense($1::uuid, $2, null, null, $3::uuid)`,
          [word!.id, bodies[index], rowRequest],
        ),
      );
      expect(done[0]!.created).toBe(true);
    }
    const complete = await senseRows(word!.id);
    expect(complete.map((r) => r.meaning)).toEqual(bodies);

    // The whole file arrives again: every row lands on the sense it already
    // made, and no sense doubles.
    for (const [index, rowRequest] of rowRequests.entries()) {
      const again = await db.as(alice, (s) =>
        s.query<{ id: string; created: boolean }>(
          `select id, created from public.resume_vocabulary_sense($1::uuid, $2, null, null, $3::uuid)`,
          [word!.id, bodies[index], rowRequest],
        ),
      );
      expect(again[0]!.created).toBe(false);
    }
    const unchanged = await senseRows(word!.id);
    expect(unchanged.map((r) => r.meaning)).toEqual(bodies);
  });

  it('does not overwrite what the user changed since', async () => {
    const word = await seedWord('edited-since', ['một']);
    const [sense] = await senseRows(word);

    // The user edits the imported sense; the file arrives again unchanged.
    await db.as(alice, (s) =>
      s.query(`select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)`, [sense!.id, sense!.version, JSON.stringify({ meaning: 'của người dùng' })]),
    );
    const retry = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(
        `select created from public.resume_vocabulary_sense($1::uuid, 'từ tệp', null, null, $2::uuid)`,
        [word, sense!.request_id],
      ),
    );
    expect(retry[0]!.created).toBe(false);
    expect((await senseRows(word))[0]!.meaning).toBe('của người dùng');
  });

  it('still completes after the word was thrown away, and never brings it back', async () => {
    const word = await seedWord('trashed-retry', ['trước']);
    const [sense] = await senseRows(word);
    await db.as(alice, (s) => s.query('update public.vocabulary set deleted_at = now() where id = $1', [word]));

    // The retry reaches its own sense under the recovery call, and honours
    // the archived flag the file carried — the two things it may do.
    const archived = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(
        `select created from public.resume_vocabulary_sense($1::uuid, 'trước', null, null, $2::uuid, true)`,
        [word, sense!.request_id],
      ),
    );
    expect(archived[0]!.created).toBe(false);
    const [filed] = await senseRows(word);
    expect(filed!.archived_at).not.toBeNull();

    // A row the file had not reached yet is still created on the trashed
    // word — that is the point of the call — and the word stays trashed.
    const created = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(
        `select created from public.resume_vocabulary_sense($1::uuid, 'sau', null, null, $2::uuid)`,
        [word, crypto.randomUUID()],
      ),
    );
    expect(created[0]!.created).toBe(true);

    const rows = await senseRows(word);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.archived_at === null)).toHaveLength(1);
    const [row] = await db.admin<{ deleted_at: string | null }>('select deleted_at from public.vocabulary where id = $1', [word]);
    expect(row!.deleted_at).not.toBeNull();
  });
});
