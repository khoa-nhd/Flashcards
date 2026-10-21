/**
 * Discovery & Input over the HTTP API on the real schema: sources of every
 * kind, selections marked for later, the explicit save that makes a word,
 * and every boundary — another reader's source, a stale revision, a frozen
 * account — landing where it should.
 *
 * Three rules are proved here above all: nothing in discovery creates a
 * vocabulary entry except the two explicit saves (through the ordinary word
 * path, duplicate check included); a mark for later references no vocabulary
 * at all and keeps only the context around a selection; and reading,
 * marking and dismissing leave the learning record byte for byte untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newWordDefaults } from '../../config/review.config.js';
import {
  discoveryContextResponseSchema,
  discoveryListResponseSchema,
  discoveryMarksResponseSchema,
  discoverySaveResponseSchema,
  discoverySourceResponseSchema,
  discoverySourceSchema,
} from '../../shared/discovery.js';
import { entryResponseSchema, vocabularyListResponseSchema, type VocabularyEntry } from '../../shared/api.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type Row, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;

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
});

const TODAY = '2026-10-09';
const on = (env?: Record<string, string>) =>
  createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${TODAY}T05:00:00Z`), env });

const SENTENCE = 'The candid answer surprised everyone at the table.';

async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(status);
  return (await settled.json()) as T;
}

const send = (app: TestApp, user: TestUser, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
  call(app, user, path, { method, body });

const errorCodeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

const errorMessageOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { message: string } }).error.message;

const newSource = async (app: TestApp, user: TestUser, body: Record<string, unknown> = {}) =>
  (
    await ok<{ source: z.infer<typeof discoverySourceSchema> }>(
      send(app, user, 'POST', '/api/discovery', { kind: 'text', title: 'A reading', content: SENTENCE, requestId: newId(), ...body }),
      201,
    )
  ).source;

const documentOf = async (app: TestApp, user: TestUser, id: string) =>
  discoverySourceResponseSchema.parse(await (await call(app, user, `/api/discovery/${id}`)).json()).source;

const listSources = async (app: TestApp, user: TestUser) =>
  discoveryListResponseSchema.parse(await (await call(app, user, '/api/discovery')).json()).sources;

const markSelection = async (app: TestApp, user: TestUser, sourceId: string, body: Record<string, unknown> = {}) =>
  (
    await ok<{ mark: z.infer<typeof discoverySaveResponseSchema>['mark'] }>(
      send(app, user, 'POST', `/api/discovery/${sourceId}/marks`, {
        requestId: newId(),
        sourceId,
        label: 'candid',
        offset: 4,
        ...body,
      }),
      201,
    )
  ).mark;

const wordsOf = async (app: TestApp, user: TestUser): Promise<VocabularyEntry[]> =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;

const addWord = async (app: TestApp, user: TestUser, word: string): Promise<VocabularyEntry> => {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), word } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
};

// ---------------------------------------------------------------------------

describe('sources of every kind a learner may bring in', () => {
  it('keeps each kind with its content and provenance, listed and openable', async () => {
    const app = on();
    for (const [index, kind] of ['text', 'reading', 'listening', 'generated', 'imported', 'web', 'capture'].entries()) {
      const source = await newSource(app, alice, {
        kind,
        title: `Source ${index}`,
        origin: kind === 'web' ? 'https://example.test/page' : 'typed',
        content: kind === 'listening' ? '00:00:01 --> 00:00:04\nThe candid answer.' : SENTENCE,
        contentKind: kind === 'listening' ? 'transcript' : 'plain',
      });
      expect(source.kind).toBe(kind);
      expect(source.revision).toBe(1);
      expect(source.markedCount).toBe(0);
      expect(source.savedCount).toBe(0);
      const document = await documentOf(app, alice, source.id);
      expect(document.title).toBe(`Source ${index}`);
      expect(document.origin).toBe(kind === 'web' ? 'https://example.test/page' : 'typed');
      expect(document.contentKind).toBe(kind === 'listening' ? 'transcript' : 'plain');
      expect(document.marks).toEqual([]);
    }
    expect(await listSources(app, alice)).toHaveLength(7);
    expect(await listSources(app, bob)).toHaveLength(0);
  });

  it('answers a repeated request with the source it first made', async () => {
    const app = on();
    const requestId = newId();
    const first = await newSource(app, alice, { requestId });
    const second = await newSource(app, alice, { requestId });
    expect(second.id).toBe(first.id);
    expect(await listSources(app, alice)).toHaveLength(1);
  });

  it('refuses a blank title, an unknown kind, and content past the reading cap', async () => {
    const app = on();
    const blank = await send(app, alice, 'POST', '/api/discovery', { kind: 'text', title: '   ', content: 'x', requestId: newId() });
    expect(blank.status).toBe(400);
    expect(await errorCodeOf(blank)).toBe('invalid_request');

    const unknown = await send(app, alice, 'POST', '/api/discovery', { kind: 'diary', title: 'Nope', content: 'x', requestId: newId() });
    expect(unknown.status).toBe(400);

    const tooMuch = await send(app, alice, 'POST', '/api/discovery', {
      kind: 'imported',
      title: 'A whole book',
      content: 'word '.repeat(30_000),
      requestId: newId(),
    });
    expect(tooMuch.status).toBe(400);
    expect(await errorMessageOf(tooMuch)).toContain('excerpt rather than a whole book');
  });

  it('refuses a body past the discovery envelope before the schema ever sees it', async () => {
    const app = on();
    // 400 KB is discovery's own cap (source content travels in the request).
    const huge = await send(app, alice, 'POST', '/api/discovery', {
      kind: 'text',
      title: 'Too much',
      content: 'x'.repeat(401 * 1024),
      requestId: newId(),
    });
    expect(huge.status).toBe(413);
    expect(await errorCodeOf(huge)).toBe('payload_too_large');

    // Just under that cap, the ordinary reading cap still decides.
    const overCap = await send(app, alice, 'POST', '/api/discovery', {
      kind: 'text',
      title: 'Slightly too much',
      content: 'x'.repeat(120_001),
      requestId: newId(),
    });
    expect(overCap.status).toBe(400);
    expect(await errorCodeOf(overCap)).toBe('invalid_request');
    expect(await listSources(app, alice)).toHaveLength(0);
  });

  it('refuses another account’s source with not_found, on every verb', async () => {
    const app = on();
    const source = await newSource(app, alice);
    expect((await call(app, bob, `/api/discovery/${source.id}`)).status).toBe(404);
    const patch = await send(app, bob, 'PATCH', `/api/discovery/${source.id}`, { title: 'Stolen' });
    expect(patch.status).toBe(404);
    expect(await errorCodeOf(patch)).toBe('not_found');
    expect((await send(app, bob, 'DELETE', `/api/discovery/${source.id}`)).status).toBe(404);
    expect(await listSources(app, bob)).toHaveLength(0);
    // Alice's source is untouched.
    expect((await documentOf(app, alice, source.id)).title).toBe('A reading');
  });

  it('moves the revision only on a title edit, and only against the hand the reader had', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const renamed = await ok<{ source: z.infer<typeof discoverySourceSchema> }>(
      send(app, alice, 'PATCH', `/api/discovery/${source.id}`, { title: 'Renamed reading', ifMatch: 1 }),
    );
    expect(renamed.source.title).toBe('Renamed reading');
    expect(renamed.source.revision).toBe(2);

    const stale = await send(app, alice, 'PATCH', `/api/discovery/${source.id}`, { title: 'From an old copy', ifMatch: 1 });
    expect(stale.status).toBe(409);
    expect(await errorCodeOf(stale)).toBe('conflict');
    expect((await documentOf(app, alice, source.id)).title).toBe('Renamed reading');
  });

  it('restores a reading position without touching the revision an edit is checked against', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const moved = await ok<{ source: z.infer<typeof discoverySourceSchema> }>(
      send(app, alice, 'PATCH', `/api/discovery/${source.id}`, { position: { offset: 42 } }),
    );
    expect(moved.source.position).toEqual({ offset: 42 });
    expect(moved.source.revision).toBe(1);
    // The same stale hand still edits: a position save never moved the revision.
    const renamed = await ok<{ source: z.infer<typeof discoverySourceSchema> }>(
      send(app, alice, 'PATCH', `/api/discovery/${source.id}`, { title: 'Renamed', ifMatch: 1 }),
    );
    expect(renamed.source.revision).toBe(2);
    expect((await documentOf(app, alice, source.id)).position).toEqual({ offset: 42 });
  });

  it('refuses an empty edit and a position with nothing in it', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const empty = await send(app, alice, 'PATCH', `/api/discovery/${source.id}`, {});
    expect(empty.status).toBe(400);
    const blankPosition = await send(app, alice, 'PATCH', `/api/discovery/${source.id}`, { position: {} });
    expect(blankPosition.status).toBe(400);
  });

  it('takes a source and its marks with it, and never the words they became', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', { word: 'candid', sourceId: source.id, requestId: newId() }),
      201,
    );
    expect(await wordsOf(app, alice)).toHaveLength(1);

    expect((await send(app, alice, 'DELETE', `/api/discovery/${source.id}`)).status).toBe(200);
    expect((await call(app, alice, `/api/discovery/${source.id}`)).status).toBe(404);
    expect(await listSources(app, alice)).toHaveLength(0);
    // The word stands, exactly where it was.
    const words = await wordsOf(app, alice);
    expect(words.map((word) => word.id)).toEqual([saved.entry.id]);
    // Its provenance went with the source it came from — honestly reported as gone.
    const context = await call(app, alice, `/api/discovery/context?vocabularyId=${saved.entry.id}`);
    expect(context.status).toBe(404);
  });
});

describe('marking a selection for later', () => {
  it('keeps the sentence around it and saves nothing at all', async () => {
    const app = on();
    const source = await newSource(app, alice, { content: `${SENTENCE} Nothing else.` });
    const mark = await markSelection(app, alice, source.id);
    expect(mark.label).toBe('candid');
    expect(mark.context).toBe(SENTENCE);
    expect(mark.offset).toBe(4);
    expect(mark.vocabularyId).toBeNull();
    expect(mark.savedAt).toBeNull();

    expect(await wordsOf(app, alice)).toEqual([]);
    const listed = discoveryMarksResponseSchema.parse(await (await call(app, alice, '/api/discovery/marks')).json()).marks;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: mark.id, sourceTitle: 'A reading', sourceKind: 'text' });
  });

  it('offers the same waiting selection only once, however often it is offered', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const first = await markSelection(app, alice, source.id);
    const second = await markSelection(app, alice, source.id, { requestId: newId() });
    expect(second.id).toBe(first.id);
    expect((await documentOf(app, alice, source.id)).marks).toHaveLength(1);
  });

  it('answers a repeated submission with the mark it first made', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const requestId = newId();
    const first = await markSelection(app, alice, source.id, { requestId });
    const second = await markSelection(app, alice, source.id, { requestId });
    expect(second.id).toBe(first.id);
    expect((await documentOf(app, alice, source.id)).marks).toHaveLength(1);
  });

  it('insists a cue carries both of its ends', async () => {
    const app = on();
    const source = await newSource(app, alice, { kind: 'listening', contentKind: 'transcript' });
    const oneSided = await send(app, alice, 'POST', `/api/discovery/${source.id}/marks`, {
      requestId: newId(),
      sourceId: source.id,
      label: 'candid',
      cueStart: 1000,
    });
    expect(oneSided.status).toBe(400);
    const both = await ok<{ mark: z.infer<typeof discoverySaveResponseSchema>['mark'] }>(
      send(app, alice, 'POST', `/api/discovery/${source.id}/marks`, {
        requestId: newId(),
        sourceId: source.id,
        label: 'candid',
        cueStart: 1000,
        cueEnd: 3400,
        context: 'The candid answer.',
      }),
      201,
    );
    expect(both.mark.cueStart).toBe(1000);
    expect(both.mark.cueEnd).toBe(3400);
  });

  it('refuses a selection that belongs to another source, and another account’s source', async () => {
    const app = on();
    const one = await newSource(app, alice);
    const two = await newSource(app, alice);
    const crossed = await send(app, alice, 'POST', `/api/discovery/${one.id}/marks`, {
      requestId: newId(),
      label: 'candid',
      sourceId: two.id,
    });
    expect(crossed.status).toBe(400);

    const stolen = await send(app, bob, 'POST', `/api/discovery/${one.id}/marks`, {
      requestId: newId(),
      label: 'candid',
      sourceId: one.id,
    });
    expect(stolen.status).toBe(404);
    expect(await wordsOf(app, bob)).toEqual([]);
  });

  it('dismisses a waiting selection and leaves nothing behind', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const mark = await markSelection(app, alice, source.id);
    expect((await send(app, alice, 'DELETE', `/api/discovery/marks/${mark.id}`)).status).toBe(200);
    expect((await documentOf(app, alice, source.id)).marks).toEqual([]);
    expect(
      discoveryMarksResponseSchema.parse(await (await call(app, alice, '/api/discovery/marks')).json()).marks,
    ).toEqual([]);
    expect((await send(app, alice, 'DELETE', `/api/discovery/marks/${mark.id}`)).status).toBe(404);
    // Another account cannot dismiss it either — it is simply not there for them.
    expect((await send(app, bob, 'DELETE', `/api/discovery/marks/${mark.id}`)).status).toBe(404);
  });
});

describe('saving a selection — the one path from a source to a word', () => {
  it('creates exactly one word, with the sentence as its example and the mark as its provenance', async () => {
    const app = on();
    const source = await newSource(app, alice, { content: SENTENCE });
    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', {
        word: 'candid',
        sourceId: source.id,
        meaning: 'thẳng thắn',
        offset: 4,
        requestId: newId(),
      }),
      201,
    );
    expect(saved.entry.word).toBe('candid');
    expect(saved.entry.meaning).toBe('thẳng thắn');
    // No example was given, so the source's own sentence is what it keeps.
    expect(saved.entry.example).toBe(SENTENCE);
    expect(saved.mark.vocabularyId).toBe(saved.entry.id);
    expect(saved.mark.savedAt).not.toBeNull();
    expect(saved.mark.context).toBe(SENTENCE);
    expect(saved.mark.offset).toBe(4);

    expect(await wordsOf(app, alice)).toHaveLength(1);
    const document = await documentOf(app, alice, source.id);
    expect(document.savedCount).toBe(1);
    expect(document.markedCount).toBe(0);
    expect(document.marks).toHaveLength(1);
  });

  it('reuses the waiting mark rather than keeping the same selection twice', async () => {
    const app = on();
    const source = await newSource(app, alice);
    await markSelection(app, alice, source.id);
    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', { word: 'candid', sourceId: source.id, requestId: newId() }),
      201,
    );
    const document = await documentOf(app, alice, source.id);
    expect(document.marks).toHaveLength(1);
    expect(document.marks[0]!.id).toBe(saved.mark.id);
    expect(document.marks[0]!.vocabularyId).toBe(saved.entry.id);
    expect(document.markedCount).toBe(0);
    expect(await wordsOf(app, alice)).toHaveLength(1);
  });

  it('refuses a duplicate word unless the learner chooses to keep it anyway', async () => {
    const app = on();
    await addWord(app, alice, 'candid');
    const source = await newSource(app, alice);
    const refused = await send(app, alice, 'POST', '/api/discovery/save', {
      word: 'candid',
      sourceId: source.id,
      requestId: newId(),
    });
    expect(refused.status).toBe(409);
    expect(await errorCodeOf(refused)).toBe('duplicate');
    expect(await wordsOf(app, alice)).toHaveLength(1);

    const kept = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', {
        word: 'candid',
        sourceId: source.id,
        allowDuplicate: true,
        requestId: newId(),
      }),
      201,
    );
    expect(await wordsOf(app, alice)).toHaveLength(2);
    expect(kept.mark.vocabularyId).toBe(kept.entry.id);
  });

  it('lands a repeated submission once: one word, one mark', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const requestId = newId();
    const body = { word: 'candid', sourceId: source.id, offset: 4, requestId };
    const first = await ok<z.infer<typeof discoverySaveResponseSchema>>(send(app, alice, 'POST', '/api/discovery/save', body), 201);
    const second = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', { ...body, offset: 4 }),
      201,
    );
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.mark.id).toBe(first.mark.id);
    expect(await wordsOf(app, alice)).toHaveLength(1);
    expect((await documentOf(app, alice, source.id)).marks).toHaveLength(1);
  });

  it('never saves from another account’s source', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const stolen = await send(app, bob, 'POST', '/api/discovery/save', { word: 'candid', sourceId: source.id, requestId: newId() });
    expect(stolen.status).toBe(404);
    expect(await wordsOf(app, alice)).toEqual([]);
    expect(await wordsOf(app, bob)).toEqual([]);
  });
});

describe('saving a marked item later', () => {
  it('gives the waiting selection its word, from the selection’s own text', async () => {
    const app = on();
    const source = await newSource(app, alice, { content: SENTENCE });
    const mark = await markSelection(app, alice, source.id, { note: 'collocation' });
    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', `/api/discovery/marks/${mark.id}/save`, { requestId: newId(), meaning: 'thẳng thắn' }),
      201,
    );
    expect(saved.entry.word).toBe('candid');
    expect(saved.entry.meaning).toBe('thẳng thắn');
    expect(saved.entry.example).toBe(SENTENCE);
    expect(saved.mark.vocabularyId).toBe(saved.entry.id);
    expect(saved.mark.note).toBe('collocation');
    const document = await documentOf(app, alice, source.id);
    expect(document.savedCount).toBe(1);
    expect(document.markedCount).toBe(0);
  });

  it('answers a second press with the word that already landed', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const mark = await markSelection(app, alice, source.id);
    const first = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', `/api/discovery/marks/${mark.id}/save`, { requestId: newId() }),
      201,
    );
    const second = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', `/api/discovery/marks/${mark.id}/save`, { requestId: newId() }),
      201,
    );
    expect(second.entry.id).toBe(first.entry.id);
    expect(await wordsOf(app, alice)).toHaveLength(1);
  });

  it('refuses to dismiss a selection that is saved with its word', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const mark = await markSelection(app, alice, source.id);
    await ok(send(app, alice, 'POST', `/api/discovery/marks/${mark.id}/save`, { requestId: newId() }), 201);
    const refused = await send(app, alice, 'DELETE', `/api/discovery/marks/${mark.id}`);
    expect(refused.status).toBe(409);
    expect(await errorCodeOf(refused)).toBe('conflict');
    const document = await documentOf(app, alice, source.id);
    expect(document.marks).toHaveLength(1);
    expect(document.marks[0]!.vocabularyId).not.toBeNull();
  });

  it('never processes another account’s mark', async () => {
    const app = on();
    const source = await newSource(app, alice);
    const mark = await markSelection(app, alice, source.id);
    const stolen = await send(app, bob, 'POST', `/api/discovery/marks/${mark.id}/save`, { requestId: newId() });
    expect(stolen.status).toBe(404);
    expect(await wordsOf(app, bob)).toEqual([]);
    expect(await wordsOf(app, alice)).toEqual([]);
  });
});

describe('where a saved word was found', () => {
  it('answers with the mark and its source, and honestly has nothing for a word that did not come from one', async () => {
    const app = on();
    const source = await newSource(app, alice, { title: 'News article', content: SENTENCE });
    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', { word: 'candid', sourceId: source.id, offset: 4, requestId: newId() }),
      201,
    );
    const found = discoveryContextResponseSchema.parse(
      await (await call(app, alice, `/api/discovery/context?vocabularyId=${saved.entry.id}`)).json(),
    );
    expect(found.source.id).toBe(source.id);
    expect(found.source.title).toBe('News article');
    expect(found.mark.id).toBe(saved.mark.id);

    const plain = await addWord(app, alice, 'lucid');
    expect((await call(app, alice, `/api/discovery/context?vocabularyId=${plain.id}`)).status).toBe(404);
    expect((await call(app, bob, `/api/discovery/context?vocabularyId=${saved.entry.id}`)).status).toBe(404);
    expect((await call(app, alice, '/api/discovery/context?vocabularyId=not-a-uuid')).status).toBe(400);
  });
});

describe('generated content arrives as candidates', () => {
  it('keeps the suggested words as marks — waiting, never saved', async () => {
    const app = on();
    const source = await newSource(app, alice, {
      kind: 'generated',
      title: 'A generated reading',
      content: 'The candid answer surprised everyone. Candid words win trust.',
      suggestions: [
        { word: 'candid', note: 'often about answers' },
        { word: 'trust', sentence: 'Candid words win trust.' },
      ],
    });
    expect(await wordsOf(app, alice)).toEqual([]);
    const document = await documentOf(app, alice, source.id);
    expect(document.markedCount).toBe(2);
    expect(document.savedCount).toBe(0);
    expect(document.marks.map((mark) => mark.label).sort()).toEqual(['candid', 'trust']);
    const waiting = document.marks.find((mark) => mark.label === 'trust');
    expect(waiting?.context).toBe('Candid words win trust.');
    expect(waiting?.note).toBe('');
    expect(document.marks.find((mark) => mark.label === 'candid')?.note).toBe('often about answers');
  });

  it('refuses a suggested word that is not in the text, or one offered for other content', async () => {
    const app = on();
    const invented = await send(app, alice, 'POST', '/api/discovery', {
      kind: 'generated',
      title: 'Draft',
      content: 'Only these words are here.',
      suggestions: [{ word: 'invented' }],
      requestId: newId(),
    });
    expect(invented.status).toBe(400);
    expect(await errorMessageOf(invented)).toContain('must appear in the text');

    const misplaced = await send(app, alice, 'POST', '/api/discovery', {
      kind: 'reading',
      title: 'A reading',
      content: 'A reading with candid words.',
      suggestions: [{ word: 'candid' }],
      requestId: newId(),
    });
    expect(misplaced.status).toBe(400);
    expect(await errorMessageOf(misplaced)).toContain('generated content');
    expect(await listSources(app, alice)).toHaveLength(0);
  });
});

describe('discovery never touches the learning record', () => {
  const snapshot = async () => ({
    states: await db.admin<Row>('select * from public.card_states order by vocabulary_id'),
    logs: await db.admin<Row>('select * from public.review_logs order by id'),
    sessions: await db.admin<Row>('select * from public.study_sessions order by id'),
    practice: await db.admin<Row>("select * from public.review_logs where kind = 'practice' order by id"),
  });

  it('reads, opens, marks and dismisses while every schedule, log and practice row stands still', async () => {
    const app = on();
    const source = await newSource(app, alice, { content: SENTENCE });
    const mark = await markSelection(app, alice, source.id);
    const before = await snapshot();

    await call(app, alice, '/api/discovery');
    await call(app, alice, '/api/discovery/marks');
    await documentOf(app, alice, source.id);
    await wordsOf(app, alice);
    // A second selection, marked and dismissed: writes, but only to discovery rows.
    const other = await markSelection(app, alice, source.id, { label: 'surprised', offset: 16, requestId: newId() });
    await send(app, alice, 'DELETE', `/api/discovery/marks/${other.id}`);

    expect(await snapshot()).toEqual(before);
    // The dismissed selection left no word; the waiting mark kept waiting.
    expect(await wordsOf(app, alice)).toEqual([]);
    const document = await documentOf(app, alice, source.id);
    expect(document.marks.map((entry) => entry.id)).toEqual([mark.id]);
    expect(document.marks[0]!.vocabularyId).toBeNull();
  });

  it('an explicit save creates the word through the ordinary path and nothing else moves', async () => {
    const app = on();
    const source = await newSource(app, alice, { content: SENTENCE });
    const before = await snapshot();
    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', { word: 'candid', sourceId: source.id, offset: 4, requestId: newId() }),
      201,
    );
    const after = await snapshot();
    expect(after.logs).toEqual(before.logs);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.practice).toEqual(before.practice);
    // The only schedule row is the new word's own starting state — exactly
    // what the Add form's save would have created, at the configured default.
    // Discovery never edits mastery beyond that ordinary creation.
    expect(after.states).toHaveLength(1);
    expect(after.states[0]!.vocabulary_id).toBe(saved.entry.id);
    expect(after.states[0]!.mastery).toBe(newWordDefaults.mastery);
    expect(await wordsOf(app, alice)).toHaveLength(1);
  });
});

describe('a frozen account', () => {
  it('reads every view and is refused every write with read_only', async () => {
    // The rows exist under a writing account; the frozen app is the one read.
    const writable = on();
    const source = await newSource(writable, alice, { content: SENTENCE });
    const mark = await markSelection(writable, alice, source.id);
    const app = on({ REVIEW_WRITES_ENABLED: 'false' });

    expect(await listSources(app, alice)).toHaveLength(1);
    expect((await call(app, alice, `/api/discovery/${source.id}`)).status).toBe(200);
    expect((await call(app, alice, '/api/discovery/marks')).status).toBe(200);
    expect((await call(app, alice, `/api/discovery/context?vocabularyId=${newId()}`)).status).toBe(404);

    const writes: Array<[string, unknown]> = [
      ['POST', { kind: 'text', title: 'Nope', content: 'x', requestId: newId() }],
      ['PATCH', { title: 'Nope' }],
    ];
    for (const [method, body] of writes) {
      const path = method === 'POST' ? '/api/discovery' : `/api/discovery/${source.id}`;
      const response = await send(app, alice, method as 'POST' | 'PATCH', path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await errorCodeOf(response)).toBe('read_only');
    }
    for (const response of [
      await send(app, alice, 'POST', `/api/discovery/${source.id}/marks`, { requestId: newId(), sourceId: source.id, label: 'again' }),
      await send(app, alice, 'POST', '/api/discovery/save', { word: 'candid', sourceId: source.id, requestId: newId() }),
      await send(app, alice, 'POST', `/api/discovery/marks/${mark.id}/save`, { requestId: newId() }),
      await send(app, alice, 'DELETE', `/api/discovery/marks/${mark.id}`),
      await send(app, alice, 'DELETE', `/api/discovery/${source.id}`),
    ]) {
      expect(response.status).toBe(403);
      expect(await errorCodeOf(response)).toBe('read_only');
    }
    // Nothing moved: still one source, one waiting mark, no words.
    expect(await listSources(app, alice)).toHaveLength(1);
    expect((await documentOf(app, alice, source.id)).markedCount).toBe(1);
    expect(await wordsOf(app, alice)).toEqual([]);
  });
});

describe('suggestions from the quick-capture home', () => {
  it('keeps a standing capture source as ordinary content: mark, list, save', async () => {
    const app = on();
    const capture = await newSource(app, alice, { kind: 'capture', title: 'Quick captures', content: '' });
    const marked = await markSelection(app, alice, capture.id, { label: 'call it a day', context: '', offset: undefined });
    expect(marked.label).toBe('call it a day');
    const listed = discoveryMarksResponseSchema.parse(await (await call(app, alice, '/api/discovery/marks')).json()).marks;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.sourceKind).toBe('capture');

    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', `/api/discovery/marks/${marked.id}/save`, { requestId: newId() }),
      201,
    );
    expect(saved.entry.word).toBe('call it a day');
    expect(await wordsOf(app, alice)).toHaveLength(1);
    // A saved quick capture is no longer "waiting" anywhere.
    expect(
      discoveryMarksResponseSchema.parse(await (await call(app, alice, '/api/discovery/marks')).json()).marks,
    ).toEqual([]);
  });
});
