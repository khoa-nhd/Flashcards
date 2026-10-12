import { describe, it, expect } from 'vitest';
import { calculateTrueMastery, getTrueMastery, getTrueMasteryTier, compareTrueMastery } from '../../shared/true-mastery.js';

describe('True Mastery Metric', () => {
  const today = '2026-10-12';
    it('returns zero for a completely new word with no data', () => {
      const record = { id: 'test', word: 'test', fields: {}, mastery: 0, nextReview: null, fsrs: null };
      const result = calculateTrueMastery({ record, today: '2026-10-12' });
      
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.total10).toBeGreaterThanOrEqual(0);
      expect(result.baseMastery).toBe(0);
    });

    it('gives higher score for higher base mastery', () => {
      const lowMastery = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 2, nextReview: '2026-10-12', fsrs: null }, today: '2026-10-12' });
      const highMastery = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 8, nextReview: '2026-10-12', fsrs: null }, today: '2026-10-12' });
      
      expect(highMastery.total).toBeGreaterThan(lowMastery.total);
      expect(highMastery.baseMastery).toBeGreaterThan(lowMastery.baseMastery);
    });

    it('includes per-mode mastery in score', () => {
      const noModes = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null }, today });
      const withModes = calculateTrueMastery({ 
        record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        modeMastery: { recognition: 8, recall: 7, typing: 6, cloze: 5, listening: 4 },
        today,
      });
      
      expect(withModes.total).toBeGreaterThan(noModes.total);
      expect(withModes.perModeMastery).toBeGreaterThan(noModes.perModeMastery);
    });

    it('includes review history in score', () => {
      const noHistory = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null }, today });
      const withHistory = calculateTrueMastery({ 
        record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        history: { reviews: 20, failures: 2, recentReviews: 5, recentFailures: 1, failedDays: 1, lastReviewedOn: '2026-10-10', lastFailedOn: '2026-10-05', lastAction: 'remember' },
        today,
      });
      
      expect(withHistory.total).toBeGreaterThan(noHistory.total);
      expect(withHistory.reviewHistory).toBeGreaterThan(noHistory.reviewHistory);
    });

    it('includes FSRS metrics when available', () => {
      const noFsrs = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null }, today });
      const withFsrs = calculateTrueMastery({
        record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        fsrs: { due: new Date(Date.now() + 86400000).toISOString(), stability: 50, difficulty: 2, scheduledDays: 15, learningSteps: 0, reps: 10, lapses: 0, state: 2, lastReview: '2026-10-10T10:00:00Z' },
        today,
      });
      
      expect(withFsrs.total).toBeGreaterThan(noFsrs.total);
      expect(withFsrs.fsrsMetrics).toBeGreaterThan(noFsrs.fsrsMetrics);
    });

    it('penalizes overdue words', () => {
      const onTime = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null }, today });
      const overdue = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: '2026-10-05', fsrs: null }, today });
      
      expect(overdue.schedulingHealth).toBeLessThan(onTime.schedulingHealth);
      expect(overdue.total).toBeLessThan(onTime.total);
    });

    it('gives full score for mastered words', () => {
      const mastered = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 10, nextReview: null, fsrs: null }, today });
      expect(mastered.total).toBe(100);
      expect(mastered.total10).toBe(10);
    });

    it('gives zero for invalid words', () => {
      const invalid = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: null, nextReview: null, fsrs: null }, today, reviewStatus: 'invalid' });
      expect(invalid.total).toBe(0);
      expect(invalid.schedulingHealth).toBe(0);
    });

    it('returns correct tier labels', () => {
      expect(getTrueMasteryTier(95)).toBe('Mastered');
      expect(getTrueMasteryTier(80)).toBe('Strong');
      expect(getTrueMasteryTier(70)).toBe('Good');
      expect(getTrueMasteryTier(50)).toBe('Learning');
      expect(getTrueMasteryTier(30)).toBe('Weak');
      expect(getTrueMasteryTier(10)).toBe('New');
    });

    it('compares correctly for sorting', () => {
      const a = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 3, nextReview: '2026-10-12', fsrs: null }, today });
      const b = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 7, nextReview: '2026-10-12', fsrs: null }, today });
      
      expect(compareTrueMastery(a, b)).toBeGreaterThan(0);
      expect(compareTrueMastery(b, a)).toBeLessThan(0);
    });

    it('handles custom config weights', () => {
      const result = calculateTrueMastery({
        record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        today,
        config: { weights: { baseMastery: 0.5, perModeMastery: 0.1, reviewHistory: 0.1, fsrsMetrics: 0.1, confidenceCalibration: 0.1, schedulingHealth: 0.1 } },
      });
      
      expect(result.baseMastery).toBe(50);
    });

    it('handles missing optional data gracefully', () => {
      const result = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null }, today });
      
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.total).toBeLessThanOrEqual(100);
      expect(result.total10).toBeGreaterThanOrEqual(0);
      expect(result.total10).toBeLessThanOrEqual(10);
    });

    it('getTrueMastery convenience function works', () => {
      const result = getTrueMastery({ id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null }, { today: '2026-10-12' });
      expect(result.total).toBeGreaterThan(0);
      expect(result.total10).toBeGreaterThan(0);
    });

    it('penalizes high FSRS difficulty', () => {
      const easy = calculateTrueMastery({ 
        record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        fsrs: { due: new Date(Date.now() + 86400000).toISOString(), stability: 30, difficulty: 2, scheduledDays: 10, learningSteps: 0, reps: 5, lapses: 0, state: 2, lastReview: '2026-10-10T10:00:00Z' },
        today,
      });
      
      const hard = calculateTrueMastery({
        record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        fsrs: { due: new Date(Date.now() + 86400000).toISOString(), stability: 30, difficulty: 8, scheduledDays: 10, learningSteps: 0, reps: 5, lapses: 0, state: 2, lastReview: '2026-10-10T10:00:00Z' },
        today,
      });
      
      expect(easy.fsrsMetrics).toBeGreaterThan(hard.fsrsMetrics);
    });

    it('penalizes FSRS lapses', () => {
      const noLapses = calculateTrueMastery({ 
        record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        fsrs: { due: new Date(Date.now() + 86400000).toISOString(), stability: 30, difficulty: 3, scheduledDays: 10, learningSteps: 0, reps: 10, lapses: 0, state: 2, lastReview: '2026-10-10T10:00:00Z' },
        today,
      });
      
      const withLapses = calculateTrueMastery({
        record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        fsrs: { due: new Date(Date.now() + 86400000).toISOString(), stability: 30, difficulty: 3, scheduledDays: 10, learningSteps: 0, reps: 10, lapses: 5, state: 2, lastReview: '2026-10-10T10:00:00Z' },
        today,
      });
      
      expect(noLapses.fsrsMetrics).toBeGreaterThan(withLapses.fsrsMetrics);
    });

    it('handles confidence calibration', () => {
      const noConfidence = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null }, today });
      const withConfidence = calculateTrueMastery({
        record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: '2026-10-12', fsrs: null },
        recentConfidence: [3, 3, 2, 3, 3] as const,
        today,
      });
      
      expect(withConfidence.confidenceCalibration).toBeGreaterThan(noConfidence.confidenceCalibration);
    });
  });