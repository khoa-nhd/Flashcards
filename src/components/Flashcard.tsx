import { useState, type CSSProperties, type MouseEvent, type Ref } from 'react';
import type { ReviewCard } from '../../shared/api.js';
import { daysBetween, type IsoDate } from '../../shared/dates.js';
import type { ReviewAction } from '../../shared/review-logic.js';
import { SWIPE } from '../config.js';
import { useReducedMotion } from '../hooks/useReducedMotion.js';
import { useSwipe } from '../hooks/useSwipe.js';
import type { SwipeDirection } from '../lib/gesture.js';

export interface FlashcardProps {
  card: ReviewCard;
  today: IsoDate | null;
  flipped: boolean;
  /** The card is flipped and nothing is being saved, so an answer may be given. */
  canGrade: boolean;
  /** A save is in flight or has failed; the card is frozen until that resolves. */
  locked: boolean;
  pendingAction: ReviewAction | null;
  swipeThresholdPx?: number;
  onFlip: () => void;
  onGrade: (action: ReviewAction) => void;
  /** An answer was attempted while the card was still on its front. */
  onBlockedGrade: () => void;
  flipButtonRef?: Ref<HTMLButtonElement>;
}

const ACTION_LABEL: Record<ReviewAction, string> = {
  remember: 'Remember',
  not_remember: 'Not remember',
};

function dueLabel(nextReview: IsoDate | null, today: IsoDate | null): string | null {
  if (nextReview === null || today === null) return null;
  const overdue = daysBetween(nextReview, today);
  if (overdue === 0) return 'Due today';
  if (overdue > 0) return `${overdue} ${overdue === 1 ? 'day' : 'days'} overdue`;
  return null;
}

const FACE =
  'card-face flex min-h-[21rem] flex-col rounded-3xl border px-6 pb-16 pt-5 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-12px_rgb(0_0_0/0.18)] sm:min-h-[24rem] sm:px-9';

export function Flashcard({
  card,
  today,
  flipped,
  canGrade,
  locked,
  pendingAction,
  swipeThresholdPx = SWIPE.thresholdPx,
  onFlip,
  onGrade,
  onBlockedGrade,
  flipButtonRef,
}: FlashcardProps) {
  const reducedMotion = useReducedMotion();

  // The answer is not put in the document until the card is first flipped.
  const [revealed, setRevealed] = useState(flipped);
  if (flipped && !revealed) setRevealed(true);

  const handleSwipe = (direction: SwipeDirection) => {
    if (locked) return;
    if (canGrade) onGrade(direction === 'right' ? 'remember' : 'not_remember');
    else onBlockedGrade();
  };

  const swipe = useSwipe({ thresholdPx: swipeThresholdPx, slopPx: SWIPE.slopPx, onSwipe: handleSwipe });

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (locked || swipe.isTrailingClick()) return;
    // Releasing the mouse after selecting text on the card is not a tap.
    if (event.detail > 0 && window.getSelection()?.toString()) return;
    onFlip();
  };

  // An unflipped card only nudges, to show the gesture is seen but not accepted.
  const travel = canGrade ? swipe.offset : swipe.offset * 0.2;
  const progress = canGrade ? Math.min(Math.abs(swipe.offset) / swipeThresholdPx, 1) : 0;
  const leaning: ReviewAction | null =
    progress > 0 ? (swipe.offset > 0 ? 'remember' : 'not_remember') : locked ? pendingAction : null;
  const tint = leaning === null ? 0 : progress > 0 ? progress : 1;
  const armed = swipe.armed !== null && canGrade;

  const dragStyle: CSSProperties = {
    transform: reducedMotion || travel === 0 ? undefined : `translateX(${travel}px) rotate(${travel / 28}deg)`,
    transition: swipe.dragging ? 'none' : 'transform 220ms ease-out',
  };

  // The day the schedule in charge has it due; the mastery date unless something else decided.
  const due = dueLabel(card.dueOn ?? card.nextReview, today);

  return (
    <div
      data-testid="flashcard"
      data-flipped={flipped}
      className="card-enter relative w-full cursor-pointer touch-pan-y pointer-coarse:select-none"
      style={dragStyle}
      onClick={handleClick}
      {...swipe.handlers}
    >
      <div className="card-scene">
        <div className="card-flipper" data-flipped={flipped}>
          <section aria-hidden={flipped} className={`${FACE} border-line bg-surface`}>
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span className="rounded-full bg-paper px-2.5 py-1 font-medium tabular-nums">
                Mastery {card.mastery}
              </span>
              {due !== null && <span>{due}</span>}
            </div>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
              <h2 className="font-serif text-4xl font-semibold tracking-tight wrap-anywhere sm:text-5xl">
                {card.word}
              </h2>
              {card.front.length > 0 && (
                <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-base text-muted">
                  {card.front.map((field, index) => (
                    <span key={field.key} className="flex items-center gap-2">
                      {index > 0 && <span aria-hidden="true">·</span>}
                      <span>
                        <span className="sr-only">{field.label}: </span>
                        {field.value}
                      </span>
                    </span>
                  ))}
                </p>
              )}
            </div>
          </section>

          <section
            aria-hidden={!flipped}
            className={`${FACE} card-face-back border-accent/30 bg-surface-back`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Answer</span>
              <span className="font-serif text-lg font-semibold wrap-anywhere">{card.word}</span>
            </div>
            {revealed && (
              <div className="flex flex-1 flex-col justify-center gap-5 py-5">
                {card.back.map((field) => (
                  <div key={field.key}>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                      {field.label}
                    </div>
                    <p className="whitespace-pre-line text-lg leading-relaxed wrap-anywhere">{field.value}</p>
                  </div>
                ))}
                {card.back.length === 0 && (
                  <p className="text-center text-muted">
                    {card.detailsHidden
                      ? 'The definition and example are hidden at this mastery level. Recall them from memory.'
                      : 'No definition or example is recorded for this word.'}
                  </p>
                )}
                {card.back.length > 0 && card.detailsHidden && (
                  <p className="text-sm text-muted">Other details are hidden at this mastery level.</p>
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Swipe / saving feedback. Colour and a text label, never motion alone. */}
      <div
        aria-hidden="true"
        data-testid="swipe-feedback"
        className={`pointer-events-none absolute inset-0 flex items-start rounded-3xl p-4 ${
          leaning === 'remember'
            ? 'justify-start bg-good/10 ring-good'
            : 'justify-end bg-bad/10 ring-bad'
        } ${armed || (locked && leaning !== null) ? 'ring-4' : 'ring-2'}`}
        style={{ opacity: tint, transition: swipe.dragging ? 'none' : 'opacity 160ms ease-out' }}
      >
        {leaning !== null && (
          <span
            className={`rounded-lg px-3 py-1.5 text-sm font-bold uppercase tracking-wide text-white ${
              leaning === 'remember' ? 'bg-good' : 'bg-bad'
            } dark:text-paper`}
          >
            {ACTION_LABEL[leaning]}
          </span>
        )}
      </div>

      <button
        ref={flipButtonRef}
        type="button"
        aria-label={flipped ? 'Flip card back to the front' : 'Flip card to show the answer'}
        aria-keyshortcuts="Space"
        className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface/90 px-4 py-1.5 text-sm font-medium text-muted backdrop-blur"
      >
        <span className="keyboard:hidden">Tap to flip</span>
        <span className="hidden keyboard:inline">{flipped ? 'Flip back' : 'Show answer'}</span>
        <kbd className="hidden rounded border border-line bg-paper px-1.5 py-0.5 text-xs keyboard:inline">
          Space
        </kbd>
      </button>
    </div>
  );
}
