import { useState } from 'react';
import type { SimulationResponse } from '../../shared/api.js';
import { useApp } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { count } from '../lib/format.js';
import { Spinner } from './Spinner.js';
import { BUTTON_SECONDARY, HELP, INPUT } from './ui.js';

const TARGETS = [0.8, 0.85, 0.9, 0.92, 0.95];
const WORD_ROWS = 8;
const CAPTION = 'pb-1 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted';

const percent = (value: number) => `${Math.round(value * 100)}%`;
const signed = (days: number) => (days === 0 ? 'same day' : `${days > 0 ? '+' : '−'}${Math.abs(days)} d`);

type Days = SimulationResponse['nextDue']['days'];

/** Thirty separate days is a lot to read; three stretches say the same thing. */
function stretches(days: Days): Array<{ label: string; mastery: number; fsrs: number }> {
  const total = (from: number, to: number) =>
    days.slice(from, to).reduce((sum, day) => ({ mastery: sum.mastery + day.mastery, fsrs: sum.fsrs + day.fsrs }), {
      mastery: 0,
      fsrs: 0,
    });
  return [
    { label: 'Today or earlier', ...total(0, 1) },
    { label: 'The next 7 days', ...total(1, 8) },
    { label: `Days 8 to ${days.length - 1}`, ...total(8, days.length) },
  ];
}

function Comparison({ caption, rows }: { caption: string; rows: Array<{ label: string; mastery: number; fsrs: number }> }) {
  return (
    <table className="w-full text-left text-sm">
      <caption className={CAPTION}>{caption}</caption>
      <thead className="text-xs text-muted">
        <tr>
          <th scope="col" className="py-1 font-medium">
            When
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
        {rows.map((row) => (
          <tr key={row.label} className="border-t border-line">
            <th scope="row" className="py-1 font-normal">
              {row.label}
            </th>
            <td className="py-1 text-right">{row.mastery}</td>
            <td className="py-1 text-right">{row.fsrs}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ result }: { result: SimulationResponse }) {
  const { history, words, nextDue, ifAllRemembered, cards, retention } = result;
  const leftOut = [
    history.leftOut.undone > 0 ? `${count(history.leftOut.undone, 'record')} of answers taken back with Undo` : null,
    history.leftOut.practice > 0 ? count(history.leftOut.practice, 'practice answer') : null,
    history.leftOut.otherWords > 0
      ? `${count(history.leftOut.otherWords, 'answer')} to words that are now mastered or in the trash`
      : null,
  ].filter((part) => part !== null);

  return (
    <div className="flex flex-col gap-3">
      {history.reviews === 0 ? (
        <p className="text-sm">
          There are no saved answers to replay yet, so FSRS has nothing to go on and every word stays on its mastery
          date. Review for a while and compare again.
        </p>
      ) : (
        <p className="text-sm">
          Worked out from <strong className="font-semibold tabular-nums">{count(history.reviews, 'saved answer')}</strong>{' '}
          to <span className="tabular-nums">{words.replayed}</span> of your{' '}
          <span className="tabular-nums">{count(words.active, 'active word')}</span>, given between {history.firstDay} and{' '}
          {history.lastDay}. The fewer answers a word has, the rougher FSRS’s date for it.
        </p>
      )}
      <ul className={`${HELP} flex list-disc flex-col gap-1 pl-5`}>
        <li>
          The mastery column is your schedule as it stands. The FSRS column replays your saved answers, at the times you
          gave them, with a target of {percent(retention)}.
        </li>
        <li>
          A word is treated as new at its first saved answer. Nothing is assumed about reviews from before the history
          began.
        </li>
        {words.unseen > 0 && (
          <li>
            {count(words.unseen, 'word')} {words.unseen === 1 ? 'has' : 'have'} no saved answer. FSRS knows nothing about{' '}
            {words.unseen === 1 ? 'it' : 'them'}, so {words.unseen === 1 ? 'it keeps its' : 'they keep their'} mastery{' '}
            {words.unseen === 1 ? 'date' : 'dates'} until first answered.
          </li>
        )}
        {leftOut.length > 0 && <li>Not replayed: {leftOut.join('; ')}.</li>}
        <li>Nothing here is saved, and no review date changes.</li>
      </ul>

      {words.active > 0 && (
        <>
          <Comparison
            caption={`When each of your ${words.active} active words next falls due`}
            rows={[...stretches(nextDue.days), { label: `After ${nextDue.days.length} days`, ...nextDue.later }]}
          />

          {ifAllRemembered !== null && (
            <>
              <Comparison
                caption={`Reviews in the next ${ifAllRemembered.days.length} days, if you remembered every word`}
                rows={[...stretches(ifAllRemembered.days), { label: 'Total', ...ifAllRemembered.totals }]}
              />
              <p className={HELP}>
                This is a scenario, not a forecast. It assumes every review is answered Remember on the day it falls
                due, which shows how each schedule spaces reviews out. Forgetting a word brings it back sooner under
                both, so real numbers will be higher. It says nothing about how well you would remember under either.
              </p>
            </>
          )}

          {/* Five columns do not fit a phone: the table keeps its width and scrolls sideways instead. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] whitespace-nowrap text-left text-sm">
              <caption className={`${CAPTION} sticky left-0`}>Next review, word by word</caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="py-1 font-medium">
                    Word
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Saved answers
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Mastery schedule
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    FSRS at {percent(retention)}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Difference
                  </th>
                </tr>
              </thead>
              <tbody>
                {cards.slice(0, WORD_ROWS).map((card) => (
                  <tr key={card.id} className="border-t border-line">
                    <th scope="row" className="max-w-40 truncate py-1 font-medium">
                      {card.word}
                    </th>
                    <td className="py-1 text-right tabular-nums">{card.reviews}</td>
                    <td className="py-1 tabular-nums">{card.masteryDue}</td>
                    <td className="py-1 tabular-nums">{card.reviews === 0 ? `${card.fsrsDue} (unchanged)` : card.fsrsDue}</td>
                    <td className="py-1 text-right tabular-nums">{signed(card.differenceDays)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {words.active > WORD_ROWS && (
            <p className={HELP}>Showing the {WORD_ROWS} words FSRS would bring back soonest, of {words.active}.</p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A what-if look at the two schedules before choosing between them, worked
 * out on request from the answers actually saved. It never changes anything.
 */
export function ScheduleSimulation({ defaultRetention }: { defaultRetention: number }) {
  const { api } = useApp();
  const [target, setTarget] = useState(defaultRetention);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (retention: number) => {
    if (loading) return;
    setTarget(retention);
    setLoading(true);
    setError(null);
    try {
      setResult(await api.fetchSimulation(retention));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not work out the comparison.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-sm font-semibold tracking-tight">Try it on your saved answers</h3>
      <p className={HELP}>
        See where FSRS would put each word if it had been in charge of the answers you have already saved, at any target
        you like, next to your schedule as it stands. This only looks; it changes nothing.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="simulation-target" className="text-sm font-medium">
            Target retention to try
          </label>
          <select
            id="simulation-target"
            className={INPUT}
            value={target}
            disabled={loading}
            onChange={(event) => {
              const next = Number(event.target.value);
              // Before the first comparison the choice only sets what the button will use.
              if (result === null) setTarget(next);
              else void run(next);
            }}
          >
            {[...new Set([...TARGETS, defaultRetention, target])]
              .sort((a, b) => a - b)
              .map((value) => (
                <option key={value} value={value}>
                  {percent(value)}
                  {value === defaultRetention ? ' (your setting)' : ''}
                </option>
              ))}
          </select>
        </div>
        <button type="button" className={BUTTON_SECONDARY} disabled={loading} onClick={() => void run(target)}>
          {loading && <Spinner />}
          {result === null ? 'Compare' : 'Compare again'}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-bad-ink">
          {error}
        </p>
      )}
      {result !== null &&
        (result.available ? (
          <div aria-live="polite" className={loading ? 'opacity-60' : ''}>
            <Result result={result} />
          </div>
        ) : (
          <p className="text-sm text-muted">This needs the database’s latest update before it can be worked out.</p>
        ))}
    </div>
  );
}
