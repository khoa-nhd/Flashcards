import { randomUUID } from 'node:crypto';
import {
  normalizeId,
  type CardField,
  type PracticeMasteryResponse,
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
  type PracticeHistoryRow,
} from '../shared/api.js';
import { calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import {
  applyAction,
  areDetailsVisible,
  areWriteRulesConfirmed,
  buildFsrsQueue,
  buildQueue,
  checkEligibility,
  checkFsrsEligibility,
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
  fsrsDueDay,
  fsrsRetrievability,
  fsrsReview,
  isValidRetention,
  type FsrsSettings,
  type FsrsState,
} from '../shared/scheduler/fsrs.js';
import { DEFAULT_RATING_MAP, ratingFor, type RatingMap } from '../shared/scheduler/rating-map.js';
import { isDetailCollapsed, memoryStrength, strengthLevelOf } from '../shared/scheduler/strength.js';
import { simulate } from '../shared/scheduler/simulation.js';
import { PRACTICE_MASTERY_MAX, STUDY_MODES, judge, practiceMasteryOf, type PracticeWord } from '../shared/study-modes.js';
import type { CardFieldConfig, StoredFsrs, VocabularyRecord } from '../shared/vocabulary.js';
import type { WeakRecoveryView } from '../shared/api.js';
import { HttpError } from './errors.js';
import { KeyedMutex } from './keyed-mutex.js';
import { MASTERY_ONLY, type SchedulerStore } from './scheduler-store.js';
import type { FsrsCardState, FsrsWrite, VocabularyRepository } from './vocabulary-repository.js';

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

/** How far ahead of the server's own clock an answer's stated instant may be. */
const ANSWER_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
/** How old an answer may be. Older than this it is refused rather than dated to an ancient day. */
const ANSWER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A way to narrow the queue to words named from outside. `weak` arrives
 * weakest-first; a `selection` arrives in the order the reviewer ticked the
 * words. Both are read as a set and both may bring a word forward before it is
 * due, since only the ids decide what belongs in the queue.
 */
export type QueueFocus =
  | { kind: 'weak'; ids: readonly string[]; recovery?: ReadonlyMap<string, WeakRecoveryView> }
  | { kind: 'selection'; ids: readonly string[] };

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

  /** Whether FSRS is being calculated and stored at all. */
  private fsrsRunning(): boolean {
    return this.options.fsrs != null && this.options.repository.capabilities.fsrs;
  }

  /**
   * FSRS is the only schedule once the store is at schema version 15. Before
   * that, mastery is what the store writes, whichever schedule the account
   * reads its due days from, so nothing here may treat FSRS as the only one.
   */
  private fsrsMode(): boolean {
    return this.fsrsRunning() && this.options.repository.capabilities.fsrsOnly === true;
  }

  /**
   * The schedule in charge right now: FSRS alone from version 15; before that,
   * FSRS where the account chose it and it is actually running, otherwise mastery.
   */
  private activeScheduler(): SchedulerId {
    if (this.fsrsMode()) return 'fsrs';
    return this.scheduler.get() === 'fsrs' && this.fsrsRunning() ? 'fsrs' : DEFAULT_SCHEDULER;
  }

  /** The day a word is next due under `scheduler`. */
  private dueDate(record: VocabularyRecord, scheduler: SchedulerId): IsoDate | null {
    if (scheduler === 'fsrs' && this.fsrsMode()) {
      const state = record.fsrs?.state ?? null;
      if (state !== null) return fsrsDueDay(state, this.options.timeZone);
      // A word FSRS has not seen comes up on its fallback day; with none at all it is new and due now.
      return record.dueOn ?? record.nextReview ?? this.today();
    }
    return dueDateUnder(
      scheduler,
      { reviewDate: record.nextReview, fsrsDue: record.fsrs?.state.due ?? null },
      this.options.timeZone,
    );
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  /**
   * The instant an answer was given. Without `answeredAt` that is now; with it,
   * the browser's clock has to be close enough to the server's to be believed:
   * an answer from the future or from more than a month ago is refused rather
   * than filed under a misleading day. This is what makes an answer given
   * offline land on the day it was answered, not the day it synced.
   */
  private answeredInstant(answeredAt: string | undefined): Date {
    if (answeredAt === undefined) return this.now();
    const instant = new Date(answeredAt);
    const time = instant.getTime();
    if (!Number.isFinite(time)) {
      throw new HttpError(400, 'invalid_request', 'The answer carried a timestamp the server could not read.');
    }
    const now = this.now().getTime();
    if (time > now + ANSWER_CLOCK_SKEW_MS) {
      throw new HttpError(400, 'invalid_request', 'The answer is dated in the future, so nothing was saved.');
    }
    if (time < now - ANSWER_MAX_AGE_MS) {
      throw new HttpError(400, 'invalid_request', 'The answer is more than a month old, so nothing was saved.');
    }
    return instant;
  }

  private async writesEnabled(): Promise<boolean> {
    const { repository, rules, writesRequested } = this.options;
    if (!writesRequested) return false;
    if (!this.fsrsMode() && !areWriteRulesConfirmed(rules)) return false;
    return (await repository.checkSetup()).writeIssues.length === 0;
  }

  /**
   * The cards to review. A `focus` keeps only the words it names; a queue with
   * no focus holds everything the schedule says is ready.
   */
  async getQueue(focus: QueueFocus | null = null): Promise<QueueResponse> {
    const { repository, rules, timeZone } = this.options;
    const setup = await repository.checkSetup();
    if (setup.readIssues.length > 0) {
      throw new HttpError(503, 'setup_incomplete', setup.readIssues.join(' '));
    }

    if (this.fsrsMode()) return this.getFsrsQueue(focus);

    const today = this.today();
    const scheduler = this.activeScheduler();
    // A narrowed queue names its own words, so the review date cannot decide which are candidates:
    // both narrowings may bring a word forward before it is due.
    const narrowed = focus !== null;
    const { records, invalid } =
      scheduler === 'fsrs' || narrowed ? await repository.listLiveRecords() : await repository.listDueCandidates(today);
    const candidates: Candidate[] = records.map((record) => ({
      ...record,
      storedReview: record.nextReview,
      nextReview: this.dueDate(record, scheduler),
    }));
    const built = buildQueue(candidates, today, rules, { allowNotDue: narrowed });
    const { excluded } = built;
    let { queue } = built;
    if (focus !== null) {
      // The order the ids arrive in is the order to review them in: weakest first for a weak
      // review, and the order the reviewer ticked them in for their own picked words.
      const rank = new Map(focus.ids.map((id, position) => [id, position]));
      queue = queue.filter((item) => rank.has(item.id));
      queue.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
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
      cards: queue.map((record) => {
        const card = this.toCard(record);
        const recovery = focus?.kind === 'weak' ? focus.recovery?.get(card.id) : undefined;
        return recovery === undefined
          ? card
          : {
              ...card,
              recovery: {
                points: recovery.points,
                threshold: recovery.threshold,
                recovered: recovery.recovered,
                lastRememberedOn: recovery.lastRememberedOn,
              },
            };
      }),
      today,
      timeZone,
      mode: repository.mode,
      writesEnabled: await this.writesEnabled(),
      capabilities: repository.capabilities,
      scheduler,
      fsrsOnly: false,
      focus: focus?.kind === 'weak' ? 'weak' : null,
      selection: focus?.kind === 'selection',
      skipped,
      // Only worth asking when there is nothing to review. A narrowed queue being empty says nothing about the rest.
      vocabulary: queue.length > 0 || focus !== null ? 'in_progress' : await repository.vocabularyStatus(),
    };
  }

  /**
   * The FSRS-only queue: every live, non-archived word whose due day is today
   * or earlier, earliest first. A narrowed queue may take words early.
   */
  private async getFsrsQueue(focus: QueueFocus | null): Promise<QueueResponse> {
    const { repository, timeZone } = this.options;
    const today = this.today();
    const { records, invalid } = await repository.listLiveRecords();
    const candidates = records.map((record) => ({
      ...record,
      storedReview: record.nextReview,
      dueOn: this.dueDate(record, 'fsrs'),
    }));
    const built = buildFsrsQueue(candidates, today, { allowNotDue: focus !== null });
    let { queue } = built;
    if (focus !== null) {
      const rank = new Map(focus.ids.map((id, position) => [id, position]));
      queue = queue.filter((item) => rank.has(item.id));
      queue.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    }

    const skipped = [...invalid];
    for (const { record, reason } of built.excluded) {
      if (reason === 'missing_due_date') {
        skipped.push({ id: record.id, word: record.word, reason: 'This word has no due date.' });
      } else if (reason === 'suspended') {
        skipped.push({ id: record.id, word: record.word, reason: 'This word is archived.' });
      }
    }

    const live = records.filter((record) => record.suspended !== true).length;
    return {
      cards: queue.map((record) => {
        const card = this.toCard(record);
        const recovery = focus?.kind === 'weak' ? focus.recovery?.get(card.id) : undefined;
        return recovery === undefined
          ? card
          : {
              ...card,
              recovery: {
                points: recovery.points,
                threshold: recovery.threshold,
                recovered: recovery.recovered,
                lastRememberedOn: recovery.lastRememberedOn,
              },
            };
      }),
      today,
      timeZone,
      mode: repository.mode,
      writesEnabled: await this.writesEnabled(),
      capabilities: repository.capabilities,
      scheduler: 'fsrs',
      fsrsOnly: true,
      focus: focus?.kind === 'weak' ? 'weak' : null,
      selection: focus?.kind === 'selection',
      skipped,
      vocabulary: queue.length > 0 || focus !== null ? 'in_progress' : live > 0 ? 'in_progress' : 'empty',
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
    return this.locks.run(pageId, () =>
      this.fsrsMode() ? this.applyFsrsDecision(pageId, request) : this.applyDecision(pageId, request),
    );
  }

  /**
   * An answer under FSRS alone. FSRS works the new state out here; the store
   * saves it only while the card is still at the revision the reviewer saw,
   * and recognises a repeated request id. Mastery and the review date are no
   * longer written.
   */
  private async applyFsrsDecision(pageId: string, request: ReviewSubmission): Promise<ReviewActionResponse> {
    const { action } = request;
    const requestId = request.requestId ?? randomUUID();
    const { repository, timeZone, fsrs } = this.options;
    const apply = repository.applyFsrsReview;
    if (fsrs == null || apply === undefined) {
      throw new HttpError(500, 'scheduler_failed', 'FSRS is not available, so nothing was saved.');
    }
    const answeredAt = this.answeredInstant(request.answeredAt);
    const today = calendarDateInTimeZone(answeredAt, timeZone);

    const record = await repository.getRecord(pageId);
    if (record === null) throw new HttpError(404, 'not_found', 'That card is not in your vocabulary.');
    const current = this.fsrsStateOf(record);
    const refuse = (state: ReviewState | null, message: string) =>
      new HttpError(409, 'conflict', message, { body: state === null ? {} : { current: state } });
    const CHANGED = 'This card was changed after it was loaded, so nothing was saved.';

    // The revision the reviewer saw. A page from before revisions existed sends the day it was
    // shown instead, which stands for the current revision only while that day still matches.
    const expectedRevision =
      request.expectedRevision ?? (request.expected.nextReview === current.nextReview ? (current.revision ?? 0) : -1);

    // Whether the card may be answered now is only asked of the card the reviewer saw. A changed
    // card goes to the store anyway, which tells a repeat of a saved answer from a stale one.
    if (expectedRevision === current.revision) {
      const eligibility = checkFsrsEligibility(
        { id: record.id, dueOn: current.nextReview, suspended: record.suspended === true },
        today,
        { allowNotDue: request.allowNotDue === true },
      );
      if (!eligibility.eligible) {
        const why = {
          not_due: 'This word is not due for review yet',
          missing_due_date: 'This word has no due date',
          suspended: 'This word is archived',
        } as const;
        throw refuse(current, `${why[eligibility.reason]}, so nothing was saved.`);
      }
    }

    // The reviewer's own choice: an answer that does not count is recorded and moves nothing.
    const counts = request.countsTowardSchedule !== false && request.countsTowardMastery !== false;
    const rating = ratingFor(action, fsrs.ratingMap);
    let after: FsrsState | null = null;
    if (counts) {
      try {
        after = fsrsReview(record.fsrs?.state ?? null, rating, answeredAt, fsrs.settings);
      } catch (error) {
        console.error('FSRS calculation failed:', error instanceof Error ? error.message : 'unknown error');
        throw new HttpError(500, 'scheduler_failed', 'The next review could not be worked out, so nothing was saved. Try again.');
      }
    }
    if (!(await this.writesEnabled())) {
      const preview =
        after === null
          ? current
          : this.fsrsReviewState({ fsrs: { state: after, engine: FSRS_ENGINE }, dueOn: null, revision: (current.revision ?? 0) + 1 });
      return { outcome: 'dry_run', state: preview };
    }

    const result = await apply.call(repository, {
      id: pageId,
      requestId,
      action,
      expectedRevision,
      countsTowardSchedule: counts,
      rating,
      engine: after === null ? null : FSRS_ENGINE,
      after,
      reviewedOn: today,
      answeredAt: request.answeredAt ?? null,
      durationMs: request.durationMs ?? null,
      sessionId: request.sessionId ?? null,
      confidence: request.confidence ?? null,
    });
    switch (result.outcome) {
      case 'applied': {
        const saved = this.fsrsReviewState(result.state);
        // The store reports what it holds now; an answer that counted must have left exactly FSRS's result.
        if (after !== null && (saved.fsrs == null || Date.parse(saved.fsrs.due) !== Date.parse(after.due))) {
          throw new HttpError(
            502,
            'unconfirmed_write',
            'The update was accepted but the stored values are not the expected ones. Check this word.',
          );
        }
        return { outcome: 'applied', state: saved };
      }
      case 'already_applied':
        return { outcome: 'already_applied', state: this.fsrsReviewState(result.state) };
      case 'not_found':
        throw new HttpError(404, 'not_found', 'That card is not in your vocabulary.');
      case 'suspended':
        throw refuse(result.state === null ? null : this.fsrsReviewState(result.state, true), 'This word is archived, so nothing was saved.');
      case 'undone':
        throw refuse(
          result.state === null ? null : this.fsrsReviewState(result.state),
          'That answer was taken back with Undo, so it was not saved again.',
        );
      case 'conflict':
        throw refuse(result.state === null ? null : this.fsrsReviewState(result.state), CHANGED);
    }
  }

  /** Where a card stands under FSRS alone, as the browser is told. `mastery` is the strength level, for display only. */
  private fsrsReviewState(card: { fsrs: StoredFsrs | null; dueOn: IsoDate | null; revision: number }, suspended = false): ReviewState {
    const state = card.fsrs?.state ?? null;
    return {
      mastery: strengthLevelOf(state?.stability ?? null),
      nextReview: state !== null ? fsrsDueDay(state, this.options.timeZone) : (card.dueOn ?? this.today()),
      fsrs: state,
      ...(card.fsrs == null ? {} : { fsrsEngine: card.fsrs.engine }),
      dueOn: state === null ? card.dueOn : null,
      revision: card.revision,
      suspended,
    };
  }

  private fsrsStateOf(record: VocabularyRecord): ReviewState {
    return this.fsrsReviewState(
      { fsrs: record.fsrs ?? null, dueOn: record.dueOn ?? record.nextReview ?? null, revision: record.revision ?? 0 },
      record.suspended === true,
    );
  }

  private async applyDecision(pageId: string, request: ReviewSubmission): Promise<ReviewActionResponse> {
    const { action, expected } = request;
    const requestId = request.requestId ?? randomUUID();
    const { repository, rules, timeZone } = this.options;
    // The day the answer was given, which is the browser's day for an answer
    // made offline: everything below is worked out as of that day.
    const answeredAt = this.answeredInstant(request.answeredAt);
    const today = calendarDateInTimeZone(answeredAt, timeZone);

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
    // Whether it is due is the one thing the schedule in charge decides, except where the answer
    // came from a review that names its own words, which may take one early.
    const scheduler = this.activeScheduler();
    const eligibility = checkEligibility(
      { mastery: current.mastery, nextReview: this.dueDate(record, scheduler) },
      today,
      rules,
      { allowNotDue: request.allowNotDue === true },
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

    // A review that does not count is extra practice: the answer is recorded, but the word does
    // not move. The owner's rule (2026-10-17): the reviewer chooses this, and while it is off
    // mastery, the review date and the FSRS state all stay as they are, for either answer. It is
    // saved as an answer whose state after equals its state before, so Undo, statistics and the
    // request-id guard against saving twice work as for any answer.
    const practiceOnly = request.countsTowardMastery === false;
    const next =
      ruleFor(action, rules) === null ? null : practiceOnly ? { ...current } : applyAction(action, current, today, rules);
    if (next === null || !(await this.writesEnabled())) return { outcome: 'dry_run', state: next };

    const fsrs = practiceOnly ? this.unchangedFsrs(record, action) : this.fsrsFor(record, action, answeredAt);
    if (scheduler === 'fsrs' && fsrs === null) {
      // With FSRS in charge the store will not take an answer without an FSRS state, and a word FSRS
      // has never seen has none to keep. Giving it one would move it, so this answer is not recorded.
      if (practiceOnly) return { outcome: 'dry_run', state: next };
      // Beside the mastery schedule a failed FSRS calculation costs nothing. In charge, saving
      // without it would leave the word exactly where it was, so the answer is refused instead.
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
    if (!repository.capabilities.practice || !(await this.writesEnabled())) {
      return { outcome: 'dry_run', ...result, modeMastery: null };
    }
    const outcome = await repository.recordPractice({
      id: pageId,
      requestId: request.requestId,
      sessionId: request.sessionId ?? null,
      mode: request.mode,
      correct: judged.correct,
      grading: judged.grading,
      submitted: judged.submitted,
      reviewedOn: calendarDateInTimeZone(this.answeredInstant(request.answeredAt), this.options.timeZone),
      durationMs: request.durationMs ?? null,
      confidence: request.confidence ?? null,
    });
    if (outcome === 'not_found') throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
    if (outcome === 'unsupported') return { outcome: 'dry_run', ...result, modeMastery: null };
    // Counted from what is recorded, after recording: a repeated request finds its one answer and no more.
    const correct = (await repository.practiceCorrectCounts(pageId)).get(request.mode) ?? 0;
    return { outcome, ...result, modeMastery: practiceMasteryOf(correct) };
  }

  /**
   * One word's practice mastery in every mode: its correct practice answers
   * in that mode, counted up to the ceiling. Reads only, and has nothing to do
   * with when the word is due.
   */
  async practiceMastery(id: string): Promise<PracticeMasteryResponse> {
    const { repository } = this.options;
    const pageId = normalizeId(id);
    if ((await repository.getRecord(pageId)) === null) {
      throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
    }
    const available = repository.capabilities.practice;
    const counts = available ? await repository.practiceCorrectCounts(pageId) : new Map<string, number>();
    return {
      available,
      max: PRACTICE_MASTERY_MAX,
      // Every mode, so one that has not been tried reads as zero rather than as missing.
      modes: available
        ? STUDY_MODES.map((mode) => {
            const correct = counts.get(mode) ?? 0;
            return { mode, correct, mastery: practiceMasteryOf(correct) };
          })
        : [],
    };
  }

  /**
   * Practice history for True Mastery: detailed answers with correctness, timestamps, mode, grading, session.
   * Returns all practice answers for the current user, optionally filtered by date.
   */
  async practiceHistory(since: string | null): Promise<PracticeHistoryRow[]> {
    const { repository } = this.options;
    if (!repository.capabilities.practiceHistory) return [];
    const sinceDate = since ?? null;
    return repository.practiceHistory(sinceDate);
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
    const undoFsrs = this.options.repository.undoFsrsReview;
    if (this.fsrsMode() && undoFsrs !== undefined) {
      const result = await undoFsrs.call(this.options.repository, request);
      const shown = (state: FsrsCardState | null) => (state === null ? {} : { current: this.fsrsReviewState(state) });
      switch (result.outcome) {
        case 'undone':
        case 'already_undone':
          return { outcome: result.outcome, pageId: result.id, state: this.fsrsReviewState(result.state) };
        case 'not_found':
          throw new HttpError(404, 'not_found', 'There is no saved answer to undo.');
        case 'not_latest':
          throw new HttpError(
            409,
            'conflict',
            'This card has been reviewed again since then, so that answer can no longer be undone.',
            { body: shown(result.state) },
          );
        case 'conflict':
          throw new HttpError(409, 'conflict', 'This card was changed after that answer, so it was left as it is.', {
            body: shown(result.state),
          });
      }
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
  /** The FSRS part of an answer that leaves the word where it is: the state after is the state before. */
  private unchangedFsrs(record: VocabularyRecord, action: ReviewAction): FsrsWrite | null {
    const { fsrs } = this.options;
    const before = record.fsrs ?? null;
    if (fsrs == null || !this.fsrsRunning() || before === null) return null;
    return { rating: ratingFor(action, fsrs.ratingMap), engine: before.engine, before, after: before.state };
  }

  private fsrsFor(record: VocabularyRecord, action: ReviewAction, at: Date): FsrsWrite | null {
    const { fsrs } = this.options;
    if (fsrs == null || !this.fsrsRunning()) return null;
    try {
      const rating = ratingFor(action, fsrs.ratingMap);
      const before = record.fsrs ?? null;
      return {
        rating,
        engine: FSRS_ENGINE,
        before,
        after: fsrsReview(before?.state ?? null, rating, at, fsrs.settings),
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
    const strengthDistribution = Array.from({ length: 10 }, () => 0);
    if (this.fsrsMode()) {
      for (const card of schedules) {
        if (card.fsrs === null) continue;
        const index = strengthLevelOf(card.fsrs.stability) - 1;
        strengthDistribution[index] = (strengthDistribution[index] ?? 0) + 1;
      }
    }
    return {
      active: this.activeScheduler(),
      fsrsOnly: this.fsrsMode(),
      switchable: !this.fsrsMode() && available && this.scheduler.available,
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
      ...(this.fsrsMode() ? { strengthDistribution } : {}),
    };
  }

  /**
   * Puts one schedule in charge of what is due. Nothing is converted: both
   * schedules are kept up to date by every answer, so the other one is simply
   * read from now on, and choosing again reads the first one back.
   */
  async chooseScheduler(next: SchedulerId): Promise<SchedulerReport> {
    if (this.fsrsMode()) {
      throw new HttpError(409, 'not_supported', 'FSRS is the only scheduler in this account.');
    }
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
    if (this.fsrsMode()) return this.fsrsStateOf(record);
    const mastery = resolveMastery(record.mastery, this.options.rules);
    return mastery === null ? null : { mastery, nextReview: record.nextReview };
  }

  /**
   * Shapes a word for the FSRS-only card. All content is sent; a high
   * strength level only tells the browser to start with details folded.
   */
  private toFsrsCard(record: Candidate): ReviewCard {
    const { cardFields } = this.options;
    const state = record.fsrs?.state ?? null;
    const settings = this.options.fsrs?.settings ?? DEFAULT_FSRS_SETTINGS;
    const memory = memoryStrength(state, {
      retrievability: fsrsRetrievability(state, this.now(), settings),
    });
    const front: CardField[] = [];
    const back: CardField[] = [];
    for (const field of cardFields) {
      const value = record.fields[field.key];
      if (value === null || value === undefined) continue;
      (field.side === 'front' ? front : back).push({ key: field.key, label: field.label, value });
    }
    return {
      id: record.id,
      word: record.word,
      mastery: memory.level,
      nextReview: record.dueOn ?? record.nextReview,
      dueOn: record.dueOn ?? undefined,
      memory,
      detailCollapsed: isDetailCollapsed(memory.level),
      revision: record.revision ?? 0,
      suspended: record.suspended === true,
      front,
      back,
      detailsHidden: false,
    };
  }

  /** Shapes a record for the browser in the legacy mastery path. */
  private toCard(record: Candidate): ReviewCard {
    if (this.fsrsMode()) return this.toFsrsCard(record);
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
      detailCollapsed: false,
      suspended: false,
    };
  }
}
