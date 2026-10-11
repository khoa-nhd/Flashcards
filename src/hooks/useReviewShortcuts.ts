import { useEffect, useRef } from 'react';
import type { Confidence } from '../../shared/api.js';
import type { ReviewAction } from '../../shared/review-logic.js';

export type ShortcutIntent = 'flip' | 'undo' | 'help' | ReviewAction | { confidence: Confidence };

/**
 * Extra pairs of answer keys a reviewer can switch on. The arrow keys always
 * work; these are in addition, for hands that would rather stay on the home
 * row. Each pair is [Not remember, Remember].
 */
export const ANSWER_KEY_SETS = {
  none: null,
  jk: ['j', 'k'],
  fj: ['f', 'j'],
  numbers: ['1', '2'],
} as const satisfies Record<string, readonly [string, string] | null>;

export type AnswerKeys = keyof typeof ANSWER_KEY_SETS;

export interface ShortcutOptions {
  /** An extra pair of answer keys beside the arrows. */
  answerKeys?: AnswerKeys;
  /** The reviewer is being asked how sure they are: 1, 2 and 3 answer that. */
  ratingConfidence?: boolean;
}

const TEXT_ENTRY =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="tablist"], [role="radiogroup"]';
const ACTIVATED_BY_SPACE = 'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"]';

const within = (target: EventTarget | null, selector: string) =>
  target instanceof Element && target.closest(selector) !== null;

/**
 * Maps a key press to a review intent, or `null` when the key belongs to
 * whatever the user is focused on (typing, a native control) or is not ours.
 */
export function shortcutFor(event: KeyboardEvent, options: ShortcutOptions = {}): ShortcutIntent | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (within(event.target, TEXT_ENTRY)) return null;
  // "?" is typed with Shift on most keyboards, so it is the one key allowed to carry it.
  if (event.key === '?') return 'help';
  if (event.shiftKey) return null;

  if (event.key === ' ' || event.code === 'Space') {
    // On a focused button Space is that button's own activation key.
    return within(event.target, ACTIVATED_BY_SPACE) ? null : 'flip';
  }
  if (event.key === 'ArrowLeft') return 'not_remember';
  if (event.key === 'ArrowRight') return 'remember';

  const key = event.key.toLowerCase();
  // While a rating is being asked for, the number keys give it; they are answer keys only afterwards.
  if (options.ratingConfidence === true && (key === '1' || key === '2' || key === '3')) {
    return { confidence: Number(key) as Confidence };
  }
  const extra = ANSWER_KEY_SETS[options.answerKeys ?? 'none'];
  if (extra !== null) {
    if (key === extra[0]) return 'not_remember';
    if (key === extra[1]) return 'remember';
  }
  if (key === 'u') return 'undo';
  return null;
}

export interface ShortcutHandlers {
  onFlip: () => void;
  onGrade: (action: ReviewAction) => void;
  onUndo?: () => void;
  onConfidence?: (level: Confidence) => void;
  onHelp?: () => void;
}

/**
 * Global review shortcuts: Space flips, ← / → answer, U takes the last answer
 * back, ? opens the list of shortcuts. One listener is attached per mount and
 * removed on unmount; handlers and options are read through a ref so a
 * re-render never re-subscribes or leaves a stale listener behind.
 */
export function useReviewShortcuts(handlers: ShortcutHandlers, options: ShortcutOptions & { enabled?: boolean } = {}): void {
  const latest = useRef({ handlers, options });
  useEffect(() => {
    latest.current = { handlers, options };
  });
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const { handlers: current, options: currentOptions } = latest.current;
      const intent = shortcutFor(event, currentOptions);
      if (intent === null) return;
      // Also stops Space from scrolling the page.
      event.preventDefault();
      // A held key auto-repeats; only the initial press counts.
      if (event.repeat) return;
      if (intent === 'flip') current.onFlip();
      else if (intent === 'undo') current.onUndo?.();
      else if (intent === 'help') current.onHelp?.();
      else if (typeof intent === 'object') current.onConfidence?.(intent.confidence);
      else current.onGrade(intent);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
