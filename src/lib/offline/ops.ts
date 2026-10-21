/**
 * The offline operation model, shared by everything that writes.
 *
 * Every change — a review answer, a practice answer, a word added, edited or
 * removed — becomes one immutable operation in the outbox. Nothing is written
 * anywhere else: what is on screen is the last confirmed server state with the
 * outstanding operations folded over it, so one answer by one code path works
 * the same online and offline, and a retry can never apply an operation twice
 * (the request id identifies it to the server).
 *
 * The functions here are pure, so the projection can be tested without a
 * browser, a database or a clock.
 */
import type { Confidence, CreateEntryInput, UpdateEntryInput, VocabularyEntry } from '../../../shared/api.js';
import type { ReviewAction, ReviewState } from '../../../shared/review-logic.js';
import type { StudyMode } from '../../../shared/study-modes.js';
import { compareDates, isIsoDate } from '../../../shared/dates.js';
import type { OutboxRecord } from './storage.js';

export type OutboxKind = OutboxRecord['kind'];

/** One review answer, as the outbox carries it. */
export type ReviewActionPayload = {
  pageId: string;
  action: ReviewAction;
  /** The state the card was shown in; the server's own precondition. */
  expected: ReviewState;
  /**
   * The revision the card was shown at, where the server keeps revisions (FSRS
   * as the only schedule). The stronger precondition: the answer is refused
   * if the card has moved on since.
   */
  expectedRevision?: number;
  /** The sitting the answer belongs to. */
  sessionId: string | null;
  durationMs: number | null;
  /**
   * Whether this answer may be taken for a word the schedule does not call due
   * yet. Set by the narrowing it was given under, and read by the server.
   */
  allowNotDue: boolean;
  /**
   * Whether this answer moves the word. Read when the answer was given, not
   * when it is sent, so the switch may be changed mid-sitting.
   */
  countsTowardMastery: boolean;
  confidence: Confidence | null;
  /**
   * The word, for notices on this device only. The request the server hears is
   * built field by field, so this never travels.
   */
  word: string;
};

/** One practice answer, as the outbox carries it. */
export type PracticePayload = {
  pageId: string;
  mode: StudyMode;
  answer: { kind: 'choice'; selectedId: string } | { kind: 'typed'; text: string };
  sessionId: string | null;
  durationMs: number | null;
  confidence: Confidence | null;
};

/** A word added while offline: the whole optimistic entry travels with it, so a reload can still show it. */
export type VocabCreatePayload = {
  /** The id the entry carries until the server names a real one. */
  tempId: string;
  entry: VocabularyEntry;
  /** The content only: the request id is the operation's own id, added when it is sent. */
  input: Omit<CreateEntryInput, 'requestId'>;
};

export type VocabUpdatePayload = {
  id: string;
  input: UpdateEntryInput;
};

export type VocabDeletePayload = {
  id: string;
};

export type OpPayload =
  | { kind: 'review_action'; payload: ReviewActionPayload }
  | { kind: 'practice'; payload: PracticePayload }
  | { kind: 'vocab_create'; payload: VocabCreatePayload }
  | { kind: 'vocab_update'; payload: VocabUpdatePayload }
  | { kind: 'vocab_delete'; payload: VocabDeletePayload };

/** Whether the operation is one the review session is waiting on. */
export const isReviewOp = (op: OutboxRecord): boolean => op.kind === 'review_action';

/** Whether the operation changes the vocabulary bank (as opposed to reviewing it). */
export const isVocabularyOp = (op: OutboxRecord): boolean =>
  op.kind === 'vocab_create' || op.kind === 'vocab_update' || op.kind === 'vocab_delete';

/** Operations that still have to be sent (a refused one will not be sent again by itself). */
export const isOutstanding = (op: OutboxRecord): boolean => op.status === 'pending' || op.status === 'syncing';

/** The word state an entry is shown in while an operation about it is outstanding. */
export function projectVocabulary(
  base: readonly VocabularyEntry[],
  ops: readonly OutboxRecord[],
  context: { today: string | null; resolveId?: (id: string) => string },
): VocabularyEntry[] {
  const resolve = context.resolveId ?? ((id: string) => id);
  const entries = new Map(base.map((entry) => [entry.id, entry]));
  const created: VocabularyEntry[] = [];

  for (const op of ops) {
    // A refused operation never reached the server, so it changes nothing; it is
    // kept only so the person can retry or dismiss it.
    if (!isOutstanding(op)) continue;
    switch (op.kind) {
      case 'vocab_create': {
        const payload = op.payload as unknown as VocabCreatePayload;
        if (!entries.has(payload.tempId) && !created.some((entry) => entry.id === payload.tempId)) {
          created.push(payload.entry);
        }
        break;
      }
      case 'vocab_update': {
        const payload = op.payload as unknown as VocabUpdatePayload;
        // The word may still carry the temporary id its create gave it; by the
        // time this operation is folded in, the real id may be known.
        const id = resolve(payload.id);
        const current = entries.get(id) ?? created.find((entry) => entry.id === id) ?? null;
        if (current !== null) {
          const next = optimisticUpdate(current, payload.input, context.today);
          const at = created.findIndex((entry) => entry.id === id);
          if (at !== -1) created[at] = next;
          else entries.set(id, next);
        }
        break;
      }
      case 'vocab_delete': {
        const payload = op.payload as unknown as VocabDeletePayload;
        const id = resolve(payload.id);
        entries.delete(id);
        const at = created.findIndex((entry) => entry.id === id);
        if (at !== -1) created.splice(at, 1);
        break;
      }
      default:
        // Review and practice operations do not change the bank's own content.
        break;
    }
  }

  return [...created, ...entries.values()];
}

/** The rules a new or edited word is shown under, for the moment before the server answers. */
const OPTIMISTIC_RETIRED_AT_MASTERY = 10;

export const tidyWord = (word: string): string => word.normalize('NFC').trim().replace(/\s+/g, ' ');

export const tidyText = (text: string | undefined | null): string | null => {
  const tidy = text == null ? '' : text.normalize('NFC').trim();
  return tidy === '' ? null : tidy;
};

/** Whether a word with this mastery and date is due, judged the way the server judges it. */
export function statusFor(
  mastery: number | null,
  reviewDate: string | null,
  today: string | null,
): VocabularyEntry['reviewStatus'] {
  if (mastery === null || !Number.isInteger(mastery) || mastery < 0) return 'invalid';
  if (mastery >= OPTIMISTIC_RETIRED_AT_MASTERY) return 'mastered';
  if (reviewDate === null || !isIsoDate(reviewDate)) return 'unscheduled';
  const order = compareDates(reviewDate, today ?? reviewDate);
  if (order < 0) return 'overdue';
  return order === 0 ? 'due_today' : 'upcoming';
}

const isReviewable = (status: VocabularyEntry['reviewStatus']): boolean =>
  status === 'overdue' || status === 'due_today' || status === 'unscheduled';

/** A new word as it looks before the database has confirmed it. */
export function optimisticCreate(
  input: Omit<CreateEntryInput, 'requestId'>,
  defaults: { mastery: number; reviewDate: 'empty' | 'today'; today: string } | null,
  localId: string,
): VocabularyEntry {
  const today = defaults?.today ?? null;
  const mastery = input.mastery ?? defaults?.mastery ?? null;
  const reviewDate =
    input.reviewDate !== undefined ? input.reviewDate : defaults?.reviewDate === 'today' ? (defaults?.today ?? null) : null;
  const reviewStatus = statusFor(mastery, reviewDate, today);
  return {
    id: localId,
    word: tidyWord(input.word),
    meaning: tidyText(input.meaning),
    definition: tidyText(input.definition),
    example: tidyText(input.example),
    mastery,
    reviewDate,
    dateAdded: input.dateAdded ?? today,
    reviewStatus,
    reviewable: isReviewable(reviewStatus),
    createdTime: null,
    lastEditedTime: null,
    suspended: false,
    revision: 0,
  };
}

/** The entry an edit would leave behind, before the database has confirmed it. */
export function optimisticUpdate(
  entry: VocabularyEntry,
  input: UpdateEntryInput,
  today: string | null,
): VocabularyEntry {
  const mastery = input.schedule?.mastery ?? entry.mastery;
  const reviewDate = input.schedule === undefined ? entry.reviewDate : input.schedule.reviewDate;
  const reviewStatus = statusFor(mastery, reviewDate, today);
  return {
    ...entry,
    word: input.word === undefined ? entry.word : tidyWord(input.word),
    meaning: input.meaning === undefined ? entry.meaning : tidyText(input.meaning),
    definition: input.definition === undefined ? entry.definition : tidyText(input.definition),
    example: input.example === undefined ? entry.example : tidyText(input.example),
    dateAdded: input.dateAdded === undefined ? entry.dateAdded : input.dateAdded,
    mastery,
    reviewDate,
    reviewStatus,
    reviewable: isReviewable(reviewStatus),
  };
}

/** The word an edit is about, where the id is still the temporary one a create carried. */
export function resolveEntityId(id: string, ids: ReadonlyMap<string, string>): string {
  return ids.get(id) ?? id;
}

/** Every card id with any review operation recorded at or after `since`. */
export function answeredCards(ops: readonly OutboxRecord[], since: number): Set<string> {
  const answered = new Set<string>();
  for (const op of ops) {
    if (op.kind !== 'review_action' || op.createdAt < since) continue;
    const payload = op.payload as unknown as ReviewActionPayload;
    if (typeof payload.pageId === 'string') answered.add(payload.pageId);
  }
  return answered;
}
