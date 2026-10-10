/** Hand-built Notion API payloads and a fake client. No test ever reaches the real API. */
import type { DataSourceQuery, NotionApi } from '../../server/notion/notion-client.js';
import { NotionRequestError } from '../../server/notion/notion-errors.js';
import type { CardFieldConfig, NotionPropertyConfig } from '../../shared/vocabulary.js';

export const DATABASE_ID = '11111111-1111-4111-8111-111111111111';
export const DATA_SOURCE_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_DATA_SOURCE_ID = '33333333-3333-4333-8333-333333333333';

export const TEST_PROPERTIES: NotionPropertyConfig = {
  word: 'Word',
  mastery: 'Mastery',
  nextReview: 'Next Review',
};

export const TEST_FIELDS: CardFieldConfig[] = [
  { key: 'partOfSpeech', property: 'Part of Speech', label: 'Part of speech', side: 'front', visibility: 'always' },
  { key: 'definition', property: 'Definition', label: 'Definition', side: 'back', visibility: 'details' },
  { key: 'example', property: 'Example', label: 'Example', side: 'back', visibility: 'details' },
];

export const richText = (...parts: string[]) =>
  parts.map((text) => ({ type: 'text', plain_text: text, text: { content: text }, annotations: {} }));

export interface PageOptions {
  id: string;
  word?: string;
  mastery?: number | null;
  nextReview?: string | null;
  definition?: string | null;
  example?: string | null;
  dataSourceId?: string;
  inTrash?: boolean;
  properties?: Record<string, unknown>;
}

export function notionPage(options: PageOptions) {
  const { id, word = 'serendipity', mastery = 3, nextReview = '2026-10-09', definition = 'a happy accident' } = options;
  const example = options.example === undefined ? 'What serendipity!' : options.example;
  return {
    object: 'page',
    id,
    in_trash: options.inTrash ?? false,
    archived: false,
    parent: {
      type: 'data_source_id',
      data_source_id: options.dataSourceId ?? DATA_SOURCE_ID,
      database_id: DATABASE_ID,
    },
    properties: {
      Word: { id: 'title', type: 'title', title: richText(word) },
      Mastery: { id: 'm', type: 'number', number: mastery },
      'Next Review': {
        id: 'd',
        type: 'date',
        date: nextReview === null ? null : { start: nextReview, end: null, time_zone: null },
      },
      'Part of Speech': { id: 'p', type: 'select', select: { id: 'x', name: 'noun', color: 'blue' } },
      Definition: { id: 'f', type: 'rich_text', rich_text: definition === null ? [] : richText(definition) },
      Example: { id: 'e', type: 'rich_text', rich_text: example === null ? [] : richText(example) },
      ...options.properties,
    },
  };
}

export const DEFAULT_SCHEMA: Record<string, { id: string; type: string }> = {
  Word: { id: 'title', type: 'title' },
  Mastery: { id: 'm', type: 'number' },
  'Next Review': { id: 'd', type: 'date' },
  'Part of Speech': { id: 'p', type: 'select' },
  Definition: { id: 'f', type: 'rich_text' },
  Example: { id: 'e', type: 'rich_text' },
  Remember: { id: 'b', type: 'button' },
};

export class FakeNotionApi implements NotionApi {
  database: unknown = {
    object: 'database',
    id: DATABASE_ID,
    data_sources: [{ id: DATA_SOURCE_ID, name: 'Vocabulary' }],
  };
  schema: Record<string, { id: string; type: string }> = { ...DEFAULT_SCHEMA };
  /** Query results, one array per page of the paginated response. */
  resultPages: unknown[][] = [[]];
  pages = new Map<string, unknown>();
  failNext: NotionRequestError | null = null;

  readonly queries: DataSourceQuery[] = [];
  readonly updates: Array<{ pageId: string; properties: Record<string, unknown> }> = [];
  databaseLookups = 0;
  schemaLookups = 0;

  private maybeFail() {
    const failure = this.failNext;
    this.failNext = null;
    if (failure) throw failure;
  }

  async retrieveDatabase() {
    this.maybeFail();
    this.databaseLookups += 1;
    return this.database;
  }

  async retrieveDataSource(dataSourceId: string) {
    this.maybeFail();
    this.schemaLookups += 1;
    return { object: 'data_source', id: dataSourceId, properties: this.schema };
  }

  /** When set, decides the rows for a query from its filter instead of `resultPages`. */
  rowsFor: ((query: DataSourceQuery) => unknown[]) | null = null;

  async queryDataSource(query: DataSourceQuery) {
    this.maybeFail();
    this.queries.push(query);
    if (this.rowsFor !== null) {
      const rows = this.rowsFor(query).slice(0, query.pageSize ?? 100);
      return { object: 'list', results: rows, has_more: false, next_cursor: null };
    }
    const index = query.startCursor === undefined ? 0 : Number(query.startCursor.replace('cursor-', ''));
    const hasMore = index < this.resultPages.length - 1;
    return {
      object: 'list',
      results: this.resultPages[index] ?? [],
      has_more: hasMore,
      next_cursor: hasMore ? `cursor-${index + 1}` : null,
    };
  }

  async retrievePage(pageId: string) {
    this.maybeFail();
    const page = this.pages.get(pageId);
    if (page === undefined) throw new NotionRequestError('not_found', 'not found');
    return page;
  }

  async updatePage(pageId: string, properties: Record<string, unknown>) {
    this.maybeFail();
    this.updates.push({ pageId, properties });
    const page = this.pages.get(pageId) as { properties: Record<string, Record<string, unknown>> } | undefined;
    if (page === undefined) throw new NotionRequestError('not_found', 'not found');
    const merged = { ...page.properties };
    for (const [name, value] of Object.entries(properties)) {
      merged[name] = { ...merged[name], ...(value as Record<string, unknown>) };
    }
    const updated = { ...page, properties: merged };
    this.pages.set(pageId, updated);
    return updated;
  }

  async listViews() {
    return { object: 'list', results: [], has_more: false, next_cursor: null };
  }

  async retrieveView() {
    return {};
  }
}
