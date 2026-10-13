/**
 * When a backup file was last downloaded, so Settings can say how long ago
 * that was and nudge gently once it has been over a week. It is kept in this
 * browser only — nothing is sent anywhere, and losing it only loses the nudge.
 */

/** A copy older than this is worth refreshing; the line under the buttons says so. */
export const BACKUP_NUDGE_DAYS = 7;

const STORAGE_KEY = 'vocabulary-review:lastBackupAt:v1';

const DAY_MS = 24 * 60 * 60 * 1000;

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.localStorage;
  } catch {
    return null; // Storage can be blocked entirely; the nudge then simply never shows.
  }
}

/** The last download this browser knows of, or null when there is no record. */
export function lastBackupAt(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
): Date | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/** Marks a backup as downloaded now. A blocked store only means the nudge does not persist. */
export function recordBackup(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
  now: Date = new Date(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, now.toISOString());
  } catch {
    // A full or blocked store only means the preference does not persist.
  }
}

/** Whole days since the last download, never negative; null when nothing is recorded. */
export function backupAgeDays(at: Date | null, now: Date = new Date()): number | null {
  if (at === null) return null;
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY_MS));
}

/** The line Settings shows under the download buttons: always the age, and a gentle nudge past a week. */
export function backupSummary(days: number | null): string {
  if (days === null) return 'No backup has been downloaded in this browser yet.';
  const age = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return days >= BACKUP_NUDGE_DAYS
    ? `Last backup download: ${age}. That copy is over a week old — download a fresh one when you can.`
    : `Last backup download: ${age}.`;
}
