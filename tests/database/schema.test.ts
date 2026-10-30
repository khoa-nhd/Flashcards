/**
 * The database itself: schema, Row Level Security and the atomic functions,
 * run against a real PostgreSQL with the project's migrations applied. These
 * tests do not go through the application, so they hold whatever client talks
 * to the database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type Session, type TestDatabase } from '../helpers/test-database.js';

const RLS_DENIED = '42501';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

let db: TestDatabase;
let alice: string;
let bob: string;
let requestCounter = 0;

/** A fresh, valid request id for each call. */
const requestId = () => `00000000-0000-4000-8000-${String(++requestCounter).padStart(12, '0')}`;

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

interface NewWord {
  word?: string;
  mastery?: number;
  reviewDate?: string | null;
  request?: string | null;
  externalId?: string | null;
}

async function createWord(session: Session, options: NewWord = {}) {
  const word = options.word ?? 'candid';
  const rows = await session.query<{ id: string; created: boolean }>(
    `select * from public.create_vocabulary(
       p_word => $1, p_word_key => lower($1), p_mastery => $2::smallint, p_review_date => $3::date,
       p_request_id => $4::uuid, p_external_source => $5, p_external_id => $6)`,
    [
      word,
      options.mastery ?? 3,
      options.reviewDate === undefined ? '2026-10-09' : options.reviewDate,
      options.request ?? null,
      options.externalId ? 'notion' : null,
      options.externalId ?? null,
    ],
  );
  return rows[0]!;
}

const cards = (session: Session) =>
  session.query<{ id: string; word: string; mastery: number; review_date: string | null; deleted: boolean }>(
    `select id, word, mastery, review_date::text, deleted_at is not null as deleted
       from public.vocabulary_cards order by created_at, word`,
  );

interface ReviewArgs {
  id: string;
  request?: string;
  action?: string;
  expected: [mastery: number, reviewDate: string | null];
  next: [mastery: number, reviewDate: string | null];
}

async function review(session: Session, args: ReviewArgs) {
  const rows = await session.query<{ outcome: string; mastery: number | null; review_date: string | null }>(
    `select outcome, mastery, review_date::text from public.apply_review(
       p_vocabulary_id => $1::uuid, p_request_id => $2::uuid, p_action => $3,
       p_expected_mastery => $4::smallint, p_expected_review_date => $5::date,
       p_new_mastery => $6::smallint, p_new_review_date => $7::date,
       p_reviewed_on => '2026-10-10'::date, p_duration_ms => 4200)`,
    [args.id, args.request ?? requestId(), args.action ?? 'remember', args.expected[0], args.expected[1], args.next[0], args.next[1]],
  );
  return rows[0]!;
}

const count = async (table: string) =>
  Number((await db.admin<{ n: number }>(`select count(*)::int as n from public.${table}`))[0]!.n);

describe('schema', () => {
  it('has Row Level Security switched on for every table', async () => {
    const tables = await db.admin<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
    );
    expect(tables).toEqual([
      { relname: 'ai_conversations', relrowsecurity: true },
      { relname: 'ai_messages', relrowsecurity: true },
      { relname: 'ai_rate_limits', relrowsecurity: true },
      { relname: 'app_admins', relrowsecurity: true },
      { relname: 'blocks', relrowsecurity: true },
      { relname: 'card_states', relrowsecurity: true },
      { relname: 'challenges', relrowsecurity: true },
      { relname: 'collection_items', relrowsecurity: true },
      { relname: 'collections', relrowsecurity: true },
      { relname: 'follows', relrowsecurity: true },
      { relname: 'game_badges', relrowsecurity: true },
      { relname: 'game_events', relrowsecurity: true },
      { relname: 'game_freezes', relrowsecurity: true },
      { relname: 'game_quests', relrowsecurity: true },
      { relname: 'game_rewards', relrowsecurity: true },
      { relname: 'game_signing_key', relrowsecurity: true },
      { relname: 'game_state', relrowsecurity: true },
      { relname: 'inventory', relrowsecurity: true },
      { relname: 'invites', relrowsecurity: true },
      { relname: 'league_groups', relrowsecurity: true },
      { relname: 'league_members', relrowsecurity: true },
      { relname: 'league_tiers', relrowsecurity: true },
      { relname: 'public_profiles', relrowsecurity: true },
      { relname: 'reports', relrowsecurity: true },
      { relname: 'review_logs', relrowsecurity: true },
      { relname: 'stardust_ledger', relrowsecurity: true },
      { relname: 'study_days', relrowsecurity: true },
      { relname: 'study_sessions', relrowsecurity: true },
      { relname: 'user_settings', relrowsecurity: true },
      { relname: 'vocabulary', relrowsecurity: true },
      { relname: 'vocabulary_analysis', relrowsecurity: true },
      { relname: 'vocabulary_examples', relrowsecurity: true },
      { relname: 'vocabulary_relations', relrowsecurity: true },
      { relname: 'xp_ledger', relrowsecurity: true },
    ]);
  });

  it('gives signed-in users only the privileges the app needs', async () => {
    const can = async (role: string, table: string, privilege: string) =>
      (await db.admin<{ allowed: boolean }>('select has_table_privilege($1, $2, $3) as allowed', [role, `public.${table}`, privilege]))[0]!.allowed;

    for (const table of [
      'vocabulary',
      'card_states',
      'review_logs',
      'user_settings',
      'study_sessions',
      'vocabulary_cards',
      'effective_reviews',
    ]) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        expect(await can('anon', table, privilege), `anon ${privilege} ${table}`).toBe(false);
      }
      expect(await can('authenticated', table, 'TRUNCATE'), `truncate ${table}`).toBe(false);
    }
    // History is append-only at the privilege level, not just by policy.
    expect(await can('authenticated', 'review_logs', 'SELECT')).toBe(true);
    expect(await can('authenticated', 'review_logs', 'INSERT')).toBe(true);
    expect(await can('authenticated', 'review_logs', 'UPDATE')).toBe(false);
    expect(await can('authenticated', 'review_logs', 'DELETE')).toBe(false);
    expect(await can('authenticated', 'user_settings', 'DELETE')).toBe(false);
    expect(await can('authenticated', 'vocabulary_cards', 'INSERT')).toBe(false);
    expect(await can('authenticated', 'effective_reviews', 'SELECT')).toBe(true);
    expect(await can('authenticated', 'effective_reviews', 'INSERT')).toBe(false);
    expect(await can('authenticated', 'study_sessions', 'DELETE')).toBe(false);
    // The Add Word action may only change a message's own metadata.
    expect(await can('authenticated', 'ai_messages', 'UPDATE')).toBe(true);
    expect(await can('anon', 'ai_messages', 'UPDATE')).toBe(false);
    expect(await can('authenticated', 'ai_messages', 'DELETE')).toBe(false);
    // Nobody can remove a word or its state outright; the app only ever trashes.
    for (const table of ['vocabulary', 'card_states']) {
      expect(await can('authenticated', table, 'SELECT'), table).toBe(true);
      expect(await can('authenticated', table, 'INSERT'), table).toBe(true);
      expect(await can('authenticated', table, 'UPDATE'), table).toBe(true);
      expect(await can('authenticated', table, 'DELETE'), table).toBe(false);
    }
  });

  it('has a policy for every operation that is allowed, and for no other', async () => {
    const policies = await db.admin<{ tablename: string; cmd: string; roles: string }>(
      `select tablename, cmd, roles::text as roles from pg_policies where schemaname = 'public' order by tablename, cmd`,
    );
    // Words, their schedules and their history can never be deleted. Only the
    // organising tables (collections, further examples, links) allow it.
    expect(policies.map((policy) => `${policy.tablename} ${policy.cmd} ${policy.roles}`)).toEqual([
      'ai_conversations DELETE {authenticated}',
      'ai_conversations INSERT {authenticated}',
      'ai_conversations SELECT {authenticated}',
      'ai_conversations UPDATE {authenticated}',
      'ai_messages INSERT {authenticated}',
      'ai_messages SELECT {authenticated}',
      'ai_messages UPDATE {authenticated}',
      'ai_rate_limits INSERT {authenticated}',
      'ai_rate_limits SELECT {authenticated}',
      'ai_rate_limits UPDATE {authenticated}',
      // Competition: each account reads its own rows; others only through functions returning public columns.
      'blocks SELECT {authenticated}',
      'card_states INSERT {authenticated}',
      'card_states SELECT {authenticated}',
      'card_states UPDATE {authenticated}',
      'collection_items DELETE {authenticated}',
      'collection_items INSERT {authenticated}',
      'collection_items SELECT {authenticated}',
      'collections DELETE {authenticated}',
      'collections INSERT {authenticated}',
      'collections SELECT {authenticated}',
      'collections UPDATE {authenticated}',
      'follows SELECT {authenticated}',
      // The game is read only: it is written through signed changes alone (game_commit).
      'game_badges SELECT {authenticated}',
      // Events are read by everyone; only an admin's signed operation switches them.
      'game_events SELECT {authenticated}',
      'game_freezes SELECT {authenticated}',
      'game_quests SELECT {authenticated}',
      'game_rewards SELECT {authenticated}',
      'game_state SELECT {authenticated}',
      'inventory SELECT {authenticated}',
      'league_tiers SELECT {authenticated}',
      'public_profiles SELECT {authenticated}',
      'review_logs INSERT {authenticated}',
      'review_logs SELECT {authenticated}',
      'stardust_ledger SELECT {authenticated}',
      'study_days INSERT {authenticated}',
      'study_days SELECT {authenticated}',
      'study_days UPDATE {authenticated}',
      'study_sessions INSERT {authenticated}',
      'study_sessions SELECT {authenticated}',
      'study_sessions UPDATE {authenticated}',
      'user_settings INSERT {authenticated}',
      'user_settings SELECT {authenticated}',
      'user_settings UPDATE {authenticated}',
      'vocabulary INSERT {authenticated}',
      'vocabulary SELECT {authenticated}',
      'vocabulary UPDATE {authenticated}',
      'vocabulary_analysis DELETE {authenticated}',
      'vocabulary_analysis INSERT {authenticated}',
      'vocabulary_analysis SELECT {authenticated}',
      'vocabulary_analysis UPDATE {authenticated}',
      'vocabulary_examples DELETE {authenticated}',
      'vocabulary_examples INSERT {authenticated}',
      'vocabulary_examples SELECT {authenticated}',
      'vocabulary_examples UPDATE {authenticated}',
      'vocabulary_relations DELETE {authenticated}',
      'vocabulary_relations INSERT {authenticated}',
      'vocabulary_relations SELECT {authenticated}',
      'xp_ledger SELECT {authenticated}',
    ]);
  });

  it('keeps FSRS fields empty and separate from mastery', async () => {
    await db.as(alice, (s) => createWord(s));
    const [state] = await db.admin(
      `select scheduler, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_last_review, fsrs_reps, fsrs_lapses, fsrs_state, fsrs_version
         from public.card_states`,
    );
    expect(state).toEqual({
      scheduler: 'mastery_v1',
      fsrs_stability: null,
      fsrs_difficulty: null,
      fsrs_due: null,
      fsrs_last_review: null,
      fsrs_reps: null,
      fsrs_lapses: null,
      fsrs_state: null,
      fsrs_version: null,
    });
  });
});

describe('isolation between users', () => {
  it('shows each user only their own words, states and history', async () => {
    const mine = await db.as(alice, (s) => createWord(s, { word: 'alice-word' }));
    await db.as(bob, (s) => createWord(s, { word: 'bob-word' }));
    await db.as(alice, (s) => review(s, { id: mine.id, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));

    expect((await db.as(alice, cards)).map((card) => card.word)).toEqual(['alice-word']);
    expect((await db.as(bob, cards)).map((card) => card.word)).toEqual(['bob-word']);
    for (const table of ['vocabulary', 'card_states']) {
      expect(await db.as(bob, (s) => s.query(`select 1 from public.${table}`))).toHaveLength(1);
    }
    expect(await db.as(alice, (s) => s.query('select 1 from public.review_logs'))).toHaveLength(1);
    expect(await db.as(bob, (s) => s.query('select 1 from public.review_logs'))).toHaveLength(0);
  });

  it('gives a signed-out visitor nothing at all', async () => {
    const mine = await db.as(alice, (s) => createWord(s));
    for (const table of [
      'vocabulary',
      'card_states',
      'review_logs',
      'user_settings',
      'study_sessions',
      'vocabulary_cards',
      'effective_reviews',
    ]) {
      await expect(db.asAnon((s) => s.query(`select * from public.${table}`)), table).rejects.toMatchObject({ code: RLS_DENIED });
    }
    for (const call of [
      'public.app_schema_version()',
      `public.record_review('{}'::jsonb)`,
      `public.undo_review('${mine.id}'::uuid, '${mine.id}'::uuid)`,
      `public.session_summary('${mine.id}'::uuid)`,
      `public.mark_ai_message_saved('${mine.id}'::uuid, '${mine.id}'::uuid, '${mine.id}'::uuid)`,
    ]) {
      await expect(db.asAnon((s) => s.query(`select * from ${call}`)), call).rejects.toMatchObject({ code: RLS_DENIED });
    }
    await expect(db.asAnon((s) => createWord(s))).rejects.toMatchObject({ code: RLS_DENIED });
    await expect(
      db.asAnon((s) => review(s, { id: mine.id, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] })),
    ).rejects.toMatchObject({ code: RLS_DENIED });
    await expect(db.asAnon((s) => s.query(`select public.update_vocabulary($1::uuid, '{"word":"x"}')`, [mine.id]))).rejects.toMatchObject({
      code: RLS_DENIED,
    });
  });

  it("does not let one user change or delete another's rows", async () => {
    const mine = await db.as(alice, (s) => createWord(s));

    const updates = [
      `update public.vocabulary set word = 'hacked' where id = '${mine.id}' returning id`,
      `update public.vocabulary set deleted_at = now() where id = '${mine.id}' returning id`,
      `update public.card_states set mastery = 10 where vocabulary_id = '${mine.id}' returning vocabulary_id`,
    ];
    for (const sql of updates) {
      // RLS hides the row, so the statement succeeds and touches nothing.
      expect(await db.as(bob, (s) => s.query(sql)), sql).toEqual([]);
    }
    const deletes = [
      `delete from public.card_states where vocabulary_id = '${mine.id}'`,
      `delete from public.vocabulary where id = '${mine.id}'`,
      `delete from public.review_logs where vocabulary_id = '${mine.id}'`,
    ];
    for (const sql of deletes) {
      await expect(db.as(bob, (s) => s.query(sql)), sql).rejects.toMatchObject({ code: RLS_DENIED });
    }
    expect(await db.as(alice, cards)).toEqual([
      { id: mine.id, word: 'candid', mastery: 3, review_date: '2026-10-09', deleted: false },
    ]);
  });

  it('lets nobody remove a word outright, not even its owner', async () => {
    const mine = await db.as(alice, (s) => createWord(s));
    await db.as(alice, (s) => review(s, { id: mine.id, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    for (const sql of [
      `delete from public.vocabulary where id = '${mine.id}'`,
      `delete from public.card_states where vocabulary_id = '${mine.id}'`,
      'truncate public.vocabulary cascade',
    ]) {
      await expect(db.as(alice, (s) => s.query(sql)), sql).rejects.toMatchObject({ code: RLS_DENIED });
    }
    expect(await count('vocabulary')).toBe(1);
    expect(await count('card_states')).toBe(1);
    expect(await count('review_logs')).toBe(1);
  });

  it('rejects a row written under somebody else’s user id', async () => {
    await expect(
      db.as(bob, (s) => s.query(`insert into public.vocabulary (user_id, word, word_key) values ($1, 'x', 'x')`, [alice])),
    ).rejects.toMatchObject({ code: RLS_DENIED });
    await expect(
      db.as(bob, (s) => s.query(`insert into public.user_settings (user_id, time_zone) values ($1, 'UTC')`, [alice])),
    ).rejects.toMatchObject({ code: RLS_DENIED });
    expect(await count('vocabulary')).toBe(0);
    expect(await count('user_settings')).toBe(0);
  });

  it('cannot hand a row over to another user', async () => {
    const mine = await db.as(alice, (s) => createWord(s));
    await expect(
      db.as(alice, (s) => s.query('update public.card_states set user_id = $1 where vocabulary_id = $2', [bob, mine.id])),
    ).rejects.toMatchObject({ code: RLS_DENIED });
  });

  it('cannot attach a state or a review to another user’s word', async () => {
    const mine = await db.as(alice, (s) => createWord(s));
    await db.admin('delete from public.card_states');

    // Under Bob's own id the ownership foreign key refuses it…
    await expect(
      db.as(bob, (s) => s.query('insert into public.card_states (vocabulary_id, mastery) values ($1, 5)', [mine.id])),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    await expect(
      db.as(bob, (s) =>
        s.query(
          `insert into public.review_logs (vocabulary_id, request_id, action, reviewed_on, mastery_before, mastery_after)
           values ($1, $2, 'remember', '2026-10-10', 3, 4)`,
          [mine.id, requestId()],
        ),
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    // …and under Alice's id the policy does.
    await expect(
      db.as(bob, (s) => s.query('insert into public.card_states (vocabulary_id, user_id, mastery) values ($1, $2, 5)', [mine.id, alice])),
    ).rejects.toMatchObject({ code: RLS_DENIED });
    expect(await count('card_states')).toBe(0);
    expect(await count('review_logs')).toBe(0);
  });

  it('does not let the atomic functions reach another user’s word', async () => {
    const mine = await db.as(alice, (s) => createWord(s));

    expect(await db.as(bob, (s) => review(s, { id: mine.id, expected: [3, '2026-10-09'], next: [10, '2026-10-13'] }))).toEqual({
      outcome: 'not_found',
      mastery: null,
      review_date: null,
    });
    const edited = await db.as(bob, (s) =>
      s.query<{ ok: boolean }>(`select public.update_vocabulary($1::uuid, '{"word":"hacked","mastery":10}') as ok`, [mine.id]),
    );
    expect(edited).toEqual([{ ok: false }]);

    expect(await db.as(alice, cards)).toEqual([
      { id: mine.id, word: 'candid', mastery: 3, review_date: '2026-10-09', deleted: false },
    ]);
    expect(await count('review_logs')).toBe(0);
  });

  it('links a reply to the caller’s own word, and to nobody else’s', async () => {
    const mine = await db.as(alice, (s) => createWord(s));
    const [chat] = await db.as(alice, (s) =>
      s.query<{ id: string }>(`insert into public.ai_conversations (mode) values ('vocabulary_expert') returning id`),
    );
    const [replied] = await db.as(alice, (s) =>
      s.query<{ id: string }>(
        `insert into public.ai_messages (conversation_id, role, content, metadata)
         values ($1, 'assistant', 'hello', '{"model":"test"}') returning id`,
        [chat!.id],
      ),
    );
    const [asked] = await db.as(alice, (s) =>
      s.query<{ id: string }>(
        `insert into public.ai_messages (conversation_id, role, content) values ($1, 'user', 'hi') returning id`,
        [chat!.id],
      ),
    );

    const mark = (user: string, conversation: string, message: string, word: string) =>
      db.as(user, (s) =>
        s.query<{ ok: boolean }>(`select public.mark_ai_message_saved($1::uuid, $2::uuid, $3::uuid) as ok`, [conversation, message, word]),
      );

    // The word is recorded on the reply; whatever else was in the metadata stays.
    expect(await mark(alice, chat!.id, replied!.id, mine.id)).toEqual([{ ok: true }]);
    const [stored] = await db.as(alice, (s) =>
      s.query<{ metadata: Record<string, unknown> }>(`select metadata from public.ai_messages where id = $1`, [replied!.id]),
    );
    expect(stored!.metadata).toMatchObject({ model: 'test', vocabularyId: mine.id });
    expect(typeof stored!.metadata.savedAt).toBe('string');

    // A question is not a reply, a reply belongs to one conversation, and a word
    // has to exist: none of these is an error, they just record nothing.
    expect(await mark(alice, chat!.id, asked!.id, mine.id)).toEqual([{ ok: false }]);
    expect(await mark(alice, '00000000-0000-4000-8000-000000000009', replied!.id, mine.id)).toEqual([{ ok: false }]);
    await expect(mark(alice, chat!.id, replied!.id, '00000000-0000-4000-8000-00000000000a')).rejects.toMatchObject({
      code: RLS_DENIED,
    });

    // Bob's own word cannot point at Alice's reply, and Alice's word is not his to use.
    const bobsWord = await db.as(bob, (s) => createWord(s, { word: 'tide' }));
    expect(await mark(bob, chat!.id, replied!.id, bobsWord.id)).toEqual([{ ok: false }]);
    await expect(mark(bob, chat!.id, replied!.id, mine.id)).rejects.toMatchObject({ code: RLS_DENIED });
    expect(
      await db.as(bob, (s) =>
        s.query(`update public.ai_messages set metadata = metadata || '{"sneaky":true}' where id = $1 returning id`, [replied!.id]),
      ),
    ).toEqual([]);

    // …and nothing any of them did left a mark on the reply.
    const [after] = await db.as(alice, (s) =>
      s.query<{ metadata: Record<string, unknown> }>(`select metadata from public.ai_messages where id = $1`, [replied!.id]),
    );
    expect(after!.metadata).toMatchObject({ model: 'test', vocabularyId: mine.id });
    expect(after!.metadata).not.toHaveProperty('sneaky');
  });

  it('keeps settings private and one row per user', async () => {
    await db.as(alice, (s) => s.query(`insert into public.user_settings (time_zone) values ('Asia/Ho_Chi_Minh')`));
    await db.as(bob, (s) => s.query(`insert into public.user_settings (time_zone) values ('Europe/Paris')`));
    expect(await db.as(alice, (s) => s.query('select time_zone from public.user_settings'))).toEqual([
      { time_zone: 'Asia/Ho_Chi_Minh' },
    ]);
    expect(await db.as(bob, (s) => s.query(`update public.user_settings set time_zone = 'UTC' where user_id = $1 returning 1`, [alice]))).toEqual([]);
    await expect(db.as(alice, (s) => s.query(`insert into public.user_settings (time_zone) values ('UTC')`))).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('removes everything a user owns when the account is deleted, and nothing else', async () => {
    const mine = await db.as(alice, (s) => createWord(s));
    await db.as(alice, (s) => review(s, { id: mine.id, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    await db.as(alice, (s) => s.query(`insert into public.user_settings (time_zone) values ('UTC')`));
    await db.as(bob, (s) => createWord(s, { word: 'bob-word' }));

    await db.admin('delete from auth.users where id = $1', [alice]);
    expect(await count('vocabulary')).toBe(1);
    expect(await count('card_states')).toBe(1);
    expect(await count('review_logs')).toBe(0);
    expect(await count('user_settings')).toBe(0);
    expect((await db.as(bob, cards)).map((card) => card.word)).toEqual(['bob-word']);
  });
});

describe('create_vocabulary', () => {
  it('creates the word and its scheduling state together, owned by the caller', async () => {
    const made = await db.as(alice, (s) => createWord(s, { word: 'Luminous', mastery: 1, reviewDate: null }));
    expect(made.created).toBe(true);
    const [row] = await db.admin(
      `select v.user_id, v.word, v.word_key, c.user_id as state_owner, c.mastery, c.review_date
         from public.vocabulary v join public.card_states c on c.vocabulary_id = v.id`,
    );
    expect(row).toEqual({ user_id: alice, word: 'Luminous', word_key: 'luminous', state_owner: alice, mastery: 1, review_date: null });
  });

  it('returns the first word again for a repeated request id', async () => {
    const request = requestId();
    const first = await db.as(alice, (s) => createWord(s, { request }));
    const again = await db.as(alice, (s) => createWord(s, { request }));
    expect(again).toEqual({ id: first.id, created: false });
    expect(await count('vocabulary')).toBe(1);
    expect(await count('card_states')).toBe(1);
  });

  it('makes a repeated import a no-op', async () => {
    const first = await db.as(alice, (s) => createWord(s, { externalId: 'page-1', mastery: 7 }));
    // The same source row again, with different values: the stored word wins.
    const again = await db.as(alice, (s) => createWord(s, { externalId: 'page-1', mastery: 2, word: 'changed' }));
    expect(again).toEqual({ id: first.id, created: false });
    expect(await db.as(alice, cards)).toEqual([expect.objectContaining({ word: 'candid', mastery: 7 })]);
  });

  it('lets two users import the same source id independently', async () => {
    await db.as(alice, (s) => createWord(s, { externalId: 'page-1' }));
    const other = await db.as(bob, (s) => createWord(s, { externalId: 'page-1' }));
    expect(other.created).toBe(true);
    expect(await count('vocabulary')).toBe(2);
  });

  it('allows a deliberate duplicate word', async () => {
    await db.as(alice, (s) => createWord(s, { word: 'bank' }));
    await db.as(alice, (s) => createWord(s, { word: 'bank' }));
    expect(await count('vocabulary')).toBe(2);
  });

  it('creates nothing at all when the state is invalid', async () => {
    await expect(db.as(alice, (s) => createWord(s, { mastery: 11 }))).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(db.as(alice, (s) => createWord(s, { mastery: -1 }))).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(db.as(alice, (s) => createWord(s, { word: '   ' }))).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(await count('vocabulary')).toBe(0);
    expect(await count('card_states')).toBe(0);
  });
});

describe('apply_review', () => {
  let word: string;
  beforeEach(async () => {
    word = (await db.as(alice, (s) => createWord(s, { mastery: 3, reviewDate: '2026-10-09' }))).id;
  });

  it('updates the state and appends one history row', async () => {
    const result = await db.as(alice, (s) => review(s, { id: word, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    expect(result).toEqual({ outcome: 'applied', mastery: 4, review_date: '2026-10-13' });

    const [log] = await db.admin(
      `select user_id, vocabulary_id, action, review_mode, reviewed_on::text, duration_ms, mastery_before, mastery_after,
              review_date_before::text, review_date_after::text, scheduler, reviewed_at is not null as stamped
         from public.review_logs`,
    );
    expect(log).toEqual({
      user_id: alice,
      vocabulary_id: word,
      action: 'remember',
      review_mode: 'flashcard',
      reviewed_on: '2026-10-10',
      duration_ms: 4200,
      mastery_before: 3,
      mastery_after: 4,
      review_date_before: '2026-10-09',
      review_date_after: '2026-10-13',
      scheduler: 'mastery_v1',
      stamped: true,
    });
  });

  it('does not apply a retried request a second time', async () => {
    const request = requestId();
    const args = { id: word, request, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] } satisfies ReviewArgs;
    await db.as(alice, (s) => review(s, args));
    const retry = await db.as(alice, (s) => review(s, args));

    expect(retry).toEqual({ outcome: 'already_applied', mastery: 4, review_date: '2026-10-13' });
    expect(await count('review_logs')).toBe(1);
    expect((await db.as(alice, cards))[0]).toMatchObject({ mastery: 4, review_date: '2026-10-13' });
  });

  it('reports the recorded result of a retried request even after the word moved on', async () => {
    const request = requestId();
    await db.as(alice, (s) => review(s, { id: word, request, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    await db.as(alice, (s) => review(s, { id: word, expected: [4, '2026-10-13'], next: [5, '2026-10-14'] }));

    const retry = await db.as(alice, (s) => review(s, { id: word, request, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    expect(retry).toEqual({ outcome: 'already_applied', mastery: 4, review_date: '2026-10-13' });
    expect((await db.as(alice, cards))[0]).toMatchObject({ mastery: 5, review_date: '2026-10-14' });
    expect(await count('review_logs')).toBe(2);
  });

  it('lets only the first of two devices answer the same card', async () => {
    // Both devices loaded the card at mastery 3.
    const first = await db.as(alice, (s) => review(s, { id: word, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    const second = await db.as(alice, (s) =>
      review(s, { id: word, action: 'not_remember', expected: [3, '2026-10-09'], next: [3, '2026-10-11'] }),
    );

    expect(first.outcome).toBe('applied');
    // The second is told what the card holds now, and changes nothing.
    expect(second).toEqual({ outcome: 'conflict', mastery: 4, review_date: '2026-10-13' });
    expect((await db.as(alice, cards))[0]).toMatchObject({ mastery: 4, review_date: '2026-10-13' });
    expect(await count('review_logs')).toBe(1);
  });

  it('treats an empty review date as a value to match, not a wildcard', async () => {
    const undated = (await db.as(alice, (s) => createWord(s, { word: 'new', mastery: 1, reviewDate: null }))).id;
    expect(
      (await db.as(alice, (s) => review(s, { id: undated, expected: [1, '2026-10-09'], next: [2, '2026-10-11'] }))).outcome,
    ).toBe('conflict');
    expect(
      await db.as(alice, (s) => review(s, { id: undated, expected: [1, null], next: [2, '2026-10-11'] })),
    ).toEqual({ outcome: 'applied', mastery: 2, review_date: '2026-10-11' });
  });

  it('reports an unknown or trashed word as not found', async () => {
    const missing = await db.as(alice, (s) =>
      review(s, { id: '99999999-9999-4999-8999-999999999999', expected: [3, null], next: [4, null] }),
    );
    expect(missing.outcome).toBe('not_found');

    await db.as(alice, (s) => s.query('update public.vocabulary set deleted_at = now() where id = $1', [word]));
    const trashed = await db.as(alice, (s) => review(s, { id: word, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    expect(trashed.outcome).toBe('not_found');
    expect(await count('review_logs')).toBe(0);
  });

  it('changes nothing when the history row cannot be written', async () => {
    await expect(
      db.as(alice, (s) => review(s, { id: word, action: 'skip', expected: [3, '2026-10-09'], next: [4, '2026-10-13'] })),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // The state update in the same call was rolled back with it.
    expect((await db.as(alice, cards))[0]).toMatchObject({ mastery: 3, review_date: '2026-10-09' });
    expect(await count('review_logs')).toBe(0);
  });

  it('refuses a mastery outside 0 to 10', async () => {
    await expect(
      db.as(alice, (s) => review(s, { id: word, expected: [3, '2026-10-09'], next: [11, '2026-10-13'] })),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await db.as(alice, cards))[0]).toMatchObject({ mastery: 3 });
  });

  it('keeps history append-only, even for its owner', async () => {
    await db.as(alice, (s) => review(s, { id: word, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    await expect(db.as(alice, (s) => s.query('update public.review_logs set mastery_after = 10'))).rejects.toMatchObject({
      code: RLS_DENIED,
    });
    await expect(db.as(alice, (s) => s.query('delete from public.review_logs'))).rejects.toMatchObject({ code: RLS_DENIED });
    expect(await count('review_logs')).toBe(1);
  });

  it('rejects the same request id used for two different answers', async () => {
    const request = requestId();
    const other = (await db.as(alice, (s) => createWord(s, { word: 'other' }))).id;
    await db.as(alice, (s) => review(s, { id: word, request, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    // A second word under an id already spent: reported as done, the word untouched.
    const reused = await db.as(alice, (s) => review(s, { id: other, request, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    expect(reused.outcome).toBe('already_applied');
    expect((await db.as(alice, cards)).find((card) => card.id === other)).toMatchObject({ mastery: 3 });
  });

  it('lets two users use the same request id without interfering', async () => {
    const request = requestId();
    const theirs = (await db.as(bob, (s) => createWord(s, { word: 'bob-word' }))).id;
    await db.as(alice, (s) => review(s, { id: word, request, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    const result = await db.as(bob, (s) => review(s, { id: theirs, request, expected: [3, '2026-10-09'], next: [4, '2026-10-13'] }));
    expect(result.outcome).toBe('applied');
    expect(await count('review_logs')).toBe(2);
  });
});

describe('update_vocabulary', () => {
  let word: string;
  const patch = (session: Session, id: string, changes: object) =>
    session.query<{ ok: boolean }>('select public.update_vocabulary($1::uuid, $2::jsonb) as ok', [id, JSON.stringify(changes)]);
  const stored = async () =>
    (
      await db.admin(
        `select v.word, v.word_key, v.meaning, v.definition, v.example, v.date_added::text, c.mastery, c.review_date::text
           from public.vocabulary v join public.card_states c on c.vocabulary_id = v.id where v.id = $1`,
        [word],
      )
    )[0];

  beforeEach(async () => {
    word = (await db.as(alice, (s) => createWord(s))).id;
    await db.admin(`update public.vocabulary set meaning = 'thẳng thắn', definition = 'honest', date_added = '2026-10-01'`);
  });

  it('writes only the keys given', async () => {
    expect(await db.as(alice, (s) => patch(s, word, { definition: 'honest and direct' }))).toEqual([{ ok: true }]);
    expect(await stored()).toEqual({
      word: 'candid',
      word_key: 'candid',
      meaning: 'thẳng thắn',
      definition: 'honest and direct',
      example: null,
      date_added: '2026-10-01',
      mastery: 3,
      review_date: '2026-10-09',
    });
  });

  it('clears a value given as null', async () => {
    await db.as(alice, (s) => patch(s, word, { meaning: null, date_added: null }));
    expect(await stored()).toMatchObject({ meaning: null, date_added: null, definition: 'honest' });
  });

  it('changes the schedule only when asked to', async () => {
    await db.as(alice, (s) => patch(s, word, { example: 'A candid answer.' }));
    expect(await stored()).toMatchObject({ mastery: 3, review_date: '2026-10-09' });
    await db.as(alice, (s) => patch(s, word, { mastery: 6, review_date: null }));
    expect(await stored()).toMatchObject({ mastery: 6, review_date: null, example: 'A candid answer.' });
  });

  it('applies a mixed edit completely or not at all', async () => {
    await expect(db.as(alice, (s) => patch(s, word, { word: 'renamed', word_key: 'renamed', mastery: 42 }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    expect(await stored()).toMatchObject({ word: 'candid', mastery: 3 });
  });

  it('rejects a field it does not manage', async () => {
    await expect(db.as(alice, (s) => patch(s, word, { user_id: bob }))).rejects.toMatchObject({ code: '22023' });
    await expect(db.as(alice, (s) => patch(s, word, { deleted_at: null }))).rejects.toMatchObject({ code: '22023' });
  });

  it('reports a missing or trashed word', async () => {
    expect(await db.as(alice, (s) => patch(s, '99999999-9999-4999-8999-999999999999', { word: 'x' }))).toEqual([{ ok: false }]);
    await db.admin('update public.vocabulary set deleted_at = now()');
    expect(await db.as(alice, (s) => patch(s, word, { word: 'x' }))).toEqual([{ ok: false }]);
    expect(await db.as(alice, (s) => patch(s, word, { mastery: 9 }))).toEqual([{ ok: false }]);
    expect(await stored()).toMatchObject({ word: 'candid', mastery: 3 });
  });
});

describe('trash and timestamps', () => {
  it('keeps a trashed word and its state, and brings both back on restore', async () => {
    const word = (await db.as(alice, (s) => createWord(s, { mastery: 7 }))).id;
    await db.as(alice, (s) => s.query('update public.vocabulary set deleted_at = now() where id = $1', [word]));
    expect(await db.as(alice, cards)).toEqual([expect.objectContaining({ id: word, mastery: 7, deleted: true })]);

    await db.as(alice, (s) => s.query('update public.vocabulary set deleted_at = null where id = $1', [word]));
    expect(await db.as(alice, cards)).toEqual([expect.objectContaining({ id: word, mastery: 7, deleted: false })]);
  });

  it('stamps every change with the time it was made', async () => {
    const word = (await db.as(alice, (s) => createWord(s))).id;
    await db.admin(`update public.vocabulary set updated_at = '2020-01-01' where id = $1`, [word]);
    await db.admin(`alter table public.vocabulary disable trigger vocabulary_touch`);
    await db.admin(`update public.vocabulary set updated_at = '2020-01-01' where id = $1`, [word]);
    await db.admin(`alter table public.vocabulary enable trigger vocabulary_touch`);
    await db.as(alice, (s) => s.query(`select public.update_vocabulary($1::uuid, '{"meaning":"x"}')`, [word]));
    const [row] = await db.admin<{ fresh: boolean; utc: string }>(
      `select updated_at > now() - interval '1 minute' as fresh, to_char(created_at at time zone 'UTC', 'YYYY') as utc
         from public.vocabulary where id = $1`,
      [word],
    );
    expect(row?.fresh).toBe(true);
  });
});
