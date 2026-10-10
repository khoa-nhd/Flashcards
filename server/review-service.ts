import {
  normalizeId,
  type CardField,
  type QueueResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type ReviewCard,
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
  type ReviewRules,
  type ReviewState,
} from '../shared/review-logic.js';
import type { CardFieldConfig, VocabularyRecord } from '../shared/vocabulary.js';
import { HttpError } from './errors.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { VocabularyRepository } from './vocabulary-repository.js';

export interface ReviewServiceOptions {
  repository: VocabularyRepository;
  rules: ReviewRules;
  cardFields: readonly CardFieldConfig[];
  timeZone: string;
  /** The owner switched writes on. Unconfirmed rules or a read-only schema still veto them. */
  writesRequested: boolean;
  now?: () => Date;
}

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

  async getQueue(): Promise<QueueResponse> {
    const { repository, rules, timeZone } = this.options;
    const setup = await repository.checkSetup();
    if (setup.readIssues.length > 0) {
      throw new HttpError(503, 'setup_incomplete', setup.readIssues.join(' '));
    }

    const today = this.today();
    const { records, invalid } = await repository.listDueCandidates(today);
    const { queue, excluded } = buildQueue(records, today, rules);

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
      skipped,
      // Only worth asking when there is nothing to review.
      vocabulary: queue.length > 0 ? 'in_progress' : await repository.vocabularyStatus(),
    };
  }

  /**
   * Applies one review decision. The browser's `expected` state is only a
   * precondition; every value written comes from a fresh read of the record,
   * and is written as an absolute value (never "+1"), so a repeated request
   * can at worst rewrite what is already there.
   */
  submitAction(request: ReviewActionRequest): Promise<ReviewActionResponse> {
    const pageId = normalizeId(request.pageId);
    return this.locks.run(pageId, () => this.applyDecision(pageId, request));
  }

  private async applyDecision(
    pageId: string,
    { action, expected }: ReviewActionRequest,
  ): Promise<ReviewActionResponse> {
    const { repository, rules } = this.options;
    const today = this.today();

    const record = await repository.getRecord(pageId);
    if (record === null) {
      throw new HttpError(404, 'not_found', 'That card is not in the vocabulary database.');
    }
    const current = this.stateOf(record);
    if (current === null) {
      throw new HttpError(409, 'invalid_record', 'This card has no mastery value, so it cannot be reviewed.');
    }

    const decision = reconcile(action, expected, current, today, rules);
    if (decision === 'already_applied') return { outcome: 'already_applied', state: current };
    if (decision === 'conflict') {
      throw new HttpError(
        409,
        'conflict',
        'This card was changed in Notion after it was loaded, so nothing was saved.',
        { body: { current } },
      );
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

    const changes: Partial<ReviewState> = {};
    if (next.mastery !== current.mastery) changes.mastery = next.mastery;
    if (next.nextReview !== current.nextReview) changes.nextReview = next.nextReview;
    if (Object.keys(changes).length === 0) return { outcome: 'applied', state: current };

    const confirmed = this.stateOf(await repository.updateReviewState(pageId, changes));
    if (confirmed === null || !isSameState(confirmed, next)) {
      throw new HttpError(
        502,
        'unconfirmed_write',
        'Notion accepted the update but did not return the expected values. Check the card in Notion.',
      );
    }
    return { outcome: 'applied', state: confirmed };
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
