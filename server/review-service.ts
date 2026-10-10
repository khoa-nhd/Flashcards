import { randomUUID } from 'node:crypto';
import {
  normalizeId,
  type CardField,
  type QueueResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type ReviewCard,
  type ReviewUndoRequest,
  type ReviewUndoResponse,
  type SchedulerReport,
  type SessionSummary,
} from '../shared/api.js';
import { calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import {
  applyAction,
  areDetailsVisible,
  areWriteRulesConfirmed,
  buildQueue,
  checkEligibility,
  isSameState,
  reconcile,
  resolveMastery,
  ruleFor,
  type ReviewAction,
  type ReviewRules,
  type ReviewState,
} from '../shared/review-logic.js';
import { compareSchedules } from '../shared/scheduler/comparison.js';
import {
  DEFAULT_FSRS_SETTINGS,
  FSRS_ENGINE,
  FSRS_RATING_NAMES,
  fsrsReview,
  type FsrsSettings,
} from '../shared/scheduler/fsrs.js';
import { DEFAULT_RATING_MAP, ratingFor, type RatingMap } from '../shared/scheduler/rating-map.js';
import type { CardFieldConfig, VocabularyRecord } from '../shared/vocabulary.js';
import { HttpError } from './errors.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { FsrsWrite, VocabularyRepository } from './vocabulary-repository.js';

export interface ReviewServiceOptions {
  repository: VocabularyRepository;
  rules: ReviewRules;
  cardFields: readonly CardFieldConfig[];
  timeZone: string;
  /** The owner switched writes on. Unconfirmed rules or a read-only schema still veto them. */
  writesRequested: boolean;
  /**
   * When given, FSRS is calculated for every saved answer and stored beside
   * the schedule above, where the store can hold it. It decides nothing here.
   */
  fsrs?: { settings: FsrsSettings; ratingMap: RatingMap } | null;
  now?: () => Date;
}

/** An answer as the service takes it. Without a request id, one is made up for this attempt. */
export type ReviewSubmission = ReviewActionRequest;

export class ReviewService {
  private readonly locks = new KeyedMutex();
  private readonly now: () => Date;

  constructor(private readonly options: ReviewServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  private async writesEnabled(): Promise<boolean> {
    const { repository, rules, writesRequested } = this.options;
    if (!writesRequested || !areWriteRulesConfirmed(rules)) return false;
    return (await repository.checkSetup()).writeIssues.length === 0;
  }

  /**
   * The cards due now. With `focus`, only the due cards among the given ids,
   * in the order given: the queue is narrowed, never widened, so a focused
   * review still only moves words the schedule says are ready.
   */
  async getQueue(focus: { kind: 'weak'; ids: readonly string[] } | null = null): Promise<QueueResponse> {
    const { repository, rules, timeZone } = this.options;
    const setup = await repository.checkSetup();
    if (setup.readIssues.length > 0) {
      throw new HttpError(503, 'setup_incomplete', setup.readIssues.join(' '));
    }

    const today = this.today();
    const { records, invalid } = await repository.listDueCandidates(today);
    const built = buildQueue(records, today, rules);
    const { excluded } = built;
    let { queue } = built;
    if (focus !== null) {
      const rank = new Map(focus.ids.map((id, position) => [id, position]));
      queue = queue
        .filter((item) => rank.has(item.id))
        .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    }

    const skipped = [...invalid];
    for (const { record, reason } of excluded) {
      // Rule-based exclusions are normal. A mastery the schedule cannot use is a data gap worth surfacing.
      if (reason === 'missing_mastery') {
        skipped.push({ id: record.id, word: record.word, reason: 'Mastery is empty.' });
      } else if (reason === 'invalid_mastery') {
        skipped.push({ id: record.id, word: record.word, reason: 'Mastery is not a whole number from 0 to 10.' });
      }
    }

    return {
      cards: queue.map((record) => this.toCard(record)),
      today,
      timeZone,
      mode: repository.mode,
      writesEnabled: await this.writesEnabled(),
      capabilities: repository.capabilities,
      focus: focus?.kind ?? null,
      skipped,
      // Only worth asking when there is nothing to review. A narrowed queue being empty says nothing about the rest.
      vocabulary: queue.length > 0 || focus !== null ? 'in_progress' : await repository.vocabularyStatus(),
    };
  }

  /**
   * Applies one review decision. The browser's `expected` state is only a
   * precondition; every value written comes from a fresh read of the record,
   * and is written as an absolute value (never "+1"). Where the store records
   * answers, the request id makes a retried answer a no-op; elsewhere the
   * state comparison below does.
   */
  submitAction(request: ReviewSubmission): Promise<ReviewActionResponse> {
    const pageId = normalizeId(request.pageId);
    return this.locks.run(pageId, () => this.applyDecision(pageId, request));
  }

  private async applyDecision(pageId: string, request: ReviewSubmission): Promise<ReviewActionResponse> {
    const { action, expected } = request;
    const requestId = request.requestId ?? randomUUID();
    const { repository, rules } = this.options;
    const today = this.today();

    const record = await repository.getRecord(pageId);
    if (record === null) {
      throw new HttpError(404, 'not_found', 'That card is not in your vocabulary.');
    }
    const current = this.stateOf(record);
    if (current === null) {
      throw new HttpError(409, 'invalid_record', 'This card has no mastery value, so it cannot be reviewed.');
    }

    const conflict = (state: ReviewState) =>
      new HttpError(409, 'conflict', 'This card was changed after it was loaded, so nothing was saved.', {
        body: { current: state },
      });

    const decision = reconcile(action, expected, current, today, rules);
    if (decision === 'already_applied') return { outcome: 'already_applied', state: current };
    if (decision === 'conflict') {
      // The word may have moved on since this very answer was saved: ask by request id.
      const earlier = await repository.findReview(requestId);
      if (earlier !== null) return { outcome: 'already_applied', state: earlier };
      throw conflict(current);
    }
    // Unchanged since it was shown, but still not something that may be reviewed now.
    const eligibility = checkEligibility(current, today, rules);
    if (!eligibility.eligible) {
      const why: Record<typeof eligibility.reason, string> = {
        retired: 'This word has already reached full mastery',
        not_due: 'This word is not due for review yet',
        missing_due_date: 'This word has no review date',
        missing_mastery: 'This word has no mastery value',
        invalid_mastery: 'The mastery stored for this word is not a whole number from 0 to 10',
      };
      throw new HttpError(409, 'conflict', `${why[eligibility.reason]}, so nothing was saved.`, {
        body: { current },
      });
    }

    const next = ruleFor(action, rules) === null ? null : applyAction(action, current, today, rules);
    if (next === null || !(await this.writesEnabled())) return { outcome: 'dry_run', state: next };

    const result = await repository.applyReview({
      id: pageId,
      requestId,
      action,
      expected: current,
      next,
      reviewedOn: today,
      durationMs: request.durationMs ?? null,
      sessionId: request.sessionId ?? null,
      fsrs: this.shadowFsrs(record, action),
    });
    if (result.outcome === 'not_found') {
      throw new HttpError(404, 'not_found', 'That card is not in your vocabulary.');
    }
    // Another device answered between the read above and this write.
    if (result.outcome === 'conflict') throw conflict(result.state);
    if (result.outcome === 'undone') {
      throw new HttpError(409, 'conflict', 'That answer was taken back with Undo, so it was not saved again.', {
        body: { current: result.state },
      });
    }
    if (result.outcome === 'applied' && !isSameState(result.state, next)) {
      throw new HttpError(
        502,
        'unconfirmed_write',
        'The update was accepted but the stored values are not the expected ones. Check this word.',
      );
    }
    return { outcome: result.outcome, state: result.state };
  }

  /**
   * Takes back one saved answer. The store restores the state from before that
   * answer only if it is still the word's latest and the word has not changed
   * since, and keeps a record of the undo; nothing is deleted.
   */
  async undo(request: ReviewUndoRequest): Promise<ReviewUndoResponse> {
    if (!(await this.writesEnabled())) {
      throw new HttpError(403, 'read_only', 'Saving is switched off, so nothing was changed.');
    }
    const result = await this.options.repository.undoReview(request);
    switch (result.outcome) {
      case 'undone':
      case 'already_undone':
        return { outcome: result.outcome, pageId: result.id, state: result.state };
      case 'not_found':
        throw new HttpError(404, 'not_found', 'There is no saved answer to undo.');
      case 'not_latest':
        throw new HttpError(
          409,
          'conflict',
          'This card has been reviewed again since then, so that answer can no longer be undone.',
          { body: result.state === null ? {} : { current: result.state } },
        );
      case 'conflict':
        throw new HttpError(409, 'conflict', 'This card was changed after that answer, so it was left as it is.', {
          body: result.state === null ? {} : { current: result.state },
        });
      case 'unsupported':
        throw new HttpError(409, 'not_supported', 'Undo is not available yet: the database needs its latest update.');
    }
  }

  /**
   * What FSRS makes of this answer, computed beside the real schedule. A
   * failure here must never cost the user their review, so it is logged and
   * the answer is saved without an FSRS state.
   */
  private shadowFsrs(record: VocabularyRecord, action: ReviewAction): FsrsWrite | null {
    const { fsrs, repository } = this.options;
    if (fsrs == null || !repository.capabilities.fsrs) return null;
    try {
      const rating = ratingFor(action, fsrs.ratingMap);
      const before = record.fsrs ?? null;
      return {
        rating,
        engine: FSRS_ENGINE,
        before,
        after: fsrsReview(before?.state ?? null, rating, this.now(), fsrs.settings),
      };
    } catch (error) {
      console.error('FSRS calculation failed:', error instanceof Error ? error.message : 'unknown error');
      return null;
    }
  }

  /** The two schedules side by side. Reads only. */
  async schedulerReport(): Promise<SchedulerReport> {
    const { repository, rules, timeZone, fsrs } = this.options;
    const available = fsrs != null && repository.capabilities.fsrs;
    const today = this.today();
    const comparison = compareSchedules(available ? await repository.listSchedules() : [], today, timeZone, {
      retiredAtMastery: rules.retiredAtMastery,
    });
    const map = fsrs?.ratingMap ?? DEFAULT_RATING_MAP;
    return {
      active: 'mastery_v1',
      today,
      timeZone,
      fsrs: {
        available,
        engine: FSRS_ENGINE,
        requestRetention: fsrs?.settings.requestRetention ?? DEFAULT_FSRS_SETTINGS.requestRetention,
        ratings: { remember: FSRS_RATING_NAMES[map.remember], notRemember: FSRS_RATING_NAMES[map.not_remember] },
      },
      ...comparison,
    };
  }

  /** What a review session actually saved, from the store rather than from the browser's own count. */
  async sessionSummary(sessionId: string): Promise<SessionSummary> {
    const summary = await this.options.repository.sessionSummary(sessionId);
    if (summary === null) throw new HttpError(404, 'not_found', 'No answers were saved in that session.');
    return summary;
  }

  private stateOf(record: VocabularyRecord): ReviewState | null {
    const mastery = resolveMastery(record.mastery, this.options.rules);
    return mastery === null ? null : { mastery, nextReview: record.nextReview };
  }

  /** Shapes a record for the browser. Fields the mastery rule withholds are never included. */
  private toCard(record: VocabularyRecord): ReviewCard {
    const { rules, cardFields } = this.options;
    const mastery = resolveMastery(record.mastery, rules) ?? 0;
    const detailsVisible = areDetailsVisible(mastery, rules);
    const front: CardField[] = [];
    const back: CardField[] = [];
    let detailsHidden = false;

    for (const field of cardFields) {
      if (field.visibility === 'details' && !detailsVisible) {
        detailsHidden = true;
        continue;
      }
      const value = record.fields[field.key];
      if (value === null || value === undefined) continue;
      (field.side === 'front' ? front : back).push({ key: field.key, label: field.label, value });
    }

    return { id: record.id, word: record.word, mastery, nextReview: record.nextReview, front, back, detailsHidden };
  }
}
