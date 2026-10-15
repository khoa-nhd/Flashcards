import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { decideAxis, swipeDirection, type GestureAxis, type SwipeDirection } from '../lib/gesture.js';

export interface SwipeOptions {
  thresholdPx: number;
  slopPx: number;
  onSwipe: (direction: SwipeDirection) => void;
}

interface ActiveGesture {
  pointerId: number;
  startX: number;
  startY: number;
  axis: GestureAxis;
}

/** A click this soon after a drag ends is the drag's own trailing click, not a tap. */
const TRAILING_CLICK_MS = 350;

/**
 * Horizontal swipe detection for touch and pen. Mouse drags are left alone so
 * text on the card can still be selected. The element should set
 * `touch-action: pan-y` so vertical scrolling stays with the browser.
 */
export function useSwipe({ thresholdPx, slopPx, onSwipe }: SwipeOptions) {
  const gesture = useRef<ActiveGesture | null>(null);
  const dragEndedAt = useRef(Number.NEGATIVE_INFINITY);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const finish = useCallback(() => {
    gesture.current = null;
    setOffset(0);
    setDragging(false);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    // A new touch starts a new gesture: its click is its own, not the last drag's.
    dragEndedAt.current = Number.NEGATIVE_INFINITY;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: 'undecided',
    };
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (active === null || active.pointerId !== event.pointerId) return;
      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;

      if (active.axis === 'undecided') {
        active.axis = decideAxis(dx, dy, slopPx);
        if (active.axis === 'vertical') {
          finish(); // The user is scrolling.
          return;
        }
        if (active.axis === 'horizontal') {
          setDragging(true);
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Capture is a nicety; the gesture still works without it.
          }
        }
      }
      if (active.axis === 'horizontal') setOffset(dx);
    },
    [finish, slopPx],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (active === null || active.pointerId !== event.pointerId) return;
      const wasDrag = active.axis === 'horizontal';
      const direction = wasDrag ? swipeDirection(event.clientX - active.startX, thresholdPx) : null;
      finish();
      if (wasDrag) dragEndedAt.current = performance.now();
      if (direction !== null) onSwipe(direction);
    },
    [finish, onSwipe, thresholdPx],
  );

  /** True when a click should be ignored because it merely ended a drag. */
  const isTrailingClick = useCallback(
    () => performance.now() - dragEndedAt.current < TRAILING_CLICK_MS,
    [],
  );

  // Reset gesture state on unmount to prevent stale state from leaking across remounts.
  useEffect(() => {
    return () => {
      gesture.current = null;
    };
  }, []);

  return {
    offset,
    dragging,
    /** Set once the drag has travelled far enough that releasing would answer. */
    armed: swipeDirection(offset, thresholdPx),
    isTrailingClick,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: finish },
  };
}
