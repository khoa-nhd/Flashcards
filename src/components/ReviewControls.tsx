import type { ReviewAction } from '../../shared/review-logic.js';

export interface ReviewControlsProps {
  /** False until the card is flipped. An earlier answer on its way never disables these. */
  enabled: boolean;
  onGrade: (action: ReviewAction) => void;
  /** A button was pressed while answering is not allowed yet. */
  onBlocked: () => void;
}

/**
 * Left is “Not remember”, right is “Remember”, matching the arrow keys and
 * the swipe directions. The same order holds on the phone.
 */
const BUTTONS: Array<{
  action: ReviewAction;
  label: string;
  shortcut: string;
  keyLabel: string;
  tone: string;
}> = [
  {
    action: 'not_remember',
    label: 'Not remember',
    shortcut: 'ArrowLeft',
    keyLabel: '←',
    tone: 'border-line-strong bg-transparent text-ink hover:border-muted hover:bg-line/25',
  },
  {
    action: 'remember',
    label: 'Remember',
    shortcut: 'ArrowRight',
    keyLabel: '→',
    tone: 'border-transparent bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-on-accent',
  },
];

const KEY_HINT = 'hidden rounded border border-current/30 px-1.5 py-0.5 text-xs keyboard:inline';

export function ReviewControls({ enabled, onGrade, onBlocked }: ReviewControlsProps) {
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Your answer">
      {BUTTONS.map(({ action, label, shortcut, keyLabel, tone }) => (
        <button
          key={action}
          type="button"
          // aria-disabled (not disabled) keeps focus and key events alive while the button is inert.
          aria-disabled={!enabled}
          aria-keyshortcuts={shortcut}
          onClick={() => {
            if (enabled) onGrade(action);
            else onBlocked();
          }}
          className={`flex h-12 sm:h-14 items-center justify-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl border text-[0.875rem] sm:text-[0.9375rem] font-semibold tracking-[-0.01em] transition-[color,background-color,border-color,transform] duration-150 ${tone} ${
            enabled ? 'cursor-pointer active:scale-[0.98]' : 'cursor-not-allowed opacity-45'
          }`}
        >
          {/* The key hints are decoration: aria-keyshortcuts already announces them. */}
          {action === 'not_remember' && (
            <kbd aria-hidden="true" className={KEY_HINT}>
              {keyLabel}
            </kbd>
          )}
          <span>{label}</span>
          {action === 'remember' && (
            <kbd aria-hidden="true" className={KEY_HINT}>
              {keyLabel}
            </kbd>
          )}
        </button>
      ))}
    </div>
  );
}
