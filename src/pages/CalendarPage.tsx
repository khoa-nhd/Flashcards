import { useEffect, useMemo, useState } from 'react';
import type { ReviewDaysResponse } from '../../shared/api.js';
import { isIsoDate, type IsoDate } from '../../shared/dates.js';
import { addMonths, countByDateAdded, isMonth, monthGrid } from '../../shared/metrics.js';
import { useApp, useVocabulary } from '../app-context.js';
import { MasteryPill, StatusBadge, formatDate } from '../components/badges.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_SECONDARY, CARD, HELP, PAGE, SECTION_TITLE } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';
import { count as countOf } from '../lib/format.js';
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

type Level = 0 | 1 | 2 | 3 | 4;

/** Intensity step for a day's count of words added. The count itself is always printed as well. */
export function heatLevel(count: number): Level {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

/** The same for reviews, which come by the dozen rather than one or two at a time. */
export function reviewHeatLevel(count: number): Level {
  if (count <= 0) return 0;
  if (count < 10) return 1;
  if (count < 25) return 2;
  if (count < 50) return 3;
  return 4;
}

type Legend = Array<[level: 1 | 2 | 3 | 4, label: string]>;

const VIEWS = {
  additions: {
    label: 'Words added',
    description: 'Words by the day they were added.',
    level: heatLevel,
    legend: [
      [1, '1'],
      [2, '2–3'],
      [3, '4–6'],
      [4, '7+'],
    ] as Legend,
    legendLabel: 'Legend: words added per day',
    cell: (count: number) => (count === 0 ? 'no words added' : `${countOf(count, 'word')} added`),
  },
  reviews: {
    label: 'Reviews',
    description: 'Your saved reviews by the day you did them.',
    level: reviewHeatLevel,
    legend: [
      [1, '1–9'],
      [2, '10–24'],
      [3, '25–49'],
      [4, '50+'],
    ] as Legend,
    legendLabel: 'Legend: reviews per day',
    cell: (count: number) => (count === 0 ? 'no reviews' : countOf(count, 'review')),
  },
} as const;

type View = keyof typeof VIEWS;
type ReviewDay = ReviewDaysResponse['days'][number];

type Loaded =
  | { key: string; days: Map<IsoDate, ReviewDay>; available: boolean; error: null }
  | { key: string; days: null; available: false; error: string };

/** Saved reviews per day for a range, loaded only while the range is wanted. */
function useReviewDays(from: IsoDate | null, to: IsoDate | null) {
  const { api } = useApp();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = from === null || to === null ? null : `${from} ${to} ${attempt}`;

  useEffect(() => {
    if (from === null || to === null || key === null) return;
    let current = true;
    api.fetchReviewDays(from, to).then(
      (response) => {
        if (!current) return;
        setLoaded({
          key,
          days: new Map(response.days.map((day) => [day.date, day])),
          available: response.available,
          error: null,
        });
      },
      (cause: unknown) => {
        if (!current) return;
        const error = cause instanceof ApiError ? cause.message : 'Could not load the reviews for this month.';
        setLoaded({ key, days: null, available: false, error });
      },
    );
    return () => {
      current = false;
    };
  }, [api, from, to, key]);

  const result = loaded !== null && loaded.key === key ? loaded : null;
  return { loading: key !== null && result === null, result, retry: () => setAttempt((tries) => tries + 1) };
}

/** A month at a glance: the words added on each day, or the reviews saved on it. */
export function CalendarPage() {
  const state = useVocabulary();
  const location = useLocation();
  const today = state.meta?.today ?? null;

  const requestedMonth = location.query.get('month');
  const requestedDate = location.query.get('date');
  const view: View = location.query.get('view') === 'reviews' ? 'reviews' : 'additions';
  const showing = VIEWS[view];
  const selected = requestedDate !== null && isIsoDate(requestedDate) ? requestedDate : null;
  const month = isMonth(requestedMonth) ? requestedMonth : (selected ?? today ?? '1970-01-01').slice(0, 7);

  const added = useMemo(() => countByDateAdded(state.entries), [state.entries]);
  const weeks = useMemo(() => monthGrid(month), [month]);
  const undated = useMemo(() => state.entries.filter((entry) => entry.dateAdded === null), [state.entries]);
  const wordsOnSelected = useMemo(
    () =>
      selected === null
        ? []
        : state.entries
            .filter((entry) => entry.dateAdded === selected)
            .sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' })),
    [state.entries, selected],
  );

  // The whole grid, so the days of the neighbouring months that show are counted too.
  const first = weeks[0]?.[0]?.date ?? null;
  const last = weeks.at(-1)?.at(-1)?.date ?? null;
  const reviewing = view === 'reviews' && today !== null;
  const reviews = useReviewDays(reviewing ? first : null, reviewing ? last : null);

  const countOn = (date: IsoDate): number =>
    view === 'additions' ? (added.get(date) ?? 0) : (reviews.result?.days?.get(date)?.reviews ?? 0);
  const monthTotal = weeks.flat().reduce((sum, day) => sum + (day.inMonth ? countOn(day.date) : 0), 0);
  const reviewedOnSelected = selected === null ? null : (reviews.result?.days?.get(selected) ?? null);

  const go = (params: { month: string; date: string | null; view?: View }) =>
    navigate(
      buildHref(ROUTES.calendar, {
        month: params.month,
        date: params.date,
        view: (params.view ?? view) === 'reviews' ? 'reviews' : null,
      }),
    );

  return (
    <div className={PAGE}>
      <PageHeader title="Calendar" description={showing.description} />

      <VocabularyGate state={state}>
        {today !== null && (
          <div className={`grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] ${state.refreshing ? 'opacity-70' : ''}`}>
            <section className={`${CARD} p-4`} aria-label="Month">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-serif text-xl font-semibold" aria-live="polite">
                  {monthTitle.format(new Date(`${month}-01T00:00:00Z`))}
                </h2>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1" role="group" aria-label="Show on the calendar">
                    {(Object.keys(VIEWS) as View[]).map((key) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={view === key}
                        onClick={() => go({ month, date: selected, view: key })}
                        className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium ${
                          view === key
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-line bg-surface text-muted hover:text-ink'
                        }`}
                      >
                        {VIEWS[key].label}
                      </button>
                    ))}
                  </div>
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
              </div>

              {view === 'reviews' && reviews.result?.error != null && (
                <p role="alert" className="mb-3 flex flex-wrap items-center gap-3 text-sm text-bad-ink">
                  {reviews.result.error}
                  <button type="button" className={BUTTON_SECONDARY} onClick={reviews.retry}>
                    Try again
                  </button>
                </p>
              )}
              {view === 'reviews' && reviews.result !== null && reviews.result.error === null && !reviews.result.available && (
                <p className="mb-3 text-sm text-muted">
                  Reviews per day cannot be shown yet: the database needs its latest update.
                </p>
              )}

              <table
                className={`w-full table-fixed border-separate border-spacing-1 ${reviews.loading ? 'opacity-60' : ''}`}
                aria-busy={reviews.loading}
              >
                <caption className="sr-only">
                  {view === 'additions' ? 'Words added' : 'Reviews saved'} each day of{' '}
                  {monthTitle.format(new Date(`${month}-01T00:00:00Z`))}
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
                        const count = countOn(day.date);
                        const isSelected = day.date === selected;
                        const isToday = day.date === today;
                        return (
                          <td key={day.date} className="p-0">
                            <button
                              type="button"
                              onClick={() => go({ month: day.date.slice(0, 7), date: day.date })}
                              aria-pressed={isSelected}
                              aria-label={`${formatDate(day.date)}: ${showing.cell(count)}${isToday ? ' (today)' : ''}`}
                              data-level={showing.level(count)}
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
                  {view === 'additions'
                    ? `${countOf(monthTotal, 'word')} added this month.`
                    : reviews.loading
                      ? 'Loading the reviews for this month…'
                      : `${countOf(monthTotal, 'review')} saved this month.`}
                </p>
                <div className="flex items-center gap-2" aria-label={showing.legendLabel}>
                  <span>{showing.label}</span>
                  {showing.legend.map(([level, label]) => (
                    <span key={level} className="flex items-center gap-1">
                      <span data-level={level} className="heat-cell size-4 rounded" aria-hidden="true" />
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              {view === 'additions' && undated.length > 0 && (
                <p className="mt-3 text-xs text-muted">
                  {undated.length} {undated.length === 1 ? 'word has' : 'words have'} no Date Added and{' '}
                  {undated.length === 1 ? 'is' : 'are'} not placed on the calendar.
                </p>
              )}
              {view === 'reviews' && (
                <p className={`${HELP} mt-3`}>
                  Counted on the day you answered, in your time zone. Answers taken back with Undo are not counted, and
                  practice is not included.
                </p>
              )}
            </section>

            <section className={`${CARD} p-4`} aria-live="polite">
              {selected === null ? (
                <>
                  <h2 className={SECTION_TITLE}>Pick a day</h2>
                  <p className="mt-2 text-sm text-muted">
                    {view === 'additions'
                      ? 'Select a date to see the words added on it.'
                      : 'Select a date to see how its reviews went.'}
                  </p>
                </>
              ) : view === 'reviews' ? (
                <>
                  <h2 className={SECTION_TITLE}>{formatDate(selected)}</h2>
                  <p className="mt-1 text-sm text-muted">
                    {reviews.loading
                      ? 'Loading…'
                      : reviews.result?.error != null
                        ? 'The reviews for this day could not be loaded.'
                        : reviewedOnSelected === null
                          ? 'No reviews were saved on this day.'
                          : `${countOf(reviewedOnSelected.reviews, 'review')} saved: ${reviewedOnSelected.remembered} remembered, ${
                              reviewedOnSelected.reviews - reviewedOnSelected.remembered
                            } not remembered.`}
                  </p>
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
                              className="flex w-full cursor-pointer items-center gap-2 py-2 text-left hover:bg-line-strong/30"
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
