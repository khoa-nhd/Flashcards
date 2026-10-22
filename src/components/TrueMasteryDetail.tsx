import { STUDY_MODE_LABELS, STUDY_MODES } from '../../shared/study-modes.js';
import {
  calculateTrueMastery,
  getEvidenceCoverageLabel,
  getTrueMasteryTier,
  type PracticeAnswer,
  type ModeBreakdown,
} from '../../shared/true-mastery.js';
import { useVocabulary } from '../app-context.js';
import { formatDate, relativeDay } from './badges.js';

/** Detailed True Mastery breakdown for a single vocabulary item. */
export function TrueMasteryDetail({
  answers,
  today,
}: {
  answers: PracticeAnswer[];
  today: string | null;
}) {
  const fsrsOnly = useVocabulary().meta?.fsrsOnly === true;
  const scoreName = fsrsOnly ? 'Practice score' : 'True Mastery';
  const result = answers.length > 0 && today
    ? calculateTrueMastery(answers, today)
    : null;

  // Insufficient data or no answers
  if (!result || result.mastery === null) {
    return (
      <section aria-labelledby="true-mastery-heading" className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 id="true-mastery-heading" className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
          {scoreName}
        </h3>
        <p className="text-sm text-muted">
          {answers.length === 0
            ? 'No practice history yet. Start practising to build evidence.'
            : 'Insufficient evidence for a reliable estimate. Keep practising across modes.'}
        </p>
        <p className="text-xs text-muted">
          {fsrsOnly
            ? 'Practice score is an evidence-based estimate (0–100) of how well you know this word, drawn from practice answers across all modes. It is separate from memory strength and per-mode practice progress, and it never changes when a word is due.'
            : 'True Mastery is an evidence-based estimate (0–100) of how well you know this word, drawn from your practice history across all modes. It is separate from Review Mastery (which drives the schedule) and Practice Mastery (per-mode progress up to 3).'}
        </p>
      </section>
    );
  }

  const { mastery, coverage, totalEffectiveEvidence, modesWithEvidence, modes } = result;

  const tier = getTrueMasteryTier(mastery);
  const coverageLabel = getEvidenceCoverageLabel(coverage);

  // Helper to get mode label safely
  const getModeLabel = (mode: string) => STUDY_MODE_LABELS[mode as keyof typeof STUDY_MODE_LABELS] ?? mode;

  // Find the mode breakdown for a given mode
  const getModeBreakdown = (mode: string): ModeBreakdown | undefined =>
    result.modes.find(m => m.mode === mode);

  // Every mode the app offers, in a fixed order.
  const allModes: Array<typeof STUDY_MODES[number]> = [...STUDY_MODES];

  // Find the most recent practice activity across all modes
  const mostRecent = answers
    .filter(a => a.reviewedOn !== null)
    .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0];

  // Find modes with evidence
  const modesWithEvidenceSet = new Set(modes.map(m => m.mode));

  return (
    <section aria-labelledby="true-mastery-heading" className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id="true-mastery-heading" className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
        {scoreName}
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
              'bg-line-strong/60 text-muted'
            }`}
          >
            {tier} ({mastery})
          </span>
          <span className="text-xs text-muted" title={coverageLabel}>
            {coverageLabel}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-accent-soft" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={mastery} aria-label={`${scoreName} ${mastery} out of 100`}>
            <span className="block h-full rounded-full bg-accent" style={{ width: `${mastery}%` }} />
          </div>
        </div>
      </div>

      {/* Confidence/evidence summary */}
      <p className="text-xs text-muted">
        Based on {totalEffectiveEvidence.toFixed(1)} effective evidence across {modesWithEvidence} mode{modesWithEvidence === 1 ? '' : 's'}.
        {modesWithEvidence > 1 && ` Coverage: ${coverageLabel}.`}
      </p>

      {/* Most recent practice activity */}
      {mostRecent && (
        <p className="text-xs text-muted">
          Most recent: {getModeLabel(mostRecent.mode)} on {formatDate(mostRecent.reviewedOn, 'short')} ({relativeDay(mostRecent.reviewedOn, today ?? '')})
          {mostRecent.correct ? ' — correct' : ' — incorrect'}
        </p>
      )}

      {/* Mode breakdown */}
      <div className="grid grid-cols-2 gap-2">
        {allModes.map(mode => {
          const breakdown = getModeBreakdown(mode);
          const hasEvidence = !!breakdown && breakdown.totalAnswers > 0;

          if (hasEvidence) {
            const confidence = breakdown?.confidence ?? 0;
            const confidencePercent = Math.round(confidence * 100);
            return (
              <div key={mode} className="rounded-xl border border-line bg-paper p-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-medium text-sm">{getModeLabel(mode)}</span>
                  <span className="text-xs text-muted">{breakdown?.correctAnswers ?? 0}/{breakdown?.totalAnswers ?? 0} correct</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-accent-soft" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(breakdown?.accuracy * 100)} aria-label={`${getModeLabel(mode)} accuracy ${Math.round(breakdown?.accuracy * 100)}%`}>
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(breakdown?.accuracy * 100)}%` }} />
                </div>
                <div className="flex items-center justify-between text-xs text-muted mt-1">
                  <span>Evidence: {breakdown?.effectiveEvidence.toFixed(1) ?? '0'}</span>
                  <span>Confidence: {confidencePercent}%</span>
                </div>
                {breakdown?.lastAttemptedOn && (
                  <div className="flex items-center justify-end text-xs text-muted mt-0.5">
                    <span>Last: {formatDate(breakdown.lastAttemptedOn, 'short')}</span>
                  </div>
                )}
              </div>
            );
          }

          // Mode without evidence
          return (
            <div key={mode} className="col-span-2 rounded-xl border border-line bg-paper p-3 text-center text-xs text-muted">
              {getModeLabel(mode)}: No practice data yet.
            </div>
          );
        })}
      </div>

      {/* Explanation and next steps */}
      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer font-medium text-sm text-accent hover:underline">
          How this works & what to do next
        </summary>
        <div className="mt-2 flex flex-col gap-1.5 text-xs text-muted">
          <p>
            {fsrsOnly
              ? 'Practice score estimates how well you know this word (0–100) from your practice answers. It never changes the schedule or memory strength.'
              : 'True Mastery estimates how well you know this word (0–100) based on your practice history.'}{' '}
            Each mode contributes differently: Typing and Fill-in-the-blank are stronger signals than Recognition.
          </p>
          <p>
            Evidence decays over time (30-day half-life). Recent correct answers count more than old ones.
          </p>
          <p>
            Confidence grows with more independent evidence. Duplicates in the same session don't inflate it.
          </p>
          <p>
            <strong>Next step:</strong>{' '}
            {result.modes.length === 0
              ? 'Start practising any mode to begin building evidence.'
              : result.modesWithEvidence < 3
                ? `Try a mode you haven't practised yet (e.g., ${getModeLabel(allModes.find(m => !modesWithEvidenceSet.has(m))!)}) to broaden the evidence base.`
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