import type { Capabilities, Confidence, SessionSummary, SkippedRecord, VocabularyStatus } from '../../shared/api.js';
import type { DailyStat } from '../../shared/analytics.js';
import type { IsoDate } from '../../shared/dates.js';
import type { HistoryEvent } from '../../shared/export-format.js';
import type { CardHistory } from '../../shared/weak-words.js';
import type { WeakWordDayRow } from '../../shared/weak-recovery.js';
import type { ReviewRules } from '../../shared/review-logic.js';
import { normalizeWord } from '../../shared/text.js';
import { isStudyMode, type StudyMode } from '../../shared/study-modes.js';
import { DEFAULT_SCHEDULER, isSchedulerId } from '../../shared/scheduler/active.js';
import type { ScheduleCard } from '../../shared/scheduler/comparison.js';
import type { StoredFsrs, VocabularyRecord } from '../../shared/vocabulary.js';
import type { EntryChanges, EntryData, NewEntry, VocabularyCatalog } from '../vocabulary-catalog.js';
import type {
  ConfidenceStat,
  FsrsCardState,
  FsrsReviewResult,
  FsrsReviewWrite,
  FsrsUndoResult,
  PracticeDailyStat,
  PracticeHistoryRow,
  PracticeWrite,
  PracticeWriteResult,
  ReviewWrite,
  ReviewWriteResult,
  SetupReport,
  StudyDayRow,
  UndoResult,
  VocabularyRepository,
  AiConversationRow,
  AiMessageRow,
  RateLimitCheckRow,
  VocabularyAnalysisRow,
} from '../vocabulary-repository.js';
import {
  LATEST_SCHEMA_VERSION,
  fsrsFromJson,
  fsrsOfCard,
  fsrsStateToRow,
  type CardPatch,
  type CardRow,
  type VocabularyDatabase,
} from './supabase-database.js';

function toEntry(row: CardRow): EntryData {
  return {
    id: row.id,
    word: row.word,
    meaning: row.meaning,
    definition: row.definition,
    example: row.example,
    mastery: row.mastery,
    reviewDate: row.review_date,
    fsrsDue: fsrsOfCard(row)?.state.due ?? null,
    dateAdded: row.date_added,
    createdTime: row.created_at,
    lastEditedTime: row.updated_at,
    fsrs: storedFsrs(row),
    dueOn: row.due_on ?? null,
    revision: row.revision ?? 0,
    suspended: row.suspended_at != null,
  };
}

/** A card's place under FSRS alone, as a version 15 function reports it. */
function fsrsCardState(row: { revision: number | null; due_on: IsoDate | null; fsrs: unknown }): FsrsCardState | null {
  if (row.revision === null) return null;
  const found = fsrsFromJson(row.fsrs);
  return {
    fsrs: found === null ? null : { state: found.state, engine: found.version },
    dueOn: row.due_on,
    revision: row.revision,
  };
}

/** A review card. The keys match the card field configuration. */
function toRecord(row: CardRow): VocabularyRecord {
  return {
    id: row.id,
    word: row.word,
    mastery: row.mastery,
    nextReview: row.review_date,
    fields: { meaning: row.meaning, definition: row.definition, example: row.example },
    fsrs: storedFsrs(row),
    dueOn: row.due_on ?? null,
    revision: row.revision ?? 0,
    suspended: row.suspended_at != null,
  };
}

function storedFsrs(row: CardRow): StoredFsrs | null {
  const found = fsrsOfCard(row);
  return found === null ? null : { state: found.state, engine: found.version };
}

/** What a database that has reached this schema version can do. */
export function capabilitiesAt(schemaVersion: number): Capabilities {
  return {
    sessions: schemaVersion >= 2,
    undo: schemaVersion >= 2,
    fsrs: schemaVersion >= 3,
    analytics: schemaVersion >= 4,
    goals: schemaVersion >= 5,
    confidence: schemaVersion >= 5,
    practice: schemaVersion >= 6,
    library: schemaVersion >= 7,
    practiceHistory: schemaVersion >= 9,
    aiChat: schemaVersion >= 10,
    weakRecovery: schemaVersion >= 14,
    fsrsOnly: schemaVersion >= 15,
    game: schemaVersion >= 17,
    competition: schemaVersion >= 18,
    economy: schemaVersion >= 19,
    notifications: schemaVersion >= 20,
    pvp: schemaVersion >= 21,
  };
}

const NO_ISSUES: SetupReport = { readIssues: [], writeIssues: [], warnings: [], entryWriteIssues: [] };

/**
 * Vocabulary stored in Supabase, for one signed-in user. Which rows that user
 * can reach is decided by the database (Row Level Security), not here.
 */
export class SupabaseVocabularyRepository implements VocabularyRepository, VocabularyCatalog {
  readonly mode = 'supabase' as const;
  readonly capabilities: Capabilities;

  constructor(
    private readonly database: VocabularyDatabase,
    private readonly rules: ReviewRules,
    /** The newest migration the database has. Anything it lacks stays switched off. */
    private readonly schemaVersion: number = LATEST_SCHEMA_VERSION,
  ) {
    this.capabilities = capabilitiesAt(schemaVersion);
  }

  async checkSetup(): Promise<SetupReport> {
    // The schema is this project's own; a missing migration surfaces as an error on first use.
    return NO_ISSUES;
  }

  // ---- Review queue ----

  async listDueCandidates(today: IsoDate): Promise<{ records: VocabularyRecord[]; invalid: SkippedRecord[] }> {
    // With rules that do not admit undated words the query returns a few extra
    // rows; the rules engine does the authoritative filtering either way.
    const rows = await this.database.listDueCards(today, this.rules.retiredAtMastery);
    return { records: rows.map(toRecord), invalid: [] };
  }

  async listLiveRecords(): Promise<{ records: VocabularyRecord[]; invalid: SkippedRecord[] }> {
    return { records: (await this.database.listCards()).map(toRecord), invalid: [] };
  }

  async vocabularyStatus(): Promise<VocabularyStatus> {
    if ((await this.database.countCards({ masteryBelow: this.rules.retiredAtMastery })) > 0) return 'in_progress';
    return (await this.database.countCards()) > 0 ? 'all_mastered' : 'empty';
  }

  async getRecord(id: string): Promise<VocabularyRecord | null> {
    const row = await this.database.getCard(id);
    return row === null || row.deleted_at !== null ? null : toRecord(row);
  }

  async applyReview(write: ReviewWrite): Promise<ReviewWriteResult> {
    const args = {
      id: write.id,
      requestId: write.requestId,
      action: write.action,
      expectedMastery: write.expected.mastery,
      expectedReviewDate: write.expected.nextReview,
      newMastery: write.next.mastery,
      newReviewDate: write.next.nextReview,
      reviewedOn: write.reviewedOn,
      durationMs: write.durationMs,
    };
    // A database that has not had the sessions migration still saves the answer, the way it always did.
    const result = this.capabilities.sessions
      ? await this.database.recordReview({
          ...args,
          sessionId: write.sessionId,
          fsrs: this.fsrsOf(write),
          confidence: this.capabilities.confidence ? (write.confidence ?? null) : null,
        })
      : await this.database.applyReview(args);
    if (result.outcome === 'not_found' || result.mastery === null) return { outcome: 'not_found' };
    return { outcome: result.outcome, state: { mastery: result.mastery, nextReview: result.review_date } };
  }

  /** The FSRS part of an answer in stored form, or nothing where the database cannot hold it. */
  private fsrsOf(write: ReviewWrite) {
    if (!this.capabilities.fsrs || write.fsrs == null) return null;
    const { rating, engine, before, after } = write.fsrs;
    return {
      rating,
      version: engine,
      before: before === null ? null : fsrsStateToRow(before.state, before.engine),
      after: fsrsStateToRow(after, engine),
    };
  }

  async reviewDailyStats(from: IsoDate, to: IsoDate): Promise<DailyStat[]> {
    if (!this.capabilities.analytics) return [];
    return (await this.database.reviewDailyStats(from, to)).map((row) => ({
      day: row.day,
      mode: row.review_mode,
      reviews: row.reviews,
      remembered: row.remembered,
      notRemembered: row.not_remembered,
      repeatReviews: row.repeat_reviews,
      repeatRemembered: row.repeat_remembered,
      durationMs: row.duration_ms,
      timedReviews: row.timed_reviews,
      cards: row.cards,
    }));
  }

  async cardReviewStats(since: IsoDate): Promise<Map<string, CardHistory>> {
    if (!this.capabilities.analytics) return new Map();
    const rows = await this.database.cardReviewStats(since);
    return new Map(
      rows.map((row) => [
        row.vocabulary_id,
        {
          reviews: row.reviews,
          failures: row.failures,
          recentReviews: row.recent_reviews,
          recentFailures: row.recent_failures,
          failedDays: row.failed_days,
          lastReviewedOn: row.last_reviewed_on,
          lastFailedOn: row.last_failed_on,
          lastAction: row.last_action === 'remember' || row.last_action === 'not_remember' ? row.last_action : null,
        },
      ]),
    );
  }

  async weakWordDays(): Promise<WeakWordDayRow[]> {
    if (!this.capabilities.weakRecovery) return [];
    return this.database.weakWordDays().then((rows) =>
      rows.map((row) => ({
        vocabularyId: row.vocabulary_id,
        day: row.day,
        reviewAnswers: row.review_answers,
        reviewFails: row.review_fails,
        practiceAnswers: row.practice_answers,
        practiceFails: row.practice_fails,
        dayPoints: row.day_points,
        lastAction:
          row.last_action === 'remember' || row.last_action === 'not_remember' ? row.last_action : null,
      })),
    );
  }

  async listHistory(): Promise<HistoryEvent[]> {
    return (await this.database.listReviewLogs()).map((row) => ({
      id: row.id,
      vocabularyId: row.vocabulary_id,
      // Before the column existed every row was a review.
      kind: row.kind === 'undo' || row.kind === 'practice' ? row.kind : 'review',
      action: row.action === 'remember' ? 'remember' : 'not_remember',
      mode: row.review_mode,
      reviewedAt: new Date(row.reviewed_at).toISOString(),
      reviewedOn: row.reviewed_on,
      durationMs: row.duration_ms,
      masteryBefore: row.mastery_before,
      masteryAfter: row.mastery_after,
      reviewDateBefore: row.review_date_before,
      reviewDateAfter: row.review_date_after,
      sessionId: row.session_id ?? null,
      undoesId: row.undoes_log_id ?? null,
      scheduler: isSchedulerId(row.scheduler) ? row.scheduler : DEFAULT_SCHEDULER,
      rating: row.rating ?? null,
      confidence: row.confidence ?? null,
      answerCorrect: row.answer_correct ?? null,
      submittedAnswer: row.submitted_answer ?? null,
      grading: row.grading === 'self' || row.grading === 'auto' ? row.grading : null,
    }));
  }

  async recordPractice(write: PracticeWrite): Promise<PracticeWriteResult> {
    if (!this.capabilities.practice) return 'unsupported';
    return this.database.recordPractice(write);
  }

  async practiceDailyStats(from: IsoDate, to: IsoDate): Promise<PracticeDailyStat[]> {
    if (!this.capabilities.practice) return [];
    return (await this.database.practiceDailyStats(from, to))
      // Rows recorded in a mode the app no longer offers are left out of today's figures.
      .filter((row) => isStudyMode(row.review_mode))
      .map((row) => ({
        day: row.day,
        mode: row.review_mode,
        answers: row.answers,
        correct: row.correct,
        durationMs: row.duration_ms,
        timedAnswers: row.timed_answers,
        cards: row.cards,
      }));
  }

  async practiceCorrectCounts(id: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!this.capabilities.practice) return counts;
    for (const mode of await this.database.listCorrectPracticeModes(id)) counts.set(mode, (counts.get(mode) ?? 0) + 1);
    return counts;
  }

  async practiceHistory(since: IsoDate | null): Promise<PracticeHistoryRow[]> {
    if (!this.capabilities.practiceHistory) return [];
    const rows = (await this.database.practiceHistory(since)).filter((row) => isStudyMode(row.review_mode));
    return rows.map((row) => ({
      vocabularyId: row.vocabulary_id,
      mode: row.review_mode as StudyMode,
      correct: row.answer_correct,
      grading: row.grading as 'self' | 'auto',
      submitted: row.submitted_answer,
      reviewedOn: row.reviewed_on,
      reviewedAt: row.reviewed_at,
      durationMs: row.duration_ms,
      confidence: row.confidence,
      sessionId: row.session_id,
    }));
  }

  async confidenceStats(since: IsoDate): Promise<ConfidenceStat[]> {
    if (!this.capabilities.confidence) return [];
    return (await this.database.confidenceStats(since)).map((row) => ({
      confidence: row.confidence as Confidence,
      reviews: row.reviews,
      remembered: row.remembered,
    }));
  }

  async listSchedules(): Promise<ScheduleCard[]> {
    return (await this.database.listCards()).map((row) => ({
      id: row.id,
      word: row.word,
      mastery: row.mastery,
      reviewDate: row.review_date,
      fsrs: fsrsOfCard(row)?.state ?? null,
    }));
  }

  async findReview(requestId: string) {
    const found = await this.database.findReviewByRequestId(requestId);
    return found === null ? null : { mastery: found.mastery, nextReview: found.reviewDate };
  }

  async undoReview(input: { reviewRequestId: string; requestId: string }): Promise<UndoResult> {
    if (!this.capabilities.undo) return { outcome: 'unsupported' };
    const result = await this.database.undoReview(input);
    if (result.outcome === 'not_found' || result.vocabulary_id === null) return { outcome: 'not_found' };
    const state = result.mastery === null ? null : { mastery: result.mastery, nextReview: result.review_date };
    if (result.outcome === 'not_latest' || result.outcome === 'conflict') {
      return { outcome: result.outcome, id: result.vocabulary_id, state };
    }
    if (state === null) return { outcome: 'not_found' };
    return { outcome: result.outcome, id: result.vocabulary_id, state };
  }

  async applyFsrsReview(write: FsrsReviewWrite): Promise<FsrsReviewResult> {
    const record = this.database.recordFsrsReview;
    if (!this.capabilities.fsrsOnly || record === undefined) {
      throw new Error('This database cannot save answers under FSRS alone.');
    }
    const result = await record.call(this.database, {
      id: write.id,
      requestId: write.requestId,
      sessionId: write.sessionId,
      action: write.action,
      expectedRevision: write.expectedRevision,
      countsTowardSchedule: write.countsTowardSchedule,
      rating: write.rating,
      version: write.engine,
      after: write.after === null || write.engine === null ? null : fsrsStateToRow(write.after, write.engine),
      reviewedOn: write.reviewedOn,
      reviewedAt: write.answeredAt,
      durationMs: write.durationMs,
      confidence: write.confidence,
    });
    if (result.outcome === 'not_found') return { outcome: 'not_found' };
    const state = fsrsCardState(result);
    if (result.outcome === 'applied' || result.outcome === 'already_applied') {
      if (state === null) throw new Error('The database confirmed the answer without the card’s new state.');
      return { outcome: result.outcome, state };
    }
    return { outcome: result.outcome, state };
  }

  async undoFsrsReview(input: { reviewRequestId: string; requestId: string }): Promise<FsrsUndoResult> {
    const undo = this.database.undoFsrsReview;
    if (!this.capabilities.fsrsOnly || undo === undefined) {
      throw new Error('This database cannot take answers back under FSRS alone.');
    }
    const result = await undo.call(this.database, input);
    if (result.outcome === 'not_found' || result.vocabulary_id === null) return { outcome: 'not_found' };
    const state = fsrsCardState(result);
    if (result.outcome === 'not_latest' || result.outcome === 'conflict') {
      return { outcome: result.outcome, id: result.vocabulary_id, state };
    }
    if (state === null) return { outcome: 'not_found' };
    return { outcome: result.outcome, id: result.vocabulary_id, state };
  }

  async studyDayCounts(day: IsoDate): Promise<{ newWords: number; reviews: number; practice: number }> {
    const count = this.database.studyDayCounts;
    if (!this.capabilities.fsrsOnly || count === undefined) return { newWords: 0, reviews: 0, practice: 0 };
    const row = await count.call(this.database, day);
    return { newWords: row.new_words, reviews: row.reviews, practice: row.practice };
  }

  async recordStudyDay(row: StudyDayRow): Promise<boolean> {
    const record = this.database.recordStudyDay;
    if (!this.capabilities.fsrsOnly || record === undefined) return row.met;
    return record.call(this.database, row);
  }

  async listMetStudyDays(): Promise<IsoDate[]> {
    const list = this.database.listMetStudyDays;
    if (!this.capabilities.fsrsOnly || list === undefined) return [];
    return list.call(this.database);
  }

  async setEntriesSuspended(ids: readonly string[], suspended: boolean): Promise<EntryData[]> {
    const set = this.database.setCardsSuspended;
    if (!this.capabilities.fsrsOnly || set === undefined) return [];
    return (await set.call(this.database, ids, suspended)).map(toEntry);
  }

  async sessionSummary(sessionId: string): Promise<SessionSummary | null> {
    if (!this.capabilities.sessions) return null;
    const row = await this.database.sessionSummary(sessionId);
    if (row === null) return null;
    return {
      sessionId: row.session_id,
      reviewed: row.reviewed,
      remembered: row.remembered,
      notRemembered: row.not_remembered,
      accuracy: row.reviewed === 0 ? null : row.remembered / row.reviewed,
      firstTime: row.first_time,
      seenBefore: row.reviewed - row.first_time,
      undone: row.undone,
      durationMs: row.duration_ms,
      timedReviews: row.timed_reviews,
    };
  }

  // ---- Whole records ----

  async listEntries() {
    return { entries: (await this.database.listCards()).map(toEntry), invalid: [] };
  }

  async listTrashed(): Promise<EntryData[]> {
    return (await this.database.listTrashedCards()).map(toEntry);
  }

  async getEntry(id: string): Promise<EntryData | null> {
    const row = await this.database.getCard(id);
    return row === null || row.deleted_at !== null ? null : toEntry(row);
  }

  async findEntriesByWord(word: string): Promise<EntryData[]> {
    const wanted = normalizeWord(word);
    const rows = await this.database.findCardsByWordKey(wanted);
    // The stored key is trusted for the lookup; the comparison that counts is repeated here.
    return rows.filter((row) => normalizeWord(row.word) === wanted).map(toEntry);
  }

  async findByRequestId(requestId: string): Promise<EntryData | null> {
    const row = await this.database.findCardByRequestId(requestId);
    return row === null || row.deleted_at !== null ? null : toEntry(row);
  }

  async createEntry(entry: NewEntry): Promise<{ entry: EntryData; created: boolean }> {
    const { id, created } = await this.database.createCard({
      word: entry.word,
      wordKey: normalizeWord(entry.word),
      mastery: entry.mastery,
      meaning: entry.meaning,
      definition: entry.definition,
      example: entry.example,
      dateAdded: entry.dateAdded,
      reviewDate: entry.reviewDate,
      requestId: entry.requestId ?? null,
    });
    // Read back what was stored rather than echoing the request.
    const row = await this.database.getCard(id);
    if (row === null) throw new Error('The new word could not be read back.');
    return { entry: toEntry(row), created };
  }

  async updateEntry(id: string, changes: EntryChanges): Promise<EntryData> {
    const patch: CardPatch = {};
    if (changes.word !== undefined) {
      patch.word = changes.word;
      patch.word_key = normalizeWord(changes.word);
    }
    if (changes.meaning !== undefined) patch.meaning = changes.meaning;
    if (changes.definition !== undefined) patch.definition = changes.definition;
    if (changes.example !== undefined) patch.example = changes.example;
    if (changes.dateAdded !== undefined) patch.date_added = changes.dateAdded;
    if (changes.mastery !== undefined) patch.mastery = changes.mastery;
    if (changes.reviewDate !== undefined) patch.review_date = changes.reviewDate;

    const updated = await this.database.updateCard(id, patch);
    const row = updated ? await this.database.getCard(id) : null;
    if (row === null) throw new Error('The word could not be read back after the change.');
    return toEntry(row);
  }

  async trashEntry(id: string): Promise<boolean> {
    if (await this.database.setCardTrashed(id, true)) return true;
    // Already in the trash counts as done; a word that does not exist does not.
    const row = await this.database.getCard(id);
    return row !== null && row.deleted_at !== null;
  }

  async restoreEntry(id: string): Promise<EntryData | null> {
    await this.database.setCardTrashed(id, false);
    const row = await this.database.getCard(id);
    return row === null || row.deleted_at !== null ? null : toEntry(row);
  }

  // ---- AI Conversations (schema version 10) ----

  async listAiConversations(limit?: number, offset?: number): Promise<AiConversationRow[]> {
    if (!this.capabilities.aiChat) return [];
    return this.database.listAiConversations(limit, offset);
  }

  async createAiConversation(mode: 'general' | 'vocabulary_expert', title?: string): Promise<AiConversationRow> {
    if (!this.capabilities.aiChat) throw new Error('AI chat not supported by this database version.');
    return this.database.createAiConversation(mode, title);
  }

  async getAiConversation(id: string): Promise<AiConversationRow | null> {
    if (!this.capabilities.aiChat) return null;
    return this.database.getAiConversation(id);
  }

  async updateAiConversationTitle(id: string, title: string): Promise<boolean> {
    if (!this.capabilities.aiChat) return false;
    return this.database.updateAiConversationTitle(id, title);
  }

  async deleteAiConversation(id: string): Promise<boolean> {
    if (!this.capabilities.aiChat) return false;
    return this.database.deleteAiConversation(id);
  }

  async listAiMessages(conversationId: string, limit?: number, offset?: number): Promise<AiMessageRow[]> {
    if (!this.capabilities.aiChat) return [];
    return this.database.listAiMessages(conversationId, limit, offset);
  }

  async insertAiMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<AiMessageRow> {
    if (!this.capabilities.aiChat) throw new Error('AI chat not supported by this database version.');
    return this.database.insertAiMessage(conversationId, role, content, metadata);
  }

  async markAiMessageSaved(conversationId: string, messageId: string, vocabularyId: string): Promise<boolean> {
    // The link is a convenience; before version 12 there is nowhere to keep it.
    if (this.schemaVersion < 12) return false;
    return this.database.markAiMessageSaved(conversationId, messageId, vocabularyId);
  }

  async checkAiRateLimit(
    mode: 'general' | 'vocabulary_expert',
    window: 'minute' | 'day',
    limit: number,
  ): Promise<RateLimitCheckRow> {
    if (!this.capabilities.aiChat) throw new Error('AI chat not supported by this database version.');
    return this.database.checkAiRateLimit(mode, window, limit);
  }

  // ---- Vocabulary Analysis (schema version 11) ----

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
    if (!this.capabilities.aiChat) throw new Error('AI chat not supported by this database version.');
    return this.database.upsertVocabularyAnalysis(args);
  }

  async getVocabularyAnalysis(vocabularyId: string): Promise<VocabularyAnalysisRow | null> {
    if (!this.capabilities.aiChat) return null;
    return this.database.getVocabularyAnalysis(vocabularyId);
  }

  async deleteVocabularyAnalysis(vocabularyId: string): Promise<boolean> {
    if (!this.capabilities.aiChat) return false;
    return this.database.deleteVocabularyAnalysis(vocabularyId);
  }
}
