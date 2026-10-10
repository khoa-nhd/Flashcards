import { useMemo, useState } from 'react';
import type { WeakWordView } from '../../shared/api.js';
import { useApp } from '../app-context.js';
import { MasteryPill } from '../components/badges.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, PAGE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ROUTES, buildHref, openWord } from '../lib/router.js';

type Severity = WeakWordView['severity'];

const SEVERITY_TEXT: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const SEVERITY_TONE: Record<Severity, string> = {
  high: 'bg-bad-soft text-bad-ink',
  medium: 'bg-warn-soft text-warn-ink',
  low: 'bg-line/50 text-muted',
};
const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

function recentText(word: WeakWordView, windowDays: number): string {
  if (word.recent === null) return 'No saved reviews yet.';
  if (word.recent.reviews === 0) return `No reviews in the last ${windowDays} days.`;
  return `Remembered ${word.recent.remembered} of ${word.recent.reviews} ${
    word.recent.reviews === 1 ? 'review' : 'reviews'
  } in the last ${windowDays} days.`;
}

/** Words that need attention, weakest first, each with the reasons it is listed. */
export function WeakWordsPage() {
  const { api } = useApp();
  const weak = useRemote(api.fetchWeakWords, 'Could not load your weak words.');
  const [severity, setSeverity] = useState<Severity | null>(null);

  const words = useMemo(() => weak.data?.words ?? [], [weak.data]);
  const counts = useMemo(() => {
    const totals: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
    for (const word of words) totals[word.severity] += 1;
    return totals;
  }, [words]);
  const shown = severity === null ? words : words.filter((word) => word.severity === severity);
  const dueNow = words.filter((word) => word.reviewable).length;

  return (
    <div className={PAGE}>
      <PageHeader
        title="Weak words"
        description="Words that need attention, weakest first, and why each one is here."
        actions={
          <>
            <button
              type="button"
              className={BUTTON_SECONDARY}
              onClick={weak.reload}
              disabled={weak.status === 'loading'}
            >
              <Icon name="refresh" className="size-4" />
              Refresh
            </button>
            {dueNow > 0 && (
              <Link to={buildHref(ROUTES.review, { focus: 'weak' })} className={BUTTON_PRIMARY}>
                <Icon name="review" className="size-4" /> Review my weakest words
              </Link>
            )}
          </>
        }
      />

      {weak.status === 'loading' && (
        <p role="status" className="flex items-center gap-3 text-muted">
          <Spinner className="size-5" />
          Loading your weak words…
        </p>
      )}

      {weak.status === 'failed' && (
        <div className={`${CARD} flex flex-col items-start gap-3 p-5`}>
          <p role="alert" className="text-sm text-bad-ink">
            {weak.error}
          </p>
          <button type="button" className={BUTTON_SECONDARY} onClick={weak.reload}>
            Try again
          </button>
        </div>
      )}

      {weak.status === 'ready' && (
        <div className="flex flex-col gap-4">
          {!weak.data.historyAvailable && (
            <p className={`${CARD} px-4 py-3 text-sm text-muted`}>
              Review history is not available until the database has its latest update, so words are judged here only
              on how long they have been overdue and on missing content.
            </p>
          )}

          {words.length === 0 ? (
            <div className={`${CARD} p-6 text-center`}>
              <h2 className="font-serif text-2xl font-semibold">Nothing stands out</h2>
              <p className="mt-2 text-sm text-muted">
                No word has been forgotten repeatedly, left overdue for long, or is missing content.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show priority">
                {([null, ...SEVERITIES] as Array<Severity | null>).map((key) => {
                  const count = key === null ? words.length : counts[key];
                  return (
                    <button
                      key={key ?? 'all'}
                      type="button"
                      aria-pressed={severity === key}
                      onClick={() => setSeverity(key)}
                      className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium ${
                        severity === key
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-line bg-surface text-muted hover:text-ink'
                      }`}
                    >
                      {key === null ? 'All' : SEVERITY_TEXT[key]} <span className="tabular-nums">({count})</span>
                    </button>
                  );
                })}
              </div>

              <p className={HELP}>
                {weak.data.total > words.length
                  ? `Showing the ${words.length} weakest of ${weak.data.total} words. `
                  : ''}
                {dueNow === 0
                  ? 'None of these is due for review right now.'
                  : `${dueNow} ${dueNow === 1 ? 'is' : 'are'} due for review now.`}{' '}
                A focused review only includes words that are already due, so it never brings a word forward.
              </p>

              {shown.length === 0 ? (
                <p className="text-sm text-muted">No words at this priority.</p>
              ) : (
                <ul className={`${CARD} m-0 flex list-none flex-col divide-y divide-line p-0`}>
                  {shown.map((word) => {
                    const [main, ...others] = word.reasons;
                    return (
                      <li key={word.id} className="flex flex-col gap-1.5 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openWord(word.id)}
                            className="cursor-pointer text-left text-base font-semibold underline-offset-2 hover:underline"
                          >
                            {word.word}
                          </button>
                          <span
                            className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_TONE[word.severity]}`}
                          >
                            {SEVERITY_TEXT[word.severity]}
                            <span className="sr-only"> priority</span>
                          </span>
                          <MasteryPill mastery={word.mastery} />
                          {word.reviewable && (
                            <span className="inline-flex whitespace-nowrap rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                              Due now
                            </span>
                          )}
                        </div>
                        <p className="text-sm">{main?.detail}</p>
                        {others.length > 0 && (
                          <p className="text-xs text-muted">Also: {others.map((reason) => reason.detail).join(' ')}</p>
                        )}
                        <p className="text-xs text-muted">{recentText(word, weak.data.windowDays)}</p>
                        <p className="text-sm">
                          <span className="text-muted">Suggested: </span>
                          {word.action}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}

              <details className={`${CARD} px-4 py-3 text-sm`}>
                <summary className="cursor-pointer font-medium">How this list is made</summary>
                <ul className="m-0 mt-2 flex list-disc flex-col gap-1 pl-4 text-muted">
                  <li>Being forgotten on several separate days counts the most.</li>
                  <li>
                    Then: recent misses, a low share remembered recently, and slipping after reaching a high mastery.
                  </li>
                  <li>Waiting a week or more past its review date adds a little; missing content adds the least.</li>
                  <li>Only answers that were saved and not undone are counted. Nothing is guessed for other words.</li>
                </ul>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}
