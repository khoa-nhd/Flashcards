/** Shared class lists, so every page draws its controls the same way. */

const BUTTON_BASE =
  'inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

export const BUTTON_PRIMARY = `${BUTTON_BASE} bg-accent text-white dark:text-paper`;
export const BUTTON_SECONDARY = `${BUTTON_BASE} border border-line bg-surface text-ink hover:border-muted`;
export const BUTTON_DANGER = `${BUTTON_BASE} bg-bad text-white dark:text-paper`;
export const BUTTON_GHOST = `${BUTTON_BASE} text-muted hover:bg-line/40 hover:text-ink`;

export const INPUT =
  'h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted/70 disabled:opacity-60';
export const TEXTAREA =
  'w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-muted/70 disabled:opacity-60';
export const LABEL = 'text-sm font-medium text-ink';
export const HELP = 'text-xs text-muted';
export const FIELD_ERROR = 'text-xs font-medium text-bad-ink';

export const CARD = 'rounded-2xl border border-line bg-surface';
export const SECTION_TITLE = 'text-sm font-semibold tracking-tight text-ink';
export const PAGE = 'mx-auto w-full max-w-5xl px-4 py-5 md:px-8 md:py-7';
