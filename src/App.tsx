import { CompletionScreen } from './components/CompletionScreen.js';
import { ReviewScreen } from './components/ReviewScreen.js';
import { Spinner } from './components/Spinner.js';
import { UnlockScreen } from './components/UnlockScreen.js';
import { useReviewSession } from './hooks/useReviewSession.js';
import { reviewApi, type ReviewApi } from './lib/api-client.js';
import type { SessionMeta } from './lib/session-machine.js';

function ModeBadge({ meta }: { meta: SessionMeta | null }) {
  if (meta === null) return null;
  if (meta.mode === 'mock') {
    return (
      <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
        Sample data
      </span>
    );
  }
  if (!meta.writesEnabled) {
    return (
      <span
        className="rounded-full bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn-ink"
        title="Answers are checked against Notion but nothing is written."
      >
        Preview · not saving
      </span>
    );
  }
  return null;
}

export function App({ api = reviewApi }: { api?: ReviewApi }) {
  const { state, session } = useReviewSession(api);
  const { status, error } = state;
  const reload = () => void session.load();
  const unlocking = status === 'error' && error?.kind === 'load' && error.unauthorized;

  let content;
  if (status === 'loading') {
    content = (
      <div role="status" className="flex h-full items-center justify-center gap-3 text-muted">
        <Spinner className="size-5" />
        Loading your review queue…
      </div>
    );
  } else if (unlocking) {
    content = <UnlockScreen api={api} onUnlocked={reload} />;
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
    content = (
      <CompletionScreen total={state.cards.length} tally={state.tally} meta={state.meta} onReload={reload} />
    );
  } else {
    content = <ReviewScreen state={state} session={session} onReload={reload} />;
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-xl items-center justify-between gap-3 px-4 pb-1 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold tracking-tight">Vocabulary review</h1>
          <ModeBadge meta={state.meta} />
        </div>
        {!unlocking && (
          <button
            type="button"
            onClick={reload}
            aria-disabled={status === 'saving' || status === 'loading'}
            title="Reload the queue from Notion. Does not change any review data."
            className="flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 text-sm font-medium text-muted transition hover:text-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Refresh
          </button>
        )}
      </header>
      <main className="min-h-0 flex-1">{content}</main>
    </div>
  );
}
