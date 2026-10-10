import { useMemo } from 'react';
import { isIsoDate } from '../../shared/dates.js';
import { addMonths, countByDateAdded, isMonth, monthGrid } from '../../shared/metrics.js';
import { useVocabulary } from '../app-context.js';
import { MasteryPill, StatusBadge, formatDate } from '../components/badges.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_SECONDARY, CARD, PAGE, SECTION_TITLE } from '../components/ui.js';
import { ROUTES, buildHref, navigate, openWord, useLocation } from '../lib/router.js';

const WEEKDAYS = [
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
] as const;

const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Intensity step for a day's count. The count itself is always printed as well. */
export function heatLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

const LEGEND: Array<[level: 1 | 2 | 3 | 4, label: string]> = [
  [1, '1'],
  [2, '2–3'],
  [3, '4–6'],
  [4, '7+'],
];

/** Words by the day they were added. A history of additions, not a review schedule. */
export function CalendarPage() {
  const state = useVocabulary();
  const location = useLocation();
  const today = state.meta?.today ?? null;

  const requestedMonth = location.query.get('month');
  const requestedDate = location.query.get('date');
  const selected = requestedDate !== null && isIsoDate(requestedDate) ? requestedDate : null;
  const month = isMonth(requestedMonth) ? requestedMonth : (selected ?? today ?? '1970-01-01').slice(0, 7);

  const counts = useMemo(() => countByDateAdded(state.entries), [state.entries]);
  const weeks = useMemo(() => monthGrid(month), [month]);
  const undated = useMemo(() => state.entries.filter((entry) => entry.dateAdded === null), [state.entries]);
  const monthTotal = useMemo(
    () => weeks.flat().reduce((sum, day) => sum + (day.inMonth ? (counts.get(day.date) ?? 0) : 0), 0),
    [weeks, counts],
  );
  const wordsOnSelected = useMemo(
    () =>
      selected === null
        ? []
        : state.entries
            .filter((entry) => entry.dateAdded === selected)
            .sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' })),
    [state.entries, selected],
  );

  const go = (params: { month: string; date: string | null }) =>
    navigate(buildHref(ROUTES.calendar, { month: params.month, date: params.date }));

  return (
    <div className={PAGE}>
      <PageHeader title="Calendar" description="Words by the day they were added." />

      <VocabularyGate state={state}>
        {today !== null && (
          <div className={`grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] ${state.refreshing ? 'opacity-70' : ''}`}>
            <section className={`${CARD} p-4`} aria-label="Month">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-serif text-xl font-semibold" aria-live="polite">
                  {monthTitle.format(new Date(`${month}-01T00:00:00Z`))}
                </h2>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label="Previous month"
                    className={`${BUTTON_SECONDARY} w-10 px-0`}
                    onClick={() => go({ month: addMonths(month, -1), date: null })}
                  >
                    <Icon name="left" className="size-4" />
                  </button>
                  <button
                    type="button"
                    className={BUTTON_SECONDARY}
                    onClick={() => go({ month: today.slice(0, 7), date: today })}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    aria-label="Next month"
                    className={`${BUTTON_SECONDARY} w-10 px-0`}
                    onClick={() => go({ month: addMonths(month, 1), date: null })}
                  >
                    <Icon name="right" className="size-4" />
                  </button>
                </div>
              </div>

              <table className="w-full table-fixed border-separate border-spacing-1">
                <caption className="sr-only">
                  Words added each day of {monthTitle.format(new Date(`${month}-01T00:00:00Z`))}
                </caption>
                <thead>
                  <tr>
                    {WEEKDAYS.map(([short, full]) => (
                      <th key={short} scope="col" className="pb-1 text-center text-xs font-medium text-muted">
                        <abbr title={full} className="no-underline">
                          {short}
                        </abbr>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {weeks.map((week) => (
                    <tr key={week[0]?.date}>
                      {week.map((day) => {
                        const count = counts.get(day.date) ?? 0;
                        const level = heatLevel(count);
                        const isSelected = day.date === selected;
                        const isToday = day.date === today;
                        return (
                          <td key={day.date} className="p-0">
                            <button
                              type="button"
                              onClick={() => go({ month: day.date.slice(0, 7), date: day.date })}
                              aria-pressed={isSelected}
                              aria-label={`${formatDate(day.date)}: ${count === 0 ? 'no words added' : `${count} ${count === 1 ? 'word' : 'words'} added`}${isToday ? ' (today)' : ''}`}
                              data-level={level}
                              className={`heat-cell flex aspect-square w-full cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl border text-sm ${
                                isSelected ? 'border-ink ring-2 ring-ink' : 'border-transparent hover:border-muted'
                              } ${day.inMonth ? '' : 'opacity-40'}`}
                            >
                              <span className={isToday ? 'font-bold underline underline-offset-4' : ''}>
                                {Number(day.date.slice(8))}
                              </span>
                              <span className="h-4 text-xs font-semibold leading-4 tabular-nums">
                                {count > 0 ? count : ''}
                              </span>
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
                <p>
                  {monthTotal} {monthTotal === 1 ? 'word' : 'words'} added this month.
                </p>
                <div className="flex items-center gap-2" aria-label="Legend: words added per day">
                  <span>Words added</span>
                  {LEGEND.map(([level, label]) => (
                    <span key={level} className="flex items-center gap-1">
                      <span data-level={level} className="heat-cell size-4 rounded" aria-hidden="true" />
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              {undated.length > 0 && (
                <p className="mt-3 text-xs text-muted">
                  {undated.length} {undated.length === 1 ? 'word has' : 'words have'} no Date Added and{' '}
                  {undated.length === 1 ? 'is' : 'are'} not placed on the calendar.
                </p>
              )}
            </section>

            <section className={`${CARD} p-4`} aria-live="polite">
              {selected === null ? (
                <>
                  <h2 className={SECTION_TITLE}>Pick a day</h2>
                  <p className="mt-2 text-sm text-muted">Select a date to see the words added on it.</p>
                </>
              ) : (
                <>
                  <h2 className={SECTION_TITLE}>{formatDate(selected)}</h2>
                  <p className="mt-1 text-sm text-muted">
                    {wordsOnSelected.length === 0
                      ? 'No words were added on this day.'
                      : `${wordsOnSelected.length} ${wordsOnSelected.length === 1 ? 'word' : 'words'} added.`}
                  </p>
                  {wordsOnSelected.length > 0 && (
                    <>
                      <ul className="m-0 mt-3 flex list-none flex-col divide-y divide-line p-0">
                        {wordsOnSelected.map((entry) => (
                          <li key={entry.id}>
                            <button
                              type="button"
                              onClick={() => openWord(entry.id)}
                              className="flex w-full cursor-pointer items-center gap-2 py-2 text-left hover:bg-line/20"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{entry.word}</span>
                                <span className="block truncate text-xs text-muted">{entry.meaning ?? entry.definition ?? '—'}</span>
                              </span>
                              <MasteryPill mastery={entry.mastery} />
                            </button>
                            <span className="sr-only">
                              <StatusBadge status={entry.reviewStatus} />
                            </span>
                          </li>
                        ))}
                      </ul>
                      <Link
                        to={buildHref(ROUTES.bank, { from: selected, to: selected })}
                        className={`${BUTTON_SECONDARY} mt-3 w-full`}
                      >
                        Open these in the bank
                      </Link>
                    </>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </VocabularyGate>
    </div>
  );
}
