/**
 * Tests for the rules ENGINE. The dates expected here follow from
 * `sampleRules`, which are illustrative and explicitly not the owner's
 * schedule (see server/mock/sample-rules.ts). The owner's own rules are
 * covered by review-config.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  RuleNotConfirmedError,
  applyAction,
  areDetailsVisible,
  areWriteRulesConfirmed,
  buildQueue,
  checkEligibility,
  reconcile,
  type ReviewRules,
} from '../../shared/review-logic.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { TODAY } from '../helpers/fixtures.js';

const YESTERDAY = '2026-10-08';
const TOMORROW = '2026-10-10';

describe('checkEligibility', () => {
  it('includes an item due today', () => {
    expect(checkEligibility({ mastery: 3, nextReview: TODAY }, TODAY, sampleRules)).toEqual({ eligible: true });
  });

  it('includes an overdue item', () => {
    expect(checkEligibility({ mastery: 3, nextReview: '2026-09-01' }, TODAY, sampleRules)).toEqual({
      eligible: true,
    });
  });

  it('excludes an item due in the future', () => {
    expect(checkEligibility({ mastery: 3, nextReview: TOMORROW }, TODAY, sampleRules)).toEqual({
      eligible: false,
      reason: 'not_due',
    });
  });

  it('excludes mastery 10 even when it is overdue', () => {
    expect(checkEligibility({ mastery: 10, nextReview: '2026-01-01' }, TODAY, sampleRules)).toEqual({
      eligible: false,
      reason: 'retired',
    });
  });

  it('also excludes a mastery above 10', () => {
    expect(checkEligibility({ mastery: 11, nextReview: TODAY }, TODAY, sampleRules)).toEqual({
      eligible: false,
      reason: 'retired',
    });
  });

  it('keeps mastery 9 in the queue', () => {
    expect(checkEligibility({ mastery: 9, nextReview: TODAY }, TODAY, sampleRules).eligible).toBe(true);
  });

  it('can be configured to treat "due today" as not yet due', () => {
    const strict: ReviewRules = { ...sampleRules, includeDueToday: false };
    expect(checkEligibility({ mastery: 3, nextReview: TODAY }, TODAY, strict)).toEqual({
      eligible: false,
      reason: 'not_due',
    });
    expect(checkEligibility({ mastery: 3, nextReview: YESTERDAY }, TODAY, strict).eligible).toBe(true);
  });

  it('excludes a missing or invalid due date unless the rules admit it', () => {
    for (const nextReview of [null, 'soon', '2026-02-30']) {
      expect(checkEligibility({ mastery: 3, nextReview }, TODAY, sampleRules)).toEqual({
        eligible: false,
        reason: 'missing_due_date',
      });
    }
    const lenient: ReviewRules = { ...sampleRules, includeMissingDueDate: true };
    expect(checkEligibility({ mastery: 3, nextReview: null }, TODAY, lenient).eligible).toBe(true);
  });

  it('excludes a mastery that is not a whole number of zero or more', () => {
    for (const mastery of [2.5, -1, 0.1]) {
      expect(checkEligibility({ mastery, nextReview: TODAY }, TODAY, sampleRules)).toEqual({
        eligible: false,
        reason: 'invalid_mastery',
      });
    }
    expect(checkEligibility({ mastery: 0, nextReview: TODAY }, TODAY, sampleRules).eligible).toBe(true);
  });

  it('excludes a missing mastery unless the rules give it a value', () => {
    expect(checkEligibility({ mastery: null, nextReview: TODAY }, TODAY, sampleRules)).toEqual({
      eligible: false,
      reason: 'missing_mastery',
    });
    const asZero: ReviewRules = { ...sampleRules, missingMastery: { treatAs: 0 } };
    expect(checkEligibility({ mastery: null, nextReview: TODAY }, TODAY, asZero).eligible).toBe(true);
  });

  it('can allow a word to be reviewed before it is due, for a weak focused review', () => {
    expect(checkEligibility({ mastery: 3, nextReview: TOMORROW }, TODAY, sampleRules, { allowNotDue: true })).toEqual({
      eligible: true,
    });
    // Retirement and an unusable mastery are still refused.
    expect(checkEligibility({ mastery: 10, nextReview: TOMORROW }, TODAY, sampleRules, { allowNotDue: true })).toEqual({
      eligible: false,
      reason: 'retired',
    });
  });
});

describe('buildQueue', () => {
  const item = (id: string, nextReview: string | null, mastery: number | null = 3) => ({ id, nextReview, mastery });

  it('orders by due date, most overdue first', () => {
    const { queue } = buildQueue(
      [item('today', TODAY), item('oldest', '2026-09-01'), item('yesterday', YESTERDAY)],
      TODAY,
      sampleRules,
    );
    expect(queue.map((entry) => entry.id)).toEqual(['oldest', 'yesterday', 'today']);
  });

  it('supports the opposite direction', () => {
    const { queue } = buildQueue(
      [item('oldest', '2026-09-01'), item('today', TODAY), item('yesterday', YESTERDAY)],
      TODAY,
      { ...sampleRules, sortDirection: 'descending' },
    );
    expect(queue.map((entry) => entry.id)).toEqual(['today', 'yesterday', 'oldest']);
  });

  it('keeps cards that share a due date in the order they were returned', () => {
    const { queue } = buildQueue(
      [item('c', TODAY), item('a', TODAY), item('old', YESTERDAY), item('b', TODAY)],
      TODAY,
      sampleRules,
    );
    expect(queue.map((entry) => entry.id)).toEqual(['old', 'c', 'a', 'b']);
  });

  it('drops duplicate records, keeping the first', () => {
    const first = { ...item('dup', YESTERDAY), marker: 'first' };
    const second = { ...item('dup', YESTERDAY), marker: 'second' };
    const { queue, excluded } = buildQueue([first, item('other', TODAY), second], TODAY, sampleRules);
    expect(queue.map((entry) => entry.id)).toEqual(['dup', 'other']);
    expect(queue[0]).toBe(first);
    expect(excluded).toEqual([{ record: second, reason: 'duplicate' }]);
  });

  it('leaves out retired, future and incomplete records and says why', () => {
    const { queue, excluded } = buildQueue(
      [
        item('due', TODAY),
        item('mastered', YESTERDAY, 10),
        item('future', TOMORROW),
        item('undated', null),
        item('ungraded', TODAY, null),
      ],
      TODAY,
      sampleRules,
    );
    expect(queue.map((entry) => entry.id)).toEqual(['due']);
    expect(Object.fromEntries(excluded.map((entry) => [entry.record.id, entry.reason]))).toEqual({
      mastered: 'retired',
      future: 'not_due',
      undated: 'missing_due_date',
      ungraded: 'missing_mastery',
    });
  });

  it('returns an empty queue for no records', () => {
    expect(buildQueue([], TODAY, sampleRules)).toEqual({ queue: [], excluded: [] });
  });

  it('keeps a not-yet-due record when the caller allows it, without keeping retired ones', () => {
    const { queue, excluded } = buildQueue(
      [item('future', TOMORROW), item('mastered', TOMORROW, 10)],
      TODAY,
      sampleRules,
      { allowNotDue: true },
    );
    expect(queue.map((entry) => entry.id)).toEqual(['future']);
    expect(excluded.map((entry) => entry.record.id)).toEqual(['mastered']);
  });
});

describe('areDetailsVisible', () => {
  it('shows details at mastery 5 and hides them at mastery 6', () => {
    expect(areDetailsVisible(5, sampleRules)).toBe(true);
    expect(areDetailsVisible(6, sampleRules)).toBe(false);
  });

  it('holds at the extremes', () => {
    expect(areDetailsVisible(0, sampleRules)).toBe(true);
    expect(areDetailsVisible(9, sampleRules)).toBe(false);
  });
});

describe('applyAction (with the illustrative sample rules)', () => {
  it('Remember raises mastery and schedules from today', () => {
    expect(applyAction('remember', { mastery: 3, nextReview: '2026-10-01' }, TODAY, sampleRules)).toEqual({
      mastery: 4,
      nextReview: '2026-10-13',
    });
  });

  it('Remember at mastery 9 reaches 10, which retires the card', () => {
    const next = applyAction('remember', { mastery: 9, nextReview: TODAY }, TODAY, sampleRules);
    expect(next.mastery).toBe(10);
    expect(checkEligibility(next, TODAY, sampleRules)).toEqual({ eligible: false, reason: 'retired' });
  });

  it('Not Remember leaves mastery alone and moves the date one day', () => {
    expect(applyAction('not_remember', { mastery: 3, nextReview: '2026-10-01' }, TODAY, sampleRules)).toEqual({
      mastery: 3,
      nextReview: TOMORROW,
    });
  });

  it('can count the interval from the existing due date instead of today', () => {
    const fromDueDate: ReviewRules = {
      ...sampleRules,
      notRemember: { masteryAfter: (mastery) => mastery, schedule: { base: 'currentDueDate', intervalDays: () => 1 } },
    };
    expect(applyAction('not_remember', { mastery: 3, nextReview: '2026-10-01' }, TODAY, fromDueDate)).toEqual({
      mastery: 3,
      nextReview: '2026-10-02',
    });
    expect(() => applyAction('not_remember', { mastery: 3, nextReview: null }, TODAY, fromDueDate)).toThrow(
      RangeError,
    );
  });

  it('does not mutate the state it is given', () => {
    const state = Object.freeze({ mastery: 3, nextReview: TODAY });
    applyAction('remember', state, TODAY, sampleRules);
    expect(state).toEqual({ mastery: 3, nextReview: TODAY });
  });

  it('refuses to apply a rule that has not been confirmed', () => {
    const unconfirmed: ReviewRules = { ...sampleRules, remember: null };
    expect(() => applyAction('remember', { mastery: 3, nextReview: TODAY }, TODAY, unconfirmed)).toThrow(
      RuleNotConfirmedError,
    );
    expect(areWriteRulesConfirmed(unconfirmed)).toBe(false);
    expect(areWriteRulesConfirmed(sampleRules)).toBe(true);
  });

  it('rejects a rule that produces a fractional interval', () => {
    const broken: ReviewRules = {
      ...sampleRules,
      remember: { masteryAfter: (mastery) => mastery + 1, schedule: { base: 'today', intervalDays: () => 1.5 } },
    };
    expect(() => applyAction('remember', { mastery: 3, nextReview: TODAY }, TODAY, broken)).toThrow(RangeError);
  });
});

describe('reconcile', () => {
  const shown = { mastery: 3, nextReview: YESTERDAY };

  it('applies when the record is exactly as the reviewer saw it', () => {
    expect(reconcile('remember', shown, { ...shown }, TODAY, sampleRules)).toBe('apply');
  });

  it('recognises an answer that already landed', () => {
    const afterRemember = applyAction('remember', shown, TODAY, sampleRules);
    expect(reconcile('remember', shown, afterRemember, TODAY, sampleRules)).toBe('already_applied');
    const afterNotRemember = applyAction('not_remember', shown, TODAY, sampleRules);
    expect(reconcile('not_remember', shown, afterNotRemember, TODAY, sampleRules)).toBe('already_applied');
  });

  it('reports a conflict when the record changed some other way', () => {
    expect(reconcile('remember', shown, { mastery: 7, nextReview: YESTERDAY }, TODAY, sampleRules)).toBe('conflict');
    // The other answer landed, not this one.
    const afterNotRemember = applyAction('not_remember', shown, TODAY, sampleRules);
    expect(reconcile('remember', shown, afterNotRemember, TODAY, sampleRules)).toBe('conflict');
  });

  it('never claims an unconfirmed rule was applied', () => {
    const unconfirmed: ReviewRules = { ...sampleRules, remember: null };
    expect(reconcile('remember', shown, { mastery: 4, nextReview: '2026-10-13' }, TODAY, unconfirmed)).toBe('conflict');
  });
});
