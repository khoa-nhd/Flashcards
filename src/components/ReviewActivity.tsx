import type { AnalyticsResponse } from '../../shared/api.js';
import { STUDY_MODE_LABELS } from '../../shared/study-modes.js';
import { useApp } from '../app-context.js';
import { useRemote, type Remote } from '../hooks/useRemote.js';
import { ROUTES } from '../lib/router.js';
import { BarChart } from './BarChart.js';
import { CONFIDENCE_LABELS } from './ConfidencePrompt.js';
import { formatDuration } from '../lib/format.js';
import { Link } from './Link.js';
import { StatTile } from './StatTile.js';
import { formatDate } from './badges.js';
import { BUTTON_SECONDARY, CARD, HELP, SECTION_TITLE } from './ui.js';

type Period = AnalyticsResponse['periods']['today'];

const LOAD_FAILED = 'Could not load your review activity.';
const NOT_ENOUGH = 'Not enough data';

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const days = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

const MODE_LABELS: Record<string, string> = { flashcard: 'Flashcards', ...STUDY_MODE_LABELS };

/**
 * Practice in the other study modes, one row per mode and never a combined
 * figure: recognising a meaning and producing a word are different skills.
 */
function Practice({ data }: { data: AnalyticsResponse }) {
  const { modes, today } = data.practice;
  if (modes.length === 0) {
    return (
      <p className="text-sm text-muted">
        No practice in the last 30 days.{' '}
        <Link to={ROUTES.practice} className="font-medium text-accent hover:underline">
          Start a practice session
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-sm">
        <caption className="pb-1 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted">
          Practice by mode, last 30 days
        </caption>
        <thead className="text-left text-xs text-muted">
          <tr>
            <th scope="col" className="py-1 font-medium">
              Mode
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Answers
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Correct
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Share
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {modes.map((mode) => (
            <tr key={mode.mode} className="border-t border-line">
              <th scope="row" className="py-1.5 text-left font-normal">
                {MODE_LABELS[mode.mode] ?? mode.mode}
              </th>
              <td className="py-1.5 text-right">{mode.answers}</td>
              <td className="py-1.5 text-right">{mode.correct}</td>
              <td className="py-1.5 text-right">{ratioCell(mode.accuracy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={HELP}>
        Today: <span className="tabular-nums">{today.correct}</span> of {today.answers} practice{' '}
        {today.answers === 1 ? 'answer' : 'answers'} correct. Practice is kept apart from the review figures above and
        never changes mastery or review dates. Every practice answer is checked automatically.
      </p>
    </div>
  );
}

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
    <section className="flex flex-col" aria-label="Review activity">
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

/**
 * How answers went at each level of confidence given beforehand. The two
 * mismatches are plain counts: sure and wrong, unsure and right.
 */
function Calibration({ data }: { data: AnalyticsResponse }) {
  const { levels } = data.calibration;
  const rated = levels.reduce((total, level) => total + level.reviews, 0);
  if (rated === 0) {
    return (
      <p className="text-sm text-muted">
        No confidence ratings in the last 30 days. To collect them, turn on “Ask how sure I am before showing the
        answer” in{' '}
        <Link to={ROUTES.settings} className="font-medium text-accent hover:underline">
          Settings
        </Link>
        .
      </p>
    );
  }
  const at = (confidence: number) => levels.find((level) => level.confidence === confidence);
  const sureAndWrong = (at(3)?.reviews ?? 0) - (at(3)?.remembered ?? 0);
  const unsureAndRight = at(1)?.remembered ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-sm">
        <caption className="pb-1 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted">
          How sure you were, last 30 days
        </caption>
        <thead className="text-left text-xs text-muted">
          <tr>
            <th scope="col" className="py-1 font-medium">
              Confidence before the answer
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Answers
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Remembered
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Share
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {levels.map((level) => (
            <tr key={level.confidence} className="border-t border-line">
              <th scope="row" className="py-1.5 text-left font-normal">
                {CONFIDENCE_LABELS[level.confidence]}
              </th>
              <td className="py-1.5 text-right">{level.reviews}</td>
              <td className="py-1.5 text-right">{level.remembered}</td>
              <td className="py-1.5 text-right">{level.reviews === 0 ? '—' : ratioCell(level.accuracy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={HELP}>
        Sure but not remembered: <span className="tabular-nums">{sureAndWrong}</span> of {at(3)?.reviews ?? 0} high-confidence{' '}
        {(at(3)?.reviews ?? 0) === 1 ? 'answer' : 'answers'}. Unsure but remembered:{' '}
        <span className="tabular-nums">{unsureAndRight}</span> of {at(1)?.reviews ?? 0} low-confidence{' '}
        {(at(1)?.reviews ?? 0) === 1 ? 'answer' : 'answers'}. Only answers given with a rating are counted; the rating
        never changes what an answer does.
      </p>
    </div>
  );
}

/**
 * Accuracy and time per card, week by week. A week with too few answers gets
 * no bar and says so: a blank is not a zero.
 */
function WeeklyTrends({ data }: { data: AnalyticsResponse }) {
  const { weeks, minSample } = data;
  if (weeks.length === 0) return null;
  const range = (week: Period) => `${formatDate(week.from, 'short')} – ${formatDate(week.to)}`;
  // Every other week is labelled, always including the newest.
  const tick = (week: Period, index: number) =>
    index % 2 === (weeks.length - 1) % 2 ? formatDate(week.to, 'short') : '';
  const tooFew = (have: number, what: string) =>
    have === 0 ? `No ${what}` : `${NOT_ENOUGH}: ${have} of ${minSample} ${what} needed`;

  const accuracy = weeks.map((week, index) => ({
    key: week.from,
    tick: tick(week, index),
    label: range(week),
    value: week.accuracy === null ? 0 : Math.round(week.accuracy * 100),
    text:
      week.accuracy === null
        ? tooFew(week.reviews, 'answers')
        : `${percent(week.accuracy)} (${week.remembered} of ${week.reviews} answers remembered)`,
  }));
  const timed = weeks.map((week, index) => {
    const enough = week.averageMs !== null && week.timedReviews >= minSample;
    return {
      key: week.from,
      tick: tick(week, index),
      label: range(week),
      value: enough && week.averageMs !== null ? Math.round(week.averageMs / 100) / 10 : 0,
      text:
        enough && week.averageMs !== null
          ? `${formatDuration(week.averageMs)} per card, over ${week.timedReviews} timed answers`
          : tooFew(week.timedReviews, 'timed answers'),
    };
  });
  const anyAccuracy = weeks.some((week) => week.accuracy !== null);
  const anyTime = timed.some((week) => week.value > 0);

  return (
    <div className="flex flex-col gap-4">
      {anyAccuracy ? (
        <BarChart
          title={`Accuracy by week, last ${weeks.length} weeks (%)`}
          unit={['percent', 'percent']}
          categoryLabel="Week"
          height={180}
          data={accuracy}
        />
      ) : (
        <p className="text-sm text-muted">
          No week has had {minSample} answers yet, so there is no week-by-week accuracy to show.
        </p>
      )}
      {anyTime && (
        <BarChart
          title={`Time per card by week, last ${weeks.length} weeks (seconds)`}
          unit={['second', 'seconds']}
          categoryLabel="Week"
          height={180}
          data={timed}
        />
      )}
      <p className={HELP}>
        A week here is seven days ending on today’s weekday, so the last bar ends today. A week with fewer than{' '}
        {minSample} answers has no bar: that is too few to call a percentage, not a score of zero. Accuracy is what
        happened in your saved answers, not a prediction.
      </p>
    </div>
  );
}

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
      {activity.status === 'ready' && activity.data.practice.available && <Practice data={activity.data} />}
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

      <WeeklyTrends data={data} />

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

      {data.calibration.available && <Calibration data={data} />}

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
