import { useState, type CSSProperties, type MouseEvent, type Ref } from 'react';
import type { ReviewCard } from '../../shared/api.js';
import { daysBetween, type IsoDate } from '../../shared/dates.js';
import type { ReviewAction } from '../../shared/review-logic.js';
import { SWIPE } from '../config.js';
import { useReducedMotion } from '../hooks/useReducedMotion.js';
import { useSwipe } from '../hooks/useSwipe.js';
import { useUiLanguage } from '../app-context.js';
import { pick } from '../lib/i18n.js';
import type { SwipeDirection } from '../lib/gesture.js';
import { StrengthPill } from './badges.js';

export interface FlashcardProps {
  card: ReviewCard;
  today: IsoDate | null;
  flipped: boolean;
  /** The card is flipped and nothing is being saved, so an answer may be given. */
  canGrade: boolean;
  /** A save is in flight or has failed; the card is frozen until that resolves. */
  locked: boolean;
  pendingAction: ReviewAction | null;
  /** The word's strength fell since it was last shown in this session. */
  strengthDropped?: boolean;
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
  'card-face flex min-h-[21rem] flex-col rounded-2xl border px-6 pb-16 pt-5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.95)] sm:min-h-[25rem] sm:px-8';

export function Flashcard({
  card,
  today,
  flipped,
  canGrade,
  locked,
  pendingAction,
  strengthDropped = false,
  swipeThresholdPx = SWIPE.thresholdPx,
  onFlip,
  onGrade,
  onBlockedGrade,
  flipButtonRef,
}: FlashcardProps) {
  const reducedMotion = useReducedMotion();
  const language = useUiLanguage();

  // The answer is not put in the document until the card is first flipped.
  const [revealed, setRevealed] = useState(flipped);
  if (flipped && !revealed) setRevealed(true);
  // Level 6 and above starts with the definition and example folded away.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsCollapsed = card.memory !== undefined && card.detailCollapsed && !detailsOpen;
  const meaningFields = card.back.filter((field) => field.key === 'meaning');
  const detailFields = card.back.filter((field) => field.key !== 'meaning');
  const visibleFields = detailsCollapsed ? meaningFields : card.back;

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
            <div className="flex items-center justify-between gap-3 text-xs text-faint">
              {card.memory !== undefined ? (
                <StrengthPill memory={card.memory} language={language} needsReview={strengthDropped} />
              ) : (
                <span className="text-[0.6875rem] font-medium uppercase tracking-[0.16em] tabular-nums">
                  Mastery {card.mastery}
                </span>
              )}
              {due !== null && <span className="shrink-0">{due}</span>}
            </div>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
              <h2 className="font-serif text-[clamp(2.5rem,8vw,4.5rem)] font-semibold leading-[1.05] tracking-[-0.025em] wrap-anywhere">
                {card.word}
              </h2>
              {card.front.length > 0 && (
                <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[0.9375rem] text-muted">
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
            <div className="flex items-baseline justify-between gap-3 border-b border-line pb-3">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-faint">Answer</span>
              <span className="font-serif text-lg font-semibold wrap-anywhere">{card.word}</span>
            </div>
            {revealed && (
              <div className="flex flex-1 flex-col justify-center gap-5 py-5">
                {visibleFields.map((field) => (
                  <div key={field.key}>
                    <div className="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-faint">
                      {field.label}
                    </div>
                    <p className="whitespace-pre-line font-serif text-[1.125rem] leading-[1.55] wrap-anywhere">{field.value}</p>
                  </div>
                ))}
                {detailsCollapsed && detailFields.length > 0 && (
                  <div>
                    <button
                      type="button"
                      aria-expanded={detailsOpen}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDetailsOpen(true);
                      }}
                      className="cursor-pointer rounded-full border border-line-strong px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:text-ink"
                    >
                      {pick(language, 'Show definition/example', 'Xem định nghĩa/ví dụ')}
                    </button>
                    <p className="mt-2 text-xs text-faint">
                      {pick(
                        language,
                        'The details are folded away at this strength level. They are still there when you need them.',
                        'Định nghĩa và ví dụ được thu gọn ở mức sức nhớ này. Bạn vẫn mở lại được khi cần.',
                      )}
                    </p>
                  </div>
                )}
                {!detailsCollapsed && card.memory !== undefined && card.detailCollapsed && (
                  <button
                    type="button"
                    aria-expanded={detailsOpen}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDetailsOpen(false);
                    }}
                    className="cursor-pointer self-start rounded-full border border-line px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-ink"
                  >
                    {pick(language, 'Hide definition/example', 'Ẩn định nghĩa/ví dụ')}
                  </button>
                )}
                {card.back.length === 0 && (
                  <p className="text-center text-sm leading-relaxed text-muted">
                    {card.detailsHidden
                      ? card.memory !== undefined
                        ? 'The definition and example are folded away at this memory strength. They are still there when you need them.'
                        : 'The definition and example are hidden at this mastery level. Recall them from memory.'
                      : 'No definition or example is recorded for this word.'}
                  </p>
                )}
                {card.back.length > 0 && card.detailsHidden && (
                  <p className="text-xs text-faint">
                    {card.memory !== undefined
                      ? 'Other details are folded away at this memory strength.'
                      : 'Other details are hidden at this mastery level.'}
                  </p>
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
        className={`pointer-events-none absolute inset-0 flex items-start rounded-2xl p-4 ${
          leaning === 'remember'
            ? 'justify-start bg-accent-soft ring-accent'
            : 'justify-end bg-line-strong/50 ring-line-strong'
        } ${armed || (locked && leaning !== null) ? 'ring-2' : 'ring-1'}`}
        style={{ opacity: tint, transition: swipe.dragging ? 'none' : 'opacity 160ms ease-out' }}
      >
        {leaning !== null && (
          <span
            className={`rounded-lg px-3 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] ${
              leaning === 'remember'
                ? 'bg-accent text-on-accent'
                : 'border border-line-strong bg-surface text-ink'
            }`}
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
        className="absolute bottom-4 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-line-strong bg-paper px-4 py-1.5 text-xs font-medium text-muted transition-colors hover:text-ink"
      >
        <span className="keyboard:hidden">{flipped ? 'Tap to flip back' : 'Tap to flip'}</span>
        <span className="hidden keyboard:inline">{flipped ? 'Flip back' : 'Show answer'}</span>
        <kbd className="hidden rounded border border-line bg-surface px-1.5 py-0.5 text-[0.6875rem] keyboard:inline">
          Space
        </kbd>
      </button>
    </div>
  );
}
