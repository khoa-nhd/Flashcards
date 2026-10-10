import { useEffect, useState } from 'react';
import type { SchedulerReport } from '../../shared/api.js';
import { useApp } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { CARD, HELP, INPUT, SECTION_TITLE } from './ui.js';

const RETENTION_CHOICES = [0.8, 0.85, 0.9, 0.92, 0.95];
const percent = (value: number) => `${Math.round(value * 100)}%`;
const signed = (days: number) => (days === 0 ? 'same day' : `${days > 0 ? '+' : '−'}${Math.abs(days)} d`);
const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

const CAPTION = 'pb-1 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted';

/**
 * Which schedule decides what is due, and what FSRS would do instead. FSRS is
 * only calculated here; nothing on this panel changes a due date.
 */
export function SchedulerSection() {
  const { api, account, toasts } = useApp();
  const [report, setReport] = useState<SchedulerReport | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`}>
      <h2 className={SECTION_TITLE}>Scheduling</h2>
      <p className="text-sm">
        Your reviews are scheduled by <strong className="font-semibold">mastery level</strong>: Remember raises the
        level and waits that many days; Not remember brings the word back tomorrow.
      </p>
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
            FSRS, a newer scheduling method, is also calculated from every answer you save, so the two can be compared.
            It does not decide what is due, and switching to it is not available yet. Remember counts as “
            {report.fsrs.ratings.remember}” and Not remember as “{report.fsrs.ratings.notRemember}”.
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
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.cards.length > 8 && <p className={HELP}>Showing the 8 words FSRS would bring back soonest.</p>}
            </>
          )}
          <p className={HELP}>Calculated with ts-fsrs, {report.fsrs.engine}.</p>
        </>
      )}
    </section>
  );
}
