/** The Notion side of whole-record operations, against a fake API client. */
import { describe, expect, it } from 'vitest';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { hasFormatting, mapPageToEntry, pageSchema, toRichText } from '../../server/notion/notion-mappers.js';
import { NotionVocabularyRepository } from '../../server/notion/notion-repository.js';
import { TIME_ZONE, pageId } from '../helpers/fixtures.js';
import {
  DATABASE_ID,
  DATA_SOURCE_ID,
  FakeNotionApi,
  OTHER_DATA_SOURCE_ID,
  TEST_FIELDS,
  TEST_PROPERTIES,
  TEST_VOCABULARY_FIELDS,
  notionPage,
  richText,
} from '../helpers/notion-fixtures.js';

function setup() {
  const api = new FakeNotionApi();
  const repository = new NotionVocabularyRepository(api, {
    databaseId: DATABASE_ID,
    dataSourceId: null,
    properties: TEST_PROPERTIES,
    vocabularyFields: TEST_VOCABULARY_FIELDS,
    cardFields: TEST_FIELDS,
    rules: sampleRules,
    timeZone: TIME_ZONE,
  });
  return { api, repository };
}

const mapping = { properties: TEST_PROPERTIES, fields: TEST_VOCABULARY_FIELDS, timeZone: TIME_ZONE };

describe('mapPageToEntry', () => {
  it('maps every stored field, including Notion metadata', () => {
    const mapped = mapPageToEntry(pageSchema.parse(notionPage({ id: pageId(1), word: 'candid', mastery: 4 })), mapping);
    expect(mapped).toEqual({
      ok: true,
      entry: {
        id: pageId(1),
        word: 'candid',
        meaning: 'sự tình cờ may mắn',
        definition: 'a happy accident',
        example: 'What serendipity!',
        mastery: 4,
        reviewDate: '2026-10-09',
        dateAdded: '2026-10-01',
        formattedFields: [],
        url: expect.stringContaining('notion.com'),
        createdTime: '2026-10-01T02:00:00.000Z',
        lastEditedTime: '2026-10-05T02:00:00.000Z',
      },
    });
  });

  it('keeps an entry with empty or unusable values rather than hiding it', () => {
    const mapped = mapPageToEntry(
      pageSchema.parse(
        notionPage({ id: pageId(1), mastery: null, nextReview: null, dateAdded: null, meaning: null, definition: null, example: null }),
      ),
      mapping,
    );
    expect(mapped.ok && mapped.entry).toMatchObject({
      mastery: null,
      reviewDate: null,
      dateAdded: null,
      meaning: null,
      definition: null,
      example: null,
    });
  });

  it('places a Date Added timestamp on the local calendar day', () => {
    const page = notionPage({
      id: pageId(1),
      properties: { 'Date Added': { type: 'date', date: { start: '2026-10-09T20:00:00.000Z' } } },
    });
    const mapped = mapPageToEntry(pageSchema.parse(page), mapping);
    expect(mapped.ok && mapped.entry.dateAdded).toBe('2026-10-10');
  });

  it('skips only a row with no word', () => {
    const mapped = mapPageToEntry(pageSchema.parse(notionPage({ id: pageId(1), word: ' ' })), mapping);
    expect(mapped).toEqual({ ok: false, skipped: { id: pageId(1), word: null, reason: '"Word" is empty.' } });
  });

  it('flags fields whose formatting a plain-text edit would lose', () => {
    const bold = [{ type: 'text', plain_text: 'bold', text: { content: 'bold' }, annotations: { bold: true } }];
    const linked = [{ type: 'text', plain_text: 'link', text: { content: 'link' }, href: 'https://example.com', annotations: {} }];
    const page = notionPage({
      id: pageId(1),
      properties: {
        Definition: { type: 'rich_text', rich_text: bold },
        Example: { type: 'rich_text', rich_text: linked },
      },
    });
    const mapped = mapPageToEntry(pageSchema.parse(page), mapping);
    expect(mapped.ok && mapped.entry.formattedFields).toEqual(['definition', 'example']);
    expect(hasFormatting({ type: 'rich_text', rich_text: richText('plain') })).toBe(false);
    expect(hasFormatting({ type: 'number', number: 3 })).toBe(false);
  });
});

describe('toRichText', () => {
  it('sends short text as one item and nothing for empty text', () => {
    expect(toRichText('hello')).toEqual([{ type: 'text', text: { content: 'hello' } }]);
    expect(toRichText('')).toEqual([]);
  });

  it('splits long text at the 2,000-character limit without losing any', () => {
    const text = 'a'.repeat(2000) + 'b'.repeat(2000) + 'c'.repeat(500);
    const items = toRichText(text);
    expect(items.map((item) => item.text.content.length)).toEqual([2000, 2000, 500]);
    expect(items.map((item) => item.text.content).join('')).toBe(text);
  });

  it('never cuts a multi-unit character in half', () => {
    const text = 'x'.repeat(1999) + '😀' + 'y';
    const items = toRichText(text);
    expect(items.map((item) => item.text.content).join('')).toBe(text);
    // The emoji takes two units, so it moves whole into the next piece.
    expect(items.map((item) => item.text.content.length)).toEqual([1999, 3]);
    expect(items.every((item) => item.text.content.length <= 2000)).toBe(true);
  });
});

describe('listEntries', () => {
  it('reads every page of results without a filter', async () => {
    const { api, repository } = setup();
    api.resultPages = [
      [notionPage({ id: pageId(1) }), notionPage({ id: pageId(2) })],
      [notionPage({ id: pageId(3), mastery: 10 }), notionPage({ id: pageId(4), word: '' })],
    ];
    const { entries, invalid } = await repository.listEntries();
    expect(entries.map((entry) => entry.id)).toEqual([pageId(1), pageId(2), pageId(3)]);
    expect(invalid).toEqual([{ id: pageId(4), word: null, reason: '"Word" is empty.' }]);
    expect(api.queries.map((query) => [query.filter, query.startCursor])).toEqual([
      [undefined, undefined],
      [undefined, 'cursor-1'],
    ]);
  });
});

describe('findEntriesByWord', () => {
  it('asks Notion for candidates and matches exactly after normalising', async () => {
    const { api, repository } = setup();
    api.rowsFor = () => [
      notionPage({ id: pageId(1), word: 'Ice  Cream' }),
      notionPage({ id: pageId(2), word: 'ice cream cone' }),
    ];
    const matches = await repository.findEntriesByWord('  ice cream ');
    expect(matches.map((entry) => entry.id)).toEqual([pageId(1)]);
    expect(api.queries[0]?.filter).toEqual({ property: 'Word', title: { contains: 'ice cream' } });
  });
});

describe('createEntry', () => {
  it('creates a row in the configured data source with typed values', async () => {
    const { api, repository } = setup();
    const { entry, created } = await repository.createEntry({
      word: 'candid',
      meaning: 'thẳng thắn',
      definition: 'honest and direct',
      example: null,
      dateAdded: '2026-10-10',
      mastery: 1,
      reviewDate: null,
    });
    expect(created).toBe(true);
    expect(api.creations).toEqual([
      {
        dataSourceId: DATA_SOURCE_ID,
        properties: {
          Word: { title: [{ type: 'text', text: { content: 'candid' } }] },
          Mastery: { number: 1 },
          Meaning: { rich_text: [{ type: 'text', text: { content: 'thẳng thắn' } }] },
          Definition: { rich_text: [{ type: 'text', text: { content: 'honest and direct' } }] },
          'Date Added': { date: { start: '2026-10-10' } },
        },
      },
    ]);
    // Read back from what "Notion" stored, not echoed from the request.
    expect(entry).toMatchObject({
      word: 'candid',
      meaning: 'thẳng thắn',
      example: null,
      mastery: 1,
      reviewDate: null,
      dateAdded: '2026-10-10',
    });
  });

  it('leaves empty optional values unset and includes a review date when given', async () => {
    const { api, repository } = setup();
    await repository.createEntry({
      word: 'candid',
      meaning: null,
      definition: null,
      example: null,
      dateAdded: null,
      mastery: 0,
      reviewDate: '2026-10-12',
    });
    expect(api.creations[0]?.properties).toEqual({
      Word: { title: [{ type: 'text', text: { content: 'candid' } }] },
      Mastery: { number: 0 },
      'Next Review': { date: { start: '2026-10-12' } },
    });
  });

  it('refuses when a field has the wrong type in Notion, before calling Notion', async () => {
    const { api, repository } = setup();
    api.schema.Definition = { id: 'f', type: 'formula' };
    await expect(
      repository.createEntry({ word: 'x', meaning: null, definition: null, example: null, dateAdded: null, mastery: 1, reviewDate: null }),
    ).rejects.toMatchObject({ status: 409, code: 'read_only' });
    expect(api.creations).toEqual([]);
    // Reviews are unaffected by that problem.
    expect((await repository.checkSetup()).writeIssues).toEqual([]);
  });
});

describe('updateEntry', () => {
  it('sends only the given properties', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1) }));
    const entry = await repository.updateEntry(pageId(1), { definition: 'clearer', example: null });
    expect(api.updates).toEqual([
      {
        pageId: pageId(1),
        properties: {
          Definition: { rich_text: [{ type: 'text', text: { content: 'clearer' } }] },
          Example: { rich_text: [] },
        },
      },
    ]);
    expect(entry).toMatchObject({ definition: 'clearer', example: null, mastery: 3, reviewDate: '2026-10-09' });
  });

  it('can change the word, the dates and the schedule', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1) }));
    await repository.updateEntry(pageId(1), { word: 'renamed', dateAdded: null, mastery: 5, reviewDate: '2026-11-01' });
    expect(api.updates[0]?.properties).toEqual({
      Word: { title: [{ type: 'text', text: { content: 'renamed' } }] },
      'Date Added': { date: null },
      Mastery: { number: 5 },
      'Next Review': { date: { start: '2026-11-01' } },
    });
  });
});

describe('trashEntry and restoreEntry', () => {
  it('moves a row of this database to the trash and back', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1) }));
    await expect(repository.trashEntry(pageId(1))).resolves.toBe(true);
    expect(api.trashCalls).toEqual([{ pageId: pageId(1), trashed: true }]);
    await expect(repository.getEntry(pageId(1))).resolves.toBeNull();

    await expect(repository.restoreEntry(pageId(1))).resolves.toMatchObject({ id: pageId(1) });
    expect(api.trashCalls[1]).toEqual({ pageId: pageId(1), trashed: false });
    await expect(repository.getEntry(pageId(1))).resolves.not.toBeNull();
  });

  it('never trashes or restores a page from another database', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1), dataSourceId: OTHER_DATA_SOURCE_ID }));
    api.pages.set(pageId(2), notionPage({ id: pageId(2), dataSourceId: OTHER_DATA_SOURCE_ID, inTrash: true }));
    await expect(repository.trashEntry(pageId(1))).resolves.toBe(false);
    await expect(repository.restoreEntry(pageId(2))).resolves.toBeNull();
    await expect(repository.trashEntry(pageId(404))).resolves.toBe(false);
    expect(api.trashCalls).toEqual([]);
  });

  it('does not call Notion again for a row that is already in the trash', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1), inTrash: true }));
    await expect(repository.trashEntry(pageId(1))).resolves.toBe(true);
    expect(api.trashCalls).toEqual([]);
  });
});
