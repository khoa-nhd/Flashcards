/**
 * Brings a backup file into one Supabase account and checks the result:
 *
 *   npm run supabase:import                     dry run: shows what would happen, changes nothing
 *   npm run supabase:import -- --apply          imports, then compares every field with the file
 *   npm run supabase:import -- path/to/file.json [--apply]
 *
 * Without a path, the newest `backups/notion-export-*.json` is used.
 *
 * It signs in as the account that should own the words (MIGRATION_EMAIL, and
 * MIGRATION_PASSWORD or a prompt), so it can do nothing that account could not
 * do in the app. Words already imported are left exactly as they are; running
 * it twice, or after a failure, is safe.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyImport, planImport, reconcile, type ReconcileReport } from '../server/supabase/backup-import.js';
import { backupSchema, type Backup } from '../shared/backup.js';
import { isValidTimeZone } from '../shared/dates.js';
import { readProjectConfig, signIn } from './lib/supabase-session.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

function findBackup(given: string | undefined): string {
  if (given !== undefined) {
    if (!existsSync(given)) throw new Error(`No such file: ${given}`);
    return given;
  }
  const files = existsSync('backups')
    ? readdirSync('backups').filter((name) => /^notion-export-.*\.json$/.test(name)).sort()
    : [];
  const latest = files.at(-1);
  if (latest === undefined) throw new Error('No backup found in backups/. Run "npm run notion:export" first.');
  return join('backups', latest);
}

const levels = (counts: Record<string, number>) =>
  Object.entries(counts)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([level, count]) => `${level}×${count}`)
    .join(', ') || 'none';

function printReport(report: ReconcileReport): void {
  console.log('\nReconciliation (backup file compared with the account, field by field)');
  console.log(`  words in the backup that can be stored: ${report.expected}`);
  console.log(`  of those, found in the account:         ${report.found}`);
  console.log(`  missing from the account:               ${report.missing.length}`);
  console.log(`  with a value that differs:              ${new Set(report.mismatched.map((item) => item.externalId)).size}`);
  console.log(`  imported words now in the trash:        ${report.trashed}`);
  console.log(`  words in the account from elsewhere:    ${report.notFromBackup}`);
  console.log(`  mastery levels in the backup:  ${levels(report.mastery.backup)}`);
  console.log(`  mastery levels in the account: ${levels(report.mastery.stored)}`);
  for (const item of report.missing.slice(0, 20)) console.log(`  MISSING   ${item.externalId}  ${item.word}`);
  for (const item of report.mismatched.slice(0, 40)) {
    console.log(`  DIFFERENT ${item.externalId}  ${item.word}: ${item.field} is ${JSON.stringify(item.stored)}, the backup has ${JSON.stringify(item.expected)}`);
  }
  const hidden = Math.max(0, report.missing.length - 20) + Math.max(0, report.mismatched.length - 40);
  if (hidden > 0) console.log(`  …and ${hidden} more.`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const file = findBackup(args.find((arg) => !arg.startsWith('--')));

  const backup: Backup = backupSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const project = readProjectConfig();
  const session = await signIn(project, 'MIGRATION_EMAIL', 'MIGRATION_PASSWORD');

  console.log(`Backup:  ${file}`);
  console.log(`         ${backup.count} words from ${backup.source}, exported ${backup.exportedAt}, time zone ${backup.timeZone}`);
  console.log(`Account: ${session.email} (${session.userId})`);

  const plan = await planImport(session.database, backup);
  console.log(`\nPlan`);
  console.log(`  to create:        ${plan.toCreate.length}`);
  console.log(`  already imported: ${plan.alreadyImported}`);
  console.log(`  cannot be stored: ${plan.unusable.length}`);
  for (const item of plan.unusable) console.log(`  UNUSABLE  ${item.externalId}  ${item.word}: ${item.reason}`);
  if (backup.skipped.length > 0) {
    console.log(`  NOTE: the export itself left out ${backup.skipped.length} source ${backup.skipped.length === 1 ? 'row' : 'rows'}:`);
    for (const row of backup.skipped) console.log(`    ${row.id}: ${row.reason}`);
  }

  if (!apply) {
    printReport(await reconcile(session.database, backup));
    console.log('\nDry run: nothing was changed. Run again with --apply to import.');
    return 0;
  }

  const result = await applyImport(session.database, backup, plan, (done, total) => {
    if (done === total || done % 25 === 0) console.log(`  imported ${done} of ${total}`);
  });
  console.log(`\nCreated ${result.created} ${result.created === 1 ? 'word' : 'words'}.`);

  // "Today" must mean the same day it did before, or due dates would shift.
  if (isValidTimeZone(backup.timeZone)) {
    const before = await session.database.getTimeZone();
    const zone = await session.database.saveTimeZone(backup.timeZone);
    console.log(before === zone ? `Time zone is ${zone}.` : `Time zone set to ${zone} (was ${before ?? 'not set'}).`);
  }

  const report = await reconcile(session.database, backup);
  printReport(report);

  const complete = report.identical && plan.unusable.length === 0 && backup.skipped.length === 0;
  console.log(
    complete
      ? '\nRESULT: every word in the backup is in the account with identical values.'
      : '\nRESULT: NOT identical. See the lines above. Nothing was overwritten.',
  );
  return complete ? 0 : 3;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'The import failed.');
    process.exitCode = 1;
  },
);
