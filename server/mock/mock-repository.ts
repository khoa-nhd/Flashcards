import { normalizeId, type Confidence, type SessionSummary } from '../../shared/api.js';
import { HttpError } from '../errors.js';
import type { DailyStat } from '../../shared/analytics.js';
import { addDays, type IsoDate } from '../../shared/dates.js';
import type { HistoryEvent } from '../../shared/export-format.js';
import type { CardHistory } from '../../shared/weak-words.js';
import type { ReviewAction, ReviewState } from '../../shared/review-logic.js';
import { normalizeWord } from '../../shared/text.js';
import { DEFAULT_SCHEDULER, type SchedulerId } from '../../shared/scheduler/active.js';
import type { ScheduleCard } from '../../shared/scheduler/comparison.js';
import type { CardFieldConfig, StoredFsrs, VocabularyRecord } from '../../shared/vocabulary.js';
import type { EntryChanges, EntryData, NewEntry, SenseOperations, VocabularyCatalog } from '../vocabulary-catalog.js';
import type {
  ConfidenceStat,
  PracticeDailyStat,
  PracticeWrite,
  PracticeWriteResult,
  ReviewWrite,
  ReviewWriteResult,
  UndoResult,
  VocabularyRepository,
} from '../vocabulary-repository.js';

export const mockCardFields: CardFieldConfig[] = [
  { key: 'partOfSpeech', label: 'Part of speech', side: 'front', visibility: 'always' },
  { key: 'pronunciation', label: 'Pronunciation', side: 'front', visibility: 'always' },
  { key: 'meaning', label: 'Vietnamese meaning', side: 'back', visibility: 'always' },
  { key: 'definition', label: 'Definition', side: 'back', visibility: 'details' },
  { key: 'example', label: 'Example', side: 'back', visibility: 'details' },
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

import type { Sense } from '../../shared/api.js';

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
  /** The word this one was formed from, as in the real store (schema 11). */
  rootId: string | null;
  /** Kept beside the mastery schedule, as in the real store. */
  fsrs?: StoredFsrs | null;
  /** Senses for this vocabulary entry (schema 13). */
  senses?: Sense[];
  /** Bumped on every sense change, as the real store's senses_version is. */
  sensesVersion?: number;
}

interface MockLog {
  /** Position in the history; also what an undo points at. */
  sequence: number;
  wordId: string;
  requestId: string;
  kind: 'review' | 'undo';
  undoes: number | null;
  action: ReviewAction;
  sessionId: string | null;
  /** The reviewer's calendar day the answer was given on. */
  reviewedOn: IsoDate;
  before: ReviewState;
  after: ReviewState;
  durationMs: number | null;
  /** Present when the answer was saved with an FSRS state: what to put back on Undo. */
  fsrs: { before: StoredFsrs | null; after: StoredFsrs } | null;
  confidence: Confidence | null;
  /** Which schedule was in charge when it was given. */
  scheduler: SchedulerId;
  /** When it was recorded. */
  at: string;
}

/** In-memory sample vocabulary. Nothing here is ever stored anywhere. */
export class MockVocabularyRepository implements VocabularyRepository, VocabularyCatalog {
  readonly mode = 'mock' as const;
  readonly capabilities = {
    sessions: true,
    undo: true,
    fsrs: true,
    analytics: true,
    goals: true,
    confidence: true,
    practice: true,
    library: true,
    roots: true,
    senses: true,
  };

  /** Whether this id is a live sample word; what the library's foreign keys check in the real store. */
  ownsWord(id: string): boolean {
    const word = this.words.get(normalizeId(id));
    return word !== undefined && !word.trashed;
  }
  /** Practice answers, kept apart from the reviews: they never touch a word's schedule. */
  private readonly practice: Array<PracticeWrite & { at: string; state: ReviewState }> = [];
  private readonly words = new Map<string, StoredWord>();
  private readonly logs: MockLog[] = [];
  /** Request id → sense id, so retrying an "add sense" lands on the same sense. */
  private readonly senseRequests = new Map<string, string>();
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
        rootId: null,
        senses: [
          {
            id: `sense-${id}`,
            position: 0,
            meaning,
            definition,
            example,
            archived: false,
            version: 1,
          },
        ],
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

  async listLiveRecords() {
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

  /** The review history, kept the way the real store keeps it: appended to, never edited. */
  private stands(log: MockLog): boolean {
    return log.kind === 'review' && !this.logs.some((other) => other.undoes === log.sequence);
  }

  private stateOf(word: StoredWord): ReviewState {
    return { mastery: word.mastery, nextReview: word.reviewDate };
  }

  async applyReview(write: ReviewWrite): Promise<ReviewWriteResult> {
    const earlier = this.logs.find((log) => log.kind === 'review' && log.requestId === write.requestId);
    if (earlier) {
      if (this.stands(earlier)) return { outcome: 'already_applied', state: earlier.after };
      const moved = this.words.get(earlier.wordId);
      return { outcome: 'undone', state: moved ? this.stateOf(moved) : earlier.before };
    }

    const word = this.words.get(normalizeId(write.id));
    if (!word || word.trashed) return { outcome: 'not_found' };
    const current = this.stateOf(word);
    if (current.mastery !== write.expected.mastery || current.nextReview !== write.expected.nextReview) {
      return { outcome: 'conflict', state: current };
    }
    word.mastery = write.next.mastery;
    word.reviewDate = write.next.nextReview;
    const fsrs = write.fsrs == null ? null : { before: write.fsrs.before, after: { state: write.fsrs.after, engine: write.fsrs.engine } };
    if (fsrs !== null) word.fsrs = fsrs.after;
    this.touch(word);
    this.logs.push({
      sequence: this.logs.length + 1,
      wordId: word.id,
      requestId: write.requestId,
      kind: 'review',
      undoes: null,
      action: write.action,
      sessionId: write.sessionId,
      reviewedOn: write.reviewedOn,
      before: current,
      after: write.next,
      durationMs: write.durationMs,
      fsrs,
      confidence: write.confidence ?? null,
      scheduler: write.scheduler ?? DEFAULT_SCHEDULER,
      at: this.now().toISOString(),
    });
    return { outcome: 'applied', state: write.next };
  }

  async findReview(requestId: string) {
    return this.logs.find((log) => log.kind === 'review' && log.requestId === requestId)?.after ?? null;
  }

  async undoReview(input: { reviewRequestId: string; requestId: string }): Promise<UndoResult> {
    const target = this.logs.find((log) => log.kind === 'review' && log.requestId === input.reviewRequestId);
    if (!target) return { outcome: 'not_found' };

    const undone = this.logs.find((log) => log.undoes === target.sequence);
    if (undone) return { outcome: 'already_undone', id: target.wordId, state: undone.after };

    const word = this.words.get(target.wordId);
    const current = word ? this.stateOf(word) : null;
    const newer = this.logs.some(
      (log) => log.wordId === target.wordId && log.sequence > target.sequence && this.stands(log),
    );
    if (newer) return { outcome: 'not_latest', id: target.wordId, state: current };
    if (!word || word.trashed || current?.mastery !== target.after.mastery || current.nextReview !== target.after.nextReview) {
      return { outcome: 'conflict', id: target.wordId, state: current };
    }

    word.mastery = target.before.mastery;
    word.reviewDate = target.before.nextReview;
    if (target.fsrs !== null) word.fsrs = target.fsrs.before;
    this.touch(word);
    this.logs.push({
      sequence: this.logs.length + 1,
      wordId: word.id,
      requestId: input.requestId,
      kind: 'undo',
      undoes: target.sequence,
      action: target.action,
      sessionId: target.sessionId,
      reviewedOn: target.reviewedOn,
      before: target.after,
      after: target.before,
      durationMs: null,
      fsrs: null,
      confidence: null,
      scheduler: target.scheduler,
      at: this.now().toISOString(),
    });
    return { outcome: 'undone', id: word.id, state: target.before };
  }

  async reviewDailyStats(from: IsoDate, to: IsoDate): Promise<DailyStat[]> {
    const byDay = new Map<IsoDate, DailyStat & { words: Set<string> }>();
    for (const log of this.logs) {
      if (!this.stands(log) || log.reviewedOn < from || log.reviewedOn > to) continue;
      const day = byDay.get(log.reviewedOn) ?? {
        day: log.reviewedOn,
        mode: 'flashcard',
        reviews: 0,
        remembered: 0,
        notRemembered: 0,
        repeatReviews: 0,
        repeatRemembered: 0,
        durationMs: 0,
        timedReviews: 0,
        cards: 0,
        words: new Set<string>(),
      };
      const remembered = log.action === 'remember';
      const seenBefore = this.logs.some(
        (other) => other.wordId === log.wordId && other.sequence < log.sequence && this.stands(other),
      );
      day.reviews += 1;
      day.remembered += remembered ? 1 : 0;
      day.notRemembered += remembered ? 0 : 1;
      day.repeatReviews += seenBefore ? 1 : 0;
      day.repeatRemembered += seenBefore && remembered ? 1 : 0;
      day.durationMs += log.durationMs ?? 0;
      day.timedReviews += log.durationMs === null ? 0 : 1;
      day.words.add(log.wordId);
      day.cards = day.words.size;
      byDay.set(log.reviewedOn, day);
    }
    return [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(({ words: _words, ...stat }) => {
        void _words;
        return stat;
      });
  }

  async cardReviewStats(since: IsoDate): Promise<Map<string, CardHistory>> {
    const stats = new Map<string, CardHistory & { days: Set<IsoDate> }>();
    for (const log of this.logs) {
      if (!this.stands(log)) continue;
      const entry = stats.get(log.wordId) ?? {
        reviews: 0,
        failures: 0,
        recentReviews: 0,
        recentFailures: 0,
        failedDays: 0,
        lastReviewedOn: null,
        lastFailedOn: null,
        lastAction: null,
        lastConfidence: null,
        days: new Set<IsoDate>(),
      };
      const failed = log.action === 'not_remember';
      const recent = log.reviewedOn >= since;
      entry.reviews += 1;
      entry.failures += failed ? 1 : 0;
      entry.recentReviews += recent ? 1 : 0;
      entry.recentFailures += recent && failed ? 1 : 0;
      if (failed) entry.days.add(log.reviewedOn);
      entry.failedDays = entry.days.size;
      // The history is in order, so the latest log seen is the latest answer.
      entry.lastReviewedOn = log.reviewedOn;
      if (failed) entry.lastFailedOn = log.reviewedOn;
      entry.lastAction = log.action;
      entry.lastConfidence = log.confidence;
      stats.set(log.wordId, entry);
    }
    return new Map(
      [...stats].map(([id, { days: _days, ...history }]) => {
        void _days;
        return [id, history];
      }),
    );
  }

  async recordPractice(write: PracticeWrite): Promise<PracticeWriteResult> {
    if (this.practice.some((earlier) => earlier.requestId === write.requestId)) return 'already_recorded';
    const word = this.words.get(normalizeId(write.id));
    if (!word || word.trashed) return 'not_found';
    this.practice.push({ ...write, id: word.id, at: this.now().toISOString(), state: this.stateOf(word) });
    return 'recorded';
  }

  async listHistory(): Promise<HistoryEvent[]> {
    const reviews: HistoryEvent[] = this.logs.map((log) => ({
      id: `00000000-0000-4000-b000-${String(log.sequence).padStart(12, '0')}`,
      vocabularyId: log.wordId,
      kind: log.kind,
      action: log.action,
      mode: 'flashcard',
      reviewedAt: log.at,
      reviewedOn: log.reviewedOn,
      durationMs: log.durationMs,
      masteryBefore: log.before.mastery,
      masteryAfter: log.after.mastery,
      reviewDateBefore: log.before.nextReview,
      reviewDateAfter: log.after.nextReview,
      sessionId: log.sessionId,
      undoesId: log.undoes === null ? null : `00000000-0000-4000-b000-${String(log.undoes).padStart(12, '0')}`,
      scheduler: log.scheduler,
      rating: null,
      confidence: log.confidence,
      answerCorrect: null,
      submittedAnswer: null,
      grading: null,
    }));
    const practised: HistoryEvent[] = this.practice.map((answer, index) => ({
      id: `00000000-0000-4000-c000-${String(index + 1).padStart(12, '0')}`,
      vocabularyId: answer.id,
      kind: 'practice',
      action: answer.correct ? 'remember' : 'not_remember',
      mode: answer.mode,
      reviewedAt: answer.at,
      reviewedOn: answer.reviewedOn,
      durationMs: answer.durationMs,
      masteryBefore: answer.state.mastery,
      masteryAfter: answer.state.mastery,
      reviewDateBefore: answer.state.nextReview,
      reviewDateAfter: answer.state.nextReview,
      sessionId: answer.sessionId,
      undoesId: null,
      // Practice moves no schedule, whichever is in charge.
      scheduler: DEFAULT_SCHEDULER,
      rating: null,
      confidence: answer.confidence,
      answerCorrect: answer.correct,
      submittedAnswer: answer.submitted,
      grading: answer.grading,
    }));
    return [...reviews, ...practised].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
  }

  async practiceDailyStats(from: IsoDate, to: IsoDate): Promise<PracticeDailyStat[]> {
    const groups = new Map<string, PracticeDailyStat & { words: Set<string> }>();
    for (const answer of this.practice) {
      if (answer.reviewedOn < from || answer.reviewedOn > to) continue;
      const key = `${answer.reviewedOn} ${answer.mode}`;
      const group = groups.get(key) ?? {
        day: answer.reviewedOn,
        mode: answer.mode,
        answers: 0,
        correct: 0,
        durationMs: 0,
        timedAnswers: 0,
        cards: 0,
        words: new Set<string>(),
      };
      group.answers += 1;
      group.correct += answer.correct ? 1 : 0;
      group.durationMs += answer.durationMs ?? 0;
      group.timedAnswers += answer.durationMs === null ? 0 : 1;
      group.words.add(answer.id);
      group.cards = group.words.size;
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((a, b) => a.day.localeCompare(b.day) || a.mode.localeCompare(b.mode))
      .map(({ words: _words, ...stat }) => {
        void _words;
        return stat;
      });
  }

  async confidenceStats(since: IsoDate): Promise<ConfidenceStat[]> {
    const levels = new Map<Confidence, ConfidenceStat>();
    for (const log of this.logs) {
      if (!this.stands(log) || log.confidence === null || log.reviewedOn < since) continue;
      const level = levels.get(log.confidence) ?? { confidence: log.confidence, reviews: 0, remembered: 0 };
      level.reviews += 1;
      level.remembered += log.action === 'remember' ? 1 : 0;
      levels.set(log.confidence, level);
    }
    return [...levels.values()].sort((a, b) => a.confidence - b.confidence);
  }

  async listSchedules(): Promise<ScheduleCard[]> {
    return this.live().map((word) => ({
      id: word.id,
      word: word.word,
      mastery: word.mastery,
      reviewDate: word.reviewDate,
      fsrs: word.fsrs?.state ?? null,
    }));
  }

  async sessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const mine = this.logs.filter((log) => log.sessionId === sessionId);
    if (mine.length === 0) return null;
    const standing = mine.filter((log) => this.stands(log));
    const remembered = standing.filter((log) => log.action === 'remember').length;
    const firstTime = standing.filter(
      (log) => !this.logs.some((other) => other.wordId === log.wordId && other.sequence < log.sequence && this.stands(other)),
    ).length;
    const timed = standing.filter((log) => log.durationMs !== null);
    return {
      sessionId,
      reviewed: standing.length,
      remembered,
      notRemembered: standing.length - remembered,
      accuracy: standing.length === 0 ? null : remembered / standing.length,
      firstTime,
      seenBefore: standing.length - firstTime,
      undone: mine.filter((log) => log.kind === 'undo').length,
      durationMs: timed.reduce((total, log) => total + (log.durationMs ?? 0), 0),
      timedReviews: timed.length,
    };
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

  async listTrashed() {
    return [...this.words.values()].filter((word) => word.trashed).map(toEntry);
  }

  async createEntry(entry: NewEntry): Promise<{ entry: EntryData; created: boolean }> {
    this.created += 1;
    const id = `00000000-0000-4000-9000-${String(this.created).padStart(12, '0')}`;
    const timestamp = this.now().toISOString();
    const word: StoredWord = {
      id,
      word: entry.word,
      meaning: entry.meaning,
      definition: entry.definition,
      example: entry.example,
      mastery: entry.mastery,
      reviewDate: entry.reviewDate,
      dateAdded: entry.dateAdded,
      partOfSpeech: null,
      pronunciation: null,
      trashed: false,
      createdTime: timestamp,
      lastEditedTime: timestamp,
      rootId: null,
      senses: entry.meaning || entry.definition || entry.example ? [{
        id: `sense-${id}`,
        position: 0,
        meaning: entry.meaning,
        definition: entry.definition,
        example: entry.example,
        archived: false,
        version: 1,
      }] : [],
      sensesVersion: 0,
    };
    this.words.set(id, word);
    return { entry: toEntry(word), created: true };
  }

  async updateEntry(id: string, changes: EntryChanges): Promise<EntryData> {
    const word = this.words.get(normalizeId(id));
    if (!word || word.trashed) throw new Error(`Unknown sample record: ${id}`);
    // The version the caller expected is checked, then left off the stored word.
    const { expectSensesVersion, ...rest } = changes;
    if (expectSensesVersion !== undefined && expectSensesVersion !== (word.sensesVersion ?? 0)) {
      throw new HttpError(409, 'conflict', 'This word changed while you were editing it. Reload and try again.');
    }
    Object.assign(word, rest);
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

  // ---- SenseOperations (schema version 13) ----
  /** The sense operations, reachable as `catalog.senses`. */
  get senses(): SenseOperations {
    return this;
  }

  private bumpSenses(word: StoredWord) {
    word.sensesVersion = (word.sensesVersion ?? 0) + 1;
  }

  async listSenses(vocabularyId: string): Promise<Sense[]> {
    const word = this.words.get(normalizeId(vocabularyId));
    if (!word) return [];
    // Archived senses stay listed, exactly as the real store lists them.
    return [...(word.senses ?? [])].sort((a, b) => a.position - b.position);
  }

  async getSense(id: string): Promise<Sense | null> {
    for (const word of this.words.values()) {
      const sense = word.senses?.find(s => s.id === id);
      if (sense) return sense;
    }
    return null;
  }

  async createSense(
    vocabularyId: string,
    sense: { meaning: string | null; definition: string | null; example: string | null; requestId: string },
    options?: { resume?: boolean; archived?: boolean },
  ): Promise<{ sense: Sense; created: boolean }> {
    const word = this.words.get(normalizeId(vocabularyId));
    if (!word) throw new Error(`Unknown sample record: ${vocabularyId}`);
    // A retry of the same action carries the same request id and lands on the same sense.
    const seen = this.senseRequests.get(sense.requestId);
    if (seen !== undefined) {
      const found = (word.senses ?? []).find((s) => s.id === seen);
      if (found) {
        // The import's completion call may still set the archive flag its
        // file carried; nothing else about a stored sense changes.
        if (options?.archived === true && !found.archived) {
          found.archived = true;
          found.version += 1;
          this.bumpSenses(word);
        }
        return { sense: found, created: false };
      }
    }
    const senses = word.senses ?? [];
    const position = senses.reduce((highest, s) => Math.max(highest, s.position), -1) + 1;
    const newSense: Sense = {
      id: `sense-${crypto.randomUUID()}`,
      position,
      meaning: sense.meaning,
      definition: sense.definition,
      example: sense.example,
      archived: options?.archived === true,
      version: 1,
    };
    senses.push(newSense);
    word.senses = senses;
    this.senseRequests.set(sense.requestId, newSense.id);
    this.bumpSenses(word);
    return { sense: newSense, created: true };
  }

  async updateSense(id: string, patch: { meaning?: string | null; definition?: string | null; example?: string | null; expectedVersion: number }): Promise<Sense | 'stale' | 'not_found'> {
    for (const word of this.words.values()) {
      const sense = word.senses?.find((s) => s.id === id);
      if (sense) {
        if (sense.version !== patch.expectedVersion) return 'stale';
        if (patch.meaning !== undefined) sense.meaning = patch.meaning;
        if (patch.definition !== undefined) sense.definition = patch.definition;
        if (patch.example !== undefined) sense.example = patch.example;
        sense.version += 1;
        this.bumpSenses(word);
        return sense;
      }
    }
    return 'not_found';
  }

  async reorderSenses(vocabularyId: string, senseIds: string[], expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'> {
    const word = this.words.get(normalizeId(vocabularyId));
    if (!word) return 'not_found';
    if ((word.sensesVersion ?? 0) !== expectedVersion) return 'stale';
    const senses = word.senses ?? [];
    const live = senses.filter((s) => !s.archived);
    // The order sent must name every live sense exactly once.
    if (senseIds.length !== live.length || senseIds.some((id) => !live.some((s) => s.id === id))) {
      return 'not_found';
    }
    const ordered = senseIds.map((id, index) => {
      const sense = live.find((s) => s.id === id)!;
      return { ...sense, position: index };
    });
    // The archived senses pack in behind, so a restore starts past them.
    const archived = senses
      .filter((s) => s.archived)
      .sort((a, b) => a.position - b.position)
      .map((sense, index) => ({ ...sense, position: ordered.length + index }));
    word.senses = [...ordered, ...archived];
    this.bumpSenses(word);
    return 'ok';
  }

  async archiveSense(id: string, expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'> {
    for (const word of this.words.values()) {
      const sense = word.senses?.find((s) => s.id === id);
      if (sense) {
        if (sense.version !== expectedVersion || sense.archived) return 'stale';
        sense.archived = true;
        sense.version += 1;
        this.bumpSenses(word);
        return 'ok';
      }
    }
    return 'not_found';
  }

  async restoreSense(id: string, expectedVersion: number): Promise<'ok' | 'stale' | 'not_found'> {
    for (const word of this.words.values()) {
      const sense = word.senses?.find((s) => s.id === id);
      if (sense) {
        if (sense.version !== expectedVersion || !sense.archived) return 'stale';
        // Restored senses go to the end: their old position may have been taken.
        const senses = word.senses ?? [];
        sense.position = senses.reduce((highest, s) => Math.max(highest, s.position), -1) + 1;
        sense.archived = false;
        sense.version += 1;
        this.bumpSenses(word);
        return 'ok';
      }
    }
    return 'not_found';
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
    fsrs: word.fsrs ?? null,
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
    fsrsDue: word.fsrs?.state.due ?? null,
    dateAdded: word.dateAdded,
    createdTime: word.createdTime,
    lastEditedTime: word.lastEditedTime,
    rootId: word.rootId,
    // Archived senses stay listed, exactly as the real store lists them.
    senses: [...(word.senses ?? [])].sort((a, b) => a.position - b.position),
    sensesVersion: word.sensesVersion ?? 0,
  };
}
