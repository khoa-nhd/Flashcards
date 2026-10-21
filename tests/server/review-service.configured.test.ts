/**
 * The review service running the owner's real rules and card fields
 * (config/review.config.ts) against an in-memory store.
 *
 * The clock is fixed at half past midnight on 10 October in Vietnam, which is
 * still 9 October in UTC, so a mistake in day arithmetic shows up immediately.
 */
import { describe, expect, it } from 'vitest';
import { cardFields, reviewRules } from '../../config/review.config.js';
import { ReviewService, type ReviewServiceOptions } from '../../server/review-service.js';
import type { ReviewState } from '../../shared/review-logic.js';
import { FakeRepository, pageId, record } from '../helpers/fixtures.js';

const JUST_AFTER_MIDNIGHT = new Date('2026-10-09T17:30:00Z');
const REVIEW_DAY = '2026-10-10';

function start(state: ReviewState, overrides: Partial<ReviewServiceOptions> = {}) {
  const repository = new FakeRepository([
    record(1, {
      mastery: state.mastery,
      nextReview: state.nextReview,
      fields: { meaning: 'tình cờ may mắn', definition: 'a happy accident', example: 'What luck!' },
    }),
  ]);
  const service = new ReviewService({
    repository,
    rules: reviewRules,
    cardFields,
    timeZone: 'Asia/Ho_Chi_Minh',
    writesRequested: true,
    now: () => JUST_AFTER_MIDNIGHT,
    ...overrides,
  });
  return { repository, service };
}

describe('Remember', () => {
  it.each([
    [0, 1, '2026-10-10'],
    [1, 2, '2026-10-11'],
    [3, 4, '2026-10-13'],
    [5, 6, '2026-10-15'],
    [9, 10, '2026-10-19'],
  ])('at mastery %i saves mastery %i and review date %s', async (before, after, nextReview) => {
    const shown = { mastery: before, nextReview: REVIEW_DAY };
    const { repository, service } = start(shown);
    const result = await service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    expect(result).toEqual({ outcome: 'applied', state: { mastery: after, nextReview } });
    expect(await repository.getRecord(pageId(1))).toMatchObject({ mastery: after, nextReview });
  });

  it('at mastery 0 changes only Mastery when the word was due that day', async () => {
    const shown = { mastery: 0, nextReview: REVIEW_DAY };
    const { repository, service } = start(shown);
    await service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    expect(repository.updates).toEqual([{ pageId: pageId(1), changes: { mastery: 1 } }]);
  });

  it('schedules an overdue word from the day of the review', async () => {
    const shown = { mastery: 4, nextReview: '2026-10-02' };
    const { service } = start(shown);
    const result = await service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    expect(result.state).toEqual({ mastery: 5, nextReview: '2026-10-14' });
  });

  it('a second identical request is recognised, not applied again', async () => {
    const shown = { mastery: 0, nextReview: REVIEW_DAY };
    const { repository, service } = start(shown);
    const request = { pageId: pageId(1), action: 'remember' as const, expected: shown };
    await service.submitAction(request);
    await expect(service.submitAction(request)).resolves.toMatchObject({ outcome: 'already_applied' });
    expect((await repository.getRecord(pageId(1)))?.mastery).toBe(1);
    expect(repository.updates).toHaveLength(1);
  });

  it('a word that reaches mastery 10 leaves the queue for good', async () => {
    const shown = { mastery: 9, nextReview: REVIEW_DAY };
    const { service } = start(shown);
    await service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    const later = start({ mastery: 10, nextReview: '2026-10-19' }, { now: () => new Date('2026-10-25T05:00:00Z') });
    expect(await later.service.getQueue()).toMatchObject({ cards: [], vocabulary: 'all_mastered' });
  });
});

describe('Not Remember', () => {
  it.each([3, 9])('at mastery %i keeps the mastery and saves the next day', async (mastery) => {
    const shown = { mastery, nextReview: REVIEW_DAY };
    const { repository, service } = start(shown);
    const result = await service.submitAction({ pageId: pageId(1), action: 'not_remember', expected: shown });
    expect(result).toEqual({ outcome: 'applied', state: { mastery, nextReview: '2026-10-11' } });
    // Mastery is not even written.
    expect(repository.updates).toEqual([{ pageId: pageId(1), changes: { nextReview: '2026-10-11' } }]);
  });

  it('reviews a word that has no review date', async () => {
    const shown = { mastery: 1, nextReview: null };
    const { service } = start(shown);
    expect((await service.getQueue()).cards).toHaveLength(1);
    const result = await service.submitAction({ pageId: pageId(1), action: 'not_remember', expected: shown });
    expect(result.state).toEqual({ mastery: 1, nextReview: '2026-10-11' });
  });
});

describe('calendar days and time zones', () => {
  it('uses the local calendar day, not the UTC one', async () => {
    const shown = { mastery: 3, nextReview: '2026-10-09' };
    const local = start(shown);
    const localResult = await local.service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    expect(localResult.state).toEqual({ mastery: 4, nextReview: '2026-10-13' });

    // The same instant read in UTC is still 9 October, which would give the 12th.
    const utc = start(shown, { timeZone: 'UTC' });
    const utcResult = await utc.service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    expect(utcResult.state).toEqual({ mastery: 4, nextReview: '2026-10-12' });
  });

  it('gives the same result at any time of the same local day', async () => {
    const shown = { mastery: 2, nextReview: '2026-10-08' };
    for (const instant of ['2026-10-09T17:00:01Z', '2026-10-10T05:00:00Z', '2026-10-10T16:59:59Z']) {
      const { service } = start(shown, { now: () => new Date(instant) });
      const result = await service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
      expect(result.state, instant).toEqual({ mastery: 3, nextReview: '2026-10-12' });
    }
  });

  it('decides what is due by the local day as well', async () => {
    // Due on the 10th: not yet due by the UTC calendar, due by the Vietnamese one.
    const shown = { mastery: 3, nextReview: REVIEW_DAY };
    expect((await start(shown).service.getQueue()).cards).toHaveLength(1);
    expect((await start(shown, { timeZone: 'UTC' }).service.getQueue()).cards).toHaveLength(0);
  });
});

describe('saving switch and card content', () => {
  it('saves only when saving was switched on', async () => {
    const shown = { mastery: 3, nextReview: REVIEW_DAY };
    expect((await start(shown).service.getQueue()).writesEnabled).toBe(true);

    const off = start(shown, { writesRequested: false });
    expect((await off.service.getQueue()).writesEnabled).toBe(false);
    const result = await off.service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    expect(result).toEqual({ outcome: 'dry_run', state: { mastery: 4, nextReview: '2026-10-13' } });
    expect(off.repository.updates).toEqual([]);
  });

  it('sends the Vietnamese meaning always, and the English details only up to mastery 5', async () => {
    const low = await start({ mastery: 5, nextReview: REVIEW_DAY }).service.getQueue();
    expect(low.cards[0]?.back.map((field) => field.key)).toEqual(['meaning', 'definition', 'example']);

    const high = await start({ mastery: 6, nextReview: REVIEW_DAY }).service.getQueue();
    expect(high.cards[0]?.back.map((field) => field.key)).toEqual(['meaning']);
    expect(high.cards[0]?.detailsHidden).toBe(true);
    expect(JSON.stringify(high)).not.toContain('a happy accident');
    expect(JSON.stringify(high)).not.toContain('What luck!');
  });
});
