/**
 * G3 — who may reach the senses table, and how far. Separate identities: a
 * visitor (anon), two signed-in accounts, and the owner used only to arrange
 * and inspect. The release question this file answers is the one the
 * FC-RC-FIX-011 report left open — whether the direct-table write path holds
 * the same rule the calls hold — plus what remains open by design, and where
 * row-level isolation ends and the calls' business rules begin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReleaseDatabase, type OpenSession, type ReleaseDatabase } from '../helpers/pg-release-database.js';

let db: ReleaseDatabase;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createReleaseDatabase('rel012_security');
  alice = await db.createUser('alice@security.test');
  bob = await db.createUser('bob@security.test');
});

afterAll(async () => {
  await db.drop();
});

/** Seeds a word (optionally trashed) with one live sense. */
const seedWord = async (user: string, word: string, meaning: string, trashed = false) => {
  const [row] = await db.admin<{ id: string }>(
    `insert into public.vocabulary (user_id, word, word_key, deleted_at)
     values ($1, $2, $2, case when $3 then now() else null end) returning id`,
    [user, word, trashed],
  );
  await db.admin(
    `insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id)
     values ($1, $2, 0, $3, 1, gen_random_uuid())`,
    [user, row!.id, meaning],
  );
  return row!.id;
};

const settlesAs = async <T>(promise: Promise<T>): Promise<{ rows: T } | { code: string }> =>
  promise.then(
    (rows) => ({ rows }),
    (error) => ({ code: (error as { code?: string }).code ?? 'no-code' }),
  );

/** A signed-in session with no JWT claims at all, or malformed ones. */
const openBare = async (claims?: string) => {
  const s = await db.open();
  await s.begin();
  await s.query('set local role authenticated');
  if (claims !== undefined) await s.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
  return s;
};

const closeQuietly = (s: OpenSession) => s.close().catch(() => undefined);

describe('account isolation', () => {
  it("keeps one account out of another's senses, by table and by view", async () => {
    const word = await seedWord(alice, 'mine', 'của tôi');
    const read = await db.as(bob, (s) => s.query('select 1 from public.vocabulary_senses where vocabulary_id = $1', [word]));
    expect(read).toHaveLength(0);
    const view = await db.as(bob, (s) => s.query('select 1 from public.vocabulary_cards where id = $1', [word]));
    expect(view).toHaveLength(0);
  });

  it("refuses every sense call on another account's word", async () => {
    const word = await seedWord(bob, 'theirs', 'của họ');
    const [sense] = await db.admin<{ id: string; meaning: string | null; version: number }>(
      `select id, meaning, version from public.vocabulary_senses where vocabulary_id = $1`,
      [word],
    );

    const outcomes = {
      add: await settlesAs(db.as(alice, (s) => s.query(`select public.add_vocabulary_sense($1::uuid, 'planted', null, null, $2::uuid)`, [word, crypto.randomUUID()]))),
      edit: await settlesAs(db.as(alice, (s) => s.query(`select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)`, [sense!.id, sense!.version, JSON.stringify({ meaning: 'hijacked' })]))),
      archive: await settlesAs(db.as(alice, (s) => s.query(`select public.archive_vocabulary_sense($1::uuid, $2::int)`, [sense!.id, sense!.version]))),
      restore: await settlesAs(db.as(alice, (s) => s.query(`select public.restore_vocabulary_sense($1::uuid, $2::int)`, [sense!.id, sense!.version]))),
      reorder: await settlesAs(db.as(alice, (s) => s.query(`select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)`, [word, JSON.stringify([sense!.id]), 1]))),
      resume: await settlesAs(db.as(alice, (s) => s.query(`select public.resume_vocabulary_sense($1::uuid, 'planted', null, null, $2::uuid)`, [word, crypto.randomUUID()]))),
      legacy: await settlesAs(db.as(alice, (s) => s.query(`select public.update_vocabulary($1::uuid, $2::jsonb)`, [word, JSON.stringify({ meaning: 'hijacked' })]))),
    };
    // Every call refuses with the not-found answer, or the legacy call's
    // honest `updated: false` — never a write into the neighbour's word.
    for (const [call, outcome] of Object.entries(outcomes)) {
      expect(['P0002', 'no-code'], call).toContain('code' in outcome ? outcome.code : 'no-code');
    }
    const [unchanged] = await db.admin<{ meaning: string | null; version: number }>(
      'select meaning, version from public.vocabulary_senses where id = $1',
      [sense!.id],
    );
    expect(unchanged).toMatchObject({ meaning: 'của họ', version: 1 });
  });

  it('cannot be given another account\'s request id', async () => {
    const aliceWord = await seedWord(alice, 'alice-word', 'nghĩa của alice');
    const request = crypto.randomUUID();
    await db.as(alice, (s) => s.query(`select public.add_vocabulary_sense($1::uuid, 'thêm', null, null, $2::uuid)`, [aliceWord, request]));

    const bobWord = await seedWord(bob, 'bob-word', 'nghĩa của bob');
    // The same id under another account is a different id: the index is
    // per user, so the reuse lands as its own sense and aliases nothing.
    const reuse = await db.as(bob, (s) => s.query<{ id: string; created: boolean }>(`select id, created from public.add_vocabulary_sense($1::uuid, 'dùng lại', null, null, $2::uuid)`, [bobWord, request]));
    expect(reuse[0]!.created).toBe(true);

    const [aliceSense, bobSense] = await Promise.all([
      db.admin<{ id: string }>('select id from public.vocabulary_senses where user_id = $1 and request_id = $2', [alice, request]),
      db.admin<{ id: string }>('select id from public.vocabulary_senses where user_id = $1 and request_id = $2', [bob, request]),
    ]);
    expect(aliceSense).toHaveLength(1);
    expect(bobSense).toHaveLength(1);
    expect(bobSense[0]!.id).not.toBe(aliceSense[0]!.id);
  });

  it('denies the visitor every way in', async () => {
    const word = await seedWord(alice, 'visitor-proof', 'không tới được');
    const add = await settlesAs(db.asAnon((s) => s.query(`select public.add_vocabulary_sense($1::uuid, 'x', null, null, $2::uuid)`, [word, crypto.randomUUID()])));
    expect(add).toEqual({ code: '42501' });
    const resume = await settlesAs(db.asAnon((s) => s.query(`select public.resume_vocabulary_sense($1::uuid, 'x', null, null, $2::uuid)`, [word, crypto.randomUUID()])));
    expect(resume).toEqual({ code: '42501' });
    const insert = await settlesAs(db.asAnon((s) => s.query(`insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id) values ($1, $2, 9, 'x', 1, gen_random_uuid())`, [alice, word])));
    expect(insert).toEqual({ code: '42501' });
    // The visitor holds no privilege on the table at all — version 13
    // revoked it — so even a read is refused before any policy is consulted.
    const read = await settlesAs(db.asAnon((s) => s.query('select 1 from public.vocabulary_senses where vocabulary_id = $1', [word])));
    expect(read).toEqual({ code: '42501' });
  });
});

describe('the direct table, and the rule it now holds', () => {
  it('still takes a live word\'s new sense directly — the path the calls do not need but the contract keeps', async () => {
    const word = await seedWord(alice, 'live-direct', 'nghĩa gốc');
    const landed = await db.as(alice, (s) =>
      s.query<{ id: string }>(`insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id) values ($1, $2, 1, 'thẳng', 1, gen_random_uuid()) returning id`, [alice, word]),
    );
    expect(landed[0]!.id).toBeDefined();
  });

  it('refuses every write into a trashed word, whichever statement comes', async () => {
    const word = await seedWord(alice, 'trashed-direct', 'trong thùng rác', true);
    const [sense] = await db.admin<{ id: string }>('select id from public.vocabulary_senses where vocabulary_id = $1', [word]);

    // Insert: refused by name, by the guard policy.
    const insert = await settlesAs(db.as(alice, (s) => s.query(`insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id) values ($1, $2, 5, 'planted', 1, gen_random_uuid())`, [alice, word])));
    expect(insert).toEqual({ code: '42501' });

    // Update: the rows are filtered away — the statement runs and touches
    // nothing, which is how row-level rules answer rather than an error.
    const update = await db.as(alice, (s) => s.query(`update public.vocabulary_senses set meaning = 'BYPASSED' where vocabulary_id = $1 returning id`, [word]));
    expect(update).toHaveLength(0);

    // Delete: no policy allows it for this role, at all, anywhere.
    const remove = await settlesAs(db.as(alice, (s) => s.query('delete from public.vocabulary_senses where id = $1', [sense!.id])));
    expect(remove).toEqual({ code: '42501' });

    const [unchanged] = await db.admin<{ meaning: string | null }>('select meaning from public.vocabulary_senses where id = $1', [sense!.id]);
    expect(unchanged!.meaning).toBe('trong thùng rác');
  });

  it('refuses a neighbour\'s word even for a brand-new row', async () => {
    const bobWord = await seedWord(bob, 'bob-live', 'nghĩa của bob');
    const insert = await settlesAs(db.as(alice, (s) => s.query(`insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id) values ($1, $2, 7, 'planted on the neighbour', 1, gen_random_uuid())`, [alice, bobWord])));
    expect(insert).toEqual({ code: '42501' });
    expect(await db.admin('select 1 from public.vocabulary_senses where vocabulary_id = $1', [bobWord])).toHaveLength(1);
  });

  it('names the grants that make those refusals meaningful, not missing privileges', async () => {
    // The insert and update paths are refused by policies, not by absent
    // grants — a refusal for a missing grant would say something else.
    // Delete is the deliberate exception: version 13 withholds the privilege
    // itself, so no delete policy was ever needed.
    const grants = await db.admin<{ select_: boolean; insert: boolean; update: boolean; delete_: boolean }>(
      `select has_table_privilege('authenticated', 'public.vocabulary_senses', 'SELECT') as select_,
              has_table_privilege('authenticated', 'public.vocabulary_senses', 'INSERT') as insert,
              has_table_privilege('authenticated', 'public.vocabulary_senses', 'UPDATE') as update,
              has_table_privilege('authenticated', 'public.vocabulary_senses', 'DELETE') as delete_`,
    );
    expect(grants[0]).toMatchObject({ select_: true, insert: true, update: true, delete_: false });
    const visitor = await db.admin<{ select_: boolean }>(
      `select has_table_privilege('anon', 'public.vocabulary_senses', 'SELECT') as select_`,
    );
    expect(visitor[0]!.select_, 'the visitor holds nothing on the table').toBe(false);
  });
});

describe('the recovery call, and nothing else, reaches the trashed word', () => {
  it('adds and archives a sense on the caller\'s own trashed word, and leaves the word trashed', async () => {
    const word = await seedWord(alice, 'recovery-open', 'trước phục hồi', true);
    const created = await db.as(alice, (s) =>
      s.query<{ id: string; created: boolean }>(`select id, created from public.resume_vocabulary_sense($1::uuid, 'sau phục hồi', null, null, $2::uuid)`, [word, crypto.randomUUID()]),
    );
    expect(created[0]!.created).toBe(true);

    const request = crypto.randomUUID();
    await db.as(alice, (s) => s.query(`select public.resume_vocabulary_sense($1::uuid, 'một dòng tệp', null, null, $2::uuid, true)`, [word, request]));
    const [filed] = await db.admin<{ archived_at: string | null }>('select archived_at from public.vocabulary_senses where request_id = $1', [request]);
    expect(filed!.archived_at).not.toBeNull();

    const [row] = await db.admin<{ deleted_at: string | null }>('select deleted_at from public.vocabulary where id = $1', [word]);
    expect(row!.deleted_at).not.toBeNull();
  });

  it('still refuses another account\'s trashed word', async () => {
    const word = await seedWord(bob, 'bob-trashed', 'của họ', true);
    const resume = await settlesAs(db.as(alice, (s) => s.query(`select public.resume_vocabulary_sense($1::uuid, 'planted', null, null, $2::uuid)`, [word, crypto.randomUUID()])));
    expect(resume).toEqual({ code: 'P0002' });
    expect(await db.admin('select 1 from public.vocabulary_senses where vocabulary_id = $1', [word])).toHaveLength(1);
  });

  it('leaves the door closed without a signed-in identity', async () => {
    const word = await seedWord(alice, 'recovery-auth', 'cần đăng nhập', true);

    const noClaims = await openBare();
    try {
      const outcome = await settlesAs(noClaims.query(`select public.resume_vocabulary_sense($1::uuid, 'x', null, null, $2::uuid)`, [word, crypto.randomUUID()]));
      expect(outcome).toEqual({ code: '28000' });
    } finally {
      await closeQuietly(noClaims);
    }

    const malformed = await openBare(JSON.stringify({ sub: 'not-a-uuid', role: 'authenticated' }));
    try {
      const outcome = await settlesAs(malformed.query(`select public.resume_vocabulary_sense($1::uuid, 'x', null, null, $2::uuid)`, [word, crypto.randomUUID()]));
      expect(outcome).toEqual({ code: '22P02' });
    } finally {
      await closeQuietly(malformed);
    }

    const unknown = await openBare(JSON.stringify({ sub: crypto.randomUUID(), role: 'authenticated' }));
    try {
      const outcome = await settlesAs(unknown.query(`select public.resume_vocabulary_sense($1::uuid, 'x', null, null, $2::uuid)`, [word, crypto.randomUUID()]));
      expect(outcome).toEqual({ code: 'P0002' });
    } finally {
      await closeQuietly(unknown);
    }
  });
});

describe('row-level rules and business rules, side by side', () => {
  it('answer differently, on purpose: a filtered row for one, a named error for the other', async () => {
    const word = await seedWord(alice, 'two-layers', 'hai tầng', true);
    const [sense] = await db.admin<{ id: string; version: number }>('select id, version from public.vocabulary_senses where vocabulary_id = $1', [word]);

    // The table, directly: the row is not there to touch — isolation works
    // by filtering, silently, without an opinion about why.
    const direct = await db.as(alice, (s) => s.query('update public.vocabulary_senses set meaning = $2 where id = $1 returning id', [sense!.id, 'nope']));
    expect(direct).toHaveLength(0);

    // The call: the same refusal, but stated — the word is in the trash,
    // which is a rule about this account's own data, and it has a name.
    const called = await settlesAs(db.as(alice, (s) => s.query(`select public.archive_vocabulary_sense($1::uuid, $2::int)`, [sense!.id, sense!.version])));
    expect(called).toEqual({ code: 'P0002' });
  });

  it('keeps the identities closed to direct login, and the bypass role unused by any client', async () => {
    const roles = await db.admin<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean }>(
      `select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by rolname`,
    );
    // The application identities exist only inside a request: a connection
    // as them is not something a person can open. (The stronger claim this
    // once made — that the recovery setting was out of reach because only
    // the calls could set it — was disproven by FC-SEC-013 G1: any session
    // can raise a custom setting. Schema 17 therefore moved the exception
    // into a NOLOGIN role no session can become; see recovery-boundary
    // tests.)
    expect(roles).toEqual([
      { rolname: 'anon', rolcanlogin: false, rolbypassrls: false },
      { rolname: 'authenticated', rolcanlogin: false, rolbypassrls: false },
      { rolname: 'service_role', rolcanlogin: false, rolbypassrls: true },
    ]);

    // The bypass role is the owner's door: it skips the rules entirely, as
    // the report documents. Nothing in the application connects as it —
    // checked by the report against the server's connection code.
    await db.admin(`insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id)
                    select $1, v.id, 6, 'as the bypass role', 1, gen_random_uuid() from public.vocabulary v where v.word_key = 'two-layers'`, [alice]);
    const planted = await db.admin<{ n: string }>(
      `select count(*)::text as n from public.vocabulary_senses s join public.vocabulary v on v.id = s.vocabulary_id
        where v.word_key = 'two-layers' and s.meaning = 'as the bypass role'`,
    );
    expect(planted[0]!.n).toBe('1');
  });
});
