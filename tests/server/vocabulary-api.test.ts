import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/create-app.js';
import { loadConfig, type AppConfig } from '../../server/env.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { DatabaseError } from '../../server/supabase/supabase-database.js';
import { VocabularyService } from '../../server/vocabulary-service.js';
import {
  apiErrorSchema,
  deleteEntryResponseSchema,
  entryResponseSchema,
  vocabularyListResponseSchema,
  NO_CAPABILITIES,
  type Capabilities,
} from '../../shared/api.js';
import { FakeCatalog, entryData } from '../helpers/fake-catalog.js';
import { NOW, TIME_ZONE, pageId } from '../helpers/fixtures.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function setup(configOverrides: Partial<AppConfig> = {}, writesRequested = true, capabilities: Capabilities = NO_CAPABILITIES) {
  const catalog = new FakeCatalog([entryData(1), entryData(2, { word: 'bank' })]);
  const vocabulary = new VocabularyService({
    catalog,
    rules: sampleRules,
    defaults: { mastery: 1, reviewDate: 'empty' },
    timeZone: TIME_ZONE,
    writesRequested,
    capabilities,
    now: () => NOW,
  });
  const config = { ...loadConfig({ DATA_MODE: 'mock' }), ...configOverrides };
  return { app: createApp({ config, service: null, vocabulary }), catalog };
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('GET /api/vocabulary', () => {
  it('returns the whole vocabulary in the shared format', async () => {
    const { app } = setup();
    const response = await app.request('/api/vocabulary');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const list = vocabularyListResponseSchema.parse(await response.json());
    expect(list.entries.map((entry) => entry.word)).toEqual(['word-1', 'bank']);
  });

  it('returns one entry, and 404 for an unknown one', async () => {
    const { app } = setup();
    const found = await app.request(`/api/vocabulary/${pageId(1)}`);
    expect(entryResponseSchema.parse(await found.json()).entry.word).toBe('word-1');
    expect((await app.request(`/api/vocabulary/${pageId(9)}`)).status).toBe(404);
    expect((await app.request('/api/vocabulary/not-an-id')).status).toBe(400);
  });
});

describe('POST /api/vocabulary', () => {
  it('creates a word and answers 201 with the stored record', async () => {
    const { app, catalog } = setup();
    const response = await app.request('/api/vocabulary', json('POST', { word: 'candid', meaning: 'thẳng thắn', requestId: REQUEST_ID }));
    expect(response.status).toBe(201);
    expect(entryResponseSchema.parse(await response.json()).entry).toMatchObject({ word: 'candid', meaning: 'thẳng thắn', mastery: 1 });
    expect(catalog.created).toHaveLength(1);
  });

  it('answers 200, not 201, when the same submission arrives again', async () => {
    const { app, catalog } = setup();
    const body = { word: 'candid', requestId: REQUEST_ID };
    expect((await app.request('/api/vocabulary', json('POST', body))).status).toBe(201);
    expect((await app.request('/api/vocabulary', json('POST', body))).status).toBe(200);
    expect(catalog.created).toHaveLength(1);
  });

  it('answers 409 with the existing entries for a duplicate', async () => {
    const { app, catalog } = setup();
    const response = await app.request('/api/vocabulary', json('POST', { word: ' BANK ', requestId: REQUEST_ID }));
    expect(response.status).toBe(409);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('duplicate');
    expect(body.duplicates?.map((entry) => entry.id)).toEqual([pageId(2)]);
    expect(catalog.created).toEqual([]);
  });

  it.each([
    ['a missing word', { requestId: REQUEST_ID }],
    ['a blank word', { word: '   ', requestId: REQUEST_ID }],
    ['a missing request id', { word: 'candid' }],
    ['an out-of-range mastery', { word: 'candid', mastery: 42, requestId: REQUEST_ID }],
    ['an impossible date', { word: 'candid', dateAdded: '2026-13-01', requestId: REQUEST_ID }],
    ['an unknown property', { word: 'candid', icon: '🔥', requestId: REQUEST_ID }],
  ])('rejects %s with 400 and creates nothing', async (_name, body) => {
    const { app, catalog } = setup();
    const response = await app.request('/api/vocabulary', json('POST', body));
    expect(response.status).toBe(400);
    expect(catalog.created).toEqual([]);
  });

  it('names the field in a validation message', async () => {
    const { app } = setup();
    const response = await app.request('/api/vocabulary', json('POST', { word: '', requestId: REQUEST_ID }));
    expect(apiErrorSchema.parse(await response.json()).error.message).toContain('word: Enter a word');
  });

  it('passes on a refusal from the database instead of pretending to succeed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, catalog } = setup();
    catalog.failNextWrite = new DatabaseError('forbidden', 'The database refused this change.', '42501');
    const response = await app.request('/api/vocabulary', json('POST', { word: 'candid', requestId: REQUEST_ID }));
    expect(response.status).toBe(403);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('forbidden');
  });

  it('answers 403 while saving is switched off', async () => {
    const { app, catalog } = setup({}, false);
    const response = await app.request('/api/vocabulary', json('POST', { word: 'candid', requestId: REQUEST_ID }));
    expect(response.status).toBe(403);
    expect(catalog.created).toEqual([]);
  });

  it('takes a phrase, an idiom, a phrasal verb or an expression pattern as one word', async () => {
    const { app } = setup();
    const shapes: ReadonlyArray<readonly [string, string]> = [
      ['phrase', 'break the ice'],
      ['idiom', 'bite the bullet'],
      ['phrasal verb', 'look it up'],
      ['expression pattern', 'would rather + infinitive'],
    ];
    for (const [index, [shape, word]] of shapes.entries()) {
      const requestId = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
      const response = await app.request('/api/vocabulary', json('POST', { word, requestId }));
      expect(response.status, shape).toBe(201);
      expect(entryResponseSchema.parse(await response.json()).entry.word, shape).toBe(word);
    }
  });
});

describe('PATCH /api/vocabulary/:id', () => {
  it('updates the named fields only', async () => {
    const { app, catalog } = setup();
    const response = await app.request(`/api/vocabulary/${pageId(1)}`, json('PATCH', { definition: 'clearer' }));
    expect(response.status).toBe(200);
    expect(entryResponseSchema.parse(await response.json()).entry.definition).toBe('clearer');
    expect(catalog.updated).toEqual([{ id: pageId(1), changes: { definition: 'clearer' } }]);
  });

  it('refuses to set fields it does not manage', async () => {
    const { app, catalog } = setup();
    for (const body of [{ properties: { Mastery: { number: 10 } } }, { mastery: 10 }, { 'Answer Shown': true }, {}]) {
      const response = await app.request(`/api/vocabulary/${pageId(1)}`, json('PATCH', body));
      expect(response.status).toBe(400);
    }
    expect(catalog.updated).toEqual([]);
  });

  it('answers 404 for an unknown word and 400 for a malformed id', async () => {
    const { app } = setup();
    expect((await app.request(`/api/vocabulary/${pageId(9)}`, json('PATCH', { definition: 'x' }))).status).toBe(404);
    expect((await app.request('/api/vocabulary/nope', json('PATCH', { definition: 'x' }))).status).toBe(400);
  });
});

describe('PATCH /api/vocabulary/:id with the word a word was formed from', () => {
  const withRoots = { ...NO_CAPABILITIES, roots: true };

  it('stores the root and reads it back, and clears it with null', async () => {
    const { app } = setup({}, true, withRoots);
    const set = await app.request(`/api/vocabulary/${pageId(1)}`, json('PATCH', { rootId: pageId(2) }));
    expect(set.status).toBe(200);
    expect(entryResponseSchema.parse(await set.json()).entry.rootId).toBe(pageId(2));
    const read = await app.request(`/api/vocabulary/${pageId(1)}`);
    expect(entryResponseSchema.parse(await read.json()).entry.rootId).toBe(pageId(2));

    const clear = await app.request(`/api/vocabulary/${pageId(1)}`, json('PATCH', { rootId: null }));
    expect(entryResponseSchema.parse(await clear.json()).entry.rootId).toBeNull();
  });

  it('answers 404 for a root that is not in the account, and 400 for the word itself', async () => {
    const { app, catalog } = setup({}, true, withRoots);
    expect((await app.request(`/api/vocabulary/${pageId(1)}`, json('PATCH', { rootId: pageId(9) }))).status).toBe(404);
    expect((await app.request(`/api/vocabulary/${pageId(1)}`, json('PATCH', { rootId: pageId(1) }))).status).toBe(400);
    expect(catalog.updated).toEqual([]);
  });

  it('says the database cannot keep it yet when its version predates the column', async () => {
    const { app, catalog } = setup();
    const response = await app.request(`/api/vocabulary/${pageId(1)}`, json('PATCH', { rootId: pageId(2) }));
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('not_supported');
    expect(catalog.updated).toEqual([]);
  });
});

describe('DELETE /api/vocabulary/:id and restore', () => {
  it('trashes a word and can restore it', async () => {
    const { app, catalog } = setup();
    const deleted = await app.request(`/api/vocabulary/${pageId(1)}`, { method: 'DELETE' });
    expect(deleteEntryResponseSchema.parse(await deleted.json())).toEqual({ id: pageId(1), trashed: true });
    expect(catalog.trashed).toEqual([pageId(1)]);

    const restored = await app.request(`/api/vocabulary/${pageId(1)}/restore`, { method: 'POST' });
    expect(entryResponseSchema.parse(await restored.json()).entry.id).toBe(pageId(1));
  });

  it('answers 404 for a word that is not in the database', async () => {
    const { app, catalog } = setup();
    expect((await app.request(`/api/vocabulary/${pageId(9)}`, { method: 'DELETE' })).status).toBe(404);
    expect(catalog.trashed).toEqual([]);
  });
});

