import type { SkippedRecord, VocabularyEntry } from '../shared/api.js';
import type { IsoDate } from '../shared/dates.js';
import type { SetupReport } from './vocabulary-repository.js';

/** A stored entry before the service adds its review status. */
export type EntryData = Omit<VocabularyEntry, 'reviewStatus' | 'reviewable'>;

/** Everything needed to create a row. Defaults have already been applied. */
export interface NewEntry {
  word: string;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  dateAdded: IsoDate | null;
  mastery: number;
  reviewDate: IsoDate | null;
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
}

/**
 * Whole-record access to the vocabulary: listing, creating, editing and
 * trashing. The review queue has its own narrower interface
 * (VocabularyRepository) and does not go through here.
 */
export interface VocabularyCatalog {
  readonly mode: 'mock' | 'notion';
  checkSetup(): Promise<SetupReport>;
  listEntries(): Promise<{ entries: EntryData[]; invalid: SkippedRecord[] }>;
  /** The latest stored values, or `null` if this is not a live row of the database. */
  getEntry(id: string): Promise<EntryData | null>;
  /** Existing live entries whose word equals `word` after normalisation. */
  findEntriesByWord(word: string): Promise<EntryData[]>;
  createEntry(entry: NewEntry): Promise<EntryData>;
  updateEntry(id: string, changes: EntryChanges): Promise<EntryData>;
  /** Moves a row to the trash. Returns false if it was not a row of this database. */
  trashEntry(id: string): Promise<boolean>;
  /** Takes a row back out of the trash, or returns `null` if it is not one of ours. */
  restoreEntry(id: string): Promise<EntryData | null>;
}
