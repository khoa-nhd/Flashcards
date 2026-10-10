import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/create-app.js';
import { loadConfig, type AppConfig } from '../../server/env.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { NotionRequestError } from '../../server/notion/notion-errors.js';
import { VocabularyService } from '../../server/vocabulary-service.js';
import {
  apiErrorSchema,
  deleteEntryResponseSchema,
  entryResponseSchema,
  vocabularyListResponseSchema,
} from '../../shared/api.js';
import { FakeCatalog, entryData } from '../helpers/fake-catalog.js';
import { NOW, TIME_ZONE, pageId } from '../helpers/fixtures.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function setup(configOverrides: Partial<AppConfig> = {}, writesRequested = true) {
  const catalog = new FakeCatalog([entryData(1), entryData(2, { word: 'bank' })]);
  const vocabulary = new VocabularyService({
    catalog,
    rules: sampleRules,
    defaults: { mastery: 1, reviewDate: 'empty' },
    timeZone: TIME_ZONE,
    writesRequested,
    now: () => NOW,
  });
  const config = { ...loadConfig({ DATA_MODE: 'mock' }), ...configOverrides };
  return { app: createApp({ config, service: null, vocabulary, now: () => NOW }), catalog };
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

  it('passes on a Notion permission problem instead of pretending to succeed', async () => {
    const { app, catalog } = setup();
    catalog.failNextWrite = new NotionRequestError('forbidden', 'The Notion integration is not allowed to do this. Check its capabilities.');
    const response = await app.request('/api/vocabulary', json('POST', { word: 'candid', requestId: REQUEST_ID }));
    expect(response.status).toBe(502);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('notion_forbidden');
  });

  it('answers 403 while saving is switched off', async () => {
    const { app, catalog } = setup({}, false);
    const response = await app.request('/api/vocabulary', json('POST', { word: 'candid', requestId: REQUEST_ID }));
    expect(response.status).toBe(403);
    expect(catalog.created).toEqual([]);
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

  it('refuses to set arbitrary Notion properties', async () => {
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

describe('access control covers the vocabulary routes', () => {
  it('requires the password when one is configured', async () => {
    const { app, catalog } = setup({ accessPassword: 'a long passphrase' });
    expect((await app.request('/api/vocabulary')).status).toBe(401);
    expect((await app.request('/api/vocabulary', json('POST', { word: 'x', requestId: REQUEST_ID }))).status).toBe(401);
    expect((await app.request(`/api/vocabulary/${pageId(1)}`, { method: 'DELETE' })).status).toBe(401);
    expect(catalog.created).toEqual([]);
    expect(catalog.trashed).toEqual([]);
  });

  it('is open when the owner opted out of a password in production', async () => {
    const { app } = setup({ isProduction: true, allowUnauthenticated: true });
    expect((await app.request('/api/vocabulary')).status).toBe(200);
  });

  it('still refuses cross-site writes without a password', async () => {
    const { app, catalog } = setup({ isProduction: true, allowUnauthenticated: true });
    const response = await app.request('http://flashcards.test/api/vocabulary', {
      ...json('POST', { word: 'x', requestId: REQUEST_ID }),
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Host: 'flashcards.test' },
    });
    expect(response.status).toBe(403);
    expect(catalog.created).toEqual([]);
  });
});
