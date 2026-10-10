import { useMemo, useState } from 'react';
import {
  additionsByPeriod,
  busiestDays,
  computeSummary,
  masteryDistribution,
  type Granularity,
} from '../../shared/metrics.js';
import { useVocabulary } from '../app-context.js';
import { BarChart } from '../components/BarChart.js';
import { formatDate } from '../components/badges.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { CARD, PAGE, SECTION_TITLE } from '../components/ui.js';
import { MISSING_LABELS, missingFields } from '../lib/bank-query.js';
import { ROUTES, buildHref } from '../lib/router.js';

const RANGES: Record<Granularity, { periods: number; label: string; title: string; category: string }> = {
  day: { periods: 30, label: 'Day', title: 'Words added per day, last 30 days', category: 'Day' },
  week: { periods: 12, label: 'Week', title: 'Words added per week, last 12 weeks', category: 'Week starting' },
  month: { periods: 12, label: 'Month', title: 'Words added per month, last 12 months', category: 'Month' },
};

const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
const monthLong = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const asDate = (date: string) => new Date(`${date}T00:00:00Z`);

const percent = (part: number, whole: number) => (whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`);

export function InsightsPage() {
  const state = useVocabulary();
  const [granularity, setGranularity] = useState<Granularity>('week');
  const { entries, meta } = state;
  const today = meta?.today ?? null;

  const summary = useMemo(() => (today === null ? null : computeSummary(entries, today)), [entries, today]);
  const distribution = useMemo(() => masteryDistribution(entries), [entries]);
  const range = RANGES[granularity];
  const additions = useMemo(
    () => (today === null ? [] : additionsByPeriod(entries, granularity, range.periods, today)),
    [entries, granularity, range.periods, today],
  );
  const busiest = useMemo(() => busiestDays(entries, 5), [entries]);
  const incomplete = useMemo(() => {
    const counts = { meaning: 0, definition: 0, example: 0 };
    for (const entry of entries) for (const key of missingFields(entry)) counts[key] += 1;
    return counts;
  }, [entries]);

  return (
    <div className={PAGE}>
      <PageHeader title="Insights" description="How your vocabulary is growing and where it stands." />

      <VocabularyGate state={state}>
        {summary !== null && today !== null && (
          <div className={`flex flex-col gap-6 ${state.refreshing ? 'opacity-70' : ''}`}>
            <div className="flex items-center gap-2" role="group" aria-label="Group additions by">
              <span className="text-sm text-muted">Additions by</span>
              {(Object.keys(RANGES) as Granularity[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={granularity === key}
                  onClick={() => setGranularity(key)}
                  className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium ${
                    granularity === key ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-muted hover:text-ink'
                  }`}
                >
                  {RANGES[key].label}
                </button>
              ))}
            </div>

            <section className={`${CARD} p-5`}>
              <BarChart
                title={range.title}
                unit={['word', 'words']}
                categoryLabel={range.category}
                height={220}
                data={additions.map((period, index) => ({
                  key: period.start,
                  tick:
                    granularity === 'month'
                      ? monthFormat.format(asDate(period.start))
                      : granularity === 'week'
                        ? index % 2 === (additions.length - 1) % 2
                          ? formatDate(period.start, 'short')
                          : ''
                        : (additions.length - 1 - index) % 7 === 0
                          ? formatDate(period.start, 'short')
                          : '',
                  label:
                    granularity === 'month'
                      ? monthLong.format(asDate(period.start))
                      : granularity === 'week'
                        ? `${formatDate(period.start, 'short')} – ${formatDate(period.end)}`
                        : formatDate(period.start),
                  value: period.count,
                }))}
              />
              <p className="mt-2 text-xs text-muted">
                Counted by Date Added. Weeks run Monday to Sunday. A period with no bar had no words added
                {summary.missingDateAdded > 0 &&
                  `; ${summary.missingDateAdded} ${summary.missingDateAdded === 1 ? 'word' : 'words'} without a Date Added ${summary.missingDateAdded === 1 ? 'is' : 'are'} not counted`}
                .
              </p>
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <section className={`${CARD} p-5`}>
                <h2 className={SECTION_TITLE}>Mastered and still learning</h2>
                <div
                  role="progressbar"
                  aria-label="Share of words mastered"
                  aria-valuemin={0}
                  aria-valuemax={summary.total}
                  aria-valuenow={summary.mastered}
                  className="mt-4 h-2.5 overflow-hidden rounded-full bg-accent-soft"
                >
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${summary.total === 0 ? 0 : (summary.mastered / summary.total) * 100}%` }}
                  />
                </div>
                <table className="mt-4 w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th scope="col" className="py-1 font-medium">
                        State
                      </th>
                      <th scope="col" className="py-1 text-right font-medium">
                        Words
                      </th>
                      <th scope="col" className="py-1 text-right font-medium">
                        Share
                      </th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {(
                      [
                        ['Mastered (mastery 10)', summary.mastered],
                        ['Learning (mastery 0 to 9)', summary.learning],
                        ...(summary.invalid > 0 ? ([['No usable mastery', summary.invalid]] as Array<[string, number]>) : []),
                      ] as Array<[string, number]>
                    ).map(([label, count]) => (
                      <tr key={label} className="border-t border-line">
                        <th scope="row" className="py-1.5 text-left font-normal">
                          {label}
                        </th>
                        <td className="py-1.5 text-right">{count}</td>
                        <td className="py-1.5 text-right text-muted">{percent(count, summary.total)}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-line font-semibold">
                      <th scope="row" className="py-1.5 text-left">
                        Total
                      </th>
                      <td className="py-1.5 text-right">{summary.total}</td>
                      <td className="py-1.5 text-right text-muted">{summary.total === 0 ? '—' : '100%'}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              <section className={`${CARD} p-5`}>
                <BarChart
                  title="Words at each mastery level"
                  unit={['word', 'words']}
                  categoryLabel="Mastery"
                  data={distribution.buckets.map((bucket) => ({
                    key: String(bucket.mastery),
                    tick: String(bucket.mastery),
                    label: `Mastery ${bucket.mastery}`,
                    value: bucket.count,
                  }))}
                />
              </section>

              <section className={`${CARD} p-5`}>
                <h2 className={SECTION_TITLE}>Days with the most additions</h2>
                {busiest.length === 0 ? (
                  <p className="mt-3 text-sm text-muted">No words have a Date Added yet.</p>
                ) : (
                  <ol className="m-0 mt-3 flex list-none flex-col divide-y divide-line p-0 text-sm">
                    {busiest.map((day) => (
                      <li key={day.date} className="flex items-center justify-between gap-3 py-2">
                        <Link
                          to={buildHref(ROUTES.calendar, { month: day.date.slice(0, 7), date: day.date })}
                          className="font-medium text-accent hover:underline"
                        >
                          {formatDate(day.date)}
                        </Link>
                        <span className="tabular-nums text-muted">
                          {day.count} {day.count === 1 ? 'word' : 'words'}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className={`${CARD} p-5`}>
                <h2 className={SECTION_TITLE}>Incomplete entries</h2>
                <p className="mt-1 text-xs text-muted">
                  Words missing a descriptive field. This is about the record, not about how well you know the word.
                </p>
                <ul className="m-0 mt-3 flex list-none flex-col divide-y divide-line p-0 text-sm">
                  {(['meaning', 'definition', 'example'] as const).map((key) => (
                    <li key={key} className="flex items-center justify-between gap-3 py-2">
                      {incomplete[key] > 0 ? (
                        <Link to={buildHref(ROUTES.bank, { missing: key })} className="font-medium text-accent hover:underline">
                          {MISSING_LABELS[key]}
                        </Link>
                      ) : (
                        <span>{MISSING_LABELS[key]}</span>
                      )}
                      <span className="tabular-nums text-muted">
                        {incomplete[key]} of {summary.total}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        )}
      </VocabularyGate>
    </div>
  );
}
