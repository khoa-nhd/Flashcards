import { useEffect, useRef } from 'react';
import type { ReviewAction } from '../../shared/review-logic.js';

export type ShortcutIntent = 'flip' | 'undo' | ReviewAction;

const TEXT_ENTRY =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="tablist"], [role="radiogroup"]';
const ACTIVATED_BY_SPACE = 'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"]';

const within = (target: EventTarget | null, selector: string) =>
  target instanceof Element && target.closest(selector) !== null;

/**
 * Maps a key press to a review intent, or `null` when the key belongs to
 * whatever the user is focused on (typing, a native control) or is not ours.
 */
export function shortcutFor(event: KeyboardEvent): ShortcutIntent | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (within(event.target, TEXT_ENTRY)) return null;

  if (event.key === ' ' || event.code === 'Space') {
    // On a focused button Space is that button's own activation key.
    return within(event.target, ACTIVATED_BY_SPACE) ? null : 'flip';
  }
  if (event.key === 'ArrowLeft') return 'not_remember';
  if (event.key === 'ArrowRight') return 'remember';
  if (event.key === 'u' || event.key === 'U') return 'undo';
  return null;
}

export interface ShortcutHandlers {
  onFlip: () => void;
  onGrade: (action: ReviewAction) => void;
  onUndo?: () => void;
}

/**
 * Global review shortcuts: Space flips, ← / → answer, U takes the last answer
 * back. One listener is attached
 * per mount and removed on unmount; handlers are read through a ref so a
 * re-render never re-subscribes or leaves a stale listener behind.
 */
export function useReviewShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const intent = shortcutFor(event);
      if (intent === null) return;
      // Also stops Space from scrolling the page.
      event.preventDefault();
      // A held key auto-repeats; only the initial press counts.
      if (event.repeat) return;
      if (intent === 'flip') latest.current.onFlip();
      else if (intent === 'undo') latest.current.onUndo?.();
      else latest.current.onGrade(intent);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
