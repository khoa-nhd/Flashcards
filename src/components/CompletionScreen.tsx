import { useEffect, useState } from 'react';
import type { DayPlanResponse, SessionSummary } from '../../shared/api.js';
import { useApp, useCounting } from '../app-context.js';
import { formatDuration } from '../lib/format.js';
import { FOCUS_TEXT, SELECT_TEXT, type FocusText } from '../lib/review-focus.js';
import { ROUTES } from '../lib/router.js';
import { canUndo, type SessionState } from '../lib/session-machine.js';
import { GoalProgress, hasGoal } from './GoalStatus.js';
import { Link } from './Link.js';
import { RefusedAnswersPanel } from './RefusedAnswersPanel.js';
import { SkippedNotice } from './SkippedNotice.js';

export interface CompletionScreenProps {
  state: SessionState;
  /** The sitting that just ended, for asking the server what it saved. */
  sessionId: string;
  onReload: () => void;
  onUndo: () => void;
  /** Sends a refused answer again. */
  onRetry: (requestId: string) => void;
  /** Gives up on a refused answer for good. */
  onDismiss: (requestId: string) => void;
  /** Words that left the weak list during this session, named for the reviewer. */
  recovered?: readonly string[];
}

type Loaded = { for: string; summary: SessionSummary | null };

export function CompletionScreen({ state, sessionId, onReload, onUndo, onRetry, onDismiss, recovered = [] }: CompletionScreenProps) {
  const { api } = useApp();
  const counting = useCounting();
  const { meta, tally } = state;
  const total = state.cards.length;
  const preview = meta !== null && !meta.writesEnabled;
  const answered = tally.remember + tally.notRemember;
  const pending = state.pending.length;
  // Re-read once the last answer has settled, so the counts are the server's own.
  const settled = pending > 0 ? 'saving' : 'settled';
  // The server's own account of the session, where it keeps one. Asked for again whenever the count changes.
  const wanted =
    meta?.capabilities.sessions === true && !preview && answered > 0 ? `${sessionId}:${answered}:${settled}` : null;
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
  const showAccuracy = accuracy !== null && !preview;

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
  const focus: Pick<FocusText, 'emptyTitle' | 'emptyDetail' | 'done'> | null =
    meta?.selection === true ? SELECT_TEXT : meta?.focus == null ? null : FOCUS_TEXT[meta.focus];
  if (focus !== null) {
    emptyTitle = focus.emptyTitle;
    emptyDetail = focus.emptyDetail;
  }

  // Today's figures against the daily goal, re-read whenever another answer has been saved.
  const goalWanted =
    meta?.capabilities.goals === true && !preview && total > 0 ? `${sessionId}:${answered}:${settled}` : null;
  const [plan, setPlan] = useState<{ for: string; plan: DayPlanResponse } | null>(null);
  useEffect(() => {
    if (goalWanted === null) return;
    let current = true;
    api
      .fetchPlan()
      .then((next) => current && setPlan({ for: goalWanted, plan: next }))
      // The goal is a nicety on this screen; without it the summary still stands.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api, goalWanted]);
  const goal = plan !== null && plan.for === goalWanted ? plan.plan : null;

  const lastWord = state.lastSaved === null ? null : (state.cards[state.lastSaved.index]?.word ?? null);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-lg flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      <div className="w-full">
        <h2 className="font-serif text-[2.25rem] font-semibold leading-[1.08] tracking-[-0.025em]">
          {total === 0 ? emptyTitle : `${total} ${total === 1 ? 'word' : 'words'}, done.`}
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
          {total === 0
            ? emptyDetail
            : `You went through ${total} ${total === 1 ? 'card' : 'cards'} in this session.`}
          {total > 0 && focus !== null && ` ${focus.done}`}
          {total > 0 && preview && ' This was a preview, so no answers were saved.'}
        </p>
      </div>

      {total > 0 && (
        <div className="w-full">
          <dl
            className={`grid divide-x divide-line overflow-hidden rounded-2xl border border-line bg-surface text-center ${
              showAccuracy ? 'grid-cols-3' : 'grid-cols-2'
            }`}
            aria-label="Session summary"
          >
            <div className="px-3 py-4">
              <dd className="font-serif text-[1.75rem] font-semibold leading-none tabular-nums text-ink">{remembered}</dd>
              <dt className="mt-2 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-faint">Remembered</dt>
            </div>
            <div className="px-3 py-4">
              <dd className="font-serif text-[1.75rem] font-semibold leading-none tabular-nums text-ink">{notRemembered}</dd>
              <dt className="mt-2 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-faint">
                Not remembered
              </dt>
            </div>
            {showAccuracy && (
              <div className="px-3 py-4">
                <dd className="font-serif text-[1.75rem] font-semibold leading-none tabular-nums text-ink">{accuracy}%</dd>
                <dt className="mt-2 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-faint">Accuracy</dt>
              </div>
            )}
          </dl>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted">
            {summary !== null && summary.timedReviews > 0 && (
              <span>{formatDuration(summary.durationMs)} on cards</span>
            )}
            {summary !== null && summary.reviewed > 0 && (
              <span>
                <span className="font-semibold tabular-nums text-ink">{summary.firstTime}</span> first time ·{' '}
                <span className="font-semibold tabular-nums text-ink">{summary.seenBefore}</span> reviewed before
                {summary.undone > 0 && (
                  <>
                    {' '}
                    · <span className="font-semibold tabular-nums text-ink">{summary.undone}</span> undone
                  </>
                )}
              </span>
            )}
            {tally.skipped > 0 && (
              <span className="text-warn-ink">{tally.skipped} not saved, so left out of the counts</span>
            )}
          </div>
        </div>
      )}

      {summary !== null && <p className="-mt-3 text-xs text-faint">These are the answers that were saved.</p>}

      {!counting && reviewed > 0 && (
        <p className="w-full rounded-2xl border border-line px-4 py-3 text-left text-sm text-muted">
          Counting towards mastery was off, so those answers left every word’s mastery and review date as they were.
          They are still saved, and still count in your accuracy, streak and daily goal.
        </p>
      )}

      {recovered.length > 0 && (
        <p className="w-full rounded-2xl bg-good-soft px-4 py-3 text-left text-sm text-good-ink">
          {recovered.length === 1
            ? `“${recovered[0]}” has left your weak list.`
            : `${recovered.length} words have left your weak list: ${recovered.join(', ')}.`}
        </p>
      )}

      {goal !== null && hasGoal(goal) && (
        <div className="w-full rounded-2xl border border-line px-4 py-3 text-left">
          <GoalProgress plan={goal} />
        </div>
      )}
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

      {pending > 0 && (
        <p className="text-sm text-muted">
          Saving {pending === 1 ? 'your last answer' : `${pending} answers`}… They are kept on this device if the
          connection drops.
        </p>
      )}

      {state.refused.length > 0 && (
        <div className="w-full text-left">
          <RefusedAnswersPanel answers={state.refused} onRetry={onRetry} onDismiss={onDismiss} />
        </div>
      )}

      <div className="flex w-full flex-col items-stretch gap-2">
        <button
          type="button"
          autoFocus
          onClick={onReload}
          className="h-12 cursor-pointer rounded-xl bg-accent px-6 font-semibold text-on-accent transition hover:bg-accent-hover active:scale-[0.98] focus-visible:outline-on-accent"
        >
          Check for more cards
        </button>
        {state.lastSaved !== null && (
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo(state)}
            className="h-11 cursor-pointer rounded-xl border border-line-strong px-6 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
          >
            {state.undoing ? 'Undoing…' : `Undo the last answer${lastWord === null ? '' : ` (${lastWord})`}`}
          </button>
        )}
        {focus !== null && (
          <Link
            to={ROUTES.review}
            className="flex h-11 items-center justify-center rounded-xl border border-line-strong px-6 text-sm font-semibold"
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
