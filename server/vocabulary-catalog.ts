import type { SkippedRecord, VocabularyEntry } from '../shared/api.js';
import type { IsoDate } from '../shared/dates.js';
import type { DataMode, SetupReport } from './vocabulary-repository.js';

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
}
