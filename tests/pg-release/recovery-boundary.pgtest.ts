/**
 * FC-SEC-013 G3 — the sense recovery boundary after schema 17. What a
 * caller can and cannot reach:
 *
 *  - the custom setting a caller raises for itself changes nothing;
 *  - no session can become the recovery role;
 *  - the legitimate interrupted-import recovery still completes, on live and
 *    on trashed words, still idempotent, still ownership-checked;
 *  - cross-account isolation, the ordinary direct-write surface and the
 *    legacy paths are exactly as before;
 *  - concurrent resumes queue on the word's lock, and a rolled-back recovery
 *    leaves nothing behind.
 *
 * Every probe runs in its own transaction and is rolled back, so a refusal
 * never masks the next probe (no aborted-transaction cascades).
 *
 * Run against the real local instance (see tests/pg-release/vitest.config.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createReleaseDatabase,
  waitUntilBlocked,
  withTimeout,
  type OpenSession,
  type ReleaseDatabase,
} from '../helpers/pg-release-database.js';

let db: ReleaseDatabase;
let alice: string;
let bob: string;
let inspector: OpenSession;

beforeAll(async () => {
  db = await createReleaseDatabase('rel012_sec013_boundary');
  alice = await db.createUser('alice@sec013.test');
  bob = await db.createUser('bob@sec013.test');
  inspector = await db.openInspector();
});

afterAll(async () => {
  await inspector.close();
  await db.drop();
});

const asAlice = (lockTimeout = '8s') => db.open({ role: 'authenticated', userId: alice }, { lockTimeout });
const asBob = () => db.open({ role: 'authenticated', userId: bob });

/** Collects a refusal instead of throwing, so assertions can inspect it. */
const refuses = async (promise: Promise<unknown>): Promise<{ code?: string; message?: string }> =>
  promise.then(
    () => ({ code: undefined, message: 'unexpectedly succeeded' }),
    (error) => {
      const e = error as { code?: string; message?: string };
      return { code: e.code, message: e.message?.split('\n')[0] };
    },
  );

const expectRefusal = async (promise: Promise<unknown>, code: string, messagePart?: string) => {
  const outcome = await refuses(promise);
  expect(outcome.code, `expected ${code}; got ${outcome.code} (${outcome.message})`).toBe(code);
  if (messagePart) expect(outcome.message).toContain(messagePart);
};

/**
 * One probe = one transaction. Statements run in order; assertions live
 * inside the block (before any refusal could abort the transaction); the
 * block is always rolled back.
 */
const probe = async (identity: 'A' | 'B', statements: (s: OpenSession) => Promise<void>) => {
  const s = identity === 'A' ? await asAlice() : await asBob();
  await s.begin();
  try {
    await statements(s);
  } finally {
    await s.rollback().catch(() => undefined);
    await s.close().catch(() => undefined);
  }
};

/** Seeds a committed word with the given live senses; trashes it if asked. */
const seedWord = async (word: string, meanings: string[], trashed = false) => {
  const [row] = await db.admin<{ id: string }>(
    `insert into public.vocabulary (user_id, word, word_key) values ($1, $2, $2) returning id`,
    [alice, word],
  );
  for (const [position, meaning] of meanings.entries()) {
    await db.admin(
      `insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id)
       values ($1, $2, $3, $4, 1, gen_random_uuid())`,
      [alice, row!.id, position, meaning],
    );
  }
  await db.admin('update public.vocabulary set senses_version = 1 where id = $1', [row!.id]);
  if (trashed) await db.as(alice, (s) => s.query('update public.vocabulary set deleted_at = now() where id = $1', [row!.id]));
  return row!.id;
};

const sensesOf = (word: string) =>
  db.admin<{ position: number; meaning: string | null; archived_at: string | null }>(
    `select position, meaning, archived_at from public.vocabulary_senses where vocabulary_id = $1 order by position`,
    [word],
  );

const wordRow = (word: string) =>
  db.admin<{ meaning: string | null; deleted_at: string | null; senses_version: number }>(
    `select meaning, deleted_at, senses_version from public.vocabulary where id = $1`,
    [word],
  );

const requestIdOf = async (word: string) =>
  (await db.admin<{ request_id: string }>(`select request_id from public.vocabulary_senses where vocabulary_id = $1 limit 1`, [word]))[0]!.request_id;

const insertSpoof = (word: string, user: string) =>
  `insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id)
   values ('${user}', '${word}', 9, 'spoofed', 1, gen_random_uuid())`;

const meaningsIn = (s: OpenSession, word: string) =>
  s
    .query<{ meanings: string }>(
      `select coalesce(string_agg(meaning, '|' order by position), '') as meanings
         from public.vocabulary_senses where vocabulary_id = '${word}' and archived_at is null`,
    )
    .then((rows) => rows[0]!.meanings);

describe('the recovery context cannot be raised by a caller', () => {
  it('ignores the custom setting a session raises for itself', async () => {
    const word = await seedWord('spoof-guc', ['nghĩa gốc'], true);

    // Spelling one: set_config, exactly as FC-SEC-013 G1 used it on 16.
    await probe('A', async (s) => {
      const [set] = await s.query<{ set_to: string }>(`select set_config('app.sense_recovery', 'on', true) as set_to`);
      expect(set!.set_to).toBe('on');
      await expectRefusal(s.query(insertSpoof(word, alice)), '42501', 'vocabulary_senses_insert_guard');
    });

    // The update direction: no error, but nothing to act on — the guard
    // filters the trashed word's rows out from under the statement.
    await probe('A', async (s) => {
      await s.query(`select set_config('app.sense_recovery', 'on', true)`);
      const updated = await s.query(
        `update public.vocabulary_senses set meaning = 'spoofed' where vocabulary_id = '${word}' and archived_at is null`,
      );
      expect(updated).toHaveLength(0);
      expect(await meaningsIn(s, word)).toBe('nghĩa gốc');
    });

    // Spelling two: `set local`.
    await probe('A', async (s) => {
      await s.query(`set local app.sense_recovery = 'on'`);
      await expectRefusal(s.query(insertSpoof(word, alice)), '42501', 'vocabulary_senses_insert_guard');
    });

    // Nothing in the database still reads any custom setting.
    const [readers] = await db.admin<{ n: number }>(
      `select count(*)::int as n from pg_policies
        where schemaname = 'public'
          and (coalesce(qual, '') like '%current_setting%' or coalesce(with_check, '') like '%current_setting%')`,
    );
    expect(readers!.n).toBe(0);

    // And the committed state never moved.
    expect(await sensesOf(word)).toEqual([{ position: 0, meaning: 'nghĩa gốc', archived_at: null }]);
    expect((await wordRow(word))[0]!.deleted_at).not.toBeNull();
  });

  it('cannot become the recovery role', async () => {
    const word = await seedWord('spoof-role', ['gốc'], true);

    await probe('A', async (s) => {
      // A refused role switch aborts the transaction like any error, so the
      // proof that nothing changed continues from a savepoint, in the same
      // session: the role never moved, and the write stays refused.
      await s.query('savepoint before_role_switch');
      await expectRefusal(s.query('set role app_sense_recovery'), '42501', 'app_sense_recovery');
      await s.query('rollback to savepoint before_role_switch');
      const [still] = await s.query<{ current_user: string }>(`select current_user::text as current_user`);
      expect(still!.current_user).toBe('authenticated');
      await expectRefusal(s.query(insertSpoof(word, alice)), '42501', 'vocabulary_senses_insert_guard');
    });
    expect(await sensesOf(word)).toHaveLength(1);
  });

  it('holds the recovery role for nobody, and the call for the signed-in role alone', async () => {
    const members = await db.admin(
      `select r2.rolname from pg_auth_members m
         join pg_roles r1 on r1.oid = m.member
         join pg_roles r2 on r2.oid = m.roleid
        where r1.rolname = 'app_sense_recovery' or r2.rolname = 'app_sense_recovery'`,
    );
    expect(members).toEqual([]);
    const grants = await db.admin<{ auth: boolean; anon: boolean; service: boolean }>(
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'resume_vocabulary_sense'`,
    );
    expect(grants[0]).toEqual({ auth: true, anon: false, service: false });
  });
});

describe('the legitimate recovery still works', () => {
  it('completes an interrupted import on a live word, and keeps the word in step', async () => {
    // The documented intermediate state: the word landed, its senses did not.
    const request = crypto.randomUUID();
    const [entry] = await db.as(alice, (s) =>
      s.query<{ id: string }>(
        `select id from public.create_vocabulary($1::text, $1::text, 3::smallint, null::text, null::text, null::text,
          current_date, null::date, $2::uuid, null::text, null::text, null::timestamptz)`,
        ['interrupted', request],
      ),
    );
    expect(await sensesOf(entry!.id)).toHaveLength(0);

    const first = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(
        `select created from public.resume_vocabulary_sense($1::uuid, 'nghĩa một', null, null, $2::uuid)`,
        [entry!.id, request],
      ),
    );
    expect(first[0]!.created).toBe(true);

    // The whole file arrives again: same request id, same body — no double.
    const again = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(
        `select created from public.resume_vocabulary_sense($1::uuid, 'nghĩa một', null, null, $2::uuid)`,
        [entry!.id, request],
      ),
    );
    expect(again[0]!.created).toBe(false);
    expect(await sensesOf(entry!.id)).toEqual([{ position: 0, meaning: 'nghĩa một', archived_at: null }]);

    // The projection trigger ran inside the definer path: the shown word
    // columns follow the sense that was just created.
    const [word] = await wordRow(entry!.id);
    expect(word!.meaning).toBe('nghĩa một');
    expect(word!.deleted_at).toBeNull();
  });

  it('retries on a trashed word, and never brings it back', async () => {
    const word = await seedWord('trashed-retry', ['trước'], true);

    // A row the file had not reached yet is still created on the trashed
    // word — that is the call's purpose.
    const created = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(
        `select created from public.resume_vocabulary_sense($1::uuid, 'sau', null, null, $2::uuid)`,
        [word, crypto.randomUUID()],
      ),
    );
    expect(created[0]!.created).toBe(true);
    expect((await sensesOf(word)).map((r) => r.meaning)).toEqual(['trước', 'sau']);

    const [row] = await wordRow(word);
    expect(row!.deleted_at).not.toBeNull();
  });

  it('archives the existing row when the retry carries its request id', async () => {
    const word = await seedWord('trashed-archive', ['một'], true);
    const request = await requestIdOf(word);

    const retry = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(
        `select created from public.resume_vocabulary_sense($1::uuid, 'một', null, null, $2::uuid, true)`,
        [word, request],
      ),
    );
    expect(retry[0]!.created).toBe(false);
    const rows = await sensesOf(word);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.archived_at).not.toBeNull();
    expect((await wordRow(word))[0]!.deleted_at).not.toBeNull();
  });
});

describe('cross-account isolation and the ordinary surface', () => {
  it('keeps user B out of user A\'s words even with the setting raised', async () => {
    const word = await seedWord('cross-boundary', ['của A'], true);

    await probe('B', async (s) => {
      await s.query(`select set_config('app.sense_recovery', 'on', true)`);
      const read = await s.query(`select id from public.vocabulary_senses where vocabulary_id = '${word}'`);
      expect(read).toEqual([]);
      const updated = await s.query(
        `update public.vocabulary_senses set meaning = 'của B' where vocabulary_id = '${word}' and archived_at is null`,
      );
      expect(updated).toHaveLength(0);
      // B's session sees no rows of A's at all — the isolation itself: the
      // verification select comes back empty from B's side of the boundary.
      expect(await meaningsIn(s, word)).toBe('');
    });
    await probe('B', async (s) => {
      await s.query(`select set_config('app.sense_recovery', 'on', true)`);
      await expectRefusal(s.query(insertSpoof(word, bob)), '42501', 'vocabulary_senses_insert_guard');
    });
    await probe('B', async (s) => {
      await expectRefusal(
        s.query(`select public.resume_vocabulary_sense($1::uuid, 'x', null, null, $2::uuid)`, [word, crypto.randomUUID()]),
        'P0002',
      );
    });
    await probe('B', async (s) => {
      await expectRefusal(
        s.query(`select public.add_vocabulary_sense($1::uuid, 'x', null, null, $2::uuid)`, [word, crypto.randomUUID()]),
        'P0002',
      );
    });

    expect(await sensesOf(word)).toEqual([{ position: 0, meaning: 'của A', archived_at: null }]);
    expect((await wordRow(word))[0]!.deleted_at).not.toBeNull();
  });

  it('leaves the ordinary direct writes exactly as version 13 set them', async () => {
    const word = await seedWord('ordinary', ['gốc'], false);

    // The supported direct path on a live word still works…
    const inserted = await db.as(alice, (s) => s.query(insertSpoof(word, alice)));
    expect(inserted).toHaveLength(0);
    const updated = await db.as(alice, (s) =>
      s.query(`update public.vocabulary_senses set meaning = 'đã sửa' where vocabulary_id = $1 and position = 0`, [word]),
    );
    expect(updated).toHaveLength(0);
    // …delete stays withheld at the grant level…
    await expectRefusal(db.as(alice, (s) => s.query(`delete from public.vocabulary_senses where vocabulary_id = $1`, [word])), '42501');
    // …and the senses still answer to the account that owns them.
    expect((await sensesOf(word)).map((r) => r.meaning)).toEqual(['đã sửa', 'spoofed']);
  });

  it('runs the legacy application paths unchanged', async () => {
    const request = crypto.randomUUID();
    const [entry] = await db.as(alice, (s) =>
      s.query<{ id: string; created: boolean }>(
        `select id, created from public.create_vocabulary($1::text, $1::text, 3::smallint, $2::text, null::text, null::text,
          current_date, null::date, $3::uuid, null::text, null::text, null::timestamptz)`,
        ['legacy-path', 'nghĩa cũ', request],
      ),
    );
    expect(entry!.created).toBe(true);
    const repeat = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(
        `select id, created from public.create_vocabulary($1::text, $1::text, 3::smallint, $2::text, null::text, null::text,
          current_date, null::date, $3::uuid, null::text, null::text, null::timestamptz)`,
        ['legacy-path', 'nghĩa cũ', request],
      ),
    );
    expect(repeat[0]!.created).toBe(false);

    const edited = await db.as(alice, (s) =>
      s.query<{ update_vocabulary: boolean }>(`select public.update_vocabulary($1::uuid, $2::jsonb)`, [entry!.id, JSON.stringify({ meaning: 'nghĩa mới' })]),
    );
    expect(edited[0]!.update_vocabulary).toBe(true);
    expect((await wordRow(entry!.id))[0]!.meaning).toBe('nghĩa mới');
    expect((await sensesOf(entry!.id))[0]!.meaning).toBe('nghĩa mới');
  });
});

describe('concurrency and rollback', () => {
  it('queues a second resume behind the first and lands exactly one row', async () => {
    const word = await seedWord('queued-recovery', ['gốc'], true);
    const request = crypto.randomUUID();

    const a = await asAlice();
    const b = await asAlice();
    try {
      const bPid = await b.backendPid();

      await a.begin();
      await a.query(`select public.resume_vocabulary_sense($1::uuid, 'song', null, null, $2::uuid)`, [word, request]);

      await b.begin();
      // Sent at once: it settles into an outcome, so no promise is left
      // unhandled while the test waits for the overlap to appear.
      const waiter = b
        .query<{ created: boolean }>(`select created from public.resume_vocabulary_sense($1::uuid, 'song', null, null, $2::uuid)`, [word, request])
        .then(
          (rows) => ({ rows }),
          (error) => ({ code: (error as { code?: string }).code ?? 'no-code' }),
        );
      // The waiter is watched until it is parked on the word's claim — the
      // overlap is the point of the test.
      await waitUntilBlocked(inspector, bPid);

      await a.commit();
      const outcome = await withTimeout(waiter, 10_000, 'queued recovery');
      expect('rows' in outcome, `resume errored instead of completing: ${JSON.stringify(outcome)}`).toBe(true);
      expect('rows' in outcome ? outcome.rows[0]!.created : undefined).toBe(false);
      await b.commit();
    } finally {
      await a.close().catch(() => undefined);
      await b.close().catch(() => undefined);
    }

    const rows = await sensesOf(word);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.meaning === 'song')).toHaveLength(1);
    expect((await wordRow(word))[0]!.deleted_at).not.toBeNull();
  });

  it('leaves nothing behind when a recovery is rolled back', async () => {
    const word = await seedWord('rollback-recovery', ['gốc'], true);
    const before = await wordRow(word);

    const s = await asAlice();
    await s.begin();
    const [made] = await s.query<{ created: boolean }>(
      `select created from public.resume_vocabulary_sense($1::uuid, 'không ở lại', null, null, $2::uuid)`,
      [word, crypto.randomUUID()],
    );
    expect(made!.created).toBe(true);
    expect(await s.query(`select 1 from public.vocabulary_senses where vocabulary_id = '${word}'`)).toHaveLength(2);
    await s.rollback();
    await s.close();

    expect(await sensesOf(word)).toEqual([{ position: 0, meaning: 'gốc', archived_at: null }]);
    const after = await wordRow(word);
    expect(after[0]!.senses_version).toBe(before[0]!.senses_version);
    expect(after[0]!.deleted_at).not.toBeNull();
  });
});
