import { useState } from 'react';
import { useApp, useSettings, useVocabulary } from '../app-context.js';
import { AccountSection, DatabaseStatus, TimeZoneSection, TrashSection } from '../components/AccountSettings.js';
import { GoalSection } from '../components/GoalSection.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { SchedulerSection } from '../components/SchedulerSection.js';
import { SkippedNotice } from '../components/SkippedNotice.js';
import { BUTTON_SECONDARY, CARD, HELP, INPUT, PAGE, SECTION_TITLE } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';
import { sortEntries } from '../lib/bank-query.js';
import { downloadFile, toCsv, toJson } from '../lib/export.js';
import { ROUTES } from '../lib/router.js';
import type { Settings, SortKey } from '../lib/settings.js';

const SORT_LABELS: Record<SortKey, string> = {
  word: 'Word',
  dateAdded: 'Date added',
  reviewDate: 'Review date',
  mastery: 'Mastery',
};

const SOURCE_TEXT = {
  supabase: 'Your account (Supabase)',
  mock: 'Built-in sample data (not your own words)',
} as const;

const SAVING_TEXT = {
  supabase: 'On: reviews, new words and edits are saved to your account',
  mock: 'On, in memory only: nothing is kept after the server stops',
} as const;

export function SettingsPage() {
  const { api, settings: store, vocabulary, account } = useApp();
  const settings = useSettings();
  const state = useVocabulary();
  const { meta, entries } = state;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => store.update({ [key]: value });
  const exportName = `vocabulary-${meta?.today ?? 'export'}`;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportEverything = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const everything = await api.fetchExport();
      downloadFile(`vocabulary-everything-${meta?.today ?? 'export'}.json`, 'application/json', JSON.stringify(everything, null, 2));
    } catch (cause) {
      setExportError(cause instanceof ApiError ? cause.message : 'The export could not be prepared.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={PAGE}>
      <PageHeader
        title="Settings"
        description={
          account === null
            ? 'Preferences are kept in this browser only.'
            : 'Display and review preferences are kept in this browser; your words, time zone and daily goal are kept in your account.'
        }
      />

      <div className="flex max-w-2xl flex-col gap-6">
        {account !== null && <AccountSection account={account} />}
        {account !== null && <TimeZoneSection />}
        <SchedulerSection />
        <GoalSection />

        <section className={`${CARD} flex flex-col gap-4 p-5`}>
          <h2 className={SECTION_TITLE}>Review</h2>
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={settings.askConfidence}
              onChange={(event) => set('askConfidence', event.target.checked)}
            />
            <span>
              <span className="font-medium">Ask how sure I am before showing the answer</span>
              <span className={`block ${HELP}`}>
                Three buttons appear under each card (keys 1, 2 and 3). Your rating is saved beside your answer, and
                Insights then shows how well your confidence matches your results. It never changes what an answer
                does, and you can skip it by simply flipping the card.
              </span>
            </span>
          </label>
          <div className="flex flex-col gap-1.5 sm:max-w-sm">
            <label htmlFor="answer-keys" className="text-sm font-medium">
              Extra answer keys
            </label>
            <select
              id="answer-keys"
              className={INPUT}
              value={settings.answerKeys}
              aria-describedby="answer-keys-help"
              onChange={(event) => set('answerKeys', event.target.value as Settings['answerKeys'])}
            >
              <option value="none">None (arrow keys only)</option>
              <option value="jk">J = Not remember, K = Remember</option>
              <option value="fj">F = Not remember, J = Remember</option>
              <option value="numbers">1 = Not remember, 2 = Remember</option>
            </select>
            <p id="answer-keys-help" className={HELP}>
              The arrow keys always work. Press ? during a review to see every shortcut.
            </p>
          </div>
        </section>

        <section className={`${CARD} flex flex-col gap-4 p-5`}>
          <h2 className={SECTION_TITLE}>Vocabulary bank</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Default view
              <select
                className={INPUT}
                value={settings.bankView}
                onChange={(event) => set('bankView', event.target.value as Settings['bankView'])}
              >
                <option value="table">Table</option>
                <option value="list">Compact list</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Words per page
              <select
                className={INPUT}
                value={settings.bankPageSize}
                onChange={(event) => set('bankPageSize', Number(event.target.value) as Settings['bankPageSize'])}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Default sort
              <select
                className={INPUT}
                value={settings.bankSort}
                onChange={(event) => set('bankSort', event.target.value as SortKey)}
              >
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                  <option key={key} value={key}>
                    {SORT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Default direction
              <select
                className={INPUT}
                value={settings.bankDirection}
                onChange={(event) => set('bankDirection', event.target.value as Settings['bankDirection'])}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
          </div>
        </section>

        <section className={`${CARD} flex flex-col gap-4 p-5`}>
          <h2 className={SECTION_TITLE}>Display</h2>
          <label className="flex flex-col gap-1.5 text-sm font-medium sm:max-w-xs">
            Dashboard additions chart
            <select
              className={INPUT}
              value={settings.dashboardDays}
              onChange={(event) => set('dashboardDays', Number(event.target.value) as Settings['dashboardDays'])}
            >
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={settings.reduceMotion}
              onChange={(event) => set('reduceMotion', event.target.checked)}
            />
            <span>
              <span className="font-medium">Reduce motion</span>
              <span className={`block ${HELP}`}>
                Turns off the card flip and other animations. Your system setting for reduced motion is always
                respected as well.
              </span>
            </span>
          </label>
          <button type="button" className={`${BUTTON_SECONDARY} self-start`} onClick={() => store.reset()}>
            Reset preferences
          </button>
        </section>

        <section className={`${CARD} flex flex-col gap-3 p-5`}>
          <h2 className={SECTION_TITLE}>Backup</h2>
          <p className="text-sm text-muted">
            Download every word with its meaning, definition, example, mastery and dates. Exporting only reads; it
            never changes anything.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={entries.length === 0}
              onClick={() => downloadFile(`${exportName}.csv`, 'text/csv;charset=utf-8', toCsv(sortEntries(entries, 'word', 'asc')))}
            >
              Export CSV
            </button>
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={entries.length === 0}
              onClick={() =>
                downloadFile(`${exportName}.json`, 'application/json', toJson(sortEntries(entries, 'word', 'asc'), new Date().toISOString()))
              }
            >
              Export JSON
            </button>
          </div>
          {state.status !== 'ready' && <p className={HELP}>Your vocabulary is still loading.</p>}

          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <p className="text-sm text-muted">
              Or download everything in your account in one file: every word (the trash included), its schedule, your
              collections, further examples and links, your settings, and the whole review history.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={BUTTON_SECONDARY} disabled={exporting} onClick={() => void exportEverything()}>
                {exporting ? 'Preparing…' : 'Export everything (JSON)'}
              </button>
              <Link to={ROUTES.import} className="text-sm font-medium text-accent hover:underline">
                Import a list of words
              </Link>
            </div>
            {exportError !== null && (
              <p role="alert" className="text-sm text-bad-ink">
                {exportError}
              </p>
            )}
            <p className={HELP}>
              This is a copy for you to keep. It is not a database backup, and the app cannot rebuild review history
              from it; importing it back adds its words as new words only.
            </p>
          </div>
        </section>

        <section className={`${CARD} flex flex-col gap-3 p-5`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className={SECTION_TITLE}>Connection</h2>
            <button type="button" className={BUTTON_SECONDARY} onClick={() => void vocabulary.reload()} disabled={state.refreshing}>
              {state.refreshing ? 'Checking…' : 'Check again'}
            </button>
          </div>
          {meta === null ? (
            <p role={state.status === 'error' ? 'alert' : undefined} className="text-sm text-muted">
              {state.status === 'error' ? state.error?.message : 'Checking the connection…'}
            </p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted">Data source</dt>
              <dd className="m-0">{SOURCE_TEXT[meta.mode]}</dd>
              <dt className="text-muted">Saving</dt>
              <dd className="m-0">{!meta.writesEnabled ? 'Off: read-only' : SAVING_TEXT[meta.mode]}</dd>
              {account !== null && <DatabaseStatus />}
              {meta.mode === 'supabase' && (
                <>
                  <dt className="text-muted">Other devices</dt>
                  <dd className="m-0">
                    Changes made elsewhere appear when a page re-reads your words: on opening it, on returning to this
                    tab, or with Check again. They do not appear instantly.
                  </dd>
                </>
              )}
              <dt className="text-muted">Words</dt>
              <dd className="m-0 tabular-nums">{entries.length}</dd>
              <dt className="text-muted">Today</dt>
              <dd className="m-0">
                {meta.today} <span className="text-muted">({meta.timeZone})</span>
              </dd>
              <dt className="text-muted">New words start at</dt>
              <dd className="m-0">
                Mastery {meta.defaults.mastery},{' '}
                {meta.defaults.reviewDate === 'today' ? 'review date today' : 'no review date (due right away)'}
              </dd>
            </dl>
          )}
          {meta !== null && <SkippedNotice skipped={meta.skipped} />}
        </section>

        {meta !== null && <TrashSection />}
      </div>
    </div>
  );
}
