/**
 * The vocabulary maps tables themselves — schema version 18 — held against
 * PostgreSQL directly, without the application in between: row-level
 * ownership, the checks that keep a saved node free of stored text and a
 * candidate free of word references, the combinations each table allows only
 * once, the cascades (a deleted map removes map data only; a deleted word
 * removes its nodes), the grants, and the one-call revision bump. Whatever
 * the service claims to refuse, these tests show the database refusing too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION } from '../../server/supabase/supabase-database.js';
import { createTestDatabase, type Row, type TestDatabase } from '../helpers/test-database.js';

const RLS_DENIED = '42501';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

let db: TestDatabase;
let alice: string;
let bob: string;
let word: string;
let map: string;

/** One word for alice, written straight to the table the way the app's own writers do. */
const createWord = async (owner: string, text: string): Promise<string> =>
  (
    await db.as(owner, (s) =>
      s.query<{ id: string }>('insert into public.vocabulary (user_id, word, word_key) values ($1, $2, $2) returning id', [owner, text]),
    )
  )[0]!.id;

const createMap = async (owner: string, type = 'semantic'): Promise<string> =>
  (
    await db.as(owner, (s) =>
      s.query<{ id: string }>('insert into public.vocabulary_maps (user_id, type, title) values ($1, $2, $3) returning id', [
        owner,
        type,
        'A map',
      ]),
    )
  )[0]!.id;

const addNode = <T extends Row = { id: string }>(owner: string, sql: string, params: unknown[]) => db.as(owner, (s) => s.query<T>(sql, params));

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
  word = await createWord(alice, 'candid');
  map = await createMap(alice);
});

describe('the version and the privileges', () => {
  it('reports the newest schema version, above the one that has these tables', async () => {
    const [row] = await db.admin<{ version: number }>('select public.app_schema_version() as version');
    // Version 18 introduced these tables; the version function now reports
    // whatever the newest migration says (19 for discovery content).
    expect(row!.version).toBe(LATEST_SCHEMA_VERSION);
    expect(row!.version).toBeGreaterThanOrEqual(18);
  });

  it('grants the signed-in role the four operations, and a visitor nothing', async () => {
    const can = async (role: string, table: string, privilege: string) =>
      (
        await db.admin<{ allowed: boolean }>('select has_table_privilege($1, $2, $3) as allowed', [
          role,
          `public.${table}`,
          privilege,
        ])
      )[0]!.allowed;
    for (const table of ['vocabulary_maps', 'vocabulary_map_nodes', 'vocabulary_map_edges']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await can('authenticated', table, privilege), `${table} ${privilege}`).toBe(true);
        expect(await can('anon', table, privilege), `anon ${table} ${privilege}`).toBe(false);
      }
      expect(await can('authenticated', table, 'TRUNCATE'), `truncate ${table}`).toBe(false);
    }
    const grants = await db.admin<{ auth: boolean; anon: boolean }>(
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'bump_vocabulary_map_revision'`,
    );
    expect(grants[0]).toEqual({ auth: true, anon: false });
  });
});

describe("one reader's maps are nobody else's", () => {
  it('shows another account nothing, and lets it change nothing', async () => {
    await addNode(
      alice,
      `insert into public.vocabulary_map_nodes (user_id, map_id, kind, label) values ($1, $2, 'candidate', 'frank') returning id`,
      [alice, map],
    );
    expect(await db.as(bob, (s) => s.query('select id from public.vocabulary_maps'))).toHaveLength(0);
    expect(await db.as(bob, (s) => s.query('select id from public.vocabulary_map_nodes'))).toHaveLength(0);
    // The statements succeed and touch nothing: the rows are not visible to update or delete.
    expect(await db.as(bob, (s) => s.query(`update public.vocabulary_maps set title = 'taken' where id = $1 returning id`, [map]))).toEqual([]);
    expect(await db.as(bob, (s) => s.query('delete from public.vocabulary_map_nodes where map_id = $1', [map]))).toEqual([]);
  });

  it("refuses a node pointed at another account's map or word", async () => {
    const bobsWord = await createWord(bob, 'bobs');
    // Not their map: the composite key (map_id, user_id) has no such row.
    await expect(
      addNode(bob, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, label) values ($1, $2, 'candidate', 'x')`, [bob, map]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    // Their map, but alice's word: the vocabulary key has no such row either.
    await expect(
      addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id) values ($1, $2, 'saved', $3)`, [
        alice,
        map,
        bobsWord,
      ]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });

  it('answers a visitor with a permission error, on reading and on bumping', async () => {
    await expect(db.asAnon((s) => s.query('select id from public.vocabulary_maps'))).rejects.toMatchObject({ code: RLS_DENIED });
    await expect(db.asAnon((s) => s.query('select * from public.bump_vocabulary_map_revision($1)', [map]))).rejects.toMatchObject({
      code: RLS_DENIED,
    });
  });
});

describe('the line between a saved word and a suggestion, held by the table', () => {
  it('stores no text beside a saved node, and no word behind a suggestion', async () => {
    // A saved node naming its word but carrying text: refused.
    await expect(
      addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id, label) values ($1, $2, 'saved', $3, 'candid')`, [
        alice,
        map,
        word,
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // A saved node with no word at all: refused.
    await expect(
      addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id) values ($1, $2, 'saved', null)`, [alice, map]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // A suggestion carrying a word id: refused.
    await expect(
      addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id, label) values ($1, $2, 'candidate', $3, 'frank')`, [
        alice,
        map,
        word,
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // A suggestion with no text: refused.
    await expect(
      addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, label) values ($1, $2, 'candidate', null)`, [alice, map]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // A sense chosen without the word it belongs to: refused.
    await expect(
      addNode(
        alice,
        `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id, sense_id, label) values ($1, $2, 'candidate', $3, gen_random_uuid(), 'x')`,
        [alice, map, word],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('has no stored personal map: the type list does not contain it', async () => {
    await expect(createMap(alice, 'personal')).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('insists a relationship is of a kind the schema knows, and never a node to itself', async () => {
    const first = (
      await addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, label) values ($1, $2, 'candidate', 'a') returning id`, [
        alice,
        map,
      ])
    )[0]!.id;
    const second = (
      await addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, label) values ($1, $2, 'candidate', 'b') returning id`, [
        alice,
        map,
      ])
    )[0]!.id;
    await expect(
      db.as(alice, (s) =>
        s.query('insert into public.vocabulary_map_edges (user_id, map_id, from_node_id, to_node_id, kind) values ($1, $2, $3, $4, $5)', [
          alice,
          map,
          first,
          second,
          'best_friends',
        ]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      db.as(alice, (s) =>
        s.query('insert into public.vocabulary_map_edges (user_id, map_id, from_node_id, to_node_id, kind) values ($1, $2, $3, $3, $4)', [
          alice,
          map,
          first,
          'synonym',
        ]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('pins a sense node to the very word and account the sense belongs to', async () => {
    const bobsWord = await createWord(bob, 'bobs');
    const bobsSense = (
      await db.as(bob, (s) =>
        s.query<{ id: string }>(
          `insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning) values ($1, $2, 0, 'their meaning') returning id`,
          [bob, bobsWord],
        ),
      )
    )[0]!.id;
    // Alice's map and alice's word, but bob's sense: no such (sense, word, user) row.
    await expect(
      addNode(
        alice,
        `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id, sense_id, label) values ($1, $2, 'saved', $3, $4, null)`,
        [alice, map, word, bobsSense],
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    // The triple key that makes that promise is on the senses table.
    const indexes = await db.admin<{ indexdef: string }>(
      `select pg_get_indexdef(i.indexrelid) as indexdef from pg_index i
         join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'vocabulary_senses'`,
    );
    expect(indexes.map((row) => row.indexdef).join('\n')).toContain('(id, vocabulary_id, user_id)');
  });
});

describe('each kind of thing appears on a map only once', () => {
  it('holds one node per word, one per suggestion, one link per pair and kind', async () => {
    const saved = `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id) values ($1, $2, 'saved', $3)`;
    await addNode(alice, saved, [alice, map, word]);
    await expect(addNode(alice, saved, [alice, map, word])).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    const suggestion = `insert into public.vocabulary_map_nodes (user_id, map_id, kind, label) values ($1, $2, 'candidate', 'frank')`;
    await addNode(alice, suggestion, [alice, map]);
    await expect(addNode(alice, suggestion, [alice, map])).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    const [lucidRow] = await addNode(
      alice,
      `insert into public.vocabulary_map_nodes (user_id, map_id, kind, label) values ($1, $2, 'candidate', 'lucid') returning id`,
      [alice, map],
    );
    const lucid = lucidRow!.id;
    const savedNode = await savedId();
    const link = `insert into public.vocabulary_map_edges (user_id, map_id, from_node_id, to_node_id, kind) values ($1, $2, $3, $4, 'synonym')`;
    await db.as(alice, (s) => s.query(link, [alice, map, savedNode, lucid]));
    await expect(db.as(alice, (s) => s.query(link, [alice, map, savedNode, lucid]))).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
    // The same pair under another kind is another relationship: allowed.
    await db.as(alice, (s) =>
      s.query(
        `insert into public.vocabulary_map_edges (user_id, map_id, from_node_id, to_node_id, kind) values ($1, $2, $3, $4, 'antonym')`,
        [alice, map, savedNode, lucid],
      ),
    );
  });

  it('lets one submission id land once per account, and twice across accounts', async () => {
    const request = '00000000-0000-4000-8000-000000000099';
    const insert = (owner: string) =>
      db.as(owner, (s) =>
        s.query('insert into public.vocabulary_maps (user_id, type, title, request_id) values ($1, $2, $3, $4) returning id', [
          owner,
          'semantic',
          'Once',
          request,
        ]),
      );
    await insert(alice);
    await expect(insert(alice)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    // Another account's submission id is their own: it lands.
    expect(await insert(bob)).toHaveLength(1);
  });
});

describe('deleting removes the diagram or the word, and only what that means', () => {
  it('removing a map takes its nodes and links with it, and leaves every word standing', async () => {
    await addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id) values ($1, $2, 'saved', $3)`, [
      alice,
      map,
      word,
    ]);
    const node = (
      await db.as(alice, (s) => s.query<{ id: string }>('select id from public.vocabulary_map_nodes where map_id = $1', [map]))
    )[0]!.id;
    const other = await createWord(alice, 'lucid');
    const [otherRow] = await addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id) values ($1, $2, 'saved', $3) returning id`, [
      alice,
      map,
      other,
    ]);
    const otherNode = otherRow!.id;
    await db.as(alice, (s) =>
      s.query('insert into public.vocabulary_map_edges (user_id, map_id, from_node_id, to_node_id, kind) values ($1, $2, $3, $4, $5)', [
        alice,
        map,
        node,
        otherNode,
        'synonym',
      ]),
    );

    expect(await db.as(alice, (s) => s.query('delete from public.vocabulary_maps where id = $1 returning id', [map]))).toHaveLength(1);
    expect(await db.as(alice, (s) => s.query('select id from public.vocabulary_map_nodes'))).toHaveLength(0);
    expect(await db.as(alice, (s) => s.query('select id from public.vocabulary_map_edges'))).toHaveLength(0);
    // Both words are untouched: the diagram held references, not copies.
    const words = await db.as(alice, (s) => s.query<{ word: string }>('select word from public.vocabulary order by word'));
    expect(words.map((row) => row.word)).toEqual(['candid', 'lucid']);
  });

  it('removing a word takes its nodes from every map, and the map itself stays', async () => {
    await addNode(alice, `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id) values ($1, $2, 'saved', $3)`, [
      alice,
      map,
      word,
    ]);
    const node = (
      await db.as(alice, (s) => s.query<{ id: string }>('select id from public.vocabulary_map_nodes where map_id = $1', [map]))
    )[0]!.id;
    const companion = await createWord(alice, 'lucid');
    const [companionRow] = await addNode(
      alice,
      `insert into public.vocabulary_map_nodes (user_id, map_id, kind, vocabulary_id) values ($1, $2, 'saved', $3) returning id`,
      [alice, map, companion],
    );
    const companionNode = companionRow!.id;
    await db.as(alice, (s) =>
      s.query('insert into public.vocabulary_map_edges (user_id, map_id, from_node_id, to_node_id, kind) values ($1, $2, $3, $4, $5)', [
        alice,
        map,
        node,
        companionNode,
        'related',
      ]),
    );

    // A word's row goes only through the account's own lifecycle (trash), but
    // even a hard delete — which only an admin can do — is defined here: the
    // node is removed, its links with it, the map and the other words stay.
    await db.admin('delete from public.vocabulary where id = $1', [word]);
    expect(await db.as(alice, (s) => s.query('select id from public.vocabulary_map_nodes where vocabulary_id is not null'))).toHaveLength(1);
    expect(await db.as(alice, (s) => s.query('select id from public.vocabulary_map_edges'))).toHaveLength(0);
    expect(await db.as(alice, (s) => s.query('select id from public.vocabulary_maps where id = $1', [map]))).toHaveLength(1);
  });
});

describe('the revision call moves one map, once, for its owner', () => {
  it('increments and returns the row, and answers nothing for anyone else', async () => {
    const bump = (owner: string, target: string) =>
      db.as(owner, (s) => s.query<{ id: string | null; revision: number | null }>('select * from public.bump_vocabulary_map_revision($1)', [target]));
    const [first] = await bump(alice, map);
    expect(first!.revision).toBe(2);
    const [second] = await bump(alice, map);
    expect(second!.revision).toBe(3);
    // Bob's call on alice's map matches no row under RLS. A composite-returning
    // function still answers with a row, every field null — which both stores
    // read as "nothing moved", and which nothing could mistake for a revision.
    const [blocked] = await bump(bob, map);
    expect(blocked!.id).toBeNull();
    expect(blocked!.revision).toBeNull();
    const [still] = await db.as(alice, (s) => s.query<{ revision: number }>('select revision from public.vocabulary_maps where id = $1', [map]));
    expect(still!.revision).toBe(3);
  });

  it('holds the map to a sane shape: type, title and revision ranges', async () => {
    await expect(
      db.as(alice, (s) => s.query('insert into public.vocabulary_maps (user_id, type, title) values ($1, $2, $3)', [alice, 'diary', 'x'])),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      db.as(alice, (s) => s.query('insert into public.vocabulary_maps (user_id, type, title) values ($1, $2, $3)', [alice, 'semantic', '   '])),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      db.as(alice, (s) =>
        s.query('insert into public.vocabulary_maps (user_id, type, title, revision) values ($1, $2, $3, $4)', [alice, 'semantic', 'x', 0]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

/** The id of the saved node alice's map gained in this test. */
async function savedId(): Promise<string> {
  const rows = await db.as(alice, (s) => s.query<{ id: string }>("select id from public.vocabulary_map_nodes where kind = 'saved'"));
  return rows[0]!.id;
}
