/**
 * Old application code against the newest schema — executed, not reasoned
 * about. Every call here is the shape version 12's code made: the
 * twelve-argument create_vocabulary, update_vocabulary's text patch, the
 * trash through the vocabulary table itself, and every read through the
 * vocabulary_cards view with exactly the columns that version selected. The
 * database underneath is the newest migration, including the sense
 * operations and the legacy-column synchronisation of version 14.
 *
 * What cannot be reproduced locally is the PostgREST gateway in front of
 * these functions; the SQL boundary is where this project's compatibility
 * claims are tested.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cardColumns } from '../../server/supabase/supabase-database.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: string;
let bob: string;
let counter = 0;

const requestId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  alice = await db.createUser('alice@example.com');
  bob = await db.createUser('bob@example.com');
});

/** The exact twelve-positional-argument call version 12's gateway made. */
const createWordVersion12 = (
  user: string,
  word: string,
  content: { meaning?: string | null; definition?: string | null; example?: string | null },
  options: { request?: string } = {},
) =>
  db.as(user, (session) =>
    session.query<{ id: string; created: boolean }>(
      `select * from public.create_vocabulary(
         $1::text, $2::text, $3::smallint, $4::text, $5::text, $6::text,
         $7::date, $8::date, $9::uuid, $10::text, $11::text, $12::timestamptz)`,
      [
        word,
        word,
        3,
        content.meaning ?? null,
        content.definition ?? null,
        content.example ?? null,
        '2026-01-05',
        null,
        options.request ?? requestId(),
        null,
        null,
        '2026-01-05T10:00:00Z',
      ],
    ),
  );

/** The view read version 12 made: the columns of that version, nothing more. */
const readViewVersion12 = (user: string, id: string) =>
  db.as(user, (session) =>
    session.query<Record<string, unknown>>(`select ${cardColumns(12)} from public.vocabulary_cards where id = $1`, [id]),
  );

/** The live list, selected the way version 12 selected it: by the trash column on the same view. */
const readLiveViewVersion12 = (user: string, id: string) =>
  db.as(user, (session) =>
    session.query<Record<string, unknown>>(
      `select ${cardColumns(12)} from public.vocabulary_cards where id = $1 and deleted_at is null`,
      [id],
    ),
  );

/** The trashed list, the other half of that same split. */
const readTrashedViewVersion12 = (user: string, id: string) =>
  db.as(user, (session) =>
    session.query<Record<string, unknown>>(
      `select ${cardColumns(12)} from public.vocabulary_cards where id = $1 and deleted_at is not null`,
      [id],
    ),
  );

describe('version 12 code on the newest schema', () => {
  it('creates a word with the twelve-argument call, and the view shows it', async () => {
    const created = await createWordVersion12(alice, 'candid', { meaning: 'thẳng thắn', definition: 'honest' });
    expect(created[0]).toMatchObject({ created: true });

    const read = await readViewVersion12(alice, created[0]!.id);
    expect(read[0]).toMatchObject({
      word: 'candid',
      word_key: 'candid',
      meaning: 'thẳng thắn',
      definition: 'honest',
      example: null,
      mastery: 3,
      root_id: null,
    });
    // The columns version 12 knew exist; the ones it did not know are simply
    // not asked for, and their absence changes nothing.
    expect(Object.keys(read[0]!)).not.toContain('senses');
  });

  it('answers a repeated submission id with the word that landed, as version 12 relied on', async () => {
    const request = requestId();
    const first = await createWordVersion12(alice, 'lucid', { meaning: 'sáng suốt' }, { request });
    const again = await createWordVersion12(alice, 'lucid', { meaning: 'a different body under the same id' }, { request });
    expect(again[0]).toEqual({ id: first[0]!.id, created: false });
  });

  it('edits content through update_vocabulary, and every reader agrees afterwards', async () => {
    const word = (await createWordVersion12(alice, 'candid', { meaning: 'thẳng thắn' }))[0]!.id;
    const patched = await db.as(alice, (session) =>
      session.query('select public.update_vocabulary($1::uuid, $2::jsonb) as updated', [
        word,
        JSON.stringify({ meaning: 'gan dạ', example: 'a candid remark' }),
      ]),
    );
    expect(patched[0]).toEqual({ updated: true });

    // The old reader through the view...
    const read = await readViewVersion12(alice, word);
    expect(read[0]).toMatchObject({ meaning: 'gan dạ', example: 'a candid remark' });
    // ...the base table, and the sense that carries the content, all the same.
    const legacy = await db.admin<{ meaning: string | null; example: string | null }>(
      'select meaning, example from public.vocabulary where id = $1',
      [word],
    );
    expect(legacy[0]).toMatchObject({ meaning: 'gan dạ', example: 'a candid remark' });
    const sense = await db.admin<{ meaning: string | null }>(
      `select meaning from public.vocabulary_senses where vocabulary_id = $1 and archived_at is null order by position limit 1`,
      [word],
    );
    expect(sense[0]!.meaning).toBe('gan dạ');
  });

  it('trashes and restores through the vocabulary table itself, senses intact', async () => {
    const word = (await createWordVersion12(alice, 'bank', { meaning: 'ngân hàng' }))[0]!.id;
    await db.as(alice, (session) => session.query('update public.vocabulary set deleted_at = now() where id = $1', [word]));

    // Version 12 kept its two lists on the one view, split by that column:
    // the word left the live list and stayed on the trashed one.
    expect(await readLiveViewVersion12(alice, word)).toHaveLength(0);
    expect(await readTrashedViewVersion12(alice, word)).toHaveLength(1);
    // The sense is not lost while the word waits in the trash.
    const whileTrashed = await db.admin<{ n: number }>('select count(*)::int as n from public.vocabulary_senses where vocabulary_id = $1', [word]);
    expect(whileTrashed[0]!.n).toBe(1);

    await db.as(alice, (session) => session.query('update public.vocabulary set deleted_at = null where id = $1', [word]));
    const restored = await readLiveViewVersion12(alice, word);
    expect(restored[0]).toMatchObject({ meaning: 'ngân hàng', deleted_at: null });
    expect(await readTrashedViewVersion12(alice, word)).toHaveLength(0);
  });

  it('sees a word whose senses were rearranged by the newer endpoints the same way the new code does', async () => {
    const word = (await createWordVersion12(alice, 'light', { meaning: 'ánh sáng' }))[0]!.id;
    // What a sense endpoint does, written straight to the table: a second
    // sense arrives, the first is archived, and the shown meaning follows.
    await db.admin(
      `insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning)
       values ($1, $2, 1, 'nhẹ nhàng')`,
      [alice, word],
    );
    await db.admin(
      'update public.vocabulary_senses set archived_at = now(), version = version + 1 where vocabulary_id = $1 and position = 0',
      [word],
    );

    const read = await readViewVersion12(alice, word);
    expect(read[0]).toMatchObject({ meaning: 'nhẹ nhàng', definition: null });
    // The base table answers the same, so a reader of either path agrees.
    const legacy = await db.admin<{ meaning: string | null }>('select meaning from public.vocabulary where id = $1', [word]);
    expect(legacy[0]!.meaning).toBe('nhẹ nhàng');
  });

  it('keeps one account out of another’s rows through the view, as it always has', async () => {
    const word = (await createWordVersion12(alice, 'mine', { meaning: 'của tôi' }))[0]!.id;
    expect(await readViewVersion12(bob, word)).toHaveLength(0);
    const touched = await db.admin<{ n: number }>('select count(*)::int as n from public.vocabulary_senses where vocabulary_id = $1', [word]);
    expect(touched[0]!.n).toBe(1);
  });
});
