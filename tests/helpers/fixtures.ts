import { NO_CAPABILITIES, type QueueResponse, type ReviewCard } from '../../shared/api.js';
import type { ReviewState } from '../../shared/review-logic.js';
import type { CardHistory } from '../../shared/weak-words.js';
import type { CardFieldConfig, VocabularyRecord } from '../../shared/vocabulary.js';
import type {
  PracticeHistoryRow,
  ReviewWrite,
  ReviewWriteResult,
  SetupReport,
  UndoResult,
  VocabularyRepository,
  AiConversationRow,
  AiMessageRow,
  RateLimitCheckRow,
  VocabularyAnalysisRow,
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
    detailCollapsed: false,
    suspended: false,
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
    capabilities: NO_CAPABILITIES,
    scheduler: 'mastery_v1',
    fsrsOnly: false,
    heldBack: 0,
    focus: null,
    selection: false,
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
  readonly capabilities = { ...NO_CAPABILITIES, practiceHistory: false, aiChat: true, weakRecovery: false };
  readonly updates: Array<{ pageId: string; changes: Partial<ReviewState> }> = [];
  setup: SetupReport = { readIssues: [], writeIssues: [], warnings: [] };
  /** Lets a test corrupt what the "database" reports back after a write. */
  afterUpdate: (record: VocabularyRecord) => VocabularyRecord = (updated) => updated;
  private readonly records: Map<string, VocabularyRecord>;
  private readonly aiConversations = new Map<string, AiConversationRow>();
  private readonly aiMessages = new Map<string, AiMessageRow[]>();
  private aiSequence = 0;

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

  async listLiveRecords() {
    return { records: [...this.records.values()].map((item) => ({ ...item })), invalid: [] };
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
  async updateReviewState(id: string, changes: Partial<Pick<ReviewState, 'mastery' | 'nextReview'>>) {
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

  async weakWordDays() {
    return [];
  }

  async confidenceStats() {
    return [];
  }

  async recordPractice() {
    return 'unsupported' as const;
  }

  async listHistory() {
    return [];
  }

  async practiceDailyStats() {
    return [];
  }

  async practiceCorrectCounts() {
    return new Map<string, number>();
  }

  async practiceHistory(): Promise<PracticeHistoryRow[]> {
    return [];
  }

  // ---- AI Conversations ----

  async listAiConversations(limit?: number, offset?: number): Promise<AiConversationRow[]> {
    const all = [...this.aiConversations.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return all.slice(offset ?? 0, (offset ?? 0) + (limit ?? 50));
  }

  async createAiConversation(mode: 'general' | 'vocabulary_expert', title?: string): Promise<AiConversationRow> {
    this.aiSequence += 1;
    const now = new Date().toISOString();
    const id = `00000000-0000-4000-a000-${String(this.aiSequence).padStart(12, '0')}`;
    const row: AiConversationRow = { id, mode, title: title ?? 'New conversation', created_at: now, updated_at: now };
    this.aiConversations.set(id, row);
    this.aiMessages.set(id, []);
    return row;
  }

  async getAiConversation(id: string): Promise<AiConversationRow | null> {
    return this.aiConversations.get(id) ?? null;
  }

  async updateAiConversationTitle(id: string, title: string): Promise<boolean> {
    const conv = this.aiConversations.get(id);
    if (!conv) return false;
    conv.title = title;
    conv.updated_at = new Date().toISOString();
    return true;
  }

  async deleteAiConversation(id: string): Promise<boolean> {
    if (!this.aiConversations.has(id)) return false;
    this.aiConversations.delete(id);
    this.aiMessages.delete(id);
    return true;
  }

  async listAiMessages(conversationId: string, limit?: number, offset?: number): Promise<AiMessageRow[]> {
    const messages = this.aiMessages.get(conversationId) ?? [];
    return messages.slice(offset ?? 0, (offset ?? 0) + (limit ?? 200));
  }

  async insertAiMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<AiMessageRow> {
    const messages = this.aiMessages.get(conversationId);
    if (!messages) throw new Error('Conversation not found');
    const row: AiMessageRow = {
      id: `00000000-0000-4000-b000-${String(messages.length + 1).padStart(12, '0')}`,
      role,
      content,
      metadata: metadata ?? {},
      created_at: new Date().toISOString(),
    };
    messages.push(row);
    const conv = this.aiConversations.get(conversationId);
    if (conv) conv.updated_at = row.created_at;
    return row;
  }

  async markAiMessageSaved(conversationId: string, messageId: string, vocabularyId: string): Promise<boolean> {
    const messages = this.aiMessages.get(conversationId);
    const message = messages?.find((row) => row.id === messageId && row.role === 'assistant');
    if (message === undefined) return false;
    message.metadata = { ...message.metadata, vocabularyId, savedAt: new Date().toISOString() };
    return true;
  }

  async checkAiRateLimit(
    _mode: 'general' | 'vocabulary_expert',
    _window: 'minute' | 'day',
    limit: number,
  ): Promise<RateLimitCheckRow> {
    return { allowed: true, retry_after_seconds: 0, current_count: 1, limit };
  }

  // ---- Vocabulary Analysis ----

  private readonly vocabularyAnalysis = new Map<string, VocabularyAnalysisRow>();

  async upsertVocabularyAnalysis(args: {
    vocabularyId: string;
    pronunciation?: string | null;
    partOfSpeech?: string | null;
    cefrLevel?: string | null;
    confidence?: number | null;
    englishDefinition?: string | null;
    vietnameseMeaning?: string | null;
    senses?: Record<string, unknown>[];
    examples?: Record<string, unknown>[];
    wordFamily?: Record<string, unknown>[];
    collocations?: Record<string, unknown>[];
    synonyms?: Record<string, unknown>[];
    antonyms?: Record<string, unknown>[];
    usageNotes?: string | null;
    commonMistakes?: string | null;
    revisionSummary?: string | null;
    model?: string | null;
  }): Promise<VocabularyAnalysisRow> {
    const now = new Date().toISOString();
    const existing = this.vocabularyAnalysis.get(args.vocabularyId);
    const row: VocabularyAnalysisRow = {
      id: existing?.id ?? `00000000-0000-4000-c000-${String(this.vocabularyAnalysis.size + 1).padStart(12, '0')}`,
      vocabulary_id: args.vocabularyId,
      pronunciation: args.pronunciation ?? null,
      part_of_speech: args.partOfSpeech ?? null,
      cefr_level: args.cefrLevel ?? null,
      confidence: args.confidence ?? null,
      english_definition: args.englishDefinition ?? null,
      vietnamese_meaning: args.vietnameseMeaning ?? null,
      senses: args.senses ?? [],
      examples: args.examples ?? [],
      word_family: args.wordFamily ?? [],
      collocations: args.collocations ?? [],
      synonyms: args.synonyms ?? [],
      antonyms: args.antonyms ?? [],
      usage_notes: args.usageNotes ?? null,
      common_mistakes: args.commonMistakes ?? null,
      revision_summary: args.revisionSummary ?? null,
      model: args.model ?? 'vocabulary_expert',
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.vocabularyAnalysis.set(args.vocabularyId, row);
    return row;
  }

  async getVocabularyAnalysis(vocabularyId: string): Promise<VocabularyAnalysisRow | null> {
    return this.vocabularyAnalysis.get(vocabularyId) ?? null;
  }

  async deleteVocabularyAnalysis(vocabularyId: string): Promise<boolean> {
    return this.vocabularyAnalysis.delete(vocabularyId);
  }

  /** Simulates a change made somewhere else, such as on another device. */
  editElsewhere(id: string, changes: Partial<VocabularyRecord>) {
    const existing = this.records.get(id);
    if (existing) this.records.set(id, { ...existing, ...changes });
  }
}
