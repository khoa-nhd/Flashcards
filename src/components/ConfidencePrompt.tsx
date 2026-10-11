import type { Confidence } from '../../shared/api.js';

export const CONFIDENCE_LABELS: Record<Confidence, string> = { 1: 'Low', 2: 'Medium', 3: 'High' };

const LEVELS: Confidence[] = [1, 2, 3];

const KEY_HINT = 'hidden rounded border border-current/30 px-1.5 text-xs keyboard:inline';

/**
 * Asked before the answer is shown: how sure are you? Choosing shows the
 * answer. It can be skipped by simply flipping the card; the rating is kept
 * beside the answer and never changes what the answer does.
 */
export function ConfidencePrompt({ onRate }: { onRate: (level: Confidence) => void }) {
  return (
    <div role="group" aria-labelledby="confidence-prompt-label" className="flex flex-col gap-2">
      <p id="confidence-prompt-label" className="text-center text-sm font-medium text-muted">
        How sure are you that you know it?
      </p>
      <div className="grid grid-cols-3 gap-2">
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            aria-keyshortcuts={String(level)}
            aria-label={`${CONFIDENCE_LABELS[level]} confidence`}
            onClick={() => onRate(level)}
            className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-surface text-sm font-semibold transition hover:border-muted active:scale-[0.98]"
          >
            <kbd aria-hidden="true" className={KEY_HINT}>
              {level}
            </kbd>
            <span>{CONFIDENCE_LABELS[level]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
