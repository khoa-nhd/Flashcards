/**
 * High-level AI service that wraps the repository and provider client.
 * This is the interface used by the API routes.
 */
import type { VocabularyAnalysisRow, VocabularyRepository } from './vocabulary-repository.js';
import type {
  AiConfig,
  AiMode,
  AiProviderClient,
  ConversationContext,
  RateLimitResult,
  AiStreamChunk,
  AiErrorCode,
  AiError,
} from './ai-service.js';
import { loadAiConfig, createProviderClient, checkRateLimits, enforceRateLimits, buildConversationContext, generateResponse } from './ai-service.js';

export interface AiService {
  readonly config: AiConfig;
  readonly provider: AiProviderClient;
  /** Lists the caller's conversations. */
  listConversations(limit?: number, offset?: number): Promise<Array<{ id: string; mode: AiMode; title: string; createdAt: string; updatedAt: string }>>;
  /** Creates a new conversation. */
  createConversation(mode: AiMode, title?: string): Promise<{ id: string; mode: AiMode; title: string; createdAt: string; updatedAt: string }>;
  /** Gets one conversation by id. */
  getConversation(id: string): Promise<{ id: string; mode: AiMode; title: string; createdAt: string; updatedAt: string } | null>;
  /** Updates conversation title. */
  updateConversationTitle(id: string, title: string): Promise<boolean>;
  /** Deletes a conversation. */
  deleteConversation(id: string): Promise<boolean>;
  /** Lists messages for a conversation, as the model is given them. */
  listMessages(conversationId: string, limit?: number, offset?: number): Promise<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>>;
  /** Lists messages for a conversation, as the page shows them. */
  listMessageRecords(
    conversationId: string,
    limit?: number,
    offset?: number,
  ): Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; metadata: Record<string, unknown>; createdAt: string }>>;
  /** Marks an assistant message as saved to a word, so the state survives a reload. Needs schema version 12. */
  markMessageSaved(conversationId: string, messageId: string, vocabularyId: string): Promise<boolean>;
  /** Builds the conversation context for generation. */
  buildContext(conversationId: string, mode: AiMode, history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>, newUserMessage: string): ConversationContext;
  /** Checks rate limits for a mode. */
  checkRateLimits(mode: AiMode): Promise<{ minute: RateLimitResult; day: RateLimitResult }>;
  /** Throws if rate limits are exceeded. */
  enforceRateLimits(limits: { minute: RateLimitResult; day: RateLimitResult }): void;
  /** Generates a streaming response. `signal` stops it, for example when the reader has gone. */
  generateResponse(conversationId: string, context: ConversationContext, signal: AbortSignal): AsyncGenerator<AiStreamChunk, void, unknown>;
  /** Vocabulary Analysis: upsert analysis for a vocabulary entry. Needs schema version 11. */
  upsertVocabularyAnalysis(args: {
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
  }): Promise<VocabularyAnalysisRow>;
  /** Vocabulary Analysis: get analysis for a vocabulary entry. Needs schema version 11. */
  getVocabularyAnalysis(vocabularyId: string): Promise<VocabularyAnalysisRow | null>;
  /** Vocabulary Analysis: delete analysis for a vocabulary entry. Needs schema version 11. */
  deleteVocabularyAnalysis(vocabularyId: string): Promise<boolean>;
}

/** Creates the AI service with configuration from environment. */
export function createAiService(repository: VocabularyRepository, env: Record<string, string | undefined> = process.env): AiService {
  const config = loadAiConfig(env);
  const provider = createProviderClient(config);

  return {
    config,
    provider,

    async listConversations(limit = 50, offset = 0) {
      const rows = await repository.listAiConversations(limit, offset);
      return rows.map((r) => ({
        id: r.id,
        mode: r.mode,
        title: r.title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    },

    async createConversation(mode: AiMode, title?: string) {
      const row = await repository.createAiConversation(mode, title);
      return { id: row.id, mode: row.mode, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
    },

    async getConversation(id: string) {
      const row = await repository.getAiConversation(id);
      if (!row) return null;
      return { id: row.id, mode: row.mode, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
    },

    async updateConversationTitle(id: string, title: string) {
      return repository.updateAiConversationTitle(id, title);
    },

    async deleteConversation(id: string) {
      return repository.deleteAiConversation(id);
    },

    async listMessages(conversationId: string, limit = 200, offset = 0) {
      const rows = await repository.listAiMessages(conversationId, limit, offset);
      return rows.map((r) => ({ role: r.role, content: r.content }));
    },

    async listMessageRecords(conversationId: string, limit = 200, offset = 0) {
      const rows = await repository.listAiMessages(conversationId, limit, offset);
      return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, metadata: r.metadata, createdAt: r.created_at }));
    },

    async markMessageSaved(conversationId: string, messageId: string, vocabularyId: string) {
      return repository.markAiMessageSaved(conversationId, messageId, vocabularyId);
    },

    buildContext(conversationId: string, mode: AiMode, history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>, newUserMessage: string) {
      return buildConversationContext(conversationId, mode, history, newUserMessage);
    },

    async checkRateLimits(mode: AiMode) {
      return checkRateLimits(repository, mode, config);
    },

    enforceRateLimits(limits: { minute: RateLimitResult; day: RateLimitResult }) {
      enforceRateLimits(limits);
    },

    async *generateResponse(_conversationId: string, context: ConversationContext, signal: AbortSignal) {
      yield* generateResponse(repository, context, config, signal);
    },

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
      return repository.upsertVocabularyAnalysis(args);
    },

    async getVocabularyAnalysis(vocabularyId: string): Promise<VocabularyAnalysisRow | null> {
      return repository.getVocabularyAnalysis(vocabularyId);
    },

    async deleteVocabularyAnalysis(vocabularyId: string): Promise<boolean> {
      return repository.deleteVocabularyAnalysis(vocabularyId);
    },
  };
}

// Re-export types for consumers
export type { AiConfig, AiMode, AiProviderClient, ConversationContext, RateLimitResult, AiStreamChunk, AiErrorCode, AiError, VocabularyAnalysisRow };
export { loadAiConfig, createProviderClient, buildConversationContext, checkRateLimits, enforceRateLimits, generateResponse };