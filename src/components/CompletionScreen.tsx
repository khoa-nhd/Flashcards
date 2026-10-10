import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../shared/api.js';
import { useApp } from '../app-context.js';
import { ROUTES } from '../lib/router.js';
import { canUndo, type SessionState } from '../lib/session-machine.js';
import { Link } from './Link.js';
import { SkippedNotice } from './SkippedNotice.js';

export interface CompletionScreenProps {
  state: SessionState;
  /** The sitting that just ended, for asking the server what it saved. */
  sessionId: string;
  onReload: () => void;
  onUndo: () => void;
}

/** "1 min 05 s", or "42 s" under a minute. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
}

type Loaded = { for: string; summary: SessionSummary | null };

export function CompletionScreen({ state, sessionId, onReload, onUndo }: CompletionScreenProps) {
  const { api } = useApp();
  const { meta, tally } = state;
  const total = state.cards.length;
  const preview = meta !== null && !meta.writesEnabled;
  const answered = tally.remember + tally.notRemember;
  // The server's own account of the session, where it keeps one. Asked for again whenever the count changes.
  const wanted = meta?.capabilities.sessions === true && !preview && answered > 0 ? `${sessionId}:${answered}` : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (wanted === null) return;
    let current = true;
    api
      .fetchSessionSummary(sessionId)
      .then((summary) => current && setLoaded({ for: wanted, summary }))
      .catch(() => current && setLoaded({ for: wanted, summary: null }));
    return () => {
      current = false;
    };
  }, [api, sessionId, wanted]);

  const summary = loaded !== null && loaded.for === wanted ? loaded.summary : null;
  const summaryFailed = wanted !== null && loaded !== null && loaded.for === wanted && loaded.summary === null;
  // Saved numbers when the server has them; otherwise what this device saw confirmed.
  const remembered = summary?.remembered ?? tally.remember;
  const notRemembered = summary?.notRemembered ?? tally.notRemember;
  const reviewed = summary?.reviewed ?? answered;
  const accuracy = reviewed === 0 ? null : Math.round((remembered / reviewed) * 100);

  // An empty queue has three different causes; say which one this is.
  let emptyTitle = 'Nothing is due right now';
  let emptyDetail = 'No vocabulary is waiting for review.';
  if (meta?.vocabulary === 'all_mastered') {
    emptyTitle = 'Every word is mastered';
    emptyDetail = 'All of your vocabulary has reached full mastery, so there is nothing left to review.';
  } else if (meta?.vocabulary === 'empty') {
    emptyTitle = 'No vocabulary yet';
    emptyDetail = 'Add your first word to start reviewing.';
  }
  // A narrowed queue being empty says nothing about the rest of the vocabulary.
  const weakOnly = meta?.focus === 'weak';
  if (weakOnly) {
    emptyTitle = 'No weak words are due';
    emptyDetail = 'None of the words that need attention is due for review right now.';
  }

  const lastWord = state.lastSaved === null ? null : (state.cards[state.lastSaved.index]?.word ?? null);

  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div
        aria-hidden="true"
        className="flex size-16 items-center justify-center rounded-full bg-good-soft text-good-ink"
      >
        <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div>
        <h2 className="font-serif text-3xl font-semibold">
          {total === 0 ? emptyTitle : 'Review complete'}
        </h2>
        <p className="mt-2 text-muted">
          {total === 0
            ? emptyDetail
            : `You went through ${total} ${total === 1 ? 'card' : 'cards'} in this session.`}
          {total > 0 && weakOnly && ' They were your weakest words among those due.'}
          {total > 0 && preview && ' This was a preview, so no answers were saved.'}
        </p>
      </div>

      {total > 0 && (
        <dl className="grid w-full grid-cols-2 gap-3" aria-label="Session summary">
          <div className="rounded-2xl bg-good-soft px-4 py-3 text-good-ink">
            <dd className="text-2xl font-semibold tabular-nums">{remembered}</dd>
            <dt className="text-sm">Remembered</dt>
          </div>
          <div className="rounded-2xl bg-bad-soft px-4 py-3 text-bad-ink">
            <dd className="text-2xl font-semibold tabular-nums">{notRemembered}</dd>
            <dt className="text-sm">Not remembered</dt>
          </div>
          {accuracy !== null && !preview && (
            <div className="rounded-2xl border border-line px-4 py-3">
              <dd className="text-2xl font-semibold tabular-nums">{accuracy}%</dd>
              <dt className="text-sm text-muted">
                Accuracy <span className="whitespace-nowrap">({remembered} of {reviewed})</span>
              </dt>
            </div>
          )}
          {summary !== null && summary.timedReviews > 0 && (
            <div className="rounded-2xl border border-line px-4 py-3">
              <dd className="text-2xl font-semibold tabular-nums">{formatDuration(summary.durationMs)}</dd>
              <dt className="text-sm text-muted">Time on cards</dt>
            </div>
          )}
          {summary !== null && summary.reviewed > 0 && (
            <div className="col-span-2 rounded-2xl border border-line px-4 py-3 text-sm text-muted">
              <dt className="sr-only">New and reviewed before</dt>
              <dd>
                <span className="font-semibold text-ink tabular-nums">{summary.firstTime}</span> reviewed for the first
                time · <span className="font-semibold text-ink tabular-nums">{summary.seenBefore}</span> reviewed before
                {summary.undone > 0 && (
                  <>
                    {' '}
                    · <span className="font-semibold text-ink tabular-nums">{summary.undone}</span> undone
                  </>
                )}
              </dd>
            </div>
          )}
          {tally.skipped > 0 && (
            <div className="col-span-2 rounded-2xl bg-warn-soft px-4 py-3 text-warn-ink">
              <dd className="text-2xl font-semibold tabular-nums">{tally.skipped}</dd>
              <dt className="text-sm">Skipped because they changed on another device</dt>
            </div>
          )}
        </dl>
      )}

      {summary !== null && <p className="-mt-3 text-xs text-muted">These are the answers that were saved.</p>}
      {summaryFailed && (
        <p className="-mt-3 text-xs text-muted">
          Counted on this device from confirmed saves; the saved summary could not be loaded.
        </p>
      )}

      {state.undoError !== null && (
        <p role="alert" className="w-full rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {state.undoError}
        </p>
      )}

      <div className="flex w-full flex-col items-stretch gap-2">
        <button
          type="button"
          autoFocus
          onClick={onReload}
          className="h-12 cursor-pointer rounded-2xl bg-accent px-6 font-semibold text-white transition active:scale-[0.98] dark:text-paper"
        >
          Check for more cards
        </button>
        {state.lastSaved !== null && (
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo(state)}
            className="h-11 cursor-pointer rounded-2xl border border-line px-6 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
          >
            {state.undoing ? 'Undoing…' : `Undo the last answer${lastWord === null ? '' : ` (${lastWord})`}`}
          </button>
        )}
        {weakOnly && (
          <Link
            to={ROUTES.review}
            className="flex h-11 items-center justify-center rounded-2xl border border-line px-6 text-sm font-semibold"
          >
            Review everything due
          </Link>
        )}
        {total > 0 && (
          <Link to={ROUTES.dashboard} className="py-2 text-sm font-semibold text-accent underline-offset-2 hover:underline">
            Finish
          </Link>
        )}
      </div>

      {meta !== null && (
        <div className="w-full text-left">
          <SkippedNotice skipped={meta.skipped} />
        </div>
      )}
    </div>
  );
}
