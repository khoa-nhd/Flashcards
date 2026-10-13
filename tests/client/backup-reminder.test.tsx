// @vitest-environment jsdom
/**
 * Settings says when a backup file was last downloaded from this browser and
 * nudges gently once that copy is over a week old. The record itself lives in
 * this browser only, so it is also checked here on its own: never negative,
 * round-trips through the store, and says the right thing at each age.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App.js';
import { BACKUP_NUDGE_DAYS, backupAgeDays, backupSummary, lastBackupAt, recordBackup } from '../../src/lib/backup.js';
import { createFakeApi, entry } from '../helpers/fake-api.js';

const BACKUP_KEY = 'vocabulary-review:lastBackupAt:v1';

const summary = () => screen.getByText(/(No backup has been downloaded|Last backup download)/);

async function open() {
  window.history.replaceState(null, '', '/settings');
  const fake = createFakeApi({ entries: [entry(1)] });
  const view = render(<App api={fake.api} />);
  await screen.findByRole('heading', { name: 'Backup' });
  return { ...fake, user: userEvent.setup(), ...view };
}

describe('the record on its own', () => {
  it('round-trips through a store, and reports nothing before the first download', () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    };
    expect(lastBackupAt(storage)).toBeNull();

    const at = new Date('2026-10-01T10:00:00.000Z');
    recordBackup(storage, at);
    expect(lastBackupAt(storage)).toEqual(at);
  });

  it('counts whole days since the download and never goes negative', () => {
    const now = new Date('2026-10-13T09:00:00.000Z');
    expect(backupAgeDays(null, now)).toBeNull();
    expect(backupAgeDays(new Date('2026-10-13T01:00:00.000Z'), now)).toBe(0);
    expect(backupAgeDays(new Date('2026-10-10T10:00:00.000Z'), now)).toBe(2);
    // A clock set backwards reads as downloaded just now, not in the future.
    expect(backupAgeDays(new Date('2026-10-20T10:00:00.000Z'), now)).toBe(0);
  });

  it('nudges from a week on, and only then', () => {
    expect(backupSummary(null)).toBe('No backup has been downloaded in this browser yet.');
    expect(backupSummary(0)).toBe('Last backup download: today.');
    expect(backupSummary(1)).toBe('Last backup download: yesterday.');
    expect(backupSummary(3)).toBe('Last backup download: 3 days ago.');
    const stale = backupSummary(BACKUP_NUDGE_DAYS);
    expect(stale).toContain('Last backup download: 7 days ago.');
    expect(stale).toContain('over a week old');
    expect(backupSummary(BACKUP_NUDGE_DAYS - 1)).not.toContain('over a week old');
  });
});

describe('the line under the download buttons', () => {
  beforeEach(() => {
    window.localStorage.removeItem(BACKUP_KEY);
    // jsdom never builds downloads; the click and the record are what matter here.
    URL.createObjectURL = () => 'blob:backup';
    URL.revokeObjectURL = () => {};
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    window.localStorage.removeItem(BACKUP_KEY);
  });

  it('says there is nothing yet, and records a download as today', async () => {
    const { user } = await open();
    expect(summary()).toHaveTextContent('No backup has been downloaded in this browser yet.');

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(summary()).toHaveTextContent('Last backup download: today.');
    expect(window.localStorage.getItem(BACKUP_KEY)).not.toBeNull();
  });

  it('asks for a fresh copy once the record is over a week old', async () => {
    window.localStorage.setItem(BACKUP_KEY, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());

    await open();

    expect(summary()).toHaveTextContent('Last backup download: 8 days ago.');
    expect(summary()).toHaveTextContent('over a week old');
  });
});
