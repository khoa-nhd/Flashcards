import { useEffect, useRef } from 'react';
import type { RefusedAnswer } from '../lib/session-machine.js';

const PANEL_BUTTON =
  'h-11 cursor-pointer rounded-xl border px-4 text-sm font-semibold transition active:scale-[0.98]';

export interface RefusedAnswersPanelProps {
  /** Answers the server would not take, each waiting for a retry or a dismissal. */
  answers: RefusedAnswer[];
  /** Sends one answer again. */
  onRetry: (requestId: string) => void;
  /** Gives up on one answer for good; it stays out of the counts. */
  onDismiss: (requestId: string) => void;
}

/**
 * The answers the server refused, listed beside the current card. They are
 * never in the way — the session has already moved on — so this only says what
 * happened and offers the two ways out: send an answer again, or let it go.
 */
export function RefusedAnswersPanel({ answers, onRetry, onDismiss }: RefusedAnswersPanelProps) {
  const primary = useRef<HTMLButtonElement>(null);
  const first = answers[0]?.requestId ?? null;
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [first]);

  if (answers.length === 0) return null;

  return (
    <div role="alert" className="rounded-2xl border border-bad/40 bg-bad-soft p-4 text-bad-ink">
      <p className="font-semibold">
        {answers.length === 1 ? 'One answer was not saved' : `${answers.length} answers were not saved`}
      </p>
      <ul className="mt-2 flex flex-col gap-3">
        {answers.map((answer, at) => (
          <li key={answer.requestId} className="flex flex-col gap-1 border-t border-bad/20 pt-3 first:border-t-0 first:pt-0">
            <p className="text-sm">
              <strong className="font-semibold">“{answer.word}”</strong>{' '}
              {answer.kind === 'conflict'
                ? 'changed on another device, so this answer could not be saved.'
                : 'could not be saved.'}
            </p>
            <p className="text-sm">{answer.message}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                ref={at === 0 ? primary : undefined}
                type="button"
                className={`${PANEL_BUTTON} border-bad bg-bad text-white dark:text-paper`}
                onClick={() => onRetry(answer.requestId)}
              >
                Retry
              </button>
              <button
                type="button"
                className={`${PANEL_BUTTON} border-bad/40`}
                onClick={() => onDismiss(answer.requestId)}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
