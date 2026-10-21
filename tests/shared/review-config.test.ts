/**
 * Guards the owner's actual configuration: the queue rule carried over from
 * their original vocabulary system, and the "Nhớ" / "Không nhớ" rules as the
 * owner specified them. The expected dates below are the owner's own worked
 * examples.
 */
import { describe, expect, it } from 'vitest';
import { cardFields, newWordDefaults, reviewRules } from '../../config/review.config.js';
import {
  applyAction,
  areDetailsVisible,
  areWriteRulesConfirmed,
  buildQueue,
  checkEligibility,
} from '../../shared/review-logic.js';
import { TODAY } from '../helpers/fixtures.js';

/** The day of the review in the owner's examples. */
const REVIEW_DAY = '2026-10-10';

/** The original rule, written out: mastery < 10 and (no review date, or review date <= today). */
const dueForReview = (mastery: number, reviewDate: string | null) =>
  mastery < 10 && (reviewDate === null || reviewDate <= TODAY);

describe('queue rules', () => {
  it('starts a new word at mastery 1 with no review date, so it is due at once', () => {
    expect(newWordDefaults).toEqual({ mastery: 1, reviewDate: 'empty', dueOn: 'today', newWordsPerDay: 20 });
    expect(dueForReview(newWordDefaults.mastery, null)).toBe(true);
  });

  it('agrees with the "Due for Review" formula for every combination', () => {
    const dates = [null, '2026-09-01', '2026-10-08', TODAY, '2026-10-10', '2027-01-01'];
    for (let mastery = 0; mastery <= 11; mastery += 1) {
      for (const nextReview of dates) {
        expect(
          checkEligibility({ mastery, nextReview }, TODAY, reviewRules).eligible,
          `mastery ${mastery}, review date ${nextReview}`,
        ).toBe(dueForReview(mastery, nextReview));
      }
    }
  });

  it('includes words due today and overdue, and excludes future ones', () => {
    expect(checkEligibility({ mastery: 4, nextReview: TODAY }, TODAY, reviewRules).eligible).toBe(true);
    expect(checkEligibility({ mastery: 4, nextReview: '2026-09-30' }, TODAY, reviewRules).eligible).toBe(true);
    expect(checkEligibility({ mastery: 4, nextReview: '2026-10-10' }, TODAY, reviewRules)).toEqual({
      eligible: false,
      reason: 'not_due',
    });
  });

  it('never queues mastery 10', () => {
    expect(checkEligibility({ mastery: 10, nextReview: '2026-01-01' }, TODAY, reviewRules)).toEqual({
      eligible: false,
      reason: 'retired',
    });
  });

  it('still queues mastery 6 to 9 when due, even though their details are hidden', () => {
    for (const mastery of [6, 7, 8, 9]) {
      expect(checkEligibility({ mastery, nextReview: TODAY }, TODAY, reviewRules).eligible).toBe(true);
      expect(areDetailsVisible(mastery, reviewRules)).toBe(false);
    }
  });

  it('treats a word with no review date as due', () => {
    expect(checkEligibility({ mastery: 1, nextReview: null }, TODAY, reviewRules)).toEqual({ eligible: true });
  });

  it('orders the queue like the "Need review" view: review date ascending', () => {
    const { queue } = buildQueue(
      [
        { id: 'today', mastery: 3, nextReview: TODAY },
        { id: 'oldest', mastery: 7, nextReview: '2026-09-20' },
        { id: 'yesterday', mastery: 1, nextReview: '2026-10-08' },
      ],
      TODAY,
      reviewRules,
    );
    expect(queue.map((item) => item.id)).toEqual(['oldest', 'yesterday', 'today']);
  });
});

describe('card fields', () => {
  it('shows definition and example for mastery 0 to 5 and hides them above', () => {
    for (const mastery of [0, 1, 2, 3, 4, 5]) expect(areDetailsVisible(mastery, reviewRules)).toBe(true);
    for (const mastery of [6, 7, 8, 9]) expect(areDetailsVisible(mastery, reviewRules)).toBe(false);
    const governed = cardFields.filter((field) => field.visibility === 'details').map((field) => field.key);
    expect(governed).toEqual(['definition', 'example']);
  });

  it('never puts a mastery-governed field on the front of the card', () => {
    expect(cardFields.filter((field) => field.side === 'front' && field.visibility === 'details')).toEqual([]);
  });

  it('gives every card field a distinct key, and only fields the database stores', () => {
    expect(new Set(cardFields.map((field) => field.key)).size).toBe(cardFields.length);
    expect(cardFields.map((field) => field.key).sort()).toEqual(['definition', 'example', 'meaning']);
  });
});

describe('"Nhớ" (Remember)', () => {
  // The owner's table: reviewed on 10 October.
  it.each([
    [0, 1, '2026-10-10'],
    [1, 2, '2026-10-11'],
    [2, 3, '2026-10-12'],
    [3, 4, '2026-10-13'],
    [4, 5, '2026-10-14'],
    [5, 6, '2026-10-15'],
    [6, 7, '2026-10-16'],
    [7, 8, '2026-10-17'],
    [8, 9, '2026-10-18'],
    [9, 10, '2026-10-19'],
  ])('mastery %i becomes %i, next review %s', (before, after, nextReview) => {
    expect(applyAction('remember', { mastery: before, nextReview: REVIEW_DAY }, REVIEW_DAY, reviewRules)).toEqual({
      mastery: after,
      nextReview,
    });
  });

  it('counts the interval from the old mastery, not the new one', () => {
    const result = applyAction('remember', { mastery: 3, nextReview: REVIEW_DAY }, REVIEW_DAY, reviewRules);
    expect(result.nextReview).toBe('2026-10-13'); // 3 days, not 4
  });

  it('counts from the day of the review, even when the word was overdue', () => {
    expect(applyAction('remember', { mastery: 3, nextReview: '2026-10-02' }, REVIEW_DAY, reviewRules)).toEqual({
      mastery: 4,
      nextReview: '2026-10-13',
    });
  });

  it('schedules a word that had no review date', () => {
    expect(applyAction('remember', { mastery: 2, nextReview: null }, REVIEW_DAY, reviewRules)).toEqual({
      mastery: 3,
      nextReview: '2026-10-12',
    });
  });

  it('leaves a mastery-0 word due the same day', () => {
    const result = applyAction('remember', { mastery: 0, nextReview: REVIEW_DAY }, REVIEW_DAY, reviewRules);
    expect(result).toEqual({ mastery: 1, nextReview: REVIEW_DAY });
    // Still due by the rule, which is why a session never shows a card twice.
    expect(checkEligibility(result, REVIEW_DAY, reviewRules).eligible).toBe(true);
  });

  it('retires the word on reaching mastery 10', () => {
    const result = applyAction('remember', { mastery: 9, nextReview: REVIEW_DAY }, REVIEW_DAY, reviewRules);
    expect(result.mastery).toBe(10);
    expect(checkEligibility(result, '2026-10-19', reviewRules)).toEqual({ eligible: false, reason: 'retired' });
  });

  it('never produces a mastery above 10', () => {
    expect(reviewRules.remember?.masteryAfter(10)).toBe(10);
    expect(reviewRules.remember?.masteryAfter(9)).toBe(10);
  });

  it('uses calendar days across month and year ends', () => {
    expect(applyAction('remember', { mastery: 8, nextReview: '2026-10-28' }, '2026-10-28', reviewRules).nextReview).toBe(
      '2026-11-05',
    );
    expect(applyAction('remember', { mastery: 5, nextReview: '2026-12-29' }, '2026-12-29', reviewRules).nextReview).toBe(
      '2027-01-03',
    );
    expect(applyAction('remember', { mastery: 2, nextReview: '2028-02-28' }, '2028-02-28', reviewRules).nextReview).toBe(
      '2028-03-01',
    );
  });
});

describe('"Không nhớ" (Not remember)', () => {
  // The owner's table: reviewed on 10 October.
  it.each([0, 1, 2, 3, 5, 8, 9])('mastery %i stays the same, next review the following day', (mastery) => {
    expect(applyAction('not_remember', { mastery, nextReview: REVIEW_DAY }, REVIEW_DAY, reviewRules)).toEqual({
      mastery,
      nextReview: '2026-10-11',
    });
  });

  it('does not use the Remember interval', () => {
    const result = applyAction('not_remember', { mastery: 8, nextReview: REVIEW_DAY }, REVIEW_DAY, reviewRules);
    expect(result.nextReview).toBe('2026-10-11'); // not 18 October
  });

  it('counts from the day of the review, even when the word was overdue', () => {
    expect(applyAction('not_remember', { mastery: 4, nextReview: '2026-09-28' }, REVIEW_DAY, reviewRules)).toEqual({
      mastery: 4,
      nextReview: '2026-10-11',
    });
  });

  it('schedules a word that had no review date', () => {
    expect(applyAction('not_remember', { mastery: 1, nextReview: null }, REVIEW_DAY, reviewRules)).toEqual({
      mastery: 1,
      nextReview: '2026-10-11',
    });
  });

  it('crosses a month end correctly', () => {
    expect(applyAction('not_remember', { mastery: 6, nextReview: '2026-10-31' }, '2026-10-31', reviewRules).nextReview).toBe(
      '2026-11-01',
    );
  });
});

describe('saving', () => {
  it('has both action rules in place', () => {
    expect(areWriteRulesConfirmed(reviewRules)).toBe(true);
  });
});
