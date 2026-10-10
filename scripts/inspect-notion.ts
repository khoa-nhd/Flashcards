/**
 * Read-only inspection of the vocabulary database: `npm run notion:inspect`.
 *
 * Prints the property schema (names, types, formula expressions), every view's
 * filter and sort, and how config/review.config.ts lines up with them. It
 * performs no writes, prints no secret, and prints no vocabulary content.
 */
import { z } from 'zod';
import {
  cardFields,
  notionProperties,
  pendingConfirmation,
  reviewRules,
  vocabularyFields,
} from '../config/review.config.js';
import { normalizeId } from '../shared/api.js';
import { loadConfig } from '../server/env.js';
import { createNotionApi } from '../server/notion/notion-client.js';
import { NotionRequestError } from '../server/notion/notion-errors.js';
import { databaseSchema } from '../server/notion/notion-mappers.js';
import { NotionVocabularyRepository } from '../server/notion/notion-repository.js';
import { collectPaginated } from '../server/notion/pagination.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const propertySchema = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  formula: z.looseObject({ expression: z.string().optional() }).optional(),
});
const schemaResponse = z.looseObject({ properties: z.record(z.string(), propertySchema) });
const viewSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  filter: z.unknown().optional(),
  // Filters added from the view's filter bar are stored here, not in `filter`.
  quick_filters: z.unknown().optional(),
  sorts: z.unknown().optional(),
});

const heading = (title: string) => console.log(`\n=== ${title} ===`);

/** Views refer to properties by id; this rewrites those references as names. */
function withPropertyNames(value: unknown, nameById: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => withPropertyNames(item, nameById));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      nameById.get(key) ?? key,
      key === 'property' && typeof inner === 'string'
        ? (nameById.get(inner) ?? inner)
        : withPropertyNames(inner, nameById),
    ]),
  );
}

async function main() {
  const config = loadConfig({ ...process.env, DATA_MODE: 'notion' });
  if (config.notion === null) {
    console.error('NOTION_API_KEY is not set. Add it to .env (see .env.example).');
    process.exitCode = 1;
    return;
  }
  const { apiKey, databaseId, dataSourceId: configuredSource } = config.notion;
  const api = createNotionApi(apiKey);

  let dataSourceId = configuredSource;
  if (dataSourceId === null) {
    if (databaseId === null) {
      console.error('Set NOTION_DATABASE_ID (or NOTION_DATA_SOURCE_ID) in .env.');
      process.exitCode = 1;
      return;
    }
    const database = databaseSchema.parse(await api.retrieveDatabase(databaseId));
    heading('Data sources');
    for (const source of database.data_sources) console.log(`- ${source.name ?? 'Untitled'}: ${source.id}`);
    if (database.data_sources.length !== 1 || database.data_sources[0] === undefined) {
      console.log('Set NOTION_DATA_SOURCE_ID to the vocabulary data source and run this again.');
      return;
    }
    dataSourceId = database.data_sources[0].id;
  }
  dataSourceId = normalizeId(dataSourceId);

  heading('Properties');
  const schema = schemaResponse.parse(await api.retrieveDataSource(dataSourceId));
  const nameById = new Map<string, string>();
  for (const [name, property] of Object.entries(schema.properties)) {
    if (property.id === undefined) continue;
    nameById.set(property.id, name);
    // The schema reports ids URL-encoded; views use them decoded.
    try {
      nameById.set(decodeURIComponent(property.id), name);
    } catch {
      // Not URL-encoded after all.
    }
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    let note = '';
    if (property.type === 'formula' && property.formula?.expression) note = `  =  ${property.formula.expression}`;
    if (property.type === 'button') note = '  (button steps are not exposed by the Notion API)';
    console.log(`- "${name}": ${property.type}${note}`);
  }

  heading('Views (filter and sort as stored in Notion)');
  try {
    const views = await collectPaginated((cursor) => api.listViews(dataSourceId, cursor));
    if (views.length === 0) console.log('No views were returned for this data source.');
    for (const entry of views) {
      const listed = viewSchema.safeParse(entry);
      if (!listed.success) continue;
      const view = viewSchema.safeParse(await api.retrieveView(listed.data.id));
      const detail = view.success ? view.data : listed.data;
      const show = (value: unknown) => JSON.stringify(withPropertyNames(value ?? null, nameById));
      console.log(`- ${detail.name ?? 'Untitled'} (${detail.type ?? 'unknown type'})`);
      console.log(`    filter:        ${show(detail.filter)}`);
      console.log(`    quick filters: ${show(detail.quick_filters)}`);
      console.log(`    sorts:         ${show(detail.sorts)}`);
    }
  } catch (error) {
    const reason = error instanceof NotionRequestError ? error.message : 'unexpected error';
    console.log(`Could not read views (${reason}). Check the filter and sort in Notion by hand.`);
  }

  heading('config/review.config.ts against this schema');
  if (config.timeZone === null) {
    console.log('REVIEW_TIMEZONE is not set; set it before running the app.');
  }
  const repository = new NotionVocabularyRepository(api, {
    databaseId,
    dataSourceId,
    properties: notionProperties,
    vocabularyFields,
    cardFields,
    rules: reviewRules,
    timeZone: config.timeZone ?? 'UTC',
  });
  const report = await repository.checkSetup();
  for (const issue of report.readIssues) console.log(`BLOCKS READING: ${issue}`);
  for (const issue of report.writeIssues) console.log(`BLOCKS WRITING: ${issue}`);
  const entryIssues = report.entryWriteIssues ?? [];
  for (const issue of entryIssues) console.log(`BLOCKS ADDING AND EDITING WORDS: ${issue}`);
  for (const warning of report.warnings) console.log(`warning: ${warning}`);
  if (report.readIssues.length + report.writeIssues.length + entryIssues.length + report.warnings.length === 0) {
    console.log('Every configured property was found with a usable type.');
  }

  heading('Still to confirm (see docs/review-logic.md)');
  for (const item of pendingConfirmation) console.log(`- ${item}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Inspection failed.');
  process.exitCode = 1;
});
