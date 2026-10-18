import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { REVIEW_FOCUSES, pageIdSchema } from '../../shared/api.js';
import { useApp, useCounting, useLibrary, useSettings } from '../app-context.js';
import { CompletionScreen } from '../components/CompletionScreen.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { ReviewScreen } from '../components/ReviewScreen.js';
import { ShortcutHelp } from '../components/ShortcutHelp.js';
import { Spinner } from '../components/Spinner.js';
import { WordPicker } from '../components/WordPicker.js';
import { EVERYTHING_LABEL, FOCUS_TEXT, SELECT_TEXT, SELECT_VALUE, scopeFromQuery } from '../lib/review-focus.js';
import { ALL_SCOPE, WEAK_SCOPE, sameScope, scopeKey, selection } from '../lib/review-scope.js';
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

/**
 * Whether an answer moves the word. Either way the answer is recorded and counted in accuracy and
 * the daily goal; switched off, the word's mastery, review date and FSRS state all stay as they are.
 */
function CountingSwitch() {
  const counting = useCounting();
  const { counting: preference } = useApp();
  return (
    <label
      className="flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm font-medium text-muted"
      title="Count this review toward mastery. Off, the answers are still recorded, but every word keeps its mastery and review date."
    >
      <input
        type="checkbox"
        className="size-4 accent-[var(--accent)]"
        checked={counting}
        onChange={(event) => {
          // Hand the keys back to the card, exactly as the choice of words does: space
          // should flip the card, not toggle this again.
          event.currentTarget.blur();
          preference.set(event.target.checked);
        }}
      />
      Count toward mastery
    </label>
  );
}

const HEADER_BUTTON =
  'flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 text-sm font-medium text-muted transition hover:text-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

/**
 * The flashcard review. The session itself lives for the whole app, so leaving
 * this tab and coming back resumes where it was.
 */
export function ReviewPage() {
  const { api, session, ensureReviewSession } = useApp();
  const settings = useSettings();
  const counting = useCounting();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const { status, error } = state;
  const [helpOpen, setHelpOpen] = useState(false);
  const reload = () => void session.load();
  const { query } = useLocation();
  const { collections } = useLibrary();

  // The address names everything due, the weakest words, or the reviewer's own picks. A collection
  // in the address is a set of words to start the picking from, not a narrowing of its own.
  const wantedCollection = query.get('collection');
  const collectionId =
    wantedCollection !== null && pageIdSchema.safeParse(wantedCollection).success ? wantedCollection : null;
  const asked = scopeFromQuery(query);
  const askedKey = scopeKey(asked);
  const picking = asked.kind === 'selection' || collectionId !== null;

  /** The words ticked here, once the reviewer has started on them. */
  const [picked, setPicked] = useState<string[] | null>(() => {
    const active = session.scope();
    return active.kind === 'selection' ? [...active.ids] : null;
  });
  // Choosing means the address asks for picked words and this is not the sitting that was started
  // from them: a session already running keeps running.
  const choosing = picking && (picked === null || !sameScope(selection(picked), session.scope()));

  useEffect(() => {
    // Picked words are only loaded once they have been chosen; everything else loads on arrival.
    // The weakest words are the one narrowing the server works out for itself, and `scopeKey`
    // names them exactly that.
    if (picking) return;
    ensureReviewSession(askedKey === 'weak' ? WEAK_SCOPE : ALL_SCOPE);
  }, [ensureReviewSession, picking, askedKey]);

  // The weak list the sitting started from, so the finished screen can name any word that left it.
  const weakBefore = useRef<Map<string, string> | null>(null);
  const [recovered, setRecovered] = useState<readonly string[]>([]);
  useEffect(() => {
    if (status === 'loading') {
      weakBefore.current = null;
      setRecovered([]);
      return;
    }
    if ((status === 'ready' || status === 'flipped') && weakBefore.current === null) {
      let active = true;
      api
        .fetchWeakWords()
        .then((weak) => {
          if (active) weakBefore.current = new Map(weak.words.map((word) => [word.id, word.word]));
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }
    if (status === 'completed' && weakBefore.current !== null) {
      let active = true;
      const before = weakBefore.current;
      api
        .fetchWeakWords()
        .then((weak) => {
          if (!active) return;
          const after = new Set(weak.words.map((word) => word.id));
          setRecovered([...before].filter(([id]) => !after.has(id)).map(([, word]) => word));
        })
        .catch(() => setRecovered([]));
      return () => {
        active = false;
      };
    }
  }, [api, status]);

  /** The words to start the picker with: a collection in the address, or the running sitting's own picks. */
  const active = session.scope();
  const seed =
    collectionId !== null
      ? (collections.find((each) => each.id === collectionId)?.wordIds ?? [])
      : active.kind === 'selection'
        ? active.ids
        : [];

  const startPicked = (ids: string[]) => {
    setPicked(ids);
    ensureReviewSession(selection(ids));
  };

  let content;
  if (choosing) {
    content = (
      <WordPicker
        initialIds={seed}
        onStart={startPicked}
        onClose={() => navigate(buildHref(ROUTES.review, {}))}
      />
    );
  } else if (status === 'loading') {
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
      <CompletionScreen
        state={state}
        sessionId={session.sessionId()}
        onReload={reload}
        onUndo={() => session.undo()}
        onRetry={(requestId) => session.retryRefusal(requestId)}
        onDismiss={(requestId) => session.dismissRefusal(requestId)}
        recovered={recovered}
      />
    );
  } else {
    content = <ReviewScreen state={state} session={session} onHelp={() => setHelpOpen(true)} paused={helpOpen} />;
  }

  // What is actually loaded decides the banner; the address only asks for it.
  const shown = state.meta?.focus ?? null;
  const pickedScope = state.meta?.selection === true;
  const text = pickedScope ? SELECT_TEXT : shown === null ? null : FOCUS_TEXT[shown];
  // The note about mastery stands on its own: it is true of an ordinary review as well, and it is
  // what makes a word that is not due answerable at all.
  const parts = [
    text?.banner ?? null,
    counting ? null : 'Not counting toward mastery, so every word keeps the mastery and review date it had.',
  ].filter((part): part is string => part !== null);
  const banner = parts.length === 0 ? null : parts.join(' ');

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pb-1 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="hidden truncate text-sm font-semibold tracking-tight md:block">Review</h1>
          <ModeBadge meta={state.meta} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="review-focus">
            Cards to review
          </label>
          <select
            id="review-focus"
            value={picking ? SELECT_VALUE : askedKey === 'weak' ? 'weak' : ''}
            title="Choose which words to review. The weakest words and your own picks may be taken before they are due."
            className="h-9 max-w-[11rem] cursor-pointer rounded-full border border-line bg-surface px-3 text-sm font-medium text-muted disabled:cursor-not-allowed disabled:opacity-50"
            onChange={(event) => {
              const { value } = event.target;
              // Hand the keys back to the card: an arrow key should answer, not change this choice.
              event.currentTarget.blur();
              navigate(buildHref(ROUTES.review, { focus: value === '' ? null : value }));
            }}
          >
            <option value="">{EVERYTHING_LABEL}</option>
            {REVIEW_FOCUSES.map((key) => (
              <option key={key} value={key}>
                {FOCUS_TEXT[key].label}
              </option>
            ))}
            <option value={SELECT_VALUE}>{SELECT_TEXT.label}</option>
          </select>
          <CountingSwitch />
          {pickedScope && !choosing && (
            <button type="button" onClick={() => setPicked(null)} className={HEADER_BUTTON}>
              Change words
            </button>
          )}
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
          {!choosing && (
            <button
              type="button"
              onClick={reload}
              aria-disabled={status === 'loading'}
              title="Reload the queue. Does not change any review data."
              className={HEADER_BUTTON}
            >
              <Icon name="refresh" className="size-4" />
              Refresh
            </button>
          )}
        </div>
      </div>
      {/* The finished screen says this itself, with the same way out. */}
      {banner !== null && status !== 'loading' && status !== 'completed' && !choosing && (
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
          confidence={false}
          onClose={() => setHelpOpen(false)}
        />
      )}
    </div>
  );
}
