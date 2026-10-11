import { useEffect, useState } from 'react';
import type { SchedulerReport } from '../../shared/api.js';
import { SCHEDULER_NAMES, type SchedulerId } from '../../shared/scheduler/active.js';
import { useApp } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ScheduleSimulation } from './ScheduleSimulation.js';
import { BUTTON_SECONDARY, CARD, HELP, INPUT, SECTION_TITLE } from './ui.js';

const RETENTION_CHOICES = [0.8, 0.85, 0.9, 0.92, 0.95];
const percent = (value: number) => `${Math.round(value * 100)}%`;
const signed = (days: number) => (days === 0 ? 'same day' : `${days > 0 ? '+' : '−'}${Math.abs(days)} d`);
const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

const CAPTION = 'pb-1 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted';

/**
 * Which schedule decides what is due, what the other one would do instead,
 * and the choice between them. Both are kept up to date by every saved answer,
 * so choosing converts nothing and can be undone at any time.
 */
export function SchedulerSection() {
  const { api, account, toasts, vocabulary, session } = useApp();
  const [report, setReport] = useState<SchedulerReport | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<SchedulerId | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .fetchScheduler()
      .then((loaded) => {
        if (!current) return;
        setReport(loaded);
        // Only an account can keep the setting; the sample data has nowhere to store it.
        setRetention(account === null || !loaded.fsrs.available ? null : loaded.fsrs.requestRetention);
      })
      .catch((cause: unknown) => {
        if (current) setError(messageOf(cause, 'Could not load the schedule comparison.'));
      });
    return () => {
      current = false;
    };
  }, [api, account]);

  const saveRetention = async (value: number) => {
    if (saving || retention === null) return;
    const previous = retention;
    setRetention(value);
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveSettings({ fsrsRetention: value });
      setRetention(saved.fsrsRetention ?? value);
      toasts.show({ message: `FSRS target retention set to ${percent(saved.fsrsRetention ?? value)}.` });
    } catch (cause) {
      setRetention(previous);
      setError(messageOf(cause, 'Could not save the target retention.'));
    } finally {
      setSaving(false);
    }
  };

  const choose = async (next: SchedulerId) => {
    if (switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      const updated = await api.chooseScheduler(next);
      setReport(updated);
      setAsking(null);
      toasts.show({ message: `${SCHEDULER_NAMES[updated.active]} is now in charge of your reviews.` });
      // What is due has just changed everywhere: the word list is read again, and so is a review
      // queue that was already loaded. An answer still being saved is left to finish first.
      void vocabulary.reload();
      const review = session.getState();
      if (review.meta !== null && review.status !== 'saving') void session.load();
    } catch (cause) {
      setSwitchError(messageOf(cause, 'Could not change the schedule.'));
    } finally {
      setSwitching(false);
    }
  };

  const byFsrs = report?.active === 'fsrs';
  const unseen = report === null ? 0 : report.totalCards - report.comparable;

  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`}>
      <h2 className={SECTION_TITLE}>Scheduling</h2>
      {byFsrs ? (
        <p className="text-sm">
          Your reviews are scheduled by <strong className="font-semibold">FSRS</strong>: each word comes back on the day
          FSRS works out from your answers. Mastery still goes up with every Remember, and still retires a word at the
          top level.
        </p>
      ) : (
        <p className="text-sm">
          Your reviews are scheduled by <strong className="font-semibold">mastery level</strong>: Remember raises the
          level and waits that many days; Not remember brings the word back tomorrow.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-bad-ink">
          {error}
        </p>
      )}
      {report === null ? (
        error === null && (
          <p role="status" className="text-sm text-muted">
            Loading…
          </p>
        )
      ) : !report.fsrs.available ? (
        <p className={HELP}>
          FSRS, a newer scheduling method, can be calculated alongside for comparison once the database has its latest
          update.
        </p>
      ) : (
        <>
          <p className={HELP}>
            {byFsrs
              ? 'The mastery schedule is still worked out from every answer you save, so you can go back to it at any time.'
              : `FSRS, a newer scheduling method, is also calculated from every answer you save, so the two can be compared. ${
                  report.switchable
                    ? 'It does not decide what is due unless you put it in charge.'
                    : 'It does not decide what is due, and switching to it is not available yet.'
                }`}{' '}
            Remember counts as “{report.fsrs.ratings.remember}” and Not remember as “{report.fsrs.ratings.notRemember}”.
          </p>
          <p className="text-sm">
            <strong className="font-semibold tabular-nums">{report.comparable}</strong> of{' '}
            <span className="tabular-nums">{report.totalCards}</span> words have an FSRS schedule so far. A word gets one
            the first time you review it from now on; none is made up for the rest.
          </p>

          {retention !== null && (
            <div className="flex flex-col gap-1.5 sm:max-w-xs">
              <label htmlFor="fsrs-retention" className="text-sm font-medium">
                FSRS target retention
              </label>
              <select
                id="fsrs-retention"
                className={INPUT}
                value={retention}
                disabled={saving}
                aria-describedby="fsrs-retention-help"
                onChange={(event) => void saveRetention(Number(event.target.value))}
              >
                {[...new Set([...RETENTION_CHOICES, retention])]
                  .sort((a, b) => a - b)
                  .map((value) => (
                    <option key={value} value={value}>
                      {percent(value)}
                      {value === 0.9 ? ' (standard)' : ''}
                    </option>
                  ))}
              </select>
              <p id="fsrs-retention-help" className={HELP}>
                The share of reviews FSRS aims for you to remember. Higher means more frequent reviews. It applies to
                answers saved from now on.
              </p>
            </div>
          )}

          {report.comparable > 0 && (
            <>
              <table className="w-full text-left text-sm">
                <caption className={CAPTION}>Reviews falling due, among those {report.comparable} words</caption>
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-1 font-medium">
                      Day
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Mastery schedule
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      FSRS
                    </th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {report.workload.slice(0, 7).map((day) => (
                    <tr key={day.date} className="border-t border-line">
                      <th scope="row" className="py-1 font-normal">
                        {day.date === report.today ? 'Today or earlier' : day.date}
                      </th>
                      <td className="py-1 text-right">{day.legacy}</td>
                      <td className="py-1 text-right">{day.fsrs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <table className="w-full text-left text-sm">
                <caption className={CAPTION}>Next review, word by word</caption>
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-1 font-medium">
                      Word
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Mastery schedule
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      FSRS
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Difference
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Estimated recall now
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.cards.slice(0, 8).map((item) => (
                    <tr key={item.id} className="border-t border-line">
                      <th scope="row" className="max-w-40 truncate py-1 font-medium">
                        {item.word}
                      </th>
                      <td className="py-1 tabular-nums">{item.legacyDue ?? 'never (mastered)'}</td>
                      <td className="py-1 tabular-nums">{item.fsrsDue}</td>
                      <td className="py-1 text-right tabular-nums">
                        {item.differenceDays === null ? '—' : signed(item.differenceDays)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {item.recall === null ? 'Too early to say' : `about ${percent(item.recall)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.cards.length > 8 && <p className={HELP}>Showing the 8 words FSRS would bring back soonest.</p>}
              <p className={HELP}>
                Estimated recall is FSRS’s own figure for the chance you would remember the word if asked right now. It
                is a model’s estimate from your answers so far, not a measurement and not a promise, and it is a
                different thing from the share of answers you actually got right, which is on the Insights page. A word
                answered only once has no estimate yet.
              </p>
            </>
          )}

          <ScheduleSimulation defaultRetention={report.fsrs.requestRetention} />

          <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
            <h3 className="text-sm font-semibold tracking-tight">Which schedule is in charge</h3>
            {!report.switchable ? (
              <p className={HELP}>
                The mastery schedule. Choosing FSRS instead needs the database’s latest update; nothing changes until
                then.
              </p>
            ) : byFsrs ? (
              <>
                <p className={HELP}>
                  FSRS. Going back puts every word on its mastery date again. Those dates were kept up to date all
                  along, so nothing has to be converted, but some words will be due sooner or later than FSRS had them.
                </p>
                <button
                  type="button"
                  className={`${BUTTON_SECONDARY} self-start`}
                  onClick={() => {
                    setSwitchError(null);
                    setAsking('mastery_v1');
                  }}
                >
                  Go back to the mastery schedule…
                </button>
              </>
            ) : (
              <>
                <p className={HELP}>
                  The mastery schedule. You can put FSRS in charge instead, and go back whenever you like: both schedules
                  are updated by every answer, so neither is ever out of date.
                </p>
                <button
                  type="button"
                  className={`${BUTTON_SECONDARY} self-start`}
                  onClick={() => {
                    setSwitchError(null);
                    setAsking('fsrs');
                  }}
                >
                  Put FSRS in charge…
                </button>
              </>
            )}
          </div>

          <p className={HELP}>Calculated with ts-fsrs, {report.fsrs.engine}.</p>
        </>
      )}

      {asking === 'fsrs' && report !== null && (
        <ConfirmDialog
          title="Put FSRS in charge?"
          confirmLabel="Put FSRS in charge"
          tone="primary"
          busy={switching}
          error={switchError}
          onConfirm={() => void choose('fsrs')}
          onCancel={() => setAsking(null)}
        >
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              A word will come back on the day FSRS works out from your answers, instead of on its mastery date. What is
              due today may change straight away.
            </li>
            {unseen > 0 && (
              <li>
                {unseen} of your {report.totalCards} words {unseen === 1 ? 'has' : 'have'} no FSRS schedule yet.{' '}
                {unseen === 1 ? 'It keeps its' : 'They keep their'} current {unseen === 1 ? 'date' : 'dates'} until you
                next answer {unseen === 1 ? 'it' : 'them'}.
              </li>
            )}
            <li>
              Remember and Not remember work as before. Mastery still goes up with each Remember and still retires a
              word at the top level.
            </li>
            <li>A review date FSRS has set cannot be edited by hand.</li>
            <li>You can go back at any time, and nothing is lost either way.</li>
          </ul>
        </ConfirmDialog>
      )}
      {asking === 'mastery_v1' && (
        <ConfirmDialog
          title="Go back to the mastery schedule?"
          confirmLabel="Use the mastery schedule"
          tone="primary"
          busy={switching}
          error={switchError}
          onConfirm={() => void choose('mastery_v1')}
          onCancel={() => setAsking(null)}
        >
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              Every word will be due on its mastery date again. Those dates were kept up to date while FSRS was in
              charge, so what is due today may change straight away.
            </li>
            <li>FSRS keeps being calculated beside it, so you can put it back in charge later.</li>
          </ul>
        </ConfirmDialog>
      )}
    </section>
  );
}
