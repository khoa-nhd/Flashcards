import type { SessionMeta, SessionTally } from '../lib/session-machine.js';
import { SkippedNotice } from './SkippedNotice.js';

export interface CompletionScreenProps {
  /** Cards that were in this session's queue. */
  total: number;
  tally: SessionTally;
  meta: SessionMeta | null;
  onReload: () => void;
}

export function CompletionScreen({ total, tally, meta, onReload }: CompletionScreenProps) {
  const preview = meta !== null && !meta.writesEnabled;

  // An empty queue has three different causes; say which one this is.
  let emptyTitle = 'Nothing is due right now';
  let emptyDetail = 'No vocabulary is waiting for review.';
  if (meta?.vocabulary === 'all_mastered') {
    emptyTitle = 'Every word is mastered';
    emptyDetail = 'All of your vocabulary has reached full mastery, so there is nothing left to review.';
  } else if (meta?.vocabulary === 'empty') {
    emptyTitle = 'No vocabulary yet';
    emptyDetail = 'The vocabulary database has no words in it.';
  }

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
          {total > 0 && preview && ' This was a preview, so no answers were saved.'}
        </p>
      </div>

      {total > 0 && (
        <dl className="grid w-full grid-cols-2 gap-3">
          <div className="rounded-2xl bg-good-soft px-4 py-3 text-good-ink">
            <dd className="text-2xl font-semibold tabular-nums">{tally.remember}</dd>
            <dt className="text-sm">Remembered</dt>
          </div>
          <div className="rounded-2xl bg-bad-soft px-4 py-3 text-bad-ink">
            <dd className="text-2xl font-semibold tabular-nums">{tally.notRemember}</dd>
            <dt className="text-sm">Not remembered</dt>
          </div>
          {tally.skipped > 0 && (
            <div className="col-span-2 rounded-2xl bg-warn-soft px-4 py-3 text-warn-ink">
              <dd className="text-2xl font-semibold tabular-nums">{tally.skipped}</dd>
              <dt className="text-sm">Skipped because they changed in Notion</dt>
            </div>
          )}
        </dl>
      )}

      <button
        type="button"
        autoFocus
        onClick={onReload}
        className="h-12 cursor-pointer rounded-2xl bg-accent px-6 font-semibold text-white transition active:scale-[0.98] dark:text-paper"
      >
        Check for more cards
      </button>

      {meta !== null && (
        <div className="w-full text-left">
          <SkippedNotice skipped={meta.skipped} />
        </div>
      )}
    </div>
  );
}
