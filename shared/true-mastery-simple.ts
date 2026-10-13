/**
 * True Mastery - Simple Adjustment Formula
 * 
 * Instead of 6 weighted components, this uses a simple adjustment formula:
 * 
 *   true_mastery = base_mastery + adjustments
 * 
 * Where adjustments are bounded and intuitive:
 * - Accuracy bonus/penalty: ±2.0
 * - Recency bonus/penalty: ±1.5  
 * - FSRS retrievability: ±1.5
 * - Consistency across modes: ±1.0
 * - Overdue penalty: -0.5 per day (max -3.0)
 * 
 * Result clamped to 0-10.
 * 
 * This is much simpler than 6 weighted components while still
 * capturing the key signals that indicate true mastery.
 */

import type { VocabularyRecord } from './vocabulary.js';
import type { CardHistory } from './weak-words.js';
import type { FsrsState } from './scheduler/fsrs.js';
import type { Confidence } from './api.js';

/** Configuration for adjustment bounds */
export interface TrueMasteryConfig {
  /** Maximum total adjustment (positive or negative) */
  maxAdjustment: number;
  /** Accuracy weight */
  accuracyWeight: number;
  /** Recency weight */
  recencyWeight: number;
  /** FSRS retrievability weight */
  fsrsWeight: number;
  /** Mode consistency weight */
  consistencyWeight: number;
  /** Overdue penalty per day */
  overduePenaltyPerDay: number;
  /** Maximum overdue penalty */
  maxOverduePenalty: number;
}

export const DEFAULT_TRUE_MASTERY_CONFIG: TrueMasteryConfig = {
  maxAdjustment: 3.0,
  accuracyWeight: 2.0,
  recencyWeight: 1.5,
  fsrsWeight: 1.5,
  consistencyWeight: 1.0,
  overduePenaltyPerDay: 0.5,
  maxOverduePenalty: 3.0,
};

/** Input data for true mastery calculation */
export interface TrueMasteryInput {
  record: VocabularyRecord;
  modeMastery?: Record<string, number>;
  history?: CardHistory | null;
  fsrs?: FsrsState | null;
  recentConfidence?: Confidence[];
  today: string;
  reviewStatus?: 'mastered' | 'overdue' | 'due_today' | 'unscheduled' | 'upcoming' | 'invalid';
  config?: Partial<TrueMasteryConfig>;
}

/** Result of true mastery calculation */
export interface TrueMasteryResult {
  /** Final true mastery 0-10 */
  mastery: number;
  /** Base mastery before adjustments */
  baseMastery: number;
  /** Total adjustment applied */
  adjustment: number;
  /** Individual adjustments */
  breakdown: {
    accuracy: number;
    recency: number;
    fsrs: number;
    consistency: number;
    overdue: number;
  };
  /** Confidence tier */
  tier: 'Mastered' | 'Strong' | 'Good' | 'Learning' | 'Weak' | 'New';
}

/**
 * Calculate true mastery using simple adjustment formula.
 * 
 * @param input - Vocabulary record and optional statistical data
 * @returns True mastery 0-10 with breakdown
 */
export function calculateTrueMastery(input: TrueMasteryInput): TrueMasteryResult {
  const baseMastery = input.record.mastery ?? 0;
  
  // Resolve config with defaults
  const w = { ...DEFAULT_TRUE_MASTERY_CONFIG, ...input.config };
  
  // Special cases
  if (input.reviewStatus === 'mastered' || baseMastery >= 10) {
    return createResult(10, 0, { accuracy: 0, recency: 0, fsrs: 0, consistency: 0, overdue: 0 }, 'Mastered');
  }
  if (input.reviewStatus === 'invalid' || (baseMastery === 0 && input.record.mastery === null)) {
    return createResult(0, 0, { accuracy: 0, recency: 0, fsrs: 0, consistency: 0, overdue: 0 }, 'New');
  }
  
  // Calculate individual adjustments
  const accuracyAdj = calculateAccuracyAdjustment(input.history, w.accuracyWeight ?? DEFAULT_TRUE_MASTERY_CONFIG.accuracyWeight);
  const recencyAdj = calculateRecencyAdjustment(input.history, input.record, w.recencyWeight ?? DEFAULT_TRUE_MASTERY_CONFIG.recencyWeight, input.today);
  const fsrsAdj = calculateFsrsAdjustment(input.fsrs, w.fsrsWeight ?? DEFAULT_TRUE_MASTERY_CONFIG.fsrsWeight);
  const consistencyAdj = calculateConsistencyAdjustment(input.modeMastery, w.consistencyWeight ?? DEFAULT_TRUE_MASTERY_CONFIG.consistencyWeight);
  const overdueAdj = calculateOverdueAdjustment(input.record, input.today, w);
  
  // Sum adjustments and clamp
  const totalAdjustment = clamp(
    accuracyAdj + recencyAdj + fsrsAdj + consistencyAdj + overdueAdj,
    -w.maxAdjustment!,
    w.maxAdjustment!
  );
  
  const finalMastery = clamp(baseMastery + totalAdjustment, 0, 10);
  
  return createResult(
    finalMastery,
    totalAdjustment,
    { accuracy: accuracyAdj, recency: recencyAdj, fsrs: fsrsAdj, consistency: consistencyAdj, overdue: overdueAdj },
    getTier(finalMastery)
  );
}

/** Create result object */
function createResult(
  mastery: number,
  adjustment: number,
  breakdown: TrueMasteryResult['breakdown'],
  tier: TrueMasteryResult['tier']
): TrueMasteryResult {
  return { mastery: Number(mastery.toFixed(1)), baseMastery: 0, adjustment: Number(adjustment.toFixed(2)), breakdown, tier };
}

/** Accuracy adjustment: ±weight based on review accuracy */
function calculateAccuracyAdjustment(history: CardHistory | null | undefined, weight: number): number {
  if (!history || history.reviews < 3) return 0;
  
  const accuracy = 1 - history.failures / history.reviews;
  // 0.5 accuracy = neutral (0), 1.0 = +weight, 0.0 = -weight
  return (accuracy - 0.5) * 2 * weight;
}

/** Recency bonus: recent activity gets small bonus */
function calculateRecencyAdjustment(
  history: CardHistory | null | undefined,
  _record: { nextReview: string | null },
  weight: number,
  today: string
): number {
  if (!history || !history.lastReviewedOn) return 0;
  
  const daysSinceReview = daysBetween(history.lastReviewedOn, today);
  if (daysSinceReview < 0) return 0; // Future date? treat as neutral
  
  // Bonus for recent reviews (within 7 days), decays to 0 at 30 days
  if (daysSinceReview <= 7) return weight;
  if (daysSinceReview <= 30) return weight * (1 - (daysSinceReview - 7) / 23);
  return 0;
}

/** FSRS retrievability adjustment: ±weight based on current retrievability */
function calculateFsrsAdjustment(fsrs: FsrsState | null | undefined, weight: number): number {
  if (!fsrs) return 0;
  
  const retrievability = calculateRetrievability(fsrs);
  // 0.5 retrievability = neutral, 1.0 = +weight, 0.0 = -weight
  return (retrievability - 0.5) * 2 * weight;
}

/** Calculate current retrievability from FSRS state */
function calculateRetrievability(fsrs: FsrsState): number {
  const now = Date.now();
  const due = new Date(fsrs.due).getTime();
  const elapsedDays = (now - due) / (1000 * 60 * 60 * 24);
  
  if (elapsedDays <= 0) return 1; // Not yet due
  
  // FSRS retrievability: R = exp(-t / S)
  const stabilityDays = fsrs.stability;
  return Math.exp(-elapsedDays / stabilityDays);
}

/** Consistency across practice modes: bonus if all modes are similar */
function calculateConsistencyAdjustment(modeMastery: Record<string, number> | undefined, weight: number): number {
  if (!modeMastery || Object.keys(modeMastery).length < 2) return 0;
  
  const modes = ['recognition', 'recall', 'typing', 'cloze', 'listening'];
  const values = modes.map(m => modeMastery[m] ?? 0).filter(v => v > 0);
  if (values.length < 2) return 0;
  
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  
  // Low stdDev = consistent = bonus. Max stdDev for 0-10 scale is ~5.
  // 0 stdDev = +weight, 5 stdDev = -weight
  const normalizedStdDev = Math.min(1, stdDev / 5);
  return (1 - normalizedStdDev * 2) * weight; // 0 variance = +weight, max variance = -weight
}

/** Overdue penalty: -0.5 per day overdue, max -3.0 */
function calculateOverdueAdjustment(record: { nextReview: string | null }, today: string, config: TrueMasteryConfig): number {
  if (!record.nextReview) return 0;
  
  const todayDate = new Date(today);
  const dueDate = new Date(record.nextReview);
  const daysOverdue = Math.floor((todayDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
  
  if (daysOverdue <= 0) return 0;
  
  const penalty = daysOverdue * (config.overduePenaltyPerDay ?? 0.5);
  return -Math.min(penalty, config.maxOverduePenalty ?? 3.0);
}

/** Clamp value between min and max */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Days between two ISO dates */
function daysBetween(from: string, to: string): number {
  const toUtc = (value: string) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** Get mastery tier label */
function getTier(score: number): 'Mastered' | 'Strong' | 'Good' | 'Learning' | 'Weak' | 'New' {
  if (score >= 9) return 'Mastered';
  if (score >= 7.5) return 'Strong';
  if (score >= 6) return 'Good';
  if (score >= 4) return 'Learning';
  if (score >= 2) return 'Weak';
  return 'New';
}

/**
 * Convenience function for simple usage
 */
export function getTrueMastery(
  record: VocabularyRecord,
  options: {
    modeMastery?: Record<string, number>;
    history?: CardHistory | null;
    fsrs?: FsrsState | null;
    recentConfidence?: Confidence[];
    today: string;
    reviewStatus?: 'mastered' | 'overdue' | 'due_today' | 'unscheduled' | 'upcoming' | 'invalid';
    config?: Partial<TrueMasteryConfig>;
  }
): TrueMasteryResult {
  return calculateTrueMastery({
    record,
    modeMastery: options.modeMastery,
    history: options.history,
    fsrs: options.fsrs,
    recentConfidence: options.recentConfidence,
    today: options.today,
    reviewStatus: options.reviewStatus,
    config: options.config,
  });
}

/**
 * Compare two words by true mastery (for sorting)
 */
export function compareTrueMastery(a: TrueMasteryResult, b: TrueMasteryResult): number {
  return b.mastery - a.mastery; // Descending: higher mastery first
}

/**
 * Get mastery tier label
 */
export function getTrueMasteryTier(score: number): 'Mastered' | 'Strong' | 'Good' | 'Learning' | 'Weak' | 'New' {
  if (score >= 9) return 'Mastered';
  if (score >= 7.5) return 'Strong';
  if (score >= 6) return 'Good';
  if (score >= 4) return 'Learning';
  if (score >= 2) return 'Weak';
  return 'New';
}
