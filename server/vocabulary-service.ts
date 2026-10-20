import {
  importItemSchema,
  MAX_SENSES,
  normalizeId,
  NO_CAPABILITIES,
  type Capabilities,
  type CreateEntryRequest,
  type ImportResponse,
  type ImportSense,
  type UpdateEntryRequest,
  type VocabularyEntry,
  type VocabularyListResponse,
  type Sense,
  type AddSenseRequest,
  type UpdateSenseRequest,
  type ReorderSensesRequest,
  type ArchiveSenseRequest,
  type RestoreSenseRequest,
  type AddSenseResponse,
} from '../shared/api.js';
import { calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import type { ReviewRules } from '../shared/review-logic.js';
import { dueDateUnder, isScheduledByFsrs } from '../shared/scheduler/active.js';
import { normalizeWord } from '../shared/text.js';
import { TEXT_FIELD_KEYS, type NewWordDefaults } from '../shared/vocabulary.js';
import { classifyReviewStatus, isReviewableNow } from '../shared/vocabulary-status.js';
import { HttpError } from './errors.js';
import { KeyedMutex } from './keyed-mutex.js';
import { derivedRequestId } from './request-id.js';
import { MASTERY_ONLY, type SchedulerStore } from './scheduler-store.js';
import type { EntryChanges, EntryData, NewEntry, VocabularyCatalog } from './vocabulary-catalog.js';

export interface VocabularyServiceOptions {
  catalog: VocabularyCatalog;
  rules: ReviewRules;
  defaults: NewWordDefaults;
  timeZone: string;
  /** The owner allowed the app to change stored data. */
  writesRequested: boolean;
  /** Which schedule decides when a word is due. Without one, the mastery schedule. */
  scheduler?: SchedulerStore;
  /** What the store behind this service can keep. Without one, nothing optional. */
  capabilities?: Capabilities;
  now?: () => Date;
}

const RECENT_CREATE_TTL_MS = 10 * 60 * 1000;
const RECENT_CREATE_LIMIT = 200;

const emptyToNull = (text: string | undefined): string | null | undefined =>
  text === undefined ? undefined : text === '' ? null : text;

/** A sense field as the row holds it: absent, empty and blank all mean "no value". */
const senseText = (value: string | null | undefined): string | null =>
  value == null || value === '' ? null : value;

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
  private readonly capabilities: Capabilities;

  constructor(private readonly options: VocabularyServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? MASTERY_ONLY;
    this.capabilities = options.capabilities ?? NO_CAPABILITIES;
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  /**
   * An entry as the reviewer sees it. Its review date, and with it the status,
   * is the one under the schedule in charge; the stored mastery date is
   * untouched underneath.
   */
  private decorate(entry: EntryData, today: IsoDate): VocabularyEntry {
    const { rules, timeZone } = this.options;
    const scheduler = this.scheduler.get();
    const stored = { ...entry };
    delete stored.fsrsDue;
    const reviewDate = dueDateUnder(scheduler, entry, timeZone);
    const reviewStatus = classifyReviewStatus({ mastery: entry.mastery, reviewDate }, today, rules);
    return {
      ...stored,
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
      capabilities: this.capabilities,
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
  async create(
    request: CreateEntryRequest,
    /** The word's senses, written with the word itself where the store can. */
    senses?: NewEntry['senses'],
  ): Promise<{ entry: VocabularyEntry; created: boolean }> {
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
        senses,
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
   *
   * A row may carry the word's senses in order, as the account export lists
   * them. Those senses are then the word's content — the row's own meaning,
   * definition and example are not read, so nothing is stored twice — and the
   * row is refused whole if the store cannot hold senses, rather than
   * importing a word stripped of them. Where the database writes them, the
   * word and every sense it names land in one transaction, so a failure
   * cannot leave a word behind without its senses; the pass afterwards then
   * archives what the file marks and finishes any earlier interrupted run.
   */
  async importBatch(items: readonly unknown[]): Promise<ImportResponse> {
    await this.requireWrites();
    const results: ImportResponse['results'] = [];
    for (const [index, raw] of items.entries()) {
      const parsed = importItemSchema.safeParse(raw);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`).join('; ');
        results.push({ outcome: 'invalid', entry: null, message });
        continue;
      }
      const { senses, ...item } = parsed.data;
      if (senses !== undefined && senses.length > 0 && !this.capabilities?.senses) {
        results.push({
          outcome: 'invalid',
          entry: null,
          message: 'This database cannot store multiple senses yet. Settings → Connection shows the update that adds it.',
        });
        continue;
      }
      try {
        const withSenses = senses !== undefined && senses.length > 0;
        const { entry, created } = await this.create(
          // The senses are the word's content: the row's own fields are not read.
          withSenses ? { ...item, meaning: undefined, definition: undefined, example: undefined } : item,
          // Carried into the row's own write, so the word and every sense it
          // names land together where the store can write them together. The
          // ids match what fillSenses derives, so a repeat lands on the same
          // senses either way.
          withSenses
            ? senses.map((sense, position) => ({
                meaning: senseText(sense.meaning),
                definition: senseText(sense.definition),
                example: senseText(sense.example),
                requestId: derivedRequestId(item.requestId, `sense:${position}`),
              }))
            : undefined,
        );
        // Always write the senses again afterwards: on a store that could not
        // carry them with the word this is what makes them, and on one that
        // could it is a repeat that lands on the same rows and archives what
        // the file says to archive — either way the word ends the same.
        const stored =
          senses !== undefined && senses.length > 0
            ? await this.fillSenses(item.requestId, entry, senses)
            : entry;
        results.push({ outcome: created ? 'imported' : 'already_imported', entry: stored, message: null });
      } catch (error) {
        if (error instanceof HttpError && error.code === 'duplicate') {
          results.push({ outcome: 'duplicate', entry: null, message: error.message });
        } else if (error instanceof HttpError && error.status === 400) {
          results.push({ outcome: 'invalid', entry: null, message: error.message });
        } else {
          // Not about this row: the store is in trouble. Stop here, name the
          // row it happened on, and say how a retry lands the rest.
          const detail = error instanceof HttpError ? error.message : 'The database could not be reached.';
          const message = `"${item.word}" is incomplete: ${detail} Nothing after it was attempted. Send the same file again to finish — what is already imported is not added twice.`;
          return { results, stopped: { index, message } };
        }
      }
    }
    return { results, stopped: null };
  }

  /**
   * The senses of one imported word, in the order the file lists them, each
   * made under a request id derived from the row's own: a repeat of the batch
   * lands on the senses already made, and a run that stopped between the word
   * and its senses finishes instead of doubling anything. The entry lock the
   * sense editor uses is held throughout, and each row is one database call —
   * the resume call that is the import's authorized exception, allowed to
   * finish a word that has since been moved to the trash where the ordinary
   * sense operations refuse it. Nothing stored is changed — a sense is only
   * added, and only archived when the file says so and it is not archived
   * already — so an edit made after an interrupted import survives the rest
   * of it.
   */
  private async fillSenses(
    requestId: string,
    entry: VocabularyEntry,
    senses: readonly ImportSense[],
  ): Promise<VocabularyEntry> {
    const { catalog } = this.options;
    const store = catalog.senses;
    if (store === undefined) return entry;
    return this.locks.run(`sense:${entry.id}`, async () => {
      for (const [position, sense] of senses.entries()) {
        // The one write path allowed to finish senses on a word that has been
        // moved to the trash: each row lands under its own request id, with
        // the archive state the file carries in the same call. A sense that
        // is already there is answered, never rewritten — an edit made after
        // an interrupted run survives the rest of the import.
        await store.createSense(
          entry.id,
          {
            meaning: senseText(sense.meaning),
            definition: senseText(sense.definition),
            example: senseText(sense.example),
            requestId: derivedRequestId(requestId, `sense:${position}`),
          },
          { resume: true, archived: sense.archived === true },
        );
      }
      const updated = await catalog.getEntry(entry.id);
      return this.decorate(updated ?? entry, this.today());
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
      // The root pointer is organisation, like a collection membership: it
      // needs a store that can keep it, and the root must be a word of this
      // own account. It never touches the word's content or its schedule.
      if (request.rootId !== undefined && request.rootId !== current.rootId) {
        if (!this.capabilities.roots) {
          throw new HttpError(
            409,
            'not_supported',
            'This database cannot keep which word a word was formed from yet. Settings → Connection shows the update that adds it.',
          );
        }
        if (request.rootId !== null) {
          if (request.rootId === pageId) {
            throw new HttpError(400, 'invalid_request', 'A word cannot be its own root.');
          }
          if ((await catalog.getEntry(request.rootId)) === null) {
            throw new HttpError(404, 'not_found', 'That root word is not in your vocabulary.');
          }
        }
        changes.rootId = request.rootId;
      }
      if (request.schedule !== undefined) {
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
              'FSRS sets this word’s review date from your answers, so it cannot be changed by hand. To set dates yourself, switch back to the mastery schedule in Settings.',
            );
          }
          changes.reviewDate = request.schedule.reviewDate;
        }
      }
      if (Object.keys(changes).length === 0) return this.decorate(current, today);

      // A client that states the senses version it last saw is refused if the
      // senses have moved on since it read them. The store checks it inside
      // the same statement that writes the change.
      if (request.expectSensesVersion !== undefined) changes.expectSensesVersion = request.expectSensesVersion;

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

  // ---- Sense operations (schema version 13) ----

  /** List all senses for a vocabulary entry, archived ones included. */
  async listSenses(vocabularyId: string): Promise<Sense[]> {
    if (!this.capabilities?.senses) {
      throw new HttpError(409, 'not_supported', 'This database cannot keep multiple senses yet. Settings → Connection shows the update that adds it.');
    }
    const pageId = normalizeId(vocabularyId);
    if ((await this.options.catalog.getEntry(pageId)) === null) throw notFound();
    return this.options.catalog.senses!.listSenses(pageId);
  }

  /** Get a single sense by ID. */
  async getSense(senseId: string): Promise<Sense> {
    if (!this.capabilities?.senses) {
      throw new HttpError(409, 'not_supported', 'This database cannot keep multiple senses yet. Settings → Connection shows the update that adds it.');
    }
    const sense = await this.options.catalog.senses!.getSense(senseId);
    if (!sense) throw notFound();
    return sense;
  }

  /** Add a new sense to a vocabulary entry. A repeated request id lands on the same sense. */
  async addSense(vocabularyId: string, request: AddSenseRequest): Promise<AddSenseResponse> {
    await this.requireWrites();
    if (!this.capabilities?.senses) {
      throw new HttpError(409, 'not_supported', 'This database cannot keep multiple senses yet. Settings → Connection shows the update that adds it.');
    }
    if (request.meaning == null && request.definition == null && request.example == null) {
      throw new HttpError(400, 'invalid_request', 'A sense needs at least a meaning, a definition or an example.');
    }
    const pageId = normalizeId(vocabularyId);
    return this.locks.run(`sense:${pageId}`, async () => {
      if ((await this.options.catalog.getEntry(pageId)) === null) throw notFound();
      const live = (await this.options.catalog.senses!.listSenses(pageId)).filter((sense) => !sense.archived);
      if (live.length >= MAX_SENSES) {
        throw new HttpError(400, 'invalid_request', `A word can hold at most ${MAX_SENSES} senses.`);
      }
      const { sense, created } = await this.options.catalog.senses!.createSense(pageId, {
        meaning: request.meaning ?? null,
        definition: request.definition ?? null,
        example: request.example ?? null,
        requestId: request.requestId,
      });
      return { sense, created };
    });
  }

  /** Update an existing sense. A field left out is left as it is; `null` clears it. */
  async updateSense(senseId: string, request: UpdateSenseRequest): Promise<Sense> {
    await this.requireWrites();
    if (!this.capabilities?.senses) {
      throw new HttpError(409, 'not_supported', 'This database cannot keep multiple senses yet. Settings → Connection shows the update that adds it.');
    }
    return this.locks.run(`sense-op:${normalizeId(senseId)}`, async () => {
      const result = await this.options.catalog.senses!.updateSense(normalizeId(senseId), {
        ...(request.meaning !== undefined ? { meaning: request.meaning } : {}),
        ...(request.definition !== undefined ? { definition: request.definition } : {}),
        ...(request.example !== undefined ? { example: request.example } : {}),
        expectedVersion: request.ifMatch,
      });
      if (result === 'stale') throw new HttpError(409, 'conflict', 'This sense was modified by another request. Please reload and try again.');
      if (result === 'not_found') throw notFound();
      return result;
    });
  }

  /** Reorder senses. The order sent must name every live sense exactly once. */
  async reorderSenses(vocabularyId: string, request: ReorderSensesRequest): Promise<void> {
    await this.requireWrites();
    if (!this.capabilities?.senses) {
      throw new HttpError(409, 'not_supported', 'This database cannot keep multiple senses yet. Settings → Connection shows the update that adds it.');
    }
    const pageId = normalizeId(vocabularyId);
    return this.locks.run(`sense:${pageId}`, async () => {
      if ((await this.options.catalog.getEntry(pageId)) === null) throw notFound();
      const liveIds = (await this.options.catalog.senses!.listSenses(pageId))
        .filter((sense) => !sense.archived)
        .map((sense) => sense.id);
      const wanted = request.senseIds;
      const complete =
        wanted.length === liveIds.length &&
        new Set(wanted).size === wanted.length &&
        wanted.every((id) => liveIds.includes(id));
      if (!complete) {
        throw new HttpError(400, 'invalid_request', 'That order does not name every sense of this word exactly once. Reload and try again.');
      }
      const result = await this.options.catalog.senses!.reorderSenses(pageId, wanted, request.ifMatch);
      if (result === 'stale') throw new HttpError(409, 'conflict', 'The sense list was modified by another request. Please reload and try again.');
      if (result === 'not_found') throw notFound();
    });
  }

  /** Archive (soft-delete) a sense. It stays, and can be restored. */
  async archiveSense(senseId: string, request: ArchiveSenseRequest): Promise<void> {
    await this.requireWrites();
    if (!this.capabilities?.senses) {
      throw new HttpError(409, 'not_supported', 'This database cannot keep multiple senses yet. Settings → Connection shows the update that adds it.');
    }
    return this.locks.run(`sense-op:${normalizeId(senseId)}`, async () => {
      const result = await this.options.catalog.senses!.archiveSense(normalizeId(senseId), request.ifMatch);
      if (result === 'stale') throw new HttpError(409, 'conflict', 'This sense was modified by another request. Please reload and try again.');
      if (result === 'not_found') throw notFound();
    });
  }

  /** Restore an archived sense. It returns at the end of the order. */
  async restoreSense(senseId: string, request: RestoreSenseRequest): Promise<void> {
    await this.requireWrites();
    if (!this.capabilities?.senses) {
      throw new HttpError(409, 'not_supported', 'This database cannot keep multiple senses yet. Settings → Connection shows the update that adds it.');
    }
    return this.locks.run(`sense-op:${normalizeId(senseId)}`, async () => {
      const result = await this.options.catalog.senses!.restoreSense(normalizeId(senseId), request.ifMatch);
      if (result === 'stale') throw new HttpError(409, 'conflict', 'This sense was modified by another request. Please reload and try again.');
      if (result === 'not_found') throw notFound();
    });
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
