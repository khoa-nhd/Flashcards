/** The parts of Settings that exist because the app has accounts: who is signed in, their time zone, their trash. */
import { useEffect, useMemo, useState } from 'react';
import type { AccountSettings, VocabularyEntry } from '../../shared/api.js';
import { useApp, type AccountControls } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { MasteryPill } from './badges.js';
import { BUTTON_SECONDARY, CARD, HELP, INPUT, SECTION_TITLE } from './ui.js';

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

export function AccountSection({ account }: { account: AccountControls }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await account.signOut();
    } catch {
      setError('Could not sign out. Check your connection and try again.');
      setBusy(false);
    }
  };

  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`}>
      <h2 className={SECTION_TITLE}>Account</h2>
      <p className="text-sm">
        Signed in as <strong className="font-semibold">{account.email ?? 'your account'}</strong>.
      </p>
      <p className={HELP}>
        Your words and review progress belong to this account and are the same on every device you sign in on. Signing
        out here does not sign out your other devices.
      </p>
      {error !== null && (
        <p role="alert" className="text-sm text-bad-ink">
          {error}
        </p>
      )}
      <button type="button" className={`${BUTTON_SECONDARY} self-start`} disabled={busy} onClick={() => void signOut()}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  );
}

function knownTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** Which calendar day counts as "today". Stored with the account, so every device agrees. */
export function TimeZoneSection() {
  const { api, vocabulary, session, toasts } = useApp();
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    api
      .fetchSettings()
      .then((loaded) => {
        if (!current) return;
        setSettings(loaded);
        setChoice(loaded.timeZone);
      })
      .catch((cause: unknown) => {
        if (current) setError(messageOf(cause, 'Could not load your time zone.'));
      });
    return () => {
      current = false;
    };
  }, [api]);

  const zones = useMemo(() => {
    const all = new Set(['UTC', ...knownTimeZones()]);
    if (settings !== null) all.add(settings.timeZone);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [settings]);

  if (settings !== null && !settings.timeZoneEditable) return null;

  const save = async () => {
    if (settings === null || saving || choice === settings.timeZone) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveSettings({ timeZone: choice });
      setSettings(saved);
      setChoice(saved.timeZone);
      // "Today" may have moved, and with it what is due.
      void vocabulary.reload();
      void session.load();
      toasts.show({ message: `Time zone set to ${saved.timeZone}.` });
    } catch (cause) {
      setError(messageOf(cause, 'Could not save the time zone.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`}>
      <h2 className={SECTION_TITLE}>Time zone</h2>
      <p className={HELP}>
        Decides which calendar day counts as “today” for due dates. It is saved with your account, so every device
        uses the same one.
      </p>
      {settings === null ? (
        <p role={error === null ? 'status' : 'alert'} className="text-sm text-muted">
          {error ?? 'Loading…'}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm font-medium sm:max-w-xs">
              Your time zone
              <select className={INPUT} value={choice} disabled={saving} onChange={(event) => setChoice(event.target.value)}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={saving || choice === settings.timeZone}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save time zone'}
            </button>
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-bad-ink">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Deleted words. Deleting only ever moves a word here, so nothing is lost by accident. */
export function TrashSection() {
  const { api, vocabulary, toasts } = useApp();
  const [entries, setEntries] = useState<VocabularyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    api
      .fetchTrash()
      .then((loaded) => {
        if (!current) return;
        setEntries(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (current) setError(messageOf(cause, 'Could not load deleted words.'));
      });
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const restore = async (entry: VocabularyEntry) => {
    if (restoring !== null) return;
    setRestoring(entry.id);
    setError(null);
    try {
      const restored = await api.restoreEntry(entry.id);
      vocabulary.upsert(restored);
      setEntries((list) => (list ?? []).filter((item) => item.id !== entry.id));
      toasts.show({ message: `Restored “${restored.word}”.` });
    } catch (cause) {
      setError(messageOf(cause, 'Could not restore the word.'));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className={SECTION_TITLE}>Deleted words</h2>
        <button type="button" className={BUTTON_SECONDARY} onClick={() => setAttempt((count) => count + 1)}>
          Refresh
        </button>
      </div>
      <p className={HELP}>A deleted word keeps its mastery and dates, and comes back exactly as it was.</p>
      {error !== null && (
        <p role="alert" className="text-sm text-bad-ink">
          {error}
        </p>
      )}
      {entries === null ? (
        error === null && (
          <p role="status" className="text-sm text-muted">
            Loading…
          </p>
        )
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted">Nothing has been deleted.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{entry.word}</span>
                {entry.meaning !== null && <span className="block truncate text-xs text-muted">{entry.meaning}</span>}
              </span>
              <MasteryPill mastery={entry.mastery} />
              <button
                type="button"
                className={BUTTON_SECONDARY}
                disabled={restoring !== null}
                aria-label={`Restore ${entry.word}`}
                onClick={() => void restore(entry)}
              >
                {restoring === entry.id ? 'Restoring…' : 'Restore'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
