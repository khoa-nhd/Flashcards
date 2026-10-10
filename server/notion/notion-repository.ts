import { normalizeId, type SkippedRecord, type VocabularyStatus } from '../../shared/api.js';
import { addDays, type IsoDate } from '../../shared/dates.js';
import type { ReviewRules, ReviewState } from '../../shared/review-logic.js';
import type { CardFieldConfig, NotionPropertyConfig, VocabularyRecord } from '../../shared/vocabulary.js';
import { HttpError } from '../errors.js';
import type { SetupReport, VocabularyRepository } from '../vocabulary-repository.js';
import type { NotionApi } from './notion-client.js';
import { NotionRequestError } from './notion-errors.js';
import {
  DATE_TYPES,
  NUMBER_TYPES,
  TEXT_TYPES,
  dataSourceSchema,
  databaseSchema,
  mapPageToRecord,
  pageSchema,
} from './notion-mappers.js';
import { collectPaginated, listPageSchema } from './pagination.js';

export interface NotionRepositoryOptions {
  databaseId: string | null;
  dataSourceId: string | null;
  properties: NotionPropertyConfig;
  cardFields: readonly CardFieldConfig[];
  rules: ReviewRules;
  timeZone: string;
}

interface ResolvedSchema extends SetupReport {
  dataSourceId: string;
  types: Map<string, string>;
  /** Card fields whose property exists and can be read as text. */
  fields: CardFieldConfig[];
}

const includes = (types: readonly string[], type: string | undefined) =>
  type !== undefined && types.includes(type);

export class NotionVocabularyRepository implements VocabularyRepository {
  readonly mode = 'notion' as const;
  private schema: Promise<ResolvedSchema> | null = null;

  constructor(
    private readonly api: NotionApi,
    private readonly options: NotionRepositoryOptions,
  ) {}

  async checkSetup(): Promise<SetupReport> {
    const { readIssues, writeIssues, warnings } = await this.resolveSchema();
    return { readIssues, writeIssues, warnings };
  }

  async listDueCandidates(today: IsoDate) {
    const schema = await this.readableSchema();
    const { properties, rules } = this.options;

    const raw = await collectPaginated((startCursor) =>
      this.api.queryDataSource({
        dataSourceId: schema.dataSourceId,
        filter: this.buildCandidateFilter(schema, today),
        sorts: [{ property: properties.nextReview, direction: rules.sortDirection }],
        startCursor,
      }),
    );

    const records: VocabularyRecord[] = [];
    const invalid: SkippedRecord[] = [];
    for (const item of raw) {
      const page = pageSchema.safeParse(item);
      if (!page.success) continue; // Partial objects carry no properties to review.
      const mapped = mapPageToRecord(page.data, this.mapping(schema));
      if (mapped.ok) records.push(mapped.record);
      else invalid.push(mapped.skipped);
    }
    return { records, invalid };
  }

  /** Two one-row queries, only ever run when the due queue came back empty. */
  async vocabularyStatus(): Promise<VocabularyStatus> {
    const schema = await this.readableSchema();
    const { properties, rules } = this.options;
    const anyRow = async (filter?: unknown) => {
      const page = listPageSchema.safeParse(
        await this.api.queryDataSource({ dataSourceId: schema.dataSourceId, filter, pageSize: 1 }),
      );
      if (!page.success) throw new Error('Notion returned a malformed list response.');
      return page.data.results.length > 0;
    };

    const unfinished = this.condition(schema, properties.mastery, 'number', {
      less_than: rules.retiredAtMastery,
    });
    if (unfinished === null) {
      // Mastery cannot be filtered server-side, so completion is never claimed.
      return (await anyRow()) ? 'in_progress' : 'empty';
    }
    const ungraded = this.condition(schema, properties.mastery, 'number', { is_empty: true });
    if (await anyRow({ or: [unfinished, ungraded] })) return 'in_progress';
    return (await anyRow()) ? 'all_mastered' : 'empty';
  }

  async getRecord(pageId: string): Promise<VocabularyRecord | null> {
    const schema = await this.readableSchema();
    let raw: unknown;
    try {
      raw = await this.api.retrievePage(pageId);
    } catch (error) {
      if (error instanceof NotionRequestError && error.failure === 'not_found') return null;
      throw error;
    }
    return this.toLiveRecord(raw, schema);
  }

  async updateReviewState(pageId: string, changes: Partial<ReviewState>): Promise<VocabularyRecord> {
    const schema = await this.readableSchema();
    if (schema.writeIssues.length > 0) {
      throw new HttpError(409, 'read_only', schema.writeIssues.join(' '));
    }

    const { properties } = this.options;
    const update: Record<string, unknown> = {};
    if (changes.mastery !== undefined) update[properties.mastery] = { number: changes.mastery };
    if (changes.nextReview !== undefined) {
      update[properties.nextReview] = {
        date: changes.nextReview === null ? null : { start: changes.nextReview },
      };
    }

    const record = this.toLiveRecord(await this.api.updatePage(pageId, update), schema);
    if (record === null) {
      throw new HttpError(502, 'unconfirmed_write', 'Notion returned an unexpected response to the update.');
    }
    return record;
  }

  /** A page counts only if it is a live row of the configured data source. */
  private toLiveRecord(raw: unknown, schema: ResolvedSchema): VocabularyRecord | null {
    const page = pageSchema.safeParse(raw);
    if (!page.success) return null;
    if (page.data.in_trash === true || page.data.archived === true) return null;
    const parentId = page.data.parent.data_source_id;
    if (page.data.parent.type !== 'data_source_id' || parentId === undefined) return null;
    if (normalizeId(parentId) !== schema.dataSourceId) return null;

    const mapped = mapPageToRecord(page.data, this.mapping(schema));
    if (!mapped.ok) throw new HttpError(409, 'invalid_record', mapped.skipped.reason);
    return mapped.record;
  }

  private mapping(schema: ResolvedSchema) {
    return { properties: this.options.properties, fields: schema.fields, timeZone: this.options.timeZone };
  }

  /**
   * A server-side pre-filter that only reduces how much is downloaded. It is
   * deliberately looser than the real rule (one extra day, so Notion's own
   * reading of "today" cannot drop a due row); shared/review-logic.ts decides
   * what is actually in the queue.
   */
  private buildCandidateFilter(schema: ResolvedSchema, today: IsoDate): unknown {
    const { properties, rules } = this.options;
    const horizon = addDays(today, 1);
    const condition = (property: string, kind: 'date' | 'number', test: Record<string, unknown>) =>
      this.condition(schema, property, kind, test);

    const clauses: unknown[] = [];

    const due = condition(properties.nextReview, 'date', { on_or_before: horizon });
    if (due !== null) {
      const empty = condition(properties.nextReview, 'date', { is_empty: true });
      clauses.push(rules.includeMissingDueDate ? { or: [due, empty] } : due);
    }

    const notRetired = condition(properties.mastery, 'number', { less_than: rules.retiredAtMastery });
    if (notRetired !== null) {
      // Rows with an empty mastery are fetched too, so they can be reported instead of vanishing.
      clauses.push({ or: [notRetired, condition(properties.mastery, 'number', { is_empty: true })] });
    }

    return clauses.length > 0 ? { and: clauses } : undefined;
  }

  /** A Notion filter clause for a property, in the form its type requires. */
  private condition(
    schema: ResolvedSchema,
    property: string,
    kind: 'date' | 'number',
    test: Record<string, unknown>,
  ): unknown {
    const type = schema.types.get(property);
    if (type === kind) return { property, [kind]: test };
    if (type === 'formula') return { property, formula: { [kind]: test } };
    return null; // Rollups and anything else are filtered locally only.
  }

  private async readableSchema(): Promise<ResolvedSchema> {
    const schema = await this.resolveSchema();
    if (schema.readIssues.length > 0) {
      throw new HttpError(503, 'setup_incomplete', schema.readIssues.join(' '));
    }
    return schema;
  }

  private resolveSchema(): Promise<ResolvedSchema> {
    if (this.schema === null) {
      this.schema = this.loadSchema().catch((error: unknown) => {
        this.schema = null; // Do not cache a failure; the next request retries.
        throw error;
      });
    }
    return this.schema;
  }

  private async loadSchema(): Promise<ResolvedSchema> {
    const dataSourceId = await this.resolveDataSourceId();
    const parsed = dataSourceSchema.safeParse(await this.api.retrieveDataSource(dataSourceId));
    if (!parsed.success) throw new Error('Notion returned a data source without a readable schema.');

    const types = new Map(Object.entries(parsed.data.properties).map(([name, value]) => [name, value.type]));
    const available = [...types].map(([name, type]) => `"${name}" (${type})`).join(', ');
    const readIssues: string[] = [];
    const writeIssues: string[] = [];
    const warnings: string[] = [];
    const { properties, cardFields } = this.options;

    const requireReadable = (role: string, name: string, readable: readonly string[]) => {
      const type = types.get(name);
      if (type === undefined) {
        readIssues.push(
          `No property named "${name}" for the ${role}. Fix the name in config/review.config.ts. Available: ${available}.`,
        );
      } else if (!includes(readable, type)) {
        readIssues.push(`"${name}" (${type}) cannot be used as the ${role}.`);
      }
      return type;
    };

    requireReadable('word', properties.word, TEXT_TYPES);
    const masteryType = requireReadable('mastery', properties.mastery, NUMBER_TYPES);
    const dateType = requireReadable('next review date', properties.nextReview, DATE_TYPES);

    // Computed properties can be read but never written through the API.
    if (masteryType !== undefined && masteryType !== 'number' && includes(NUMBER_TYPES, masteryType)) {
      writeIssues.push(`"${properties.mastery}" is a ${masteryType}, so the app cannot update it.`);
    }
    if (dateType !== undefined && dateType !== 'date' && includes(DATE_TYPES, dateType)) {
      writeIssues.push(`"${properties.nextReview}" is a ${dateType}, so the app cannot update it.`);
    }

    const fields: CardFieldConfig[] = [];
    for (const field of cardFields) {
      const type = types.get(field.property);
      if (type === undefined) {
        warnings.push(`Card field "${field.label}" skipped: no property named "${field.property}".`);
      } else if (!includes(TEXT_TYPES, type)) {
        warnings.push(`Card field "${field.label}" skipped: "${field.property}" (${type}) is not text.`);
      } else {
        fields.push(field);
      }
    }

    return { dataSourceId, types, fields, readIssues, writeIssues, warnings };
  }

  private async resolveDataSourceId(): Promise<string> {
    const { dataSourceId, databaseId } = this.options;
    if (dataSourceId !== null) return normalizeId(dataSourceId);
    if (databaseId === null) throw new HttpError(503, 'setup_incomplete', 'No Notion database is configured.');

    const database = databaseSchema.safeParse(await this.api.retrieveDatabase(databaseId));
    if (!database.success) throw new Error('Notion returned a database without data sources.');

    const sources = database.data.data_sources;
    if (sources.length === 1 && sources[0] !== undefined) return normalizeId(sources[0].id);
    if (sources.length === 0) {
      throw new HttpError(503, 'setup_incomplete', 'The Notion database has no data source.');
    }
    const listed = sources.map((source) => `"${source.name ?? 'Untitled'}" (${source.id})`).join(', ');
    throw new HttpError(
      503,
      'setup_incomplete',
      `The Notion database has several data sources: ${listed}. Set NOTION_DATA_SOURCE_ID to the vocabulary one.`,
    );
  }
}
