import { useEffect, useRef } from 'react';

const PANEL_BUTTON =
  'h-11 cursor-pointer rounded-xl border px-4 text-sm font-semibold transition active:scale-[0.98]';

export interface SaveIssuePanelProps {
  kind: 'save' | 'conflict';
  message: string;
  /** The word whose answer this was, when it is known. */
  word: string | null;
  onRetry: () => void;
  /** Gives up on an answer that will not save and lets the session go on. */
  onDiscard: () => void;
  onReload: () => void;
  onSkip: () => void;
}

/**
 * The one place a save that needs the reviewer's attention is shown. The card
 * has already moved on, so this sits beside the current one and says which
 * answer it is about rather than freezing a stale card.
 */
export function SaveIssuePanel({ kind, message, word, onRetry, onDiscard, onReload, onSkip }: SaveIssuePanelProps) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, []);

  const about = word === null ? 'Your last answer' : `Your answer to “${word}”`;

  return (
    <div role="alert" className="rounded-2xl border border-bad/40 bg-bad-soft p-4 text-bad-ink">
      <p className="font-semibold">
        {kind === 'conflict' ? `${about} could not be saved: the card changed on another device` : `${about} was not saved`}
      </p>
      <p className="mt-1 text-sm">{message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {kind === 'save' ? (
          <>
            <button
              ref={primary}
              type="button"
              className={`${PANEL_BUTTON} border-bad bg-bad text-white dark:text-paper`}
              onClick={onRetry}
            >
              Retry
            </button>
            <button type="button" className={`${PANEL_BUTTON} border-bad/40`} onClick={onDiscard}>
              Discard answer
            </button>
          </>
        ) : (
          <>
            <button
              ref={primary}
              type="button"
              className={`${PANEL_BUTTON} border-bad bg-bad text-white dark:text-paper`}
              onClick={onReload}
            >
              Reload queue
            </button>
            <button type="button" className={`${PANEL_BUTTON} border-bad/40`} onClick={onSkip}>
              Skip this card
            </button>
          </>
        )}
      </div>
    </div>
  );
}
