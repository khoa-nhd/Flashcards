/**
 * G1 — the real migration sequence on real PostgreSQL.
 *
 * Two installations are verified: an empty database taking every file in
 * order, and a representative pre-v13 database — legacy vocabulary, a card
 * schedule and review history — upgraded through the same files and checked
 * for data loss. Capability detection is compared against the catalog at
 * every version, so what the backend claims a schema can do is what the
 * schema actually holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesAt } from '../../server/supabase/supabase-repository.js';
import {
  createReleaseDatabase,
  readMigrations,
  type ReleaseDatabase,
  type Session,
} from '../helpers/pg-release-database.js';

const LATEST = readMigrations().length;

let db: ReleaseDatabase;
let alice: string;

beforeAll(async () => {
  db = await createReleaseDatabase('rel012_migrations');
  alice = await db.createUser('alice@migrations.test');
});

afterAll(async () => {
  await db.drop();
});

/** One scalar answer, the way the checks below read the database. */
const scalar = async (session: Session | ReleaseDatabase, sql: string, params: unknown[] = []) => {
  const rows = 'admin' in session ? await session.admin<{ value: string | null }>(sql, params) : await session.query<{ value: string | null }>(sql, params);
  return rows[0]?.value ?? null;
};

describe('migration ordering', () => {
  it('applies every file in sequence, and the version function tracks what was applied', async () => {
    for (const version of [13, 14, 15, LATEST]) {
      const probe = await createReleaseDatabase(`rel012_mig_v${version}`, { migrations: version });
      try {
        expect(await scalar(probe, 'select public.app_schema_version()::text as value')).toBe(String(version));
      } finally {
        await probe.drop();
      }
    }
  }, 120_000);
});

describe('fresh installation', () => {
  it('has the functions, views, triggers and indexes the newest code expects', async () => {
    const functions = await db.admin<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' order by p.proname`,
    );
    const names = functions.map((f) => f.proname);
    for (const expected of [
      'app_schema_version',
      'create_vocabulary',
      'create_vocabulary_with_senses',
      'update_vocabulary',
      'add_vocabulary_sense',
      'restore_vocabulary_sense',
      'reorder_vocabulary_senses',
      'update_vocabulary_sense',
      'archive_vocabulary_sense',
      'resume_vocabulary_sense',
      'apply_review',
      'record_review',
      'bump_vocabulary_map_revision',
      'bump_discovery_source_revision',
    ]) {
      expect(names, `function ${expected}`).toContain(expected);
    }

    const views = await db.admin<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v' order by c.relname`,
    );
    expect(views.map((v) => v.relname)).toEqual(['effective_reviews', 'vocabulary_cards']);

    const triggers = await db.admin<{ relname: string; tgname: string; before: boolean }>(
      `select c.relname, t.tgname, (t.tgtype & 4) <> 0 as before
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
        order by c.relname, t.tgname`,
    );
    expect(triggers).toEqual([
      { relname: 'card_states', tgname: 'card_states_touch', before: false },
      { relname: 'collections', tgname: 'collections_touch', before: false },
      { relname: 'discovery_sources', tgname: 'discovery_sources_touch', before: false },
      { relname: 'user_settings', tgname: 'user_settings_touch', before: false },
      { relname: 'vocabulary', tgname: 'vocabulary_touch', before: false },
      { relname: 'vocabulary_examples', tgname: 'vocabulary_examples_touch', before: false },
      { relname: 'vocabulary_maps', tgname: 'vocabulary_maps_touch', before: false },
      { relname: 'vocabulary_senses', tgname: 'vocabulary_senses_sync', before: true },
      { relname: 'vocabulary_senses', tgname: 'vocabulary_senses_touch', before: false },
      { relname: 'vocabulary_senses', tgname: 'vocabulary_senses_version', before: true },
    ]);

    const indexes = await db.admin<{ indexdef: string }>(
      `select pg_get_indexdef(i.indexrelid) as indexdef from pg_index i
        join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'vocabulary_senses'`,
    );
    const indexText = indexes.map((i) => i.indexdef).join('\n');
    expect(indexText).toContain('CREATE UNIQUE INDEX vocabulary_senses_position_unique');
    expect(indexText).toContain('vocabulary_id, "position"');
    expect(indexText).toContain('CREATE UNIQUE INDEX vocabulary_senses_request_unique');
    expect(indexText).toMatch(/WHERE \(request_id IS NOT NULL\)/);

    const secured = await db.admin<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
    );
    for (const table of secured) expect(table.relrowsecurity, table.relname).toBe(true);
  });

  it('grants the sense calls to the signed-in role and to nobody else', async () => {
    for (const fn of ['add_vocabulary_sense', 'update_vocabulary_sense', 'resume_vocabulary_sense']) {
      const grants = await db.admin<{ auth: boolean; anon: boolean }>(
        `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      expect(grants[0], fn).toBeDefined();
      expect(grants[0]!.auth, `${fn} to authenticated`).toBe(true);
      expect(grants[0]!.anon, `${fn} to anon`).toBe(false);
    }

    // The table itself stays readable and writable for the signed-in role —
    // the policies, not a missing grant, are what bind those writes (G3).
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
      expect(await scalar(db, 'select has_table_privilege($1::text, $2::text, $3::text)::text as value', ['authenticated', 'public.vocabulary_senses', privilege])).toBe('true');
    }
    // Eight policies on the senses table: version 13's three permissive,
    // the two restrictive guards restated by version 17, and the recovery
    // role's own three. The exception is now a role, never a setting.
    const policies = await db.admin<{ policyname: string; qual: string | null; with_check: string | null; roles: string }>(
      `select policyname, qual, with_check, roles::text as roles from pg_policies where schemaname = 'public' and tablename = 'vocabulary_senses' order by policyname`,
    );
    expect(policies.map((p) => p.policyname)).toEqual([
      'vocabulary_senses_insert',
      'vocabulary_senses_insert_guard',
      'vocabulary_senses_recovery_insert',
      'vocabulary_senses_recovery_select',
      'vocabulary_senses_recovery_update',
      'vocabulary_senses_select',
      'vocabulary_senses_update',
      'vocabulary_senses_update_guard',
    ]);
    for (const guard of policies.filter((p) => p.policyname.endsWith('_guard'))) {
      // An insert guard states its condition as with_check; an update guard
      // as qual. Either way: the word must be the account's, live — unless
      // the statement runs as the recovery role (FC-SEC-013). The old
      // custom-setting reading must be gone.
      const condition = guard.qual ?? guard.with_check ?? '';
      expect(condition, guard.policyname).toContain('deleted_at');
      // pg_get_expr renders the keyword uppercase: CURRENT_USER = the role
      // the statement runs as, never a value a caller can raise.
      expect(condition, guard.policyname).toContain('CURRENT_USER');
      expect(condition, guard.policyname).toContain('app_sense_recovery');
      expect(condition, guard.policyname).not.toContain('current_setting');
      // (pg_policies.roles is sorted by role name, hence the order here.)
      expect(guard.roles, guard.policyname).toBe('{app_sense_recovery,authenticated}');
    }
    for (const recovery of policies.filter((p) => p.policyname.includes('_recovery_'))) {
      expect(recovery.roles, recovery.policyname).toBe('{app_sense_recovery}');
      expect(recovery.qual ?? recovery.with_check ?? '', recovery.policyname).toContain('auth.uid()');
    }
    // The recovery role exists, cannot log in, and owns the one call that
    // runs as it.
    const [role] = await db.admin<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'app_sense_recovery'`,
    );
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
    const [owner] = await db.admin<{ owner: string; prosecdef: boolean }>(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'resume_vocabulary_sense'`,
    );
    expect(owner).toEqual({ owner: 'app_sense_recovery', prosecdef: true });
  });
});

describe('upgrade from a pre-v13 database', () => {
  it('keeps every word, id and review row, and gives the words their senses', async () => {
    const legacy = await createReleaseDatabase('rel012_upgrade', { migrations: 12 });
    // The upgrade database has its own accounts: this is another project
    // that has fallen behind, not the one above.
    const legacyAlice = await legacy.createUser('alice@upgrade.test');
    try {
      // The data version 12 would hold: two words with content, one of them
      // already in the trash, one imported without content, a schedule and a
      // review event — written the way that code wrote them, straight to the
      // tables as the signed-in account.
      const { candid, bank, empty } = await legacy.as(legacyAlice, async (s) => {
        const insert = async (word: string, meaning: string | null, definition: string | null, trashed: boolean) => {
          const rows = await s.query<{ id: string }>(
            `insert into public.vocabulary (user_id, word, word_key, meaning, definition, date_added, deleted_at)
             values ($1, $2, $2, $3, $4, current_date, case when $5 then now() else null end) returning id`,
            [legacyAlice, word, meaning, definition, trashed],
          );
          return rows[0]!.id;
        };
        const candidId = await insert('candid', 'thẳng thắn', 'honest', false);
        const bankId = await insert('bank', 'ngân hàng', 'a bank', true);
        const emptyId = await insert('empty', null, null, false);
        await s.query(
          `insert into public.card_states (user_id, vocabulary_id, mastery, review_date) values ($1, $2, 3, current_date + 2)`,
          [legacyAlice, candidId],
        );
        await s.query(
          `insert into public.review_logs (user_id, vocabulary_id, action, request_id, reviewed_on, mastery_before, mastery_after)
           values ($1, $2, 'remember', gen_random_uuid(), current_date, 2, 3)`,
          [legacyAlice, candidId],
        );
        return { candid: candidId, bank: bankId, empty: emptyId };
      });

      const beforeCards = await legacy.admin<{ id: string }>(
        `select id from public.vocabulary where user_id = $1 order by id`,
        [legacyAlice],
      );
      const beforeState = await legacy.admin<{ mastery: number; review_date: string }>(
        `select mastery, review_date::text from public.card_states where vocabulary_id = $1`,
        [candid],
      );
      const beforeLogs = await legacy.admin<{ id: string }>(
        `select id from public.review_logs where vocabulary_id = $1`,
        [candid],
      );

      await legacy.applyMigrations(LATEST);
      expect(await scalar(legacy, 'select public.app_schema_version()::text as value')).toBe(String(LATEST));

      // The words themselves are untouched — same ids, same content.
      const afterCards = await legacy.admin<{ id: string; word: string; meaning: string | null; definition: string | null; deleted_at: string | null }>(
        `select id, word, meaning, definition, deleted_at from public.vocabulary where user_id = $1 order by id`,
        [legacyAlice],
      );
      expect(afterCards.map((c) => c.id).sort()).toEqual(beforeCards.map((c) => c.id).sort());
      expect(afterCards.find((c) => c.word === 'candid')).toMatchObject({ meaning: 'thẳng thắn', definition: 'honest', deleted_at: null });
      expect(afterCards.find((c) => c.word === 'bank')?.deleted_at).not.toBeNull();

      // Backfill: every word with content gained exactly one live sense
      // carrying that content, the trashed word included; the empty word
      // gained none.
      const senses = await legacy.admin<{ word: string; position: number; meaning: string | null; definition: string | null; version: number; archived_at: string | null }>(
        `select v.word, s.position, s.meaning, s.definition, s.version, s.archived_at
           from public.vocabulary_senses s join public.vocabulary v on v.id = s.vocabulary_id
          where v.user_id = $1 order by v.word, s.position`,
        [legacyAlice],
      );
      expect(senses).toHaveLength(2);
      expect(senses.find((s) => s.word === 'candid')).toMatchObject({ position: 0, meaning: 'thẳng thắn', definition: 'honest', version: 1, archived_at: null });
      expect(senses.find((s) => s.word === 'bank')).toMatchObject({ position: 0, meaning: 'ngân hàng', version: 1, archived_at: null });
      // The word imported without content gained nothing to say.
      expect(await legacy.admin('select 1 from public.vocabulary_senses where vocabulary_id = $1', [empty])).toHaveLength(0);

      // Schedule and history survived untouched.
      expect(await legacy.admin('select mastery, review_date::text from public.card_states where vocabulary_id = $1', [candid])).toEqual(beforeState);
      expect(await legacy.admin<{ id: string }>('select id from public.review_logs where vocabulary_id = $1', [candid])).toEqual(beforeLogs);

      // The trashed word's senses can come back through the recovery call
      // after the word itself is restored — the recovery path end to end.
      await legacy.as(legacyAlice, (s) => s.query('update public.vocabulary set deleted_at = null where id = $1', [bank]));
      const resumed = await legacy.as(legacyAlice, (s) =>
        s.query<{ id: string; created: boolean }>(
          `select id, created from public.resume_vocabulary_sense($1::uuid, 'phía bờ', null, null, $2::uuid)`,
          [bank, crypto.randomUUID()],
        ),
      );
      expect(resumed[0]!.created).toBe(true);
      const bankSenses = await legacy.admin<{ n: string }>(
        `select count(*)::text as n from public.vocabulary_senses where vocabulary_id = $1 and archived_at is null`,
        [bank],
      );
      expect(bankSenses[0]!.n).toBe('2');
    } finally {
      await legacy.drop();
    }
  }, 120_000);
});

describe('compatibility in both directions', () => {
  it('runs the version 12 paths against the newest schema', async () => {
    const word = (
      await db.as(alice, (s) =>
        s.query<{ id: string }>(`insert into public.vocabulary (user_id, word, word_key, meaning) values ($1, 'candid', 'candid', 'thẳng thắn') returning id`, [alice]),
      )
    )[0]!.id;
    // The view joins the schedule for the card's mastery, as every word has.
    await db.as(alice, (s) => s.query('insert into public.card_states (user_id, vocabulary_id, mastery) values ($1, $2, 3)', [alice, word]));

    // Version 12 trashed and restored by writing the table itself; the view
    // splits and joins on that column, and the senses ride along untouched.
    await db.as(alice, (s) => s.query('update public.vocabulary set deleted_at = now() where id = $1', [word]));
    expect(await db.as(alice, (s) => s.query('select 1 from public.vocabulary_cards where id = $1 and deleted_at is null', [word]))).toHaveLength(0);
    expect(await db.as(alice, (s) => s.query('select 1 from public.vocabulary_cards where id = $1 and deleted_at is not null', [word]))).toHaveLength(1);
    await db.as(alice, (s) => s.query('update public.vocabulary set deleted_at = null where id = $1', [word]));

    // The version 13 edit path: update_vocabulary, one call, every reader
    // agreeing afterwards.
    const patched = await db.as(alice, (s) =>
      s.query<{ updated: boolean }>('select public.update_vocabulary($1::uuid, $2::jsonb) as updated', [word, JSON.stringify({ meaning: 'gan dạ', example: 'a candid remark' })]),
    );
    expect(patched[0]!.updated).toBe(true);
    const readers = await db.admin<{ legacy: string | null; sense: string | null }>(
      `select v.meaning as legacy, (select meaning from public.vocabulary_senses where vocabulary_id = v.id and archived_at is null order by position limit 1) as sense
         from public.vocabulary v where v.id = $1`,
      [word],
    );
    expect(readers[0]).toMatchObject({ legacy: 'gan dạ', sense: 'gan dạ' });

    // The version 12 reader: the columns it knew, from the view it knew.
    const oldReader = await db.as(alice, (s) =>
      s.query<{ word: string; meaning: string | null; example: string | null; mastery: number }>(
        'select word, meaning, definition, example, mastery, root_id, deleted_at from public.vocabulary_cards where id = $1',
        [word],
      ),
    );
    expect(oldReader[0]).toMatchObject({ word: 'candid', meaning: 'gan dạ', example: 'a candid remark', deleted_at: null });
  });

  it('answers a repeated submission id with the word that landed, as version 12 relied on', async () => {
    const request = crypto.randomUUID();
    // The exact twelve-positional-argument call version 12's gateway made.
    const create = (body: string) =>
      db.as(alice, (s) =>
        s.query<{ id: string; created: boolean }>(
          `select * from public.create_vocabulary(
             $1::text, $1::text, 3::smallint, $2::text, null::text, null::text,
             current_date, null::date, $3::uuid, null::text, null::text, null::timestamptz)`,
          ['lucid', body, request],
        ),
      );
    const first = await create('sáng suốt');
    const again = await create('a different body under the same id');
    expect(first[0]!.created).toBe(true);
    expect(again[0]).toEqual({ id: first[0]!.id, created: false });
  });

  it('tells the newer code what an older schema cannot do', async () => {
    const behind13 = await createReleaseDatabase('rel012_cap_behind13', { migrations: 13 });
    const behind14 = await createReleaseDatabase('rel012_cap_behind14', { migrations: 14 });
    const behind17 = await createReleaseDatabase('rel012_cap_behind17', { migrations: 17 });
    try {
      // At 13 the senses table exists but the atomic calls do not: exactly
      // where the store throws schema_missing instead of drifting.
      expect(await scalar(behind13, `select to_regclass('public.vocabulary_senses') is not null::text as value`)).toBe('true');
      expect(await scalar(behind13, `select count(*)::text as value from pg_proc where proname = 'add_vocabulary_sense'`)).toBe('0');
      expect(await scalar(behind13, `select count(*)::text as value from pg_proc where proname = 'update_vocabulary_sense'`)).toBe('0');
      expect(await scalar(behind13, `select count(*)::text as value from pg_proc where proname = 'resume_vocabulary_sense'`)).toBe('0');

      // At 14 the atomic sense calls exist; the version 15 pair does not.
      expect(await scalar(behind14, `select count(*)::text as value from pg_proc where proname = 'add_vocabulary_sense'`)).toBe('1');
      expect(await scalar(behind14, `select count(*)::text as value from pg_proc where proname = 'update_vocabulary_sense'`)).toBe('0');
      expect(await scalar(behind14, `select count(*)::text as value from pg_proc where proname = 'resume_vocabulary_sense'`)).toBe('0');

      // At 17 the vocabulary maps tables and their revision call do not
      // exist; version 18 is what adds them, so a store built at 17 must
      // report the feature as absent rather than reach for missing tables.
      expect(await scalar(behind17, `select to_regclass('public.vocabulary_maps') is not null::text as value`)).toBe('false');
      expect(await scalar(behind17, `select to_regclass('public.vocabulary_map_nodes') is not null::text as value`)).toBe('false');
      expect(await scalar(behind17, `select count(*)::text as value from pg_proc where proname = 'bump_vocabulary_map_revision'`)).toBe('0');
    } finally {
      await behind13.drop();
      await behind14.drop();
      await behind17.drop();
    }
  }, 120_000);

  it('detects every capability the same way the catalog holds it, at every version', async () => {
    // Each flag of capabilitiesAt, traced to the object its threshold
    // introduced: the claim the backend makes about a schema version, and
    // the schema itself, checked against each other at every step.
    const table = (name: string) => async (v: ReleaseDatabase) =>
      (await v.admin<{ value: boolean }>(`select to_regclass($1) is not null as value`, [`public.${name}`]))[0]!.value;
    const column = (tableName: string, columnName: string) => async (v: ReleaseDatabase) =>
      (
        await v.admin<{ value: boolean }>(
          `select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2) as value`,
          [tableName, columnName],
        )
      )[0]!.value;
    const function_ = (name: string) => async (v: ReleaseDatabase) =>
      (await v.admin<{ value: boolean }>(`select exists(select 1 from pg_proc where proname = $1) as value`, [name]))[0]!.value;
    const sensesCall = async (v: ReleaseDatabase) => function_('add_vocabulary_sense')(v);

    const predicates: Array<[keyof ReturnType<typeof capabilitiesAt>, (v: ReleaseDatabase) => Promise<boolean>]> = [
      ['sessions', table('study_sessions')],
      ['undo', column('review_logs', 'undoes_log_id')],
      // The FSRS shadow: the columns sat in the base table from version 1,
      // and version 3 carried them into the reader — so the view's column is
      // what the capability means.
      ['fsrs', column('vocabulary_cards', 'fsrs_due')],
      ['analytics', function_('review_daily_stats')],
      ['goals', column('user_settings', 'daily_goal_minutes')],
      ['confidence', column('review_logs', 'confidence')],
      ['practice', column('review_logs', 'answer_correct')],
      ['library', table('collections')],
      ['roots', column('vocabulary', 'root_id')],
      [
        'senses',
        async (v) => (await table('vocabulary_senses')(v)) && (await sensesCall(v)),
      ],
    ];

    for (let version = 1; version <= LATEST; version += 1) {
      const probe = await createReleaseDatabase(`rel012_caps_v${version}`, { migrations: version });
      try {
        const claimed = capabilitiesAt(version);
        for (const [flag, holds] of predicates) {
          expect(await holds(probe), `${flag} at schema ${version}`).toBe(claimed[flag]);
        }
      } finally {
        await probe.drop();
      }
    }
  }, 300_000);
});
