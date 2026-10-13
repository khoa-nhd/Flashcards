import { useEffect, useState, useSyncExternalStore } from 'react';
import { REVIEW_FOCUSES, pageIdSchema, reviewFocusSchema } from '../../shared/api.js';
import { useApp, useLibrary, useSettings } from '../app-context.js';
import { useFocusMode } from '../components/AppShell.js';
import { CompletionScreen } from '../components/CompletionScreen.js';
import { FocusTimer } from '../components/FocusTimer.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { ReviewScreen } from '../components/ReviewScreen.js';
import { ShortcutHelp } from '../components/ShortcutHelp.js';
import { Spinner } from '../components/Spinner.js';
import { EVERYTHING_LABEL, FOCUS_TEXT, focusFromQuery } from '../lib/review-focus.js';
import { ROUTES, buildHref, navigate, useLocation } from '../lib/router.js';
import type { SessionMeta } from '../lib/session-machine.js';

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
        title="Saving is switched off, so answers are checked but not recorded."
      >
        Preview · not saving
      </span>
    );
  }
  return null;
}

const HEADER_BUTTON =
  'flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 text-sm font-medium text-muted transition hover:text-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

/**
 * The flashcard review. The session itself lives for the whole app, so leaving
 * this tab and coming back resumes where it was.
 */
export function ReviewPage() {
  const { session, ensureReviewSession } = useApp();
  const settings = useSettings();
  const focusMode = useFocusMode();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const { status, error } = state;
  const [helpOpen, setHelpOpen] = useState(false);
  const reload = () => void session.load();
  // The address chooses the selection of cards: everything due, or a narrower set of the same.
  const { query } = useLocation();
  const wantedCollection = query.get('collection');
  const collectionId = wantedCollection !== null && pageIdSchema.safeParse(wantedCollection).success ? wantedCollection : null;
  const focus = collectionId === null ? focusFromQuery(query) : null;
  const { collections } = useLibrary();

  useEffect(() => {
    ensureReviewSession(focus, collectionId);
  }, [ensureReviewSession, focus, collectionId]);

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
    content = (
      <CompletionScreen state={state} sessionId={session.sessionId()} onReload={reload} onUndo={() => session.undo()} />
    );
  } else {
    content = <ReviewScreen state={state} session={session} onReload={reload} onHelp={() => setHelpOpen(true)} paused={helpOpen} />;
  }

  // What is actually loaded decides the banner; the address only asks for it.
  const shown = state.meta?.focus ?? null;
  const shownCollection = state.meta?.collection ?? null;
  const banner =
    shownCollection !== null
      ? `Collection “${shownCollection.name}” only, from those due now.`
      : shown !== null
        ? FOCUS_TEXT[shown].banner
        : null;

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pb-1 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="hidden truncate text-sm font-semibold tracking-tight md:block">Review</h1>
          <ModeBadge meta={state.meta} />
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="review-focus">
            Cards to review
          </label>
          <select
            id="review-focus"
            value={collectionId !== null ? `collection:${collectionId}` : (focus ?? '')}
            disabled={status === 'saving'}
            title="Choose which of the due words to review. No choice brings a word forward."
            className="h-9 max-w-[11rem] cursor-pointer rounded-full border border-line bg-surface px-3 text-sm font-medium text-muted disabled:cursor-not-allowed disabled:opacity-50"
            onChange={(event) => {
              const { value } = event.target;
              const chosen = reviewFocusSchema.safeParse(value);
              // Hand the keys back to the card: an arrow key should answer, not change this choice.
              event.currentTarget.blur();
              navigate(
                value.startsWith('collection:')
                  ? buildHref(ROUTES.review, { collection: value.slice('collection:'.length) })
                  : buildHref(ROUTES.review, { focus: chosen.success ? chosen.data : null }),
              );
            }}
          >
            <option value="">{EVERYTHING_LABEL}</option>
            {REVIEW_FOCUSES.map((key) => (
              <option key={key} value={key}>
                {FOCUS_TEXT[key].label}
              </option>
            ))}
            {collections.length > 0 && (
              <optgroup label="Collections">
                {collections.map((collection) => (
                  <option key={collection.id} value={`collection:${collection.id}`}>
                    {collection.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts"
            className={`${HEADER_BUTTON} hidden keyboard:flex`}
          >
            <span aria-hidden="true" className="font-semibold">
              ?
            </span>
          </button>
          <button
            type="button"
            onClick={reload}
            aria-disabled={status === 'saving' || status === 'loading'}
            title="Reload the queue. Does not change any review data."
            className={HEADER_BUTTON}
          >
            <Icon name="refresh" className="size-4" />
            Refresh
          </button>
          <button
            type="button"
            onClick={focusMode.toggle}
            aria-pressed={focusMode.on}
            title="Hide the navigation and show a timer, for studying without distractions."
            className={`${HEADER_BUTTON} aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent`}
          >
            Focus
          </button>
          {focusMode.on && <FocusTimer />}
        </div>
      </div>
      {/* The finished screen says this itself, with the same way out. */}
      {banner !== null && status !== 'loading' && status !== 'completed' && (
        <p className="mx-auto w-full max-w-xl px-4 pt-1 text-sm text-muted">
          {banner}{' '}
          <Link to={ROUTES.review} className="font-medium text-accent hover:underline">
            Review everything due
          </Link>
        </p>
      )}
      <div className="min-h-0 flex-1">{content}</div>
      {helpOpen && (
        <ShortcutHelp
          answerKeys={settings.answerKeys}
          undo={state.meta?.capabilities.undo === true}
          confidence={settings.askConfidence && state.meta?.capabilities.confidence === true && state.meta.writesEnabled}
          onClose={() => setHelpOpen(false)}
        />
      )}
    </div>
  );
}
