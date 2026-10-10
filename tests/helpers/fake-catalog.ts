import { normalizeWord } from '../../shared/text.js';
import type { EntryChanges, EntryData, NewEntry, VocabularyCatalog } from '../../server/vocabulary-catalog.js';
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

  async createEntry({ requestId: _requestId, ...entry }: NewEntry) {
    void _requestId;
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
    Object.assign(entry, changes);
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
}
