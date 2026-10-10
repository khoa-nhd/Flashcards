import { describe, expect, it } from 'vitest';
import { HttpError } from '../../server/errors.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { NotionRequestError } from '../../server/notion/notion-errors.js';
import { NotionVocabularyRepository, type NotionRepositoryOptions } from '../../server/notion/notion-repository.js';
import { TIME_ZONE, TODAY, pageId } from '../helpers/fixtures.js';
import {
  DATABASE_ID,
  DATA_SOURCE_ID,
  FakeNotionApi,
  OTHER_DATA_SOURCE_ID,
  TEST_FIELDS,
  TEST_PROPERTIES,
  TEST_VOCABULARY_FIELDS,
  notionPage,
} from '../helpers/notion-fixtures.js';

function setup(overrides: Partial<NotionRepositoryOptions> = {}) {
  const api = new FakeNotionApi();
  const repository = new NotionVocabularyRepository(api, {
    databaseId: DATABASE_ID,
    dataSourceId: null,
    properties: TEST_PROPERTIES,
    vocabularyFields: TEST_VOCABULARY_FIELDS,
    cardFields: TEST_FIELDS,
    rules: sampleRules,
    timeZone: TIME_ZONE,
    ...overrides,
  });
  return { api, repository };
}

describe('data source resolution', () => {
  it('finds the single data source of the configured database, once', async () => {
    const { api, repository } = setup();
    await repository.listDueCandidates(TODAY);
    await repository.listDueCandidates(TODAY);
    expect(api.queries.every((query) => query.dataSourceId === DATA_SOURCE_ID)).toBe(true);
    expect(api.databaseLookups).toBe(1);
    expect(api.schemaLookups).toBe(1);
  });

  it('uses an explicit data source id without looking up the database', async () => {
    const { api, repository } = setup({ dataSourceId: OTHER_DATA_SOURCE_ID.replace(/-/g, '') });
    await repository.listDueCandidates(TODAY);
    expect(api.databaseLookups).toBe(0);
    expect(api.queries[0]?.dataSourceId).toBe(OTHER_DATA_SOURCE_ID);
  });

  it('asks for NOTION_DATA_SOURCE_ID when the database has several data sources', async () => {
    const { api, repository } = setup();
    api.database = {
      id: DATABASE_ID,
      data_sources: [
        { id: DATA_SOURCE_ID, name: 'Vocabulary' },
        { id: OTHER_DATA_SOURCE_ID, name: 'Archive' },
      ],
    };
    await expect(repository.listDueCandidates(TODAY)).rejects.toThrow(/NOTION_DATA_SOURCE_ID/);
  });

  it('retries schema loading after a failure instead of caching it', async () => {
    const { api, repository } = setup();
    api.failNext = new NotionRequestError('unavailable', 'down');
    await expect(repository.checkSetup()).rejects.toThrow('down');
    await expect(repository.checkSetup()).resolves.toMatchObject({ readIssues: [] });
  });
});

describe('schema validation', () => {
  it('accepts a schema that matches the configuration', async () => {
    const { repository } = setup();
    await expect(repository.checkSetup()).resolves.toEqual({
      readIssues: [],
      writeIssues: [],
      warnings: [],
      entryWriteIssues: [],
    });
  });

  it('reports a wrong property name and lists what exists', async () => {
    const { repository } = setup({ properties: { ...TEST_PROPERTIES, mastery: 'Level' } });
    const report = await repository.checkSetup();
    expect(report.readIssues).toHaveLength(1);
    expect(report.readIssues[0]).toContain('"Level"');
    expect(report.readIssues[0]).toContain('"Mastery" (number)');
    await expect(repository.listDueCandidates(TODAY)).rejects.toMatchObject({ status: 503, code: 'setup_incomplete' });
  });

  it('reports a property of an unusable type', async () => {
    const { api, repository } = setup();
    api.schema['Next Review'] = { id: 'd', type: 'checkbox' };
    const report = await repository.checkSetup();
    expect(report.readIssues[0]).toContain('"Next Review" (checkbox)');
  });

  it('allows reading computed properties but flags them as not writable', async () => {
    const { api, repository } = setup();
    api.schema.Mastery = { id: 'm', type: 'formula' };
    api.schema['Next Review'] = { id: 'd', type: 'formula' };
    const report = await repository.checkSetup();
    expect(report.readIssues).toEqual([]);
    expect(report.writeIssues).toHaveLength(2);
    await expect(repository.updateReviewState(pageId(1), { mastery: 4 })).rejects.toMatchObject({
      status: 409,
      code: 'read_only',
    });
    expect(api.updates).toEqual([]);
  });

  it('drops an optional card field that does not exist, with a warning', async () => {
    const { api, repository } = setup();
    delete api.schema.Example;
    api.resultPages = [[notionPage({ id: pageId(1) })]];
    const report = await repository.checkSetup();
    expect(report.readIssues).toEqual([]);
    expect(report.warnings[0]).toContain('"Example"');
    const { records } = await repository.listDueCandidates(TODAY);
    expect(records[0]?.fields).toEqual({ partOfSpeech: 'noun', definition: 'a happy accident' });
  });
});

describe('listDueCandidates', () => {
  it('collects every page of results', async () => {
    const { api, repository } = setup();
    api.resultPages = [
      [notionPage({ id: pageId(1) }), notionPage({ id: pageId(2) })],
      [notionPage({ id: pageId(3) })],
      [notionPage({ id: pageId(4) }), notionPage({ id: pageId(5) })],
    ];
    const { records } = await repository.listDueCandidates(TODAY);
    expect(records.map((item) => item.id)).toEqual([1, 2, 3, 4, 5].map(pageId));
    expect(api.queries.map((query) => query.startCursor)).toEqual([undefined, 'cursor-1', 'cursor-2']);
  });

  it('pre-filters by due date and mastery and sorts by due date', async () => {
    const { api, repository } = setup();
    await repository.listDueCandidates(TODAY);
    expect(api.queries[0]?.sorts).toEqual([{ property: 'Next Review', direction: 'ascending' }]);
    expect(api.queries[0]?.filter).toEqual({
      and: [
        // One day of slack: the exact comparison is done by the rules engine.
        { property: 'Next Review', date: { on_or_before: '2026-10-10' } },
        {
          or: [
            { property: 'Mastery', number: { less_than: 10 } },
            { property: 'Mastery', number: { is_empty: true } },
          ],
        },
      ],
    });
  });

  it('also fetches undated rows when the rules admit them', async () => {
    const { api, repository } = setup({ rules: { ...sampleRules, includeMissingDueDate: true } });
    await repository.listDueCandidates(TODAY);
    expect((api.queries[0]?.filter as { and: unknown[] }).and[0]).toEqual({
      or: [
        { property: 'Next Review', date: { on_or_before: '2026-10-10' } },
        { property: 'Next Review', date: { is_empty: true } },
      ],
    });
  });

  it('filters formula properties with formula conditions', async () => {
    const { api, repository } = setup();
    api.schema['Next Review'] = { id: 'd', type: 'formula' };
    await repository.listDueCandidates(TODAY);
    expect((api.queries[0]?.filter as { and: unknown[] }).and[0]).toEqual({
      property: 'Next Review',
      formula: { date: { on_or_before: '2026-10-10' } },
    });
  });

  it('reports unusable rows instead of dropping them silently', async () => {
    const { api, repository } = setup();
    api.resultPages = [
      [
        notionPage({ id: pageId(1) }),
        notionPage({ id: pageId(2), word: '' }),
        { object: 'page', id: pageId(3) }, // partial object: nothing to review
      ],
    ];
    const { records, invalid } = await repository.listDueCandidates(TODAY);
    expect(records.map((item) => item.id)).toEqual([pageId(1)]);
    expect(invalid).toEqual([{ id: pageId(2), word: null, reason: '"Word" is empty.' }]);
  });
});

describe('vocabularyStatus', () => {
  const isFiltered = (filter: unknown) => filter !== undefined;

  it('reports words still in progress', async () => {
    const { api, repository } = setup();
    api.rowsFor = () => [notionPage({ id: pageId(1) })];
    await expect(repository.vocabularyStatus()).resolves.toBe('in_progress');
    // One row is enough to know, and only unfinished words are asked for.
    expect(api.queries).toHaveLength(1);
    expect(api.queries[0]).toMatchObject({
      pageSize: 1,
      filter: {
        or: [
          { property: 'Mastery', number: { less_than: 10 } },
          { property: 'Mastery', number: { is_empty: true } },
        ],
      },
    });
  });

  it('reports everything mastered when words exist but none is unfinished', async () => {
    const { api, repository } = setup();
    api.rowsFor = (query) => (isFiltered(query.filter) ? [] : [notionPage({ id: pageId(1), mastery: 10 })]);
    await expect(repository.vocabularyStatus()).resolves.toBe('all_mastered');
  });

  it('reports an empty collection', async () => {
    const { api, repository } = setup();
    api.rowsFor = () => [];
    await expect(repository.vocabularyStatus()).resolves.toBe('empty');
  });
});

describe('getRecord', () => {
  it('returns a live row of the configured data source', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1), word: 'candid', mastery: 6 }));
    await expect(repository.getRecord(pageId(1))).resolves.toMatchObject({ word: 'candid', mastery: 6 });
  });

  it('refuses a page from another database', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1), dataSourceId: OTHER_DATA_SOURCE_ID }));
    await expect(repository.getRecord(pageId(1))).resolves.toBeNull();
  });

  it('refuses a page that is not a database row at all', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), { ...notionPage({ id: pageId(1) }), parent: { type: 'page_id', page_id: pageId(9) } });
    await expect(repository.getRecord(pageId(1))).resolves.toBeNull();
  });

  it('refuses a page in the trash', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1), inTrash: true }));
    await expect(repository.getRecord(pageId(1))).resolves.toBeNull();
  });

  it('returns null for an unknown page but propagates other failures', async () => {
    const { api, repository } = setup();
    await expect(repository.getRecord(pageId(404))).resolves.toBeNull();
    await repository.checkSetup();
    api.failNext = new NotionRequestError('rate_limited', 'slow down', 3);
    await expect(repository.getRecord(pageId(1))).rejects.toMatchObject({ failure: 'rate_limited' });
  });
});

describe('updateReviewState', () => {
  it('sends only the review properties that changed, in Notion format', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1), mastery: 3, nextReview: '2026-10-01' }));

    const updated = await repository.updateReviewState(pageId(1), { mastery: 4, nextReview: '2026-10-13' });
    expect(api.updates).toEqual([
      {
        pageId: pageId(1),
        properties: { Mastery: { number: 4 }, 'Next Review': { date: { start: '2026-10-13' } } },
      },
    ]);
    expect(updated).toMatchObject({ mastery: 4, nextReview: '2026-10-13' });
  });

  it('touches nothing but the date when only the date changes', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1) }));
    await repository.updateReviewState(pageId(1), { nextReview: '2026-10-10' });
    expect(Object.keys(api.updates[0]?.properties ?? {})).toEqual(['Next Review']);
  });

  it('fails loudly when Notion returns something that is not the updated row', async () => {
    const { api, repository } = setup();
    api.pages.set(pageId(1), notionPage({ id: pageId(1), dataSourceId: OTHER_DATA_SOURCE_ID }));
    await expect(repository.updateReviewState(pageId(1), { mastery: 4 })).rejects.toBeInstanceOf(HttpError);
  });
});
