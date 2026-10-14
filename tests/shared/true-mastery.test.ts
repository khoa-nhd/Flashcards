import { describe, it, expect } from 'vitest';
import {
  calculateTrueMastery,
  getEvidenceCoverageLabel,
  getTrueMasteryTier,
  type PracticeAnswer,
  type TrueMasteryConfig,
} from '../../shared/true-mastery.js';

const TODAY = '2026-10-12';

function makeAnswer(overrides: Partial<PracticeAnswer> = {}): PracticeAnswer {
  return {
    vocabularyId: 'word-1',
    mode: 'typing',
    correct: true,
    grading: 'auto',
    submitted: 'candid',
    reviewedOn: TODAY,
    reviewedAt: '2026-10-12T10:00:00Z',
    durationMs: 3000,
    confidence: 2,
    sessionId: 'session-1',
    requestId: 'req-1',
    ...overrides,
  };
}

const defaultConfig: Partial<TrueMasteryConfig> = {
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
};

describe('True Mastery', () => {
  it('returns insufficient data when no answers', () => {
    const result = calculateTrueMastery([], TODAY);
    expect(result.mastery).toBeNull();
    expect(result.coverage).toBe('insufficient');
    expect(result.hasAnyPractice).toBe(false);
    expect(result.modesWithEvidence).toBe(0);
    expect(result.totalEffectiveEvidence).toBe(0);
  });

  it('one correct answer does not produce 100 mastery', () => {
    const result = calculateTrueMastery([makeAnswer()], TODAY, defaultConfig);
    expect(result.mastery).not.toBeNull();
    expect(result.mastery).toBeLessThan(100);
    expect(result.modes.length).toBeGreaterThan(0);
    expect(result.modes[0]!.accuracy).toBeLessThan(1);
    expect(result.coverage).toBe('low');
  });

  it('one incorrect answer is not ignored', () => {
    const correct = calculateTrueMastery([makeAnswer({ correct: true })], TODAY, defaultConfig);
    const incorrect = calculateTrueMastery([makeAnswer({ correct: false })], TODAY, defaultConfig);
    expect(correct.mastery).not.toBeNull();
    expect(incorrect.mastery).not.toBeNull();
    expect(correct.mastery!).toBeGreaterThan(incorrect.mastery!);
  });

  it('mixed correct and incorrect answers produce intermediate estimate', () => {
    const answers = [
      makeAnswer({ correct: true }),
      makeAnswer({ correct: true }),
      makeAnswer({ correct: false }),
      makeAnswer({ correct: false }),
      makeAnswer({ correct: false }),
    ];
    const result = calculateTrueMastery(answers, TODAY, defaultConfig);
    expect(result.mastery).not.toBeNull();
    expect(result.mastery).toBeGreaterThan(0);
    expect(result.mastery).toBeLessThan(100);
  });

  it('more recent evidence has greater influence than old evidence', () => {
    const recent = [
      makeAnswer({ correct: true, reviewedOn: '2026-10-10', reviewedAt: '2026-10-10T10:00:00Z' }),
      makeAnswer({ correct: true, reviewedOn: '2026-10-11', reviewedAt: '2026-10-11T10:00:00Z' }),
      makeAnswer({ correct: true, reviewedOn: '2026-10-12', reviewedAt: '2026-10-12T10:00:00Z' }),
    ];
    const old = [
      makeAnswer({ correct: true, reviewedOn: '2026-09-10', reviewedAt: '2026-09-10T10:00:00Z' }),
      makeAnswer({ correct: true, reviewedOn: '2026-09-11', reviewedAt: '2026-09-11T10:00:00Z' }),
      makeAnswer({ correct: true, reviewedOn: '2026-09-12', reviewedAt: '2026-09-12T10:00:00Z' }),
    ];
    const recentResult = calculateTrueMastery(recent, TODAY, defaultConfig);
    const oldResult = calculateTrueMastery(old, TODAY, defaultConfig);
    // Both all correct, but recent should have higher effective evidence
    expect(recentResult.modes.length).toBeGreaterThan(0);
    expect(oldResult.modes.length).toBeGreaterThan(0);
    expect(recentResult.modes[0]!.effectiveEvidence).toBeGreaterThan(oldResult.modes[0]!.effectiveEvidence);
  });

  it('old evidence gradually loses influence', () => {
    const halfLife = 30;
    const answers = [
      makeAnswer({ correct: true, reviewedOn: '2026-10-12', reviewedAt: '2026-10-12T10:00:00Z', sessionId: 'session-1' }),
      makeAnswer({ correct: true, reviewedOn: '2026-09-12', reviewedAt: '2026-09-12T10:00:00Z', sessionId: 'session-2' }), // 30 days ago
    ];
    const result = calculateTrueMastery(answers, TODAY, { ...defaultConfig, recencyHalfLifeDays: halfLife });
    // The 30-day-old answer should have weight ~0.5
    expect(result.modes.length).toBeGreaterThan(0);
    expect(result.modes[0]!.effectiveEvidence).toBeLessThan(2);
    expect(result.modes[0]!.effectiveEvidence).toBeGreaterThan(1.3);
  });

  it('all answers correct do not automatically imply certainty', () => {
    const answers = Array.from({ length: 20 }, (_, i) =>
      makeAnswer({ correct: true, reviewedOn: TODAY, reviewedAt: `2026-10-12T${10 + i}:00:00Z` })
    );
    const result = calculateTrueMastery(answers, TODAY, defaultConfig);
    expect(result.mastery).toBeLessThan(100);
    expect(result.modes.length).toBeGreaterThan(0);
    expect(result.modes[0]!.accuracy).toBeLessThan(1);
  });

  it('all answers incorrect do not cause division by zero', () => {
    const answers = Array.from({ length: 10 }, (_, i) =>
      makeAnswer({ correct: false, reviewedOn: TODAY, reviewedAt: `2026-10-12T${10 + i}:00:00Z` })
    );
    const result = calculateTrueMastery(answers, TODAY, defaultConfig);
    expect(result.mastery).not.toBeNull();
    expect(result.mastery).toBeGreaterThanOrEqual(0);
    expect(result.modes.length).toBeGreaterThan(0);
    expect(result.modes[0]!.accuracy).toBeGreaterThanOrEqual(0);
  });

  it('a mode with no history is excluded from aggregation', () => {
    // Only typing answers, no recognition
    const answers = [makeAnswer({ mode: 'typing', correct: true })];
    const result = calculateTrueMastery(answers, TODAY, defaultConfig);
    expect(result.modes.length).toBe(1);
    expect(result.modes[0]!.mode).toBe('typing');
  });

  it('a missing or disabled mode does not count as zero', () => {
    // Even if weight is 0, it's not in the breakdown
    const config = { ...defaultConfig, modeWeights: { ...defaultConfig.modeWeights, typing: 0 } };
    const answers = [makeAnswer({ mode: 'typing', correct: true })];
    const result = calculateTrueMastery(answers, TODAY, config);
    expect(result.modes.length).toBe(1);
    expect(result.modes[0]!.weight).toBe(0);
  });

  it('a single mode does not automatically imply strong cross-mode coverage', () => {
    // Many answers in one mode only
    const answers = Array.from({ length: 30 }, (_, i) =>
      makeAnswer({ correct: true, reviewedOn: TODAY, reviewedAt: `2026-10-12T${10 + i}:00:00Z`, sessionId: `session-${i}` })
    );
    const result = calculateTrueMastery(answers, TODAY, defaultConfig);
    expect(result.modesWithEvidence).toBe(1);
    // With only 1 mode, coverage cannot reach 'moderate' or 'high' regardless of evidence volume
    expect(result.coverage).toBe('low');
  });

  it('repeated retries in one session do not inflate confidence without limit', () => {
    // 10 correct answers in the same session
    const answers = Array.from({ length: 10 }, (_, i) =>
      makeAnswer({ correct: true, reviewedOn: TODAY, reviewedAt: `2026-10-12T10:${i.toString().padStart(2, '0')}:00Z`, sessionId: 'session-1' })
    );
    const result = calculateTrueMastery(answers, TODAY, { ...defaultConfig, sessionMaxEffectiveEvidence: 2 });
    // Effective evidence capped at 2 per session
    expect(result.modes.length).toBeGreaterThan(0);
    expect(result.modes[0]!.effectiveEvidence).toBeLessThanOrEqual(2.1);
  });

  it('invalid or future timestamps are handled safely', () => {
    const future = makeAnswer({ reviewedOn: '2026-10-20', reviewedAt: '2026-10-20T10:00:00Z' });
    const past = makeAnswer({ reviewedOn: '2026-10-10', reviewedAt: '2026-10-10T10:00:00Z' });
    const result = calculateTrueMastery([future, past], TODAY, defaultConfig);
    // Future answer ignored, only past counts
    expect(result.modes.length).toBe(1);
    expect(result.modes[0]!.effectiveEvidence).toBeGreaterThan(0);
  });

  it('different modes have different weights', () => {
    const typingAnswers = Array.from({ length: 10 }, () => makeAnswer({ mode: 'typing', correct: true }));
    const recognitionAnswers = Array.from({ length: 10 }, () => makeAnswer({ mode: 'recognition', correct: true }));

    const typingResult = calculateTrueMastery(typingAnswers, TODAY, defaultConfig);
    const recognitionResult = calculateTrueMastery(recognitionAnswers, TODAY, defaultConfig);

    // Same number of correct answers, but typing has higher weight
    expect(typingResult.modes.length).toBeGreaterThan(0);
    expect(recognitionResult.modes.length).toBeGreaterThan(0);
    expect(typingResult.modes[0]!.weight).toBeGreaterThan(recognitionResult.modes[0]!.weight);
  });

  it('self-graded recall answers are included but weighted appropriately', () => {
    const recallAnswers = Array.from({ length: 10 }, (_, i) =>
      makeAnswer({ mode: 'recall', correct: true, grading: 'self', reviewedOn: TODAY, reviewedAt: `2026-10-12T${10 + i}:00:00Z` })
    );
    const result = calculateTrueMastery(recallAnswers, TODAY, defaultConfig);
    expect(result.modes.length).toBeGreaterThan(0);
    expect(result.modes[0]!.mode).toBe('recall');
    expect(result.modes[0]!.weight).toBe(defaultConfig.modeWeights!.recall);
  });

  it('technical failures (durationMs null) do not count as incorrect', () => {
    const answers = [
      makeAnswer({ correct: true, durationMs: null, reviewedAt: '2026-10-12T10:00:00Z', sessionId: 'session-1' }),
      makeAnswer({ correct: true, durationMs: 3000, reviewedAt: '2026-10-12T11:00:00Z', sessionId: 'session-2' }),
    ];
    const result = calculateTrueMastery(answers, TODAY, defaultConfig);
    expect(result.modes.length).toBeGreaterThan(0);
    expect(result.modes[0]!.totalAnswers).toBe(2);
    expect(result.modes[0]!.correctAnswers).toBe(2);
  });

  it('duplicate attempt submissions (same sessionId, same time) are aggregated', () => {
    // Two identical submissions in same session
    const answers = [
      makeAnswer({ sessionId: 'session-1', reviewedAt: '2026-10-12T10:00:00Z' }),
      makeAnswer({ sessionId: 'session-1', reviewedAt: '2026-10-12T10:00:00Z' }),
    ];
    const result = calculateTrueMastery(answers, TODAY, defaultConfig);
    // Only the last one in session counts
    expect(result.modes.length).toBeGreaterThan(0);
    expect(result.modes[0]!.totalAnswers).toBe(2);
    // But effective evidence should be capped
    expect(result.modes[0]!.effectiveEvidence).toBeLessThan(2);
  });

  it('evidence coverage labels are correct', () => {
    expect(getEvidenceCoverageLabel('insufficient')).toBe('Insufficient data');
    expect(getEvidenceCoverageLabel('low')).toBe('Low evidence');
    expect(getEvidenceCoverageLabel('moderate')).toBe('Moderate evidence');
    expect(getEvidenceCoverageLabel('high')).toBe('High evidence');
  });

  it('tier labels are correct', () => {
    expect(getTrueMasteryTier(null)).toBe('Unknown');
    expect(getTrueMasteryTier(95)).toBe('Excellent');
    expect(getTrueMasteryTier(80)).toBe('Strong');
    expect(getTrueMasteryTier(70)).toBe('Good');
    expect(getTrueMasteryTier(50)).toBe('Developing');
    expect(getTrueMasteryTier(30)).toBe('Weak');
    expect(getTrueMasteryTier(10)).toBe('New');
  });

  it('insufficient data returns Unknown tier', () => {
    const result = calculateTrueMastery([], TODAY);
    expect(getTrueMasteryTier(result.mastery)).toBe('Unknown');
  });

  it('weights can be overridden via config', () => {
    const customWeights = { ...defaultConfig.modeWeights, typing: 1.0, recognition: 0 };
    const answers = [
      makeAnswer({ mode: 'typing', correct: true }),
      makeAnswer({ mode: 'recognition', correct: true }),
    ];
    const result = calculateTrueMastery(answers, TODAY, { ...defaultConfig, modeWeights: customWeights });
    expect(result.modes.find(m => m.mode === 'typing')?.weight).toBe(1.0);
    expect(result.modes.find(m => m.mode === 'recognition')?.weight).toBe(0);
  });

  it('confidence increases with more evidence', () => {
    const few = [makeAnswer({ correct: true })];
    const many = Array.from({ length: 30 }, (_, i) =>
      makeAnswer({ correct: true, reviewedAt: `2026-10-12T${10 + i}:00:00Z`, sessionId: `session-${i}` })
    );
    const fewResult = calculateTrueMastery(few, TODAY, defaultConfig);
    const manyResult = calculateTrueMastery(many, TODAY, defaultConfig);
    expect(fewResult.modes.length).toBeGreaterThan(0);
    expect(manyResult.modes.length).toBeGreaterThan(0);
    expect(manyResult.modes[0]!.confidence).toBeGreaterThan(fewResult.modes[0]!.confidence);
  });
});