/**
 * The whole application in Supabase mode: HTTP routes, account sessions,
 * services, repository, and the real schema with Row Level Security. Only the
 * hosted network layer is replaced (see tests/helpers/supabase-app.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/bootstrap.js';
import { DatabaseError, LATEST_SCHEMA_VERSION } from '../../server/supabase/supabase-database.js';
import {
  accountSettingsSchema,
  apiErrorSchema,
  appConfigResponseSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  trashResponseSchema,
  vocabularyListResponseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
import { TODAY } from '../helpers/fixtures.js';
import {
  SUPABASE_ENV,
  call,
  createSupabaseTestApp,
  createTestUser,
  newId,
  type TestApp,
  type TestUser,
} from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

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

const listOf = async (user: TestUser, on: TestApp = app) =>
  vocabularyListResponseSchema.parse(await (await call(on, user, '/api/vocabulary')).json());

const queueOf = async (user: TestUser, on: TestApp = app) =>
  queueResponseSchema.parse(await (await call(on, user, '/api/review-queue')).json());

const answer = (user: TestUser, body: Record<string, unknown>, on: TestApp = app) =>
  call(on, user, '/api/review-action', { method: 'POST', body: { requestId: newId(), ...body } });

const errorOf = async (response: Response) => apiErrorSchema.parse(await response.json());

const logs = (user: TestUser) =>
  db.admin('select * from public.review_logs where user_id = $1 order by reviewed_at, id', [user.id]);

describe('how the browser is told to sign in', () => {
  it('announces accounts, with only the public address and key', async () => {
    const response = await call(app, null, '/api/config');
    expect(response.status).toBe(200);
    expect(appConfigResponseSchema.parse(await response.json())).toEqual({
      mode: 'supabase',
      auth: 'account',
      supabase: { url: SUPABASE_ENV.SUPABASE_URL, publicKey: SUPABASE_ENV.SUPABASE_ANON_KEY },
    });
  });

  it('has no shared password: only an account opens anything', async () => {
    // A setting left over from the old passphrase gate changes nothing.
    const leftover = createSupabaseTestApp(db, [alice], { env: { APP_ACCESS_PASSWORD: 'a passphrase' } });
    const login = await call(leftover, null, '/api/login', { method: 'POST', body: { password: 'a passphrase' } });
    expect(login.status).toBe(401);
    expect((await call(leftover, alice, '/api/login', { method: 'POST', body: { password: 'a passphrase' } })).status).toBe(404);
    expect((await call(leftover, null, '/api/vocabulary')).status).toBe(401);
    expect((await call(leftover, alice, '/api/vocabulary')).status).toBe(200);
  });
});

describe('requests without a valid session', () => {
  const protectedRoutes: Array<[string, string]> = [
    ['GET', '/api/review-queue'],
    ['POST', '/api/review-action'],
    ['GET', '/api/vocabulary'],
    ['POST', '/api/vocabulary'],
    ['GET', '/api/trash'],
    ['GET', '/api/settings'],
    ['PUT', '/api/settings'],
    ['GET', '/api/vocabulary/00000000-0000-4000-8000-000000000001'],
    ['PATCH', '/api/vocabulary/00000000-0000-4000-8000-000000000001'],
    ['DELETE', '/api/vocabulary/00000000-0000-4000-8000-000000000001'],
    ['POST', '/api/vocabulary/00000000-0000-4000-8000-000000000001/restore'],
  ];

  it.each(protectedRoutes)('%s %s is refused with 401', async (method, path) => {
    const response = await app.request(path, { method });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).error.code).toBe('unauthorized');
  });

  it.each([
    ['an unknown token', 'Bearer stranger.session.token'],
    ['a token that is not a JWT', 'Bearer not-a-token'],
    ['another scheme', 'Basic YWxpY2U6c2VjcmV0'],
    ['an empty bearer', 'Bearer '],
  ])('refuses %s', async (_name, authorization) => {
    const response = await app.request('/api/vocabulary', { headers: { Authorization: authorization } });
    expect(response.status).toBe(401);
  });

  it('says the sign-in service is unavailable rather than signing the user out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = createSupabaseTestApp(db, [alice], {
      verifier: {
        async verify() {
          throw new DatabaseError('unavailable', 'The sign-in service is temporarily unavailable.');
        },
      },
    });
    const response = await call(down, alice, '/api/vocabulary');
    expect(response.status).toBe(503);
    expect((await errorOf(response)).error.code).toBe('database_unavailable');
  });
});

describe('a new account', () => {
  it('starts empty, in the time zone its first device reports', async () => {
    const list = await listOf(alice);
    expect(list).toMatchObject({ entries: [], mode: 'supabase', writesEnabled: true, timeZone: 'Asia/Ho_Chi_Minh', today: TODAY });
    expect(list.defaults).toEqual({ mastery: 1, reviewDate: 'empty' });
    expect(await queueOf(alice)).toMatchObject({ cards: [], vocabulary: 'empty', mode: 'supabase' });
  });

  it('keeps that time zone when another device reports a different one', async () => {
    await call(app, alice, '/api/vocabulary', { zone: 'Asia/Ho_Chi_Minh' });
    const later = await call(app, alice, '/api/settings', { zone: 'America/New_York' });
    expect(accountSettingsSchema.parse(await later.json())).toEqual({
      timeZone: 'Asia/Ho_Chi_Minh',
      timeZoneEditable: true,
      email: alice.email,
      database: { version: LATEST_SCHEMA_VERSION, latest: LATEST_SCHEMA_VERSION },
      fsrsRetention: 0.9,
    });
  });

  it.each([['Mars/Olympus_Mons'], [null]])('falls back to UTC when the device offers %s', async (zone) => {
    const response = await call(app, bob, '/api/settings', { zone });
    expect(accountSettingsSchema.parse(await response.json()).timeZone).toBe('UTC');
  });

  it('can use a server-wide default zone instead', async () => {
    const configured = createSupabaseTestApp(db, [bob], { env: { REVIEW_TIMEZONE: 'Asia/Tokyo' } });
    const response = await call(configured, bob, '/api/settings', { zone: null });
    expect(accountSettingsSchema.parse(await response.json()).timeZone).toBe('Asia/Tokyo');
  });
});

describe('adding and editing words', () => {
  it('creates a word with the same defaults as before: mastery 1, no review date, added today', async () => {
    const entry = await addWord(alice, { word: '  ice   cream ', meaning: ' kem ' });
    expect(entry).toMatchObject({
      word: 'ice cream',
      meaning: 'kem',
      definition: null,
      example: null,
      mastery: 1,
      reviewDate: null,
      dateAdded: TODAY,
      reviewStatus: 'unscheduled',
      reviewable: true,
    });
    expect((await listOf(alice)).entries.map((item) => item.id)).toEqual([entry.id]);
  });

  it('creates a word once however often the same submission arrives, even on a restarted server', async () => {
    const requestId = newId();
    const body = { word: 'candid', requestId };
    const first = await call(app, alice, '/api/vocabulary', { method: 'POST', body });
    expect(first.status).toBe(201);

    const restarted = createSupabaseTestApp(db, [alice, bob]);
    const second = await call(restarted, alice, '/api/vocabulary', { method: 'POST', body });
    expect(second.status).toBe(200);
    expect(entryResponseSchema.parse(await second.json()).entry.id).toBe(entryResponseSchema.parse(await first.json()).entry.id);
    expect((await listOf(alice)).entries).toHaveLength(1);
  });

  it('refuses a duplicate within the account, unless it is allowed explicitly', async () => {
    const original = await addWord(alice, { word: 'Candid' });
    const again = await call(app, alice, '/api/vocabulary', { method: 'POST', body: { word: ' candid ', requestId: newId() } });
    expect(again.status).toBe(409);
    const body = await errorOf(again);
    expect(body.error.code).toBe('duplicate');
    expect(body.duplicates?.map((entry) => entry.id)).toEqual([original.id]);

    await addWord(alice, { word: 'candid', allowDuplicate: true });
    expect((await listOf(alice)).entries).toHaveLength(2);
  });

  it('edits text and, separately, the schedule', async () => {
    const entry = await addWord(alice, { word: 'candid', meaning: 'thang than' });
    const edited = await call(app, alice, `/api/vocabulary/${entry.id}`, {
      method: 'PATCH',
      body: { meaning: 'thẳng thắn', example: 'A candid answer.', schedule: { mastery: 4, reviewDate: '2026-10-20' } },
    });
    expect(edited.status).toBe(200);
    expect(entryResponseSchema.parse(await edited.json()).entry).toMatchObject({
      word: 'candid',
      meaning: 'thẳng thắn',
      example: 'A candid answer.',
      mastery: 4,
      reviewDate: '2026-10-20',
      reviewStatus: 'upcoming',
    });

    const cleared = await call(app, alice, `/api/vocabulary/${entry.id}`, { method: 'PATCH', body: { example: '' } });
    expect(entryResponseSchema.parse(await cleared.json()).entry.example).toBeNull();
  });

  it('rejects a mastery outside 0 to 10 before it reaches the database', async () => {
    const response = await call(app, alice, '/api/vocabulary', { method: 'POST', body: { word: 'x', mastery: 11, requestId: newId() } });
    expect(response.status).toBe(400);
    expect((await listOf(alice)).entries).toEqual([]);
  });
});

describe('the review queue', () => {
  it('holds exactly the words the owner’s rule admits, most overdue first', async () => {
    const overdue = await addWord(alice, { word: 'overdue', mastery: 3, reviewDate: '2026-10-01' });
    const today = await addWord(alice, { word: 'today', mastery: 9, reviewDate: TODAY });
    const undated = await addWord(alice, { word: 'undated' });
    await addWord(alice, { word: 'tomorrow', mastery: 2, reviewDate: '2026-10-10' });
    await addWord(alice, { word: 'mastered', mastery: 10, reviewDate: '2026-10-01' });

    const queue = await queueOf(alice);
    expect(queue.cards.map((card) => card.word).slice(0, 2)).toEqual(['overdue', 'today']);
    expect(new Set(queue.cards.map((card) => card.id))).toEqual(new Set([overdue.id, today.id, undated.id]));
    expect(queue).toMatchObject({ today: TODAY, writesEnabled: true, vocabulary: 'in_progress', skipped: [] });
  });

  it('hides the definition and example above mastery 5, exactly as before', async () => {
    const text = { meaning: 'nghĩa', definition: 'the definition', example: 'the example' };
    await addWord(alice, { word: 'learning', mastery: 5, reviewDate: TODAY, ...text });
    await addWord(alice, { word: 'known', mastery: 6, reviewDate: TODAY, ...text });

    const cards = new Map((await queueOf(alice)).cards.map((card) => [card.word, card]));
    expect(cards.get('learning')?.back.map((field) => field.value)).toEqual(['nghĩa', 'the definition', 'the example']);
    expect(cards.get('learning')?.detailsHidden).toBe(false);
    expect(cards.get('known')?.back.map((field) => field.value)).toEqual(['nghĩa']);
    expect(cards.get('known')?.detailsHidden).toBe(true);
    // Withheld text is not sent at all.
    expect(JSON.stringify(cards.get('known'))).not.toContain('the definition');
  });

  it('says so when every word is mastered', async () => {
    await addWord(alice, { word: 'done', mastery: 10, reviewDate: '2026-10-01' });
    expect(await queueOf(alice)).toMatchObject({ cards: [], vocabulary: 'all_mastered' });
  });
});

describe('answering a card', () => {
  it('Remember: mastery + 1, next review after as many days as the old mastery', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: '2026-10-01' });
    const requestId = newId();
    const response = await answer(alice, {
      pageId: entry.id,
      action: 'remember',
      expected: { mastery: 3, nextReview: '2026-10-01' },
      requestId,
      durationMs: 4200,
    });
    expect(response.status).toBe(200);
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'applied',
      state: { mastery: 4, nextReview: '2026-10-12' },
    });

    expect((await listOf(alice)).entries[0]).toMatchObject({ mastery: 4, reviewDate: '2026-10-12', reviewable: false });
    expect((await queueOf(alice)).cards).toEqual([]);

    // The answer and the new state were saved together, with the history row to show for it.
    const history = await logs(alice);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      vocabulary_id: entry.id,
      request_id: requestId,
      action: 'remember',
      review_mode: 'flashcard',
      duration_ms: 4200,
      mastery_before: 3,
      mastery_after: 4,
      scheduler: 'mastery_v1',
    });
  });

  it('Not remember: mastery unchanged, due again tomorrow', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 7, reviewDate: TODAY });
    const response = await answer(alice, { pageId: entry.id, action: 'not_remember', expected: { mastery: 7, nextReview: TODAY } });
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'applied',
      state: { mastery: 7, nextReview: '2026-10-10' },
    });
    expect((await logs(alice))[0]).toMatchObject({ action: 'not_remember', mastery_before: 7, mastery_after: 7 });
  });

  it.each([
    [0, 1, TODAY],
    [1, 2, '2026-10-10'],
    [9, 10, '2026-10-18'],
  ])('Remember at mastery %i gives mastery %i and review date %s', async (before, after, next) => {
    const entry = await addWord(alice, { word: 'candid', mastery: before, reviewDate: TODAY });
    const response = await answer(alice, { pageId: entry.id, action: 'remember', expected: { mastery: before, nextReview: TODAY } });
    expect(reviewActionResponseSchema.parse(await response.json()).state).toEqual({ mastery: after, nextReview: next });
  });

  it('ignores any mastery or date the browser tries to dictate', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const response = await answer(alice, {
      pageId: entry.id,
      action: 'remember',
      expected: { mastery: 3, nextReview: TODAY },
      mastery: 10,
      nextReview: '2030-01-01',
    });
    expect(response.status).toBe(400);
    expect((await listOf(alice)).entries[0]).toMatchObject({ mastery: 3, reviewDate: TODAY });
    expect(await logs(alice)).toEqual([]);
  });

  it('records a repeated submission once', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const body = { pageId: entry.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY }, requestId: newId() };

    const first = await answer(alice, body);
    const retry = await answer(alice, body);
    expect(reviewActionResponseSchema.parse(await first.json()).outcome).toBe('applied');
    expect(reviewActionResponseSchema.parse(await retry.json())).toEqual({
      outcome: 'already_applied',
      state: { mastery: 4, nextReview: '2026-10-12' },
    });
    expect((await listOf(alice)).entries[0]).toMatchObject({ mastery: 4, reviewDate: '2026-10-12' });
    expect(await logs(alice)).toHaveLength(1);
  });

  it('still recognises a retry after the word has changed again', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const body = { pageId: entry.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY }, requestId: newId() };
    await answer(alice, body);
    await call(app, alice, `/api/vocabulary/${entry.id}`, {
      method: 'PATCH',
      body: { schedule: { mastery: 6, reviewDate: '2026-11-01' } },
    });

    // The first response was lost and the browser retries, long after.
    const retry = await answer(alice, body);
    expect(retry.status).toBe(200);
    expect(reviewActionResponseSchema.parse(await retry.json()).outcome).toBe('already_applied');
    expect((await listOf(alice)).entries[0]).toMatchObject({ mastery: 6, reviewDate: '2026-11-01' });
    expect(await logs(alice)).toHaveLength(1);
  });

  it('refuses a word that is not due, mastered, or unknown, and records nothing', async () => {
    const future = await addWord(alice, { word: 'future', mastery: 3, reviewDate: '2026-10-20' });
    const mastered = await addWord(alice, { word: 'mastered', mastery: 10, reviewDate: TODAY });

    const notDue = await answer(alice, { pageId: future.id, action: 'remember', expected: { mastery: 3, nextReview: '2026-10-20' } });
    expect(notDue.status).toBe(409);
    const retired = await answer(alice, { pageId: mastered.id, action: 'remember', expected: { mastery: 10, nextReview: TODAY } });
    expect(retired.status).toBe(409);
    const unknown = await answer(alice, {
      pageId: '99999999-9999-4999-8999-999999999999',
      action: 'remember',
      expected: { mastery: 3, nextReview: TODAY },
    });
    expect(unknown.status).toBe(404);
    expect(await logs(alice)).toEqual([]);
  });

  it('checks answers but saves nothing while saving is switched off', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const frozen = createSupabaseTestApp(db, [alice], { env: { REVIEW_WRITES_ENABLED: 'false' } });

    expect((await queueOf(alice, frozen)).writesEnabled).toBe(false);
    const response = await answer(alice, { pageId: entry.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY } }, frozen);
    expect(reviewActionResponseSchema.parse(await response.json())).toEqual({
      outcome: 'dry_run',
      state: { mastery: 4, nextReview: '2026-10-12' },
    });
    const create = await call(frozen, alice, '/api/vocabulary', { method: 'POST', body: { word: 'new', requestId: newId() } });
    expect(create.status).toBe(403);
    expect((await listOf(alice)).entries).toMatchObject([{ mastery: 3, reviewDate: TODAY }]);
    expect(await logs(alice)).toEqual([]);
  });
});

describe('the same account on two devices', () => {
  it('shows a change made on one device to the other on its next read', async () => {
    const phone = createSupabaseTestApp(db, [alice]);
    const laptop = createSupabaseTestApp(db, [alice]);

    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY }, phone);
    expect((await queueOf(alice, laptop)).cards.map((card) => card.id)).toEqual([entry.id]);

    await answer(alice, { pageId: entry.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY } }, phone);
    expect((await queueOf(alice, laptop)).cards).toEqual([]);
    expect((await listOf(alice, laptop)).entries[0]).toMatchObject({ mastery: 4, reviewDate: '2026-10-12' });
  });

  it('accepts the first answer to a card and refuses the second device’s stale one', async () => {
    const phone = createSupabaseTestApp(db, [alice]);
    const laptop = createSupabaseTestApp(db, [alice]);
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY }, phone);
    const seen = { mastery: 3, nextReview: TODAY };

    // Both devices loaded the card before either answered.
    const first = await answer(alice, { pageId: entry.id, action: 'remember', expected: seen }, phone);
    expect(first.status).toBe(200);

    const second = await answer(alice, { pageId: entry.id, action: 'not_remember', expected: seen }, laptop);
    expect(second.status).toBe(409);
    const body = await errorOf(second);
    expect(body.error.code).toBe('conflict');
    expect(body.current).toEqual({ mastery: 4, nextReview: '2026-10-12' });

    // One answer counted: the state moved once and the history has one row.
    expect((await listOf(alice)).entries[0]).toMatchObject({ mastery: 4, reviewDate: '2026-10-12' });
    expect(await logs(alice)).toHaveLength(1);
  });

  it('does not count the same answer twice when both devices give it', async () => {
    const phone = createSupabaseTestApp(db, [alice]);
    const laptop = createSupabaseTestApp(db, [alice]);
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY }, phone);
    const seen = { mastery: 3, nextReview: TODAY };

    await answer(alice, { pageId: entry.id, action: 'remember', expected: seen }, phone);
    const second = await answer(alice, { pageId: entry.id, action: 'remember', expected: seen }, laptop);
    expect(reviewActionResponseSchema.parse(await second.json()).outcome).toBe('already_applied');
    expect((await listOf(alice)).entries[0]).toMatchObject({ mastery: 4, reviewDate: '2026-10-12' });
    expect(await logs(alice)).toHaveLength(1);
  });

  it('lets the database settle two answers that arrive at the same moment', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const seen = { mastery: 3, nextReview: TODAY };
    const [a, b] = await Promise.all([
      answer(alice, { pageId: entry.id, action: 'remember', expected: seen }, createSupabaseTestApp(db, [alice])),
      answer(alice, { pageId: entry.id, action: 'not_remember', expected: seen }, createSupabaseTestApp(db, [alice])),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await logs(alice)).toHaveLength(1);
  });
});

describe('two accounts', () => {
  let secret: VocabularyEntry;

  beforeEach(async () => {
    secret = await addWord(alice, { word: 'alices-word', meaning: 'private', mastery: 3, reviewDate: TODAY });
  });

  it('never shows one account’s words to the other', async () => {
    expect((await listOf(bob)).entries).toEqual([]);
    expect((await queueOf(bob)).cards).toEqual([]);
    expect(trashResponseSchema.parse(await (await call(app, bob, '/api/trash')).json()).entries).toEqual([]);
    expect((await call(app, bob, `/api/vocabulary/${secret.id}`)).status).toBe(404);
  });

  it('refuses every way of changing another account’s word', async () => {
    const attempts = [
      call(app, bob, `/api/vocabulary/${secret.id}`, { method: 'PATCH', body: { word: 'taken' } }),
      call(app, bob, `/api/vocabulary/${secret.id}`, { method: 'PATCH', body: { schedule: { mastery: 0, reviewDate: null } } }),
      call(app, bob, `/api/vocabulary/${secret.id}`, { method: 'DELETE' }),
      call(app, bob, `/api/vocabulary/${secret.id}/restore`, { method: 'POST' }),
      answer(bob, { pageId: secret.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY } }),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(404);

    expect((await listOf(alice)).entries).toMatchObject([{ id: secret.id, word: 'alices-word', mastery: 3, reviewDate: TODAY }]);
    expect(await logs(alice)).toEqual([]);
    expect(await logs(bob)).toEqual([]);
  });

  it('lets both accounts hold the same word, and the same request id, independently', async () => {
    const requestId = newId();
    const mine = await call(app, alice, '/api/vocabulary', { method: 'POST', body: { word: 'shared', requestId } });
    const theirs = await call(app, bob, '/api/vocabulary', { method: 'POST', body: { word: 'shared', requestId } });
    expect([mine.status, theirs.status]).toEqual([201, 201]);
    // Not a duplicate of the other account's word either.
    await addWord(bob, { word: 'alices-word' });

    expect((await listOf(alice)).entries.map((entry) => entry.word).sort()).toEqual(['alices-word', 'shared']);
    expect((await listOf(bob)).entries.map((entry) => entry.word).sort()).toEqual(['alices-word', 'shared']);
    const ids = [...(await listOf(alice)).entries, ...(await listOf(bob)).entries].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('keeps review history apart', async () => {
    const bobs = await addWord(bob, { word: 'bobs-word', mastery: 2, reviewDate: TODAY });
    await answer(alice, { pageId: secret.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY } });
    await answer(bob, { pageId: bobs.id, action: 'not_remember', expected: { mastery: 2, nextReview: TODAY } });

    expect((await logs(alice)).map((row) => row.vocabulary_id)).toEqual([secret.id]);
    expect((await logs(bob)).map((row) => row.vocabulary_id)).toEqual([bobs.id]);
  });

  it('gives each account its own "today"', async () => {
    // 18:30 UTC on the 9th is already the 10th in Vietnam.
    const evening = createSupabaseTestApp(db, [alice, bob], { now: () => new Date('2026-10-09T18:30:00Z') });
    await call(evening, alice, '/api/settings', { zone: 'Asia/Ho_Chi_Minh' });
    await call(evening, bob, '/api/settings', { zone: 'UTC' });
    expect((await listOf(alice, evening)).today).toBe('2026-10-10');
    expect((await listOf(bob, evening)).today).toBe('2026-10-09');
  });
});

describe('the trash', () => {
  it('moves a word out of the bank and the queue, and restores it with its review state intact', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 7, reviewDate: TODAY });
    const removed = await call(app, alice, `/api/vocabulary/${entry.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);

    expect((await listOf(alice)).entries).toEqual([]);
    expect((await queueOf(alice)).cards).toEqual([]);
    expect((await call(app, alice, `/api/vocabulary/${entry.id}`)).status).toBe(404);
    const trash = trashResponseSchema.parse(await (await call(app, alice, '/api/trash')).json());
    expect(trash.entries).toMatchObject([{ id: entry.id, word: 'candid', mastery: 7, reviewDate: TODAY }]);

    // A trashed word cannot be reviewed.
    const reviewed = await answer(alice, { pageId: entry.id, action: 'remember', expected: { mastery: 7, nextReview: TODAY } });
    expect(reviewed.status).toBe(404);

    const restored = await call(app, alice, `/api/vocabulary/${entry.id}/restore`, { method: 'POST' });
    expect(entryResponseSchema.parse(await restored.json()).entry).toMatchObject({ id: entry.id, mastery: 7, reviewDate: TODAY });
    expect((await queueOf(alice)).cards.map((card) => card.id)).toEqual([entry.id]);
    expect(trashResponseSchema.parse(await (await call(app, alice, '/api/trash')).json()).entries).toEqual([]);
  });

  it('never removes a row: deleting is always recoverable', async () => {
    const entry = await addWord(alice, { word: 'candid' });
    await call(app, alice, `/api/vocabulary/${entry.id}`, { method: 'DELETE' });
    await call(app, alice, `/api/vocabulary/${entry.id}`, { method: 'DELETE' });
    const rows = await db.admin('select deleted_at from public.vocabulary where id = $1', [entry.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).not.toBeNull();
  });
});

describe('account settings', () => {
  it('changes the time zone, and with it what "today" is', async () => {
    const evening = createSupabaseTestApp(db, [alice], { now: () => new Date('2026-10-09T18:30:00Z') });
    expect((await listOf(alice, evening)).today).toBe('2026-10-10');

    const saved = await call(evening, alice, '/api/settings', { method: 'PUT', body: { timeZone: 'America/New_York' } });
    expect(saved.status).toBe(200);
    expect(accountSettingsSchema.parse(await saved.json()).timeZone).toBe('America/New_York');
    expect(await listOf(alice, evening)).toMatchObject({ today: '2026-10-09', timeZone: 'America/New_York' });
  });

  it('rejects a time zone that does not exist', async () => {
    await call(app, alice, '/api/settings');
    const response = await call(app, alice, '/api/settings', { method: 'PUT', body: { timeZone: 'Hanoi' } });
    expect(response.status).toBe(400);
    expect(accountSettingsSchema.parse(await (await call(app, alice, '/api/settings')).json()).timeZone).toBe('Asia/Ho_Chi_Minh');
  });
});

describe('when something is wrong', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it.each([
    ['unavailable', 503, 'database_unavailable'],
    ['schema_missing', 503, 'setup_incomplete'],
    ['unauthorized', 401, 'unauthorized'],
    ['forbidden', 403, 'forbidden'],
  ] as const)('reports a database failure (%s) instead of hiding it', async (failure, status, code) => {
    const broken = createSupabaseTestApp(db, [alice], {
      wrap: (database) => ({
        ...database,
        listCards: async () => {
          throw new DatabaseError(failure, 'A message that is safe to show.', 'XX000');
        },
      }),
    });
    const response = await call(broken, alice, '/api/vocabulary');
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error.code).toBe(code);
  });

  it('does not report a save that the database did not confirm', async () => {
    const entry = await addWord(alice, { word: 'candid', mastery: 3, reviewDate: TODAY });
    const flaky = createSupabaseTestApp(db, [alice], {
      wrap: (database) => ({
        ...database,
        recordReview: async () => {
          throw new DatabaseError('unavailable', 'The database is temporarily unavailable.');
        },
      }),
    });
    const response = await answer(alice, { pageId: entry.id, action: 'remember', expected: { mastery: 3, nextReview: TODAY } }, flaky);
    expect(response.status).toBe(503);
    expect((await listOf(alice)).entries[0]).toMatchObject({ mastery: 3, reviewDate: TODAY });
    expect(await logs(alice)).toEqual([]);
  });
});

describe('configuration', () => {
  /** Settings a deployment may still carry from before the move to Supabase. */
  const leftovers = {
    NOTION_API_KEY: 'secret_test_value',
    NOTION_DATABASE_ID: '11111111111141118111111111111111',
    REVIEW_TIMEZONE: 'Asia/Ho_Chi_Minh',
    REVIEW_WRITES_ENABLED: 'true',
  };

  it('answers 503 when Supabase is not configured, whatever older settings are still around', async () => {
    const { app: incomplete, config } = buildApp({ ...leftovers, DATA_MODE: 'supabase' });
    expect(config).toMatchObject({ mode: 'supabase', supabase: null });

    const settings = appConfigResponseSchema.parse(await (await incomplete.request('/api/config')).json());
    expect(settings).toEqual({ mode: 'supabase', auth: 'account', supabase: null });

    const response = await incomplete.request('/api/review-queue', { headers: { Authorization: 'Bearer a.b.c' } });
    expect(response.status).toBe(503);
    const body = await errorOf(response);
    expect(body.error.code).toBe('setup_incomplete');
    expect(body.error.message).toContain('SUPABASE_URL');
    expect(body.error.message).not.toContain('secret_test_value');
  });

  it('refuses to start with a privileged key, and never hands it to the browser', async () => {
    const claims = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
    for (const key of ['sb_secret_abcdefghijklmnop', `header.${claims}.signature`]) {
      const { app: unsafe, config } = buildApp({ DATA_MODE: 'supabase', SUPABASE_URL: SUPABASE_ENV.SUPABASE_URL, SUPABASE_ANON_KEY: key });
      expect(config.supabase).toBeNull();
      expect(config.issues.join(' ')).toContain('privileged');
      expect(config.issues.join(' ')).not.toContain(key);
      const text = await (await unsafe.request('/api/config')).text();
      expect(text).not.toContain(key);
      expect((await unsafe.request('/api/vocabulary', { headers: { Authorization: 'Bearer a.b.c' } })).status).toBe(503);
    }
  });

  it('builds a working Supabase app from the environment alone', async () => {
    const { app: built, config } = buildApp(SUPABASE_ENV);
    expect(config).toMatchObject({ mode: 'supabase', issues: [], writesRequested: true });
    expect((await built.request('/api/health')).status).toBe(200);
    expect((await built.request('/api/vocabulary')).status).toBe(401);
  });
});
