import type { QueueResponse, ReviewCard } from '../../shared/api.js';
import type { ReviewState } from '../../shared/review-logic.js';
import type { CardHistory } from '../../shared/weak-words.js';
import type { CardFieldConfig, VocabularyRecord } from '../../shared/vocabulary.js';
import type {
  ReviewWrite,
  ReviewWriteResult,
  SetupReport,
  UndoResult,
  VocabularyRepository,
} from '../../server/vocabulary-repository.js';

/** The fixed "today" used throughout the tests. */
export const TODAY = '2026-10-09';
export const TIME_ZONE = 'Asia/Ho_Chi_Minh';
/** An instant that falls on TODAY in TIME_ZONE (noon local time). */
export const NOW = new Date('2026-10-09T05:00:00Z');

export const pageId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function record(n: number, overrides: Partial<VocabularyRecord> = {}): VocabularyRecord {
  return {
    id: pageId(n),
    word: `word-${n}`,
    mastery: 3,
    nextReview: TODAY,
    fields: {
      partOfSpeech: 'noun',
      pronunciation: null,
      definition: `definition of word-${n}`,
      example: `example for word-${n}`,
    },
    ...overrides,
  };
}

export function card(n: number, overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    id: pageId(n),
    word: `word-${n}`,
    mastery: 3,
    nextReview: TODAY,
    front: [{ key: 'partOfSpeech', label: 'Part of speech', value: 'noun' }],
    back: [{ key: 'definition', label: 'Definition', value: `definition of word-${n}` }],
    detailsHidden: false,
    ...overrides,
  };
}

export function queueResponse(cards: ReviewCard[], overrides: Partial<QueueResponse> = {}): QueueResponse {
  return {
    cards,
    today: TODAY,
    timeZone: TIME_ZONE,
    mode: 'mock',
    writesEnabled: true,
    // Off unless a test asks: most tests are about the review itself.
    capabilities: { sessions: false, undo: false, fsrs: false, analytics: false },
    focus: null,
    skipped: [],
    vocabulary: 'in_progress',
    ...overrides,
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Card content used by the service tests: a front field and two that obey the mastery rule. */
export const TEST_FIELDS: CardFieldConfig[] = [
  { key: 'partOfSpeech', label: 'Part of speech', side: 'front', visibility: 'always' },
  { key: 'definition', label: 'Definition', side: 'back', visibility: 'details' },
  { key: 'example', label: 'Example', side: 'back', visibility: 'details' },
];

/**
 * An in-memory repository that records every write. It stands in for a store
 * that keeps no record of answers, so a repeated answer has to be recognised
 * by the state it expected alone.
 */
export class FakeRepository implements VocabularyRepository {
  readonly mode = 'mock' as const;
  readonly capabilities = { sessions: false, undo: false, fsrs: false, analytics: false };
  readonly updates: Array<{ pageId: string; changes: Partial<ReviewState> }> = [];
  setup: SetupReport = { readIssues: [], writeIssues: [], warnings: [] };
  /** Lets a test corrupt what the "database" reports back after a write. */
  afterUpdate: (record: VocabularyRecord) => VocabularyRecord = (updated) => updated;
  private readonly records: Map<string, VocabularyRecord>;

  constructor(
    records: VocabularyRecord[],
    private readonly listed: VocabularyRecord[] = records,
  ) {
    this.records = new Map(records.map((item) => [item.id, { ...item }]));
  }

  async checkSetup() {
    return this.setup;
  }

  async listDueCandidates() {
    return { records: this.listed.map((item) => ({ ...item })), invalid: [] };
  }

  async vocabularyStatus() {
    const all = [...this.records.values()];
    if (all.length === 0) return 'empty' as const;
    return all.every((item) => (item.mastery ?? 0) >= 10) ? ('all_mastered' as const) : ('in_progress' as const);
  }

  async getRecord(id: string) {
    const found = this.records.get(id);
    return found ? { ...found } : null;
  }

  /** The single place a write lands, so a test can make it fail or misreport. */
  async updateReviewState(id: string, changes: Partial<ReviewState>) {
    const existing = this.records.get(id);
    if (!existing) throw new Error('unknown record');
    this.updates.push({ pageId: id, changes });
    const updated = { ...existing, ...changes };
    this.records.set(id, updated);
    return this.afterUpdate({ ...updated });
  }

  /** Writes only what changed, and keeps no record of answers. */
  async applyReview(write: ReviewWrite): Promise<ReviewWriteResult> {
    const changes: Partial<ReviewState> = {};
    if (write.next.mastery !== write.expected.mastery) changes.mastery = write.next.mastery;
    if (write.next.nextReview !== write.expected.nextReview) changes.nextReview = write.next.nextReview;
    const updated = await this.updateReviewState(write.id, changes);
    return { outcome: 'applied', state: { mastery: updated.mastery ?? Number.NaN, nextReview: updated.nextReview } };
  }

  async findReview(): Promise<ReviewState | null> {
    return null;
  }

  async undoReview(): Promise<UndoResult> {
    return { outcome: 'unsupported' };
  }

  async sessionSummary(): Promise<null> {
    return null;
  }

  async listSchedules() {
    return [];
  }

  async reviewDailyStats() {
    return [];
  }

  async cardReviewStats() {
    return new Map<string, CardHistory>();
  }

  /** Simulates a change made somewhere else, such as on another device. */
  editElsewhere(id: string, changes: Partial<VocabularyRecord>) {
    const existing = this.records.get(id);
    if (existing) this.records.set(id, { ...existing, ...changes });
  }
}
