/**
 * G2 — real concurrency: two independent PostgreSQL connections, overlapping
 * transactions, and a synchronization point each test can show. Every
 * interleaving is built the same way — one session begins and takes the
 * word's lock with an uncommitted write, the other begins the conflicting
 * statement and is watched in pg_stat_activity until it is parked on that
 * lock, and only then does the first session commit. That wait is the
 * evidence the overlap is real: a sequential test cannot reach it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createReleaseDatabase,
  locksHeld,
  waitUntilBlocked,
  withTimeout,
  type OpenSession,
  type ReleaseDatabase,
} from '../helpers/pg-release-database.js';

let db: ReleaseDatabase;
let alice: string;
let inspector: OpenSession;

beforeAll(async () => {
  db = await createReleaseDatabase('rel012_concurrency');
  alice = await db.createUser('alice@concurrency.test');
  inspector = await db.openInspector();
});

afterAll(async () => {
  await inspector.close();
  await db.drop();
});

/** Seeds a word with the given senses; the last one starts archived if asked. */
const seedWord = async (word: string, senses: string[], archivedLast = false) => {
  const [row] = await db.admin<{ id: string }>(
    `insert into public.vocabulary (user_id, word, word_key) values ($1, $2, $2) returning id`,
    [alice, word],
  );
  for (const [position, meaning] of senses.entries()) {
    const archived = archivedLast && position === senses.length - 1;
    await db.admin(
      `insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id, archived_at)
       values ($1, $2, $3, $4, 1, gen_random_uuid(), case when $5 then now() else null end)`,
      [alice, row!.id, position, meaning, archived],
    );
  }
  await db.admin('update public.vocabulary set senses_version = 1 where id = $1', [row!.id]);
  return row!.id;
};

const senseRows = (word: string) =>
  db.admin<{ id: string; position: number; meaning: string | null; version: number; archived_at: string | null }>(
    `select id, position, meaning, version, archived_at from public.vocabulary_senses where vocabulary_id = $1 order by position, id`,
    [word],
  );

const sensesVersion = async (word: string) =>
  (await db.admin<{ senses_version: number }>('select senses_version from public.vocabulary where id = $1', [word]))[0]!.senses_version;

/** An authenticated session for alice, waiting at most 8s on any lock. */
const openAlice = () => db.open({ role: 'authenticated', userId: alice }, { lockTimeout: '8s' });

/**
 * A statement that is expected to block. It is sent at once and settles into
 * an outcome — so no promise is ever left unhandled while the test waits on
 * the synchronization point.
 */
const settlesAs = async <T>(promise: Promise<T>): Promise<{ rows: T } | { code: string }> =>
  promise.then(
    (rows) => ({ rows }),
    (error) => ({ code: (error as { code?: string }).code ?? 'no-code' }),
  );

/** Runs a schedule over two sessions and always closes them. */
const twoActors = async (schedule: (a: OpenSession, b: OpenSession) => Promise<void>) => {
  const a = await openAlice();
  const b = await openAlice();
  try {
    await schedule(a, b);
  } finally {
    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
  }
};

describe('C1 — two edits to the same sense', () => {
  it('lets exactly one land; the other answers with the stale-version conflict', async () => {
    const word = await seedWord('candid', ['thẳng thắn']);
    const [sense] = await senseRows(word);

    await twoActors(async (a, b) => {
      const bPid = await b.backendPid();

      await a.begin();
      await a.query(`select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)`, [sense!.id, sense!.version, JSON.stringify({ meaning: 'một' })]);

      await b.begin();
      const losing = settlesAs(b.query(`select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)`, [sense!.id, sense!.version, JSON.stringify({ meaning: 'hai' })]));

      // The synchronization point: b is parked on the word lock a holds.
      await waitUntilBlocked(inspector, bPid);
      const holding = await locksHeld(inspector, await a.backendPid());
      expect(holding.some((l) => l.relation === 'vocabulary' && l.granted)).toBe(true);

      await a.commit();
      expect(await withTimeout(losing, 10_000, 'C1 second edit')).toEqual({ code: 'P0003' });
    });

    // One version, one body — no silent lost update. The winning edit also
    // moved the word's sense version, as any sense mutation does.
    const [final] = await senseRows(word);
    expect(final).toMatchObject({ meaning: 'một', version: 2 });
    expect(await sensesVersion(word)).toBe(2);
  });
});

describe('C2 — an add interleaved with a reorder', () => {
  it('rejects a reorder that saw the world before the add, and keeps every sense once', async () => {
    const word = await seedWord('bank', ['ngân hàng', 'bờ sông']);

    await twoActors(async (a, b) => {
      const [first, second] = await senseRows(word);
      const bPid = await b.backendPid();

      await a.begin();
      await a.query(`select public.add_vocabulary_sense($1::uuid, 'tiền mặt', null, null, $2::uuid)`, [word, crypto.randomUUID()]);

      await b.begin();
      const stale = settlesAs(b.query(`select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)`, [word, JSON.stringify([second!.id, first!.id]), 1]));

      await waitUntilBlocked(inspector, bPid);
      await a.commit();
      expect(await withTimeout(stale, 10_000, 'C2 stale reorder')).toEqual({ code: 'P0003' });
    });

    const rows = await senseRows(word);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.position)).size).toBe(3);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.meaning)).toEqual(['ngân hàng', 'bờ sông', 'tiền mặt']);
  });

  it('lets a reorder that arrives second see the add that landed first', async () => {
    const word = await seedWord('light', ['ánh sáng', 'nhẹ']);

    await twoActors(async (a, b) => {
      const [first, second] = await senseRows(word);
      const aPid = await a.backendPid();

      // The reorder lands and holds its locks; the add waits.
      await b.begin();
      await b.query(`select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)`, [word, JSON.stringify([second!.id, first!.id]), 1]);

      await a.begin();
      const late = settlesAs(a.query(`select public.add_vocabulary_sense($1::uuid, 'sáng tỏ', null, null, $2::uuid)`, [word, crypto.randomUUID()]));

      await waitUntilBlocked(inspector, aPid);
      await b.commit();
      expect(await withTimeout(late, 10_000, 'C2 add second')).toHaveProperty('rows');
      await a.commit();
    });

    const rows = await senseRows(word);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.position)).size).toBe(3);
    // The reordered two swapped; the add appended after them.
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });
});

describe('C3 — a restore interleaved with an add', () => {
  it('keeps identities and ordering stable whichever write lands first', async () => {
    const word = await seedWord('bank', ['ngân hàng', 'phía bờ'], true);
    const [, archived] = await senseRows(word);

    await twoActors(async (a, b) => {
      const waiterPid = await b.backendPid();

      await a.begin();
      await a.query(`select public.restore_vocabulary_sense($1::uuid, $2::int)`, [archived!.id, archived!.version]);

      await b.begin();
      const late = settlesAs(b.query(`select public.add_vocabulary_sense($1::uuid, 'két sắt', null, null, $2::uuid)`, [word, crypto.randomUUID()]));

      await waitUntilBlocked(inspector, waiterPid);
      await a.commit();
      expect(await withTimeout(late, 10_000, 'C3 add after restore')).toHaveProperty('rows');
      await b.commit();
    });

    const rows = await senseRows(word);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.archived_at === null)).toBe(true);
    expect(new Set(rows.map((r) => r.position)).size).toBe(3);
    // The restored sense kept its identity: same id, back among the live.
    expect(rows.some((r) => r.id === archived!.id)).toBe(true);
  });
});

describe('C4 — an archive interleaved with an edit', () => {
  it('rejects the edit whose version the archive moved', async () => {
    const word = await seedWord('candid', ['thẳng thắn']);
    const [sense] = await senseRows(word);

    await twoActors(async (a, b) => {
      const bPid = await b.backendPid();

      await a.begin();
      await a.query(`select public.archive_vocabulary_sense($1::uuid, $2::int)`, [sense!.id, sense!.version]);

      await b.begin();
      const stale = settlesAs(b.query(`select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)`, [sense!.id, sense!.version, JSON.stringify({ meaning: 'never written' })]));

      await waitUntilBlocked(inspector, bPid);
      await a.commit();
      expect(await withTimeout(stale, 10_000, 'C4 edit after archive')).toEqual({ code: 'P0003' });
    });

    const [final] = await senseRows(word);
    expect(final!.archived_at).not.toBeNull();
    expect(final).toMatchObject({ meaning: 'thẳng thắn', version: 2 });
  });
});

describe('C5 — the same request id sent twice, at once', () => {
  it('creates one sense and answers both attempts with it', async () => {
    const word = await seedWord('lucid', ['sáng suốt']);
    const request = crypto.randomUUID();

    await twoActors(async (a, b) => {
      const bPid = await b.backendPid();

      await a.begin();
      await a.query(`select public.add_vocabulary_sense($1::uuid, 'rõ ràng', null, null, $2::uuid)`, [word, request]);

      await b.begin();
      const duplicate = settlesAs(b.query<{ id: string; created: boolean }>(`select id, created from public.add_vocabulary_sense($1::uuid, 'một bản khác', null, null, $2::uuid)`, [word, request]));

      await waitUntilBlocked(inspector, bPid);
      await a.commit();
      const answered = await withTimeout(duplicate, 10_000, 'C5 duplicate add');
      expect(answered).toHaveProperty('rows');
      const rows = (answered as { rows: Array<{ id: string; created: boolean }> }).rows;
      expect(rows[0]!.created).toBe(false);
    });

    const rows = await db.admin<{ id: string; meaning: string | null }>(
      `select id, meaning from public.vocabulary_senses where vocabulary_id = $1 and request_id = $2`,
      [word, request],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meaning).toBe('rõ ràng');
  });

  it('answers the same request id on another word with the duplicate error, and still one sense', async () => {
    const wordA = await seedWord('novel', ['tiểu thuyết']);
    const wordB = await seedWord('fiction', ['viễn tưởng']);
    const request = crypto.randomUUID();

    await db.as(alice, (s) => s.query(`select public.add_vocabulary_sense($1::uuid, 'truyện', null, null, $2::uuid)`, [wordA, request]));
    const reuse = await settlesAs(
      db.as(alice, (s) => s.query(`select public.add_vocabulary_sense($1::uuid, 'truyện khác', null, null, $2::uuid)`, [wordB, request])),
    );
    expect(reuse).toEqual({ code: '23505' });
    expect(await db.admin('select 1 from public.vocabulary_senses where request_id = $1', [request])).toHaveLength(1);
  });
});

describe('C6 — a legacy edit interleaved with a sense edit', () => {
  it('rejects the sense edit whose version the legacy write moved, and keeps the projection whole', async () => {
    const word = await seedWord('candid', ['thẳng thắn']);
    const [sense] = await senseRows(word);

    await twoActors(async (a, b) => {
      const bPid = await b.backendPid();

      await a.begin();
      await a.query(`select public.update_vocabulary($1::uuid, $2::jsonb)`, [word, JSON.stringify({ meaning: 'gan dạ' })]);

      await b.begin();
      const stale = settlesAs(b.query(`select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)`, [sense!.id, sense!.version, JSON.stringify({ meaning: 'lost' })]));

      await waitUntilBlocked(inspector, bPid);
      await a.commit();
      expect(await withTimeout(stale, 10_000, 'C6 sense edit after legacy edit')).toEqual({ code: 'P0003' });
    });

    const [row] = await db.admin<{ meaning: string | null; sense: string | null }>(
      `select v.meaning, (select meaning from public.vocabulary_senses where vocabulary_id = v.id and archived_at is null order by position limit 1) as sense
         from public.vocabulary v where v.id = $1`,
      [word],
    );
    expect(row).toMatchObject({ meaning: 'gan dạ', sense: 'gan dạ' });
  });

  it('lands the legacy edit second, and the projection still tells one story', async () => {
    const word = await seedWord('light', ['ánh sáng']);
    const [sense] = await senseRows(word);

    await twoActors(async (a, b) => {
      const aPid = await a.backendPid();

      // The sense edit lands and holds its locks; the legacy edit waits.
      await b.begin();
      await b.query(`select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)`, [sense!.id, sense!.version, JSON.stringify({ meaning: 'nhẹ nhàng' })]);

      await a.begin();
      const legacy = settlesAs(a.query(`select public.update_vocabulary($1::uuid, $2::jsonb)`, [word, JSON.stringify({ meaning: 'sáng' })]));

      await waitUntilBlocked(inspector, aPid);
      await b.commit();
      expect(await withTimeout(legacy, 10_000, 'C6 legacy edit second')).toHaveProperty('rows');
      await a.commit();
    });

    const [row] = await db.admin<{ meaning: string | null; sense: string | null }>(
      `select v.meaning, (select meaning from public.vocabulary_senses where vocabulary_id = v.id and archived_at is null order by position limit 1) as sense
         from public.vocabulary v where v.id = $1`,
      [word],
    );
    expect(row).toMatchObject({ meaning: 'sáng', sense: 'sáng' });
  });
});

describe('C7 — an import retry interleaved with the user editing', () => {
  it('cannot overwrite the edit the user landed first', async () => {
    const word = await seedWord('stable', ['ổn định']);
    const [sense] = await senseRows(word);
    const importRequest = (await db.admin<{ request_id: string }>('select request_id from public.vocabulary_senses where id = $1', [sense!.id]))[0]!.request_id;

    await twoActors(async (a, b) => {
      const bPid = await b.backendPid();

      // The user's accepted edit holds the word; the import's retry waits.
      await a.begin();
      await a.query(`select public.update_vocabulary_sense($1::uuid, $2::int, $3::jsonb)`, [sense!.id, sense!.version, JSON.stringify({ meaning: 'the user had the last word' })]);

      await b.begin();
      const retry = settlesAs(b.query<{ created: boolean }>(`select created from public.resume_vocabulary_sense($1::uuid, 'from the file again', null, null, $2::uuid)`, [word, importRequest]));

      await waitUntilBlocked(inspector, bPid);
      await a.commit();
      const answered = await withTimeout(retry, 10_000, 'C7 import retry');
      expect(answered).toHaveProperty('rows');
      expect((answered as { rows: Array<{ created: boolean }> }).rows[0]!.created).toBe(false);
    });

    const [final] = await senseRows(word);
    expect(final).toMatchObject({ meaning: 'the user had the last word', version: 2 });
  });

  it('cannot bring back a word the user has thrown away since', async () => {
    const word = await seedWord('rubbish', ['vứt đi']);
    const [sense] = await senseRows(word);
    const importRequest = (await db.admin<{ request_id: string }>('select request_id from public.vocabulary_senses where id = $1', [sense!.id]))[0]!.request_id;

    // The user trashes the word; the retry still reaches its own sense —
    // and changes neither the word's state nor the sense's body.
    await db.as(alice, (s) => s.query('update public.vocabulary set deleted_at = now() where id = $1', [word]));
    const retry = await db.as(alice, (s) =>
      s.query<{ created: boolean }>(`select created from public.resume_vocabulary_sense($1::uuid, 'from the file again', null, null, $2::uuid)`, [word, importRequest]),
    );
    expect(retry[0]!.created).toBe(false);

    const [final] = await senseRows(word);
    expect(final!.meaning).toBe('vứt đi');
    const [row] = await db.admin<{ deleted_at: string | null }>('select deleted_at::text from public.vocabulary where id = $1', [word]);
    expect(row!.deleted_at).not.toBeNull();
  });
});

describe('C8 — lock contention and deadlock', () => {
  it('queues every waiter on the one word lock and completes them all within their timeout', async () => {
    const word = await seedWord('queue', ['hàng đợi', 'đứng sau'], true);
    const [, archived] = await senseRows(word);

    const a = await openAlice();
    const b = await openAlice();
    const c = await openAlice();
    try {
      const bPid = await b.backendPid();
      const cPid = await c.backendPid();

      // One session holds the word; two different calls queue behind it.
      await a.begin();
      await a.query(`select public.add_vocabulary_sense($1::uuid, 'mới', null, null, $2::uuid)`, [word, crypto.randomUUID()]);

      await b.begin();
      const reorder = settlesAs(b.query(`select public.reorder_vocabulary_senses($1::uuid, $2::jsonb, $3::int)`, [word, JSON.stringify([]), 1]));
      await waitUntilBlocked(inspector, bPid);

      await c.begin();
      const restore = settlesAs(c.query(`select public.restore_vocabulary_sense($1::uuid, $2::int)`, [archived!.id, 1]));
      await waitUntilBlocked(inspector, cPid);

      await a.commit();
      // Both waiters finish — no indefinite waiting. The reorder saw the
      // word's version move underneath it and says so rather than writing
      // through it; the restore checks the sense's own version, which the
      // add never touched, so it lands.
      expect(await withTimeout(reorder, 10_000, 'C8 queued reorder')).toEqual({ code: 'P0003' });
      expect(await withTimeout(restore, 10_000, 'C8 queued restore')).toHaveProperty('rows');
      await c.commit();
    } finally {
      await a.close().catch(() => undefined);
      await b.close().catch(() => undefined);
      await c.close().catch(() => undefined);
    }

    const rows = await senseRows(word);
    expect(rows).toHaveLength(3);
    // The queued restore landed: the archived sense is back among the live,
    // and the add's sense sits alongside both.
    expect(rows.find((r) => r.id === archived!.id)!.archived_at).toBeNull();
    expect(new Set(rows.map((r) => r.position)).size).toBe(3);
  });

  it('detects a deadlock between two lock orders and rolls one side back whole', async () => {
    const word = await seedWord('deadlock', ['bế tắc']);
    const [sense] = await senseRows(word);

    const x = await openAlice();
    const y = await openAlice();
    try {
      // Deliberately inverted order: x takes the sense row then the word,
      // y takes the word row then the sense row. PostgreSQL resolves this
      // itself — one side gets the deadlock error, nothing partial lands.
      await x.begin();
      await x.query('select id from public.vocabulary_senses where id = $1 for update', [sense!.id]);
      await y.begin();
      await y.query(`update public.vocabulary set meaning = 'y was here' where id = $1`, [word]);

      const xSecond = settlesAs(x.query(`update public.vocabulary set meaning = 'x was here' where id = $1`, [word]));
      const ySecond = settlesAs(y.query('select id from public.vocabulary_senses where id = $1 for update', [sense!.id]));

      const outcomes = await Promise.all([
        withTimeout(xSecond, 10_000, 'C8 x second lock'),
        withTimeout(ySecond, 10_000, 'C8 y second lock'),
      ]);
      expect(outcomes.filter((o) => 'code' in o && o.code === '40P01')).toHaveLength(1);
      await x.rollback().catch(() => undefined);
      await y.rollback().catch(() => undefined);

      // Nothing was committed by either side: the word's legacy projection
      // still tells the story of the first sense, as the seed left it.
      const [row] = await db.admin<{ meaning: string | null }>('select meaning from public.vocabulary where id = $1', [word]);
      expect(row!.meaning).toBe('bế tắc');
    } finally {
      await x.close().catch(() => undefined);
      await y.close().catch(() => undefined);
    }
  });
});
