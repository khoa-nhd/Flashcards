import { describe, expect, it } from 'vitest';
import { reviewRules } from '../../config/review.config.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { checkEligibility } from '../../shared/review-logic.js';
import { normalizeWord, matchesQuery, tidyWord } from '../../shared/text.js';
import { classifyReviewStatus, isReviewableNow } from '../../shared/vocabulary-status.js';
import { TODAY } from '../helpers/fixtures.js';

const status = (mastery: number | null, reviewDate: string | null, rules = reviewRules) =>
  classifyReviewStatus({ mastery, reviewDate }, TODAY, rules);

describe('classifyReviewStatus', () => {
  it('gives every word exactly one status', () => {
    expect(status(10, '2026-01-01')).toBe('mastered');
    expect(status(3, '2026-10-01')).toBe('overdue');
    expect(status(3, TODAY)).toBe('due_today');
    expect(status(3, '2026-10-10')).toBe('upcoming');
    expect(status(3, null)).toBe('unscheduled');
    expect(status(null, TODAY)).toBe('invalid');
    expect(status(2.5, TODAY)).toBe('invalid');
    expect(status(-1, TODAY)).toBe('invalid');
  });

  it('treats mastery 10 as completed whatever its date', () => {
    for (const date of [null, '2020-01-01', TODAY, '2030-01-01']) expect(status(10, date)).toBe('mastered');
    expect(status(11, TODAY)).toBe('mastered');
  });

  it('never counts an overdue word as due today', () => {
    expect(status(1, '2026-10-08')).toBe('overdue');
    expect(status(1, TODAY)).not.toBe('overdue');
  });

  it('counts mastery 0 and mastery 9 as still learning', () => {
    expect(status(0, TODAY)).toBe('due_today');
    expect(status(9, '2026-10-01')).toBe('overdue');
  });

  it('treats an unreadable date as no date', () => {
    expect(status(3, 'not a date')).toBe('unscheduled');
  });

  it('agrees with the review queue for every combination of mastery and date', () => {
    const dates = [null, '2026-09-01', '2026-10-08', TODAY, '2026-10-10', '2027-01-01'];
    const masteries = [null, -1, 0, 1, 2.5, 5, 6, 9, 10, 11];
    for (const rules of [reviewRules, sampleRules]) {
      for (const mastery of masteries) {
        for (const reviewDate of dates) {
          const inQueue = checkEligibility({ mastery, nextReview: reviewDate }, TODAY, rules).eligible;
          const reviewable = isReviewableNow(classifyReviewStatus({ mastery, reviewDate }, TODAY, rules), rules);
          expect(reviewable, `mastery ${mastery}, date ${reviewDate}`).toBe(inQueue);
        }
      }
    }
  });

  it('counts an unscheduled word as reviewable only where the rules say so', () => {
    expect(isReviewableNow('unscheduled', reviewRules)).toBe(true);
    expect(isReviewableNow('unscheduled', sampleRules)).toBe(false);
    expect(isReviewableNow('upcoming', reviewRules)).toBe(false);
    expect(isReviewableNow('mastered', reviewRules)).toBe(false);
  });
});

describe('word normalisation', () => {
  it('ignores case, surrounding space and repeated spaces', () => {
    expect(normalizeWord('  Ice   Cream ')).toBe('ice cream');
    expect(normalizeWord('ICE CREAM')).toBe(normalizeWord('ice cream'));
    expect(normalizeWord('café')).toBe(normalizeWord('café'));
    expect(normalizeWord('cat')).not.toBe(normalizeWord('cats'));
  });

  it('tidies a word for storage without changing its case', () => {
    expect(tidyWord('  Ice   Cream ')).toBe('Ice Cream');
  });
});

describe('matchesQuery', () => {
  it('matches partial text, case-insensitively, in any field', () => {
    expect(matchesQuery('ser', ['Serendipity', null])).toBe(true);
    expect(matchesQuery('  DIP ', ['serendipity'])).toBe(true);
    expect(matchesQuery('luck', ['serendipity', 'good luck by chance'])).toBe(true);
    expect(matchesQuery('tình cờ', ['sự Tình  Cờ may mắn'])).toBe(true);
  });

  it('matches everything for an empty query and nothing for a miss', () => {
    expect(matchesQuery('   ', ['anything'])).toBe(true);
    expect(matchesQuery('zebra', ['serendipity', null])).toBe(false);
    expect(matchesQuery('x', [null, null])).toBe(false);
  });
});
