/**
 * True Mastery Metric
 * 
 * A comprehensive metric that combines all available statistics into a single
 * "true mastery" score (0-100). This goes beyond the simple 0-10 mastery level
 * to provide a holistic view of how well a word is actually known.
 * 
 * Components (weighted):
 * 1. Base Mastery (25%) - The core 0-10 mastery level
 * 2. Per-Mode Mastery (20%) - Average of practice mode scores
 * 3. Review History Quality (20%) - Accuracy, consistency, recency
 * 4. FSRS Stability/Retrievability (15%) - If FSRS data available
 * 5. Confidence Calibration (10%) - How well confidence matches actual performance
 * 6. Scheduling Health (10%) - Overdue status, scheduling consistency
 * 
 * Returns a score from 0-100, with helper to convert to 0-10 scale.
 */

import type { VocabularyRecord, ReviewStatus } from './vocabulary.js';
import type { CardHistory } from './weak-words.js';
import type { FsrsState } from './scheduler/fsrs.js';
import type { Confidence } from './api.js';

export const TRUE_MASTERY_WEIGHTS = {
  baseMastery: 0.25,
  perModeMastery: 0.20,
  reviewHistory: 0.20,
  fsrsMetrics: 0.15,
  confidenceCalibration: 0.10,
  schedulingHealth: 0.10,
} as const;

/** Configuration for the true mastery calculation */
export interface TrueMasteryConfig {
  /** Weights for each component (must sum to 1.0) */
  weights?: Record<keyof typeof TRUE_MASTERY_WEIGHTS, number>;
  /** FSRS target retention for retrievability calculation */
  fsrsRetention?: number;
  /** Days to consider "recent" for review history */
  recentWindowDays?: number;
  /** Minimum reviews needed for full review history score */
  minReviewsForFullHistory?: number;
  /** Maximum FSRS difficulty for full score */
  maxFsrsDifficultyForFullScore?: number;
  /** Minimum FSRS stability for full score (days) */
  minFsrsStabilityForFullScore?: number;
}

export const DEFAULT_TRUE_MASTERY_CONFIG: TrueMasteryConfig = {
  weights: TRUE_MASTERY_WEIGHTS,
  fsrsRetention: 0.9,
  recentWindowDays: 30,
  minReviewsForFullHistory: 10,
  maxFsrsDifficultyForFullScore: 5,
  minFsrsStabilityForFullScore: 30,
};

/** Input data for true mastery calculation */
export interface TrueMasteryInput {
  /** The vocabulary record */
  record: VocabularyRecord;
  /** Per-mode mastery scores (0-10 each) */
  modeMastery?: Record<string, number>;
  /** Review history from saved answers */
  history?: CardHistory | null;
  /** FSRS state if available */
  fsrs?: FsrsState | null;
  /** Confidence ratings from recent reviews (1-3) */
  recentConfidence?: Confidence[];
  /** Today's date for scheduling calculations */
  today: string;
  /** Review status */
  reviewStatus?: ReviewStatus;
  /** Configuration overrides */
  config?: TrueMasteryConfig;
}

/** Detailed breakdown of the true mastery score */
export interface TrueMasteryBreakdown {
  baseMastery: number;           // 0-100
  perModeMastery: number;        // 0-100
  reviewHistory: number;         // 0-100
  fsrsMetrics: number;           // 0-100
  confidenceCalibration: number; // 0-100
  schedulingHealth: number;      // 0-100
  /** Weighted total 0-100 */
  total: number;
  /** Total converted to 0-10 scale */
  total10: number;
  /** Individual component scores before weighting */
  rawComponents: {
    baseMastery: number;
    perModeMastery: number;
    reviewHistory: number;
    fsrsMetrics: number;
    confidenceCalibration: number;
    schedulingHealth: number;
  };
}

/**
 * Calculates the true mastery score for a word.
 * 
 * @param input - All available data for the word
 * @returns Detailed breakdown and total score
 */
export function calculateTrueMastery(input: TrueMasteryInput): TrueMasteryBreakdown {
  const config = { ...DEFAULT_TRUE_MASTERY_CONFIG, ...input.config };
  const weights = { ...TRUE_MASTERY_WEIGHTS, ...config.weights };
  
  // Special cases
  const mastery = input.record.mastery ?? 0;
  if (input.reviewStatus === 'mastered' || mastery >= 10) {
    return {
      baseMastery: 100,
      perModeMastery: 100,
      reviewHistory: 100,
      fsrsMetrics: 100,
      confidenceCalibration: 100,
      schedulingHealth: 100,
      total: 100,
      total10: 10,
      rawComponents: {
        baseMastery: 100,
        perModeMastery: 100,
        reviewHistory: 100,
        fsrsMetrics: 100,
        confidenceCalibration: 100,
        schedulingHealth: 100,
      },
    };
  }
  
  if (input.reviewStatus === 'invalid' || (mastery === 0 && input.record.mastery === null)) {
    return {
      baseMastery: 0,
      perModeMastery: 0,
      reviewHistory: 0,
      fsrsMetrics: 0,
      confidenceCalibration: 50, // Neutral
      schedulingHealth: 0,
      total: 0,
      total10: 0,
      rawComponents: {
        baseMastery: 0,
        perModeMastery: 0,
        reviewHistory: 0,
        fsrsMetrics: 0,
        confidenceCalibration: 50,
        schedulingHealth: 0,
      },
    };
  }
  
  // 1. Base Mastery (0-10) -> 0-100
  const baseMasteryScore = Math.min(100, mastery * 10);
  
  // 2. Per-Mode Mastery (average of modes, 0-10) -> 0-100
  const modeMasteryScore = calculatePerModeMastery(input.modeMastery);
  
  // 3. Review History Quality (0-100)
  const reviewHistoryScore = calculateReviewHistoryScore(input.history, config);
  
  // 4. FSRS Metrics (0-100)
  const fsrsScore = calculateFsrsScore(input.fsrs, config);
  
  // 5. Confidence Calibration (0-100)
  const confidenceScore = calculateConfidenceCalibration(input.recentConfidence);
  
  // 6. Scheduling Health (0-100)
  const schedulingScore = calculateSchedulingHealth(input.record, input.reviewStatus, input.today);
  
  // Apply weights
  const weightedTotal = 
    baseMasteryScore * weights.baseMastery +
    modeMasteryScore * weights.perModeMastery +
    reviewHistoryScore * weights.reviewHistory +
    fsrsScore * weights.fsrsMetrics +
    confidenceScore * weights.confidenceCalibration +
    schedulingScore * weights.schedulingHealth;
  
  return {
    baseMastery: Math.round(baseMasteryScore),
    perModeMastery: Math.round(modeMasteryScore),
    reviewHistory: Math.round(reviewHistoryScore),
    fsrsMetrics: Math.round(fsrsScore),
    confidenceCalibration: Math.round(confidenceScore),
    schedulingHealth: Math.round(schedulingScore),
    total: Math.round(weightedTotal),
    total10: Math.round(weightedTotal / 10),
    rawComponents: {
      baseMastery: baseMasteryScore,
      perModeMastery: modeMasteryScore,
      reviewHistory: reviewHistoryScore,
      fsrsMetrics: fsrsScore,
      confidenceCalibration: confidenceScore,
      schedulingHealth: schedulingScore,
    },
  };
}

/** Per-mode mastery average (0-100) */
function calculatePerModeMastery(modeMastery?: Record<string, number>): number {
  if (!modeMastery || Object.keys(modeMastery).length === 0) return 0;
  
  const modes = ['recognition', 'recall', 'typing', 'cloze', 'listening'];
  const values = modes.map(m => modeMastery[m] ?? 0);
  const avg = values.reduce((a, b) => a + b, 0) / modes.length;
  return Math.min(100, avg * 10);
}

/** Review history quality (0-100) */
function calculateReviewHistoryScore(
  history: CardHistory | null | undefined,
  config: TrueMasteryConfig
): number {
  if (!history || history.reviews === 0) return 0;
  
  // Base score from review count (capped at minReviewsForFullHistory)
  const reviewCountScore = Math.min(1, history.reviews / (config.minReviewsForFullHistory ?? 10)) * 40;
  
  // Accuracy score (0-40)
  const accuracy = history.reviews > 0 ? 1 - history.failures / history.reviews : 0;
  const accuracyScore = accuracy * 40;
  
  // Recency score (0-20) - bonus for recent activity
  let recencyScore = 0;
  if (history.lastReviewedOn) {
    // Could add recency logic here if needed
    recencyScore = 20;
  }
  
  // Failed days penalty (reduce score for multiple failed days)
  const failedDaysPenalty = Math.min(20, (history.failedDays ?? 0) * 5);
  
  return Math.max(0, Math.min(100, reviewCountScore + accuracyScore + recencyScore - failedDaysPenalty));
}

/** FSRS metrics score (0-100) */
function calculateFsrsScore(
  fsrs: FsrsState | null | undefined,
  config: TrueMasteryConfig
): number {
  if (!fsrs) return 0;
  
  // Retrievability score (0-50) - based on current retrievability
  const retrievability = calculateRetrievability(fsrs);
  const retrievabilityScore = retrievability * 50;
  
  // Stability score (0-30) - higher stability = better retention
  const stabilityScore = Math.min(30, (fsrs.stability / (config.minFsrsStabilityForFullScore ?? 30)) * 30);
  
  // Difficulty penalty (0-20) - lower difficulty = better
  const maxDifficulty = config.maxFsrsDifficultyForFullScore ?? 5;
  const difficultyScore = Math.max(0, 20 * (1 - (fsrs.difficulty - 1) / (maxDifficulty - 1)));
  
  // Reps bonus (0-10) - more reps = more established memory
  const repsBonus = Math.min(10, (fsrs.reps ?? 0) * 2);
  
  // Lapses penalty
  const lapsesPenalty = Math.min(20, (fsrs.lapses ?? 0) * 5);
  
  return Math.max(0, Math.min(100, retrievabilityScore + stabilityScore + difficultyScore + repsBonus - lapsesPenalty));
}

/** Calculate current retrievability from FSRS state */
function calculateRetrievability(fsrs: FsrsState): number {
  const now = Date.now();
  const due = new Date(fsrs.due).getTime();
  const elapsedDays = (now - due) / (1000 * 60 * 60 * 24);
  
  // FSRS retrievability formula: R = exp(-t / S) where t is days since review, S is stability
  // But we use the due date which already encodes the target retention
  if (elapsedDays <= 0) return 1; // Not yet due
  
  // Approximate retrievability decay
  const stabilityDays = fsrs.stability;
  return Math.exp(-elapsedDays / stabilityDays);
}

/** Confidence calibration (0-100) - how well confidence predicts actual performance */
function calculateConfidenceCalibration(
  recentConfidence: Confidence[] | undefined
): number {
  if (!recentConfidence || recentConfidence.length === 0) return 50; // Neutral if no data
  
  // Convert confidence 1-3 to 0-100 scale
  const avgConfidence = recentConfidence.reduce((sum, c) => sum + c, 0) / recentConfidence.length;
  const confidenceScore = ((avgConfidence - 1) / 2) * 100; // 1->0, 2->50, 3->100
  
  // TODO: Could add calibration logic comparing confidence to actual outcomes
  // For now, return the raw confidence score
  return confidenceScore;
}

/** Scheduling health (0-100) */
function calculateSchedulingHealth(
  record: VocabularyRecord,
  reviewStatus: ReviewStatus | undefined,
  today: string
): number {
  let score = 100;
  
  // Overdue penalty
  if (record.nextReview) {
    const todayDate = new Date(today);
    const dueDate = new Date(record.nextReview);
    const daysOverdue = Math.floor((todayDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysOverdue > 0) {
      // Penalty increases with overdue days, max 50 points
      score -= Math.min(50, daysOverdue * 5);
    }
  } else if (record.nextReview === null && record.mastery !== null && record.mastery < 10) {
    // No review date but not mastered - scheduling gap
    score -= 20;
  }
  
  // Mastered words get full score
  if (record.mastery !== null && record.mastery >= 10) {
    score = 100;
  }
  
  // Review status modifiers
  if (reviewStatus === 'overdue') score = Math.min(score, 60);
  if (reviewStatus === 'due_today') score = Math.min(score, 80);
  if (reviewStatus === 'mastered') score = 100;
  if (reviewStatus === 'invalid') score = 0;
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Convenience function to get true mastery from a record with all optional data
 */
export function getTrueMastery(
  record: VocabularyRecord,
  options: {
    modeMastery?: Record<string, number>;
    history?: CardHistory | null;
    fsrs?: FsrsState | null;
    recentConfidence?: Confidence[];
    today: string;
    reviewStatus?: ReviewStatus;
    config?: TrueMasteryConfig;
  }
): TrueMasteryBreakdown {
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
 * Compare two words by true mastery
 */
export function compareTrueMastery(a: TrueMasteryBreakdown, b: TrueMasteryBreakdown): number {
  return b.total - a.total; // Descending: higher mastery first
}

/**
 * Get mastery tier label
 */
export function getTrueMasteryTier(score: number): string {
  if (score >= 90) return 'Mastered';
  if (score >= 75) return 'Strong';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Learning';
  if (score >= 20) return 'Weak';
  return 'New';
}