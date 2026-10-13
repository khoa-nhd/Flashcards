import { describe, it, expect } from 'vitest';
import { calculateTrueMastery, getTrueMasteryTier, compareTrueMastery } from '../../shared/true-mastery-simple.js';

const today = '2026-10-12';

describe('True Mastery Simple', () => {
  it('returns base mastery when no adjustments', () => {
    const result = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: today, fsrs: null }, today });
    expect(result.mastery).toBe(5);
    expect(result.adjustment).toBe(0);
  });

  it('gives full 10 for mastered words', () => {
    const result = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 10, nextReview: null, fsrs: null }, today });
    expect(result.mastery).toBe(10);
    expect(result.tier).toBe('Mastered');
  });

  it('returns 0 for invalid words', () => {
    const result = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: null, nextReview: null, fsrs: null }, today, reviewStatus: 'invalid' });
    expect(result.mastery).toBe(0);
    expect(result.tier).toBe('New');
  });

  it('boosts for high accuracy', () => {
    const perfect = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: today, fsrs: null }, history: { reviews: 20, failures: 0, recentReviews: 10, recentFailures: 0, failedDays: 0, lastReviewedOn: today, lastFailedOn: null, lastAction: 'remember' }, today });
    const poor = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: today, fsrs: null }, history: { reviews: 20, failures: 15, recentReviews: 10, recentFailures: 10, failedDays: 5, lastReviewedOn: today, lastFailedOn: today, lastAction: 'not_remember' }, today });
    
    expect(perfect.mastery).toBeGreaterThan(poor.mastery);
    expect(perfect.breakdown.accuracy).toBeGreaterThan(poor.breakdown.accuracy);
  });

  it('gives recency bonus for recent reviews', () => {
    const recent = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: today, fsrs: null }, history: { reviews: 10, failures: 2, recentReviews: 5, recentFailures: 1, failedDays: 1, lastReviewedOn: today, lastFailedOn: null, lastAction: 'remember' }, today });
    const old = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: today, fsrs: null }, history: { reviews: 10, failures: 2, recentReviews: 5, recentFailures: 1, failedDays: 1, lastReviewedOn: '2026-09-01', lastFailedOn: null, lastAction: 'remember' }, today });
    
    expect(recent.breakdown.recency).toBeGreaterThan(old.breakdown.recency);
  });

  it('adjusts for FSRS retrievability', () => {
    const highRet = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: today, fsrs: null }, fsrs: { due: new Date(Date.now() + 86400000).toISOString(), stability: 50, difficulty: 2, scheduledDays: 15, learningSteps: 0, reps: 10, lapses: 0, state: 2, lastReview: today }, today });
    const lowRet = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: today, fsrs: null }, fsrs: { due: new Date(Date.now() - 86400000 * 10).toISOString(), stability: 10, difficulty: 8, scheduledDays: 2, learningSteps: 0, reps: 2, lapses: 3, state: 1, lastReview: '2026-09-01' }, today });
    
    expect(highRet.breakdown.fsrs).toBeGreaterThan(lowRet.breakdown.fsrs);
  });

  it('rewards mode consistency', () => {
    const consistent = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: today, fsrs: null }, modeMastery: { recognition: 7, recall: 7, typing: 7, cloze: 7, listening: 7 }, today });
    const inconsistent = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: today, fsrs: null }, modeMastery: { recognition: 10, recall: 2, typing: 8, cloze: 1, listening: 5 }, today });
    
    expect(consistent.breakdown.consistency).toBeGreaterThan(inconsistent.breakdown.consistency);
  });

  it('penalizes overdue words', () => {
    const onTime = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: today, fsrs: null }, today });
    const overdue = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 5, nextReview: '2026-10-05' }, today });
    
    expect(overdue.breakdown.overdue).toBeLessThan(onTime.breakdown.overdue);
    expect(overdue.mastery).toBeLessThan(onTime.mastery);
  });

  it('clamps total adjustment to max', () => {
    const extreme = calculateTrueMastery({
      record: { id: '1', word: 'a', fields: {}, mastery: 5, nextReview: '2026-09-01', fsrs: null },
      history: { reviews: 100, failures: 0, recentReviews: 20, recentFailures: 0, failedDays: 0, lastReviewedOn: today, lastFailedOn: null, lastAction: 'remember' },
      fsrs: { due: new Date(Date.now() + 86400000).toISOString(), stability: 100, difficulty: 1, scheduledDays: 30, learningSteps: 0, reps: 50, lapses: 0, state: 2, lastReview: today },
      modeMastery: { recognition: 10, recall: 10, typing: 10, cloze: 10, listening: 10 },
      today,
    });
    
    // Max adjustment is 3.0, so max mastery = 5 + 3 = 8
    expect(extreme.mastery).toBeLessThanOrEqual(8);
    expect(extreme.adjustment).toBeLessThanOrEqual(3);
  });

  it('returns 0 for invalid words', () => {
    const result = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: null, nextReview: null, fsrs: null }, today, reviewStatus: 'invalid' });
    expect(result.mastery).toBe(0);
    expect(result.tier).toBe('New');
  });

  it('returns 10 for mastered words', () => {
    const result = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 10, nextReview: null, fsrs: null }, today });
    expect(result.mastery).toBe(10);
    expect(result.tier).toBe('Mastered');
  });

  it('tier labels are correct', () => {
    expect(getTrueMasteryTier(9.5)).toBe('Mastered');
    expect(getTrueMasteryTier(8)).toBe('Strong');
    expect(getTrueMasteryTier(7)).toBe('Good');
    expect(getTrueMasteryTier(5)).toBe('Learning');
    expect(getTrueMasteryTier(3)).toBe('Weak');
    expect(getTrueMasteryTier(1)).toBe('New');
  });

  it('compares correctly for sorting', () => {
    const a = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 3, nextReview: today, fsrs: null }, today });
    const b = calculateTrueMastery({ record: { id: '2', word: 'b', fields: {}, mastery: 7, nextReview: today, fsrs: null }, today });
    
    expect(compareTrueMastery(a, b)).toBeGreaterThan(0); // b > a
    expect(compareTrueMastery(b, a)).toBeLessThan(0);
  });

  it('clamps final mastery to 0-10', () => {
    const veryLow = calculateTrueMastery({ record: { id: '1', word: 'a', fields: {}, mastery: 1, nextReview: '2026-09-01', fsrs: null }, history: { reviews: 20, failures: 18, recentReviews: 10, recentFailures: 9, failedDays: 10, lastReviewedOn: today, lastFailedOn: today, lastAction: 'not_remember' }, fsrs: { due: new Date(Date.now() - 86400000 * 30).toISOString(), stability: 5, difficulty: 9, scheduledDays: 1, learningSteps: 0, reps: 1, lapses: 10, state: 1, lastReview: '2026-09-01' }, modeMastery: { recognition: 1, recall: 1, typing: 1, cloze: 1, listening: 1 }, today });
    
    expect(veryLow.mastery).toBeGreaterThanOrEqual(0);
    expect(veryLow.mastery).toBeLessThanOrEqual(10);
  });

});
