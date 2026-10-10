import { normalizeId } from '../../shared/api.js';
import { addDays, type IsoDate } from '../../shared/dates.js';
import type { ReviewState } from '../../shared/review-logic.js';
import { normalizeWord } from '../../shared/text.js';
import type { CardFieldConfig, VocabularyRecord } from '../../shared/vocabulary.js';
import type { EntryChanges, EntryData, NewEntry, VocabularyCatalog } from '../vocabulary-catalog.js';
import type { VocabularyRepository } from '../vocabulary-repository.js';

export const mockCardFields: CardFieldConfig[] = [
  { key: 'partOfSpeech', property: 'Part of Speech', label: 'Part of speech', side: 'front', visibility: 'always' },
  { key: 'pronunciation', property: 'Pronunciation', label: 'Pronunciation', side: 'front', visibility: 'always' },
  { key: 'meaning', property: 'Vietnamese Meaning', label: 'Vietnamese meaning', side: 'back', visibility: 'always' },
  { key: 'definition', property: 'Definition', label: 'Definition', side: 'back', visibility: 'details' },
  { key: 'example', property: 'Example', label: 'Example', side: 'back', visibility: 'details' },
];

type Seed = [
  word: string,
  partOfSpeech: string,
  pronunciation: string,
  mastery: number,
  dueInDays: number,
  addedDaysAgo: number,
  meaning: string,
  definition: string,
  example: string | null,
];

const SEEDS: Seed[] = [
  ['serendipity', 'noun', '/ˌser.ənˈdɪp.ə.ti/', 2, -3, 21, 'sự tình cờ may mắn', 'The luck of finding something good without looking for it.', 'Meeting her future business partner on a delayed train was pure serendipity.'],
  ['ambiguous', 'adjective', '/æmˈbɪɡ.ju.əs/', 8, -2, 28, 'mơ hồ, nhiều nghĩa', 'Having more than one possible meaning.', 'The instructions were so ambiguous that everyone did something different.'],
  ['meticulous', 'adjective', '/məˈtɪk.jə.ləs/', 4, -1, 14, 'tỉ mỉ, kỹ lưỡng', 'Very careful and paying attention to every detail.', 'She keeps meticulous notes on every experiment.'],
  ['ubiquitous', 'adjective', '/juːˈbɪk.wɪ.təs/', 7, -1, 21, 'có mặt khắp nơi', 'Seeming to be everywhere.', 'Smartphones have become ubiquitous in daily life.'],
  ['candid', 'adjective', '/ˈkæn.dɪd/', 9, -7, 35, 'thẳng thắn', 'Honest and direct, even when the truth is uncomfortable.', 'He gave a candid account of what went wrong.'],
  ['alleviate', 'verb', '/əˈliː.vi.eɪt/', 5, 0, 9, 'làm dịu, giảm bớt', 'To make pain or a problem less severe.', 'A short walk can alleviate stress.'],
  ['ephemeral', 'adjective', '/ɪˈfem.ər.əl/', 6, 0, 9, 'phù du, chóng tàn', 'Lasting for only a short time.', 'Fame on the internet is often ephemeral.'],
  ['resilient', 'adjective', '/rɪˈzɪl.i.ənt/', 0, 0, 0, 'kiên cường', 'Able to recover quickly after something difficult.', 'Children are often more resilient than adults expect.'],
  ['tenacious', 'adjective', '/təˈneɪ.ʃəs/', 1, 0, 1, 'bền bỉ', 'Not giving up easily; holding firmly to a goal.', null],
  ['gregarious', 'adjective', '/ɡrɪˈɡeə.ri.əs/', 3, 0, 3, 'thích giao du', 'Enjoying the company of other people.', 'Her gregarious brother knew everyone at the party within an hour.'],
  // Not due yet, and already mastered: neither should ever appear in the queue.
  ['pragmatic', 'adjective', '/præɡˈmæt.ɪk/', 3, 2, 3, 'thực dụng, thực tế', 'Dealing with problems in a practical way.', 'We need a pragmatic plan, not a perfect one.'],
  ['eloquent', 'adjective', '/ˈel.ə.kwənt/', 10, -10, 60, 'hùng hồn', 'Able to express ideas clearly and persuasively.', 'She gave an eloquent speech at the ceremony.'],
];

interface StoredWord {
  id: string;
  word: string;
  partOfSpeech: string | null;
  pronunciation: string | null;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  mastery: number;
  reviewDate: IsoDate | null;
  dateAdded: IsoDate | null;
  trashed: boolean;
  createdTime: string;
  lastEditedTime: string;
}

/** In-memory sample vocabulary. Nothing here ever reaches Notion. */
export class MockVocabularyRepository implements VocabularyRepository, VocabularyCatalog {
  readonly mode = 'mock' as const;
  private readonly words = new Map<string, StoredWord>();
  private created = 0;

  constructor(
    today: IsoDate,
    private readonly now: () => Date = () => new Date(),
  ) {
    SEEDS.forEach((seed, index) => {
      const [word, partOfSpeech, pronunciation, mastery, dueInDays, addedDaysAgo, meaning, definition, example] = seed;
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const dateAdded = addDays(today, -addedDaysAgo);
      this.words.set(id, {
        id,
        word,
        partOfSpeech,
        pronunciation,
        meaning,
        definition,
        example,
        mastery,
        reviewDate: addDays(today, dueInDays),
        dateAdded,
        trashed: false,
        createdTime: `${dateAdded}T09:00:00.000Z`,
        lastEditedTime: `${dateAdded}T09:00:00.000Z`,
      });
    });
  }

  private live(): StoredWord[] {
    return [...this.words.values()].filter((word) => !word.trashed);
  }

  private touch(word: StoredWord): StoredWord {
    word.lastEditedTime = this.now().toISOString();
    return word;
  }

  async checkSetup() {
    return { readIssues: [], writeIssues: [], warnings: [] };
  }

  // ---- Review queue ----

  async listDueCandidates() {
    return { records: this.live().map(toRecord), invalid: [] };
  }

  async vocabularyStatus() {
    const words = this.live();
    if (words.length === 0) return 'empty' as const;
    return words.every((word) => word.mastery >= 10) ? ('all_mastered' as const) : ('in_progress' as const);
  }

  async getRecord(pageId: string) {
    const word = this.words.get(normalizeId(pageId));
    return word && !word.trashed ? toRecord(word) : null;
  }

  async updateReviewState(pageId: string, changes: Partial<ReviewState>) {
    const word = this.words.get(normalizeId(pageId));
    if (!word) throw new Error(`Unknown sample record: ${pageId}`);
    if (changes.mastery !== undefined) word.mastery = changes.mastery;
    if (changes.nextReview !== undefined) word.reviewDate = changes.nextReview;
    return toRecord(this.touch(word));
  }

  // ---- Whole records ----

  async listEntries() {
    return { entries: this.live().map(toEntry), invalid: [] };
  }

  async getEntry(id: string) {
    const word = this.words.get(normalizeId(id));
    return word && !word.trashed ? toEntry(word) : null;
  }

  async findEntriesByWord(word: string) {
    const wanted = normalizeWord(word);
    return this.live()
      .filter((candidate) => normalizeWord(candidate.word) === wanted)
      .map(toEntry);
  }

  async createEntry(entry: NewEntry): Promise<EntryData> {
    this.created += 1;
    const id = `00000000-0000-4000-9000-${String(this.created).padStart(12, '0')}`;
    const timestamp = this.now().toISOString();
    const word: StoredWord = {
      id,
      ...entry,
      partOfSpeech: null,
      pronunciation: null,
      trashed: false,
      createdTime: timestamp,
      lastEditedTime: timestamp,
    };
    this.words.set(id, word);
    return toEntry(word);
  }

  async updateEntry(id: string, changes: EntryChanges): Promise<EntryData> {
    const word = this.words.get(normalizeId(id));
    if (!word || word.trashed) throw new Error(`Unknown sample record: ${id}`);
    Object.assign(word, changes);
    return toEntry(this.touch(word));
  }

  async trashEntry(id: string) {
    const word = this.words.get(normalizeId(id));
    if (!word) return false;
    word.trashed = true;
    return true;
  }

  async restoreEntry(id: string) {
    const word = this.words.get(normalizeId(id));
    if (!word) return null;
    word.trashed = false;
    return toEntry(word);
  }
}

function toRecord(word: StoredWord): VocabularyRecord {
  return {
    id: word.id,
    word: word.word,
    mastery: word.mastery,
    nextReview: word.reviewDate,
    fields: {
      partOfSpeech: word.partOfSpeech,
      pronunciation: word.pronunciation,
      meaning: word.meaning,
      definition: word.definition,
      example: word.example,
    },
  };
}

function toEntry(word: StoredWord): EntryData {
  return {
    id: word.id,
    word: word.word,
    meaning: word.meaning,
    definition: word.definition,
    example: word.example,
    mastery: word.mastery,
    reviewDate: word.reviewDate,
    dateAdded: word.dateAdded,
    formattedFields: [],
    url: null,
    createdTime: word.createdTime,
    lastEditedTime: word.lastEditedTime,
  };
}
