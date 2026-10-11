import { normalizeId, type LibraryResponse } from '../shared/api.js';
import {
  LIBRARY_LIMITS,
  collectionKey,
  orderPair,
  tidyName,
  type Collection,
  type ExtraExample,
  type Relation,
  type RelationKind,
} from '../shared/library.js';
import { HttpError } from './errors.js';
import type { LibraryStore, StoredExample, StoredRelation } from './library-store.js';
import type { VocabularyCatalog } from './vocabulary-catalog.js';

export interface LibraryServiceOptions {
  store: LibraryStore;
  /** Used to tell live words from trashed and foreign ones. */
  catalog: VocabularyCatalog;
  /** The owner allowed the app to change stored data. */
  writesRequested: boolean;
}

const toExample = (stored: StoredExample): ExtraExample => ({ ...stored });
const toRelation = (stored: StoredRelation): Relation => ({
  id: stored.id,
  kind: stored.kind,
  a: stored.lowId,
  b: stored.highId,
});

const text = (value: string): string => value.normalize('NFC').trim();

/**
 * Collections, further examples and relationships between words, for one
 * account. Nothing here reads or writes a word's content, schedule or review
 * history; it only organises words that already exist.
 */
export class LibraryService {
  constructor(private readonly options: LibraryServiceOptions) {}

  private requireStore(): LibraryStore {
    const { store } = this.options;
    if (!store.available) {
      throw new HttpError(
        409,
        'not_supported',
        'Collections, examples and related words cannot be kept yet: the database needs its latest update.',
      );
    }
    if (!this.options.writesRequested) {
      throw new HttpError(403, 'read_only', 'Saving is switched off, so nothing was changed.');
    }
    return store;
  }

  /** The word, if it is a live word of this account; otherwise a 404. */
  private async requireWord(id: string): Promise<string> {
    const wordId = normalizeId(id);
    if ((await this.options.catalog.getEntry(wordId)) === null) {
      throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
    }
    return wordId;
  }

  private collectionName(raw: string): { name: string; key: string } {
    const name = tidyName(raw);
    if (name === '' || name.length > LIBRARY_LIMITS.collectionName) {
      throw new HttpError(
        400,
        'invalid_request',
        `A collection name is 1 to ${LIBRARY_LIMITS.collectionName} characters.`,
      );
    }
    return { name, key: collectionKey(name) };
  }

  private sentence(raw: string): string {
    const sentence = text(raw);
    if (sentence === '' || sentence.length > LIBRARY_LIMITS.example) {
      throw new HttpError(400, 'invalid_request', `An example is 1 to ${LIBRARY_LIMITS.example} characters.`);
    }
    return sentence;
  }

  private source(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const source = text(raw);
    if (source.length > LIBRARY_LIMITS.source) {
      throw new HttpError(400, 'invalid_request', `A source note is at most ${LIBRARY_LIMITS.source} characters.`);
    }
    return source === '' ? null : source;
  }

  /** Everything, with words in the trash left out of every list. */
  async load(): Promise<LibraryResponse> {
    const { store, catalog } = this.options;
    if (!store.available) return { available: false, collections: [], examples: [], relations: [] };

    const [stored, { entries }] = await Promise.all([store.load(), catalog.listEntries()]);
    const live = new Set(entries.map((entry) => entry.id));
    const members = new Map<string, string[]>();
    for (const item of stored.items) {
      if (!live.has(item.vocabularyId)) continue;
      const list = members.get(item.collectionId) ?? [];
      list.push(item.vocabularyId);
      members.set(item.collectionId, list);
    }
    return {
      available: true,
      collections: stored.collections.map((collection) => ({ ...collection, wordIds: members.get(collection.id) ?? [] })),
      examples: stored.examples.filter((example) => live.has(example.vocabularyId)).map(toExample),
      relations: stored.relations
        .filter((relation) => live.has(relation.lowId) && live.has(relation.highId))
        .map(toRelation),
    };
  }

  /** One collection with its live words, or a 404. Used to narrow a review. */
  async collection(id: string): Promise<Collection> {
    const wanted = normalizeId(id);
    const found = (await this.load()).collections.find((collection) => collection.id === wanted);
    if (found === undefined) throw new HttpError(404, 'not_found', 'There is no such collection.');
    return found;
  }

  // ---- Collections ----

  async createCollection(rawName: string): Promise<Collection> {
    const store = this.requireStore();
    const { name, key } = this.collectionName(rawName);
    const created = await store.createCollection(name, key);
    if (created === 'duplicate') {
      throw new HttpError(409, 'duplicate', `You already have a collection called “${name}”.`);
    }
    return { ...created, wordIds: [] };
  }

  async renameCollection(id: string, rawName: string): Promise<Collection> {
    const store = this.requireStore();
    const { name, key } = this.collectionName(rawName);
    const renamed = await store.renameCollection(normalizeId(id), name, key);
    if (renamed === null) throw new HttpError(404, 'not_found', 'There is no such collection.');
    if (renamed === 'duplicate') {
      throw new HttpError(409, 'duplicate', `You already have a collection called “${name}”.`);
    }
    return this.collection(renamed.id);
  }

  /** Removes the collection and its memberships. The words themselves are not touched. */
  async deleteCollection(id: string): Promise<{ id: string; deleted: true }> {
    const store = this.requireStore();
    const wanted = normalizeId(id);
    if (!(await store.deleteCollection(wanted))) throw new HttpError(404, 'not_found', 'There is no such collection.');
    return { id: wanted, deleted: true };
  }

  async setMembership(collectionId: string, wordId: string, member: boolean): Promise<Collection> {
    const store = this.requireStore();
    const word = await this.requireWord(wordId);
    if (!(await store.setMembership(normalizeId(collectionId), word, member))) {
      throw new HttpError(404, 'not_found', 'There is no such collection.');
    }
    return this.collection(collectionId);
  }

  // ---- Examples ----

  async addExample(
    wordId: string,
    input: { sentence: string; source?: string | null; preferred?: boolean },
  ): Promise<ExtraExample> {
    const store = this.requireStore();
    const word = await this.requireWord(wordId);
    const created = await store.addExample(word, this.sentence(input.sentence), this.source(input.source));
    if (created === null) throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
    if (input.preferred === true) {
      await store.setPreferredExample(created.id, true);
      return { ...toExample(created), preferred: true };
    }
    return toExample(created);
  }

  async updateExample(
    id: string,
    input: { sentence?: string; source?: string | null; preferred?: boolean },
  ): Promise<ExtraExample> {
    const store = this.requireStore();
    const exampleId = normalizeId(id);
    const missing = () => new HttpError(404, 'not_found', 'There is no such example.');
    const existing = await store.getExample(exampleId);
    // An example of a word that has gone to the trash is out of reach until the word is restored.
    if (existing === null || (await this.options.catalog.getEntry(existing.vocabularyId)) === null) throw missing();

    const changes: { sentence?: string; source?: string | null } = {};
    if (input.sentence !== undefined) changes.sentence = this.sentence(input.sentence);
    if (input.source !== undefined) changes.source = this.source(input.source);
    if (Object.keys(changes).length > 0 && (await store.updateExample(exampleId, changes)) === null) throw missing();
    if (input.preferred !== undefined && !(await store.setPreferredExample(exampleId, input.preferred))) throw missing();

    const updated = await store.getExample(exampleId);
    if (updated === null) throw missing();
    return toExample(updated);
  }

  async deleteExample(id: string): Promise<{ id: string; deleted: true }> {
    const store = this.requireStore();
    const exampleId = normalizeId(id);
    if (!(await store.deleteExample(exampleId))) throw new HttpError(404, 'not_found', 'There is no such example.');
    return { id: exampleId, deleted: true };
  }

  // ---- Relationships ----

  /**
   * Links two of the account's own live words. Entering the same link again,
   * from either word, returns the one that exists.
   */
  async addRelation(fromId: string, toId: string, kind: RelationKind): Promise<Relation> {
    const store = this.requireStore();
    const [from, to] = await Promise.all([this.requireWord(fromId), this.requireWord(toId)]);
    const pair = orderPair(from, to);
    if (pair === null) throw new HttpError(400, 'invalid_request', 'A word cannot be related to itself.');
    const stored = await store.addRelation(pair[0], pair[1], kind);
    if (stored === null) throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
    return toRelation(stored);
  }

  async deleteRelation(id: string): Promise<{ id: string; deleted: true }> {
    const store = this.requireStore();
    const relationId = normalizeId(id);
    if (!(await store.deleteRelation(relationId))) throw new HttpError(404, 'not_found', 'There is no such link.');
    return { id: relationId, deleted: true };
  }
}
