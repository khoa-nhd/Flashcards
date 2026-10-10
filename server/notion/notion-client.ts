/**
 * The only file that talks to Notion. It exposes a narrow interface so the rest
 * of the server (and the tests) never depend on the SDK, and so the integration
 * token never leaves this module.
 */
import { Client, type QueryDataSourceParameters, type UpdatePageParameters } from '@notionhq/client';
import { toNotionRequestError } from './notion-errors.js';

/**
 * Pinned so an SDK upgrade cannot silently change response shapes. 2025-09-03
 * is the version that introduced data sources: rows are queried from a data
 * source, and a database is a container of one or more data sources.
 */
export const NOTION_VERSION = '2025-09-03';

const REQUEST_TIMEOUT_MS = 15_000;

export interface DataSourceQuery {
  dataSourceId: string;
  filter?: unknown;
  sorts?: unknown;
  startCursor?: string;
  pageSize?: number;
}

/** Responses are `unknown` on purpose: they are validated in notion-mappers.ts. */
export interface NotionApi {
  retrieveDatabase(databaseId: string): Promise<unknown>;
  retrieveDataSource(dataSourceId: string): Promise<unknown>;
  queryDataSource(query: DataSourceQuery): Promise<unknown>;
  retrievePage(pageId: string): Promise<unknown>;
  updatePage(pageId: string, properties: Record<string, unknown>): Promise<unknown>;
  listViews(dataSourceId: string, startCursor?: string): Promise<unknown>;
  retrieveView(viewId: string): Promise<unknown>;
}

export function createNotionApi(apiKey: string): NotionApi {
  // The SDK retries rate limits (honouring Retry-After) and, for reads, transient 5xx.
  const client = new Client({ auth: apiKey, notionVersion: NOTION_VERSION, timeoutMs: REQUEST_TIMEOUT_MS });

  const call = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      throw toNotionRequestError(error);
    }
  };

  return {
    retrieveDatabase: (databaseId) => call(() => client.databases.retrieve({ database_id: databaseId })),
    retrieveDataSource: (dataSourceId) =>
      call(() => client.dataSources.retrieve({ data_source_id: dataSourceId })),
    queryDataSource: ({ dataSourceId, filter, sorts, startCursor, pageSize }) =>
      call(() =>
        client.dataSources.query({
          data_source_id: dataSourceId,
          filter: filter as QueryDataSourceParameters['filter'],
          sorts: sorts as QueryDataSourceParameters['sorts'],
          start_cursor: startCursor,
          page_size: pageSize ?? 100,
          result_type: 'page',
        }),
      ),
    retrievePage: (pageId) => call(() => client.pages.retrieve({ page_id: pageId })),
    updatePage: (pageId, properties) =>
      call(() =>
        client.pages.update({
          page_id: pageId,
          properties: properties as UpdatePageParameters['properties'],
        }),
      ),
    listViews: (dataSourceId, startCursor) =>
      call(() => client.views.list({ data_source_id: dataSourceId, start_cursor: startCursor })),
    retrieveView: (viewId) => call(() => client.views.retrieve({ view_id: viewId })),
  };
}
