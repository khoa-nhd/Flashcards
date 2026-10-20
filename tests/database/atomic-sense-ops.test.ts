/**
 * The sense operations as the database performs them: one statement, one
 * transaction, with the version, ownership and soft-delete checks inside it —
 * plus the legacy meaning/definition/example columns staying in step with the
 * senses that are the content, and an import row's word and its senses
 * landing together or not at all.
 *
 * Scope, stated by the tests themselves: this is one PostgreSQL (PGlite, in
 * this process) with the migrations applied. Every claim here is about a
 * single statement's atomicity and the checks inside it, never about two
 * connections committing at the same instant. Cross-instance simultaneity is
 * not proven by this file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const RLS_DENIED = '42501';
const CHECK_VIOLATION = '23514';
const STALE = 'P0003';
const NOT_FOUND = 'P0002';
const NOT_THE_ORDER = '22023';
const INJECTED = 'XX000';

let db: TestDatabase;
let alice: string;
let bob: string;
let counter = 0;

/** A fresh, valid request id for each call. */
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

/** A word with content, created as its owner through the real function. */
async function createWord(
  user: string,
  word: string,
  content: { meaning?: string | null; definition?: string | null; example?: string | null } = {},
): Promise<string> {
  const rows = await db.as(user, (session) =>
    session.query<{ id: string }>(
      `select id from public.create_vocabulary(
         p_word => $1, p_word_key => lower($1), p_mastery => 3::smallint,
         p_meaning => $2, p_definition => $3, p_example => $4, p_request_id => $5::uuid)`,
      [word, content.meaning ?? null, content.definition ?? null, content.example ?? null, requestId()],
    ),
  );
  return rows[0]!.id;
}

type SenseRow = {
  id: string;
  position: number;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  archived: boolean;
  version: number;
};

const sensesOf = (wordId: string) =>
  db.admin<SenseRow>(
    `select id, position, meaning, definition, example, archived_at is not null as archived, version
       from public.vocabulary_senses where vocabulary_id = $1 order by position`,
    [wordId],
  );

const positionsOf = async (wordId: string) =>
  (await db.admin<{ id: string; position: number }>(
    'select id, position from public.vocabulary_senses where vocabulary_id = $1 order by position',
    [wordId],
  )).map((row) => `${row.id}@${row.position}`);

type Content = {
  meaning: string | null;
  definition: string | null;
  example: string | null;
};

const legacyColumns = async (wordId: string): Promise<Content> => {
  const rows = await db.admin<Content>('select meaning, definition, example from public.vocabulary where id = $1', [wordId]);
  return rows[0]!;
};

const viewRow = async (wordId: string): Promise<Content> => {
  const rows = await db.admin<Content>('select meaning, definition, example from public.vocabulary_cards where id = $1', [wordId]);
  return rows[0]!;
};

const sensesVersion = async (wordId: string) =>
  (await db.admin<{ senses_version: number }>('select senses_version from public.vocabulary where id = $1', [wordId]))[0]!.senses_version;

const masteryOf = async (wordId: string) =>
  (await db.admin<{ mastery: number }>('select mastery from public.card_states where vocabulary_id = $1', [wordId]))[0]!.mastery;

const countOf = async (table: string, wordId?: string) =>
  Number(
    (
      await db.admin<{ n: number }>(
        wordId === undefined
          ? `select count(*)::int as n from public.${table}`
          : `select count(*)::int as n from public.${table} where vocabulary_id = $1`,
        wordId === undefined ? [] : [wordId],
      )
    )[0]!.n,
  );

/** Insert senses straight into the table, as the version 13 backfill did: arranging only. */
async function seedSenses(
  user: string,
  wordId: string,
  entries: Array<{ meaning?: string | null; definition?: string | null; example?: string | null }>,
  from = 0,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, sense] of entries.entries()) {
    const rows = await db.admin<{ id: string }>(
      `insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, definition, example)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [user, wordId, from + index, sense.meaning ?? null, sense.definition ?? null, sense.example ?? null],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

const archiveRow = (wordId: string, position: number) =>
  db.admin(`update public.vocabulary_senses set archived_at = now(), version = version + 1
             where vocabulary_id = $1 and position = $2`, [wordId, position]);

const restoreRow = (wordId: string, position: number, toPosition: number) =>
  db.admin(`update public.vocabulary_senses set archived_at = null, position = $3, version = version + 1
             where vocabulary_id = $1 and position = $2 and archived_at is not null`, [wordId, position, toPosition]);

/** Swap two senses' positions, the way a hand-written tool would: lift, then place. */
async function swapRows(wordId: string, leftPosition: number, rightPosition: number): Promise<void> {
  await db.admin(
    'update public.vocabulary_senses set position = position + 500 where vocabulary_id = $1 and position in ($2, $3)',
    [wordId, leftPosition, rightPosition],
  );
  await db.admin(
    'update public.vocabulary_senses set position = $2 where vocabulary_id = $1 and position = $3 + 500',
    [wordId, leftPosition, rightPosition],
  );
  await db.admin(
    'update public.vocabulary_senses set position = $3 where vocabulary_id = $1 and position = $2 + 500',
    [wordId, leftPosition, rightPosition],
  );
}

const reorder = (user: string, wordId: string, senseIds: readonly (string | null)[], version: number) =>
  db.as(user, (session) =>
    session.query('select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)', [
      wordId,
      JSON.stringify(senseIds),
      version,
    ]),
  );

const addSenseCall = (
  user: string,
  wordId: string,
  sense: { meaning?: string | null; definition?: string | null; example?: string | null; request?: string | null },
) =>
  db.as(user, (session) =>
    session.query<{ id: string; created: boolean }>(
      `select * from public.add_vocabulary_sense($1::uuid, $2::text, $3::text, $4::text, $5::uuid)`,
      [wordId, sense.meaning ?? null, sense.definition ?? null, sense.example ?? null, sense.request ?? requestId()],
    ),
  );

const restoreSenseCall = (user: string, senseId: string, version: number) =>
  db.as(user, (session) => session.query('select public.restore_vocabulary_sense($1::uuid, $2::int)', [senseId, version]));

/** From schema version 15: the sense edit that ran as a bare table update before it. */
const updateSenseCall = (
  user: string,
  senseId: string,
  version: number,
  changes: { meaning?: string | null; definition?: string | null; example?: string | null },
) =>
  db.as(user, (session) =>
    session.query('select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)', [
      senseId,
      version,
      JSON.stringify(changes),
    ]),
  );

/** From schema version 15: the archive that ran as a bare table update before it. */
const archiveSenseCall = (user: string, senseId: string, version: number) =>
  db.as(user, (session) => session.query('select public.archive_vocabulary_sense($1::uuid, $2::int)', [senseId, version]));

/**
 * From schema version 15: the import's completion call — the one path
 * allowed to write senses on a word in the trash.
 */
const resumeCall = (
  user: string,
  wordId: string,
  sense: {
    meaning?: string | null;
    definition?: string | null;
    example?: string | null;
    request?: string | null;
    archived?: boolean;
  },
) =>
  db.as(user, (session) =>
    session.query<{ id: string; created: boolean }>(
      'select * from public.resume_vocabulary_sense($1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::boolean)',
      [
        wordId,
        sense.meaning ?? null,
        sense.definition ?? null,
        sense.example ?? null,
        sense.request ?? requestId(),
        sense.archived === true,
      ],
    ),
  );

const createWithSenses = (
  user: string,
  word: string,
  fields: { meaning?: string | null; definition?: string | null; example?: string | null; request?: string | null },
  senses: Array<{ meaning?: string | null; definition?: string | null; example?: string | null; request?: string | null }>,
) =>
  db.as(user, (session) =>
    session.query<{ id: string; created: boolean }>(
      `select * from public.create_vocabulary_with_senses(
         p_word => $1, p_word_key => lower($1), p_mastery => 3::smallint,
         p_meaning => $2, p_definition => $3, p_example => $4, p_request_id => $5::uuid,
         p_senses => $6::jsonb)`,
      [
        word,
        fields.meaning ?? null,
        fields.definition ?? null,
        fields.example ?? null,
        fields.request ?? requestId(),
        JSON.stringify(
          senses.map((sense) => ({
            meaning: sense.meaning ?? null,
            definition: sense.definition ?? null,
            example: sense.example ?? null,
            request_id: sense.request ?? requestId(),
          })),
        ),
      ],
    ),
  );

describe('reorder_vocabulary_senses: one statement, or none of it', () => {
  it('moves the live senses into the order sent, packs the archived behind, and keeps identities', async () => {
    const word = await createWord(alice, 'bank');
    const seeded = await seedSenses(alice, word, [
      { meaning: 'ngân hàng' },
      { meaning: 'bờ sông' },
      { definition: 'To put money into an account.' },
    ]);
    const before = await sensesOf(word);
    expect(before).toHaveLength(3);
    const archived = before[2]!;
    await db.admin('update public.vocabulary_senses set archived_at = now(), version = version + 1 where id = $1', [archived.id]);
    const archivedVersion = archived.version + 1;
    const live = seeded.slice(0, 2);
    const version = await sensesVersion(word);
    const positionsBefore = await positionsOf(word);

    await reorder(alice, word, [live[1]!, live[0]!], version);

    const after = await sensesOf(word);
    expect(after.map((sense) => sense.id).sort()).toEqual(before.map((sense) => sense.id).sort());
    expect(after.map((sense) => ({ id: sense.id, position: sense.position }))).toEqual([
      { id: live[1], position: 0 },
      { id: live[0], position: 1 },
      { id: archived.id, position: 2 },
    ]);
    // The archived sense kept its content, its archive state and the version
    // its own archiving gave it: the reorder moved rows, it did not touch them.
    expect(after[2]).toMatchObject({ archived: true, meaning: archived.meaning, version: archivedVersion });
    expect(positionsBefore).not.toEqual(await positionsOf(word));
  });

  it('rolls every position back when one move inside it fails', async () => {
    const word = await createWord(alice, 'lie');
    await seedSenses(alice, word, [{ meaning: 'nói dối' }, { meaning: 'nằm' }]);
    const ids = (await sensesOf(word)).map((sense) => sense.id);
    const version = await sensesVersion(word);
    const before = await positionsOf(word);

    // An injected failure on the second placement: mid-function, after the
    // first moves have already run inside the statement.
    await db.admin(
      `create or replace function public.test_fail_reorder() returns trigger language plpgsql as $$
       begin
         raise exception 'injected: the reorder fails here' using errcode = '${INJECTED}';
       end $$`,
    );
    await db.admin(
      `create trigger test_fail_reorder before update of position on public.vocabulary_senses
         for each row when (new.position = 1) execute function public.test_fail_reorder()`,
    );
    try {
      await expect(reorder(alice, word, [ids[1]!, ids[0]!], version)).rejects.toMatchObject({ code: INJECTED });
      // Nothing moved: the shuffle that ran before the failure was undone with it.
      expect(await positionsOf(word)).toEqual(before);
    } finally {
      await db.admin('drop trigger test_fail_reorder on public.vocabulary_senses');
      await db.admin('drop function public.test_fail_reorder()');
    }

    // With the fault gone, the same reorder lands whole.
    await reorder(alice, word, [ids[1]!, ids[0]!], version);
    expect((await sensesOf(word)).map((sense) => sense.id)).toEqual([ids[1], ids[0]]);
  });

  it('refuses an order that omits a sense, repeats one, or names another word’s', async () => {
    const word = await createWord(alice, 'fast');
    const ids = await seedSenses(alice, word, [{ meaning: 'nhanh' }, { meaning: 'kiêng ăn' }]);
    const other = await createWord(alice, 'slow');
    const foreign = await seedSenses(alice, other, [{ meaning: 'chậm' }]);
    const version = await sensesVersion(word);
    const before = await positionsOf(word);

    for (const wrong of [[ids[0]!], [ids[0]!, ids[0]!], [ids[0]!, foreign[0]!], [ids[0]!, null]]) {
      await expect(reorder(alice, word, wrong, version), JSON.stringify(wrong)).rejects.toMatchObject({ code: NOT_THE_ORDER });
    }
    expect(await positionsOf(word)).toEqual(before);
  });

  it('refuses another account’s word, a word in the trash, and a caller who is not signed in', async () => {
    const mine = await createWord(alice, 'mine', { meaning: 'của tôi' });
    const ids = (await sensesOf(mine)).map((sense) => sense.id);
    const version = await sensesVersion(mine);

    await expect(reorder(bob, mine, [...ids].reverse(), version)).rejects.toMatchObject({ code: NOT_FOUND });

    await db.admin('update public.vocabulary set deleted_at = now() where id = $1', [mine]);
    await expect(reorder(alice, mine, [...ids].reverse(), version)).rejects.toMatchObject({ code: NOT_FOUND });
    expect((await sensesOf(mine)).map((sense) => sense.position)).toEqual([0]);

    await db.admin('update public.vocabulary set deleted_at = null where id = $1', [mine]);
    await expect(
      db.asAnon((session) =>
        session.query('select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)', [mine, JSON.stringify(ids), version]),
      ),
    ).rejects.toMatchObject({ code: RLS_DENIED });
    expect((await sensesOf(mine)).map((sense) => sense.position)).toEqual([0]);
  });

  it('refuses a reorder whose version is current but whose list missed a sense added in between', async () => {
    const word = await createWord(alice, 'run', { meaning: 'chạy' });
    const [original] = await seedSenses(alice, word, [{ meaning: 'chạy bộ' }], 1);
    const seenIds = (await sensesOf(word)).map((sense) => sense.id);
    const seenVersion = await sensesVersion(word);

    // The add lands between the client's read and its reorder.
    const added = await addSenseCall(alice, word, { meaning: 'chạy trốn', request: requestId() });
    expect(added[0]).toMatchObject({ created: true });

    // The old version: refused as stale. The current version with the old
    // list: refused because the list is no longer the word's senses.
    await expect(reorder(alice, word, [...seenIds].reverse(), seenVersion)).rejects.toMatchObject({ code: STALE });
    const currentVersion = await sensesVersion(word);
    await expect(reorder(alice, word, [...seenIds].reverse(), currentVersion)).rejects.toMatchObject({ code: NOT_THE_ORDER });
    expect((await sensesOf(word)).map((sense) => sense.id)).toContain(original!);
    expect((await sensesOf(word)).map((sense) => sense.position)).toEqual([0, 1, 2]);
  });
});

describe('add_vocabulary_sense: appended under the word’s claim', () => {
  it('lands past every sense, and a repeat of the request id lands on the same one', async () => {
    const word = await createWord(alice, 'sky', { meaning: 'bầu trời' });
    const request = requestId();
    const first = await addSenseCall(alice, word, { meaning: 'bầu trời trong xanh', request });
    expect(first[0]).toMatchObject({ created: true });

    const again = await addSenseCall(alice, word, { meaning: 'ignored on a repeat', request });
    expect(again[0]).toMatchObject({ created: false, id: first[0]!.id });

    // An archived sense keeps its slot; the next add still lands past everything.
    await archiveRow(word, 1);
    const third = await addSenseCall(alice, word, { definition: 'The expanse above.', request: requestId() });
    expect(third[0]).toMatchObject({ created: true });
    expect((await sensesOf(word)).map((sense) => sense.position)).toEqual([0, 1, 2]);
    expect((await sensesOf(word))[1]).toMatchObject({ archived: true });
  });

  it('refuses a caller who is not signed in and a word of another account', async () => {
    const mine = await createWord(alice, 'yours', { meaning: 'của bạn' });

    await expect(
      db.asAnon((session) =>
        session.query(`select * from public.add_vocabulary_sense($1::uuid, 'x', null, null, $2::uuid)`, [mine, requestId()]),
      ),
    ).rejects.toMatchObject({ code: RLS_DENIED });

    await expect(
      addSenseCall(bob, mine, { meaning: 'không được' }),
    ).rejects.toMatchObject({ code: NOT_FOUND });
    expect(await countOf('vocabulary_senses', mine)).toBe(1);
  });
});

describe('restore_vocabulary_sense: back at the end, under the claim', () => {
  it('brings a sense back past the others and refuses a version that has moved on', async () => {
    const word = await createWord(alice, 'cold');
    const ids = await seedSenses(alice, word, [{ meaning: 'lạnh' }, { meaning: 'cảm lạnh' }]);
    const middle = ids[1]!;
    const middleVersion = (await sensesOf(word))[1]!.version;
    await archiveRow(word, 1);

    await expect(restoreSenseCall(alice, middle, middleVersion)).rejects.toMatchObject({ code: STALE });

    const archivedVersion = (await sensesOf(word))[1]!.version;
    await restoreSenseCall(alice, middle, archivedVersion);
    const after = await sensesOf(word);
    expect(after.map((sense) => sense.id)).toEqual([ids[0]!, middle]);
    expect(after.map((sense) => sense.position)).toEqual([0, 2]);
    expect(after[1]).toMatchObject({ archived: false });
    // The shown meaning is still the first live sense.
    expect((await viewRow(word)).meaning).toBe('lạnh');
  });

  it('refuses a restore of another account’s sense', async () => {
    const mine = await createWord(alice, 'kept', { meaning: 'giữ' });
    const sense = (await sensesOf(mine))[0]!;
    await expect(restoreSenseCall(bob, sense.id, sense.version)).rejects.toMatchObject({ code: NOT_FOUND });
    expect((await sensesOf(mine))[0]).toMatchObject({ archived: false, position: 0 });
  });

  it('a restore that lands between reading and reordering is refused, not routed around', async () => {
    const word = await createWord(alice, 'two');
    const ids = await seedSenses(alice, word, [{ meaning: 'hai' }, { meaning: 'lại nữa' }]);
    await archiveRow(word, 1);
    const seenVersion = await sensesVersion(word);
    const liveBefore = (await sensesOf(word)).filter((sense) => !sense.archived).map((sense) => sense.id);
    expect(liveBefore).toEqual([ids[0]!]);

    // The restore lands between the reorder's read and its write.
    await restoreRow(word, 1, 2);
    const liveAfter = (await sensesOf(word)).filter((sense) => !sense.archived).map((sense) => sense.id);
    expect(liveAfter).toHaveLength(2);

    // With the version from before: stale. With the current version but the
    // old list: not the word's senses. Either way, refused whole.
    await expect(reorder(alice, word, liveBefore, seenVersion)).rejects.toMatchObject({ code: STALE });
    const currentVersion = await sensesVersion(word);
    await expect(reorder(alice, word, liveBefore, currentVersion)).rejects.toMatchObject({ code: NOT_THE_ORDER });
    expect((await sensesOf(word)).map((sense) => sense.id)).toEqual(ids);
    // The restored sense sits at the end of the order, where restore puts it.
    expect((await sensesOf(word)).map((sense) => sense.position)).toEqual([0, 2]);
  });
});

describe('the legacy columns follow the first live sense', () => {
  const expectAgreement = async (word: string, shown: string | null) => {
    const legacy = await legacyColumns(word);
    const view = await viewRow(word);
    expect(view.meaning).toBe(shown);
    expect(legacy).toEqual(view);
    expect(legacy.meaning).toBe(shown);
  };

  it('stays with the view after an archive, a restore, a reorder, a legacy edit and a sense edit', async () => {
    const word = await createWord(alice, 'bank', { meaning: 'ngân hàng', definition: 'A place that keeps money.' });
    await expectAgreement(word, 'ngân hàng');

    // A second sense, written straight to the senses table.
    await seedSenses(alice, word, [{ meaning: 'bờ sông', example: 'They sat on the bank.' }], 1);
    await expectAgreement(word, 'ngân hàng');

    // Archive the first: the projection must follow to the next live sense.
    await archiveRow(word, 0);
    await expectAgreement(word, 'bờ sông');

    // Restore it to the end: the second sense still shows, and the columns agree.
    await restoreRow(word, 0, 2);
    await expectAgreement(word, 'bờ sông');

    // Reorder so the restored sense shows first.
    await swapRows(word, 1, 2);
    await expectAgreement(word, 'ngân hàng');

    // A legacy whole-word edit writes both, in one statement, as it always has.
    const patched = await db.as(alice, (session) =>
      session.query('select public.update_vocabulary($1::uuid, $2::jsonb) as updated', [word, JSON.stringify({ meaning: 'tiền gửi' })]),
    );
    expect(patched[0]).toEqual({ updated: true });
    await expectAgreement(word, 'tiền gửi');
    // The write-through landed on the first live sense, which the swap put at position 1.
    expect((await sensesOf(word)).find((sense) => sense.position === 1)).toMatchObject({ meaning: 'tiền gửi' });

    // A sense edit through the senses table alone: the columns follow it too.
    await db.admin('update public.vocabulary_senses set meaning = $2, version = version + 1 where vocabulary_id = $1 and position = 1', [
      word,
      'tài khoản ngân hàng',
    ]);
    await expectAgreement(word, 'tài khoản ngân hàng');
  });

  it('agrees across every read path an older reader has: the base table, the view, the senses', async () => {
    const word = await createWord(alice, 'light', { meaning: 'ánh sáng' });
    await seedSenses(alice, word, [{ meaning: 'nhẹ nhàng' }], 1);
    await archiveRow(word, 0);
    // A plain reorder written straight to the table, as an older tool might.
    await db.admin('update public.vocabulary_senses set position = 2 where vocabulary_id = $1 and position = 1', [word]);

    const legacy = await legacyColumns(word);
    const view = await viewRow(word);
    const firstLive = (
      await db.admin<Content>(
        `select meaning, definition, example from public.vocabulary_senses
          where vocabulary_id = $1 and archived_at is null order by position limit 1`,
        [word],
      )
    )[0]!;
    expect(legacy).toEqual(view);
    expect(view).toEqual(firstLive);
    expect(view.meaning).toBe('nhẹ nhàng');
    // The word's own identity columns are untouched by any of this.
    const head = await db.admin<{ word: string; word_key: string }>('select word, word_key from public.vocabulary where id = $1', [word]);
    expect(head[0]).toEqual({ word: 'light', word_key: 'light' });
  });

  it('leaves a word whose senses are all archived showing nothing, columns and view alike', async () => {
    const word = await createWord(alice, 'gone', { meaning: 'đã mất' });
    await seedSenses(alice, word, [{ meaning: 'thứ hai' }], 1);
    await archiveRow(word, 0);
    await archiveRow(word, 1);
    expect(await viewRow(word)).toMatchObject({ meaning: null, definition: null, example: null });
    expect(await legacyColumns(word)).toMatchObject({ meaning: null, definition: null, example: null });
  });
});

describe('create_vocabulary_with_senses: a row lands together or not at all', () => {
  it('writes the word, its card state and every sense in one call', async () => {
    const senses = [
      { meaning: 'ngân hàng', request: requestId() },
      { meaning: 'bờ sông', request: requestId() },
      { definition: 'To put money into an account.', request: requestId() },
    ];
    const created = await createWithSenses(alice, 'bank', { request: requestId() }, senses);
    expect(created[0]).toMatchObject({ created: true });
    const word = created[0]!.id;

    expect(await countOf('card_states', word)).toBe(1);
    const stored = await sensesOf(word);
    expect(stored.map((sense) => ({ position: sense.position, meaning: sense.meaning, definition: sense.definition }))).toEqual([
      { position: 0, meaning: 'ngân hàng', definition: null },
      { position: 1, meaning: 'bờ sông', definition: null },
      { position: 2, meaning: null, definition: 'To put money into an account.' },
    ]);
    expect(stored.map((sense) => sense.version)).toEqual([1, 1, 1]);
    expect(await sensesVersion(word)).toBe(3);
    // The legacy columns show the first sense, as the view does.
    expect(await legacyColumns(word)).toMatchObject({ meaning: 'ngân hàng' });
    expect(await viewRow(word)).toMatchObject({ meaning: 'ngân hàng' });
  });

  it('leaves no word, no card state and no senses when one sense cannot be stored', async () => {
    const before = { words: await countOf('vocabulary'), cards: await countOf('card_states'), senses: await countOf('vocabulary_senses') };
    await expect(
      createWithSenses(alice, 'poison', { request: requestId() }, [
        { meaning: 'kept only if the whole row lands', request: requestId() },
        { meaning: 'x'.repeat(7000), request: requestId() },
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect({
      words: await countOf('vocabulary'),
      cards: await countOf('card_states'),
      senses: await countOf('vocabulary_senses'),
    }).toEqual(before);
    expect((await db.admin<{ word: string }>(`select word from public.vocabulary where word = 'poison'`)).length).toBe(0);
  });

  it('answers a repeated request id with the word that landed, and does not rewrite its senses', async () => {
    const request = requestId();
    const first = await createWithSenses(alice, 'twice', { request }, [{ meaning: 'lần đầu', request: requestId() }]);
    const word = first[0]!.id;

    const second = await createWithSenses(
      alice,
      'twice',
      { request },
      [{ meaning: 'a different payload under the same request id', request: requestId() }],
    );
    expect(second[0]).toEqual({ id: word, created: false });
    expect((await sensesOf(word)).map((sense) => sense.meaning)).toEqual(['lần đầu']);
  });

  it('treats senses as the content when the row carries both, and honours an empty list', async () => {
    const both = await createWithSenses(
      alice,
      'either',
      { meaning: 'legacy text beside the senses' },
      [{ meaning: 'from the senses' }],
    );
    const word = both[0]!.id;
    expect((await sensesOf(word)).map((sense) => sense.meaning)).toEqual(['from the senses']);
    expect(await legacyColumns(word)).toMatchObject({ meaning: 'from the senses' });
    expect(await viewRow(word)).toMatchObject({ meaning: 'from the senses' });

    const empty = await createWithSenses(alice, 'bare-content', { meaning: 'content alone' }, []);
    const emptyWord = empty[0]!.id;
    expect((await sensesOf(emptyWord)).map((sense) => sense.meaning)).toEqual(['content alone']);
    expect(await viewRow(emptyWord)).toMatchObject({ meaning: 'content alone' });
  });
});

describe('a word in the trash: every sense mutation refuses it, one call named excepted', () => {
  it('refuses an add and a restore on a trashed word, and takes them again once it is back', async () => {
    const word = await createWord(alice, 'bank', { meaning: 'ngân hàng' });
    const first = (await sensesOf(word))[0]!;
    await archiveSenseCall(alice, first.id, first.version);
    await db.admin('update public.vocabulary set deleted_at = now() where id = $1', [word]);

    // The ordinary add does not write into a word the owner threw away —
    // the refusal is the database's, not only the service's.
    await expect(addSenseCall(alice, word, { meaning: 'bờ sông', request: requestId() })).rejects.toMatchObject({ code: NOT_FOUND });
    // Nor does the restore of a sense the trashed word holds.
    const held = (await sensesOf(word))[0]!;
    expect(held).toMatchObject({ archived: true, version: first.version + 1 });
    await expect(restoreSenseCall(alice, held.id, held.version)).rejects.toMatchObject({ code: NOT_FOUND });
    expect(await countOf('vocabulary_senses', word)).toBe(1);

    // Out of the trash, the same two calls land.
    await db.admin('update public.vocabulary set deleted_at = null where id = $1', [word]);
    const added = await addSenseCall(alice, word, { meaning: 'bờ sông', request: requestId() });
    expect(added[0]).toMatchObject({ created: true });
    await restoreSenseCall(alice, held.id, held.version);
    expect((await sensesOf(word)).find((sense) => sense.id === held.id)).toMatchObject({ archived: false });
  });

  it('refuses an edit and an archive through their calls, and takes them again once it is back', async () => {
    const word = await createWord(alice, 'lie', { meaning: 'nói dối' });
    const first = (await sensesOf(word))[0]!;
    await db.admin('update public.vocabulary set deleted_at = now() where id = $1', [word]);

    await expect(updateSenseCall(alice, first.id, first.version, { meaning: 'dối trá' })).rejects.toMatchObject({ code: NOT_FOUND });
    await expect(archiveSenseCall(alice, first.id, first.version)).rejects.toMatchObject({ code: NOT_FOUND });
    expect((await sensesOf(word))[0]).toMatchObject({ meaning: 'nói dối', archived: false, version: first.version });

    await db.admin('update public.vocabulary set deleted_at = null where id = $1', [word]);
    await updateSenseCall(alice, first.id, first.version, { meaning: 'dối trá' });
    expect((await sensesOf(word))[0]).toMatchObject({ meaning: 'dối trá', version: first.version + 1 });
    await archiveSenseCall(alice, first.id, first.version + 1);
    expect((await sensesOf(word))[0]).toMatchObject({ archived: true, version: first.version + 2 });
  });

  it('lets resume_vocabulary_sense finish a trashed word’s senses, and nobody else reaches it', async () => {
    const word = await createWord(alice, 'bank', { meaning: 'ngân hàng' });
    const request = requestId();
    await db.admin('update public.vocabulary set deleted_at = now() where id = $1', [word]);

    // The named exception: the import's completion call claims the word
    // whatever state it is in and adds the sense its row asked for. Every
    // other call above was refused on this very word.
    const made = await resumeCall(alice, word, { meaning: 'bờ sông', request });
    expect(made[0]).toMatchObject({ created: true });

    // A repeat of the request id lands on the same sense, and the archive
    // flag its row carried lands on it — content stored stays as it was.
    const repeat = await resumeCall(alice, word, { meaning: 'rewritten?', request, archived: true });
    expect(repeat[0]).toMatchObject({ created: false, id: made[0]!.id });
    const stored = await sensesOf(word);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ meaning: 'ngân hàng', archived: false, version: 1 });
    expect(stored[1]).toMatchObject({ meaning: 'bờ sông', archived: true, version: 2 });
    // One insert and one archive flag: exactly two moves of the word's
    // senses version — a trigger chain feeding back on itself would move it
    // further, or never finish.
    expect(await sensesVersion(word)).toBe(3);

    // Ownership is unchanged: another account's trashed word answers P0002,
    // and a caller who is not signed in has no path to it at all.
    const other = await createWord(alice, 'mine', { meaning: 'của tôi' });
    await db.admin('update public.vocabulary set deleted_at = now() where id = $1', [other]);
    await expect(resumeCall(bob, other, { meaning: 'x', request: requestId() })).rejects.toMatchObject({ code: NOT_FOUND });
    await expect(
      db.asAnon((session) =>
        session.query('select * from public.resume_vocabulary_sense($1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::boolean)', [
          word,
          'x',
          null,
          null,
          requestId(),
          false,
        ]),
      ),
    ).rejects.toMatchObject({ code: RLS_DENIED });
    expect(await countOf('vocabulary_senses', other)).toBe(1);
  });
});

describe('update_vocabulary_sense and archive_vocabulary_sense: the bare updates, now under the claim', () => {
  it('edits only the fields sent, and archives keeping identity, content and position', async () => {
    const word = await createWord(alice, 'cold', { meaning: 'lạnh', definition: 'Cold weather.' });
    await seedSenses(alice, word, [{ meaning: 'cảm lạnh' }], 1);
    const [first, second] = await sensesOf(word);

    // A field left out is left as it is; a field sent as null is cleared.
    await updateSenseCall(alice, first!.id, first!.version, { meaning: 'lạnh buốt' });
    expect((await sensesOf(word))[0]).toMatchObject({
      meaning: 'lạnh buốt',
      definition: 'Cold weather.',
      version: first!.version + 1,
    });
    await updateSenseCall(alice, first!.id, first!.version + 1, { definition: null });
    expect((await sensesOf(word))[0]).toMatchObject({ meaning: 'lạnh buốt', definition: null, version: first!.version + 2 });

    // The archive moves only the flag and the version.
    await archiveSenseCall(alice, first!.id, first!.version + 2);
    const after = await sensesOf(word);
    expect(after[0]).toMatchObject({
      id: first!.id,
      position: 0,
      meaning: 'lạnh buốt',
      definition: null,
      archived: true,
      version: first!.version + 3,
    });
    // The sense behind it is exactly as it was.
    expect(after[1]).toEqual(second);
  });

  it('refuses a sense that is not there, another account’s, a version that has moved on, an archived sense, and a word in the trash', async () => {
    const mine = await createWord(alice, 'kept', { meaning: 'giữ' });
    const [first] = await sensesOf(mine);
    const ghost = '00000000-0000-4000-8000-000000000000';

    await expect(updateSenseCall(alice, ghost, 1, { meaning: 'x' })).rejects.toMatchObject({ code: NOT_FOUND });
    await expect(archiveSenseCall(alice, ghost, 1)).rejects.toMatchObject({ code: NOT_FOUND });

    const foreign = await createWord(bob, 'yours', { meaning: 'của bạn' });
    const foreignSense = (await sensesOf(foreign))[0]!;
    await expect(updateSenseCall(alice, foreignSense.id, foreignSense.version, { meaning: 'x' })).rejects.toMatchObject({
      code: NOT_FOUND,
    });
    await expect(archiveSenseCall(alice, foreignSense.id, foreignSense.version)).rejects.toMatchObject({ code: NOT_FOUND });
    expect((await sensesOf(foreign))[0]).toMatchObject({ meaning: 'của bạn', version: foreignSense.version });

    // A version that has moved on: refused whole, nothing written.
    await expect(updateSenseCall(alice, first!.id, first!.version + 1, { meaning: 'x' })).rejects.toMatchObject({ code: STALE });
    await expect(archiveSenseCall(alice, first!.id, first!.version + 1)).rejects.toMatchObject({ code: STALE });
    expect((await sensesOf(mine))[0]).toMatchObject({ meaning: 'giữ', archived: false, version: first!.version });

    // Archived once, the sense is neither edited nor archived again.
    await archiveSenseCall(alice, first!.id, first!.version);
    const archivedVersion = first!.version + 1;
    await expect(updateSenseCall(alice, first!.id, archivedVersion, { meaning: 'x' })).rejects.toMatchObject({ code: STALE });
    await expect(archiveSenseCall(alice, first!.id, archivedVersion)).rejects.toMatchObject({ code: STALE });

    // And a word in the trash answers not found for both calls, though its
    // sense exists and belongs to the caller.
    await db.admin('update public.vocabulary set deleted_at = now() where id = $1', [mine]);
    await expect(updateSenseCall(alice, first!.id, archivedVersion, { meaning: 'x' })).rejects.toMatchObject({ code: NOT_FOUND });
    await expect(archiveSenseCall(alice, first!.id, archivedVersion)).rejects.toMatchObject({ code: NOT_FOUND });
    expect((await sensesOf(mine))[0]).toMatchObject({ archived: true, version: archivedVersion });
  });
});

describe('the legacy edit, its triggers, and the way they commit', () => {
  it('changes only the first live sense when the shown text is edited, leaving the others exactly as they were', async () => {
    const word = await createWord(alice, 'bank', { meaning: 'ngân hàng' });
    await seedSenses(alice, word, [{ meaning: 'bờ sông', example: 'They sat on the bank.' }], 1);
    const before = await sensesOf(word);
    const versionBefore = await sensesVersion(word);

    const patched = await db.as(alice, (session) =>
      session.query('select public.update_vocabulary($1::uuid, $2::jsonb) as updated', [
        word,
        JSON.stringify({ meaning: 'tiền gửi', mastery: 5 }),
      ]),
    );
    expect(patched[0]).toEqual({ updated: true });

    const after = await sensesOf(word);
    // The first live sense took the edit, with the version its change gives.
    expect(after[0]).toMatchObject({ meaning: 'tiền gửi', version: before[0]!.version + 1 });
    // The sense behind it is exactly as it was: same content, same version.
    expect(after[1]).toEqual(before[1]);
    // One move of the senses version for the one sense the edit wrote.
    expect(await sensesVersion(word)).toBe(versionBefore + 1);
  });

  it('moves the senses version exactly once for each change to the senses', async () => {
    const word = await createWord(alice, 'sky', { meaning: 'bầu trời' });
    expect(await sensesVersion(word)).toBe(1);

    // One add under the claim: one move.
    const request = requestId();
    await addSenseCall(alice, word, { meaning: 'trời xanh', request });
    expect(await sensesVersion(word)).toBe(2);

    // One edit through its call: one move.
    const sense = (await sensesOf(word))[1]!;
    await updateSenseCall(alice, sense.id, sense.version, { meaning: 'trời trong' });
    expect(await sensesVersion(word)).toBe(3);

    // The import's completion call sets its archive flag: one move, though
    // it claims the word and checks the request id on the way.
    await resumeCall(alice, word, { meaning: 'ignored', request, archived: true });
    expect(await sensesVersion(word)).toBe(4);

    // One legacy whole-word edit: one move — it writes one sense, and the
    // projection it refreshes on the word never comes back around.
    await db.as(alice, (session) =>
      session.query('select public.update_vocabulary($1::uuid, $2::jsonb)', [word, JSON.stringify({ meaning: 'chân trời' })]),
    );
    expect(await sensesVersion(word)).toBe(5);
    expect(await legacyColumns(word)).toMatchObject({ meaning: 'chân trời' });
  });

  it('commits a legacy edit whole, or not at all', async () => {
    const word = await createWord(alice, 'deep', { meaning: 'sâu' });
    await seedSenses(alice, word, [{ meaning: 'sâu thẳm' }], 1);
    const before = {
      senses: await sensesOf(word),
      version: await sensesVersion(word),
      legacy: await legacyColumns(word),
      mastery: await masteryOf(word),
    };

    // A fault inside the sense write the legacy edit makes — after the
    // word's own columns, inside the same call, have already run.
    await db.admin(
      `create or replace function public.test_fail_projection() returns trigger language plpgsql as $$
       begin
         raise exception 'injected: the legacy edit fails here' using errcode = '${INJECTED}';
       end $$`,
    );
    await db.admin(
      `create trigger test_fail_projection before update of meaning on public.vocabulary_senses
         for each row when (new.meaning = 'poison') execute function public.test_fail_projection()`,
    );
    try {
      await expect(
        db.as(alice, (session) =>
          session.query('select public.update_vocabulary($1::uuid, $2::jsonb)', [
            word,
            JSON.stringify({ meaning: 'poison', mastery: 7 }),
          ]),
        ),
      ).rejects.toMatchObject({ code: INJECTED });
    } finally {
      await db.admin('drop trigger test_fail_projection on public.vocabulary_senses');
      await db.admin('drop function public.test_fail_projection()');
    }

    // Nothing landed: no content half-written, no schedule half-moved.
    expect(await sensesOf(word)).toEqual(before.senses);
    expect(await sensesVersion(word)).toBe(before.version);
    expect(await legacyColumns(word)).toEqual(before.legacy);
    expect(await masteryOf(word)).toBe(before.mastery);
  });
});
