/**
 * The file format used to carry vocabulary from the original database into
 * the new one. It is written once by the export script and read by the import
 * script, which has no dependency on where the data came from.
 */
import { z } from 'zod';
import { isoDateSchema } from './api.js';

export const BACKUP_FORMAT = 'vocabulary-backup/v1';

export const backupEntrySchema = z.object({
  /** The record's id in the system it was exported from. Makes a repeated import a no-op. */
  externalId: z.string().min(1),
  word: z.string().min(1),
  meaning: z.string().nullable(),
  definition: z.string().nullable(),
  example: z.string().nullable(),
  mastery: z.number().nullable(),
  reviewDate: isoDateSchema.nullable(),
  dateAdded: isoDateSchema.nullable(),
  /** Timestamps kept by the source system, in UTC. */
  createdTime: z.string().nullable(),
  lastEditedTime: z.string().nullable(),
  url: z.string().nullable(),
  /**
   * Text fields that carried formatting (bold, links…) in the source. The
   * backup holds their plain text, so this is the list of what was flattened.
   */
  formattedFields: z.array(z.string()).optional(),
});

/** The checksum stored in a backup: SHA-256 of `JSON.stringify(entries)`, as hex. */
export async function checksumOf(entries: readonly unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  source: z.string().min(1),
  exportedAt: z.string(),
  /** The time zone the source's calendar dates were read in. */
  timeZone: z.string(),
  count: z.number().int().nonnegative(),
  /** SHA-256 of `JSON.stringify(entries)`, to detect a damaged or edited file. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(backupEntrySchema),
  /** Source rows that could not be exported, with the reason. An honest backup lists them. */
  skipped: z.array(z.object({ id: z.string(), word: z.string().nullable(), reason: z.string() })),
});

export type BackupEntry = z.infer<typeof backupEntrySchema>;
export type Backup = z.infer<typeof backupSchema>;
