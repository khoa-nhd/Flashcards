import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { REVIEW_FOCUSES, pageIdSchema } from '../../shared/api.js';
import { useApp, useCounting, useLibrary, useSettings, useUiLanguage } from '../app-context.js';
import { CompletionScreen } from '../components/CompletionScreen.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { ReviewScreen } from '../components/ReviewScreen.js';
import { ShortcutHelp } from '../components/ShortcutHelp.js';
import { Spinner } from '../components/Spinner.js';
import { WordPicker } from '../components/WordPicker.js';
import { pick } from '../lib/i18n.js';
import { EVERYTHING_LABEL, FOCUS_TEXT, SELECT_TEXT, SELECT_VALUE, scopeFromQuery } from '../lib/review-focus.js';
import { EARLY_DAYS_DEFAULT, sameScope, scopeFromKey, scopeKey, selection } from '../lib/review-scope.js';
import { XpFloat } from '../components/GameBar.js';
import { knownGame } from '../lib/game-state.js';
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
function CountingSwitch({ fsrsOnly }: { fsrsOnly: boolean }) {
  const counting = useCounting();
  const { counting: preference } = useApp();
  const language = useUiLanguage();
  const title = fsrsOnly
    ? pick(
        language,
        'Count this review toward the schedule. Off, the answers are still recorded, but FSRS does not move the word.',
        'Tính lần ôn này vào lịch. Khi tắt, câu trả lời vẫn được lưu nhưng FSRS không thay đổi từ này.',
      )
    : 'Count this review toward mastery. Off, the answers are still recorded, but every word keeps its mastery and review date.';
  const label = fsrsOnly
    ? pick(language, 'Count toward schedule', 'Tính vào lịch ôn')
    : pick(language, 'Count toward mastery', 'Tính vào mức thành thạo');
  const shortLabel = fsrsOnly
    ? pick(language, 'Schedule', 'Lịch ôn')
    : pick(language, 'Mastery', 'Thành thạo');
  // Counting is the safe default, so it reads as an ordinary control; with it off, the
  // switch itself warns: answers are recorded, but the words do not move.
  const tone = counting
    ? 'border-line-strong bg-transparent text-muted'
    : 'border-bad/40 bg-bad-soft text-bad-ink';
  return (
    <label
      className={`flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors sm:text-sm ${tone}`}
      title={title}
    >
      <input
        type="checkbox"
        className="size-4 accent-[var(--accent)]"
        aria-label={label}
        checked={counting}
        onChange={(event) => {
          // Hand the keys back to card: space flips card, not toggle this.
          event.currentTarget.blur();
          preference.set(event.target.checked);
        }}
      />
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{shortLabel}</span>
    </label>
  );
}

const HEADER_BUTTON =
  'flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-line-strong px-2 text-xs font-medium text-muted transition-colors hover:text-ink sm:text-sm sm:px-3 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

/**
 * The flashcard review. The session itself lives for the whole app, so leaving
 * this tab and coming back resumes where it was.
 */
export function ReviewPage() {
  const { api, session, ensureReviewSession, counting: countingChoice, toasts } = useApp();
  const settings = useSettings();
  const language = useUiLanguage();
  const counting = useCounting();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const { status, error } = state;
  const fsrsOnly = state.meta?.capabilities.fsrsOnly === true;
  const [helpOpen, setHelpOpen] = useState(false);
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

  const reload = () => {
    // Refresh is a fresh start at the same words, so it counts again by default —
    // the weakest words keep the sitting's own starting point.
    if (asked.kind !== 'weak' && asked.kind !== 'random') countingChoice.preset(true);
    void session.load();
  };

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
    ensureReviewSession(scopeFromKey(askedKey));
  }, [ensureReviewSession, picking, askedKey]);

  // The weak list the sitting started from, so the finished screen can name any word that left it.
  const weakBefore = useRef<Map<string, string> | null>(null);
  const [recovered, setRecovered] = useState<readonly string[]>([]);
  // Reset weakBefore when a new review session starts (status goes to loading).
  // `recovered` is already initialized to [] and reset by remount; avoid setState in effect.
  useEffect(() => {
    if (status === 'loading') {
      weakBefore.current = null;
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

  // A finished sitting is its own screen: the queue controls step aside for the summary.
  const finishedSession = status === 'completed' && state.cards.length > 0;

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
          className="h-12 cursor-pointer rounded-xl bg-accent px-6 font-semibold text-on-accent transition hover:bg-accent-hover focus-visible:outline-on-accent"
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
    counting
      ? null
      : fsrsOnly
        ? pick(
            language,
            'Not counting toward the schedule, so FSRS leaves every word where it is.',
            'Không tính vào lịch, nên FSRS giữ nguyên mọi từ.',
          )
        : 'Not counting toward mastery, so every word keeps the mastery and review date it had.',
  ].filter((part): part is string => part !== null);
  const banner = parts.length === 0 ? null : parts.join(' ');

  return (
    <div className="flex h-full flex-col">
      <div
        className={`mx-auto flex w-full max-w-xl flex-nowrap items-center justify-between gap-x-2 px-2 sm:px-4 pb-1.5 pt-1.5 ${
          finishedSession ? 'hidden' : ''
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ModeBadge meta={state.meta} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <label className="sr-only" htmlFor="review-focus">
            Cards to review
          </label>
          <select
            id="review-focus"
            value={picking ? SELECT_VALUE : asked.kind === 'all' ? '' : asked.kind}
            title="Choose which words to review. The weakest words and your own picks may be taken before they are due."
            className="h-9 max-w-[9.5rem] cursor-pointer rounded-full border border-line-strong bg-transparent px-3 text-xs font-medium text-muted sm:max-w-[11rem] sm:text-sm disabled:cursor-not-allowed disabled:opacity-50"
            onChange={(event) => {
              const { value } = event.target;
              // Hand the keys back to the card: an arrow key should answer, not change this choice.
              event.currentTarget.blur();
              // Review early starts from how far ahead this account last chose to reach.
              const days = value === 'early' ? String(knownGame(api)?.earlyDays ?? EARLY_DAYS_DEFAULT) : null;
              navigate(buildHref(ROUTES.review, { focus: value === '' ? null : value, days }));
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
          {asked.kind === 'early' && (
            <>
              <label className="sr-only" htmlFor="review-early-days">
                {pick(language, 'How many days ahead', 'Bao nhiêu ngày tới')}
              </label>
              <select
                id="review-early-days"
                value={asked.days}
                title={pick(language, 'How many days ahead to reach', 'Ôn trước bao nhiêu ngày')}
                className="h-9 cursor-pointer rounded-full border border-line-strong bg-transparent px-2 text-xs font-medium text-muted sm:text-sm"
                onChange={(event) => {
                  const days = Number(event.target.value);
                  event.currentTarget.blur();
                  navigate(buildHref(ROUTES.review, { focus: 'early', days: String(days) }), { replace: true });
                  // Remembered with the account for next time; the review itself does not wait for it.
                  if (knownGame(api)?.available === true) {
                    void api.saveGameSettings({ earlyDays: days }).catch(() =>
                      toasts.show({ message: pick(language, 'Could not remember that choice.', 'Không lưu được lựa chọn này.') }),
                    );
                  }
                }}
              >
                {Array.from({ length: 14 }, (_, at) => at + 1).map((days) => (
                  <option key={days} value={days}>
                    {pick(language, `${days} ${days === 1 ? 'day' : 'days'}`, `${days} ngày`)}
                  </option>
                ))}
              </select>
            </>
          )}
          <CountingSwitch fsrsOnly={fsrsOnly} />
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
              aria-label="Refresh"
              title="Reload the queue. Does not change any review data."
              className={HEADER_BUTTON}
            >
              <Icon name="refresh" className="size-4" />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          )}
        </div>
      </div>
      {/* The finished screen says this itself, with the same way out. */}
      {banner !== null && status !== 'loading' && status !== 'completed' && !choosing && (
        <div className="mx-auto w-full max-w-xl px-4 pt-1.5">
          <div
            role="alert"
            className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-xl border border-bad/30 bg-bad-soft px-3 py-2 text-xs font-medium text-bad-ink sm:text-sm"
          >
            <span>{banner}</span>
            <Link to={ROUTES.review} className="font-medium text-accent underline-offset-2 hover:underline">
              Review everything due
            </Link>
          </div>
        </div>
      )}
      <div className="pool relative min-h-0 flex-1">
        <XpFloat />
        {content}
      </div>
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
