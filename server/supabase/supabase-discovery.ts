/**
 * Discovery & Input over Supabase: the store, and the one read the
 * generate step needs from the library. For one signed-in user; which rows
 * that user can reach is decided by the database, the same as the library.
 *
 * Nothing here writes a word's content or schedule. The only calls that
 * reach vocabulary are the ones the service reaches through
 * VocabularyService — the learner's explicit Save.
 */
import type { DiscoveryPosition } from '../../shared/discovery.js';
import type { DiscoveryLibrarySource } from '../discovery-service.js';
import type { DiscoveryStore, StoredDiscoveryMark, StoredDiscoverySource } from '../discovery-store.js';
import {
  type DiscoveryMarkRow,
  type DiscoverySourceRow,
  type VocabularyDatabase,
} from './supabase-database.js';

/** jsonb as it comes back: keep the two keys a position has, ignore anything else. */
function toPosition(value: Record<string, unknown>): DiscoveryPosition {
  const position: DiscoveryPosition = {};
  if (typeof value.offset === 'number' && Number.isFinite(value.offset)) position.offset = value.offset;
  if (typeof value.seconds === 'number' && Number.isFinite(value.seconds)) position.seconds = value.seconds;
  return position;
}

function toStoredSource(row: DiscoverySourceRow): StoredDiscoverySource {
  return {
    id: row.id,
    kind: row.kind as StoredDiscoverySource['kind'],
    title: row.title,
    origin: row.origin,
    content: row.content,
    contentKind: row.content_kind === 'transcript' ? 'transcript' : 'plain',
    position: toPosition(row.position),
    revision: row.revision,
    requestId: row.request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredMark(row: DiscoveryMarkRow): StoredDiscoveryMark {
  return {
    id: row.id,
    sourceId: row.source_id,
    label: row.label,
    context: row.context,
    offset: row.char_offset,
    cueStart: row.cue_start,
    cueEnd: row.cue_end,
    note: row.note,
    vocabularyId: row.vocabulary_id,
    savedAt: row.saved_at,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

/** Discovery rows to the store's shapes. A kind a future version added is simply not opened. */
export function createSupabaseDiscoveryStore(database: VocabularyDatabase): DiscoveryStore {
  return {
    available: true,

    async createSource(input) {
      const row = await database.insertDiscoverySource(input);
      if (row === 'duplicate') return 'duplicate';
      return toStoredSource(row);
    },
    findSourceByRequestId: async (requestId) => {
      const row = await database.findDiscoverySourceByRequestId(requestId);
      return row === null ? null : toStoredSource(row);
    },
    getSource: async (id) => {
      const row = await database.getDiscoverySource(id);
      return row === null ? null : toStoredSource(row);
    },
    listSources: async () => (await database.listDiscoverySources()).map(toStoredSource),
    async updateSource(id, patch) {
      const row = await database.updateDiscoverySource(id, patch);
      return row === null ? null : toStoredSource(row);
    },
    async updatePosition(id, position) {
      const row = await database.updateDiscoveryPosition(id, position);
      return row === null ? null : toStoredSource(row);
    },
    async bumpSourceRevision(id) {
      const row = await database.bumpDiscoverySource(id);
      return row === null ? null : toStoredSource(row);
    },
    deleteSource: (id) => database.deleteDiscoverySource(id),

    listMarks: async (sourceId) => (await database.listDiscoveryMarks(sourceId)).map(toStoredMark),
    async getMark(id) {
      const row = await database.getDiscoveryMark(id);
      return row === null ? null : toStoredMark(row);
    },
    async insertMark(input) {
      const row = await database.insertDiscoveryMark({
        sourceId: input.sourceId,
        label: input.label,
        context: input.context,
        offset: input.offset,
        cueStart: input.cueStart,
        cueEnd: input.cueEnd,
        note: input.note,
        vocabularyId: input.vocabularyId,
        savedAt: input.savedAt,
        requestId: input.requestId,
      });
      return row === 'duplicate' ? 'duplicate' : toStoredMark(row);
    },
    async findMarkByRequestId(requestId) {
      const row = await database.findDiscoveryMarkByRequestId(requestId);
      return row === null ? null : toStoredMark(row);
    },
    async findMarkByLabel(sourceId, label) {
      const row = await database.findDiscoveryMarkByLabel(sourceId, label);
      return row === null ? null : toStoredMark(row);
    },
    async findMarkByVocabulary(vocabularyId) {
      const row = await database.findDiscoveryMarkByVocabulary(vocabularyId);
      return row === null ? null : toStoredMark(row);
    },
    async patchMark(id, patch) {
      const row = await database.patchDiscoveryMark(id, patch);
      return row === null ? null : toStoredMark(row);
    },
    deleteMark: (id) => database.deleteDiscoveryMark(id),
  };
}

/**
 * The generate step's one read: a named collection with the words in it.
 * It looks; it never writes — the collection and its members are exactly
 * as they were when the learner asked for a draft.
 */
export function createSupabaseDiscoveryLibrary(database: VocabularyDatabase): DiscoveryLibrarySource {
  return {
    async findCollection(id) {
      const [collections, items, cards] = await Promise.all([
        database.listCollections(),
        database.listCollectionItems(),
        database.listCards(),
      ]);
      const collection = collections.find((candidate) => candidate.id === id);
      if (collection === undefined) return null;
      const words = new Map(cards.map((card) => [card.id, card.word]));
      const members: string[] = [];
      for (const item of items) {
        if (item.collection_id !== id) continue;
        const word = words.get(item.vocabulary_id);
        if (word !== undefined) members.push(word);
      }
      return { name: collection.name, words: members };
    },
  };
}
