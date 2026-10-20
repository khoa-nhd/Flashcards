import { useMemo } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import type { IsoDate } from '../../shared/dates.js';
import { useApp, useLibrary, useSettings, useVocabulary } from '../app-context.js';
import { MasteryPill, QualityFlag, StatusBadge, formatDate, relativeDay } from '../components/badges.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, INPUT, PAGE } from '../components/ui.js';
import {
  BANK_PRESETS,
  MISSING_LABELS,
  STATUS_FILTERS,
  STATUS_LABELS,
  activePreset,
  bankQueryParams,
  defaultSortDirection,
  filterEntries,
  hasActiveFilters,
  paginate,
  parseBankQuery,
  sortEntries,
  type BankQuery,
} from '../lib/bank-query.js';
import { downloadFile, toCsv, toJson } from '../lib/export.js';
import { ROUTES, buildHref, navigate, openWord, useLocation } from '../lib/router.js';
import type { SortKey } from '../lib/settings.js';
import { useTrueMastery, type TrueMasteryEntry } from '../hooks/useTrueMastery.js';

const SORT_LABELS: Record<SortKey, string> = {
  word: 'Word',
  dateAdded: 'Date added',
  reviewDate: 'Review date',
  mastery: 'Mastery',
  trueMastery: 'True Mastery',
};

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[value: string, label: string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-faint">
      {label}
      <select className={INPUT} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

interface BankTableProps {
  entries: VocabularyEntry[];
  today: IsoDate | null;
  query: BankQuery;
  onSort: (key: SortKey) => void;
  trueMasteryMap: Map<string, TrueMasteryEntry>;
}

function BankTable({
  entries,
  today,
  query,
  onSort,
  trueMasteryMap,
}: BankTableProps) {
  const header = (key: SortKey, className = '', title?: string) => {
    const active = query.sort === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (query.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
        title={title}
        className={`px-3 py-2.5 font-medium ${className}`}
      >
        <button
          type="button"
          onClick={() => onSort(key)}
          className={`inline-flex cursor-pointer items-center gap-1 ${active ? 'text-ink' : 'hover:text-ink'}`}
        >
          {SORT_LABELS[key]}
          <span aria-hidden="true" className={active ? '' : 'opacity-0'}>
            {query.direction === 'asc' ? '↑' : '↓'}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-[0.6875rem] uppercase tracking-[0.12em] text-faint">
          <tr>
            {header('word')}
            <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">
              Meaning
            </th>
            {header('mastery', 'w-24')}
            {header(
              'trueMastery',
              'w-32',
              'True Mastery is an evidence-based estimate (0–100) of how well you know a word, from your practice history across modes. It is separate from Review Mastery, which drives the schedule.',
            )}
            {header('reviewDate', 'w-40')}
            {header('dateAdded', 'hidden w-32 xl:table-cell')}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const trueMastery = trueMasteryMap.get(entry.id);
            return (
              <tr
                key={entry.id}
                onClick={() => openWord(entry.id)}
                className="cursor-pointer border-t border-line transition-colors first:border-t-0 hover:bg-line-strong/40"
              >
                <th scope="row" className="max-w-56 px-3 py-2.5 text-left font-medium">
                  <span className="flex items-center gap-2">
                    {/* The row is clickable for the mouse; this button is the keyboard and screen-reader route. */}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        openWord(entry.id);
                      }}
                      className="cursor-pointer truncate text-left font-serif text-[1.0625rem] font-medium hover:underline"
                    >
                      {entry.word}
                    </button>
                    <QualityFlag entry={entry} />
                  </span>
                </th>
                <td className="hidden max-w-xs px-3 py-2.5 text-muted lg:table-cell">
                  <span className="line-clamp-1">{entry.meaning ?? entry.definition ?? '—'}</span>
                </td>
                <td className="px-3 py-2.5">
                  <MasteryPill mastery={entry.mastery} />
                </td>
                <td className="px-3 py-2.5">
                  {trueMastery && trueMastery.mastery !== null && (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          trueMastery.tier === 'Excellent'
                            ? 'bg-good-soft text-good-ink'
                            : trueMastery.tier === 'Strong'
                            ? 'bg-accent-soft text-accent'
                            : trueMastery.tier === 'Good'
                            ? 'bg-accent-soft text-accent'
                            : trueMastery.tier === 'Developing'
                            ? 'bg-warn-soft text-warn-ink'
                            : trueMastery.tier === 'Weak'
                            ? 'bg-bad-soft text-bad-ink'
                            : 'bg-line-strong/60 text-muted'
                        }`}
                        title={
                          `True Mastery: ${trueMastery.mastery}/100 (${trueMastery.tier})\n` +
                          `Evidence: ${trueMastery.coverageLabel} (${trueMastery.totalEffectiveEvidence.toFixed(1)} effective evidence across ${trueMastery.modesWithEvidence} mode${trueMastery.modesWithEvidence === 1 ? '' : 's'})\n` +
                          (trueMastery.modeStats?.length > 0
                            ? trueMastery.modeStats
                                .filter(s => s.total > 0)
                                .map(s => `${s.mode}: ${s.correct}/${s.total} correct (${Math.round(s.accuracy * 100)}%), ${s.effectiveEvidence.toFixed(1)} evidence`)
                                .join('\n')
                            : '')
                        }
                      >
                        {trueMastery.tier} ({trueMastery.mastery})
                      </span>
                      <span className="text-xs text-muted" title={trueMastery.coverageLabel}>
                        {trueMastery.coverageLabel}
                      </span>
                    </span>
                  )}
                  {trueMastery && trueMastery.mastery === null && (
                    <span className="text-xs text-muted" title={trueMastery.coverageLabel}>
                      {trueMastery.coverageLabel}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StatusBadge status={entry.reviewStatus} />
                    {entry.reviewDate !== null && entry.reviewStatus !== 'mastered' && (
                      <span className="whitespace-nowrap text-xs text-muted">{relativeDay(entry.reviewDate, today)}</span>
                    )}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2.5 text-muted xl:table-cell">
                  {formatDate(entry.dateAdded, 'short')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface BankListProps {
  entries: VocabularyEntry[];
  today: IsoDate | null;
  trueMasteryMap: Map<string, TrueMasteryEntry>;
}

function BankList({ entries, today, trueMasteryMap }: BankListProps) {
  return (
    <ul className={`${CARD} m-0 flex list-none flex-col divide-y divide-line p-0`}>
      {entries.map((entry) => {
        const trueMastery = trueMasteryMap.get(entry.id);
        return (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => openWord(entry.id)}
              className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-line-strong/40"
            >
              <MasteryPill mastery={entry.mastery} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-serif text-[1.0625rem] font-medium">{entry.word}</span>
                {entry.meaning !== null && <span className="text-muted"> — {entry.meaning}</span>}
              </span>
              <QualityFlag entry={entry} />
              {trueMastery && trueMastery.mastery !== null && (
                <span className="shrink-0 flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      trueMastery.tier === 'Excellent'
                        ? 'bg-good-soft text-good-ink'
                        : trueMastery.tier === 'Strong'
                        ? 'bg-accent-soft text-accent'
                        : trueMastery.tier === 'Good'
                        ? 'bg-accent-soft text-accent'
                        : trueMastery.tier === 'Developing'
                        ? 'bg-warn-soft text-warn-ink'
                        : trueMastery.tier === 'Weak'
                        ? 'bg-bad-soft text-bad-ink'
                        : 'bg-line-strong/60 text-muted'
                    }`}
                    title={
                      `True Mastery: ${trueMastery.mastery}/100 (${trueMastery.tier})\n` +
                      `Evidence: ${trueMastery.coverageLabel} (${trueMastery.totalEffectiveEvidence.toFixed(1)} effective evidence across ${trueMastery.modesWithEvidence} mode${trueMastery.modesWithEvidence === 1 ? '' : 's'})\n` +
                      (trueMastery.modeStats?.length > 0
                        ? trueMastery.modeStats
                            .filter(s => s.total > 0)
                            .map(s => `${s.mode}: ${s.correct}/${s.total} correct (${Math.round(s.accuracy * 100)}%), ${s.effectiveEvidence.toFixed(1)} evidence`)
                            .join('\n')
                        : '')
                    }
                  >
                    {trueMastery.tier} ({trueMastery.mastery})
                  </span>
                  <span className="text-xs text-muted" title={trueMastery.coverageLabel}>
                    {trueMastery.coverageLabel}
                  </span>
                </span>
              )}
              {trueMastery && trueMastery.mastery === null && (
                <span className="shrink-0 flex items-center gap-2">
                  <span className="text-xs text-muted" title={trueMastery.coverageLabel}>
                    {trueMastery.coverageLabel}
                  </span>
                </span>
              )}
              <span className="shrink-0 text-xs text-muted">
                {entry.reviewStatus === 'mastered'
                  ? 'mastered'
                  : entry.reviewDate === null
                    ? 'no date'
                    : relativeDay(entry.reviewDate, today)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function BankPage() {
  const state = useVocabulary();
  const settings = useSettings();
  const { settings: settingsStore } = useApp();
  const location = useLocation();
  const defaults = useMemo(
    () => ({ sort: settings.bankSort, direction: settings.bankDirection }),
    [settings.bankSort, settings.bankDirection],
  );
  const query = useMemo(() => parseBankQuery(location.query, defaults), [location.query, defaults]);
  const today = state.meta?.today ?? null;

  // Use the True Mastery hook early so it's available for sorting
  const { trueMasteryMap } = useTrueMastery();

  // A collection narrows the bank beside its own filters. It is kept in the address like they are.
  const library = useLibrary();
  const collectionId = location.query.get('collection');
  const collection = collectionId === null ? null : (library.collections.find((item) => item.id === collectionId) ?? null);
  const members = useMemo(() => (collection === null ? null : new Set(collection.wordIds)), [collection]);

  const filtered = useMemo(() => {
    const matching = filterEntries(state.entries, query);
    // Until the collection is known (still loading, or no longer there) nothing can be said to be in it.
    return collectionId === null ? matching : matching.filter((entry) => members?.has(entry.id) ?? false);
  }, [state.entries, query, collectionId, members]);
  const filtering = hasActiveFilters(query) || collectionId !== null;
  const sorted = useMemo(() => sortEntries(filtered, query.sort, query.direction, trueMasteryMap), [filtered, query.sort, query.direction, trueMasteryMap]);
  const page = useMemo(() => paginate(sorted, query.page, settings.bankPageSize), [sorted, query.page, settings.bankPageSize]);

  /** Applies a change to the filters or sorting. Anything but a page change starts again at page 1. */
  const update = (patch: Partial<BankQuery>, options: { replace?: boolean; collection?: string | null } = {}) => {
    const next = { ...query, page: 1, ...patch };
    // Keep the open word, if any; everything else in the address is the bank's own state.
    const base = new URLSearchParams();
    const word = location.query.get('word');
    if (word !== null) base.set('word', word);
    const keptCollection = options.collection === undefined ? collectionId : options.collection;
    if (keptCollection !== null) base.set('collection', keptCollection);
    navigate(buildHref(ROUTES.bank, bankQueryParams(next, defaults), base), { replace: options.replace });
  };
  const NO_FILTERS = { search: '', status: null, mastery: null, addedFrom: null, addedTo: null, missing: null } as const;

  const sortBy = (key: SortKey) => {
    if (query.sort === key) update({ direction: query.direction === 'asc' ? 'desc' : 'asc' });
    // A new sort starts in its own natural direction: weakest first for mastery and review date.
    else update({ sort: key, direction: defaultSortDirection(key) });
  };

  const preset = today === null ? null : activePreset(query, today);
  const exportName = `vocabulary-${today ?? 'export'}`;

  return (
    <div className={PAGE}>
      <PageHeader
        title="Vocabulary bank"
        description={
          state.status === 'ready'
            ? `${state.entries.length} ${state.entries.length === 1 ? 'word' : 'words'} in your vocabulary.`
            : 'Every word in your vocabulary.'
        }
        actions={
          <>
            <Link to={ROUTES.add} className={BUTTON_PRIMARY}>
              <Icon name="add" className="size-4" /> Add
            </Link>
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={state.entries.length === 0}
              title="Download every word as a CSV file. Does not change anything."
              onClick={() => downloadFile(`${exportName}.csv`, 'text/csv;charset=utf-8', toCsv(sortEntries(state.entries, 'word', 'asc')))}
            >
              <Icon name="download" className="size-4" /> CSV
            </button>
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={state.entries.length === 0}
              title="Download every word as a JSON file. Does not change anything."
              onClick={() =>
                downloadFile(
                  `${exportName}.json`,
                  'application/json',
                  toJson(sortEntries(state.entries, 'word', 'asc'), new Date().toISOString()),
                )
              }
            >
              <Icon name="download" className="size-4" /> JSON
            </button>
          </>
        }
      />
      <VocabularyGate state={state}>
        {today !== null && (
          <div className={`flex flex-col gap-4 ${state.refreshing ? 'opacity-70' : ''}`}>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Quick filters">
              {BANK_PRESETS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={preset === item.key}
                  onClick={() => update({ search: '', ...item.filters(today) })}
                  className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                    preset === item.key
                      ? 'border-accent/60 bg-accent-soft text-accent'
                      : 'border-line-strong bg-transparent text-muted hover:border-muted hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className={`${CARD} flex flex-col gap-3 p-3`}>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
                  <Icon name="search" className="size-4" />
                </span>
                <input
                  type="search"
                  aria-label="Search words, meanings, definitions and examples"
                  placeholder="Search words, meanings, definitions and examples"
                  className={`${INPUT} pl-9`}
                  value={query.search}
                  // Typing refines one search; it should not fill the history with every keystroke.
                  onChange={(event) => update({ search: event.target.value }, { replace: true })}
                />
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
                <FilterSelect
                  label="Review status"
                  value={query.status ?? ''}
                  onChange={(value) => update({ status: value === '' ? null : (value as BankQuery['status']) })}
                  options={[['', 'Any status'], ...STATUS_FILTERS.map((key): [string, string] => [key, STATUS_LABELS[key]])]}
                />
                <FilterSelect
                  label="Mastery"
                  value={query.mastery === null ? '' : String(query.mastery)}
                  onChange={(value) => update({ mastery: value === '' ? null : Number(value) })}
                  options={[['', 'Any mastery'], ...Array.from({ length: 11 }, (_, level): [string, string] => [String(level), `Mastery ${level}`])]}
                />
                <FilterSelect
                  label="Completeness"
                  value={query.missing ?? ''}
                  onChange={(value) => update({ missing: value === '' ? null : (value as BankQuery['missing']) })}
                  options={[
                    ['', 'Any'],
                    ['meaning', MISSING_LABELS.meaning],
                    ['definition', MISSING_LABELS.definition],
                    ['example', MISSING_LABELS.example],
                  ]}
                />
                {(library.collections.length > 0 || collectionId !== null) && (
                  <FilterSelect
                    label="Collection"
                    value={collectionId ?? ''}
                    onChange={(value) => update({}, { collection: value === '' ? null : value })}
                    options={[
                      ['', 'Any collection'],
                      ...library.collections.map((item): [string, string] => [item.id, item.name]),
                    ]}
                  />
                )}
                <label className="flex flex-col gap-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-faint">
                  Added from
                  <input
                    type="date"
                    className={INPUT}
                    value={query.addedFrom ?? ''}
                    max={query.addedTo ?? undefined}
                    onChange={(event) => update({ addedFrom: event.target.value === '' ? null : event.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-faint">
                  Added to
                  <input
                    type="date"
                    className={INPUT}
                    value={query.addedTo ?? ''}
                    min={query.addedFrom ?? undefined}
                    onChange={(event) => update({ addedTo: event.target.value === '' ? null : event.target.value })}
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-muted" role="status">
                  {page.total === 0
                    ? 'No words match.'
                    : `Showing ${page.from}–${page.to} of ${page.total} ${page.total === 1 ? 'word' : 'words'}`}
                  {filtering && page.total > 0 && ` (filtered from ${state.entries.length})`}
                </p>
                {filtering && (
                  <button
                    type="button"
                    className="cursor-pointer text-sm font-semibold text-accent hover:underline"
                    onClick={() => update(NO_FILTERS, { collection: null })}
                  >
                    Clear filters
                  </button>
                )}

                <div className="ml-auto flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted">
                    Sort by
                    <select
                      className={`${INPUT} w-auto`}
                      value={query.sort}
                      onChange={(event) => {
                        // The same rule as a column heading: a newly chosen sort starts weakest first.
                        const key = event.target.value as SortKey;
                        update({ sort: key, direction: defaultSortDirection(key) });
                      }}
                    >
                      {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                        <option key={key} value={key}>
                          {SORT_LABELS[key]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={BUTTON_SECONDARY}
                    onClick={() => update({ direction: query.direction === 'asc' ? 'desc' : 'asc' })}
                    aria-label={`Sort direction: ${query.direction === 'asc' ? 'ascending' : 'descending'}. Switch.`}
                  >
                    {query.direction === 'asc' ? '↑ Ascending' : '↓ Descending'}
                  </button>
                  <div className="flex rounded-xl border border-line p-0.5" role="group" aria-label="View">
                    {(['table', 'list'] as const).map((view) => (
                      <button
                        key={view}
                        type="button"
                        aria-pressed={settings.bankView === view}
                        aria-label={view === 'table' ? 'Table view' : 'Compact list view'}
                        onClick={() => settingsStore.update({ bankView: view })}
                        className={`flex size-9 cursor-pointer items-center justify-center rounded-lg ${
                          settings.bankView === view ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'
                        }`}
                      >
                        <Icon name={view} className="size-4" />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div>
          {page.total === 0 ? (
            <>
              <div className={`${CARD} flex flex-col items-center gap-3 px-6 py-12 text-center`}>
                <p className="font-serif text-xl font-semibold">
                  {state.entries.length === 0 ? 'Your vocabulary is empty' : 'No words match these filters'}
                </p>
                <p className="max-w-sm text-sm text-muted">
                  {state.entries.length === 0
                    ? 'Add your first word to get started.'
                    : 'Try a different search, or clear the filters to see everything.'}
                </p>
                {state.entries.length === 0 ? (
                  <Link to={ROUTES.add} className={BUTTON_PRIMARY}>
                    Add vocabulary
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={BUTTON_SECONDARY}
                    onClick={() => update(NO_FILTERS, { collection: null })}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </>
          ) : settings.bankView === 'table' ? (
            <>
              <BankTable
                entries={page.items as VocabularyEntry[]}
                today={today}
                query={query}
                onSort={sortBy}
                trueMasteryMap={trueMasteryMap}
              />
            </>
          ) : (
            <>
              <BankList entries={page.items as VocabularyEntry[]} today={today} trueMasteryMap={trueMasteryMap} />
            </>
          )}

          {page.pageCount > 1 && (
            <nav aria-label="Pages" className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                className={BUTTON_GHOST}
                disabled={page.page <= 1}
                onClick={() => update({ page: page.page - 1 })}
              >
                <Icon name="left" className="size-4" /> Previous
              </button>
              <span className="text-sm tabular-nums text-muted">
                Page {page.page} of {page.pageCount}
              </span>
              <button
                type="button"
                className={BUTTON_GHOST}
                disabled={page.page >= page.pageCount}
                onClick={() => update({ page: page.page + 1 })}
              >
                Next <Icon name="right" className="size-4" />
              </button>
            </nav>
          )}
        </div>
      </VocabularyGate>
    </div>
  );
}