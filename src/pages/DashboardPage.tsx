import { useMemo } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { addDays, compareDates } from '../../shared/dates.js';
import { additionsByPeriod, computeSummary, masteryDistribution } from '../../shared/metrics.js';
import { useApp, useSettings, useVocabulary, useTrueMastery } from '../app-context.js';
import { BarChart } from '../components/BarChart.js';
import { MasteryPill, StatusBadge, formatDate } from '../components/badges.js';
import { GoalProgress, hasGoal, useDayPlan } from '../components/GoalStatus.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { ReviewActivityCard, useReviewActivity } from '../components/ReviewActivity.js';
import { StatTile } from '../components/StatTile.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, PAGE, SECTION_TITLE } from '../components/ui.js';
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
  const { vocabulary } = useApp();
  const settings = useSettings();
  const activity = useReviewActivity();
  const plan = useDayPlan();
  const { trueMasteryMap } = useTrueMastery();
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

  // True Mastery summary
  const trueMasterySummary = useMemo(() => {
    if (!today) return null;
    const counts = { Excellent: 0, Strong: 0, Good: 0, Developing: 0, Weak: 0, New: 0, Insufficient: 0 };
    let totalEvidence = 0;
    let wordsWithEvidence = 0;
    for (const entry of entries) {
      const tm = trueMasteryMap.get(entry.id);
      if (tm && tm.mastery !== null) {
        const tier = tm.tier as keyof typeof counts;
        counts[tier] = (counts[tier] ?? 0) + 1;
        totalEvidence += tm.totalEffectiveEvidence;
        wordsWithEvidence++;
      } else {
        counts.Insufficient++;
      }
    }
    return { counts, totalEvidence, wordsWithEvidence };
  }, [entries, trueMasteryMap, today]);

  return (
    <div className={PAGE}>
      <PageHeader
        title="Dashboard"
        description={today === null ? 'Your vocabulary at a glance.' : `Your vocabulary as of ${formatDate(today)}.`}
        actions={
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => {
              void vocabulary.reload();
              activity.reload();
              plan.reload();
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
            {/* Headline: what needs doing now, and the way to do it. */}
            <section
              aria-label="Ready to review"
              className="pool pool-top overflow-hidden rounded-2xl border border-line px-6 py-7 md:px-9 md:py-9"
            >
              <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
                <div className="min-w-0 max-w-[36rem]">
                  <h2 className="font-serif text-[2.5rem] font-semibold leading-[1.04] tracking-[-0.025em] text-ink md:text-[3.25rem]">
                    {ready === 0
                      ? 'Nothing is due right now.'
                      : `${ready} ${ready === 1 ? 'word' : 'words'} ready to review.`}
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-muted">
                    {ready === 0
                      ? 'New words and due reviews will show up here.'
                      : `${summary.overdue} overdue, ${summary.dueToday} due today${
                          summary.unscheduled > 0 && ready > summary.overdue + summary.dueToday
                            ? `, ${summary.unscheduled} new`
                            : ''
                        }.`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
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

            <ReviewActivityCard activity={activity} />

            {/* Next useful action - clearly distinguish due review from weak knowledge */}
            <section className="flex flex-col" aria-label="What to do next">
              <h2 className={SECTION_TITLE}>What to do next</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {/* Due review */}
                <Link
                  to={buildHref(ROUTES.review)}
                  className={`flex flex-col gap-2 rounded-xl border p-4 transition-colors hover:border-muted ${
                    summary.dueToday > 0 || summary.overdue > 0
                      ? 'border-accent/50 bg-accent-soft'
                      : 'border-line bg-surface'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-8 items-center justify-center rounded-lg border border-accent/40 text-accent">
                      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 6v6l4 2"/></svg>
                    </span>
                    <span className="font-semibold text-sm">Review now</span>
                  </div>
                  <p className="text-sm text-muted">
                    {summary.dueToday > 0
                      ? `${summary.dueToday} due today${summary.overdue > 0 ? `, ${summary.overdue} overdue` : ''}`
                      : summary.overdue > 0
                        ? `${summary.overdue} overdue`
                        : 'Nothing due right now'}
                  </p>
                </Link>

                {/* Practice weak words with evidence */}
                <Link
                  to={buildHref(ROUTES.practice, { source: 'weak' })}
                  className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-muted"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-line-strong/50 text-muted">
                      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    </span>
                    <span className="font-semibold text-sm">Practice weak words</span>
                  </div>
                  <p className="text-sm text-muted">
                    {trueMasterySummary && trueMasterySummary.wordsWithEvidence > 0
                      ? `${trueMasterySummary.wordsWithEvidence} words with weak evidence`
                      : 'Not enough practice evidence yet'}
                  </p>
                </Link>

                {/* Collect evidence */}
                <Link
                  to={buildHref(ROUTES.practice, { source: 'all' })}
                  className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-muted"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-line-strong/60 text-muted">
                      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    </span>
                    <span className="font-semibold text-sm">Collect evidence</span>
                  </div>
                  <p className="text-sm text-muted">
                    {trueMasterySummary
                      ? `${trueMasterySummary.counts.Insufficient ?? 0} words need more practice`
                      : 'Start practicing to build evidence'}
                  </p>
                </Link>
              </div>
            </section>

            <section aria-label="Summary">
              <h2 className={SECTION_TITLE}>Summary</h2>
              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
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

            {trueMasterySummary && (
              <section className="flex flex-col" aria-label="True Mastery">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                  <h2 className={SECTION_TITLE}>True Mastery</h2>
                  <span className="text-xs text-muted">
                    Evidence-based estimate (0–100) from practice history. Separate from Review Mastery.
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <StatTile
                    label="Excellent"
                    value={trueMasterySummary.counts.Excellent ?? 0}
                    emphasis="accent"
                    hint="90–100"
                  />
                  <StatTile
                    label="Strong"
                    value={trueMasterySummary.counts.Strong ?? 0}
                    emphasis="accent"
                    hint="75–89"
                  />
                  <StatTile
                    label="Good"
                    value={trueMasterySummary.counts.Good ?? 0}
                    emphasis="accent"
                    hint="60–74"
                  />
                  <StatTile
                    label="Developing"
                    value={trueMasterySummary.counts.Developing ?? 0}
                    hint="40–59"
                  />
                  <StatTile
                    label="Weak"
                    value={trueMasterySummary.counts.Weak ?? 0}
                    emphasis="bad"
                    hint="20–39"
                  />
                  <StatTile
                    label="New"
                    value={trueMasterySummary.counts.New ?? 0}
                    hint="0–19"
                  />
                  <StatTile
                    label="Insufficient data"
                    value={trueMasterySummary.counts.Insufficient ?? 0}
                    hint="Not enough practice evidence"
                  />
                </div>
                {trueMasterySummary.wordsWithEvidence > 0 && (
                  <p className="mt-3 text-sm text-muted">
                    {trueMasterySummary.wordsWithEvidence} of {summary.total} words have practice evidence
                    (avg {Math.round(trueMasterySummary.totalEvidence / trueMasterySummary.wordsWithEvidence)} effective evidence).
                    <Link to={ROUTES.bank} className="ml-2 font-medium text-accent hover:underline">
                      View in Bank
                    </Link>
                  </p>
                )}
              </section>
            )}

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
                        className="flex w-full cursor-pointer items-center gap-3 py-2.5 text-left transition-colors hover:bg-line-strong/40"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-serif text-[1.0625rem] font-medium">{entry.word}</span>
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

            <section aria-label="Quick links" className="flex flex-wrap gap-2">
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
            </section>
          </div>
        )}
      </VocabularyGate>
    </div>
  );
}
