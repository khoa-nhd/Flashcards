/**
 * Review sessions, Undo and the session summary, through the HTTP API on the
 * real schema. Also the same API on a database that has not had the
 * migration, which must keep saving reviews exactly as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION } from '../../server/supabase/supabase-database.js';
import { capabilitiesAt } from '../../server/supabase/supabase-repository.js';
import {
  NO_CAPABILITIES,
  accountSettingsSchema,
  apiErrorSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  reviewUndoResponseSchema,
  sessionSummarySchema,
  vocabularyListResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { TODAY } from '../helpers/fixtures.js';
import { createPgVocabularyDatabase } from '../helpers/pg-vocabulary-database.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, readMigrations, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  alice = await createTestUser(db, 'alice');
  bob = await createTestUser(db, 'bob');
  app = createSupabaseTestApp(db, [alice, bob]);
});

async function addWord(user: TestUser, input: Record<string, unknown>, on: TestApp = app): Promise<VocabularyEntry> {
  const response = await call(on, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

const seen = { mastery: 3, nextReview: TODAY };

/** Answers a card and returns the request id it was saved under. */
async function answer(
  user: TestUser,
  word: VocabularyEntry,
  options: { action?: string; sessionId?: string; durationMs?: number; expected?: object; on?: TestApp } = {},
) {
  const requestId = newId();
  const response = await call(options.on ?? app, user, '/api/review-action', {
    method: 'POST',
    body: {
      pageId: word.id,
      action: options.action ?? 'remember',
      expected: options.expected ?? { mastery: word.mastery, nextReview: word.reviewDate },
      requestId,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    },
  });
  return { requestId, response };
}

const undo = (user: TestUser, reviewRequestId: string, requestId = newId(), on: TestApp = app) =>
  call(on, user, '/api/review-undo', { method: 'POST', body: { reviewRequestId, requestId } });

const stateOf = async (user: TestUser, id: string) => {
  const list = vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json());
  const entry = list.entries.find((item) => item.id === id);
  return entry === undefined ? null : { mastery: entry.mastery, nextReview: entry.reviewDate };
};

const logs = (user: TestUser) =>
  db.admin<{ kind: string; request_id: string; mastery_before: number; mastery_after: number; session_id: string | null }>(
    'select kind, request_id, mastery_before, mastery_after, session_id from public.review_logs where user_id = $1 order by reviewed_at, kind',
    [user.id],
  );

const errorOf = async (response: Response) => apiErrorSchema.parse(await response.json());

describe('the schema version', () => {
  it('matches the newest migration file, so the server and the SQL cannot drift apart', async () => {
    expect(readMigrations()).toHaveLength(LATEST_SCHEMA_VERSION);
    expect(await createPgVocabularyDatabase(db, alice.id).schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  });

  it('is reported to the signed-in user, and switches the new features on', async () => {
    const settings = accountSettingsSchema.parse(await (await call(app, alice, '/api/settings')).json());
    expect(settings.database).toEqual({ version: LATEST_SCHEMA_VERSION, latest: LATEST_SCHEMA_VERSION });
    const queue = queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue')).json());
    expect(queue.capabilities).toEqual(capabilitiesAt(LATEST_SCHEMA_VERSION));
  });
});

describe('undoing an answer', () => {
  it('puts the word back exactly as it was, and keeps both events in the history', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word);
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 4, nextReview: '2026-10-12' });

    const response = await undo(alice, requestId);
    expect(response.status).toBe(200);
    expect(reviewUndoResponseSchema.parse(await response.json())).toEqual({ outcome: 'undone', pageId: word.id, state: seen });
    expect(await stateOf(alice, word.id)).toEqual(seen);

    // Nothing was deleted: the answer is still there, followed by the event that took it back.
    expect(await logs(alice)).toMatchObject([
      { kind: 'review', request_id: requestId, mastery_before: 3, mastery_after: 4 },
      { kind: 'undo', mastery_before: 4, mastery_after: 3 },
    ]);
    // And the word is due again, so it can be answered properly.
    const queue = queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue')).json());
    expect(queue.cards.map((card) => card.id)).toEqual([word.id]);
  });

  it('restores an empty review date as empty', async () => {
    const word = await addWord(alice, { word: 'fresh' });
    const { requestId } = await answer(alice, word, { action: 'not_remember' });
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 1, nextReview: '2026-10-10' });
    await undo(alice, requestId);
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 1, nextReview: null });
  });

  it('happens once however often the request is repeated', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word);
    const undoId = newId();

    const first = await undo(alice, requestId, undoId);
    const retry = await undo(alice, requestId, undoId);
    const another = await undo(alice, requestId);
    expect(reviewUndoResponseSchema.parse(await first.json()).outcome).toBe('undone');
    expect(reviewUndoResponseSchema.parse(await retry.json())).toEqual({ outcome: 'already_undone', pageId: word.id, state: seen });
    expect(reviewUndoResponseSchema.parse(await another.json()).outcome).toBe('already_undone');
    expect((await logs(alice)).filter((log) => log.kind === 'undo')).toHaveLength(1);
    expect(await stateOf(alice, word.id)).toEqual(seen);
  });

  it('refuses when the card has a newer answer that still stands', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 0, reviewDate: TODAY });
    const first = await answer(alice, word);
    // Mastery 0 stays due the same day, so it can be answered again at once.
    const second = await answer(alice, word, { expected: { mastery: 1, nextReview: TODAY } });
    expect(second.response.status).toBe(200);

    const stale = await undo(alice, first.requestId);
    expect(stale.status).toBe(409);
    const body = await errorOf(stale);
    expect(body.error.message).toContain('reviewed again');
    expect(body.current).toEqual({ mastery: 2, nextReview: '2026-10-10' });
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 2, nextReview: '2026-10-10' });

    // Taking back the newest answer first makes the older one undoable in turn.
    expect((await undo(alice, second.requestId)).status).toBe(200);
    expect((await undo(alice, first.requestId)).status).toBe(200);
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 0, nextReview: TODAY });
  });

  it('refuses when the word was edited after the answer, and leaves the edit alone', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word);
    await call(app, alice, `/api/vocabulary/${word.id}`, {
      method: 'PATCH',
      body: { schedule: { mastery: 7, reviewDate: '2026-11-01' } },
    });

    const response = await undo(alice, requestId);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).error.message).toContain('changed after that answer');
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 7, nextReview: '2026-11-01' });
    expect((await logs(alice)).filter((log) => log.kind === 'undo')).toEqual([]);
  });

  it('refuses when the word is in the trash', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word);
    await call(app, alice, `/api/vocabulary/${word.id}`, { method: 'DELETE' });
    expect((await undo(alice, requestId)).status).toBe(409);
  });

  it('cannot reach another account’s answer', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word);

    const response = await undo(bob, requestId);
    expect(response.status).toBe(404);
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 4, nextReview: '2026-10-12' });
    expect(await logs(bob)).toEqual([]);
  });

  it('answers 404 for an answer that was never saved, and 400 for a malformed request', async () => {
    expect((await undo(alice, newId())).status).toBe(404);
    const bad = await call(app, alice, '/api/review-undo', { method: 'POST', body: { reviewRequestId: 'nope', requestId: newId() } });
    expect(bad.status).toBe(400);
    const extra = await call(app, alice, '/api/review-undo', {
      method: 'POST',
      body: { reviewRequestId: newId(), requestId: newId(), mastery: 0 },
    });
    expect(extra.status).toBe(400);
  });

  it('does not save an answer again once it has been undone', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const body = { pageId: word.id, action: 'remember', expected: seen, requestId: newId() };
    await call(app, alice, '/api/review-action', { method: 'POST', body });
    await undo(alice, body.requestId);

    // A late retry of the original request must not quietly re-apply it.
    const replay = await call(app, alice, '/api/review-action', { method: 'POST', body });
    expect(replay.status).toBe(409);
    expect((await errorOf(replay)).error.message).toContain('taken back');
    expect(await stateOf(alice, word.id)).toEqual(seen);
    expect((await logs(alice)).filter((log) => log.kind === 'review')).toHaveLength(1);
  });

  it('is refused while saving is switched off', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word);
    const frozen = createSupabaseTestApp(db, [alice], { env: { REVIEW_WRITES_ENABLED: 'false' } });
    expect((await undo(alice, requestId, newId(), frozen)).status).toBe(403);
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 4, nextReview: '2026-10-12' });
  });

  it('on two devices: the second undo of the same answer changes nothing', async () => {
    const phone = createSupabaseTestApp(db, [alice]);
    const laptop = createSupabaseTestApp(db, [alice]);
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY }, phone);
    const { requestId } = await answer(alice, word, { on: phone });

    const [a, b] = await Promise.all([undo(alice, requestId, newId(), phone), undo(alice, requestId, newId(), laptop)]);
    const outcomes = [reviewUndoResponseSchema.parse(await a.json()).outcome, reviewUndoResponseSchema.parse(await b.json()).outcome];
    expect(outcomes.sort()).toEqual(['already_undone', 'undone']);
    expect((await logs(alice)).filter((log) => log.kind === 'undo')).toHaveLength(1);
    expect(await stateOf(alice, word.id)).toEqual(seen);
  });

  it('on two devices: an answer given elsewhere after mine stops my undo', async () => {
    const phone = createSupabaseTestApp(db, [alice]);
    const laptop = createSupabaseTestApp(db, [alice]);
    const word = await addWord(alice, { word: 'candid', mastery: 0, reviewDate: TODAY }, phone);
    const mine = await answer(alice, word, { on: phone });
    await answer(alice, word, { expected: { mastery: 1, nextReview: TODAY }, on: laptop });

    expect((await undo(alice, mine.requestId, newId(), phone)).status).toBe(409);
    expect(await stateOf(alice, word.id)).toEqual({ mastery: 2, nextReview: '2026-10-10' });
  });
});

describe('the history stays append-only', () => {
  it('cannot be edited or deleted directly, undo rows included', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word);
    await undo(alice, requestId);
    for (const sql of [
      `update public.review_logs set mastery_after = 9`,
      `delete from public.review_logs`,
      `delete from public.study_sessions`,
    ]) {
      await expect(db.as(alice.id, (s) => s.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect(await logs(alice)).toHaveLength(2);
  });

  it('cannot hold an undo that points at another account’s answer', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    await answer(alice, word);
    const [target] = await db.admin<{ id: string }>('select id from public.review_logs');
    const mine = await addWord(bob, { word: 'bobs', mastery: 3, reviewDate: TODAY });
    await expect(
      db.as(bob.id, (s) =>
        s.query(
          `insert into public.review_logs (vocabulary_id, request_id, kind, undoes_log_id, action, reviewed_on, mastery_before, mastery_after)
           values ($1, gen_random_uuid(), 'undo', $2, 'remember', '2026-10-09', 4, 3)`,
          [mine.id, target?.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('review sessions and their summary', () => {
  it('summarises what the session saved, leaving out undone answers', async () => {
    const sessionId = newId();
    const a = await addWord(alice, { word: 'a', mastery: 3, reviewDate: TODAY });
    const b = await addWord(alice, { word: 'b', mastery: 5, reviewDate: TODAY });
    const c = await addWord(alice, { word: 'c', mastery: 2, reviewDate: TODAY });

    await answer(alice, a, { sessionId, durationMs: 4000 });
    await answer(alice, b, { sessionId, action: 'not_remember', durationMs: 6000 });
    const third = await answer(alice, c, { sessionId });
    await undo(alice, third.requestId);

    const response = await call(app, alice, `/api/sessions/${sessionId}/summary`);
    expect(response.status).toBe(200);
    expect(sessionSummarySchema.parse(await response.json())).toEqual({
      sessionId,
      reviewed: 2,
      remembered: 1,
      notRemembered: 1,
      accuracy: 0.5,
      firstTime: 2,
      seenBefore: 0,
      undone: 1,
      durationMs: 10_000,
      timedReviews: 2,
    });
    expect((await logs(alice)).every((log) => log.session_id === sessionId)).toBe(true);
  });

  it('tells a first recorded review from a word reviewed before', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 0, reviewDate: TODAY });
    await answer(alice, word, { sessionId: newId() });
    const later = newId();
    await answer(alice, word, { sessionId: later, expected: { mastery: 1, nextReview: TODAY } });
    const summary = sessionSummarySchema.parse(await (await call(app, alice, `/api/sessions/${later}/summary`)).json());
    expect(summary).toMatchObject({ reviewed: 1, firstTime: 0, seenBefore: 1 });
  });

  it('reports no accuracy for a session in which every answer was undone', async () => {
    const sessionId = newId();
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { requestId } = await answer(alice, word, { sessionId });
    await undo(alice, requestId);
    const summary = sessionSummarySchema.parse(await (await call(app, alice, `/api/sessions/${sessionId}/summary`)).json());
    expect(summary).toMatchObject({ reviewed: 0, accuracy: null, undone: 1 });
  });

  it('does not exist for anyone but its owner, or before anything was saved', async () => {
    const sessionId = newId();
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    await answer(alice, word, { sessionId });
    expect((await call(app, bob, `/api/sessions/${sessionId}/summary`)).status).toBe(404);
    expect((await call(app, alice, `/api/sessions/${newId()}/summary`)).status).toBe(404);
    expect((await call(app, alice, '/api/sessions/not-an-id/summary')).status).toBe(400);
  });

  it('cannot attach an answer to another account’s session', async () => {
    const sessionId = newId();
    const mine = await addWord(alice, { word: 'alices', mastery: 3, reviewDate: TODAY });
    await answer(alice, mine, { sessionId });

    const theirs = await addWord(bob, { word: 'bobs', mastery: 3, reviewDate: TODAY });
    const hijack = await answer(bob, theirs, { sessionId });
    expect(hijack.response.status).toBe(403);
    // Refused as a whole: Bob's word did not move and nothing was logged for him.
    expect(await stateOf(bob, theirs.id)).toEqual(seen);
    expect(await logs(bob)).toEqual([]);
  });

  it('still saves an answer that names no session', async () => {
    const word = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const { response } = await answer(alice, word);
    expect(reviewActionResponseSchema.parse(await response.json()).outcome).toBe('applied');
    expect(await logs(alice)).toMatchObject([{ kind: 'review', session_id: null }]);
  });
});

describe('a database that has not had this migration yet', () => {
  let old: TestDatabase;
  let owner: TestUser;
  let legacy: TestApp;

  beforeAll(async () => {
    old = await createTestDatabase({ migrations: 1 });
  }, 60_000);

  afterAll(async () => {
    await old.close();
  });

  beforeEach(async () => {
    await old.admin('delete from auth.users');
    owner = await createTestUser(old, 'owner');
    legacy = createSupabaseTestApp(old, [owner]);
  });

  it('says so, and keeps the new features off', async () => {
    const settings = accountSettingsSchema.parse(await (await call(legacy, owner, '/api/settings')).json());
    expect(settings.database).toEqual({ version: 1, latest: LATEST_SCHEMA_VERSION });
    const queue = queueResponseSchema.parse(await (await call(legacy, owner, '/api/review-queue')).json());
    expect(queue.capabilities).toEqual(NO_CAPABILITIES);
  });

  it('saves reviews exactly as before, session id or not', async () => {
    const word = await addWord(owner, { word: 'candid', mastery: 3, reviewDate: TODAY }, legacy);
    const { response } = await answer(owner, word, { sessionId: newId(), on: legacy });
    expect(response.status).toBe(200);
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'applied',
      state: { mastery: 4, nextReview: '2026-10-12' },
    });
    expect(await old.admin('select mastery_before, mastery_after from public.review_logs')).toEqual([
      { mastery_before: 3, mastery_after: 4 },
    ]);
  });

  it('declines Undo and the summary with a clear reason instead of failing', async () => {
    const word = await addWord(owner, { word: 'candid', mastery: 3, reviewDate: TODAY }, legacy);
    const { requestId } = await answer(owner, word, { on: legacy });

    const response = await undo(owner, requestId, newId(), legacy);
    expect(response.status).toBe(409);
    const body = await errorOf(response);
    expect(body.error.code).toBe('not_supported');
    expect(body.error.message).toContain('latest update');
    expect((await call(legacy, owner, `/api/sessions/${newId()}/summary`)).status).toBe(404);
  });

  it('picks the new features up once the migration is run, without a restart', async () => {
    const upgrading = await createTestDatabase({ migrations: 1 });
    try {
      const user = await createTestUser(upgrading, 'owner');
      let clock = new Date('2026-10-09T05:00:00Z');
      const running = createSupabaseTestApp(upgrading, [user], { now: () => clock });
      const before = queueResponseSchema.parse(await (await call(running, user, '/api/review-queue')).json());
      expect(before.capabilities.undo).toBe(false);

      for (const migration of readMigrations().slice(1)) await upgrading.db.exec(migration.sql);
      // Within the same minute the earlier answer is still remembered…
      const soon = queueResponseSchema.parse(await (await call(running, user, '/api/review-queue')).json());
      expect(soon.capabilities.undo).toBe(false);
      // …and a minute later the server has noticed.
      clock = new Date('2026-10-09T05:01:30Z');
      const after = queueResponseSchema.parse(await (await call(running, user, '/api/review-queue')).json());
      expect(after.capabilities).toEqual(capabilitiesAt(LATEST_SCHEMA_VERSION));
    } finally {
      await upgrading.close();
    }
  }, 60_000);
});
