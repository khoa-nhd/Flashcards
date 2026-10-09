import { normalizeId } from '../../shared/api.js';
import { addDays, type IsoDate } from '../../shared/dates.js';
import type { ReviewState } from '../../shared/review-logic.js';
import type { CardFieldConfig, VocabularyRecord } from '../../shared/vocabulary.js';
import type { VocabularyRepository } from '../vocabulary-repository.js';

export const mockCardFields: CardFieldConfig[] = [
  { key: 'partOfSpeech', property: 'Part of Speech', label: 'Part of speech', side: 'front', visibility: 'always' },
  { key: 'pronunciation', property: 'Pronunciation', label: 'Pronunciation', side: 'front', visibility: 'always' },
  { key: 'definition', property: 'Definition', label: 'Definition', side: 'back', visibility: 'details' },
  { key: 'example', property: 'Example', label: 'Example', side: 'back', visibility: 'details' },
];

type Seed = [
  word: string,
  partOfSpeech: string,
  pronunciation: string,
  mastery: number,
  dueInDays: number,
  definition: string,
  example: string | null,
];

const SEEDS: Seed[] = [
  ['serendipity', 'noun', '/ˌser.ənˈdɪp.ə.ti/', 2, -3, 'The luck of finding something good without looking for it.', 'Meeting her future business partner on a delayed train was pure serendipity.'],
  ['ambiguous', 'adjective', '/æmˈbɪɡ.ju.əs/', 8, -2, 'Having more than one possible meaning.', 'The instructions were so ambiguous that everyone did something different.'],
  ['meticulous', 'adjective', '/məˈtɪk.jə.ləs/', 4, -1, 'Very careful and paying attention to every detail.', 'She keeps meticulous notes on every experiment.'],
  ['ubiquitous', 'adjective', '/juːˈbɪk.wɪ.təs/', 7, -1, 'Seeming to be everywhere.', 'Smartphones have become ubiquitous in daily life.'],
  ['candid', 'adjective', '/ˈkæn.dɪd/', 9, -7, 'Honest and direct, even when the truth is uncomfortable.', 'He gave a candid account of what went wrong.'],
  ['alleviate', 'verb', '/əˈliː.vi.eɪt/', 5, 0, 'To make pain or a problem less severe.', 'A short walk can alleviate stress.'],
  ['ephemeral', 'adjective', '/ɪˈfem.ər.əl/', 6, 0, 'Lasting for only a short time.', 'Fame on the internet is often ephemeral.'],
  ['resilient', 'adjective', '/rɪˈzɪl.i.ənt/', 0, 0, 'Able to recover quickly after something difficult.', 'Children are often more resilient than adults expect.'],
  ['tenacious', 'adjective', '/təˈneɪ.ʃəs/', 1, 0, 'Not giving up easily; holding firmly to a goal.', null],
  ['gregarious', 'adjective', '/ɡrɪˈɡeə.ri.əs/', 3, 0, 'Enjoying the company of other people.', 'Her gregarious brother knew everyone at the party within an hour.'],
  // Not due yet, and already mastered: neither should ever appear in the queue.
  ['pragmatic', 'adjective', '/præɡˈmæt.ɪk/', 3, 2, 'Dealing with problems in a practical way.', 'We need a pragmatic plan, not a perfect one.'],
  ['eloquent', 'adjective', '/ˈel.ə.kwənt/', 10, -10, 'Able to express ideas clearly and persuasively.', 'She gave an eloquent speech at the ceremony.'],
];

/** In-memory sample vocabulary. Nothing here ever reaches Notion. */
export class MockVocabularyRepository implements VocabularyRepository {
  readonly mode = 'mock' as const;
  private readonly records = new Map<string, VocabularyRecord>();

  constructor(today: IsoDate) {
    SEEDS.forEach(([word, partOfSpeech, pronunciation, mastery, dueInDays, definition, example], index) => {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      this.records.set(id, {
        id,
        word,
        mastery,
        nextReview: addDays(today, dueInDays),
        fields: { partOfSpeech, pronunciation, definition, example },
      });
    });
  }

  async checkSetup() {
    return { readIssues: [], writeIssues: [], warnings: [] };
  }

  async listDueCandidates() {
    return { records: [...this.records.values()].map((record) => ({ ...record })), invalid: [] };
  }

  async getRecord(pageId: string) {
    const record = this.records.get(normalizeId(pageId));
    return record ? { ...record } : null;
  }

  async updateReviewState(pageId: string, changes: Partial<ReviewState>) {
    const id = normalizeId(pageId);
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown sample record: ${id}`);
    const updated = { ...record, ...changes };
    this.records.set(id, updated);
    return { ...updated };
  }
}
