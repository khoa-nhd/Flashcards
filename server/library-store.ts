import type { RelationKind } from '../shared/library.js';

export interface StoredCollection {
  id: string;
  name: string;
}

export interface StoredExample {
  id: string;
  vocabularyId: string;
  sentence: string;
  source: string | null;
  preferred: boolean;
}

export interface StoredRelation {
  id: string;
  lowId: string;
  highId: string;
  kind: RelationKind;
}

export interface StoredLibrary {
  collections: StoredCollection[];
  /** Which word is in which collection. May name words that are in the trash. */
  items: Array<{ collectionId: string; vocabularyId: string }>;
  examples: StoredExample[];
  relations: StoredRelation[];
}

/**
 * Where one account's collections, further examples and relationships are
 * kept. It stores what it is given; the rules (what a name may be, which
 * words may be linked) live in LibraryService.
 */
export interface LibraryStore {
  /** False where the store has nowhere to keep any of this; every read is then empty. */
  readonly available: boolean;
  load(): Promise<StoredLibrary>;

  /** `duplicate`: the account already has a collection with this name key. */
  createCollection(name: string, nameKey: string): Promise<StoredCollection | 'duplicate'>;
  /** `null`: no such collection of the caller's. */
  renameCollection(id: string, name: string, nameKey: string): Promise<StoredCollection | 'duplicate' | null>;
  /** Removes the collection and its memberships. Never a word. */
  deleteCollection(id: string): Promise<boolean>;
  /** False when the collection or the word is not the caller's. Adding twice, or removing what is not there, is fine. */
  setMembership(collectionId: string, vocabularyId: string, member: boolean): Promise<boolean>;

  /** `null`: no such word of the caller's. */
  addExample(vocabularyId: string, sentence: string, source: string | null): Promise<StoredExample | null>;
  getExample(id: string): Promise<StoredExample | null>;
  updateExample(id: string, changes: { sentence?: string; source?: string | null }): Promise<StoredExample | null>;
  /** Marks one example as its word's preferred one, clearing the mark from the others, or clears it. */
  setPreferredExample(id: string, preferred: boolean): Promise<boolean>;
  deleteExample(id: string): Promise<boolean>;

  /**
   * Links two words, given in stored order. Returns the existing link when
   * the pair is already linked in this way; `null` when a word is not the caller's.
   */
  addRelation(lowId: string, highId: string, kind: RelationKind): Promise<StoredRelation | null>;
  deleteRelation(id: string): Promise<boolean>;
}

const EMPTY: StoredLibrary = { collections: [], items: [], examples: [], relations: [] };

const unavailable = (): never => {
  throw new Error('This store cannot keep collections, examples or relationships.');
};

/** For a store whose schema has no room for any of this yet. */
export const NO_LIBRARY_STORE: LibraryStore = {
  available: false,
  load: async () => EMPTY,
  createCollection: async () => unavailable(),
  renameCollection: async () => unavailable(),
  deleteCollection: async () => unavailable(),
  setMembership: async () => unavailable(),
  addExample: async () => unavailable(),
  getExample: async () => null,
  updateExample: async () => unavailable(),
  setPreferredExample: async () => unavailable(),
  deleteExample: async () => unavailable(),
  addRelation: async () => unavailable(),
  deleteRelation: async () => unavailable(),
};

/**
 * Everything in memory, for the built-in sample data. `ownsWord` says whether
 * a word exists, standing in for the foreign keys of the real store.
 */
export function createMemoryLibraryStore(ownsWord: (id: string) => boolean): LibraryStore {
  const collections = new Map<string, StoredCollection & { key: string }>();
  const items = new Set<string>();
  const examples = new Map<string, StoredExample>();
  const relations = new Map<string, StoredRelation>();
  let counter = 0;
  const nextId = () => `00000000-0000-4000-a000-${String((counter += 1)).padStart(12, '0')}`;
  const itemKey = (collectionId: string, vocabularyId: string) => `${collectionId} ${vocabularyId}`;
  const strip = ({ id, name }: StoredCollection): StoredCollection => ({ id, name });

  return {
    available: true,

    async load() {
      return {
        collections: [...collections.values()].sort((a, b) => a.key.localeCompare(b.key)).map(strip),
        items: [...items].map((key) => {
          const [collectionId = '', vocabularyId = ''] = key.split(' ');
          return { collectionId, vocabularyId };
        }),
        examples: [...examples.values()].map((example) => ({ ...example })),
        relations: [...relations.values()].map((relation) => ({ ...relation })),
      };
    },

    async createCollection(name, nameKey) {
      if ([...collections.values()].some((existing) => existing.key === nameKey)) return 'duplicate';
      const created = { id: nextId(), name, key: nameKey };
      collections.set(created.id, created);
      return strip(created);
    },

    async renameCollection(id, name, nameKey) {
      const existing = collections.get(id);
      if (existing === undefined) return null;
      if ([...collections.values()].some((other) => other.id !== id && other.key === nameKey)) return 'duplicate';
      existing.name = name;
      existing.key = nameKey;
      return strip(existing);
    },

    async deleteCollection(id) {
      if (!collections.delete(id)) return false;
      for (const key of [...items]) if (key.startsWith(`${id} `)) items.delete(key);
      return true;
    },

    async setMembership(collectionId, vocabularyId, member) {
      if (!collections.has(collectionId) || !ownsWord(vocabularyId)) return false;
      if (member) items.add(itemKey(collectionId, vocabularyId));
      else items.delete(itemKey(collectionId, vocabularyId));
      return true;
    },

    async addExample(vocabularyId, sentence, source) {
      if (!ownsWord(vocabularyId)) return null;
      const created: StoredExample = { id: nextId(), vocabularyId, sentence, source, preferred: false };
      examples.set(created.id, created);
      return { ...created };
    },

    async getExample(id) {
      const found = examples.get(id);
      return found === undefined ? null : { ...found };
    },

    async updateExample(id, changes) {
      const found = examples.get(id);
      if (found === undefined) return null;
      if (changes.sentence !== undefined) found.sentence = changes.sentence;
      if (changes.source !== undefined) found.source = changes.source;
      return { ...found };
    },

    async setPreferredExample(id, preferred) {
      const found = examples.get(id);
      if (found === undefined) return false;
      for (const other of examples.values()) if (other.vocabularyId === found.vocabularyId) other.preferred = false;
      found.preferred = preferred;
      return true;
    },

    async deleteExample(id) {
      return examples.delete(id);
    },

    async addRelation(lowId, highId, kind) {
      if (!ownsWord(lowId) || !ownsWord(highId)) return null;
      const existing = [...relations.values()].find(
        (relation) => relation.lowId === lowId && relation.highId === highId && relation.kind === kind,
      );
      if (existing !== undefined) return { ...existing };
      const created: StoredRelation = { id: nextId(), lowId, highId, kind };
      relations.set(created.id, created);
      return { ...created };
    },

    async deleteRelation(id) {
      return relations.delete(id);
    },
  };
}
