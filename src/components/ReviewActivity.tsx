import type { AnalyticsResponse } from '../../shared/api.js';
import { useApp } from '../app-context.js';
import { useRemote, type Remote } from '../hooks/useRemote.js';
import { ROUTES } from '../lib/router.js';
import { BarChart } from './BarChart.js';
import { formatDuration } from './CompletionScreen.js';
import { Link } from './Link.js';
import { StatTile } from './StatTile.js';
import { formatDate } from './badges.js';
import { BUTTON_SECONDARY, CARD, HELP, SECTION_TITLE } from './ui.js';

type Period = AnalyticsResponse['periods']['today'];

const LOAD_FAILED = 'Could not load your review activity.';
const NOT_ENOUGH = 'Not enough data';

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const days = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

const MODE_LABELS: Record<string, string> = { flashcard: 'Flashcards' };

/** Review activity is loaded by the page that shows it, so its Refresh can re-read it. */
export function useReviewActivity(): Remote<AnalyticsResponse> & { reload(): void } {
  const { api } = useApp();
  return useRemote(api.fetchAnalytics, LOAD_FAILED);
}

function Unavailable({ activity }: { activity: Remote<AnalyticsResponse> & { reload(): void } }) {
  if (activity.status === 'loading') {
    return (
      <p role="status" className="mt-3 text-sm text-muted">
        Loading your review activity…
      </p>
    );
  }
  if (activity.status === 'failed') {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm text-bad-ink">
          {activity.error}
        </p>
        <button type="button" className={BUTTON_SECONDARY} onClick={activity.reload}>
          Try again
        </button>
      </div>
    );
  }
  if (!activity.data.available) {
    return (
      <p className="mt-3 text-sm text-muted">
        Review activity appears here once the database has its latest update.{' '}
        <Link to={ROUTES.settings} className="font-medium text-accent hover:underline">
          See Settings
        </Link>
        . Nothing is estimated in the meantime.
      </p>
    );
  }
  if (activity.data.firstReviewOn === null) {
    return (
      <p className="mt-3 text-sm text-muted">
        No saved reviews in the last {activity.data.windowDays} days. Answers you save from now on are counted here.
      </p>
    );
  }
  return null;
}

const hasFigures = (activity: Remote<AnalyticsResponse>): activity is Remote<AnalyticsResponse> & { status: 'ready' } =>
  activity.status === 'ready' && activity.data.available && activity.data.firstReviewOn !== null;

/** The dashboard's short account of recent reviewing. Every figure comes from saved answers. */
export function ReviewActivityCard({ activity }: { activity: Remote<AnalyticsResponse> & { reload(): void } }) {
  return (
    <section className={`${CARD} p-5`} aria-label="Review activity">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={SECTION_TITLE}>Review activity</h2>
        <div className="flex gap-4 text-sm font-medium">
          <Link to={ROUTES.weak} className="text-accent hover:underline">
            Weak words
          </Link>
          <Link to={ROUTES.insights} className="text-accent hover:underline">
            More in Insights
          </Link>
        </div>
      </div>
      <Unavailable activity={activity} />
      {hasFigures(activity) && <Figures data={activity.data} />}
    </section>
  );
}

function Figures({ data }: { data: AnalyticsResponse }) {
  const { today, week } = data.periods;
  const { current, longest } = data.streak;
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Reviews today"
        value={today.reviews}
        hint={today.reviews === 0 ? 'None yet today' : `${today.remembered} remembered`}
      />
      <StatTile
        label="Accuracy, last 7 days"
        value={week.accuracy === null ? '—' : percent(week.accuracy)}
        hint={
          week.accuracy === null
            ? `${NOT_ENOUGH}: ${week.reviews} of ${data.minSample} answers needed`
            : `${week.remembered} of ${week.reviews} answers remembered`
        }
      />
      <StatTile
        label="Streak"
        value={days(current)}
        hint={
          current === 0
            ? 'No review today or yesterday'
            : today.reviews === 0
              ? 'Review today to keep it going'
              : `Longest in ${data.windowDays} days: ${days(longest)}`
        }
      />
      <StatTile
        label="Time on cards today"
        value={today.timedReviews === 0 ? '—' : formatDuration(today.durationMs)}
        hint={today.averageMs === null ? 'No timed answers today' : `${formatDuration(today.averageMs)} per card`}
      />
    </div>
  );
}

const ratioCell = (value: number | null) => (value === null ? NOT_ENOUGH : percent(value));

/** The longer account on the Insights page: a chart of the last month and the figures behind it. */
export function ReviewActivityDetail() {
  const activity = useReviewActivity();
  return (
    <section className={`${CARD} flex flex-col gap-4 p-5`} aria-label="Review activity">
      <div>
        <h2 className={SECTION_TITLE}>Review activity</h2>
        <Unavailable activity={activity} />
      </div>
      {hasFigures(activity) && <Detail data={activity.data} />}
    </section>
  );
}

function Detail({ data }: { data: AnalyticsResponse }) {
  const month = data.days.slice(-30);
  const rows: Array<[string, Period]> = [
    ['Today', data.periods.today],
    ['Last 7 days', data.periods.week],
    ['Last 30 days', data.periods.month],
  ];
  return (
    <>
      <BarChart
        title="Reviews per day, last 30 days"
        unit={['review', 'reviews']}
        categoryLabel="Day"
        height={200}
        data={month.map((day, index) => ({
          key: day.date,
          tick: (month.length - 1 - index) % 7 === 0 ? formatDate(day.date, 'short') : '',
          label: formatDate(day.date),
          value: day.reviews,
        }))}
      />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <caption className="sr-only">Review figures by period</caption>
          <thead className="text-left text-xs text-muted">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Period
              </th>
              {['Reviews', 'Remembered', 'Accuracy', 'Retention', 'Time on cards', 'Days reviewed'].map((heading) => (
                <th key={heading} scope="col" className="py-1 text-right font-medium">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map(([label, period]) => (
              <tr key={label} className="border-t border-line">
                <th scope="row" className="py-1.5 text-left font-normal">
                  {label}
                </th>
                <td className="py-1.5 text-right">{period.reviews}</td>
                <td className="py-1.5 text-right">{period.remembered}</td>
                <td className="py-1.5 text-right">{ratioCell(period.accuracy)}</td>
                <td className="py-1.5 text-right">{ratioCell(period.retention)}</td>
                <td className="py-1.5 text-right">
                  {period.timedReviews === 0 ? '—' : formatDuration(period.durationMs)}
                </td>
                <td className="py-1.5 text-right">{period.activeDays}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.byMode.length > 1 && (
        <table className="w-full text-sm">
          <caption className="pb-1 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            By study mode, last 30 days
          </caption>
          <thead className="text-left text-xs text-muted">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Mode
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Reviews
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Accuracy
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {data.byMode.map((mode) => (
              <tr key={mode.mode} className="border-t border-line">
                <th scope="row" className="py-1.5 text-left font-normal">
                  {MODE_LABELS[mode.mode] ?? mode.mode}
                </th>
                <td className="py-1.5 text-right">{mode.reviews}</td>
                <td className="py-1.5 text-right">{ratioCell(mode.accuracy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-sm">
        Streak: <strong className="font-semibold tabular-nums">{days(data.streak.current)}</strong>
        <span className="text-muted">
          {' '}
          · longest in the last {data.windowDays} days: <span className="tabular-nums">{days(data.streak.longest)}</span>
        </span>
      </p>

      <ul className={`m-0 flex list-disc flex-col gap-1 pl-4 ${HELP}`}>
        <li>Counted from answers that were saved and not undone. Nothing earlier than the saved history is filled in.</li>
        <li>Accuracy is answers remembered out of all answers in the period.</li>
        <li>
          Retention is the same, counting only words you had reviewed before. It is what happened, not a prediction.
        </li>
        <li>
          A percentage is shown only from {data.minSample} answers up; below that it says “{NOT_ENOUGH}”.
        </li>
        <li>A streak counts days in a row with a saved review, and is still alive until the end of the next day.</li>
      </ul>
    </>
  );
}
