/**
 * Guards the owner's actual configuration against the rules read from their
 * Notion database (see docs/review-logic.md). Nothing here invents a schedule.
 * When the "Nhớ" / "Không nhớ" rules are confirmed and filled in, replace the
 * "locked" test with exact before/after dates for the real formula.
 */
import { describe, expect, it } from 'vitest';
import { cardFields, notionProperties, reviewRules } from '../../config/review.config.js';
import { areDetailsVisible, areWriteRulesConfirmed, buildQueue, checkEligibility } from '../../shared/review-logic.js';
import { TODAY } from '../helpers/fixtures.js';

/** Notion's own rule: Mastery < 10 and (empty(Review Date) or Review Date <= today()). */
const dueForReview = (mastery: number, reviewDate: string | null) =>
  mastery < 10 && (reviewDate === null || reviewDate <= TODAY);

describe('config/review.config.ts', () => {
  it('reads the properties the database actually has', () => {
    expect(notionProperties).toEqual({ word: 'Word', mastery: 'Mastery', nextReview: 'Review Date' });
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

  it('never queues mastery 10', () => {
    expect(checkEligibility({ mastery: 10, nextReview: '2026-01-01' }, TODAY, reviewRules)).toEqual({
      eligible: false,
      reason: 'retired',
    });
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

  it('hides definition and example above mastery 5', () => {
    expect(areDetailsVisible(5, reviewRules)).toBe(true);
    expect(areDetailsVisible(6, reviewRules)).toBe(false);
    const governed = cardFields.filter((field) => field.visibility === 'details').map((field) => field.key);
    expect(governed).toEqual(['definition', 'example']);
  });

  it('never puts a mastery-governed field on the front of the card', () => {
    expect(cardFields.filter((field) => field.side === 'front' && field.visibility === 'details')).toEqual([]);
  });

  it('gives every card field a distinct key and property', () => {
    expect(new Set(cardFields.map((field) => field.key)).size).toBe(cardFields.length);
    expect(new Set(cardFields.map((field) => field.property)).size).toBe(cardFields.length);
  });

  it('keeps writes locked until both action rules are confirmed', () => {
    // Fails on purpose the day the rules are filled in: add real date tests then.
    expect(reviewRules.remember).toBeNull();
    expect(reviewRules.notRemember).toBeNull();
    expect(areWriteRulesConfirmed(reviewRules)).toBe(false);
  });
});
