/**
 * Multi-sense vocabulary through the HTTP API on the real schema: adding,
 * editing, reordering and archiving senses, the idempotency of a retried add,
 * the conflict a second writer meets, Row Level Security between two accounts,
 * the write-through of the shown meaning, and the same API on a database that
 * has not had the migration (gates off) and one that receives it (backfill).
 *
 * These are sequential request tests: each assertion is a single request whose
 * response is awaited before the next begins. They prove the version checks and
 * refusals, not that two transactions running at the same instant are serialised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION } from '../../server/supabase/supabase-database.js';
import { capabilitiesAt } from '../../server/supabase/supabase-repository.js';
import type { AccountExport } from '../../shared/export-format.js';
import {
  addSenseResponseSchema,
  apiErrorSchema,
  entryResponseSchema,
  queueResponseSchema,
  senseSchema,
  type VocabularyEntry,
} from '../../shared/api.js';
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

async function fetchEntry(user: TestUser, id: string, on: TestApp = app): Promise<VocabularyEntry> {
  const response = await call(on, user, `/api/vocabulary/${id}`);
  expect(response.status).toBe(200);
  return entryResponseSchema.parse(await response.json()).entry;
}

const addSense = (user: TestUser, wordId: string, body: Record<string, unknown>, on: TestApp = app) =>
  call(on, user, `/api/vocabulary/${wordId}/senses`, { method: 'POST', body: { requestId: newId(), ...body } });

const patchSense = (user: TestUser, wordId: string, senseId: string, body: Record<string, unknown>, on: TestApp = app) =>
  call(on, user, `/api/vocabulary/${wordId}/senses/${senseId}`, { method: 'PATCH', body });

const errorOf = async (response: Response) => apiErrorSchema.parse(await response.json());

describe('a word’s senses on the current schema', () => {
  it('shows the sense the word was created with, and counts it in the version', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối', definition: 'to say what is not true' });
    expect(word.senses).toHaveLength(1);
    expect(word.senses[0]).toMatchObject({
      position: 0,
      meaning: 'nói dối',
      definition: 'to say what is not true',
      archived: false,
      version: 1,
    });
    expect(word.sensesVersion).toBe(1);

    const queue = queueResponseSchema.parse(await (await call(app, alice, '/api/review-queue')).json());
    expect(queue.capabilities.senses).toBe(true);
    expect(queue.capabilities).toEqual(capabilitiesAt(LATEST_SCHEMA_VERSION));
  });

  it('gives a word created without content no senses, until the first edit gives it one', async () => {
    const word = await addWord(alice, { word: 'empty' });
    expect(word.senses).toEqual([]);
    expect(word.sensesVersion).toBe(0);

    const edit = await call(app, alice, `/api/vocabulary/${word.id}`, { method: 'PATCH', body: { meaning: 'trống' } });
    expect(edit.status).toBe(200);
    const after = await fetchEntry(alice, word.id);
    expect(after.senses).toHaveLength(1);
    expect(after.senses[0]).toMatchObject({ position: 0, meaning: 'trống', archived: false, version: 1 });
    expect(after.meaning).toBe('trống');
    expect(after.sensesVersion).toBe(1);
  });

  it('adds a sense at the end and moves the version on', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    const response = await addSense(alice, word.id, { meaning: 'nằm', example: 'Don’t lie down at work.' });
    expect(response.status).toBe(201);
    const body = addSenseResponseSchema.parse(await response.json());
    expect(body.created).toBe(true);
    expect(body.sense).toMatchObject({ meaning: 'nằm', position: 1, archived: false, version: 1 });

    const after = await fetchEntry(alice, word.id);
    expect(after.senses).toHaveLength(2);
    expect(after.sensesVersion).toBe(2);
    // The shown fields belong to the first live sense, not the new one.
    expect(after.meaning).toBe('nói dối');
  });

  it('lands once when the same add is retried with the same request id', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    const requestId = newId();

    const first = await call(app, alice, `/api/vocabulary/${word.id}/senses`, {
      method: 'POST',
      body: { requestId, meaning: 'nằm' },
    });
    expect(first.status).toBe(201);
    const second = await call(app, alice, `/api/vocabulary/${word.id}/senses`, {
      method: 'POST',
      body: { requestId, meaning: 'nằm' },
    });
    expect(second.status).toBe(200);

    const created = addSenseResponseSchema.parse(await first.json());
    const repeated = addSenseResponseSchema.parse(await second.json());
    expect(repeated.created).toBe(false);
    expect(repeated.sense.id).toBe(created.sense.id);
    expect((await fetchEntry(alice, word.id)).senses).toHaveLength(2);
  });

  it('updates a sense, and refuses a change still made against the old version', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    const sense = word.senses[0]!;

    const updated = await patchSense(alice, word.id, sense.id, { ifMatch: 1, meaning: 'nói dối (kia)' });
    expect(updated.status).toBe(200);
    const changed = senseSchema.parse((await updated.json()).sense);
    expect(changed).toMatchObject({ meaning: 'nói dối (kia)', version: 2 });

    const stale = await patchSense(alice, word.id, sense.id, { ifMatch: 1, meaning: 'sửa lần nữa' });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).error.code).toBe('conflict');

    const missing = await patchSense(alice, word.id, '99999999-0000-4000-8000-000000000099', {
      ifMatch: 1,
      meaning: 'x',
    });
    expect(missing.status).toBe(404);
  });

  it('leaves out what it was not asked to change, and clears a field given null', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối', example: 'Don’t lie.' });
    const sense = word.senses[0]!;

    const withDefinition = await patchSense(alice, word.id, sense.id, {
      ifMatch: 1,
      definition: 'to speak falsely',
    });
    expect(withDefinition.status).toBe(200);
    expect(senseSchema.parse((await withDefinition.json()).sense)).toMatchObject({
      meaning: 'nói dối',
      definition: 'to speak falsely',
      example: 'Don’t lie.',
      version: 2,
    });

    const cleared = await patchSense(alice, word.id, sense.id, { ifMatch: 2, meaning: null });
    expect(cleared.status).toBe(200);
    expect(senseSchema.parse((await cleared.json()).sense)).toMatchObject({
      meaning: null,
      definition: 'to speak falsely',
    });
  });

  it('archives a sense without losing it, and the shown meaning follows the first live one', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    const first = word.senses[0]!;
    const added = addSenseResponseSchema.parse(await (await addSense(alice, word.id, { meaning: 'nằm' })).json());

    const archived = await call(app, alice, `/api/vocabulary/${word.id}/senses/${first.id}/archive`, {
      method: 'POST',
      body: { ifMatch: first.version },
    });
    expect(archived.status).toBe(200);

    const afterArchive = await fetchEntry(alice, word.id);
    // Nothing was deleted: the sense is still listed, flagged as archived.
    expect(afterArchive.senses).toHaveLength(2);
    expect(afterArchive.senses.find((item) => item.id === first.id)).toMatchObject({ archived: true, version: 2 });
    expect(afterArchive.meaning).toBe('nằm');
    const listed = await call(app, alice, `/api/vocabulary/${word.id}/senses`);
    expect(((await listed.json()) as { senses: unknown[] }).senses).toHaveLength(2);

    // An archived sense cannot be edited or archived again.
    const editArchived = await patchSense(alice, word.id, first.id, { ifMatch: 2, meaning: 'x' });
    expect(editArchived.status).toBe(409);
    const again = await call(app, alice, `/api/vocabulary/${word.id}/senses/${first.id}/archive`, {
      method: 'POST',
      body: { ifMatch: 2 },
    });
    expect(again.status).toBe(409);

    const restored = await call(app, alice, `/api/vocabulary/${word.id}/senses/${first.id}/restore`, {
      method: 'POST',
      body: { ifMatch: 2 },
    });
    expect(restored.status).toBe(200);
    const afterRestore = await fetchEntry(alice, word.id);
    expect(afterRestore.senses).toHaveLength(2);
    expect(afterRestore.senses.find((item) => item.id === first.id)).toMatchObject({ archived: false, version: 3 });
    // The old position may be taken, so a restored sense goes to the end.
    expect(afterRestore.senses.find((item) => item.id === first.id)?.position).toBe(2);
    expect(afterRestore.meaning).toBe(added.sense.meaning);
  });

  it('reorders the live senses, packs the archived ones behind, and refuses a wrong or stale order', async () => {
    const word = await addWord(alice, { word: 'run', meaning: 'chạy' });
    const second = addSenseResponseSchema.parse(await (await addSense(alice, word.id, { meaning: 'vận hành' })).json());
    const third = addSenseResponseSchema.parse(
      await (await addSense(alice, word.id, { meaning: 'chạy (danh từ)' })).json(),
    );
    const first = word.senses[0]!;

    // The archived sense drops out of the order: archive the third one.
    expect(
      (await call(app, alice, `/api/vocabulary/${word.id}/senses/${third.sense.id}/archive`, {
        method: 'POST',
        body: { ifMatch: third.sense.version },
      })).status,
    ).toBe(200);
    const live = [first.id, second.sense.id];
    const order = `/api/vocabulary/${word.id}/senses/order`;
    // The archived sense still counts in the version: create 1, add 2, add 3, archive 4.
    const seen = 4;

    // An order that does not name every live sense exactly once is refused outright.
    const incomplete = await call(app, alice, order, { method: 'PATCH', body: { senseIds: [first.id], ifMatch: seen } });
    expect(incomplete.status).toBe(400);
    const foreign = await call(app, alice, order, {
      method: 'PATCH',
      body: { senseIds: [first.id, '99999999-0000-4000-8000-000000000099'], ifMatch: seen },
    });
    expect(foreign.status).toBe(400);

    const reversed = [...live].reverse();
    const reordered = await call(app, alice, order, { method: 'PATCH', body: { senseIds: reversed, ifMatch: seen } });
    expect(reordered.status).toBe(200);
    const after = await fetchEntry(alice, word.id);
    expect(after.senses.map((item) => item.id)).toEqual([reversed[0], reversed[1], third.sense.id]);
    expect(after.senses.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(after.senses[2]).toMatchObject({ archived: true });

    const stale = await call(app, alice, order, { method: 'PATCH', body: { senseIds: live, ifMatch: seen } });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).error.code).toBe('conflict');
  });

  it('writes an edit of the shown meaning through to the first live sense', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    await addSense(alice, word.id, { meaning: 'nằm' });

    const response = await call(app, alice, `/api/vocabulary/${word.id}`, {
      method: 'PATCH',
      body: { meaning: 'nói dối, giả dối' },
    });
    expect(response.status).toBe(200);

    const after = await fetchEntry(alice, word.id);
    expect(after.meaning).toBe('nói dối, giả dối');
    expect(after.senses[0]).toMatchObject({ meaning: 'nói dối, giả dối', version: 2 });
    expect(after.sensesVersion).toBe(3);
  });

  it('refuses an edit that states a senses version which has moved on, and accepts the current one', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    await addSense(alice, word.id, { meaning: 'nằm' }); // the version is now 2

    const stale = await call(app, alice, `/api/vocabulary/${word.id}`, {
      method: 'PATCH',
      body: { meaning: 'đã cũ', expectSensesVersion: 1 },
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).error.code).toBe('conflict');

    const current = await call(app, alice, `/api/vocabulary/${word.id}`, {
      method: 'PATCH',
      body: { meaning: 'đã sửa', expectSensesVersion: 2 },
    });
    expect(current.status).toBe(200);
    expect((await fetchEntry(alice, word.id)).meaning).toBe('đã sửa');
  });

  it('keeps one account’s senses out of another’s reach', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    const sense = word.senses[0]!;

    expect((await call(app, bob, `/api/vocabulary/${word.id}`)).status).toBe(404);
    expect((await call(app, bob, `/api/vocabulary/${word.id}/senses`)).status).toBe(404);
    expect((await addSense(bob, word.id, { meaning: 'x' })).status).toBe(404);
    expect((await patchSense(bob, word.id, sense.id, { ifMatch: 1, meaning: 'x' })).status).toBe(404);
    expect(
      (await call(app, bob, `/api/vocabulary/${word.id}/senses/${sense.id}/archive`, {
        method: 'POST',
        body: { ifMatch: 1 },
      })).status,
    ).toBe(404);
    expect(
      (await call(app, bob, `/api/vocabulary/${word.id}/senses/order`, {
        method: 'PATCH',
        body: { senseIds: [sense.id], ifMatch: 1 },
      })).status,
    ).toBe(404);

    // The same id asked for in Bob's own account simply does not exist there.
    const bobWord = await addWord(bob, { word: 'bob-word' });
    expect(
      (await call(app, bob, `/api/vocabulary/${bobWord.id}/senses/${sense.id}`)).status,
    ).toBe(404);
  });

  it('carries every sense, the archived one included, out through the export', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    await addSense(alice, word.id, { meaning: 'nằm' });
    const archived = await call(app, alice, `/api/vocabulary/${word.id}/senses/${word.senses[0]!.id}/archive`, {
      method: 'POST',
      body: { ifMatch: 1 },
    });
    expect(archived.status).toBe(200);

    const exported = (await (await call(app, alice, '/api/export')).json()) as AccountExport;
    const saved = exported.vocabulary.find((item) => item.id === word.id);
    expect(saved?.senses).toHaveLength(2);
    expect(saved?.senses.map((sense) => [sense.position, sense.meaning, sense.archived])).toEqual([
      [0, 'nói dối', true],
      [1, 'nằm', false],
    ]);
    // The shown content follows the first live sense, here too.
    expect(saved?.meaning).toBe('nằm');
  });

  it('refuses a sense with nothing in it, and a twenty-sixth sense', async () => {
    const word = await addWord(alice, { word: 'run' });
    const empty = await addSense(alice, word.id, { meaning: null });
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).error.code).toBe('invalid_request');

    const missing = await addSense(alice, '99999999-0000-4000-8000-000000000042', { meaning: 'x' });
    expect(missing.status).toBe(404);

    for (let index = 0; index < 25; index += 1) {
      const added = await addSense(alice, word.id, { meaning: `nghĩa ${index}` });
      expect(added.status).toBe(201);
    }
    const overflow = await addSense(alice, word.id, { meaning: 'quá nhiều' });
    expect(overflow.status).toBe(400);
    expect((await errorOf(overflow)).error.code).toBe('invalid_request');
  }, 30_000);
});

/**
 * Two writes that collide, put one after the other — the strongest statement a
 * single-connection test store can make. Two transactions genuinely
 * overlapping in time is a separate, recorded-as-unverified question.
 */
describe('one edit after another on the same word', () => {
  it('edits two different senses without either disturbing the other', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    await addSense(alice, word.id, { meaning: 'nằm' });
    const before = (await fetchEntry(alice, word.id)).senses;

    const first = await patchSense(alice, word.id, before[0]!.id, {
      ifMatch: before[0]!.version,
      meaning: 'nói dối, giả dối',
    });
    expect(first.status).toBe(200);
    const second = await patchSense(alice, word.id, before[1]!.id, {
      ifMatch: before[1]!.version,
      example: 'Lie down at work.',
    });
    expect(second.status).toBe(200);

    const after = await fetchEntry(alice, word.id);
    expect(after.senses.map((sense) => sense.version)).toEqual([2, 2]);
    expect(after.senses[0]).toMatchObject({ meaning: 'nói dối, giả dối', example: null });
    expect(after.senses[1]).toMatchObject({ meaning: 'nằm', example: 'Lie down at work.' });
  });

  it('refuses a reorder captured before an add, and accepts the current version', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    await addSense(alice, word.id, { meaning: 'nằm' }); // the version is now 2
    const ids = (await fetchEntry(alice, word.id)).senses.map((sense) => sense.id);
    const order = `/api/vocabulary/${word.id}/senses/order`;

    const stale = await call(app, alice, order, {
      method: 'PATCH',
      body: { senseIds: [ids[1], ids[0]], ifMatch: 1 },
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).error.code).toBe('conflict');

    const fresh = await call(app, alice, order, {
      method: 'PATCH',
      body: { senseIds: [ids[1], ids[0]], ifMatch: 2 },
    });
    expect(fresh.status).toBe(200);
    expect((await fetchEntry(alice, word.id)).senses.map((sense) => sense.id)).toEqual([ids[1], ids[0]]);
  });

  it('refuses an archive captured before the edit, and an edit captured before the archive', async () => {
    // Direction one: the edit lands first, so the earlier archive is stale.
    const edited = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    const first = edited.senses[0]!;
    expect((await patchSense(alice, edited.id, first.id, { ifMatch: first.version, meaning: 'nói dối, giả dối' })).status).toBe(200);
    const staleArchive = await call(app, alice, `/api/vocabulary/${edited.id}/senses/${first.id}/archive`, {
      method: 'POST',
      body: { ifMatch: first.version },
    });
    expect(staleArchive.status).toBe(409);
    expect((await errorOf(staleArchive)).error.code).toBe('conflict');

    // Direction two: the archive lands first, so the earlier edit is stale.
    const word = await addWord(alice, { word: 'run', meaning: 'chạy' });
    await addSense(alice, word.id, { meaning: 'chạy bộ' });
    const senses = (await fetchEntry(alice, word.id)).senses;
    const archived = await call(app, alice, `/api/vocabulary/${word.id}/senses/${senses[1]!.id}/archive`, {
      method: 'POST',
      body: { ifMatch: senses[1]!.version },
    });
    expect(archived.status).toBe(200);
    const staleEdit = await patchSense(alice, word.id, senses[1]!.id, { ifMatch: senses[1]!.version, meaning: 'x' });
    expect(staleEdit.status).toBe(409);
    // Even with the version now current it is refused: the sense is archived.
    const currentEdit = await patchSense(alice, word.id, senses[1]!.id, { ifMatch: senses[1]!.version + 1, meaning: 'x' });
    expect(currentEdit.status).toBe(409);
  });

  it('refuses a restore captured before the archive, then accepts one and keeps adding behind it', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    await addSense(alice, word.id, { meaning: 'nằm' });
    const senses = (await fetchEntry(alice, word.id)).senses;
    const archived = await call(app, alice, `/api/vocabulary/${word.id}/senses/${senses[0]!.id}/archive`, {
      method: 'POST',
      body: { ifMatch: senses[0]!.version },
    });
    expect(archived.status).toBe(200);

    const stale = await call(app, alice, `/api/vocabulary/${word.id}/senses/${senses[0]!.id}/restore`, {
      method: 'POST',
      body: { ifMatch: senses[0]!.version },
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).error.code).toBe('conflict');

    const current = await call(app, alice, `/api/vocabulary/${word.id}/senses/${senses[0]!.id}/restore`, {
      method: 'POST',
      body: { ifMatch: senses[0]!.version + 1 },
    });
    expect(current.status).toBe(200);
    // A restored sense goes to the end: its old slot may have been taken.
    // A new sense still lands behind it after all of that.
    const added = await addSense(alice, word.id, { meaning: 'giả' });
    expect(added.status).toBe(201);
    const after = await fetchEntry(alice, word.id);
    expect(after.senses.map((sense) => sense.position)).toEqual([1, 2, 3]);
    expect(after.senses.map((sense) => sense.meaning)).toEqual(['nằm', 'nói dối', 'giả']);
    expect(after.senses[2]).toMatchObject({ meaning: 'giả', archived: false });
  });

  it('refuses a sense edit written against the version a whole-word edit has moved on from', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    const sense = word.senses[0]!;

    // The legacy whole-word edit writes through to the first live sense.
    const wordEdit = await call(app, alice, `/api/vocabulary/${word.id}`, {
      method: 'PATCH',
      body: { definition: 'to say what is not true' },
    });
    expect(wordEdit.status).toBe(200);
    expect((await fetchEntry(alice, word.id)).senses[0]).toMatchObject({ version: 2 });

    const stale = await patchSense(alice, word.id, sense.id, { ifMatch: sense.version, meaning: 'nói dối' });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).error.code).toBe('conflict');

    const fresh = await patchSense(alice, word.id, sense.id, { ifMatch: sense.version + 1, meaning: 'nói dối' });
    expect(fresh.status).toBe(200);
  });
});

/**
 * A word in the trash is not open for sense work. The service refuses each
 * call, and from schema version 15 the database refuses the same calls on its
 * own — the tests here state the API's half, and tests/database/
 * atomic-sense-ops.test.ts states the database's.
 */
describe('a word in the trash: every sense operation refuses it', () => {
  it('refuses add, edit, archive, restore and reorder until the word is out of the trash again', async () => {
    const word = await addWord(alice, { word: 'lie', meaning: 'nói dối' });
    await addSense(alice, word.id, { meaning: 'nằm' });
    const senses = (await fetchEntry(alice, word.id)).senses;
    const second = senses[1]!;
    const archived = await call(app, alice, `/api/vocabulary/${word.id}/senses/${second.id}/archive`, {
      method: 'POST',
      body: { ifMatch: second.version },
    });
    expect(archived.status).toBe(200);
    const listed = (await fetchEntry(alice, word.id)).senses;
    const first = listed[0]!;

    expect((await call(app, alice, `/api/vocabulary/${word.id}`, { method: 'DELETE' })).status).toBe(200);

    expect((await call(app, alice, `/api/vocabulary/${word.id}/senses`)).status).toBe(404);
    expect((await addSense(alice, word.id, { meaning: 'mới' })).status).toBe(404);
    expect((await patchSense(alice, word.id, first.id, { ifMatch: first.version, meaning: 'x' })).status).toBe(404);
    expect(
      (await call(app, alice, `/api/vocabulary/${word.id}/senses/${first.id}/archive`, {
        method: 'POST',
        body: { ifMatch: first.version },
      })).status,
    ).toBe(404);
    expect(
      (await call(app, alice, `/api/vocabulary/${word.id}/senses/${second.id}/restore`, {
        method: 'POST',
        body: { ifMatch: listed[1]!.version },
      })).status,
    ).toBe(404);
    expect(
      (await call(app, alice, `/api/vocabulary/${word.id}/senses/order`, {
        method: 'PATCH',
        body: { senseIds: [first.id], ifMatch: 3 },
      })).status,
    ).toBe(404);

    // None of that wrote anything. Out of the trash, the same calls land.
    expect((await call(app, alice, `/api/vocabulary/${word.id}/restore`, { method: 'POST' })).status).toBe(200);
    const back = await fetchEntry(alice, word.id);
    expect(back.senses.map((sense) => [sense.meaning, sense.archived, sense.version])).toEqual([
      ['nói dối', false, 1],
      ['nằm', true, 2],
    ]);
    expect((await addSense(alice, word.id, { meaning: 'mới' })).status).toBe(201);
    const restored = await call(app, alice, `/api/vocabulary/${word.id}/senses/${back.senses[1]!.id}/restore`, {
      method: 'POST',
      body: { ifMatch: back.senses[1]!.version },
    });
    expect(restored.status).toBe(200);
  });
});

describe('an account whose database has not had the migration yet', () => {
  let behind: TestDatabase;
  let owner: TestUser;
  let legacy: TestApp;

  beforeAll(async () => {
    behind = await createTestDatabase({ migrations: 12 });
  }, 60_000);

  afterAll(async () => {
    await behind.close();
  });

  beforeEach(async () => {
    await behind.admin('delete from auth.users');
    owner = await createTestUser(behind, 'owner');
    legacy = createSupabaseTestApp(behind, [owner]);
  });

  it('reports the sense features as off and refuses them with a clear reason', async () => {
    const queue = queueResponseSchema.parse(await (await call(legacy, owner, '/api/review-queue')).json());
    expect(queue.capabilities.senses).toBe(false);

    const word = await addWord(owner, { word: 'candid', meaning: 'thẳng thắn' }, legacy);
    expect(word.senses).toEqual([]);

    const response = await call(legacy, owner, `/api/vocabulary/${word.id}/senses`, {
      method: 'POST',
      body: { requestId: newId(), meaning: 'mới' },
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).error.code).toBe('not_supported');
  });

  it('gains the senses its words already carried, once the migration is run', async () => {
    const word = await addWord(owner, { word: 'candid', meaning: 'thẳng thắn', definition: 'honest' }, legacy);

    for (const migration of readMigrations().slice(12)) await behind.db.exec(migration.sql);
    const running = createSupabaseTestApp(behind, [owner]);

    const queue = queueResponseSchema.parse(await (await call(running, owner, '/api/review-queue')).json());
    expect(queue.capabilities.senses).toBe(true);

    const after = await fetchEntry(owner, word.id, running);
    expect(after.senses).toHaveLength(1);
    expect(after.senses[0]).toMatchObject({
      position: 0,
      meaning: 'thẳng thắn',
      definition: 'honest',
      archived: false,
      version: 1,
    });
    expect(after.meaning).toBe('thẳng thắn');
    expect(after.sensesVersion).toBe(1);
  }, 60_000);

  it('gives a word already in the trash its senses too, so nothing is left behind', async () => {
    // Its own store: this one is migrated by hand inside the test.
    const fresh = await createTestDatabase({ migrations: 12 });
    try {
      const owner = await createTestUser(fresh, 'trash-owner');
      const legacyApp = createSupabaseTestApp(fresh, [owner]);
      const word = await addWord(owner, { word: 'candid', meaning: 'thẳng thắn', definition: 'honest' }, legacyApp);
      expect((await call(legacyApp, owner, `/api/vocabulary/${word.id}`, { method: 'DELETE' })).status).toBe(200);

      for (const migration of readMigrations().slice(12)) await fresh.db.exec(migration.sql);

      // Read the rows themselves: the trash keeps the word out of the live view.
      const stored = await fresh.admin(
        `select meaning, definition from public.vocabulary_senses where vocabulary_id = '${word.id}' order by position`,
      );
      expect(stored).toEqual([{ meaning: 'thẳng thắn', definition: 'honest' }]);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
