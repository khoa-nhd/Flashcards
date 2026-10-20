import type { DiscoveryContentKind, DiscoveryPosition, DiscoverySourceKind } from '../shared/discovery.js';

export interface StoredDiscoverySource {
  id: string;
  kind: DiscoverySourceKind;
  title: string;
  origin: string;
  content: string;
  contentKind: DiscoveryContentKind;
  position: DiscoveryPosition;
  revision: number;
  requestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDiscoveryMark {
  id: string;
  sourceId: string;
  label: string;
  context: string;
  offset: number | null;
  cueStart: number | null;
  cueEnd: number | null;
  note: string;
  /** Set only by an explicit save. Null: the selection is still marked for later. */
  vocabularyId: string | null;
  savedAt: string | null;
  requestId: string | null;
  createdAt: string;
}

/**
 * Where one account's discovery content is kept. It stores what it is
 * given; the rules (what a mark may claim, what a save must go through)
 * live in DiscoveryService, against the same shared contracts the browser
 * uses.
 */
export interface DiscoveryStore {
  /** False where the store has nowhere to keep any of this; the endpoints then say the database is behind. */
  readonly available: boolean;

  /** `duplicate`: the account already created a source with this request id. */
  createSource(input: {
    kind: DiscoverySourceKind;
    title: string;
    origin: string;
    content: string;
    contentKind: DiscoveryContentKind;
    position: DiscoveryPosition;
    requestId: string | null;
  }): Promise<StoredDiscoverySource | 'duplicate'>;
  findSourceByRequestId(requestId: string): Promise<StoredDiscoverySource | null>;
  /** `null`: no such source of the caller's. */
  getSource(id: string): Promise<StoredDiscoverySource | null>;
  /** Every source of the caller's, most recently touched first. */
  listSources(): Promise<StoredDiscoverySource[]>;
  updateSource(id: string, patch: { title?: string }): Promise<StoredDiscoverySource | null>;
  /** A position save: where the reader or listener was. Never the revision. */
  updatePosition(id: string, position: DiscoveryPosition): Promise<StoredDiscoverySource | null>;
  /** One title edit recorded: the revision moves on by one. */
  bumpSourceRevision(id: string): Promise<StoredDiscoverySource | null>;
  /** Removes the source and its marks. Never a word. */
  deleteSource(id: string): Promise<boolean>;

  /** Every mark, or just one source's, oldest first. */
  listMarks(sourceId?: string): Promise<StoredDiscoveryMark[]>;
  getMark(id: string): Promise<StoredDiscoveryMark | null>;
  /**
   * `duplicate`: the same request id, or — for a still-marked selection —
   * the same label in the same source, already exists; that mark is the
   * mark.
   */
  insertMark(input: Omit<StoredDiscoveryMark, 'id' | 'createdAt'>): Promise<StoredDiscoveryMark | 'duplicate'>;
  findMarkByRequestId(requestId: string): Promise<StoredDiscoveryMark | null>;
  findMarkByLabel(sourceId: string, label: string): Promise<StoredDiscoveryMark | null>;
  /** The latest mark linking a word to where it was found, if any. */
  findMarkByVocabulary(vocabularyId: string): Promise<StoredDiscoveryMark | null>;
  patchMark(id: string, patch: { note?: string; vocabularyId?: string; savedAt: string }): Promise<StoredDiscoveryMark | null>;
  /** Takes a dismissed selection out. Never a word. */
  deleteMark(id: string): Promise<boolean>;
}

const unavailable = (): never => {
  throw new Error('This store cannot keep discovery content.');
};

/** For a store whose schema has no room for any of this yet (before schema version 19). */
export const NO_DISCOVERY_STORE: DiscoveryStore = {
  available: false,
  createSource: async () => unavailable(),
  findSourceByRequestId: async () => null,
  getSource: async () => null,
  listSources: async () => [],
  updateSource: async () => unavailable(),
  updatePosition: async () => unavailable(),
  bumpSourceRevision: async () => null,
  deleteSource: async () => false,
  listMarks: async () => [],
  getMark: async () => null,
  insertMark: async () => unavailable(),
  findMarkByRequestId: async () => null,
  findMarkByLabel: async () => null,
  findMarkByVocabulary: async () => null,
  patchMark: async () => unavailable(),
  deleteMark: async () => false,
};

/**
 * Everything in memory, for the built-in sample data. The foreign keys of
 * the real store are enforced by the service: words are reached only
 * through the vocabulary service it is given.
 */
export function createMemoryDiscoveryStore(now: () => Date = () => new Date()): DiscoveryStore {
  const sources = new Map<string, StoredDiscoverySource>();
  const marks = new Map<string, StoredDiscoveryMark>();
  let counter = 0;
  const nextId = () => `10000000-0000-4000-b000-${String((counter += 1)).padStart(12, '0')}`;
  const stamp = () => now().toISOString();

  return {
    available: true,

    async createSource(input) {
      if (input.requestId !== null && [...sources.values()].some((source) => source.requestId === input.requestId)) {
        return 'duplicate';
      }
      const created: StoredDiscoverySource = { ...input, id: nextId(), revision: 1, createdAt: stamp(), updatedAt: stamp() };
      sources.set(created.id, created);
      return { ...created };
    },

    async findSourceByRequestId(requestId) {
      const found = [...sources.values()].find((source) => source.requestId === requestId);
      return found === undefined ? null : { ...found };
    },

    async getSource(id) {
      const found = sources.get(id);
      return found === undefined ? null : { ...found };
    },

    async listSources() {
      return [...sources.values()]
        .sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt)))
        .map((source) => ({ ...source }));
    },

    async updateSource(id, patch) {
      const found = sources.get(id);
      if (found === undefined) return null;
      if (patch.title !== undefined) found.title = patch.title;
      found.updatedAt = stamp();
      return { ...found };
    },

    async updatePosition(id, position) {
      const found = sources.get(id);
      if (found === undefined) return null;
      found.position = { ...position };
      found.updatedAt = stamp();
      return { ...found };
    },

    async bumpSourceRevision(id) {
      const found = sources.get(id);
      if (found === undefined) return null;
      found.revision += 1;
      found.updatedAt = stamp();
      return { ...found };
    },

    async deleteSource(id) {
      if (!sources.delete(id)) return false;
      for (const mark of [...marks.values()]) if (mark.sourceId === id) marks.delete(mark.id);
      return true;
    },

    async listMarks(sourceId) {
      return [...marks.values()]
        .filter((mark) => sourceId === undefined || mark.sourceId === sourceId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((mark) => ({ ...mark }));
    },

    async getMark(id) {
      const found = marks.get(id);
      return found === undefined ? null : { ...found };
    },

    async insertMark(input) {
      const existing = [...marks.values()].find(
        (mark) =>
          (input.requestId !== null && mark.requestId === input.requestId) ||
          (mark.sourceId === input.sourceId && input.savedAt === null && mark.savedAt === null && mark.label === input.label),
      );
      if (existing !== undefined) return 'duplicate';
      const created: StoredDiscoveryMark = { ...input, id: nextId(), createdAt: stamp() };
      marks.set(created.id, created);
      return { ...created };
    },

    async findMarkByRequestId(requestId) {
      const found = [...marks.values()].find((mark) => mark.requestId === requestId);
      return found === undefined ? null : { ...found };
    },

    async findMarkByLabel(sourceId, label) {
      const found = [...marks.values()].find((mark) => mark.sourceId === sourceId && mark.label === label);
      return found === undefined ? null : { ...found };
    },

    async findMarkByVocabulary(vocabularyId) {
      const found = [...marks.values()]
        .filter((mark) => mark.vocabularyId === vocabularyId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return found[0] === undefined ? null : { ...found[0] };
    },

    async patchMark(id, patch) {
      const found = marks.get(id);
      if (found === undefined) return null;
      if (patch.note !== undefined) found.note = patch.note;
      if (patch.vocabularyId !== undefined) found.vocabularyId = patch.vocabularyId;
      found.savedAt = patch.savedAt;
      return { ...found };
    },

    async deleteMark(id) {
      return marks.delete(id);
    },
  };
}
