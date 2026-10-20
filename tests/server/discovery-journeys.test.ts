/**
 * Journeys A–J at the HTTP API on the real schema — one story each, walked
 * end to end through the routes a browser actually calls. The halves that
 * live only in a window (a workspace closing and reopening, a transcript
 * list on screen, the Word Profile overlay) are proved in the client tests;
 * everything the server must keep true is proved here:
 *
 *   A capture is saved only by its own press; a selection marked for later
 *   references no vocabulary; a reading position outlives the session that
 *   set it; a cue keeps its timestamp; a generated draft changes nothing
 *   until it is accepted, and nothing until each word is saved; a fetched
 *   page previews before it exists; a saved word leads back to its source;
 *   a duplicate is offered for reuse; and across a whole day of discovery
 *   the review record, schedules and practice rows stand byte for byte
 *   still — until the one explicit save, which lands exactly like the Add
 *   form's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiExtractResponseSchema } from '../../shared/ai.js';
import { entryResponseSchema, vocabularyListResponseSchema, type VocabularyEntry } from '../../shared/api.js';
import {
  discoveryContextResponseSchema,
  discoveryListResponseSchema,
  discoveryMarksResponseSchema,
  discoverySaveResponseSchema,
  discoverySourceResponseSchema,
  fetchUrlResponseSchema,
} from '../../shared/discovery.js';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

const TODAY = '2026-10-09';
const AI_ENV = { AI_API_KEY: 'test-key', AI_MODEL: 'test-model' };
const on = (env: Record<string, string> = AI_ENV, webImporter?: { fetch: (url: string) => Promise<{ title: string; text: string; origin: string }> }) =>
  createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${TODAY}T05:00:00Z`), env, webImporter });

/** The model endpoint as the adapter sees it: a chat reply carrying JSON. */
function modelReplies(content: string) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ok = async <T>(response: Response | Promise<Response>, status = 200): Promise<T> => {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(status);
  return (await settled.json()) as T;
};

const send = (app: TestApp, user: TestUser, method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, body?: unknown) =>
  call(app, user, path, { method, body });

const wordsOf = async (app: TestApp, user: TestUser): Promise<VocabularyEntry[]> =>
  vocabularyListResponseSchema.parse(await (await call(app, user, '/api/vocabulary')).json()).entries;

const sourcesOf = async (app: TestApp, user: TestUser) =>
  discoveryListResponseSchema.parse(await (await call(app, user, '/api/discovery')).json()).sources;

const marksOf = async (app: TestApp, user: TestUser) =>
  discoveryMarksResponseSchema.parse(await (await call(app, user, '/api/discovery/marks')).json()).marks;

const documentOf = async (app: TestApp, user: TestUser, id: string) =>
  discoverySourceResponseSchema.parse(await (await call(app, user, `/api/discovery/${id}`)).json()).source;

const newSource = async (app: TestApp, user: TestUser, body: Record<string, unknown>) =>
  (await ok<{ source: { id: string } }>(send(app, user, 'POST', '/api/discovery', { requestId: newId(), ...body }), 201)).source;

const addWord = async (app: TestApp, user: TestUser, word: string): Promise<VocabularyEntry> =>
  entryResponseSchema.parse(await ok(await send(app, user, 'POST', '/api/vocabulary', { requestId: newId(), word }), 201)).entry;

// ---------------------------------------------------------------------------

describe('Journey A — capture a phrase, then save it on its own press', () => {
  it('holds the phrase as a mark with no word until the learner says save', async () => {
    const app = on();
    const capture = await newSource(app, alice, { kind: 'capture', title: 'Quick captures', content: '' });

    const marked = await ok<{ mark: { id: string; label: string } }>(
      send(app, alice, 'POST', `/api/discovery/${capture.id}/marks`, {
        requestId: newId(),
        sourceId: capture.id,
        label: 'call it a day',
        context: '',
        offset: 0,
      }),
      201,
    );
    expect(marked.mark.label).toBe('call it a day');
    expect(await wordsOf(app, alice)).toEqual([]);
    expect(await marksOf(app, alice)).toHaveLength(1);

    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', `/api/discovery/marks/${marked.mark.id}/save`, { requestId: newId(), meaning: 'ngừng làm việc' }),
      201,
    );
    expect(saved.entry.word).toBe('call it a day');
    expect(saved.entry.meaning).toBe('ngừng làm việc');
    expect(await wordsOf(app, alice)).toHaveLength(1);
    expect(await marksOf(app, alice)).toEqual([]);
    const document = await documentOf(app, alice, capture.id);
    expect(document.savedCount).toBe(1);
    expect(document.markedCount).toBe(0);
  });
});

describe('Journey B — read a source, explain the selected word, save it with its sentence', () => {
  it('explains only the picked sentence, then saves the word with the sentence beside it', async () => {
    const app = on();
    const SENTENCE = 'The board gave a candid account of the loss.';
    const source = await newSource(app, alice, {
      kind: 'reading',
      title: 'Annual report, plainly',
      content: `${SENTENCE} Everyone stayed late to argue about slides.`,
    });

    // The reader asks what the selection means — only the sentence travels.
    const fetchMock = modelReplies(JSON.stringify({ definition: 'Frank and honest.', meaning: 'thẳng thắn, bộc trực' }));
    const explanation = aiExtractResponseSchema.parse(
      await (await send(app, alice, 'POST', '/api/ai/extract', { text: SENTENCE, word: 'candid' })).json(),
    );
    expect(explanation.sentence).toBe(SENTENCE);
    const sent = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
    expect(sent).toContain('candid');
    expect(sent).not.toContain('argue about slides');

    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', {
        word: 'candid',
        sourceId: source.id,
        offset: SENTENCE.indexOf('candid'),
        meaning: explanation.meaning ?? undefined,
        requestId: newId(),
      }),
      201,
    );
    expect(saved.entry.example).toBe(SENTENCE);
    expect(saved.entry.meaning).toBe('thẳng thắn, bộc trực');
    expect(saved.mark.context).toBe(SENTENCE);
  });
});

describe('Journey C — mark for later, save nothing, dismiss with nothing left over', () => {
  it('keeps the selection out of the library entirely until a save says otherwise', async () => {
    const app = on();
    const source = await newSource(app, alice, { kind: 'reading', title: 'An essay', content: 'A lucid point in the third paragraph.' });
    const marked = await ok<{ mark: { id: string } }>(
      send(app, alice, 'POST', `/api/discovery/${source.id}/marks`, {
        requestId: newId(),
        sourceId: source.id,
        label: 'lucid',
        offset: 2,
        note: 'come back to this',
      }),
      201,
    );

    expect(await wordsOf(app, alice)).toEqual([]);
    const waiting = await marksOf(app, alice);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ label: 'lucid', vocabularyId: null, sourceTitle: 'An essay', note: 'come back to this' });

    await ok(send(app, alice, 'DELETE', `/api/discovery/marks/${marked.mark.id}`));
    expect(await marksOf(app, alice)).toEqual([]);
    expect(await wordsOf(app, alice)).toEqual([]);
    // The source itself was never touched by any of this.
    expect((await documentOf(app, alice, source.id)).revision).toBe(1);
  });
});

describe('Journey D — a reading position outlives the session that set it', () => {
  it('restores the offset on the next app session, with the content and the revision as they were', async () => {
    const source = await (async () => {
      const app = on();
      return newSource(app, alice, { kind: 'reading', title: 'Long read', content: 'x'.repeat(500) });
    })();
    await ok(send(on(), alice, 'PATCH', `/api/discovery/${source.id}`, { position: { offset: 120 } }));

    // A fresh app over the same database: the learner closed and reopened.
    const reopened = on();
    const document = await documentOf(reopened, alice, source.id);
    expect(document.position).toEqual({ offset: 120 });
    expect(document.content).toHaveLength(500);
    expect(document.revision).toBe(1);
    expect(await wordsOf(reopened, alice)).toEqual([]);
  });
});

describe('Journey E — listen to a transcript, keep the cue, capture with its timestamp', () => {
  it('marks the words at their cue, lists them with the source being listening, and saves with both times kept', async () => {
    const app = on();
    const transcript = '00:00:01,000 --> 00:00:03,400\nGood evening, and welcome.\n\n00:00:03,400 --> 00:00:06,000\nThe candid part comes next.';
    const source = await newSource(app, alice, { kind: 'listening', title: 'Episode 12', content: transcript, contentKind: 'transcript' });

    const marked = await ok<{ mark: { id: string; cueStart: number | null; cueEnd: number | null } }>(
      send(app, alice, 'POST', `/api/discovery/${source.id}/marks`, {
        requestId: newId(),
        sourceId: source.id,
        label: 'candid',
        cueStart: 3400,
        cueEnd: 6000,
        context: 'The candid part comes next.',
      }),
      201,
    );
    expect(marked.mark.cueStart).toBe(3400);
    expect(marked.mark.cueEnd).toBe(6000);
    expect(await wordsOf(app, alice)).toEqual([]);

    const listed = await marksOf(app, alice);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sourceKind: 'listening', sourceTitle: 'Episode 12', cueStart: 3400, cueEnd: 6000 });

    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', `/api/discovery/marks/${marked.mark.id}/save`, { requestId: newId() }),
      201,
    );
    expect(saved.entry.word).toBe('candid');
    expect(saved.mark.cueStart).toBe(3400);
    expect(saved.mark.cueEnd).toBe(6000);
    expect(saved.mark.context).toBe('The candid part comes next.');
  });
});

describe('Journey F — generate from a saved collection, accept as candidates, save one word', () => {
  it('leaves the collection and every word exactly as they were until each save', async () => {
    const app = on();
    // One saved word seeds the collection; the draft's second word is new.
    await addWord(app, alice, 'candid');
    const collection = await ok<{ collection: { id: string } }>(send(app, alice, 'POST', '/api/collections', { name: 'Focus' }), 201);
    await ok(send(app, alice, 'PUT', `/api/collections/${collection.collection.id}/words/${(await wordsOf(app, alice))[0]!.id}`, { member: true }));
    const libraryBefore = (await (await call(app, alice, '/api/library')).json()) as { collections: Array<{ id: string; wordIds: string[] }> };
    const focusBefore = libraryBefore.collections.find((entry) => entry.id === collection.collection.id);

    const DRAFT = JSON.stringify({
      title: 'A candid, lucid morning',
      text: 'She gave a candid reply and a lucid explanation of why the meeting had moved, and the room understood at once.',
      suggestions: [
        { word: 'candid', sentence: 'She gave a candid reply', note: null },
        { word: 'lucid', sentence: 'a lucid explanation', note: 'easy to follow' },
      ],
    });
    modelReplies(DRAFT);
    const reply = await ok<{
      draft: { title: string; text: string; suggestions: Array<{ word: string; sentence?: string; note?: string }> };
    }>(send(app, alice, 'POST', '/api/discovery/generate', { requestId: newId(), collectionId: collection.collection.id }));
    const draft = reply.draft;
    expect(draft.suggestions.map((suggestion) => suggestion.word).sort()).toEqual(['candid', 'lucid']);
    expect(await wordsOf(app, alice)).toHaveLength(1);
    expect(await sourcesOf(app, alice)).toEqual([]);

    // Accepting the preview: an ordinary creation, still only candidates.
    const accepted = await newSource(app, alice, {
      kind: 'generated',
      title: draft.title,
      origin: 'ai',
      content: draft.text,
      suggestions: draft.suggestions.map((suggestion) => ({ word: suggestion.word })),
    });
    expect(await wordsOf(app, alice)).toHaveLength(1);
    const waiting = await marksOf(app, alice);
    expect(waiting).toHaveLength(2);
    expect(waiting.every((mark) => mark.vocabularyId === null)).toBe(true);

    // The collection is untouched by everything so far…
    const libraryAfter = (await (await call(app, alice, '/api/library')).json()) as { collections: Array<{ id: string; wordIds: string[] }> };
    const focusAfter = libraryAfter.collections.find((entry) => entry.id === collection.collection.id);
    expect(focusAfter).toEqual(focusBefore);

    // …and only this one save creates this one word; the other waits on.
    const first = waiting.find((mark) => mark.label === 'lucid')!;
    await ok(send(app, alice, 'POST', `/api/discovery/marks/${first.id}/save`, { requestId: newId() }), 201);
    expect(await wordsOf(app, alice)).toHaveLength(2);
    const stillWaiting = await marksOf(app, alice);
    expect(stillWaiting.map((mark) => mark.label)).toEqual(['candid']);
    expect(await sourcesOf(app, alice)).toHaveLength(1);
    expect((await documentOf(app, alice, accepted.id)).savedCount).toBe(1);
  });
});

describe('Journey G — fetch a page by address: preview first, then a source with provenance', () => {
  it('previews without storing, then opens as a web source whose origin is the address', async () => {
    const PAGE = { title: 'A field note', text: 'The candid observations of a careful walker.', origin: 'https://example.test/field-note' };
    const app = on(AI_ENV, {
      async fetch() {
        return PAGE;
      },
    });

    const preview = fetchUrlResponseSchema.parse(
      await (await send(app, alice, 'POST', '/api/discovery/fetch-url', { url: 'https://example.test/field-note' })).json(),
    );
    expect(preview.text).toBe(PAGE.text);
    expect(await sourcesOf(app, alice)).toEqual([]);

    // The learner presses "open in workspace": an ordinary creation.
    const source = await newSource(app, alice, {
      kind: 'web',
      title: preview.title,
      origin: preview.origin,
      content: preview.text,
    });
    const document = await documentOf(app, alice, source.id);
    expect(document.content).toBe(PAGE.text);
    expect(document.origin).toBe('https://example.test/field-note');

    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', { word: 'candid', sourceId: source.id, offset: 4, requestId: newId() }),
      201,
    );
    const found = discoveryContextResponseSchema.parse(
      await (await call(app, alice, `/api/discovery/context?vocabularyId=${saved.entry.id}`)).json(),
    );
    expect(found.source.origin).toBe('https://example.test/field-note');
  });
});

describe('Journey H — a saved word leads back to where it was found', () => {
  it('answers the Word Profile’s question with the source and the selection, and nothing before the save', async () => {
    const app = on();
    const source = await newSource(app, alice, { kind: 'reading', title: 'Notes on candour', content: 'Candid talk is rarer than good weather.' });

    // Before the save there is nothing to look up — the word does not exist yet.
    const alone = await addWord(app, alice, 'serendipity');
    expect((await call(app, alice, `/api/discovery/context?vocabularyId=${alone.id}`)).status).toBe(404);

    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', { word: 'candid', sourceId: source.id, offset: 0, requestId: newId() }),
      201,
    );
    const found = discoveryContextResponseSchema.parse(
      await (await call(app, alice, `/api/discovery/context?vocabularyId=${saved.entry.id}`)).json(),
    );
    expect(found.source.id).toBe(source.id);
    expect(found.source.title).toBe('Notes on candour');
    expect(found.mark.context).toBe('Candid talk is rarer than good weather.');
    expect(found.mark.offset).toBe(0);
    // And another account asking the same question finds no door.
    expect((await call(app, bob, `/api/discovery/context?vocabularyId=${saved.entry.id}`)).status).toBe(404);
  });
});

describe('Journey I — a duplicate is offered for reuse, never silently made twice', () => {
  it('refuses with the existing words in hand, then creates only when the learner chooses to keep both', async () => {
    const app = on();
    const existing = await addWord(app, alice, 'candid');
    const source = await newSource(app, alice, { kind: 'reading', title: 'Another essay', content: 'A candid line worth saving again.' });

    const refused = await send(app, alice, 'POST', '/api/discovery/save', {
      word: '  CANDID ',
      sourceId: source.id,
      requestId: newId(),
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string }; duplicates: Array<{ id: string; word: string }> };
    expect(body.error.code).toBe('duplicate');
    expect(body.duplicates.map((entry) => entry.id)).toContain(existing.id);
    expect(await wordsOf(app, alice)).toHaveLength(1);
    // Nothing was marked either: the refused press wrote no mark, no word.
    expect(await documentOf(app, alice, source.id)).toMatchObject({ markedCount: 0, savedCount: 0 });

    const kept = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', {
        word: 'CANDID',
        sourceId: source.id,
        allowDuplicate: true,
        requestId: newId(),
      }),
      201,
    );
    expect(kept.entry.id).not.toBe(existing.id);
    expect(await wordsOf(app, alice)).toHaveLength(2);
    expect(kept.mark.vocabularyId).toBe(kept.entry.id);
  });
});

describe('Journey J — a whole day of discovery leaves the learning record untouched', () => {
  const snapshot = async () => ({
    states: await db.admin<Row>('select * from public.card_states order by vocabulary_id'),
    logs: await db.admin<Row>('select * from public.review_logs order by id'),
    sessions: await db.admin<Row>('select * from public.study_sessions order by id'),
  });

  it('reads, explains, marks, dismisses, moves a position, previews and generates — then one save lands alone', async () => {
    const app = on();
    // One word already under study, so the schedule has something to stand still around.
    await addWord(app, alice, 'lucid');
    const seeded = (await wordsOf(app, alice))[0]!;
    const source = await newSource(app, alice, { kind: 'reading', title: 'Day’s reading', content: 'A candid remark, then a lucid explanation.' });
    const before = await snapshot();

    // The day: every read and every discovery-only write.
    await call(app, alice, '/api/discovery');
    await documentOf(app, alice, source.id);
    await wordsOf(app, alice);
    modelReplies(JSON.stringify({ definition: 'Clear.', meaning: 'rõ ràng' }));
    await send(app, alice, 'POST', '/api/ai/extract', { text: 'A candid remark, then a lucid explanation.', word: 'candid' });
    const dismissed = await ok<{ mark: { id: string } }>(
      send(app, alice, 'POST', `/api/discovery/${source.id}/marks`, {
        requestId: newId(),
        sourceId: source.id,
        label: 'candid',
        offset: 2,
      }),
      201,
    );
    await send(app, alice, 'DELETE', `/api/discovery/marks/${dismissed.mark.id}`);
    await ok(send(app, alice, 'PATCH', `/api/discovery/${source.id}`, { position: { offset: 40 } }));
    modelReplies(
      JSON.stringify({
        title: 'Draft day',
        text: 'A short reading the day generated for a try: nobody stored it, no collection changed, and no word was created by the writing of it at all.',
        suggestions: [],
      }),
    );
    const generated = await send(app, alice, 'POST', '/api/discovery/generate', { requestId: newId(), topic: 'plain talk' });
    expect(generated.status).toBe(200);

    expect(await snapshot()).toEqual(before);
    expect(await wordsOf(app, alice)).toHaveLength(1);

    // The one explicit save: the schedule gains exactly its new word's own
    // starting row — what the Add form would have created — and nothing else.
    const saved = await ok<z.infer<typeof discoverySaveResponseSchema>>(
      send(app, alice, 'POST', '/api/discovery/save', {
        word: 'candid',
        sourceId: source.id,
        offset: 2,
        meaning: 'thẳng thắn',
        requestId: newId(),
      }),
      201,
    );
    const after = await snapshot();
    expect(after.logs).toEqual(before.logs);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.states).toHaveLength(before.states.length + 1);
    const gained = after.states.filter((row) => !before.states.some((was) => was.vocabulary_id === row.vocabulary_id));
    expect(gained).toHaveLength(1);
    expect(gained[0]!.vocabulary_id).toBe(saved.entry.id);
    // The seeded word's own state never moved.
    expect(after.states.find((row) => row.vocabulary_id === seeded.id)).toEqual(
      before.states.find((row) => row.vocabulary_id === seeded.id),
    );
  });
});
