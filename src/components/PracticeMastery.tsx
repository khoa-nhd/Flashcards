import { useCallback, useId } from 'react';
import { STUDY_MODE_LABELS } from '../../shared/study-modes.js';
import { useApp } from '../app-context.js';
import { useRemote } from '../hooks/useRemote.js';
import { ROUTES, buildHref } from '../lib/router.js';
import { Link } from './Link.js';
import { BUTTON_SECONDARY, HELP } from './ui.js';

const HEADING = 'text-xs font-medium uppercase tracking-[0.12em] text-muted';

/**
 * How far one word has got in each practice mode: a point for every correct
 * practice answer in that mode, up to the ceiling. It is shown beside the
 * word's review mastery and is a different thing: it is never used to decide
 * when the word is due, and reviewing does not move it.
 */
export function PracticeMastery({ wordId }: { wordId: string }) {
  const { api } = useApp();
  const headingId = useId();
  const load = useCallback(() => api.fetchPracticeMastery(wordId), [api, wordId]);
  const mastery = useRemote(load, 'Could not load this word’s practice mastery.');

  if (mastery.status === 'loading') {
    return (
      <p role="status" className="border-t border-line pt-4 text-sm text-muted">
        Loading practice mastery…
      </p>
    );
  }
  if (mastery.status === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <p role="alert" className="text-sm text-bad-ink">
          {mastery.error}
        </p>
        <button type="button" className={BUTTON_SECONDARY} onClick={mastery.reload}>
          Try again
        </button>
      </div>
    );
  }
  // Where the database does not record practice yet there is nothing to count, so nothing is shown.
  if (!mastery.data.available) return null;

  const { modes, max } = mastery.data;
  const practised = modes.some((mode) => mode.correct > 0);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id={headingId} className={HEADING}>
        Practice mastery
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {modes.map(({ mode, mastery: level }) => (
          <li key={mode} className="flex items-center gap-3 text-sm">
            <span className="w-32 shrink-0">{STUDY_MODE_LABELS[mode]}</span>
            <span
              role="meter"
              aria-label={`${STUDY_MODE_LABELS[mode]} practice mastery`}
              aria-valuemin={0}
              aria-valuemax={max}
              aria-valuenow={level}
              aria-valuetext={`${level} of ${max}`}
              className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-accent-soft"
            >
              <span className="block h-full rounded-full bg-accent" style={{ width: `${(level / max) * 100}%` }} />
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums text-muted" aria-hidden="true">
              {level} / {max}
            </span>
          </li>
        ))}
      </ul>
      <p className={HELP}>
        One point for each correct practice answer in that mode, up to {max}. A wrong answer changes nothing. This is
        separate from the mastery above: it never decides when the word is due, and reviewing does not change it.
        {!practised && (
          <>
            {' '}
            <Link to={buildHref(ROUTES.practice, { source: 'all' })} className="font-medium text-accent hover:underline">
              Start practising
            </Link>
          </>
        )}
      </p>
    </section>
  );
}
