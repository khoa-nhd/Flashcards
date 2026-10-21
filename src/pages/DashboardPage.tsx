import { useMemo } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { addDays, compareDates } from '../../shared/dates.js';
import { additionsByPeriod, computeSummary, masteryDistribution } from '../../shared/metrics.js';
import { useApp, useSettings, useVocabulary } from '../app-context.js';
import { BarChart } from '../components/BarChart.js';
import { MasteryPill, StatusBadge, formatDate } from '../components/badges.js';
import { GoalProgress, hasGoal, useDayPlan } from '../components/GoalStatus.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { ReviewActivityCard, useReviewActivity } from '../components/ReviewActivity.js';
import { StatTile } from '../components/StatTile.js';
import { TodayPlan } from '../components/TodayPlan.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { RECENT_DAYS } from '../lib/bank-query.js';
import { ROUTES, buildHref, openWord } from '../lib/router.js';

const RECENT_COUNT = 6;

/** The most recently added words, by the user-entered Date Added (ties: latest created first). */
function recentAdditions(entries: readonly VocabularyEntry[]): VocabularyEntry[] {
  return entries
    .filter((entry) => entry.dateAdded !== null)
    .sort(
      (a, b) =>
        compareDates(b.dateAdded as string, a.dateAdded as string) ||
        (b.createdTime ?? '').localeCompare(a.createdTime ?? ''),
    )
    .slice(0, RECENT_COUNT);
}

export function DashboardPage() {
  const state = useVocabulary();
  const { api, vocabulary } = useApp();
  const settings = useSettings();
  const activity = useReviewActivity();
  const plan = useDayPlan();
  // Only the count of high-priority weak words is needed, for the plan card.
  const weak = useRemote(() => api.fetchWeakWords(), 'Could not load your weak words.');
  const { entries, meta } = state;
  const today = meta?.today ?? null;

  const summary = useMemo(() => (today === null ? null : computeSummary(entries, today)), [entries, today]);
  const distribution = useMemo(() => masteryDistribution(entries), [entries]);
  const additions = useMemo(
    () => (today === null ? [] : additionsByPeriod(entries, 'day', settings.dashboardDays, today)),
    [entries, today, settings.dashboardDays],
  );
  const recent = useMemo(() => recentAdditions(entries), [entries]);
  const ready = useMemo(() => entries.filter((entry) => entry.reviewable).length, [entries]);
  const weakHigh = weak.status === 'ready' ? weak.data.words.filter((word) => word.severity === 'high').length : null;

  return (
    <div className={PAGE}>
      <PageHeader
        title="Home"
        description={today === null ? 'Your vocabulary at a glance.' : `Your vocabulary as of ${formatDate(today)}.`}
        actions={
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => {
              void vocabulary.reload();
              activity.reload();
              plan.reload();
              weak.reload();
            }}
            disabled={state.refreshing || state.status === 'loading'}
          >
            <Icon name="refresh" className="size-4" />
            {state.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      <VocabularyGate state={state}>
        {summary !== null && today !== null && (
          <div className={`flex flex-col gap-6 ${state.refreshing ? 'opacity-70' : ''}`}>
            {/* Continue: what is ready now and the way to continue it. */}
            <section aria-label="Continue" className={`${CARD} p-5`}>
              <h2 className={SECTION_TITLE}>Continue</h2>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-muted">Ready to review</p>
                  <p className="text-5xl font-semibold tracking-tight">{ready}</p>
                  <p className="mt-1 text-sm text-muted">
                    {ready === 0
                      ? 'Nothing is waiting. New words and due reviews will show up here.'
                      : `${summary.overdue} overdue, ${summary.dueToday} due today${
                          summary.unscheduled > 0 && ready > summary.overdue + summary.dueToday
                            ? `, ${summary.unscheduled} new`
                            : ''
                        }.`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link to={ROUTES.review} className={BUTTON_PRIMARY}>
                    <Icon name="review" className="size-4" /> Start review
                  </Link>
                  <Link to={ROUTES.add} className={BUTTON_SECONDARY}>
                    <Icon name="add" className="size-4" /> Add vocabulary
                  </Link>
                </div>
              </div>
            </section>

            {plan.status === 'ready' && plan.data.available && (
              <section className={`${CARD} p-5`} aria-label="Daily goal">
                {hasGoal(plan.data) ? (
                  <GoalProgress plan={plan.data} />
                ) : (
                  <p className="text-sm text-muted">
                    No daily goal is set.{' '}
                    <Link to={ROUTES.settings} className="font-medium text-accent hover:underline">
                      Set one in Settings
                    </Link>
                  </p>
                )}
              </section>
            )}

            <TodayPlan due={ready} weakHigh={weakHigh} />

            <ReviewActivityCard activity={activity} />

            <section aria-label="Summary">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile label="Total vocabulary" value={summary.total} to={ROUTES.bank} />
                <StatTile
                  label="Mastered"
                  value={summary.mastered}
                  hint="Mastery 10"
                  to={buildHref(ROUTES.bank, { status: 'mastered' })}
                />
                <StatTile
                  label="Learning"
                  value={summary.learning}
                  hint="Mastery 0 to 9"
                  to={buildHref(ROUTES.bank, { status: 'learning' })}
                />
                <StatTile
                  label="Upcoming"
                  value={summary.upcoming}
                  hint="Scheduled after today"
                  to={buildHref(ROUTES.bank, { status: 'upcoming' })}
                />
                <StatTile
                  label="Due today"
                  value={summary.dueToday}
                  emphasis="accent"
                  to={buildHref(ROUTES.bank, { status: 'due_today' })}
                />
                <StatTile
                  label="Overdue"
                  value={summary.overdue}
                  hint="Scheduled before today"
                  emphasis="bad"
                  to={buildHref(ROUTES.bank, { status: 'overdue' })}
                />
                <StatTile
                  label="Added today"
                  value={summary.addedToday}
                  to={buildHref(ROUTES.bank, { from: today, to: today })}
                />
                <StatTile
                  label="Added this week"
                  value={summary.addedThisWeek}
                  hint="Monday to Sunday"
                  to={buildHref(ROUTES.calendar)}
                />
              </div>
              {(summary.unscheduled > 0 || summary.invalid > 0 || summary.missingDateAdded > 0) && (
                <ul className="mt-3 flex flex-col gap-1 text-sm text-muted">
                  {summary.unscheduled > 0 && (
                    <li>
                      <Link to={buildHref(ROUTES.bank, { status: 'unscheduled' })} className="text-accent hover:underline">
                        {summary.unscheduled} {summary.unscheduled === 1 ? 'word has' : 'words have'} no review date
                      </Link>{' '}
                      and {summary.unscheduled === 1 ? 'is' : 'are'} counted under Learning, not under Due today.
                    </li>
                  )}
                  {summary.invalid > 0 && (
                    <li>
                      {summary.invalid} {summary.invalid === 1 ? 'word has' : 'words have'} no usable mastery and{' '}
                      {summary.invalid === 1 ? 'is' : 'are'} counted in the total only.
                    </li>
                  )}
                  {summary.missingDateAdded > 0 && (
                    <li>
                      {summary.missingDateAdded} {summary.missingDateAdded === 1 ? 'word has' : 'words have'} no Date
                      Added and {summary.missingDateAdded === 1 ? 'is' : 'are'} left out of the “added” figures.
                    </li>
                  )}
                </ul>
              )}
            </section>

            <section className={`${CARD} p-5`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className={SECTION_TITLE}>Progress to mastery</h2>
                <p className="text-sm text-muted">
                  <strong className="font-semibold text-ink">{summary.mastered}</strong> of {summary.total} mastered
                  {summary.total > 0 && ` (${Math.round((summary.mastered / summary.total) * 100)}%)`}
                </p>
              </div>
              <div
                role="progressbar"
                aria-label="Mastered words"
                aria-valuemin={0}
                aria-valuemax={summary.total}
                aria-valuenow={summary.mastered}
                className="mt-3 h-2.5 overflow-hidden rounded-full bg-accent-soft"
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${summary.total === 0 ? 0 : (summary.mastered / summary.total) * 100}%` }}
                />
              </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
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
                {distribution.other > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    {distribution.other} {distribution.other === 1 ? 'word is' : 'words are'} not shown because{' '}
                    {distribution.other === 1 ? 'its' : 'their'} mastery is empty or outside 0 to 10.
                  </p>
                )}
              </section>

              <section className={`${CARD} p-5`}>
                <BarChart
                  title={`Words added per day, last ${settings.dashboardDays} days`}
                  unit={['word', 'words']}
                  categoryLabel="Date added"
                  data={additions.map((period, index) => ({
                    key: period.start,
                    // Label roughly every week so the axis stays readable on a phone.
                    tick: (additions.length - 1 - index) % 7 === 0 ? formatDate(period.start, 'short') : '',
                    label: formatDate(period.start),
                    value: period.count,
                  }))}
                />
                <p className="mt-2 text-xs text-muted">By Date Added. A day with no bar had no words added.</p>
              </section>
            </div>

            <section className={`${CARD} p-5`}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className={SECTION_TITLE}>Recently added</h2>
                <Link to={ROUTES.bank} className="text-sm font-medium text-accent hover:underline">
                  Open vocabulary bank
                </Link>
              </div>
              {recent.length === 0 ? (
                <p className="text-sm text-muted">No words have a Date Added yet.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
                  {recent.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => openWord(entry.id)}
                        className="flex w-full cursor-pointer items-center gap-3 py-2.5 text-left hover:bg-line/20"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{entry.word}</span>
                          <span className="block truncate text-sm text-muted">{entry.meaning ?? entry.definition ?? '—'}</span>
                        </span>
                        <span className="hidden shrink-0 sm:block">
                          <StatusBadge status={entry.reviewStatus} />
                        </span>
                        <MasteryPill mastery={entry.mastery} />
                        <span className="w-16 shrink-0 text-right text-xs text-muted">{formatDate(entry.dateAdded, 'short')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Quick actions" className={`${CARD} p-5`}>
              <h2 className={SECTION_TITLE}>Quick actions</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={buildHref(ROUTES.bank, { status: 'due_today' })} className={BUTTON_SECONDARY}>
                  View due today
                </Link>
                <Link to={buildHref(ROUTES.bank, { status: 'overdue' })} className={BUTTON_SECONDARY}>
                  View overdue
                </Link>
                <Link to={buildHref(ROUTES.bank, { status: 'mastered' })} className={BUTTON_SECONDARY}>
                  Browse mastered
                </Link>
                <Link
                  to={buildHref(ROUTES.bank, { from: addDays(today, -(RECENT_DAYS - 1)), to: today })}
                  className={BUTTON_SECONDARY}
                >
                  Added in the last {RECENT_DAYS} days
                </Link>
                <Link to={ROUTES.weak} className={BUTTON_SECONDARY}>
                  Weak words
                </Link>
                <Link to={ROUTES.insights} className={BUTTON_SECONDARY}>
                  Insights
                </Link>
              </div>
            </section>
          </div>
        )}
      </VocabularyGate>
    </div>
  );
}
