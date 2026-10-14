import type { ReviewAction } from '../../shared/review-logic.js';
import { Spinner } from './Spinner.js';

export interface ReviewControlsProps {
  /** False until the card is flipped, or while an earlier answer is still being saved. */
  enabled: boolean;
  /** An earlier answer is on its way to the server; the card is only being read. */
  saving: boolean;
  onGrade: (action: ReviewAction) => void;
  /** A button was pressed while answering is not allowed yet. */
  onBlocked: () => void;
}

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
    tone: 'border-bad/35 bg-bad-soft text-bad-ink hover:border-bad',
  },
  {
    action: 'remember',
    label: 'Remember',
    shortcut: 'ArrowRight',
    keyLabel: '→',
    tone: 'border-good/35 bg-good-soft text-good-ink hover:border-good',
  },
];

const KEY_HINT = 'hidden rounded border border-current/30 px-1.5 text-sm keyboard:inline';

export function ReviewControls({ enabled, saving, onGrade, onBlocked }: ReviewControlsProps) {
  return (
    <div className="grid grid-cols-2 gap-3" role="group" aria-label="Your answer">
      {BUTTONS.map(({ action, label, shortcut, keyLabel, tone }) => {
        const active = enabled && !saving;
        return (
          <button
            key={action}
            type="button"
            // aria-disabled (not disabled) keeps focus and key events alive while the button is inert.
            aria-disabled={!active}
            aria-keyshortcuts={shortcut}
            aria-busy={saving}
            onClick={() => {
              if (active) onGrade(action);
              else if (!saving) onBlocked();
            }}
            className={`flex h-14 items-center justify-center gap-2 rounded-2xl border text-base font-semibold transition ${tone} ${
              active ? 'cursor-pointer active:scale-[0.98]' : 'cursor-not-allowed'
            } ${active || saving ? '' : 'opacity-45'}`}
          >
            {/* The key hints are decoration: aria-keyshortcuts already announces them. */}
            {action === 'not_remember' && (
              <kbd aria-hidden="true" className={KEY_HINT}>
                {keyLabel}
              </kbd>
            )}
            {saving && <Spinner />}
            <span>{label}</span>
            {action === 'remember' && (
              <kbd aria-hidden="true" className={KEY_HINT}>
                {keyLabel}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}
