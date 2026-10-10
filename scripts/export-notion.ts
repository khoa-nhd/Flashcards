/**
 * One-off, read-only export of the whole Notion vocabulary database to a
 * local JSON file: `npm run notion:export`.
 *
 * The file is both the recoverable backup of the original data and the input
 * of `npm run supabase:import`. It contains your vocabulary, so it is written
 * to `backups/`, which is git-ignored. Nothing in Notion is changed.
 *
 * This script and the Notion client it uses are removed at the final cutover.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardFields, notionProperties, reviewRules, vocabularyFields } from '../config/review.config.js';
import { loadConfig } from '../server/env.js';
import { createNotionApi } from '../server/notion/notion-client.js';
import { NotionVocabularyRepository } from '../server/notion/notion-repository.js';
import { BACKUP_FORMAT, backupSchema, type Backup, type BackupEntry } from '../shared/backup.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

async function main() {
  const config = loadConfig({ ...process.env, DATA_MODE: 'notion' });
  if (config.notion === null || config.timeZone === null) {
    console.error(`Cannot export: ${config.issues.join(' ')}`);
    process.exitCode = 1;
    return;
  }

  const repository = new NotionVocabularyRepository(createNotionApi(config.notion.apiKey), {
    databaseId: config.notion.databaseId,
    dataSourceId: config.notion.dataSourceId,
    properties: notionProperties,
    vocabularyFields,
    cardFields,
    rules: reviewRules,
    timeZone: config.timeZone,
  });

  const { entries: rows, invalid } = await repository.listEntries();
  const entries: BackupEntry[] = rows
    .map((row) => ({
      externalId: row.id,
      word: row.word,
      meaning: row.meaning,
      definition: row.definition,
      example: row.example,
      mastery: row.mastery,
      reviewDate: row.reviewDate,
      dateAdded: row.dateAdded,
      createdTime: row.createdTime,
      lastEditedTime: row.lastEditedTime,
      url: row.url,
      ...(row.formattedFields.length > 0 ? { formattedFields: row.formattedFields } : {}),
    }))
    // A stable order, so two exports of unchanged data are byte-identical.
    .sort((a, b) => a.externalId.localeCompare(b.externalId));

  const exportedAt = new Date().toISOString();
  const backup: Backup = backupSchema.parse({
    format: BACKUP_FORMAT,
    source: 'notion',
    exportedAt,
    timeZone: config.timeZone,
    count: entries.length,
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    entries,
    skipped: invalid,
  });

  mkdirSync('backups', { recursive: true });
  const file = join('backups', `notion-export-${exportedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`);
  writeFileSync(file, `${JSON.stringify(backup, null, 2)}\n`, { flag: 'wx' });

  // A summary only: the words themselves stay in the file.
  const masteries = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.mastery === null ? 'empty' : String(entry.mastery);
    masteries.set(key, (masteries.get(key) ?? 0) + 1);
  }
  const count = (test: (entry: BackupEntry) => boolean) => entries.filter(test).length;
  console.log(`Exported ${entries.length} words to ${file}`);
  console.log(`  checksum (sha256 of entries): ${backup.sha256}`);
  console.log(`  mastery levels: ${[...masteries].sort((a, b) => Number(a[0]) - Number(b[0])).map(([level, n]) => `${level}×${n}`).join(', ')}`);
  console.log(`  with a review date: ${count((entry) => entry.reviewDate !== null)} | with a date added: ${count((entry) => entry.dateAdded !== null)}`);
  console.log(`  with meaning / definition / example: ${count((entry) => entry.meaning !== null)} / ${count((entry) => entry.definition !== null)} / ${count((entry) => entry.example !== null)}`);
  const formatted = count((entry) => (entry.formattedFields ?? []).length > 0);
  console.log(
    formatted === 0
      ? '  formatting: none of the text uses bold, links or similar, so nothing is flattened'
      : `  formatting: ${formatted} ${formatted === 1 ? 'word has' : 'words have'} bold, links or similar in Notion; the backup keeps their plain text`,
  );
  if (invalid.length > 0) {
    console.log(`  NOT exported (${invalid.length}): ${invalid.map((row) => `${row.id}: ${row.reason}`).join('; ')}`);
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Export failed.');
  process.exitCode = 1;
});
