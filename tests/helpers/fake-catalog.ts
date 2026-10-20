import { normalizeWord } from '../../shared/text.js';
import type { Sense } from '../../shared/api.js';
import { HttpError } from '../../server/errors.js';
import type { EntryChanges, EntryData, NewEntry, SenseOperations, VocabularyCatalog } from '../../server/vocabulary-catalog.js';
import type { SetupReport } from '../../server/vocabulary-repository.js';
import { pageId } from './fixtures.js';

export function entryData(n: number, overrides: Partial<EntryData> = {}): EntryData {
  return {
    id: pageId(n),
    word: `word-${n}`,
    meaning: `nghĩa ${n}`,
    definition: `definition of word-${n}`,
    example: `example for word-${n}`,
    mastery: 3,
    reviewDate: '2026-10-09',
    dateAdded: '2026-10-01',
    rootId: null,
    senses: [],
    sensesVersion: 0,
    createdTime: '2026-10-01T02:00:00.000Z',
    lastEditedTime: '2026-10-05T02:00:00.000Z',
    ...overrides,
  };
}

/** An in-memory catalog that records every write. */
export class FakeCatalog implements VocabularyCatalog {
  readonly mode = 'mock' as const;
  setup: SetupReport = { readIssues: [], writeIssues: [], warnings: [] };
  readonly created: NewEntry[] = [];
  readonly updated: Array<{ id: string; changes: EntryChanges }> = [];
  readonly trashed: string[] = [];
  readonly restored: string[] = [];
  /** Set to make the next write fail the way an outage would. */
  failNextWrite: Error | null = null;
  private readonly entries: Map<string, EntryData & { inTrash: boolean }>;
  private nextId = 100;

  constructor(entries: EntryData[] = []) {
    this.entries = new Map(entries.map((entry) => [entry.id, { ...entry, inTrash: false }]));
  }

  private strip({ inTrash: _inTrash, ...entry }: EntryData & { inTrash: boolean }): EntryData {
    void _inTrash;
    return entry;
  }

  private maybeFail() {
    const failure = this.failNextWrite;
    this.failNextWrite = null;
    if (failure) throw failure;
  }

  async checkSetup() {
    return this.setup;
  }

  async listEntries() {
    return {
      entries: [...this.entries.values()].filter((entry) => !entry.inTrash).map((entry) => this.strip(entry)),
      invalid: [],
    };
  }

  async getEntry(id: string) {
    const entry = this.entries.get(id);
    return entry && !entry.inTrash ? this.strip(entry) : null;
  }

  async findEntriesByWord(word: string) {
    const wanted = normalizeWord(word);
    return (await this.listEntries()).entries.filter((entry) => normalizeWord(entry.word) === wanted);
  }

  async listTrashed() {
    return [...this.entries.values()].filter((entry) => entry.inTrash).map((entry) => this.strip(entry));
  }

  async createEntry({ requestId: _requestId, senses: _senses, ...entry }: NewEntry) {
    void _requestId;
    // This store cannot write senses with the word; they arrive one call each
    // from the caller that always writes them after, so the field is dropped.
    void _senses;
    this.maybeFail();
    this.created.push(entry);
    const stored = { ...entryData(this.nextId++), ...entry, inTrash: false };
    this.entries.set(stored.id, stored);
    return { entry: this.strip(stored), created: true };
  }

  async updateEntry(id: string, changes: EntryChanges) {
    this.maybeFail();
    const entry = this.entries.get(id);
    if (!entry) throw new Error('unknown entry');
    this.updated.push({ id, changes });
    // The version the caller expected is checked, then left off the stored entry.
    const { expectSensesVersion, ...rest } = changes;
    if (expectSensesVersion !== undefined && expectSensesVersion !== entry.sensesVersion) {
      throw new HttpError(409, 'conflict', 'This word changed while you were editing it. Reload and try again.');
    }
    Object.assign(entry, rest);
    return this.strip(entry);
  }

  async trashEntry(id: string) {
    this.maybeFail();
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.inTrash = true;
    this.trashed.push(id);
    return true;
  }

  async restoreEntry(id: string) {
    this.maybeFail();
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.inTrash = false;
    this.restored.push(id);
    return this.strip(entry);
  }

  // ---- SenseOperations (schema version 13) ----
  /** Request id → sense id, so retrying an "add sense" lands on the same sense. */
  private readonly senseRequests = new Map<string, string>();

  /** The sense operations, reachable as `catalog.senses`. */
  get senses(): SenseOperations {
    return this;
  }

  private findSenseEntry(senseId: string) {
    for (const entry of this.entries.values()) {
      if (entry.senses.some((item) => item.id === senseId)) return entry;
    }
    return null;
  }

  async listSenses(vocabularyId: string): Promise<Sense[]> {
    const entry = this.entries.get(vocabularyId);
    if (!entry) return [];
    return [...entry.senses].sort((a, b) => a.position - b.position);
  }

  async getSense(id: string): Promise<Sense | null> {
    return this.findSenseEntry(id)?.senses.find((item) => item.id === id) ?? null;
  }

  async createSense(
    vocabularyId: string,
    sense: { meaning: string | null; definition: string | null; example: string | null; requestId: string },
    options?: { resume?: boolean; archived?: boolean },
  ): Promise<{ sense: Sense; created: boolean }> {
    const entry = this.entries.get(vocabularyId);
    if (!entry) throw new Error('unknown entry');
    this.maybeFail();
    // A retry of the same action carries the same request id and lands on the same sense.
    const seen = this.senseRequests.get(sense.requestId);
    if (seen !== undefined) {
      const found = entry.senses.find((item) => item.id === seen);
      if (found) {
        // The import's completion call may still set the archive flag its
        // file carried; nothing else about a stored sense changes.
        if (options?.archived === true && !found.archived) {
          found.archived = true;
          found.version += 1;
          entry.sensesVersion += 1;
        }
        return { sense: found, created: false };
      }
    }
    const made: Sense = {
      id: `sense-${this.nextId++}`,
      position: entry.senses.reduce((highest, item) => Math.max(highest, item.position), -1) + 1,
      meaning: sense.meaning,
      definition: sense.definition,
      example: sense.example,
      archived: options?.archived === true,
      version: 1,
    };
    entry.senses.push(made);
    entry.sensesVersion += 1;
    this.senseRequests.set(sense.requestId, made.id);
    return { sense: made, created: true };
  }

  async updateSense(
    id: string,
    patch: { meaning?: string | null; definition?: string | null; example?: string | null; expectedVersion: number },
  ): Promise<Sense | 'stale' | 'not_found'> {
    const entry = this.findSenseEntry(id);
    const sense = entry?.senses.find((item) => item.id === id);
    if (!entry || !sense) return 'not_found';
    if (sense.version !== patch.expectedVersion || sense.archived) return 'stale';
    if (patch.meaning !== undefined) sense.meaning = patch.meaning;
    if (patch.definition !== undefined) sense.definition = patch.definition;
    if (patch.example !== undefined) sense.example = patch.example;
    sense.version += 1;
    entry.sensesVersion += 1;
    return sense;
  }

  async reorderSenses(
    vocabularyId: string,
    senseIds: string[],
    expectedVersion: number,
  ): Promise<'ok' | 'stale' | 'not_found'> {
    const entry = this.entries.get(vocabularyId);
    if (!entry) return 'not_found';
    if (entry.sensesVersion !== expectedVersion) return 'stale';
    const live = entry.senses.filter((item) => !item.archived);
    if (senseIds.length !== live.length || senseIds.some((id) => !live.some((item) => item.id === id))) {
      return 'not_found';
    }
    senseIds.forEach((id, index) => {
      const sense = live.find((item) => item.id === id);
      if (sense) sense.position = index;
    });
    // The archived senses pack in behind, so a restore starts past them.
    entry.senses
      .filter((item) => item.archived)
      .sort((a, b) => a.position - b.position)
      .forEach((sense, index) => {
        sense.position = senseIds.length + index;
      });
    entry.senses.sort((a, b) => a.position - b.position);
    entry.sensesVersion += 1;
    return 'ok';
  }

  async archiveSense(id: string, expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'> {
    const entry = this.findSenseEntry(id);
    const sense = entry?.senses.find((item) => item.id === id);
    if (!entry || !sense) return 'not_found';
    if (sense.version !== expectedVersion || sense.archived) return 'stale';
    sense.archived = true;
    sense.version += 1;
    entry.sensesVersion += 1;
    return 'ok';
  }

  async restoreSense(id: string, expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'> {
    const entry = this.findSenseEntry(id);
    const sense = entry?.senses.find((item) => item.id === id);
    if (!entry || !sense) return 'not_found';
    if (sense.version !== expectedVersion || !sense.archived) return 'stale';
    sense.position = entry.senses.reduce((highest, item) => Math.max(highest, item.position), -1) + 1;
    sense.archived = false;
    sense.version += 1;
    entry.sensesVersion += 1;
    return 'ok';
  }
}
