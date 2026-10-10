import {
  normalizeId,
  type CreateEntryRequest,
  type UpdateEntryRequest,
  type VocabularyEntry,
  type VocabularyListResponse,
} from '../shared/api.js';
import { calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import type { ReviewRules } from '../shared/review-logic.js';
import { normalizeWord } from '../shared/text.js';
import { TEXT_FIELD_KEYS, type NewWordDefaults } from '../shared/vocabulary.js';
import { classifyReviewStatus, isReviewableNow } from '../shared/vocabulary-status.js';
import { HttpError } from './errors.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { EntryChanges, EntryData, VocabularyCatalog } from './vocabulary-catalog.js';

export interface VocabularyServiceOptions {
  catalog: VocabularyCatalog;
  rules: ReviewRules;
  defaults: NewWordDefaults;
  timeZone: string;
  /** The owner allowed the app to change stored data. */
  writesRequested: boolean;
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

  constructor(private readonly options: VocabularyServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  private decorate(entry: EntryData, today: IsoDate): VocabularyEntry {
    const reviewStatus = classifyReviewStatus(entry, today, this.options.rules);
    return { ...entry, reviewStatus, reviewable: isReviewableNow(reviewStatus, this.options.rules) };
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
        mastery: request.mastery ?? defaults.mastery,
        reviewDate:
          request.reviewDate !== undefined ? request.reviewDate : defaults.reviewDate === 'today' ? today : null,
      });
      this.rememberCreate(request.requestId, entry);
      return { entry: this.decorate(entry, today), created };
    });
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
      if (request.schedule !== undefined) {
        if (request.schedule.mastery !== current.mastery) changes.mastery = request.schedule.mastery;
        if (request.schedule.reviewDate !== current.reviewDate) changes.reviewDate = request.schedule.reviewDate;
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
