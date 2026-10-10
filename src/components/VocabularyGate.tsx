import type { ReactNode } from 'react';
import { useApp } from '../app-context.js';
import type { VocabularyState } from '../lib/vocabulary-store.js';
import { Spinner } from './Spinner.js';
import { BUTTON_PRIMARY } from './ui.js';

/**
 * The loading, failure and "refresh failed" states every vocabulary page
 * shares. Children render once there is data to show.
 */
export function VocabularyGate({ state, children }: { state: VocabularyState; children: ReactNode }) {
  const { vocabulary } = useApp();

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <p role="status" className="flex items-center justify-center gap-3 py-20 text-muted">
        <Spinner className="size-5" />
        Loading your vocabulary…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h2 className="font-serif text-2xl font-semibold">Could not load your vocabulary</h2>
        <p role="alert" className="max-w-md text-sm text-muted">
          {state.error?.message}
        </p>
        <button type="button" className={BUTTON_PRIMARY} onClick={() => void vocabulary.reload()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <>
      {state.error !== null && (
        <p role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink">
          <span>Could not refresh, so this may be out of date. {state.error.message}</span>
          <button type="button" className="cursor-pointer font-semibold underline" onClick={() => void vocabulary.reload()}>
            Retry
          </button>
        </p>
      )}
      {state.meta !== null && !state.meta.writesEnabled && (
        <p className="mb-4 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink">
          Saving is switched off, so words can be viewed but not added, edited or deleted.
        </p>
      )}
      {children}
    </>
  );
}
