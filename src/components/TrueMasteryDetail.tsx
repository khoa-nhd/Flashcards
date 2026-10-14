import { STUDY_MODE_LABELS } from '../../shared/study-modes.js';
import {
  calculateTrueMastery,
  getEvidenceCoverageLabel,
  getTrueMasteryTier,
  type PracticeAnswer,
  type ModeBreakdown,
} from '../../shared/true-mastery.js';

/** Detailed True Mastery breakdown for a single vocabulary item. */
export function TrueMasteryDetail({
  answers,
  today,
}: {
  answers: PracticeAnswer[];
  today: string | null;
}) {
  const result = answers.length > 0 && today
    ? calculateTrueMastery(answers, today)
    : null;

  if (!result || result.mastery === null) {
    return (
      <section aria-labelledby="true-mastery-heading" className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 id="true-mastery-heading" className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
          True Mastery
        </h3>
        <p className="text-sm text-muted">
          {answers.length === 0
            ? 'No practice history yet. Start practising to build evidence.'
            : 'Insufficient evidence for a reliable estimate. Keep practising across modes.'}
        </p>
        <p className="text-xs text-muted">
          True Mastery is an evidence-based estimate (0–100) of how well you know this word,
          drawn from your practice history across all modes. It is separate from Review Mastery
          (which drives the schedule) and Practice Mastery (per-mode progress up to 3).
        </p>
      </section>
    );
  }

  const { mastery, coverage } = result;

  const tier = getTrueMasteryTier(mastery);
  const coverageLabel = getEvidenceCoverageLabel(coverage);

  // Helper to get mode label safely
  const getModeLabel = (mode: string) => STUDY_MODE_LABELS[mode as keyof typeof STUDY_MODE_LABELS] ?? mode;

  // Find the mode breakdown for a given mode
  const getModeBreakdown = (mode: string): ModeBreakdown | undefined =>
    result.modes.find(m => m.mode === mode);

  return (
    <section aria-labelledby="true-mastery-heading" className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id="true-mastery-heading" className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
        True Mastery
      </h3>

      {/* Overall score and tier */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-medium ${
              tier === 'Excellent' ? 'bg-good-soft text-good-ink' :
              tier === 'Strong' ? 'bg-accent-soft text-accent' :
              tier === 'Good' ? 'bg-accent-soft text-accent' :
              tier === 'Developing' ? 'bg-warn-soft text-warn-ink' :
              tier === 'Weak' ? 'bg-bad-soft text-bad-ink' :
              'bg-line/50 text-muted'
            }`}
          >
            {tier} ({mastery})
          </span>
          <span className="text-xs text-muted" title={coverageLabel}>
            {coverageLabel}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-accent-soft">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${mastery}%` }} />
          </div>
        </div>
      </div>

      {/* Confidence/evidence summary */}
      <p className="text-xs text-muted">
        Based on {result.totalEffectiveEvidence.toFixed(1)} effective evidence across {result.modesWithEvidence} mode{result.modesWithEvidence === 1 ? '' : 's'}.
        {result.modesWithEvidence > 1 && ` Coverage: {coverageLabel}.`}
      </p>

      {/* Mode breakdown */}
      <div className="grid grid-cols-2 gap-2">
        {result.modes.map(({ mode, accuracy, effectiveEvidence, lastAttemptedOn }) => {
          const breakdown = getModeBreakdown(mode);
          const confidence = breakdown?.confidence ?? 0;
          return (
            <div key={mode} className="rounded-xl border border-line bg-surface/50 p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium text-sm">{getModeLabel(mode)}</span>
                <span className="text-xs text-muted">{breakdown?.correctAnswers ?? 0}/{breakdown?.totalAnswers ?? 0} correct</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-accent-soft">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(accuracy * 100)}%` }} />
              </div>
              <div className="flex items-center justify-between text-xs text-muted mt-1">
                <span>Evidence: {effectiveEvidence.toFixed(1)}</span>
                <span>Confidence: {Math.round(confidence * 100)}%</span>
              </div>
              {lastAttemptedOn && (
                <p className="text-xs text-muted mt-1">Last tried: {lastAttemptedOn}</p>
              )}
            </div>
          );
        })}

        {/* Modes with no evidence */}
        {['recognition', 'recall', 'typing', 'cloze', 'listening'].filter(mode => !result.modes.some(m => m.mode === mode)).map(mode => (
          <div key={mode} className="col-span-2 rounded-xl border border-line bg-surface/50 p-3 text-center text-xs text-muted">
            {getModeLabel(mode)}: No practice data yet.
          </div>
        ))}
      </div>

      {/* Explanation and next steps */}
      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer font-medium text-sm text-accent hover:underline">
          How this works & what to do next
        </summary>
        <div className="mt-2 flex flex-col gap-1.5 text-xs text-muted">
          <p>
            True Mastery estimates how well you know this word (0–100) based on your practice history.
            Each mode contributes differently: Typing and Fill-in-the-blank are stronger signals than Recognition.
          </p>
          <p>
            Evidence decays over time (30-day half-life). Recent correct answers count more than old ones.
            Self-graded Recall answers are included but weighted appropriately.
          </p>
          <p>
            Confidence grows with more independent evidence. Duplicates in the same session don't inflate it.
          </p>
          <p>
            <strong>Next step:</strong>{' '}
            {result.modes.length === 0
              ? 'Start practising any mode to begin building evidence.'
              : result.modesWithEvidence < 3
                ? `Try a mode you haven't practised yet (e.g., ${getModeLabel(['recognition', 'recall', 'typing', 'cloze', 'listening'].find(m => !result.modes.some(mod => mod.mode === m))!)}) to broaden the evidence base.`
                : result.modes.some(m => m.confidence < 0.5)
                  ? `Focus on ${result.modes.filter(m => m.confidence < 0.5).map(m => getModeLabel(m.mode)).join(', ')} where evidence is thin.`
                  : result.modes.some(m => m.accuracy < 0.7)
                    ? `Review ${result.modes.filter(m => m.accuracy < 0.7).map(m => getModeLabel(m.mode)).join(', ')} where accuracy is low.`
                    : 'Evidence is strong across modes. Keep maintaining with occasional practice.'
            }
          </p>
        </div>
      </details>
    </section>
  );
}