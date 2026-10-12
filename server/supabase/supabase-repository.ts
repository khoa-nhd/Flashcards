import type { Capabilities, Confidence, SessionSummary, SkippedRecord, VocabularyStatus } from '../../shared/api.js';
import type { DailyStat } from '../../shared/analytics.js';
import type { IsoDate } from '../../shared/dates.js';
import type { HistoryEvent } from '../../shared/export-format.js';
import type { CardHistory } from '../../shared/weak-words.js';
import type { ReviewRules } from '../../shared/review-logic.js';
import { normalizeWord } from '../../shared/text.js';
import { DEFAULT_SCHEDULER, isSchedulerId } from '../../shared/scheduler/active.js';
import type { ScheduleCard } from '../../shared/scheduler/comparison.js';
import type { StoredFsrs, VocabularyRecord } from '../../shared/vocabulary.js';
import type { EntryChanges, EntryData, NewEntry, VocabularyCatalog } from '../vocabulary-catalog.js';
import type {
  ConfidenceStat,
  PracticeDailyStat,
  PracticeWrite,
  PracticeWriteResult,
  ReviewWrite,
  ReviewWriteResult,
  SetupReport,
  UndoResult,
  VocabularyRepository,
} from '../vocabulary-repository.js';
import {
  LATEST_SCHEMA_VERSION,
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
    schemaVersion: number = LATEST_SCHEMA_VERSION,
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
    return (await this.database.practiceDailyStats(from, to)).map((row) => ({
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

}
