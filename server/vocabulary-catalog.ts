import type { SkippedRecord, VocabularyEntry } from '../shared/api.js';
import type { IsoDate } from '../shared/dates.js';
import type { DataMode, SetupReport } from './vocabulary-repository.js';
import type { Sense } from '../shared/api.js';

/**
 * A stored entry before the service adds its review status. `reviewDate` is
 * the mastery schedule's date as stored; `fsrsDue` is the instant FSRS has the
 * word due, where it has been answered since FSRS started being calculated.
 * Which of the two the reviewer sees is decided by the service, not here.
 */
export type EntryData = Omit<VocabularyEntry, 'reviewStatus' | 'reviewable' | 'scheduledBy'> & {
  fsrsDue?: string | null;
};

/** Everything needed to create a row. Defaults have already been applied. */
export interface NewEntry {
  word: string;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  dateAdded: IsoDate | null;
  mastery: number;
  reviewDate: IsoDate | null;
  /** Identifies the submission, for stores that can refuse to create the same one twice. */
  requestId?: string;
  /**
   * The word's senses, where the store can write them with the word itself
   * (schema version 14) so no failure can leave the word without them.
   * Positions run from zero in the order given. A store without that
   * ability ignores them; the senses are then written afterwards, one call
   * each, as they always were.
   */
  senses?: ReadonlyArray<{ meaning: string | null; definition: string | null; example: string | null; requestId: string }>;
}

/** Only the keys present are written; `null` clears a value. */
export interface EntryChanges {
  word?: string;
  meaning?: string | null;
  definition?: string | null;
  example?: string | null;
  dateAdded?: IsoDate | null;
  mastery?: number;
  reviewDate?: IsoDate | null;
  /** The word this one was formed from; `null` makes it a root of its own. */
  rootId?: string | null;
  /** Expected senses version for optimistic locking (new clients). */
  expectSensesVersion?: number;
}

/** The sense operations a store that supports senses offers. */
export interface SenseOperations {
  /** List every sense of a vocabulary entry, archived ones included, ordered by position. */
  listSenses(vocabularyId: string): Promise<Sense[]>;
  /** Get a single sense by ID. */
  getSense(id: string): Promise<Sense | null>;
  /**
   * Add a new sense. Returns the created sense. `options.resume` marks the
   * import's completion step, which may land a sense on a word in the trash
   * and — with `options.archived` — carries the archive state the file named
   * for the row.
   */
  createSense(
    vocabularyId: string,
    sense: { meaning: string | null; definition: string | null; example: string | null; requestId: string },
    options?: { resume?: boolean; archived?: boolean },
  ): Promise<{ sense: Sense; created: boolean }>;
  /** Update an existing sense. */
  updateSense(id: string, patch: { meaning?: string | null; definition?: string | null; example?: string | null; expectedVersion: number }): Promise<Sense | 'stale' | 'not_found'>;
  /** Reorder senses. */
  reorderSenses(vocabularyId: string, senseIds: string[], expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'>;
  /** Archive (soft-delete) a sense. */
  archiveSense(id: string, expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'>;
  /** Restore an archived sense. */
  restoreSense(id: string, expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'>;
}

/**
 * Whole-record access to the vocabulary: listing, creating, editing and
 * trashing. The review queue has its own narrower interface
 * (VocabularyRepository) and does not go through here.
 */
export interface VocabularyCatalog {
  readonly mode: DataMode;
  checkSetup(): Promise<SetupReport>;
  listEntries(): Promise<{ entries: EntryData[]; invalid: SkippedRecord[] }>;
  /** The latest stored values, or `null` if this is not a live row of the database. */
  getEntry(id: string): Promise<EntryData | null>;
  /** Existing live entries whose word equals `word` after normalisation. */
  findEntriesByWord(word: string): Promise<EntryData[]>;
  /** The word created by an earlier submission with this request id, where the store keeps track. */
  findByRequestId?(requestId: string): Promise<EntryData | null>;
  /** `created` is false when the store recognised the submission and returned the existing word. */
  createEntry(entry: NewEntry): Promise<{ entry: EntryData; created: boolean }>;
  updateEntry(id: string, changes: EntryChanges): Promise<EntryData>;
  /** Words in the trash, most recently trashed first. Empty where the trash is kept elsewhere. */
  listTrashed(): Promise<EntryData[]>;
  /** Moves a row to the trash. Returns false if it was not a row of this database. */
  trashEntry(id: string): Promise<boolean>;
  /** Takes a row back out of the trash, or returns `null` if it is not one of ours. */
  restoreEntry(id: string): Promise<EntryData | null>;
  /** Sense operations (available when capabilities.senses is true). */
  senses?: SenseOperations;
}
