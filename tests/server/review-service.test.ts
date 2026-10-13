import { describe, expect, it } from 'vitest';
import { fsrsRatingMap } from '../../config/review.config.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { ReviewService, type ReviewServiceOptions } from '../../server/review-service.js';
import type { FsrsWrite } from '../../server/vocabulary-repository.js';
import { NO_CAPABILITIES } from '../../shared/api.js';
import type { ReviewRules } from '../../shared/review-logic.js';
import { DEFAULT_FSRS_SETTINGS, FSRS_RATINGS, fsrsReview } from '../../shared/scheduler/fsrs.js';
import type { VocabularyRecord } from '../../shared/vocabulary.js';
import { FakeRepository, NOW, TIME_ZONE, TODAY, pageId, record } from '../helpers/fixtures.js';
import { TEST_FIELDS } from '../helpers/fixtures.js';

function setup(records: VocabularyRecord[], overrides: Partial<ReviewServiceOptions> = {}, listed?: VocabularyRecord[]) {
  const repository = new FakeRepository(records, listed);
  const service = new ReviewService({
    repository,
    rules: sampleRules,
    cardFields: TEST_FIELDS,
    timeZone: TIME_ZONE,
    writesRequested: true,
    now: () => NOW,
    ...overrides,
  });
  return { repository, service };
}

const unconfirmedRules: ReviewRules = { ...sampleRules, remember: null, notRemember: null };

describe('getQueue', () => {
  it('returns eligible cards in due-date order with session metadata', async () => {
    const { service } = setup([
      record(1, { nextReview: TODAY }),
      record(2, { nextReview: '2026-10-01' }),
      record(3, { nextReview: '2026-10-20' }),
      record(4, { mastery: 10, nextReview: '2026-09-01' }),
    ]);
    const queue = await service.getQueue();
    expect(queue.cards.map((item) => item.id)).toEqual([pageId(2), pageId(1)]);
    expect(queue).toMatchObject({ today: TODAY, timeZone: TIME_ZONE, mode: 'mock', writesEnabled: true, skipped: [] });
  });

  it('uses the configured time zone to decide what "today" is', async () => {
    // 18:30 UTC on the 9th is already the 10th in UTC+7, so a card due on the 10th is due.
    const { service } = setup([record(1, { nextReview: '2026-10-10' })], {
      now: () => new Date('2026-10-09T18:30:00Z'),
    });
    expect((await service.getQueue()).cards).toHaveLength(1);
    const utc = setup([record(1, { nextReview: '2026-10-10' })], {
      now: () => new Date('2026-10-09T18:30:00Z'),
      timeZone: 'UTC',
    });
    expect((await utc.service.getQueue()).cards).toHaveLength(0);
  });

  it('shows definition and example at mastery 5', async () => {
    const { service } = setup([record(1, { mastery: 5 })]);
    const [first] = (await service.getQueue()).cards;
    expect(first?.detailsHidden).toBe(false);
    expect(first?.back.map((field) => field.key)).toEqual(['definition', 'example']);
    expect(first?.front).toEqual([{ key: 'partOfSpeech', label: 'Part of speech', value: 'noun' }]);
  });

  it('withholds definition and example entirely at mastery 6', async () => {
    const { service } = setup([record(1, { mastery: 6 })]);
    const queue = await service.getQueue();
    expect(queue.cards[0]).toMatchObject({ detailsHidden: true, back: [] });
    // The hidden text must not travel to the browser in any field.
    expect(JSON.stringify(queue)).not.toContain('definition of word-1');
    expect(JSON.stringify(queue)).not.toContain('example for word-1');
  });

  it('omits a missing optional example without dropping the card', async () => {
    const { service } = setup([
      record(1, { fields: { partOfSpeech: null, definition: 'only a definition', example: null } }),
    ]);
    const [first] = (await service.getQueue()).cards;
    expect(first?.front).toEqual([]);
    expect(first?.back).toEqual([{ key: 'definition', label: 'Definition', value: 'only a definition' }]);
  });

  it('removes duplicate records from the queue', async () => {
    const duplicate = record(1);
    const { service } = setup([duplicate, record(2)], {}, [duplicate, record(2), duplicate]);
    expect((await service.getQueue()).cards.map((item) => item.id)).toEqual([pageId(1), pageId(2)]);
  });

  it('surfaces records with an empty mastery instead of hiding them', async () => {
    const { service } = setup([record(1), record(2, { mastery: null })]);
    const queue = await service.getQueue();
    expect(queue.cards.map((item) => item.id)).toEqual([pageId(1)]);
    expect(queue.skipped).toEqual([{ id: pageId(2), word: 'word-2', reason: 'Mastery is empty.' }]);
  });

  it('reports read-only while rules are unconfirmed, even if writes were requested', async () => {
    const { service } = setup([record(1)], { rules: unconfirmedRules, writesRequested: true });
    expect((await service.getQueue()).writesEnabled).toBe(false);
  });

  it('reports read-only when writes were not requested or the schema is not writable', async () => {
    const off = setup([record(1)], { writesRequested: false });
    expect((await off.service.getQueue()).writesEnabled).toBe(false);
    const formula = setup([record(1)]);
    formula.repository.setup = { readIssues: [], writeIssues: ['"Mastery" is a formula.'], warnings: [] };
    expect((await formula.service.getQueue()).writesEnabled).toBe(false);
  });

  it('refuses to serve a queue when the setup cannot be read', async () => {
    const { repository, service } = setup([record(1)]);
    repository.setup = { readIssues: ['No property named "Mastery".'], writeIssues: [], warnings: [] };
    await expect(service.getQueue()).rejects.toMatchObject({ status: 503, code: 'setup_incomplete' });
  });
});

describe('submitAction', () => {
  const shown = { mastery: 3, nextReview: '2026-10-01' };
  const start = () => setup([record(1, shown)]);

  it('Remember writes the new mastery and date and returns the confirmed state', async () => {
    const { repository, service } = start();
    const result = await service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    expect(result).toEqual({ outcome: 'applied', state: { mastery: 4, nextReview: '2026-10-13' } });
    expect(repository.updates).toEqual([{ pageId: pageId(1), changes: { mastery: 4, nextReview: '2026-10-13' } }]);
  });

  it('Not Remember writes only the date, leaving mastery untouched', async () => {
    const { repository, service } = start();
    const result = await service.submitAction({ pageId: pageId(1), action: 'not_remember', expected: shown });
    expect(result).toEqual({ outcome: 'applied', state: { mastery: 3, nextReview: '2026-10-10' } });
    expect(repository.updates).toEqual([{ pageId: pageId(1), changes: { nextReview: '2026-10-10' } }]);
  });

  it('computes the update from the stored record, never from browser-supplied values', async () => {
    const { repository, service } = start();
    // A tampered "expected" can only make the request fail; it is never written.
    await expect(
      service.submitAction({ pageId: pageId(1), action: 'remember', expected: { mastery: 8, nextReview: '2026-10-01' } }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(repository.updates).toEqual([]);
  });

  it('does not apply an answer twice when the first response was lost', async () => {
    const { repository, service } = start();
    const request = { pageId: pageId(1), action: 'remember' as const, expected: shown };
    await service.submitAction(request);
    // The browser never saw the response and retries the identical request.
    const retry = await service.submitAction(request);
    expect(retry).toEqual({ outcome: 'already_applied', state: { mastery: 4, nextReview: '2026-10-13' } });
    expect(repository.updates).toHaveLength(1);
    expect((await repository.getRecord(pageId(1)))?.mastery).toBe(4);
  });

  it('serialises simultaneous duplicate requests so only one writes', async () => {
    const { repository, service } = start();
    const request = { pageId: pageId(1), action: 'remember' as const, expected: shown };
    const results = await Promise.all([service.submitAction(request), service.submitAction(request)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['already_applied', 'applied']);
    expect(repository.updates).toHaveLength(1);
  });

  it('treats ids with and without dashes as the same record', async () => {
    const { repository, service } = start();
    const undashed = pageId(1).replace(/-/g, '');
    await Promise.all([
      service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown }),
      service.submitAction({ pageId: undashed, action: 'remember', expected: shown }),
    ]);
    expect(repository.updates).toHaveLength(1);
  });

  it('refuses to write over a change made elsewhere and reports the current state', async () => {
    const { repository, service } = start();
    repository.editElsewhere(pageId(1), { mastery: 7 });
    await expect(
      service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      options: { body: { current: { mastery: 7, nextReview: '2026-10-01' } } },
    });
    expect(repository.updates).toEqual([]);
  });

  it('refuses to grade a card that is no longer due', async () => {
    const future = { mastery: 3, nextReview: '2026-11-01' };
    const { repository, service } = setup([record(1, future)]);
    await expect(
      service.submitAction({ pageId: pageId(1), action: 'remember', expected: future }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(repository.updates).toEqual([]);
  });

  it('refuses to grade a mastered card', async () => {
    const mastered = { mastery: 10, nextReview: '2026-10-01' };
    const { repository, service } = setup([record(1, mastered)]);
    await expect(
      service.submitAction({ pageId: pageId(1), action: 'remember', expected: mastered }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repository.updates).toEqual([]);
  });

  it('rejects a record that is not in the vocabulary database', async () => {
    const { repository, service } = start();
    await expect(
      service.submitAction({ pageId: pageId(99), action: 'remember', expected: shown }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(repository.updates).toEqual([]);
  });

  it('is a dry run when writes are off: reports the would-be state, writes nothing', async () => {
    const { repository, service } = setup([record(1, shown)], { writesRequested: false });
    const result = await service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown });
    expect(result).toEqual({ outcome: 'dry_run', state: { mastery: 4, nextReview: '2026-10-13' } });
    expect(repository.updates).toEqual([]);
  });

  it('is a dry run with no computed state while the rules are unconfirmed', async () => {
    const { repository, service } = setup([record(1, shown)], { rules: unconfirmedRules });
    for (const action of ['remember', 'not_remember'] as const) {
      await expect(service.submitAction({ pageId: pageId(1), action, expected: shown })).resolves.toEqual({
        outcome: 'dry_run',
        state: null,
      });
    }
    expect(repository.updates).toEqual([]);
  });

  it('fails when the store does not echo back the values that were written', async () => {
    const { repository, service } = start();
    repository.afterUpdate = (updated) => ({ ...updated, mastery: 3 });
    await expect(
      service.submitAction({ pageId: pageId(1), action: 'remember', expected: shown }),
    ).rejects.toMatchObject({ status: 502, code: 'unconfirmed_write' });
  });

  it('explains why an unchanged card can no longer be reviewed', async () => {
    const mastered = { mastery: 10, nextReview: '2026-10-01' };
    const { service } = setup([record(1, mastered)]);
    await expect(
      service.submitAction({ pageId: pageId(1), action: 'remember', expected: mastered }),
    ).rejects.toMatchObject({ message: expect.stringContaining('full mastery') });
  });

  it('refuses a card whose mastery the schedule cannot use', async () => {
    const odd = { mastery: 2.5, nextReview: '2026-10-01' };
    const { repository, service } = setup([record(1, odd)]);
    await expect(
      service.submitAction({ pageId: pageId(1), action: 'remember', expected: odd }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('whole number') });
    expect(repository.updates).toEqual([]);
  });

  it('propagates a failed write so the caller can retry safely', async () => {
    const { repository, service } = start();
    const request = { pageId: pageId(1), action: 'remember' as const, expected: shown };
    const realUpdate = repository.updateReviewState.bind(repository);
    let failures = 1;
    repository.updateReviewState = async (id, changes) => {
      if (failures-- > 0) throw new Error('network down');
      return realUpdate(id, changes);
    };
    await expect(service.submitAction(request)).rejects.toThrow('network down');
    // Nothing was written, so the retry applies the answer exactly once.
    await expect(service.submitAction(request)).resolves.toMatchObject({ outcome: 'applied' });
    expect(repository.updates).toHaveLength(1);
  });
});

/** A service with FSRS running beside the mastery schedule, keeping the FSRS write each answer made. */
function setupFsrs(records: VocabularyRecord[]) {
  const { repository, service } = setup(records, {
    fsrs: { settings: DEFAULT_FSRS_SETTINGS, ratingMap: fsrsRatingMap },
  });
  Object.assign(repository, { capabilities: { ...NO_CAPABILITIES, fsrs: true } });
  const writes: Array<FsrsWrite | null> = [];
  const save = repository.applyReview.bind(repository);
  repository.applyReview = async (write) => {
    writes.push(write.fsrs ?? null);
    return save(write);
  };
  return { service, writes };
}

describe('the FSRS rating an answer is given', () => {
  const shown = { mastery: 3, nextReview: '2026-10-01' };

  it('rates Remember with low confidence (a guess) as Hard, so the word comes back sooner', async () => {
    const { service, writes } = setupFsrs([record(1, shown)]);
    const result = await service.submitAction({
      pageId: pageId(1),
      action: 'remember',
      expected: shown,
      confidence: 1,
    });
    // Confidence never touches the mastery schedule: Remember writes exactly what it always did.
    expect(result).toEqual({ outcome: 'applied', state: { mastery: 4, nextReview: '2026-10-13' } });
    expect(writes[0]).toMatchObject({ rating: FSRS_RATINGS.hard });
    expect(writes[0]?.after).toEqual(fsrsReview(null, FSRS_RATINGS.hard, NOW));
    expect(writes[0]?.after).not.toEqual(fsrsReview(null, FSRS_RATINGS.good, NOW));
  });

  it('rates Remember at Good without a confidence and at medium or high', async () => {
    for (const confidence of [undefined, 2, 3] as const) {
      const { service, writes } = setupFsrs([record(1, shown)]);
      await service.submitAction({
        pageId: pageId(1),
        action: 'remember',
        expected: shown,
        ...(confidence === undefined ? {} : { confidence }),
      });
      expect(writes[0]).toMatchObject({ rating: FSRS_RATINGS.good });
      expect(writes[0]?.after).toEqual(fsrsReview(null, FSRS_RATINGS.good, NOW));
    }
  });

  it('rates Not remember as Again even with low confidence: a misspoken confidence never softens a lapse', async () => {
    const { service, writes } = setupFsrs([record(1, shown)]);
    const result = await service.submitAction({
      pageId: pageId(1),
      action: 'not_remember',
      expected: shown,
      confidence: 1,
    });
    expect(result).toEqual({ outcome: 'applied', state: { mastery: 3, nextReview: '2026-10-10' } });
    expect(writes[0]).toMatchObject({ rating: FSRS_RATINGS.again });
    expect(writes[0]?.after).toEqual(fsrsReview(null, FSRS_RATINGS.again, NOW));
  });
});

describe('getQueue: why an empty queue is empty', () => {
  it('says words are still in progress when none happens to be due', async () => {
    const { service } = setup([record(1, { nextReview: '2026-11-01' })]);
    expect(await service.getQueue()).toMatchObject({ cards: [], vocabulary: 'in_progress' });
  });

  it('says every word is mastered only when that is true', async () => {
    const { service } = setup([record(1, { mastery: 10 }), record(2, { mastery: 10 })]);
    expect(await service.getQueue()).toMatchObject({ cards: [], vocabulary: 'all_mastered' });
  });

  it('says the collection is empty when it has no words', async () => {
    const { service } = setup([]);
    expect(await service.getQueue()).toMatchObject({ cards: [], vocabulary: 'empty' });
  });

  it('does not ask when there are cards to review', async () => {
    const { repository, service } = setup([record(1)]);
    repository.vocabularyStatus = async () => {
      throw new Error('should not be called');
    };
    expect((await service.getQueue()).vocabulary).toBe('in_progress');
  });

  it('lists a word whose mastery is not a whole number instead of queueing it', async () => {
    const { service } = setup([record(1), record(2, { mastery: 3.5 })]);
    const queue = await service.getQueue();
    expect(queue.cards.map((item) => item.id)).toEqual([pageId(1)]);
    expect(queue.skipped).toEqual([
      { id: pageId(2), word: 'word-2', reason: 'Mastery is not a whole number from 0 to 10.' },
    ]);
  });
});
