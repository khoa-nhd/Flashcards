/**
 * Guards the owner's actual configuration. Only behaviour that was stated in
 * the brief is asserted; nothing here invents a schedule. When the Remember /
 * Not Remember rules are confirmed and filled in, replace the "locked" test
 * with exact before/after dates for the real formula.
 */
import { describe, expect, it } from 'vitest';
import { cardFields, notionProperties, reviewRules } from '../../config/review.config.js';
import { areDetailsVisible, areWriteRulesConfirmed, checkEligibility } from '../../shared/review-logic.js';
import { TODAY } from '../helpers/fixtures.js';

describe('config/review.config.ts', () => {
  it('never queues mastery 10', () => {
    expect(checkEligibility({ mastery: 10, nextReview: '2026-01-01' }, TODAY, reviewRules)).toEqual({
      eligible: false,
      reason: 'retired',
    });
  });

  it('queues due and overdue items but not future ones', () => {
    expect(checkEligibility({ mastery: 4, nextReview: TODAY }, TODAY, reviewRules).eligible).toBe(true);
    expect(checkEligibility({ mastery: 4, nextReview: '2026-10-01' }, TODAY, reviewRules).eligible).toBe(true);
    expect(checkEligibility({ mastery: 4, nextReview: '2026-10-10' }, TODAY, reviewRules).eligible).toBe(false);
  });

  it('hides definition and example above mastery 5', () => {
    expect(areDetailsVisible(5, reviewRules)).toBe(true);
    expect(areDetailsVisible(6, reviewRules)).toBe(false);
    const governed = cardFields.filter((field) => field.visibility === 'details').map((field) => field.key);
    expect(governed).toEqual(expect.arrayContaining(['definition', 'example']));
  });

  it('never puts a mastery-governed field on the front of the card', () => {
    expect(cardFields.filter((field) => field.side === 'front' && field.visibility === 'details')).toEqual([]);
  });

  it('maps each role to a distinct property', () => {
    const names = Object.values(notionProperties);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.trim() !== '')).toBe(true);
  });

  it('keeps writes locked until both action rules are confirmed', () => {
    // Fails on purpose the day the rules are filled in: add real date tests then.
    expect(reviewRules.remember).toBeNull();
    expect(reviewRules.notRemember).toBeNull();
    expect(areWriteRulesConfirmed(reviewRules)).toBe(false);
  });
});
