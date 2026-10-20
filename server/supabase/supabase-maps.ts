/**
 * Vocabulary Maps over Supabase: the store, and everything the service needs
 * to know about words. For one signed-in user; which rows that user can reach
 * is decided by the database, the same as the library.
 *
 * Nothing here writes a word's content or schedule. The only call that can
 * create vocabulary is `saveWord`, and the service reaches it only when the
 * learner has pointed at a candidate and asked for it to become a word.
 */
import { isVocabMapType, type VocabMapType } from '../../shared/vocab-map.js';
import type { MapWordSource } from '../vocab-maps-service.js';
import type { StoredMap, StoredMapEdge, StoredMapNode, VocabMapsStore } from '../vocab-maps-store.js';
import type { VocabularyService } from '../vocabulary-service.js';
import { DatabaseError, type VocabMapEdgeRow, type VocabMapNodeRow, type VocabMapRow, type VocabularyDatabase } from './supabase-database.js';

/** A map row, or null for no row — or for one whose type this version does not know. */
function toStoredMap(row: VocabMapRow | null): StoredMap | null {
  if (row === null || !isVocabMapType(row.type)) return null;
  return {
    id: row.id,
    type: row.type satisfies VocabMapType,
    title: row.title,
    description: row.description,
    revision: row.revision,
    requestId: row.request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredNode(row: VocabMapNodeRow): StoredMapNode {
  return {
    id: row.id,
    mapId: row.map_id,
    kind: row.kind === 'candidate' ? 'candidate' : 'saved',
    vocabularyId: row.vocabulary_id,
    senseId: row.sense_id,
    label: row.label,
    note: row.note,
    group: row.group_key,
    step: row.step,
    x: row.x,
    y: row.y,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

function toStoredEdge(row: VocabMapEdgeRow): StoredMapEdge {
  return {
    id: row.id,
    mapId: row.map_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    kind: row.kind as StoredMapEdge['kind'],
    pattern: row.pattern,
    note: row.note,
    createdAt: row.created_at,
  };
}

/**
 * Maps rows to the store's shapes. A map whose type a future version added
 * is simply not drawn, rather than drawn wrong — the same care the library
 * takes with relationship kinds it does not know.
 */
export function createSupabaseMapsStore(database: VocabularyDatabase): VocabMapsStore {
  return {
    available: true,

    async createMap(input) {
      const row = await database.insertVocabMap(input);
      if (row === 'duplicate') return 'duplicate';
      // The type came from the service, which only offers known ones.
      const stored = toStoredMap(row);
      if (stored === null) throw new DatabaseError('unavailable', 'The database returned a map of a type this version does not know.');
      return stored;
    },
    async findMapByRequestId(requestId) {
      return toStoredMap(await database.findVocabMapByRequestId(requestId));
    },
    getMap: async (id) => toStoredMap(await database.getVocabMap(id)),
    async listMaps() {
      const rows = await database.listVocabMaps();
      return rows.map(toStoredMap).filter((map): map is StoredMap => map !== null);
    },
    async updateMap(id, patch) {
      return toStoredMap(await database.updateVocabMap(id, patch));
    },
    async bumpMapRevision(id) {
      return toStoredMap(await database.bumpVocabMap(id));
    },
    deleteMap: (id) => database.deleteVocabMap(id),

    listNodes: async (mapId) => (await database.listVocabMapNodes(mapId)).map(toStoredNode),
    async getNode(mapId, id) {
      const rows = await database.listVocabMapNodes(mapId);
      const found = rows.find((row) => row.id === id);
      return found === undefined ? null : toStoredNode(found);
    },
    async insertNode(input) {
      const row = await database.insertVocabMapNode({
        mapId: input.mapId,
        kind: input.kind,
        vocabularyId: input.vocabularyId,
        senseId: input.senseId,
        label: input.label,
        note: input.note,
        group: input.group,
        step: input.step,
        x: input.x,
        y: input.y,
        requestId: input.requestId,
      });
      return row === 'duplicate' ? 'duplicate' : toStoredNode(row);
    },
    async findNodeByRequestId(mapId, requestId) {
      return toStoredNodeOrNull(await database.findVocabMapNodeByRequestId(mapId, requestId));
    },
    async findCandidateByLabel(mapId, label) {
      return toStoredNodeOrNull(await database.findVocabMapNodeByLabel(mapId, label));
    },
    async patchNode(mapId, id, patch) {
      return toStoredNodeOrNull(await database.patchVocabMapNode(mapId, id, patch));
    },
    async promoteNode(mapId, id, vocabularyId) {
      return toStoredNodeOrNull(await database.promoteVocabMapNode(mapId, id, vocabularyId));
    },
    deleteNode: (mapId, id) => database.deleteVocabMapNode(mapId, id),

    listEdges: async (mapId) => (await database.listVocabMapEdges(mapId)).map(toStoredEdge),
    async insertEdge(input) {
      const row = await database.insertVocabMapEdge({
        mapId: input.mapId,
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        kind: input.kind,
        pattern: input.pattern,
        note: input.note,
      });
      return row === 'duplicate' ? 'duplicate' : toStoredEdge(row);
    },
    async patchEdge(mapId, id, patch) {
      const row = await database.patchVocabMapEdge(mapId, id, patch);
      return row === null ? null : toStoredEdge(row);
    },
    deleteEdge: (mapId, id) => database.deleteVocabMapEdge(mapId, id),
  };
}

function toStoredNodeOrNull(row: VocabMapNodeRow | null): StoredMapNode | null {
  return row === null ? null : toStoredNode(row);
}

/**
 * What the map service needs to know about words, read live through the
 * caller's own database session. Words are never copied into a map: saved
 * nodes hold an id, and this is where the text behind that id comes from.
 */
export function createSupabaseMapWords(database: VocabularyDatabase, vocabulary: VocabularyService | null): MapWordSource {
  return {
    async words(ids) {
      const found: Array<{ id: string; word: string; meaning: string | null }> = [];
      for (const id of ids) {
        const card = await database.getCard(id);
        // The trash is not a map's business: a trashed word is not offered.
        if (card !== null && card.deleted_at === null) found.push({ id: card.id, word: card.word, meaning: card.meaning });
      }
      return found;
    },
    async sense(id) {
      const row = await database.getSense(id);
      return row === null ? null : { id: row.id, vocabularyId: row.vocabulary_id, meaning: row.meaning };
    },
    async ownsWord(id) {
      const card = await database.getCard(id);
      return card !== null && card.deleted_at === null;
    },
    async overview() {
      const [cards, collections, memberships, relations, senses] = await Promise.all([
        database.listCards(),
        database.listCollections(),
        database.listCollectionItems(),
        database.listRelations(),
        database.countSenses(),
      ]);
      return {
        words: cards.map((card) => ({ id: card.id, word: card.word, meaning: card.meaning, updatedAt: card.updated_at })),
        collections: collections.map((collection) => ({ id: collection.id, name: collection.name })),
        memberships: memberships.map((item) => ({ collectionId: item.collection_id, vocabularyId: item.vocabulary_id })),
        relations: relations.map((relation) => ({ lowId: relation.low_id, highId: relation.high_id, kind: relation.kind })),
        senses,
      };
    },
    async saveWord(request) {
      if (vocabulary === null) {
        // Without the word service there is no word path to go through, so
        // a candidate cannot be saved — and saying so beats pretending.
        throw new Error('Saving a suggested word needs the vocabulary service.');
      }
      const { entry } = await vocabulary.create({ word: request.word, requestId: request.requestId });
      return { id: entry.id };
    },
  };
}
