/** The HTTP contract between the browser and the server, validated on both ends. */
import { z } from 'zod';
import { isIsoDate, isValidTimeZone } from './dates.js';
import { LIBRARY_LIMITS, RELATION_KINDS } from './library.js';
import { DEFAULT_SCHEDULER, SCHEDULERS } from './scheduler/active.js';
import { STUDY_MODES } from './study-modes.js';

export const isoDateSchema = z.string().refine(isIsoDate, 'Expected a YYYY-MM-DD calendar date');

/** Which schedule decides when a word is due. */
export const schedulerIdSchema = z.enum(SCHEDULERS);

export const reviewActionSchema = z.enum(['remember', 'not_remember']);

/** Where the data comes from. Shown to the user so sample data is never mistaken for their own. */
export const dataModeSchema = z.enum(['mock', 'supabase']);

export const reviewStateSchema = z.object({
  mastery: z.number(),
  nextReview: isoDateSchema.nullable(),
});

const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** The id of one word. The field keeps the name `pageId` in requests so open pages keep working. */
export const pageIdSchema = z.string().regex(UUID_PATTERN, 'Expected a word id');

/** Canonical dashed, lower-case form so ids compare reliably. */
export function normalizeId(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const cardFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
});

export const reviewCardSchema = z.object({
  id: z.string().min(1),
  word: z.string(),
  mastery: z.number(),
  nextReview: isoDateSchema.nullable(),
  /**
   * The day the schedule in charge has this word due, sent only when that is
   * not the mastery review date above: FSRS is in charge and has seen the word.
   */
  dueOn: isoDateSchema.optional(),
  /** Metadata safe to show before the card is flipped. */
  front: z.array(cardFieldSchema),
  /** Answer fields the current mastery permits. Withheld fields are never sent. */
  back: z.array(cardFieldSchema),
  /** True when the mastery rule withheld detail fields from `back`. */
  detailsHidden: z.boolean(),
});

export const skippedRecordSchema = z.object({
  id: z.string(),
  word: z.string().nullable(),
  reason: z.string(),
});

/** What the store behind the app can do. Features appear only where they are supported. */
export const capabilitiesSchema = z.object({
  /** Answers are grouped into sessions, and a session can be summarised from what was saved. */
  sessions: z.boolean(),
  /** A saved answer can be taken back. */
  undo: z.boolean(),
  /** FSRS is calculated beside the schedule in use, for comparison. */
  fsrs: z.boolean().default(false),
  /** Saved reviews can be summarised: activity, accuracy, and how each word has gone. */
  analytics: z.boolean().default(false),
  /** A daily goal can be kept with the account. */
  goals: z.boolean().default(false),
  /** A confidence rating given before the answer is stored with the answer. */
  confidence: z.boolean().default(false),
  /** Answers in the practice modes are recorded. They never move the schedule. */
  practice: z.boolean().default(false),
  /** Collections, further examples and relationships between words can be kept. */
  library: z.boolean().default(false),
});

/** A store that supports none of the optional features: the starting point for one that supports some. */
export const NO_CAPABILITIES: z.infer<typeof capabilitiesSchema> = {
  sessions: false,
  undo: false,
  fsrs: false,
  analytics: false,
  goals: false,
  confidence: false,
  practice: false,
  library: false,
};

/**
 * Ways to narrow the review queue. Every one of them selects among the words
 * that are already due; none can make a word due.
 */
export const REVIEW_FOCUSES = ['weak', 'overdue', 'due_today', 'recent'] as const;
export const reviewFocusSchema = z.enum(REVIEW_FOCUSES);
export type ReviewFocus = z.infer<typeof reviewFocusSchema>;

/** How many days back "recently added" looks, today included. */
export const RECENTLY_ADDED_DAYS = 7;

/** How sure the reviewer was before the answer was shown: 1 low, 2 medium, 3 high. */
export const confidenceSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const queueResponseSchema = z.object({
  cards: z.array(reviewCardSchema),
  today: isoDateSchema,
  timeZone: z.string(),
  mode: dataModeSchema,
  /** False while the app is a read-only preview: grading saves nothing. */
  writesEnabled: z.boolean(),
  capabilities: capabilitiesSchema.default(NO_CAPABILITIES),
  /** The schedule that decided what is in this queue. */
  scheduler: schedulerIdSchema.default(DEFAULT_SCHEDULER),
  /** Set when the queue was narrowed on request. `weak` is ordered weakest first; the others keep the usual order. */
  focus: reviewFocusSchema.nullable().default(null),
  /** Set when the queue was narrowed to one collection instead: the due words in it, in the usual order. */
  collection: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
  /** Records the source returned that could not be used, so nothing vanishes silently. */
  skipped: z.array(skippedRecordSchema),
  /**
   * Why an empty queue is empty: no words at all, every word mastered, or
   * simply nothing due yet. Always `in_progress` when there are cards.
   */
  vocabulary: z.enum(['empty', 'all_mastered', 'in_progress']),
});

export const reviewActionRequestSchema = z.strictObject({
  pageId: pageIdSchema,
  action: reviewActionSchema,
  /**
   * The state the reviewer saw. It is only ever a precondition: the server
   * computes what to write from its own fresh read, never from these values.
   */
  expected: reviewStateSchema,
  /**
   * Generated once per answer and repeated on a retry, so one answer is
   * recorded once. Optional only so that a page loaded before this field
   * existed keeps working; the server then makes one up, and the comparison
   * with `expected` remains the guard against applying an answer twice.
   */
  requestId: z.uuid().optional(),
  /** How long the card was on screen before it was answered. */
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  /** The sitting this answer belongs to. Chosen by the browser when a review session starts. */
  sessionId: z.uuid().optional(),
  /**
   * How sure the reviewer said they were before the answer was shown. Stored
   * beside the answer; it never changes what the answer does.
   */
  confidence: confidenceSchema.optional(),
});

export const reviewActionResponseSchema = z.object({
  outcome: z.enum(['applied', 'already_applied', 'dry_run']),
  /** The record's confirmed state. For `dry_run`, what would have been written (if known). */
  state: reviewStateSchema.nullable(),
});

/** Takes back one saved answer, named by the request id it was sent with. */
export const reviewUndoRequestSchema = z.strictObject({
  reviewRequestId: z.uuid(),
  /** Identifies this undo, so repeating the request undoes nothing twice. */
  requestId: z.uuid(),
});

export const reviewUndoResponseSchema = z.object({
  outcome: z.enum(['undone', 'already_undone']),
  pageId: z.string(),
  /** The state the word is back in. */
  state: reviewStateSchema,
});

/** What one review session actually saved. Undone and unsaved answers are not in it. */
export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  reviewed: z.number().int(),
  remembered: z.number().int(),
  notRemembered: z.number().int(),
  /** Remembered ÷ reviewed, from 0 to 1; `null` when nothing was reviewed. */
  accuracy: z.number().nullable(),
  /** Answers that were the first recorded review of their word. */
  firstTime: z.number().int(),
  seenBefore: z.number().int(),
  undone: z.number().int(),
  /** Time on the cards that reported one, and how many did. */
  durationMs: z.number().int(),
  timedReviews: z.number().int(),
});

// ---- Scheduling ----

/** Choosing which schedule is in charge. */
export const schedulerChoiceRequestSchema = z.strictObject({ scheduler: schedulerIdSchema });

/**
 * The two schedules side by side. `active` is the one that decides what is
 * due. Both are kept up to date by every saved answer, whichever it is.
 */
export const schedulerReportSchema = z.object({
  active: schedulerIdSchema,
  /** False where the choice cannot be stored yet, or FSRS is not being calculated. */
  switchable: z.boolean().default(false),
  today: isoDateSchema,
  timeZone: z.string(),
  fsrs: z.object({
    /** False where the store cannot hold FSRS state yet. */
    available: z.boolean(),
    /** The library and algorithm version, as the library reports itself. */
    engine: z.string(),
    /** The share of reviews FSRS aims to have remembered, from 0 to 1. */
    requestRetention: z.number(),
    /** How the two answers are rated for FSRS. */
    ratings: z.object({ remember: z.string(), notRemember: z.string() }),
  }),
  totalCards: z.number().int(),
  /** Words that have an FSRS state. A word gets one at its first review after FSRS started being calculated. */
  comparable: z.number().int(),
  cards: z.array(
    z.object({
      id: z.string(),
      word: z.string(),
      mastery: z.number(),
      legacyDue: isoDateSchema.nullable(),
      fsrsDue: isoDateSchema,
      fsrsIntervalDays: z.number().int(),
      differenceDays: z.number().int().nullable(),
      /**
       * FSRS's own estimate of the chance the word would be recalled right now,
       * from 0 to 1. A model's estimate, not a measurement; `null` while FSRS
       * has too few answers for the word to give one.
       */
      recall: z.number().min(0).max(1).nullable().default(null),
    }),
  ),
  workload: z.array(z.object({ date: isoDateSchema, legacy: z.number().int(), fsrs: z.number().int() })),
});

// ---- Simulation ----

const simulationDaySchema = z.object({ date: isoDateSchema, mastery: z.number().int(), fsrs: z.number().int() });

/**
 * A what-if comparison of the two schedules at a chosen target retention. The
 * mastery side is the live schedule; the FSRS side replays the answers that
 * were actually saved. Nothing in it is stored, and no due date changes.
 */
export const simulationResponseSchema = z.object({
  /** False where FSRS is not calculated at all yet (the database predates it). */
  available: z.boolean(),
  today: isoDateSchema,
  timeZone: z.string(),
  /** The target retention FSRS was run at, from 0 to 1. */
  retention: z.number(),
  /** How many days ahead the counts cover, today included. */
  days: z.number().int(),
  /** The saved answers the FSRS side rests on. */
  history: z.object({
    reviews: z.number().int(),
    firstDay: isoDateSchema.nullable(),
    lastDay: isoDateSchema.nullable(),
    leftOut: z.object({ undone: z.number().int(), practice: z.number().int(), otherWords: z.number().int() }),
  }),
  words: z.object({
    /** Live words the mastery level has not retired. */
    active: z.number().int(),
    /** Of those, words with at least one saved answer. */
    replayed: z.number().int(),
    /** Of those, words with none: they keep their mastery dates under both schedules. */
    unseen: z.number().int(),
    retired: z.number().int(),
  }),
  /** Where each active word next falls due. Anything already due counts on the first day. */
  nextDue: z.object({
    days: z.array(simulationDaySchema),
    later: z.object({ mastery: z.number().int(), fsrs: z.number().int() }),
  }),
  /** A stated scenario, not a forecast: every review answered Remember on the day it falls due. */
  ifAllRemembered: z
    .object({
      days: z.array(simulationDaySchema),
      totals: z.object({ mastery: z.number().int(), fsrs: z.number().int() }),
    })
    .nullable(),
  cards: z.array(
    z.object({
      id: z.string(),
      word: z.string(),
      mastery: z.number(),
      /** Saved answers replayed for this word. */
      reviews: z.number().int(),
      masteryDue: isoDateSchema,
      fsrsDue: isoDateSchema,
      fsrsIntervalDays: z.number().int().nullable(),
      differenceDays: z.number().int(),
    }),
  ),
});

// ---- Analytics ----

const periodStatsSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  reviews: z.number().int(),
  remembered: z.number().int(),
  notRemembered: z.number().int(),
  /** Remembered ÷ all answers in the period; `null` on too few answers to say. */
  accuracy: z.number().nullable(),
  repeatReviews: z.number().int(),
  /** Remembered ÷ answers, for words reviewed before; `null` on too few. Observed, not predicted. */
  retention: z.number().nullable(),
  durationMs: z.number(),
  timedReviews: z.number().int(),
  averageMs: z.number().nullable(),
  activeDays: z.number().int(),
});

/** Review activity from saved answers. Undone answers are not counted anywhere in it. */
export const analyticsResponseSchema = z.object({
  /** False where the store keeps no review history to summarise. */
  available: z.boolean(),
  today: isoDateSchema,
  timeZone: z.string(),
  /** Below this many answers no percentage is given. */
  minSample: z.number().int(),
  periods: z.object({ today: periodStatsSchema, week: periodStatsSchema, month: periodStatsSchema }),
  streak: z.object({ current: z.number().int(), longest: z.number().int() }),
  byMode: z.array(
    z.object({ mode: z.string(), reviews: z.number().int(), remembered: z.number().int(), accuracy: z.number().nullable() }),
  ),
  days: z.array(
    z.object({
      date: isoDateSchema,
      reviews: z.number().int(),
      remembered: z.number().int(),
      notRemembered: z.number().int(),
      durationMs: z.number(),
    }),
  ),
  /**
   * The same figures for each of the last twelve weeks, oldest first. A week
   * here is seven days ending on today's weekday, so the last one ends today.
   */
  weeks: z.array(periodStatsSchema).default([]),
  firstReviewOn: isoDateSchema.nullable(),
  windowDays: z.number().int(),
  /**
   * How answers went at each level of confidence given beforehand, over the
   * thirty days ending today. Only answers that carried a rating are counted.
   */
  calibration: z
    .object({
      /** False where the store does not keep confidence ratings. */
      available: z.boolean(),
      levels: z.array(
        z.object({
          confidence: confidenceSchema,
          reviews: z.number().int(),
          remembered: z.number().int(),
          /** Remembered ÷ answers at this level; `null` on too few to say. */
          accuracy: z.number().nullable(),
        }),
      ),
    })
    .default({ available: false, levels: [] }),
  /**
   * Practice in the other study modes over the thirty days ending today.
   * Kept apart from everything above, which counts scheduled reviews only,
   * and one row per mode: the modes test different skills.
   */
  practice: z
    .object({
      /** False where the store does not record practice. */
      available: z.boolean(),
      modes: z.array(
        z.object({
          mode: z.string(),
          answers: z.number().int(),
          correct: z.number().int(),
          /** Correct ÷ answers in this mode; `null` on too few to say. */
          accuracy: z.number().nullable(),
        }),
      ),
      today: z.object({ answers: z.number().int(), correct: z.number().int() }),
    })
    .default({ available: false, modes: [], today: { answers: 0, correct: 0 } }),
});

// ---- Collections, further examples, relationships ----

export const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Live words in the collection. */
  wordIds: z.array(z.string()),
});

export const extraExampleSchema = z.object({
  id: z.string(),
  vocabularyId: z.string(),
  sentence: z.string(),
  source: z.string().nullable(),
  preferred: z.boolean(),
});

export const relationSchema = z.object({
  id: z.string(),
  kind: z.enum(RELATION_KINDS),
  /** The two related words. Their order carries no meaning. */
  a: z.string(),
  b: z.string(),
});

/** Everything the account has organised, in one read. Words in the trash are left out of every list. */
export const libraryResponseSchema = z.object({
  /** False where the store cannot keep any of this yet. */
  available: z.boolean(),
  collections: z.array(collectionSchema),
  examples: z.array(extraExampleSchema),
  relations: z.array(relationSchema),
});

export const collectionNameRequestSchema = z.strictObject({ name: z.string().max(200) });
export const membershipRequestSchema = z.strictObject({ member: z.boolean() });

export const createExampleRequestSchema = z.strictObject({
  sentence: z.string().max(LIBRARY_LIMITS.example + 200),
  source: z.string().max(LIBRARY_LIMITS.source + 100).nullable().optional(),
  preferred: z.boolean().optional(),
});

export const updateExampleRequestSchema = z
  .strictObject({
    sentence: z.string().max(LIBRARY_LIMITS.example + 200).optional(),
    source: z.string().max(LIBRARY_LIMITS.source + 100).nullable().optional(),
    preferred: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');

export const createRelationRequestSchema = z.strictObject({
  fromId: pageIdSchema,
  toId: pageIdSchema,
  kind: z.enum(RELATION_KINDS),
});

export const deletedResponseSchema = z.object({ id: z.string(), deleted: z.literal(true) });

// ---- Practice ----

export const studyModeSchema = z.enum(STUDY_MODES);

export const practiceAnswerSchema = z.discriminatedUnion('kind', [
  /** Recall: the reviewer says whether they had it. */
  z.strictObject({ kind: z.literal('self'), correct: z.boolean() }),
  /** Recognition: the word whose meaning was chosen. */
  z.strictObject({ kind: z.literal('choice'), selectedId: pageIdSchema }),
  /** Typing and cloze. */
  z.strictObject({ kind: z.literal('typed'), text: z.string().max(500) }),
]);

/**
 * One practice answer. The server judges it from its own copy of the word;
 * nothing here can change a word's mastery or review date.
 */
export const practiceRequestSchema = z.strictObject({
  pageId: pageIdSchema,
  mode: studyModeSchema,
  answer: practiceAnswerSchema,
  /** Generated once per answer and repeated on a retry, so one answer is recorded once. */
  requestId: z.uuid(),
  sessionId: z.uuid().optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  confidence: confidenceSchema.optional(),
});

export const practiceResponseSchema = z.object({
  /** `dry_run`: judged, but saving is switched off so nothing was recorded. */
  outcome: z.enum(['recorded', 'already_recorded', 'dry_run']),
  correct: z.boolean(),
  /** For a typed answer, how it matched. */
  typed: z.enum(['exact', 'variant', 'incorrect']).nullable(),
  /** The right answer, as the server has it. */
  expected: z.string(),
});

// ---- Daily goal ----

const goalPartSchema = (max: number) => z.number().int().min(1).max(max).nullable();

/** A daily target. Either part may be empty; both set means both are wanted. */
export const dailyGoalSchema = z.strictObject({
  reviews: goalPartSchema(1000),
  minutes: goalPartSchema(600),
});

const goalProgressSchema = z.object({
  target: z.number(),
  done: z.number(),
  remaining: z.number(),
  met: z.boolean(),
});

/**
 * Today's reviewing set against the goal. A goal never changes what is due:
 * `beyondGoal` cards are still in the queue.
 */
/** The longest range the calendar may ask about at once: a month's grid with room to spare. */
export const REVIEW_DAYS_MAX = 100;

/** Saved reviews per day in a range of the reviewer's days. Days without any are simply absent. */
export const reviewDaysResponseSchema = z.object({
  /** False where the store keeps no review history to count. */
  available: z.boolean(),
  from: isoDateSchema,
  to: isoDateSchema,
  days: z.array(z.object({ date: isoDateSchema, reviews: z.number().int(), remembered: z.number().int() })),
});

export const dayPlanSchema = z.object({
  /** False where the store cannot keep a goal. */
  available: z.boolean(),
  today: isoDateSchema,
  timeZone: z.string(),
  goal: dailyGoalSchema,
  done: z.object({ reviews: z.number().int(), durationMs: z.number() }),
  due: z.object({ total: z.number().int(), overdue: z.number().int() }),
  /** The reviewer's own mean time per card; `null` on too few timed answers. */
  averageMs: z.number().nullable(),
  reviews: goalProgressSchema.nullable(),
  /** In milliseconds. */
  time: goalProgressSchema.nullable(),
  met: z.boolean().nullable(),
  estimatedDueMs: z.number().nullable(),
  cardsToGoal: z.number().int().nullable(),
  beyondGoal: z.number().int().nullable(),
});

export const weakWordSchema = z.object({
  id: z.string(),
  word: z.string(),
  mastery: z.number().nullable(),
  score: z.number(),
  severity: z.enum(['high', 'medium', 'low']),
  /** Heaviest first; the first is the main reason. */
  reasons: z.array(z.object({ code: z.string(), points: z.number(), detail: z.string() })).min(1),
  recent: z.object({ reviews: z.number().int(), remembered: z.number().int() }).nullable(),
  action: z.string(),
  /** Whether the word is in the review queue right now. */
  reviewable: z.boolean(),
});

export const weakWordsResponseSchema = z.object({
  /** False where no review history is kept; words are then judged on overdue time and missing content only. */
  historyAvailable: z.boolean(),
  today: isoDateSchema,
  /** How many days "recent" looks back. */
  windowDays: z.number().int(),
  total: z.number().int(),
  words: z.array(weakWordSchema),
});

// ---- Vocabulary bank ----

export const reviewStatusSchema = z.enum([
  'mastered',
  'overdue',
  'due_today',
  'unscheduled',
  'upcoming',
  'invalid',
]);

/** Limits for what the app will write, matching the checks in the database. Generous for a vocabulary note. */
export const FIELD_LIMITS = { word: 200, text: 6000 } as const;

/** A full vocabulary record as the bank, dashboard and calendar see it. */
export const vocabularyEntrySchema = z.object({
  id: z.string().min(1),
  word: z.string(),
  meaning: z.string().nullable(),
  definition: z.string().nullable(),
  example: z.string().nullable(),
  mastery: z.number().nullable(),
  /** The day the word is next due under the schedule in charge. */
  reviewDate: isoDateSchema.nullable(),
  /**
   * Sent as `fsrs` when FSRS, not the mastery schedule, set the date above.
   * Such a date is FSRS's own and cannot be edited by hand.
   */
  scheduledBy: schedulerIdSchema.optional(),
  dateAdded: isoDateSchema.nullable(),
  reviewStatus: reviewStatusSchema,
  /** Whether the word is in the review queue right now, by the same rule the Review tab uses. */
  reviewable: z.boolean(),
  /** When the record itself was created and last changed, kept apart from the user-entered Date Added. */
  createdTime: z.string().nullable(),
  lastEditedTime: z.string().nullable(),
});

export const vocabularyListResponseSchema = z.object({
  entries: z.array(vocabularyEntrySchema),
  today: isoDateSchema,
  timeZone: z.string(),
  mode: dataModeSchema,
  /** False when the app may not change stored data; adding, editing and deleting are then unavailable. */
  writesEnabled: z.boolean(),
  skipped: z.array(skippedRecordSchema),
  /** What a new word starts with, so the Add form can show it rather than hide it. */
  defaults: z.object({ mastery: z.number(), reviewDate: z.enum(['empty', 'today']) }),
});

export const entryResponseSchema = z.object({ entry: vocabularyEntrySchema });

const wordSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Enter a word').max(FIELD_LIMITS.word, `Keep the word under ${FIELD_LIMITS.word} characters`));

/** Free text: trimmed; an empty string means "no value". */
const textSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(z.string().max(FIELD_LIMITS.text, `Keep this under ${FIELD_LIMITS.text} characters`));

const masterySchema = z
  .number()
  .int('Mastery must be a whole number')
  .min(0, 'Mastery cannot be below 0')
  .max(10, 'Mastery cannot be above 10');

export const createEntryRequestSchema = z.strictObject({
  word: wordSchema,
  meaning: textSchema.optional(),
  definition: textSchema.optional(),
  example: textSchema.optional(),
  /** Defaults to today in the review time zone. */
  dateAdded: isoDateSchema.optional(),
  /** Defaults to the configured starting mastery. */
  mastery: masterySchema.optional(),
  /** `null` means no review date. Omitted means the configured default. */
  reviewDate: isoDateSchema.nullable().optional(),
  /** Set after the user has seen a duplicate warning and chosen to continue. */
  allowDuplicate: z.boolean().optional(),
  /** Identifies one submission, so a repeated request cannot create a second record. */
  requestId: z.uuid(),
});

/** The most words one import request may carry. A longer list is sent as several requests. */
export const IMPORT_BATCH_MAX = 50;

/**
 * One word to import: content only. A mastery or a review date is not
 * accepted here, so an imported word always starts as a newly added one does.
 */
export const importItemSchema = z.strictObject({
  /** Chosen once per row and repeated on a retry, so a row is never imported twice. */
  requestId: z.uuid(),
  word: wordSchema,
  meaning: textSchema.optional(),
  definition: textSchema.optional(),
  example: textSchema.optional(),
  dateAdded: isoDateSchema.optional(),
  /** Set for a row the owner chose to import although the word already exists. */
  allowDuplicate: z.boolean().optional(),
});

/** Rows are checked one by one on the server, so a bad one does not sink the rest. */
export const importRequestSchema = z.strictObject({
  items: z.array(z.unknown()).min(1).max(IMPORT_BATCH_MAX),
});

export const importResponseSchema = z.object({
  /** One result per row that was reached, in the order sent. */
  results: z.array(
    z.object({
      /** `already_imported`: this very row was imported by an earlier request. */
      outcome: z.enum(['imported', 'already_imported', 'duplicate', 'invalid']),
      entry: vocabularyEntrySchema.nullable(),
      message: z.string().nullable(),
    }),
  ),
  /** Set when the store failed part-way: rows from `index` on were not attempted. */
  stopped: z.object({ index: z.number().int(), message: z.string() }).nullable(),
});

export const updateEntryRequestSchema = z
  .strictObject({
    word: wordSchema.optional(),
    meaning: textSchema.optional(),
    definition: textSchema.optional(),
    example: textSchema.optional(),
    dateAdded: isoDateSchema.nullable().optional(),
    /** Review state is only ever changed through this explicit block. */
    schedule: z
      .strictObject({ mastery: masterySchema, reviewDate: isoDateSchema.nullable() })
      .optional(),
    allowDuplicate: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'allowDuplicate'),
    'Nothing to change',
  );

export const deleteEntryResponseSchema = z.object({ id: z.string(), trashed: z.literal(true) });

/** Deleted words that can still be restored. */
export const trashResponseSchema = z.object({ entries: z.array(vocabularyEntrySchema) });

// ---- Application setup and account ----

/**
 * What the browser needs before it can do anything else: whether to ask for
 * an account (always, except with the built-in sample words). The Supabase
 * address and key are the public ones a browser is meant to hold.
 */
export const appConfigResponseSchema = z.object({
  mode: dataModeSchema,
  auth: z.enum(['none', 'account']),
  supabase: z.object({ url: z.string(), publicKey: z.string() }).nullable(),
});

const timeZoneSchema = z
  .string()
  .max(64)
  .refine(isValidTimeZone, 'Expected an IANA time zone such as "Asia/Ho_Chi_Minh"');

export const accountSettingsSchema = z.object({
  /** Decides which calendar day counts as "today" for due dates. */
  timeZone: z.string(),
  /** False where the zone comes from the server's own configuration. */
  timeZoneEditable: z.boolean(),
  /** The signed-in account, where the app uses accounts. */
  email: z.string().nullable(),
  /**
   * How far the database's own schema is from what this version of the app can
   * use. Behind means some features stay off until the next migration is run.
   */
  database: z.object({ version: z.number().int(), latest: z.number().int() }).nullable().default(null),
  /** The retention FSRS aims for, from 0 to 1; `null` where it cannot be stored. */
  fsrsRetention: z.number().nullable().default(null),
});

export const updateSettingsRequestSchema = z
  .strictObject({
    timeZone: timeZoneSchema.optional(),
    fsrsRetention: z.number().min(0.7).max(0.97).optional(),
  })
  .refine((value) => value.timeZone !== undefined || value.fsrsRetention !== undefined, 'Nothing to change');

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  current: reviewStateSchema.optional(),
  /** Existing entries with the same word, when a create or rename was refused as a duplicate. */
  duplicates: z.array(vocabularyEntrySchema).optional(),
});

export type CardField = z.infer<typeof cardFieldSchema>;
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export type SkippedRecord = z.infer<typeof skippedRecordSchema>;
export type QueueResponse = z.infer<typeof queueResponseSchema>;
export type VocabularyStatus = QueueResponse['vocabulary'];
export type ReviewActionRequest = z.infer<typeof reviewActionRequestSchema>;
export type ReviewActionResponse = z.infer<typeof reviewActionResponseSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type ReviewUndoRequest = z.infer<typeof reviewUndoRequestSchema>;
export type ReviewUndoResponse = z.infer<typeof reviewUndoResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SchedulerReport = z.infer<typeof schedulerReportSchema>;
export type SimulationResponse = z.infer<typeof simulationResponseSchema>;
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;
export type DayPlanResponse = z.infer<typeof dayPlanSchema>;
export type ReviewDaysResponse = z.infer<typeof reviewDaysResponseSchema>;
export type LibraryResponse = z.infer<typeof libraryResponseSchema>;
export type ImportResponse = z.infer<typeof importResponseSchema>;
export type PracticeRequest = z.infer<typeof practiceRequestSchema>;
export type PracticeResponse = z.infer<typeof practiceResponseSchema>;
export type WeakWordsResponse = z.infer<typeof weakWordsResponseSchema>;
export type WeakWordView = z.infer<typeof weakWordSchema>;
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type VocabularyEntry = z.infer<typeof vocabularyEntrySchema>;
export type VocabularyListResponse = z.infer<typeof vocabularyListResponseSchema>;
export type CreateEntryRequest = z.infer<typeof createEntryRequestSchema>;
/** The form of a create request before validation trims and tidies it. */
export type CreateEntryInput = z.input<typeof createEntryRequestSchema>;
export type UpdateEntryRequest = z.infer<typeof updateEntryRequestSchema>;
export type UpdateEntryInput = z.input<typeof updateEntryRequestSchema>;
export type AppConfigResponse = z.infer<typeof appConfigResponseSchema>;
export type AccountSettings = z.infer<typeof accountSettingsSchema>;
