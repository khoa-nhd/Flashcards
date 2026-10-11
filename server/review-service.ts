import { randomUUID } from 'node:crypto';
import {
  normalizeId,
  type CardField,
  type PracticeRequest,
  type PracticeResponse,
  type QueueResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type ReviewCard,
  type ReviewUndoRequest,
  type ReviewUndoResponse,
  type SchedulerReport,
  type SessionSummary,
  type SimulationResponse,
} from '../shared/api.js';
import { calendarDateInTimeZone, compareDates, type IsoDate } from '../shared/dates.js';
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
import { DEFAULT_SCHEDULER, dueDateUnder, type SchedulerId } from '../shared/scheduler/active.js';
import { compareSchedules } from '../shared/scheduler/comparison.js';
import {
  DEFAULT_FSRS_SETTINGS,
  FSRS_ENGINE,
  FSRS_RATING_NAMES,
  FSRS_RETENTION,
  fsrsRetrievability,
  fsrsReview,
  isValidRetention,
  type FsrsSettings,
} from '../shared/scheduler/fsrs.js';
import { DEFAULT_RATING_MAP, ratingFor, type RatingMap } from '../shared/scheduler/rating-map.js';
import { simulate } from '../shared/scheduler/simulation.js';
import { judge, type PracticeWord } from '../shared/study-modes.js';
import type { CardFieldConfig, VocabularyRecord } from '../shared/vocabulary.js';
import { HttpError } from './errors.js';
import { KeyedMutex } from './keyed-mutex.js';
import { MASTERY_ONLY, type SchedulerStore } from './scheduler-store.js';
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
   * the mastery schedule, where the store can hold it.
   */
  fsrs?: { settings: FsrsSettings; ratingMap: RatingMap } | null;
  /**
   * The account's choice of which schedule decides what is due. Without one
   * the mastery schedule is always in charge.
   */
  scheduler?: SchedulerStore;
  now?: () => Date;
}

/** A record on its way into the queue: judged by the date in charge, carrying the stored date for the card. */
type Candidate = VocabularyRecord & { storedReview: IsoDate | null };

/**
 * A way to narrow the queue. `weak` and `recent` name the words to keep
 * (`weak` also sets their order); the others are read off the review date.
 */
export type QueueFocus =
  | { kind: 'weak' | 'recent'; ids: readonly string[] }
  | { kind: 'overdue' | 'due_today' }
  /** The due words of one collection, in the usual order. */
  | { kind: 'collection'; ids: readonly string[]; collection: { id: string; name: string } };

/** An answer as the service takes it. Without a request id, one is made up for this attempt. */
export type ReviewSubmission = ReviewActionRequest;

export class ReviewService {
  private readonly locks = new KeyedMutex();
  private readonly now: () => Date;
  private readonly scheduler: SchedulerStore;

  constructor(private readonly options: ReviewServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? MASTERY_ONLY;
  }

  /** Whether FSRS is being calculated and stored at all, which it must be before it can be put in charge. */
  private fsrsRunning(): boolean {
    return this.options.fsrs != null && this.options.repository.capabilities.fsrs;
  }

  /** The schedule in charge right now. FSRS only where it is actually running; otherwise the mastery schedule. */
  private activeScheduler(): SchedulerId {
    return this.scheduler.get() === 'fsrs' && this.fsrsRunning() ? 'fsrs' : DEFAULT_SCHEDULER;
  }

  /** The day a word is next due under `scheduler`. */
  private dueDate(record: VocabularyRecord, scheduler: SchedulerId): IsoDate | null {
    return dueDateUnder(
      scheduler,
      { reviewDate: record.nextReview, fsrsDue: record.fsrs?.state.due ?? null },
      this.options.timeZone,
    );
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
   * The cards due now. A `focus` keeps only some of them: the queue is
   * narrowed, never widened, so a focused review still only moves words the
   * schedule says are ready.
   */
  async getQueue(focus: QueueFocus | null = null): Promise<QueueResponse> {
    const { repository, rules, timeZone } = this.options;
    const setup = await repository.checkSetup();
    if (setup.readIssues.length > 0) {
      throw new HttpError(503, 'setup_incomplete', setup.readIssues.join(' '));
    }

    const today = this.today();
    const scheduler = this.activeScheduler();
    // The mastery date narrows the read only while it is what decides; otherwise every live word is a candidate.
    const { records, invalid } =
      scheduler === 'fsrs' ? await repository.listLiveRecords() : await repository.listDueCandidates(today);
    const candidates: Candidate[] = records.map((record) => ({
      ...record,
      storedReview: record.nextReview,
      nextReview: this.dueDate(record, scheduler),
    }));
    const built = buildQueue(candidates, today, rules);
    const { excluded } = built;
    let { queue } = built;
    if (focus !== null) {
      if (!('ids' in focus)) {
        queue = queue.filter((item) =>
          focus.kind === 'due_today'
            ? item.nextReview === today
            : item.nextReview !== null && compareDates(item.nextReview, today) < 0,
        );
      } else {
        const rank = new Map(focus.ids.map((id, position) => [id, position]));
        queue = queue.filter((item) => rank.has(item.id));
        // Weakest first; any other selection keeps the usual order, most overdue first.
        if (focus.kind === 'weak') queue.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      }
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
      scheduler,
      focus: focus === null || focus.kind === 'collection' ? null : focus.kind,
      collection: focus?.kind === 'collection' ? focus.collection : null,
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

    // The mastery state is what the browser was shown and what it hands back, whichever schedule
    // is in charge: every answer changes it, so it guards both schedules against a stale write.
    const decision = reconcile(action, expected, current, today, rules);
    if (decision === 'already_applied') return { outcome: 'already_applied', state: current };
    if (decision === 'conflict') {
      // The word may have moved on since this very answer was saved: ask by request id.
      const earlier = await repository.findReview(requestId);
      if (earlier !== null) return { outcome: 'already_applied', state: earlier };
      throw conflict(current);
    }
    // Unchanged since it was shown, but still not something that may be reviewed now.
    // Whether it is due is the one thing the schedule in charge decides.
    const scheduler = this.activeScheduler();
    const eligibility = checkEligibility(
      { mastery: current.mastery, nextReview: this.dueDate(record, scheduler) },
      today,
      rules,
    );
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

    const fsrs = this.fsrsFor(record, action);
    // Beside the mastery schedule a failed FSRS calculation costs nothing. In charge, saving
    // without it would leave the word exactly where it was, so the answer is refused instead.
    if (scheduler === 'fsrs' && fsrs === null) {
      throw new HttpError(500, 'scheduler_failed', 'The next review could not be worked out, so nothing was saved. Try again.');
    }

    const result = await repository.applyReview({
      id: pageId,
      requestId,
      action,
      expected: current,
      next,
      reviewedOn: today,
      durationMs: request.durationMs ?? null,
      sessionId: request.sessionId ?? null,
      fsrs,
      confidence: request.confidence ?? null,
      scheduler,
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
   * Judges and records one practice answer. Practice is judged from the
   * server's own copy of the word, and recording it never changes the word's
   * mastery, review date or FSRS state: only `submitAction` does that.
   */
  async submitPractice(request: PracticeRequest): Promise<PracticeResponse> {
    const { repository } = this.options;
    const pageId = normalizeId(request.pageId);
    const record = await repository.getRecord(pageId);
    if (record === null) throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');

    const word: PracticeWord = {
      id: record.id,
      word: record.word,
      meaning: record.fields.meaning ?? null,
      definition: record.fields.definition ?? null,
      example: record.fields.example ?? null,
    };
    const answer =
      request.answer.kind === 'choice'
        ? { kind: 'choice' as const, selectedId: normalizeId(request.answer.selectedId) }
        : request.answer;
    const judged = judge(request.mode, word, answer);
    if (judged === null) {
      throw new HttpError(
        400,
        'invalid_request',
        'That answer does not fit this study mode, or this word cannot be used in it as it stands.',
      );
    }
    const result = { correct: judged.correct, typed: judged.typed, expected: judged.expected };

    // Judged either way; recorded only where saving is on and the store can hold it.
    if (!repository.capabilities.practice || !(await this.writesEnabled())) return { outcome: 'dry_run', ...result };
    const outcome = await repository.recordPractice({
      id: pageId,
      requestId: request.requestId,
      sessionId: request.sessionId ?? null,
      mode: request.mode,
      correct: judged.correct,
      grading: judged.grading,
      submitted: judged.submitted,
      reviewedOn: this.today(),
      durationMs: request.durationMs ?? null,
      confidence: request.confidence ?? null,
    });
    if (outcome === 'not_found') throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
    return { outcome: outcome === 'unsupported' ? 'dry_run' : outcome, ...result };
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
   * What FSRS makes of this answer, computed beside the mastery schedule.
   * A failure is logged and reported as `null`; what that means for the answer
   * is the caller's decision.
   */
  private fsrsFor(record: VocabularyRecord, action: ReviewAction): FsrsWrite | null {
    const { fsrs } = this.options;
    if (fsrs == null || !this.fsrsRunning()) return null;
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

  /** The two schedules side by side, and which is in charge. Reads only. */
  async schedulerReport(): Promise<SchedulerReport> {
    const { repository, rules, timeZone, fsrs } = this.options;
    const available = this.fsrsRunning();
    const today = this.today();
    const now = this.now();
    const schedules = available ? await repository.listSchedules() : [];
    const comparison = compareSchedules(schedules, today, timeZone, { retiredAtMastery: rules.retiredAtMastery });
    const states = new Map(schedules.map((card) => [card.id, card.fsrs]));
    const settings = fsrs?.settings ?? DEFAULT_FSRS_SETTINGS;
    const map = fsrs?.ratingMap ?? DEFAULT_RATING_MAP;
    return {
      active: this.activeScheduler(),
      switchable: available && this.scheduler.available,
      today,
      timeZone,
      fsrs: {
        available,
        engine: FSRS_ENGINE,
        requestRetention: settings.requestRetention,
        ratings: { remember: FSRS_RATING_NAMES[map.remember], notRemember: FSRS_RATING_NAMES[map.not_remember] },
      },
      ...comparison,
      // FSRS's own estimate for each word, or nothing where it has too little to go on.
      cards: comparison.cards.map((card) => ({
        ...card,
        recall: fsrsRetrievability(states.get(card.id) ?? null, now, settings),
      })),
    };
  }

  /**
   * Puts one schedule in charge of what is due. Nothing is converted: both
   * schedules are kept up to date by every answer, so the other one is simply
   * read from now on, and choosing again reads the first one back.
   */
  async chooseScheduler(next: SchedulerId): Promise<SchedulerReport> {
    if (!this.scheduler.available) {
      throw new HttpError(409, 'not_supported', 'The schedule cannot be changed yet: the database needs its latest update.');
    }
    if (next === 'fsrs' && !this.fsrsRunning()) {
      throw new HttpError(409, 'not_supported', 'FSRS is not being calculated yet: the database needs its latest update.');
    }
    if (next !== this.scheduler.get()) await this.scheduler.save(next);
    return this.schedulerReport();
  }

  /**
   * A what-if comparison at a target retention, from the live mastery schedule
   * and the answers actually saved. Reads only: nothing is stored and no due
   * date moves.
   */
  async simulation(retention?: number): Promise<SimulationResponse> {
    const { repository, rules, timeZone, fsrs } = this.options;
    const target = retention ?? fsrs?.settings.requestRetention ?? DEFAULT_FSRS_SETTINGS.requestRetention;
    if (!isValidRetention(target)) {
      throw new HttpError(
        400,
        'invalid_request',
        `The target retention must be between ${FSRS_RETENTION.min} and ${FSRS_RETENTION.max}.`,
      );
    }
    const available = fsrs != null;
    const [words, events] = available
      ? await Promise.all([repository.listSchedules(), repository.listHistory()])
      : [[], []];
    return {
      available,
      timeZone,
      ...simulate(words, events, {
        rules,
        ratingMap: fsrs?.ratingMap ?? DEFAULT_RATING_MAP,
        settings: { requestRetention: target },
        now: this.now(),
        timeZone,
      }),
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

  /**
   * Shapes a record for the browser. Fields the mastery rule withholds are
   * never included. The card carries the stored mastery date, which comes back
   * with the answer; where another date decided it is due, that goes beside it.
   */
  private toCard(record: Candidate): ReviewCard {
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

    return {
      id: record.id,
      word: record.word,
      mastery,
      nextReview: record.storedReview,
      ...(record.nextReview !== null && record.nextReview !== record.storedReview ? { dueOn: record.nextReview } : {}),
      front,
      back,
      detailsHidden,
    };
  }
}
