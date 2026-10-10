import { useEffect, useSyncExternalStore } from 'react';
import { useApp } from '../app-context.js';
import { CompletionScreen } from '../components/CompletionScreen.js';
import { Icon } from '../components/Icon.js';
import { ReviewScreen } from '../components/ReviewScreen.js';
import { Spinner } from '../components/Spinner.js';
import type { SessionMeta } from '../lib/session-machine.js';
import { wording } from '../lib/source.js';

function ModeBadge({ meta }: { meta: SessionMeta | null }) {
  if (meta === null) return null;
  if (meta.mode === 'mock') {
    return (
      <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">Sample data</span>
    );
  }
  if (!meta.writesEnabled) {
    return (
      <span
        className="rounded-full bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn-ink"
        title={wording(
          meta.mode,
          'Answers are checked against Notion but nothing is written.',
          'Saving is switched off, so answers are checked but not recorded.',
        )}
      >
        Preview · not saving
      </span>
    );
  }
  return null;
}

/**
 * The flashcard review, unchanged in behaviour. The session itself lives for
 * the whole app, so leaving this tab and coming back resumes where it was.
 */
export function ReviewPage() {
  const { session, ensureReviewSession } = useApp();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const { status, error } = state;
  const reload = () => void session.load();

  useEffect(() => {
    ensureReviewSession();
  }, [ensureReviewSession]);

  let content;
  if (status === 'loading') {
    content = (
      <div role="status" className="flex h-full items-center justify-center gap-3 text-muted">
        <Spinner className="size-5" />
        Loading your review queue…
      </div>
    );
  } else if (status === 'error' && error?.kind === 'load') {
    content = (
      <div className="mx-auto flex h-full w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h2 className="font-serif text-3xl font-semibold">Could not load the queue</h2>
        <p role="alert" className="text-muted">
          {error.message}
        </p>
        <button
          type="button"
          onClick={reload}
          className="h-12 cursor-pointer rounded-2xl bg-accent px-6 font-semibold text-white dark:text-paper"
        >
          Try again
        </button>
      </div>
    );
  } else if (status === 'completed') {
    content = <CompletionScreen total={state.cards.length} tally={state.tally} meta={state.meta} onReload={reload} />;
  } else {
    content = <ReviewScreen state={state} session={session} onReload={reload} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3 px-4 pb-1 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="hidden truncate text-sm font-semibold tracking-tight md:block">Review</h1>
          <ModeBadge meta={state.meta} />
        </div>
        <button
          type="button"
          onClick={reload}
          aria-disabled={status === 'saving' || status === 'loading'}
          title={wording(
            state.meta?.mode,
            'Reload the queue from Notion. Does not change any review data.',
            'Reload the queue. Does not change any review data.',
          )}
          className="flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 text-sm font-medium text-muted transition hover:text-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        >
          <Icon name="refresh" className="size-4" />
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}
