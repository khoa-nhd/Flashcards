import { useEffect, useState } from 'react';
import type { DayPlanResponse, SessionSummary } from '../../shared/api.js';
import { useApp } from '../app-context.js';
import { formatDuration } from '../lib/format.js';
import { FOCUS_TEXT, type FocusText } from '../lib/review-focus.js';
import { ROUTES } from '../lib/router.js';
import { canUndo, isSaving, saveIssue, type SessionState } from '../lib/session-machine.js';
import { GoalProgress, hasGoal } from './GoalStatus.js';
import { Link } from './Link.js';
import { SaveIssuePanel } from './SaveIssuePanel.js';
import { SkippedNotice } from './SkippedNotice.js';

export interface CompletionScreenProps {
  state: SessionState;
  /** The sitting that just ended, for asking the server what it saved. */
  sessionId: string;
  onReload: () => void;
  onUndo: () => void;
  /** Repeats an answer that would not save. */
  onRetry: () => void;
  /** Gives up on an answer that would not save. */
  onDiscard: () => void;
  /** Passes a card whose record changed elsewhere. */
  onSkip: () => void;
}

type Loaded = { for: string; summary: SessionSummary | null };

export function CompletionScreen({ state, sessionId, onReload, onUndo, onRetry, onDiscard, onSkip }: CompletionScreenProps) {
  const { api } = useApp();
  const { meta, tally } = state;
  const total = state.cards.length;
  const preview = meta !== null && !meta.writesEnabled;
  const answered = tally.remember + tally.notRemember;
  const saving = isSaving(state);
  const issue = saveIssue(state);
  const issueWord = state.failed === null ? null : (state.cards[state.failed.index]?.word ?? null);
  // Re-read once the last answer has settled, so the counts are the server's own.
  const settled = saving ? 'saving' : 'settled';
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
    meta?.collection != null
      ? {
          emptyTitle: 'Nothing in this collection is due',
          emptyDetail: `None of the words in “${meta.collection.name}” is due for review right now.`,
          done: `They were the due words in “${meta.collection.name}”.`,
        }
      : meta?.focus == null
        ? null
        : FOCUS_TEXT[meta.focus];
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
          {total > 0 && focus !== null && ` ${focus.done}`}
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

      {saving && <p className="text-sm text-muted">Saving your last answer…</p>}

      {issue !== null && (
        <div className="w-full text-left">
          <SaveIssuePanel
            kind={issue.kind}
            message={issue.message}
            word={issueWord}
            onRetry={onRetry}
            onDiscard={onDiscard}
            onReload={onReload}
            onSkip={onSkip}
          />
        </div>
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
        {focus !== null && (
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
