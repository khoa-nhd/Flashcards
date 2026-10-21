import {
  importItemSchema,
  normalizeId,
  type CreateEntryRequest,
  type ImportResponse,
  type UpdateEntryRequest,
  type VocabularyEntry,
  type VocabularyListResponse,
} from '../shared/api.js';
import { addDays, calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import type { ReviewRules } from '../shared/review-logic.js';
import { dueDateUnder, isScheduledByFsrs } from '../shared/scheduler/active.js';
import { fsrsDueDay } from '../shared/scheduler/fsrs.js';
import { memoryStrength } from '../shared/scheduler/strength.js';
import { normalizeWord } from '../shared/text.js';
import { TEXT_FIELD_KEYS, type NewWordDefaults } from '../shared/vocabulary.js';
import { classifyFsrsStatus, classifyReviewStatus, isFsrsReviewable, isReviewableNow } from '../shared/vocabulary-status.js';
import { HttpError } from './errors.js';
import { KeyedMutex } from './keyed-mutex.js';
import { MASTERY_ONLY, type SchedulerStore } from './scheduler-store.js';
import type { EntryChanges, EntryData, VocabularyCatalog } from './vocabulary-catalog.js';

export interface VocabularyServiceOptions {
  catalog: VocabularyCatalog;
  rules: ReviewRules;
  defaults: NewWordDefaults;
  timeZone: string;
  /** The owner allowed the app to change stored data. */
  writesRequested: boolean;
  /** Which schedule decides when a word is due. Without one, the mastery schedule. */
  scheduler?: SchedulerStore;
  /**
   * FSRS is the only schedule (the database is at schema version 15). Never
   * inferred from the old schedule choice: before version 15 mastery is still
   * what the store writes.
   */
  fsrsOnly?: boolean;
  now?: () => Date;
}

const RECENT_CREATE_TTL_MS = 10 * 60 * 1000;
const RECENT_CREATE_LIMIT = 200;

const emptyToNull = (text: string | undefined): string | null | undefined =>
  text === undefined ? undefined : text === '' ? null : text;

/**
 * Whole-record operations for the bank, dashboard, calendar and Add form.
 * Review answers do not come through here; they stay in ReviewService so the
 * scheduling rules live in exactly one place.
 */
export class VocabularyService {
  private readonly now: () => Date;
  private readonly locks = new KeyedMutex();
  /** Submissions already answered, so a repeated request returns the same record. */
  private readonly recentCreates = new Map<string, { entry: EntryData; at: number }>();
  private readonly scheduler: SchedulerStore;

  constructor(private readonly options: VocabularyServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? MASTERY_ONLY;
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  /** True when FSRS is the only scheduler for this account. */
  private fsrsMode(): boolean {
    return this.options.fsrsOnly === true;
  }

  /**
   * An entry as the reviewer sees it. In FSRS mode the due day comes from the
   * FSRS state, or from `dueOn` for a word FSRS has never seen. The mastery
   * values below are display mirrors only.
   */
  private decorate(entry: EntryData, today: IsoDate): VocabularyEntry {
    const { rules, timeZone } = this.options;
    // Internal scheduling values stay on the server; the browser gets the day and the strength.
    const { fsrs, dueOn, revision, suspended, ...stored } = entry;
    delete stored.fsrsDue;
    if (this.fsrsMode()) {
      const state = fsrs?.state ?? null;
      // A word FSRS has not seen comes up on its fallback day; with none at all it is new and due now.
      const dueDate = state !== null ? fsrsDueDay(state, timeZone) : (dueOn ?? entry.reviewDate ?? today);
      const memory = memoryStrength(state);
      const reviewStatus = classifyFsrsStatus(
        { dueOn: dueDate, hasFsrs: state !== null, suspended: suspended === true },
        today,
      );
      return {
        ...stored,
        mastery: memory.level,
        reviewDate: dueDate,
        dueDate,
        memory,
        suspended: suspended === true,
        revision: revision ?? 0,
        reviewStatus,
        reviewable: isFsrsReviewable(reviewStatus),
        scheduledBy: 'fsrs',
      };
    }

    const scheduler = this.scheduler.get();
    const reviewDate = dueDateUnder(scheduler, entry, timeZone);
    const reviewStatus = classifyReviewStatus({ mastery: entry.mastery, reviewDate }, today, rules);
    return {
      ...stored,
      revision: revision ?? 0,
      suspended: suspended === true,
      reviewDate,
      ...(isScheduledByFsrs(scheduler, entry) ? { scheduledBy: 'fsrs' as const } : {}),
      reviewStatus,
      reviewable: isReviewableNow(reviewStatus, rules),
    };
  }

  private async writesEnabled(): Promise<boolean> {
    if (!this.options.writesRequested) return false;
    const setup = await this.options.catalog.checkSetup();
    return setup.writeIssues.length === 0 && (setup.entryWriteIssues ?? []).length === 0;
  }

  private async requireWrites(): Promise<void> {
    if (!this.options.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
  }

  async list(): Promise<VocabularyListResponse> {
    const { catalog, timeZone, defaults } = this.options;
    const setup = await catalog.checkSetup();
    if (setup.readIssues.length > 0) {
      throw new HttpError(503, 'setup_incomplete', setup.readIssues.join(' '));
    }
    const today = this.today();
    const { entries, invalid } = await catalog.listEntries();
    return {
      entries: entries.map((entry) => this.decorate(entry, today)),
      today,
      timeZone,
      mode: catalog.mode,
      writesEnabled: await this.writesEnabled(),
      skipped: invalid,
      defaults,
    };
  }

  async get(id: string): Promise<VocabularyEntry> {
    const entry = await this.options.catalog.getEntry(normalizeId(id));
    if (entry === null) throw notFound();
    return this.decorate(entry, this.today());
  }

  /**
   * Creates one word. Three things guard against a second copy: a repeated
   * request id returns the record already made; requests for the same word
   * are handled one at a time; and an existing word with the same normalised
   * spelling is refused unless the caller explicitly allows the duplicate.
   * None of this is atomic across server instances, which is why the existing
   * entries are returned for the user to judge.
   */
  async create(request: CreateEntryRequest): Promise<{ entry: VocabularyEntry; created: boolean }> {
    await this.requireWrites();
    const { catalog, defaults } = this.options;

    return this.locks.run(`create:${normalizeWord(request.word)}`, async () => {
      const today = this.today();
      // A store that keeps request ids answers this across devices and restarts.
      const repeated =
        this.recallCreate(request.requestId) ?? (await catalog.findByRequestId?.(request.requestId)) ?? null;
      if (repeated !== null) return { entry: this.decorate(repeated, today), created: false };

      if (request.allowDuplicate !== true) {
        const existing = await catalog.findEntriesByWord(request.word);
        if (existing.length > 0) {
          throw new HttpError(409, 'duplicate', `"${existing[0]?.word ?? request.word}" is already in your vocabulary.`, {
            body: { duplicates: existing.map((entry) => this.decorate(entry, today)) },
          });
        }
      }

      const { entry, created } = await catalog.createEntry({
        requestId: request.requestId,
        word: request.word,
        meaning: emptyToNull(request.meaning) ?? null,
        definition: emptyToNull(request.definition) ?? null,
        example: emptyToNull(request.example) ?? null,
        dateAdded: request.dateAdded ?? today,
        // Under FSRS alone a new word is new: no mastery is taken from the request, and it first
        // comes up on the day asked for (a spread-out import) or today. The store copies that day
        // into its fallback due day.
        mastery: this.fsrsMode() ? defaults.mastery : (request.mastery ?? defaults.mastery),
        reviewDate: this.fsrsMode()
          ? (request.dueOn ?? today)
          : request.reviewDate !== undefined
            ? request.reviewDate
            : defaults.reviewDate === 'today'
              ? today
              : null,
        dueOn: this.fsrsMode() ? (request.dueOn ?? today) : undefined,
      });
      this.rememberCreate(request.requestId, entry);
      return { entry: this.decorate(entry, today), created };
    });
  }

  /**
   * Imports up to one request's worth of words, one at a time, each through
   * the same path as the Add form: the same validation, the same defaults for
   * a new word, the same duplicate check and the same request id that makes a
   * repeat harmless. Each item is judged on its own, so one bad row costs
   * only itself. If the store fails part-way, what was done so far is
   * reported with where it stopped; sending the same batch again finishes it
   * without creating anything twice.
   */
  async importBatch(items: readonly unknown[], wordsPerDay?: number): Promise<ImportResponse> {
    await this.requireWrites();
    const results: ImportResponse['results'] = [];
    const start = this.today();
    for (const [index, raw] of items.entries()) {
      const parsed = importItemSchema.safeParse(raw);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`).join('; ');
        results.push({ outcome: 'invalid', entry: null, message });
        continue;
      }
      try {
        const spreadDay =
          wordsPerDay === undefined ? undefined : addDays(start, Math.floor(index / wordsPerDay));
        const { entry, created } = await this.create(
          spreadDay === undefined ? parsed.data : { ...parsed.data, dueOn: spreadDay },
        );
        results.push({ outcome: created ? 'imported' : 'already_imported', entry, message: null });
      } catch (error) {
        if (error instanceof HttpError && error.code === 'duplicate') {
          results.push({ outcome: 'duplicate', entry: null, message: error.message });
        } else if (error instanceof HttpError && error.status === 400) {
          results.push({ outcome: 'invalid', entry: null, message: error.message });
        } else {
          // Not about this row: the store is in trouble. Stop here and say exactly how far it got.
          const message = error instanceof HttpError ? error.message : 'The database could not be reached.';
          return { results, stopped: { index, message } };
        }
      }
    }
    return { results, stopped: null };
  }

  /** Writes only the fields whose value actually differs from what is stored. */
  async update(id: string, request: UpdateEntryRequest): Promise<VocabularyEntry> {
    await this.requireWrites();
    const { catalog } = this.options;
    const pageId = normalizeId(id);

    return this.locks.run(`entry:${pageId}`, async () => {
      const today = this.today();
      const current = await catalog.getEntry(pageId);
      if (current === null) throw notFound();

      const changes: EntryChanges = {};
      if (request.word !== undefined && request.word !== current.word) changes.word = request.word;
      for (const key of TEXT_FIELD_KEYS) {
        const next = emptyToNull(request[key]);
        if (next !== undefined && next !== current[key]) changes[key] = next;
      }
      if (request.dateAdded !== undefined && request.dateAdded !== current.dateAdded) {
        changes.dateAdded = request.dateAdded;
      }
      if (request.schedule !== undefined && !this.fsrsMode()) {
        if (request.schedule.mastery !== current.mastery) changes.mastery = request.schedule.mastery;
        // Compared with the date the form was shown, which is the one under the schedule in charge.
        const scheduler = this.scheduler.get();
        if (request.schedule.reviewDate !== dueDateUnder(scheduler, current, this.options.timeZone)) {
          // A date typed in is a mastery date. FSRS works its own out from the answers; there is
          // no honest FSRS state to go with a date somebody picked.
          if (isScheduledByFsrs(scheduler, current)) {
            throw new HttpError(
              409,
              'not_editable',
              'FSRS sets this word’s review date from your answers, so it cannot be changed by hand.',
            );
          }
          changes.reviewDate = request.schedule.reviewDate;
        }
      }
      if (Object.keys(changes).length === 0) return this.decorate(current, today);

      if (changes.word !== undefined && request.allowDuplicate !== true) {
        const others = (await catalog.findEntriesByWord(changes.word)).filter((entry) => entry.id !== pageId);
        if (others.length > 0) {
          throw new HttpError(409, 'duplicate', `"${others[0]?.word ?? changes.word}" is already in your vocabulary.`, {
            body: { duplicates: others.map((entry) => this.decorate(entry, today)) },
          });
        }
      }

      return this.decorate(await catalog.updateEntry(pageId, changes), today);
    });
  }

  /**
   * Stored words that share this spelling, so a caller can check for an
   * existing word before writing. Read-only; it never changes anything.
   */
  async findEntriesByWord(word: string): Promise<EntryData[]> {
    return this.options.catalog.findEntriesByWord(word);
  }

  /** Words that were deleted and can still be restored, where the store can list them. */
  async listTrashed(): Promise<VocabularyEntry[]> {
    const today = this.today();
    return (await this.options.catalog.listTrashed()).map((entry) => this.decorate(entry, today));
  }

  /** Moves the word to the trash, from which it can be restored. */
  async trash(id: string): Promise<{ id: string; trashed: true }> {
    await this.requireWrites();
    const pageId = normalizeId(id);
    if (!(await this.options.catalog.trashEntry(pageId))) throw notFound();
    return { id: pageId, trashed: true };
  }

  async restore(id: string): Promise<VocabularyEntry> {
    await this.requireWrites();
    const entry = await this.options.catalog.restoreEntry(normalizeId(id));
    if (entry === null) throw notFound();
    return this.decorate(entry, this.today());
  }

  /**
   * Bulk archive or resume. Archived words stay in the Bank under the Archived
   * filter but leave the review queue and dashboard counts.
   */
  async setArchived(ids: readonly string[], archived: boolean): Promise<VocabularyEntry[]> {
    await this.requireWrites();
    const setSuspended = this.options.catalog.setEntriesSuspended;
    if (setSuspended === undefined) {
      throw new HttpError(409, 'not_supported', 'Archiving is not available yet: the database needs its latest update.');
    }
    const unique = [...new Set(ids.map((id) => normalizeId(id)))];
    const entries = await setSuspended.call(this.options.catalog, unique, archived);
    const today = this.today();
    return entries.map((entry) => this.decorate(entry, today));
  }

  private recallCreate(requestId: string): EntryData | null {
    const cutoff = this.now().getTime() - RECENT_CREATE_TTL_MS;
    for (const [key, value] of this.recentCreates) {
      if (value.at < cutoff) this.recentCreates.delete(key);
    }
    return this.recentCreates.get(requestId)?.entry ?? null;
  }

  private rememberCreate(requestId: string, entry: EntryData): void {
    this.recentCreates.set(requestId, { entry, at: this.now().getTime() });
    while (this.recentCreates.size > RECENT_CREATE_LIMIT) {
      const oldest = this.recentCreates.keys().next().value;
      if (oldest === undefined) break;
      this.recentCreates.delete(oldest);
    }
  }
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
}
