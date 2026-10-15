/**
 * True Mastery Estimate
 *
 * An evidence-based estimate (0-100) of how well a user has learned a
 * vocabulary item, computed from practice history across modes.
 *
 * This is an estimate, not a ground-truth measurement. The UI must make
 * this limitation clear.
 */

import type { IsoDate } from './dates.js';

/** Configuration for True Mastery calculation */
export interface TrueMasteryConfig {
  /** Recency half-life in days (older answers weighted exponentially less) */
  recencyHalfLifeDays: number;
  /** Beta prior alpha (pseudocounts for correct answers) */
  priorAlpha: number;
  /** Beta prior beta (pseudocounts for incorrect answers) */
  priorBeta: number;
  /** Confidence scaling parameter k (confidence = n_eff / (n_eff + k)) */
  confidenceK: number;
  /** Minimum effective evidence for "low evidence" threshold */
  minEvidenceLow: number;
  /** Minimum effective evidence for "moderate evidence" threshold */
  minEvidenceModerate: number;
  /** Minimum effective evidence for "high evidence" threshold */
  minEvidenceHigh: number;
  /** Minimum number of modes with evidence for "moderate evidence" */
  minModesModerate: number;
  /** Minimum number of modes with evidence for "high evidence" */
  minModesHigh: number;
  /** Practice mode weights (evidence strength) */
  modeWeights: Record<string, number>;
  /** Session cap: max effective evidence from one session */
  sessionMaxEffectiveEvidence: number;
  /** Weight multiplier for self-graded (recall) answers vs auto-graded.
   * Self-graded answers are less reliable evidence, so we discount them. */
  recallSelfGradeWeightMultiplier: number;
}

export const DEFAULT_TRUE_MASTERY_CONFIG: TrueMasteryConfig = {
  recencyHalfLifeDays: 30,
  priorAlpha: 2,
  priorBeta: 2,
  confidenceK: 5,
  minEvidenceLow: 1,
  minEvidenceModerate: 5,
  minEvidenceHigh: 15,
  minModesModerate: 2,
  minModesHigh: 3,
  modeWeights: {
    recognition: 0.15,
    recall: 0.20,
    typing: 0.30,
    cloze: 0.25,
    listening: 0.10,
  },
  sessionMaxEffectiveEvidence: 3,
  /** Self-graded recall answers are discounted to 50% weight vs auto-graded modes */
  recallSelfGradeWeightMultiplier: 0.5,
};

/** One practice answer with full detail */
export interface PracticeAnswer {
  vocabularyId: string;
  /** Unique request ID from the practice attempt (for deduplication).
   * Optional for backward compatibility with older schema versions. */
  requestId?: string;
  mode: string;
  correct: boolean;
  grading: 'self' | 'auto';
  submitted: string | null;
  reviewedOn: IsoDate;
  reviewedAt: string;
  durationMs: number | null;
  confidence: number | null;
  sessionId: string | null;
}

/** Per-mode True Mastery breakdown */
export interface ModeBreakdown {
  mode: string;
  /** Smoothed accuracy (0-1) */
  accuracy: number;
  /** Effective evidence count */
  effectiveEvidence: number;
  /** Confidence (0-1) */
  confidence: number;
  /** Weight for this mode */
  weight: number;
  /** Total answers */
  totalAnswers: number;
  /** Correct answers */
  correctAnswers: number;
  /** Incorrect answers */
  incorrectAnswers: number;
  /** Last attempted date */
  lastAttemptedOn: IsoDate | null;
  /** Whether answers in this mode are self-graded (recall) or auto-graded */
  grading: 'self' | 'auto';
}

/** Evidence coverage level */
export type EvidenceCoverage = 'insufficient' | 'low' | 'moderate' | 'high';

/** Result of True Mastery calculation */
export interface TrueMasteryResult {
  /** True Mastery estimate (0-100), null if insufficient data */
  mastery: number | null;
  /** Evidence coverage level */
  coverage: EvidenceCoverage;
  /** Total effective evidence across all modes */
  totalEffectiveEvidence: number;
  /** Number of modes with any evidence */
  modesWithEvidence: number;
  /** Per-mode breakdown */
  modes: ModeBreakdown[];
  /** Whether any practice data exists */
  hasAnyPractice: boolean;
  /** Config used (for transparency) */
  config: TrueMasteryConfig;
}

/** Internal per-mode computation */
interface ModeComputation {
  mode: string;
  accuracy: number;
  effectiveEvidence: number;
  confidence: number;
  weight: number;
  totalAnswers: number;
  correctAnswers: number;
  incorrectAnswers: number;
  lastAttemptedOn: IsoDate | null;
  grading: 'self' | 'auto';
}

/**
 * Calculate True Mastery from practice history.
 *
 * @param answers - All practice answers for a vocabulary item
 * @param today - The reviewer's current date (for recency calculation)
 * @param config - Optional config overrides
 * @returns True Mastery estimate with breakdown
 */
export function calculateTrueMastery(
  answers: PracticeAnswer[],
  today: IsoDate,
  config: Partial<TrueMasteryConfig> = {}
): TrueMasteryResult {
  const cfg = { ...DEFAULT_TRUE_MASTERY_CONFIG, ...config };

  if (answers.length === 0) {
    return {
      mastery: null,
      coverage: 'insufficient',
      totalEffectiveEvidence: 0,
      modesWithEvidence: 0,
      modes: [],
      hasAnyPractice: false,
      config: cfg,
    };
  }

  // Group answers by mode
  const byMode = new Map<string, PracticeAnswer[]>();
  for (const a of answers) {
    const arr = byMode.get(a.mode) ?? [];
    arr.push(a);
    byMode.set(a.mode, arr);
  }

  // Compute per-mode
  const modeComputations: ModeComputation[] = [];
  for (const [mode, modeAnswers] of byMode) {
    const computation = computeMode(mode, modeAnswers, today, cfg);
    if (computation.effectiveEvidence > 0) {
      modeComputations.push(computation);
    }
  }

  if (modeComputations.length === 0) {
    return {
      mastery: null,
      coverage: 'insufficient',
      totalEffectiveEvidence: 0,
      modesWithEvidence: 0,
      modes: [],
      hasAnyPractice: true,
      config: cfg,
    };
  }

  // Aggregate across modes
  let weightedSum = 0;
  let weightSum = 0;
  let totalEffectiveEvidence = 0;

  for (const m of modeComputations) {
    const w = m.weight * m.confidence;
    weightedSum += w * m.accuracy;
    weightSum += w;
    totalEffectiveEvidence += m.effectiveEvidence;
  }

  const mastery = weightSum > 0 ? Math.round((weightedSum / weightSum) * 100) : null;

  // Determine evidence coverage
  const modesWithEvidence = modeComputations.length;
  let coverage: EvidenceCoverage = 'insufficient';
  if (totalEffectiveEvidence >= cfg.minEvidenceHigh && modesWithEvidence >= cfg.minModesHigh) {
    coverage = 'high';
  } else if (totalEffectiveEvidence >= cfg.minEvidenceModerate && modesWithEvidence >= cfg.minModesModerate) {
    coverage = 'moderate';
  } else if (totalEffectiveEvidence >= cfg.minEvidenceLow) {
    coverage = 'low';
  }

  // Build mode breakdowns
  const modes: ModeBreakdown[] = modeComputations.map((m) => ({
    mode: m.mode,
    accuracy: Math.round(m.accuracy * 10000) / 10000,
    effectiveEvidence: Math.round(m.effectiveEvidence * 100) / 100,
    confidence: Math.round(m.confidence * 10000) / 10000,
    weight: m.weight,
    totalAnswers: m.totalAnswers,
    correctAnswers: m.correctAnswers,
    incorrectAnswers: m.incorrectAnswers,
    lastAttemptedOn: m.lastAttemptedOn,
    grading: m.grading,
  }));

  return {
    mastery,
    coverage,
    totalEffectiveEvidence: Math.round(totalEffectiveEvidence * 100) / 100,
    modesWithEvidence,
    modes,
    hasAnyPractice: true,
    config: cfg,
  };
}

/**
 * Compute per-mode accuracy, effective evidence, and confidence.
 */
function computeMode(
  mode: string,
  answers: PracticeAnswer[],
  today: IsoDate,
  cfg: TrueMasteryConfig
): ModeComputation {
  const baseWeight = cfg.modeWeights[mode] ?? 0;

  // Filter out future dates and invalid events, sort by reviewedAt for session detection
  // A valid event must have: requestId, reviewedOn, reviewedAt, mode, correct, grading
  const validAnswers = answers
    .filter((a) => {
      const d = daysBetween(a.reviewedOn, today);
      return d >= 0
        && a.requestId != null && a.requestId !== ''
        && a.reviewedOn != null
        && a.reviewedAt != null
        && a.mode != null
        && typeof a.correct === 'boolean'
        && (a.grading === 'self' || a.grading === 'auto');
    })
    .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));

  let weightedCorrect = 0;
  let weightedIncorrect = 0;
  let totalEffective = 0;
  let lastAttemptedOn: IsoDate | null = null;
  let correctAnswers = 0;
  let incorrectAnswers = 0;

  // Session-based aggregation to prevent retry inflation
  // Group by sessionId, then within each session deduplicate by requestId (keep last)
  const sessions = new Map<string, PracticeAnswer[]>();
  for (const a of validAnswers) {
    const sid = a.sessionId ?? `solo:${a.reviewedAt}`;
    const arr = sessions.get(sid) ?? [];
    arr.push(a);
    sessions.set(sid, arr);
  }

  for (const [, sessionAnswers] of sessions) {
    // Within a session, deduplicate by requestId (keep last answer for each unique requestId)
    // For answers without requestId (older schema), fall back to reviewedAt as a key
    const byRequestId = new Map<string, PracticeAnswer>();
    for (const a of sessionAnswers) {
      const key = a.requestId ?? `fallback:${a.reviewedAt}`;
      byRequestId.set(key, a);
    }
    const uniqueAnswers = Array.from(byRequestId.values());

    // Cap effective evidence per session at sessionMaxEffectiveEvidence
    let sessionWeightedCorrect = 0;
    let sessionWeightedIncorrect = 0;
    let sessionTotalEffective = 0;

    for (const a of uniqueAnswers) {
      const y = a.correct ? 1 : 0;
      if (y === 1) correctAnswers++;
      else incorrectAnswers++;

      const d = daysBetween(a.reviewedOn, today);
      if (d < 0) continue; // Future date, ignore (should not happen due to pre-filter)
      const r = Math.pow(2, -d / cfg.recencyHalfLifeDays);

      // Apply recall self-grade weight multiplier for self-graded recall answers
      const selfGradeMultiplier = (a.mode === 'recall' && a.grading === 'self')
        ? cfg.recallSelfGradeWeightMultiplier
        : 1;

      sessionWeightedCorrect += r * y * selfGradeMultiplier;
      sessionWeightedIncorrect += r * (1 - y) * selfGradeMultiplier;
      sessionTotalEffective += r * selfGradeMultiplier;

      if (lastAttemptedOn === null || a.reviewedOn > lastAttemptedOn) {
        lastAttemptedOn = a.reviewedOn;
      }
    }

    // Cap effective evidence per session
    const sessionCap = cfg.sessionMaxEffectiveEvidence;
    if (sessionTotalEffective > sessionCap) {
      const scale = sessionCap / sessionTotalEffective;
      sessionWeightedCorrect *= scale;
      sessionWeightedIncorrect *= scale;
      sessionTotalEffective = sessionCap;
    }

    weightedCorrect += sessionWeightedCorrect;
    weightedIncorrect += sessionWeightedIncorrect;
    totalEffective += sessionTotalEffective;
  }

  // Beta smoothing
  const alpha = cfg.priorAlpha + weightedCorrect;
  const beta = cfg.priorBeta + weightedIncorrect;
  const accuracy = alpha / (alpha + beta);

  // Confidence from effective evidence
  const confidence = totalEffective / (totalEffective + cfg.confidenceK);

  // Apply recall self-grade multiplier to the mode's base weight
  // This reflects that self-graded evidence is less reliable
  const weight = baseWeight;

  return {
    mode,
    accuracy,
    effectiveEvidence: totalEffective,
    confidence,
    weight,
    totalAnswers: answers.length, // Original count including future/invalid
    correctAnswers,
    incorrectAnswers,
    lastAttemptedOn,
    grading: mode === 'recall' ? 'self' : 'auto',
  };
}

/**
 * Days between two ISO dates (from -> to).
 * Returns negative if 'from' is after 'to'.
 */
function daysBetween(from: IsoDate, to: IsoDate): number {
  const [fy, fm, fd] = from.split('-').map((v) => Number(v)) as [number, number, number];
  const [ty, tm, td] = to.split('-').map((v) => Number(v)) as [number, number, number];
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

/**
 * Get evidence coverage label.
 */
export function getEvidenceCoverageLabel(coverage: EvidenceCoverage): string {
  switch (coverage) {
    case 'insufficient':
      return 'Insufficient data';
    case 'low':
      return 'Low evidence';
    case 'moderate':
      return 'Moderate evidence';
    case 'high':
      return 'High evidence';
  }
}

/**
 * Format True Mastery for display.
 */
export function formatTrueMastery(result: TrueMasteryResult): string {
  if (result.mastery === null) return '—';
  return `${result.mastery}`;
}

/**
 * Get tier label for True Mastery score.
 */
export function getTrueMasteryTier(score: number | null): string {
  if (score === null) return 'Unknown';
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Strong';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Developing';
  if (score >= 20) return 'Weak';
  return 'New';
}