import { RELATION_KINDS, type RelationKind } from '../../shared/library.js';
import type { LibraryStore, StoredExample, StoredRelation } from '../library-store.js';
import type { ExampleRow, RelationRow, VocabularyDatabase } from './supabase-database.js';

const toExample = (row: ExampleRow): StoredExample => ({
  id: row.id,
  vocabularyId: row.vocabulary_id,
  sentence: row.sentence,
  source: row.source,
  preferred: row.preferred,
});

const isKind = (kind: string): kind is RelationKind => RELATION_KINDS.includes(kind as RelationKind);

/** A stored link, or `null` for one of a kind this version of the app does not know. */
function toRelation(row: RelationRow): StoredRelation | null {
  return isKind(row.kind) ? { id: row.id, lowId: row.low_id, highId: row.high_id, kind: row.kind } : null;
}

/**
 * Collections, further examples and relationships kept in Supabase, for one
 * signed-in user. Which rows that user can reach is decided by the database.
 */
export function createSupabaseLibraryStore(database: VocabularyDatabase): LibraryStore {
  return {
    available: true,

    async load() {
      const [collections, items, examples, relations] = await Promise.all([
        database.listCollections(),
        database.listCollectionItems(),
        database.listExamples(),
        database.listRelations(),
      ]);
      return {
        collections,
        items: items.map((item) => ({ collectionId: item.collection_id, vocabularyId: item.vocabulary_id })),
        examples: examples.map(toExample),
        relations: relations.map(toRelation).filter((relation): relation is StoredRelation => relation !== null),
      };
    },

    createCollection: (name, nameKey) => database.insertCollection(name, nameKey),
    renameCollection: (id, name, nameKey) => database.renameCollection(id, name, nameKey),
    deleteCollection: (id) => database.deleteCollection(id),
    setMembership: (collectionId, vocabularyId, member) =>
      member ? database.addCollectionItem(collectionId, vocabularyId) : database.removeCollectionItem(collectionId, vocabularyId),

    async addExample(vocabularyId, sentence, source) {
      const row = await database.insertExample(vocabularyId, sentence, source);
      return row === null ? null : toExample(row);
    },
    async getExample(id) {
      const row = await database.getExample(id);
      return row === null ? null : toExample(row);
    },
    async updateExample(id, changes) {
      const row = await database.updateExample(id, changes);
      return row === null ? null : toExample(row);
    },
    setPreferredExample: (id, preferred) => database.setPreferredExample(id, preferred),
    deleteExample: (id) => database.deleteExample(id),

    async addRelation(lowId, highId, kind) {
      const row = await database.insertRelation(lowId, highId, kind);
      return row === null ? null : toRelation(row);
    },
    deleteRelation: (id) => database.deleteRelation(id),
  };
}
