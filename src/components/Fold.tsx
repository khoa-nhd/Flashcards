/**
 * A part of a page that can be put away: closed on a phone and open on a
 * computer unless the reader chose otherwise, which this browser remembers.
 */
import { useState, type ReactNode } from 'react';
import { Icon } from './Icon.js';

const remembered = (key: string): boolean | null => {
  try {
    const value = window.localStorage.getItem(`flashcards:fold:${key}`);
    return value === null ? null : value === 'open';
  } catch {
    return null;
  }
};

const remember = (key: string, open: boolean) => {
  try {
    window.localStorage.setItem(`flashcards:fold:${key}`, open ? 'open' : 'closed');
  } catch {
    // Without storage the default comes back next time; nothing else depends on it.
  }
};

/** Wider than a phone; where the screen cannot be measured, taken as wide so nothing starts hidden. */
const wide = () =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches;

export function Fold({
  id,
  title,
  hint,
  children,
  openOnWide = true,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
  openOnWide?: boolean;
}) {
  const [open, setOpen] = useState(() => remembered(id) ?? (openOnWide && wide()));
  return (
    <section className="flex flex-col gap-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          remember(id, !open);
          setOpen(!open);
        }}
        className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3 text-left transition-colors hover:border-line-strong"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-ink">{title}</span>
          {hint !== undefined && <span className="truncate text-xs text-muted">{hint}</span>}
        </span>
        <Icon
          name="right"
          className={`size-4 shrink-0 text-faint transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && <div className="flex flex-col gap-6">{children}</div>}
    </section>
  );
}
