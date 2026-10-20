/**
 * Discovery & Input: what a source may hold, what a mark may claim, and
 * the one explicit act that turns a selection into saved vocabulary.
 *
 * The invariants this service exists to keep:
 *   - nothing here creates a word except saveSelection and saveMark, each
 *     on the learner's explicit press, through the ordinary vocabulary
 *     path — its duplicate check, its defaults and its request id included;
 *   - a mark for later references no vocabulary at all; it gains a word
 *     only by that same save, never by opening, reading, listening or
 *     importing anything;
 *   - marks keep the context around a selection (the sentence, the cue),
 *     never the source itself, and every source records where it came from;
 *   - nothing here touches mastery, schedules, review history, practice
 *     or the Error Log: discovery is finding, not learning.
 */
import {
  DISCOVERY_LIMITS,
  sentenceAround,
  tidyDiscoveryContent,
  tidyDiscoveryLabel,
  tidyDiscoveryTitle,
  type CreateDiscoverySourceRequest,
  type DiscoveryMark,
  type DiscoveryMarkView,
  type DiscoveryPosition,
  type DiscoverySource,
  type DiscoverySourceDocument,
  type DiscoverySuggestion,
  type MarkSelectionRequest,
  type SaveSelectionRequest,
} from '../shared/discovery.js';
import type { CreateEntryRequest } from '../shared/api.js';
import type { AiDiscoveryRequest, AiDiscoveryDraft } from '../shared/ai.js';
import { HttpError } from './errors.js';
import type { StoredDiscoveryMark, StoredDiscoverySource, DiscoveryStore } from './discovery-store.js';
import type { VocabularyService } from './vocabulary-service.js';

/** Everything the generate step needs about the learner's own library, read only. */
export interface DiscoveryLibrarySource {
  /** One of the caller's collections with the words in it, or null when there is no such collection. */
  findCollection(id: string): Promise<{ name: string; words: string[] } | null>;
}

export interface DiscoveryServiceOptions {
  store: DiscoveryStore;
  /** The ordinary word path. Null only where there is no vocabulary service to reach. */
  vocabulary: VocabularyService | null;
  library: DiscoveryLibrarySource | null;
  writesRequested: boolean;
  now?: () => Date;
}

export interface DiscoverySeeds {
  /** The words to write around, already capped. */
  words: string[];
  /** Where the words came from, for the writer's instruction. */
  from: { kind: 'topic'; topic: string } | { kind: 'collection'; name: string } | { kind: 'words' };
}

export class DiscoveryService {
  private readonly store: DiscoveryStore;
  private readonly vocabulary: VocabularyService | null;
  private readonly library: DiscoveryLibrarySource | null;
  private readonly writesRequested: boolean;
  private readonly now: () => Date;

  constructor(options: DiscoveryServiceOptions) {
    this.store = options.store;
    this.vocabulary = options.vocabulary;
    this.library = options.library;
    this.writesRequested = options.writesRequested;
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  async list(): Promise<{ sources: DiscoverySource[] }> {
    const [sources, marks] = await Promise.all([this.store.listSources(), this.store.listMarks()]);
    const counts = new Map<string, { marked: number; saved: number }>();
    for (const mark of marks) {
      const bucket = counts.get(mark.sourceId) ?? { marked: 0, saved: 0 };
      if (mark.savedAt === null) bucket.marked += 1;
      else bucket.saved += 1;
      counts.set(mark.sourceId, bucket);
    }
    return { sources: sources.map((source) => this.summary(source, counts.get(source.id) ?? { marked: 0, saved: 0 })) };
  }

  async create(request: CreateDiscoverySourceRequest): Promise<{ source: DiscoverySource }> {
    this.requireWrites();
    const title = tidyDiscoveryTitle(request.title);
    if (title.length === 0) throw new HttpError(400, 'invalid_request', 'A source needs a title.');
    const content = tidyDiscoveryContent(request.content);
    const suggestions = request.suggestions ?? [];
    // Generated content arrives with its suggested words. Each must be a
    // word that is really in the text — a model may not point at one it
    // invented — and they are stored as marks, still unsaved.
    if (suggestions.length > 0 && request.kind !== 'generated') {
      throw new HttpError(400, 'invalid_request', 'Suggested words belong to generated content.');
    }
    const lower = content.toLowerCase();
    for (const suggestion of suggestions) {
      if (!lower.includes(suggestion.word.toLowerCase())) {
        throw new HttpError(400, 'invalid_request', `Suggested words must appear in the text — "${suggestion.word}" does not.`);
      }
    }
    const created = await this.store.createSource({
      kind: request.kind,
      title,
      origin: request.origin ?? '',
      content,
      contentKind: request.contentKind ?? 'plain',
      position: request.position ?? {},
      requestId: request.requestId ?? null,
    });
    if (created === 'duplicate') {
      // The same request id again: the source the first one made is the answer,
      // and its suggestions are already stored — nothing is added twice.
      const existing = request.requestId === undefined ? null : await this.store.findSourceByRequestId(request.requestId);
      if (existing !== null) return { source: this.summary(existing, await this.counts(existing.id)) };
      throw new HttpError(409, 'conflict', 'That request was already used.');
    }
    for (const suggestion of suggestions) await this.insertSuggestion(created, content, suggestion);
    return { source: this.summary(created, await this.counts(created.id)) };
  }

  async get(id: string): Promise<{ source: DiscoverySourceDocument }> {
    const source = await this.requireSource(id);
    const marks = await this.store.listMarks(source.id);
    return { source: this.document(source, marks) };
  }

  async update(
    id: string,
    patch: { title?: string; position?: DiscoveryPosition; ifMatch?: number },
  ): Promise<{ source: DiscoverySource }> {
    this.requireWrites();
    const source = await this.requireSource(id);
    let current = source;
    if (patch.position !== undefined) {
      // A reading or listening position is restorable state: last write
      // wins, and it never moves the revision an edit is checked against.
      const moved = await this.store.updatePosition(id, patch.position);
      if (moved === null) throw this.notFound();
      current = moved;
    }
    if (patch.title !== undefined) {
      this.checkRevision(source, patch.ifMatch);
      const title = tidyDiscoveryTitle(patch.title);
      if (title.length === 0) throw new HttpError(400, 'invalid_request', 'A source needs a title.');
      const updated = await this.store.updateSource(id, { title });
      if (updated === null) throw this.notFound();
      const bumped = await this.store.bumpSourceRevision(id);
      current = bumped ?? updated;
    }
    return { source: this.summary(current, await this.counts(id)) };
  }

  /** Removes the source and every mark on it. Every word those marks became stays. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    this.requireWrites();
    await this.requireSource(id);
    await this.store.deleteSource(id);
    return { id, deleted: true };
  }

  // -------------------------------------------------------------------------
  // Marks: kept for later, or saved — never one by accident
  // -------------------------------------------------------------------------

  /** Every selection still waiting, wherever it came from, with where it came from. */
  async marks(): Promise<{ marks: DiscoveryMarkView[] }> {
    const [all, sources] = await Promise.all([this.store.listMarks(), this.store.listSources()]);
    const byId = new Map(sources.map((source) => [source.id, source]));
    const views: DiscoveryMarkView[] = [];
    for (const mark of all) {
      if (mark.savedAt !== null) continue;
      const source = byId.get(mark.sourceId);
      // A mark without its source cannot happen (the cascade takes both),
      // but skipping beats showing a claim with no provenance behind it.
      if (source === undefined) continue;
      views.push({ ...this.markOf(mark), sourceTitle: source.title, sourceKind: source.kind });
    }
    return { marks: views };
  }

  /** Mark for Later: a selection kept, referencing nothing in the library. */
  async mark(request: MarkSelectionRequest): Promise<{ mark: DiscoveryMark }> {
    this.requireWrites();
    const source = await this.requireSource(request.sourceId);
    const label = tidyDiscoveryLabel(request.label);
    if (label.length === 0) throw new HttpError(400, 'invalid_request', 'Select something first.');
    const offset = this.clampOffset(request.offset, source);
    const context =
      request.context ?? (offset !== undefined ? sentenceAround(source.content, offset) : '');
    const inserted = await this.store.insertMark({
      sourceId: source.id,
      label,
      context: context.slice(0, DISCOVERY_LIMITS.context),
      offset: offset ?? null,
      cueStart: request.cueStart ?? null,
      cueEnd: request.cueEnd ?? null,
      note: request.note ?? '',
      vocabularyId: null,
      savedAt: null,
      requestId: request.requestId,
    });
    const mark = inserted === 'duplicate' ? await this.resolveMark(request) : inserted;
    return { mark: this.markOf(mark) };
  }

  /**
   * Save Now: the selection becomes one word, through the ordinary word
   * path, and the mark keeps where it was found. A mark that was already
   * waiting for this label is the mark that gains the word — the learner
   * pressed Save, so this is the conversion, not a silent one.
   */
  async saveSelection(request: SaveSelectionRequest): Promise<{ entry: Awaited<ReturnType<VocabularyService['get']>>; mark: DiscoveryMark }> {
    this.requireWrites();
    const source = await this.requireSource(request.sourceId);
    const vocabulary = this.requireVocabulary();
    const label = tidyDiscoveryLabel(request.word);
    const offset = this.clampOffset(request.offset, source);
    const context = request.context ?? (offset !== undefined ? sentenceAround(source.content, offset) : '');
    // The source's own sentence becomes the word's example when the form
    // did not say otherwise: context worth keeping, editable like any other.
    const example = request.example || context || undefined;
    const { entry } = await vocabulary.create({
      word: label,
      meaning: request.meaning,
      definition: request.definition,
      example,
      dateAdded: request.dateAdded,
      mastery: request.mastery,
      reviewDate: request.reviewDate,
      allowDuplicate: request.allowDuplicate,
      requestId: request.requestId,
    });
    const savedAt = this.now().toISOString();

    const waiting = await this.store.findMarkByLabel(source.id, label);
    if (waiting !== null && waiting.savedAt === null) {
      const promoted = await this.store.patchMark(waiting.id, { vocabularyId: entry.id, savedAt });
      return { entry, mark: this.markOf(promoted ?? waiting) };
    }
    const inserted = await this.store.insertMark({
      sourceId: source.id,
      label,
      context: context.slice(0, DISCOVERY_LIMITS.context),
      offset: offset ?? null,
      cueStart: request.cueStart ?? null,
      cueEnd: request.cueEnd ?? null,
      note: request.note ?? '',
      vocabularyId: entry.id,
      savedAt,
      requestId: request.requestId,
    });
    if (inserted === 'duplicate') {
      // A repeated submission, or the same label already saved here: the
      // mark that exists answers for it, pointed at the word it has.
      const existing = (await this.store.findMarkByRequestId(request.requestId)) ?? (await this.store.findMarkByLabel(source.id, label));
      if (existing === null) throw new HttpError(409, 'conflict', 'That selection was already saved.');
      const linked = existing.vocabularyId === null ? await this.store.patchMark(existing.id, { vocabularyId: entry.id, savedAt }) : existing;
      return { entry, mark: this.markOf(linked ?? existing) };
    }
    return { entry, mark: this.markOf(inserted) };
  }

  /** Marked earlier, saved now: the word through the same path, the mark gains it. */
  async saveMark(markId: string, request: Omit<CreateEntryRequest, 'word'>): Promise<{ entry: Awaited<ReturnType<VocabularyService['get']>>; mark: DiscoveryMark }> {
    this.requireWrites();
    const mark = await this.requireMark(markId);
    const vocabulary = this.requireVocabulary();
    if (mark.savedAt !== null && mark.vocabularyId !== null) {
      // Already saved: the same submission answered again, or a later press
      // after one that landed. The word and the mark stand as they are.
      return { entry: await vocabulary.get(mark.vocabularyId), mark: this.markOf(mark) };
    }
    // The mark's own text is what gets saved — the selection it has been
    // holding — with the fields the form filled in around it.
    const example = request.example || mark.context || undefined;
    const { entry } = await vocabulary.create({
      word: mark.label,
      meaning: request.meaning,
      definition: request.definition,
      example,
      dateAdded: request.dateAdded,
      mastery: request.mastery,
      reviewDate: request.reviewDate,
      allowDuplicate: request.allowDuplicate,
      requestId: request.requestId,
    });
    const savedAt = this.now().toISOString();
    const linked = await this.store.patchMark(mark.id, { vocabularyId: entry.id, savedAt });
    return { entry, mark: this.markOf(linked ?? mark) };
  }

  /** Dismiss: the waiting selection is taken out. A saved one keeps its context with its word. */
  async dismiss(markId: string): Promise<{ id: string; deleted: true }> {
    this.requireWrites();
    const mark = await this.requireMark(markId);
    if (mark.savedAt !== null) {
      throw new HttpError(409, 'conflict', 'That selection is saved with its word; its context stays with the word.');
    }
    await this.store.deleteMark(markId);
    return { id: markId, deleted: true };
  }

  /** Where a word was found: the mark that saved it and the source behind it, or nothing. */
  async contextFor(vocabularyId: string): Promise<{ source: DiscoverySource; mark: DiscoveryMark }> {
    const mark = await this.store.findMarkByVocabulary(vocabularyId);
    if (mark === null) throw new HttpError(404, 'not_found', 'That word did not come from a saved selection.');
    const source = await this.requireSource(mark.sourceId);
    return { source: this.summary(source, await this.counts(source.id)), mark: this.markOf(mark) };
  }

  // -------------------------------------------------------------------------
  // Generating: what to write around — reading only, writing nothing
  // -------------------------------------------------------------------------

  /**
   * What the writer works from. Reads the named collection and never
   * changes it; words the learner typed are passed through as they are.
   */
  async seedsFor(request: AiDiscoveryRequest): Promise<DiscoverySeeds> {
    if (request.topic !== undefined) return { words: [], from: { kind: 'topic', topic: request.topic } };
    if (request.words !== undefined) return { words: request.words.slice(0, 30), from: { kind: 'words' } };
    if (this.library === null) throw new HttpError(503, 'setup_incomplete', 'Generating from a collection needs the library.');
    const collection = await this.library.findCollection(request.collectionId as string);
    if (collection === null) throw new HttpError(404, 'not_found', 'That collection is not yours.');
    return { words: collection.words.slice(0, 30), from: { kind: 'collection', name: collection.name } };
  }

  /**
   * The draft is shown, not stored: nothing is created until the learner
   * accepts the preview, and accepting is an ordinary source creation with
   * the suggestions as marks. Existing sources are never touched.
   */
  async checkDraft(draft: AiDiscoveryDraft): Promise<AiDiscoveryDraft> {
    const lower = draft.text.toLowerCase();
    const found = draft.suggestions.filter((suggestion) => lower.includes(suggestion.word.toLowerCase()));
    if (found.length !== draft.suggestions.length) {
      throw new HttpError(502, 'ai_invalid', 'The model suggested words that are not in its own text. Nothing was kept.');
    }
    return { ...draft, suggestions: found };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireWrites(): void {
    if (!this.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
  }

  private requireVocabulary(): VocabularyService {
    if (this.vocabulary === null) {
      throw new HttpError(503, 'setup_incomplete', 'Saving a selection needs the vocabulary service.');
    }
    return this.vocabulary;
  }

  private notFound(): HttpError {
    return new HttpError(404, 'not_found', 'That source is not yours.');
  }

  private async requireSource(id: string): Promise<StoredDiscoverySource> {
    const source = await this.store.getSource(id);
    if (source === null) throw this.notFound();
    return source;
  }

  private async requireMark(id: string): Promise<StoredDiscoveryMark> {
    const mark = await this.store.getMark(id);
    if (mark === null) throw new HttpError(404, 'not_found', 'That selection is not here.');
    return mark;
  }

  private checkRevision(source: StoredDiscoverySource, ifMatch: number | undefined): void {
    if (ifMatch !== undefined && ifMatch !== source.revision) {
      throw new HttpError(
        409,
        'conflict',
        'This source was changed somewhere else since you opened it. Reload it and put the change on top of the newer one.',
      );
    }
  }

  /** An offset is a position in the source as it stands; beyond its end means the end. */
  private clampOffset(offset: number | undefined, source: StoredDiscoverySource): number | undefined {
    if (offset === undefined) return undefined;
    return Math.max(0, Math.min(offset, Math.max(0, source.content.length - 1)));
  }

  private async resolveMark(request: MarkSelectionRequest): Promise<StoredDiscoveryMark> {
    const byRequest = await this.store.findMarkByRequestId(request.requestId);
    if (byRequest !== null) return byRequest;
    const byLabel = await this.store.findMarkByLabel(request.sourceId, tidyDiscoveryLabel(request.label));
    if (byLabel !== null) return byLabel;
    throw new HttpError(409, 'conflict', 'That selection was already marked.');
  }

  private async insertSuggestion(source: StoredDiscoverySource, content: string, suggestion: DiscoverySuggestion): Promise<void> {
    const label = tidyDiscoveryLabel(suggestion.word);
    const at = content.toLowerCase().indexOf(label.toLowerCase());
    const context = suggestion.sentence ?? sentenceAround(content, Math.max(0, at));
    await this.store.insertMark({
      sourceId: source.id,
      label,
      context: context.slice(0, DISCOVERY_LIMITS.context),
      offset: at >= 0 ? at : null,
      cueStart: null,
      cueEnd: null,
      note: suggestion.note ?? '',
      vocabularyId: null,
      savedAt: null,
      requestId: null,
    });
  }

  private async counts(sourceId: string): Promise<{ marked: number; saved: number }> {
    const marks = await this.store.listMarks(sourceId);
    return {
      marked: marks.filter((mark) => mark.savedAt === null).length,
      saved: marks.filter((mark) => mark.savedAt !== null).length,
    };
  }

  private summary(source: StoredDiscoverySource, counts: { marked: number; saved: number }): DiscoverySource {
    return {
      id: source.id,
      kind: source.kind,
      title: source.title,
      origin: source.origin,
      contentKind: source.contentKind,
      position: source.position,
      revision: source.revision,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      markedCount: counts.marked,
      savedCount: counts.saved,
    };
  }

  private document(source: StoredDiscoverySource, marks: StoredDiscoveryMark[]): DiscoverySourceDocument {
    return {
      ...this.summary(source, {
        marked: marks.filter((mark) => mark.savedAt === null).length,
        saved: marks.filter((mark) => mark.savedAt !== null).length,
      }),
      content: source.content,
      marks: marks.map((mark) => this.markOf(mark)),
    };
  }

  private markOf(mark: StoredDiscoveryMark): DiscoveryMark {
    return {
      id: mark.id,
      sourceId: mark.sourceId,
      label: mark.label,
      context: mark.context,
      offset: mark.offset,
      cueStart: mark.cueStart,
      cueEnd: mark.cueEnd,
      note: mark.note,
      vocabularyId: mark.vocabularyId,
      savedAt: mark.savedAt,
      createdAt: mark.createdAt,
    };
  }
}
