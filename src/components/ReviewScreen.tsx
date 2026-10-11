import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewAction } from '../../shared/review-logic.js';
import { HINT_DURATION_MS } from '../config.js';
import type { Confidence } from '../../shared/api.js';
import { useSettings } from '../app-context.js';
import { ANSWER_KEY_SETS, useReviewShortcuts } from '../hooks/useReviewShortcuts.js';
import type { SessionController } from '../lib/session-controller.js';
import { canUndo, currentCard, type SessionState } from '../lib/session-machine.js';
import { ConfidencePrompt } from './ConfidencePrompt.js';
import { Flashcard } from './Flashcard.js';
import { ReviewControls } from './ReviewControls.js';
import { ReviewProgress } from './ReviewProgress.js';
import { SkippedNotice } from './SkippedNotice.js';

export interface ReviewScreenProps {
  state: SessionState;
  session: SessionController;
  onReload: () => void;
  /** Opens the list of keyboard shortcuts. */
  onHelp?: () => void;
  /** Something is open over the card (the shortcut list): keys must not reach the review. */
  paused?: boolean;
}

const ACTION_TEXT: Record<ReviewAction, string> = {
  remember: 'Remember',
  not_remember: 'Not remember',
};

const PANEL_BUTTON =
  'h-11 cursor-pointer rounded-xl border px-4 text-sm font-semibold transition active:scale-[0.98]';

export function ReviewScreen({ state, session, onReload, onHelp, paused = false }: ReviewScreenProps) {
  const { askConfidence, answerKeys } = useSettings();
  const card = currentCard(state);
  const cardId = card?.id ?? null;
  const { status, error } = state;
  // `saving` and `error` are only ever reached from a flipped card.
  const flipped = status === 'flipped' || status === 'saving' || status === 'error';

  const [hintVisible, setHintVisible] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flipButton = useRef<HTMLButtonElement>(null);
  const errorAction = useRef<HTMLButtonElement>(null);

  const showFlipHint = useCallback(() => {
    setHintVisible(true);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHintVisible(false), HINT_DURATION_MS);
  }, []);

  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const flip = useCallback(() => {
    setHintVisible(false);
    session.flip();
  }, [session]);

  /** Every way of answering (keys, swipe, buttons) funnels through here. */
  const grade = useCallback(
    (action: ReviewAction) => {
      if (session.getState().status === 'ready') showFlipHint();
      else session.grade(action);
    },
    [session, showFlipHint],
  );

  const undo = useCallback(() => {
    session.undo();
  }, [session]);

  const rate = useCallback(
    (level: Confidence) => {
      setHintVisible(false);
      session.rateConfidence(level);
    },
    [session],
  );

  // Asked only where the rating will be stored, and only before this card's answer has been seen.
  const askingConfidence =
    askConfidence &&
    status === 'ready' &&
    !state.revealed &&
    state.meta?.capabilities.confidence === true &&
    state.meta.writesEnabled;

  useReviewShortcuts(
    { onFlip: flip, onGrade: grade, onUndo: undo, onConfidence: rate, onHelp },
    { answerKeys, ratingConfidence: askingConfidence, enabled: !paused },
  );

  // Keep keyboard focus somewhere useful: a control that was just clicked may
  // have gone inert or been replaced, which would otherwise strand key presses.
  useEffect(() => {
    if (status === 'error') errorAction.current?.focus({ preventScroll: true });
  }, [status]);
  useEffect(() => {
    if (cardId !== null) flipButton.current?.focus({ preventScroll: true });
  }, [cardId]);
  useEffect(() => {
    if (status === 'flipped' && document.activeElement === document.body) {
      flipButton.current?.focus({ preventScroll: true });
    }
  }, [status]);

  if (card === null) return null;

  const done = state.index;
  const total = state.cards.length;
  const undoable = state.lastSaved;
  const undoWord = undoable === null ? null : (state.cards[undoable.index]?.word ?? null);
  const extraKeys = ANSWER_KEY_SETS[answerKeys];

  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
      <ReviewProgress done={done} total={total} />

      {(undoable !== null || state.undoError !== null) && (
        <div className="flex min-h-8 items-center justify-between gap-3 text-sm">
          <p role={state.undoError === null ? undefined : 'alert'} className="min-w-0 flex-1 text-bad-ink">
            {state.undoError ?? ''}
          </p>
          {undoable !== null && (
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo(state)}
              aria-label={`Undo “${ACTION_TEXT[undoable.action]}”${undoWord === null ? '' : ` for ${undoWord}`}`}
              className="h-8 shrink-0 cursor-pointer rounded-full border border-line px-3 font-medium text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.undoing ? 'Undoing…' : `Undo${undoWord === null ? '' : `: ${undoWord}`}`}
            </button>
          )}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        Card {done + 1} of {total}: {card.word}. {flipped ? 'Answer shown.' : ''}
      </p>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden py-2">
        <div className="my-auto">
          <Flashcard
            key={card.id}
            card={card}
            today={state.meta?.today ?? null}
            flipped={flipped}
            canGrade={status === 'flipped'}
            locked={status === 'saving' || status === 'error'}
            pendingAction={state.pendingAction}
            onFlip={flip}
            onGrade={grade}
            onBlockedGrade={showFlipHint}
            flipButtonRef={flipButton}
          />
        </div>
      </div>

      <p role="status" className="h-5 text-center text-sm font-medium text-muted">
        {hintVisible ? 'Flip the card before answering.' : ''}
      </p>

      {askingConfidence && <ConfidencePrompt onRate={rate} />}

      {status === 'error' && error !== null ? (
        <div role="alert" className="rounded-2xl border border-bad/40 bg-bad-soft p-4 text-bad-ink">
          <p className="font-semibold">
            {error.kind === 'conflict' ? 'This card changed on another device' : 'Your answer was not confirmed'}
          </p>
          <p className="mt-1 text-sm">{error.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {error.kind === 'save' ? (
              <>
                <button
                  ref={errorAction}
                  type="button"
                  className={`${PANEL_BUTTON} border-bad bg-bad text-white dark:text-paper`}
                  onClick={() => session.retrySave()}
                >
                  Retry{state.pendingAction ? ` “${ACTION_TEXT[state.pendingAction]}”` : ''}
                </button>
                <button
                  type="button"
                  className={`${PANEL_BUTTON} border-bad/40`}
                  onClick={() => session.cancelSave()}
                >
                  Back to card
                </button>
              </>
            ) : (
              <>
                <button
                  ref={errorAction}
                  type="button"
                  className={`${PANEL_BUTTON} border-bad bg-bad text-white dark:text-paper`}
                  onClick={onReload}
                >
                  Reload queue
                </button>
                <button
                  type="button"
                  className={`${PANEL_BUTTON} border-bad/40`}
                  onClick={() => session.skipCard()}
                >
                  Skip this card
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <ReviewControls
          enabled={status === 'flipped'}
          savingAction={status === 'saving' ? state.pendingAction : null}
          onGrade={grade}
          onBlocked={showFlipHint}
        />
      )}

      <div
        role="note"
        aria-label="Keyboard shortcuts"
        className="hidden items-center justify-center gap-4 text-xs text-muted keyboard:flex"
      >
        <span>
          <kbd className="rounded border border-line bg-surface px-1.5 py-0.5">Space</kbd> flip
        </span>
        <span>
          <kbd className="rounded border border-line bg-surface px-1.5 py-0.5">←</kbd>
          {extraKeys !== null && (
            <>
              {' '}
              <kbd className="rounded border border-line bg-surface px-1.5 py-0.5">{extraKeys[0].toUpperCase()}</kbd>
            </>
          )}{' '}
          not remember
        </span>
        <span>
          <kbd className="rounded border border-line bg-surface px-1.5 py-0.5">→</kbd>
          {extraKeys !== null && (
            <>
              {' '}
              <kbd className="rounded border border-line bg-surface px-1.5 py-0.5">{extraKeys[1].toUpperCase()}</kbd>
            </>
          )}{' '}
          remember
        </span>
        {state.meta?.capabilities.undo === true && (
          <span>
            <kbd className="rounded border border-line bg-surface px-1.5 py-0.5">U</kbd> undo
          </span>
        )}
        {onHelp !== undefined && (
          <span>
            <kbd className="rounded border border-line bg-surface px-1.5 py-0.5">?</kbd> all shortcuts
          </span>
        )}
      </div>

      {state.meta !== null && <SkippedNotice skipped={state.meta.skipped} />}
    </div>
  );
}
