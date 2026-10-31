/** The HTTP contract between the browser and the server, validated on both ends. */
import { z } from 'zod';
import { isIsoDate, isValidTimeZone } from './dates.js';
import { LIBRARY_LIMITS, RELATION_KINDS } from './library.js';
import { DEFAULT_SCHEDULER, SCHEDULERS } from './scheduler/active.js';
import { fsrsStateSchema } from './scheduler/fsrs.js';
import { PRACTICE_MASTERY_MAX, STUDY_MODES } from './study-modes.js';

export const isoDateSchema = z.string().refine(isIsoDate, 'Expected a YYYY-MM-DD calendar date');

/** Which schedule decides when a word is due. */
export const schedulerIdSchema = z.enum(SCHEDULERS);

export const reviewActionSchema = z.enum(['remember', 'not_remember']);

/** Where the data comes from. Shown to the user so sample data is never mistaken for their own. */
export const dataModeSchema = z.enum(['mock', 'supabase']);

/**
 * The display scale derived from FSRS stability. It is never used to decide
 * when a word is due.
 */
export const memoryStrengthSchema = z.object({
  level: z.number().int().min(1).max(10),
  label: z.enum(['New', 'Learning', 'Familiar', 'Strong', 'Master']),
  percent: z.number().min(0).max(100),
  stabilityDays: z.number().nullable(),
  difficulty: z.number().nullable(),
  reps: z.number().int().min(0),
  lapses: z.number().int().min(0),
  lastReview: z.string().nullable(),
  retrievability: z.number().min(0).max(1).nullable(),
  nextIntervalDays: z.number().int().nullable(),
});

export type MemoryStrength = z.infer<typeof memoryStrengthSchema>;

/**
 * The state a review changes. `mastery` and `nextReview` are the display
 * mirror kept for older clients and rollback; scheduling reads only FSRS.
 */
export const reviewStateSchema = z.object({
  mastery: z.number(),
  nextReview: isoDateSchema.nullable(),
  /** The FSRS state after this answer, where FSRS has seen the word. */
  fsrs: fsrsStateSchema.nullable().optional(),
  fsrsEngine: z.string().optional(),
  /** A fallback due day for a word FSRS has never seen. */
  dueOn: isoDateSchema.nullable().optional(),
  revision: z.number().int().min(0).optional(),
  suspended: z.boolean().optional(),
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

/** How far a word is from leaving the weak list, and whether it has left. */
export const weakRecoverySchema = z.object({
  /** Points earned in the current cycle, after forgotten answers and expiry. */
  points: z.number().int().min(0),
  /** Points the word needs; a High word needs one more than the rest. */
  threshold: z.number().int().min(3),
  /** True when the word has graduated and has not slipped since. */
  recovered: z.boolean(),
  /** The last day the word was remembered, review or practice. */
  lastRememberedOn: isoDateSchema.nullable(),
});

export type WeakRecoveryView = z.infer<typeof weakRecoverySchema>;

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
  /** The FSRS-derived strength shown to the reviewer. */
  memory: memoryStrengthSchema.optional(),
  /** True when the answer details start folded away (strength level 6 and above). */
  detailCollapsed: z.boolean().default(false),
  /** The stored revision this card was read at, where the database keeps one. */
  revision: z.number().int().min(0).optional(),
  /** Archived words never appear in a review queue. */
  suspended: z.boolean().default(false),
  /** Metadata safe to show before the card is flipped. */
  front: z.array(cardFieldSchema),
  /** Answer fields. Detail fields may start folded, but are never withheld. */
  back: z.array(cardFieldSchema),
  /** True when the mastery rule withheld detail fields from `back` (legacy mode only). */
  detailsHidden: z.boolean(),
  /** How far this word is from leaving the weak list, where it is on that list. */
  recovery: weakRecoverySchema.optional(),
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
  /** Detailed practice history for True Mastery estimation. */
  practiceHistory: z.boolean().default(false),
  /** Collections, further examples and relationships between words can be kept. */
  library: z.boolean().default(false),
  /** AI chat conversations and messages can be kept. */
  aiChat: z.boolean().default(false),
  /** A weak word's recovery is worked out from saved answers. */
  weakRecovery: z.boolean().default(false),
  /**
   * FSRS is the only schedule: answers are saved with a revision guard, words
   * can be archived, and mastery is no longer written (schema version 15).
   */
  fsrsOnly: z.boolean().default(false),
  /** XP, levels, quests, badges and streak freezes are kept (schema version 17). */
  game: z.boolean().default(false),
  /** Leagues, nicknames, friends and profiles (schema version 18). */
  competition: z.boolean().default(false),
  /** Stardust, the shop, chests, companions, the weekly boss and events (schema version 19). */
  economy: z.boolean().default(false),
  /** Reminders by web push (schema version 20). */
  notifications: z.boolean().default(false),
  /** PvP word duels (schema version 21). */
  pvp: z.boolean().default(false),
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
  practiceHistory: false,
  library: false,
  aiChat: false,
  weakRecovery: false,
  fsrsOnly: false,
  game: false,
  competition: false,
  economy: false,
  notifications: false,
  pvp: false,
};

/**
 * Ways to narrow the review queue. `weak` is the only narrowing the server can
 * work out for itself: it selects among the words that are already due, and may
 * also bring a weak word forward. The reviewer's own picked words are not named
 * here — only the device knows which ones were ticked — so they travel as ids
 * on the queue request instead.
 */
export const REVIEW_FOCUSES = ['weak', 'early', 'random'] as const;
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
  /** True when FSRS is the only scheduler: the UI then never offers a choice. */
  fsrsOnly: z.boolean().default(false),
  /** Due words left out today by the account's daily review limit (FSRS alone). */
  heldBack: z.number().int().min(0).default(0),
  /** Set when the queue was narrowed on request. `weak` is ordered weakest first. */
  focus: reviewFocusSchema.nullable().default(null),
  /**
   * Set when the queue is the reviewer's own picked words, in the order they
   * were ticked. The words themselves are never echoed back; the device that
   * picked them already has them.
   */
  selection: z.boolean().default(false),
  /** Records the source returned that could not be used, so nothing vanishes silently. */
  skipped: z.array(skippedRecordSchema),
  /**
   * Why an empty queue is empty: no words at all, every word mastered, or
   * simply nothing due yet. Always `in_progress` when there are cards.
   */
  vocabulary: z.enum(['empty', 'all_mastered', 'in_progress']),
});

/**
 * The words the reviewer picked, in the order they were ticked. Sent as a body
 * rather than in the address: a handful of words would fit in a URL, the whole
 * bank would not.
 */
export const reviewQueueSelectionRequestSchema = z.strictObject({
  ids: z.array(pageIdSchema),
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
   * The instant the answer was given, as the browser's clock saw it. Sent so an
   * answer made without a connection is recorded on the day it was answered
   * rather than the day it reached the server; the server checks it against
   * its own clock and ignores it where the two disagree beyond a day.
   */
  answeredAt: z.iso.datetime({ offset: true }).optional(),
  /**
   * How sure the reviewer said they were before the answer was shown. Stored
   * beside the answer; it never changes what the answer does.
   */
  confidence: confidenceSchema.optional(),
  /**
   * Licenses an answer for a word the schedule does not call due yet. The
   * weakest-words review and the reviewer's own picked words both allow it;
   * every other review is due-only. Absent means due-only, so an answer sent by
   * a page loaded before this field existed is judged as it always was.
   */
  allowNotDue: z.boolean().optional(),
  /**
   * Whether this answer moves the word. False records the answer but leaves
   * the FSRS state and due day exactly as they were. The reviewer chooses this
   * beside the words being reviewed. Absent means it counts.
   */
  countsTowardSchedule: z.boolean().optional(),
  /** The name used by older clients; treated exactly like `countsTowardSchedule`. */
  countsTowardMastery: z.boolean().optional(),
  /** The revision the browser was shown, where the store keeps one. */
  expectedRevision: z.number().int().min(0).optional(),
});

/** What one saved answer did to the game: shown beside the card as it is saved. */
export const answerGameSchema = z.object({
  /** XP this answer earned, bonuses included. */
  xp: z.number().int(),
  totalXp: z.number().int(),
  level: z.number().int(),
  /** Answers in a row so far, and the bonus that gives, in percent. */
  combo: z.number().int(),
  comboBonus: z.number().int(),
  /** Base XP flashcard reviews can still earn today (DAILY_XP_CAP); absent from older servers. */
  reviewXpLeft: z.number().int().optional(),
});

export const reviewActionResponseSchema = z.object({
  outcome: z.enum(['applied', 'already_applied', 'dry_run']),
  /** The record's confirmed state. For `dry_run`, what would have been written (if known). */
  state: reviewStateSchema.nullable(),
  /** Present where the game is kept (schema version 17) and the answer was counted. */
  game: answerGameSchema.optional(),
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
  /** Present where the game is kept: the XP taken back with the answer, as a negative amount. */
  game: answerGameSchema.optional(),
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
  /** True when FSRS is the only schedule; Settings then hides the choice. */
  fsrsOnly: z.boolean().default(false),
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
  /** How many live words sit at each strength level, 1 to 10. */
  strengthDistribution: z.array(z.number().int()).length(10).optional(),
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
  /** The instant the answer was given; see `reviewActionRequestSchema`. */
  answeredAt: z.iso.datetime({ offset: true }).optional(),
});

export const practiceResponseSchema = z.object({
  /** `dry_run`: judged, but saving is switched off so nothing was recorded. */
  outcome: z.enum(['recorded', 'already_recorded', 'dry_run']),
  correct: z.boolean(),
  /** For a typed answer, how it matched. */
  typed: z.enum(['exact', 'variant', 'incorrect']).nullable(),
  /** The right answer, as the server has it. */
  expected: z.string(),
  /**
   * The word's practice mastery in this mode once this answer is counted, from
   * 0 to the ceiling. `null` when the answer was not recorded, so nothing changed.
   */
  modeMastery: z.number().int().min(0).max(PRACTICE_MASTERY_MAX).nullable().default(null),
  /** Present where the game is kept and the answer was recorded. */
  game: answerGameSchema.optional(),
});

/** A word's practice mastery in every mode. Read-only; it follows from the recorded practice answers. */
export const practiceMasteryResponseSchema = z.object({
  /** False where practice is not recorded (the database predates it). */
  available: z.boolean(),
  /** The ceiling a mode's mastery stops at. */
  max: z.number().int(),
  modes: z.array(
    z.object({
      mode: studyModeSchema,
      /** Correct practice answers recorded for the word in this mode. */
      correct: z.number().int().min(0),
      /** `correct`, stopped at `max`. */
      mastery: z.number().int().min(0).max(PRACTICE_MASTERY_MAX),
    }),
  ),
});

/** One practice answer with full detail for True Mastery calculation. */
export const practiceHistoryRowSchema = z.object({
  vocabularyId: pageIdSchema,
  mode: studyModeSchema,
  correct: z.boolean(),
  grading: z.enum(['self', 'auto']),
  submitted: z.string().max(500).nullable(),
  reviewedOn: isoDateSchema,
  reviewedAt: z.string(),
  durationMs: z.number().int().nullable(),
  confidence: z.number().int().min(1).max(3).nullable(),
  sessionId: z.uuid().nullable(),
});

/** Detailed practice history for True Mastery estimation. */
export const practiceHistoryResponseSchema = z.object({
  /** False where practice history is not available (database predates it). */
  available: z.boolean(),
  /** All practice answers, oldest first. */
  answers: z.array(practiceHistoryRowSchema),
});

export type PracticeHistoryRow = z.infer<typeof practiceHistoryRowSchema>;
export type PracticeHistoryResponse = z.infer<typeof practiceHistoryResponseSchema>;

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
  /** How far the word is from leaving the list again, and whether it already has. */
  recovery: weakRecoverySchema.optional(),
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
  'new',
  'overdue',
  'due_today',
  'unscheduled',
  'upcoming',
  'suspended',
  'mastered',
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
  /** Alias of `reviewDate` with the FSRS-first naming. */
  dueDate: isoDateSchema.nullable().optional(),
  /** The FSRS-derived strength, present wherever FSRS state is available. */
  memory: memoryStrengthSchema.optional(),
  /** True when the word has been archived from the review queue. */
  suspended: z.boolean().default(false),
  /** Increments on every saved answer; used to detect stale writes. */
  revision: z.number().int().min(0).default(0),
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
  /** True when FSRS is the only schedule; the interface then hides mastery entirely. */
  fsrsOnly: z.boolean().default(false),
  skipped: z.array(skippedRecordSchema),
  /** What a new word starts with, so the Add form can show it rather than hide it. */
  defaults: z.object({
    mastery: z.number(),
    reviewDate: z.enum(['empty', 'today']),
    /** FSRS-first defaults. A new word is due on the day it is added. */
    dueOn: z.literal('today').optional(),
    newWordsPerDay: z.number().int().min(1).max(1000).optional(),
  }),
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
  /** Defaults to the configured starting mastery. Ignored by an FSRS-only store. */
  mastery: masterySchema.optional(),
  /** `null` means no review date. Omitted means the configured default. */
  reviewDate: isoDateSchema.nullable().optional(),
  /** FSRS-first fallback due day for a word with no state yet. */
  dueOn: isoDateSchema.optional(),
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
  /**
   * Optional spreading for a large import: the first N words are due today,
   * the next N tomorrow, and so on. Omitted means every word is due today.
   */
  wordsPerDay: z.number().int().min(1).max(1000).optional(),
  /**
   * Where this batch starts in the original list. Sending a large import in
   * several requests keeps the same day boundaries when this is passed.
   */
  startIndex: z.number().int().min(0).optional(),
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

// ---- FSRS-only goals and archive ----

export const uiLanguageSchema = z.enum(['vi', 'en']);
export type UiLanguage = z.infer<typeof uiLanguageSchema>;

/** The two daily goals. They drive the streak only; a review session never stops for them. */
export const studyGoalsSchema = z.object({
  newWords: z.number().int().min(0).max(1000),
  reviews: z.number().int().min(0).max(1000),
  practice: z.number().int().min(0).max(1000).default(20),
  maintenanceMode: z.boolean().default(false),
});

export const updateStudyGoalsRequestSchema = z
  .strictObject({
    newWords: z.number().int().min(0).max(1000).optional(),
    reviews: z.number().int().min(0).max(1000).optional(),
    practice: z.number().int().min(0).max(1000).optional(),
    maintenanceMode: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');

const goalPartProgressSchema = z.object({
  target: z.number().int(),
  done: z.number().int(),
  remaining: z.number().int(),
  met: z.boolean(),
  /** True when no more words of this kind are available, so the goal stays open. */
  exhausted: z.boolean(),
});

/** Today's three goals, their progress, and the streak that needs all. */
export const studyGoalsResponseSchema = z.object({
  available: z.boolean(),
  /** False until the reviewer has chosen; `goals` is then the suggested pair, and no day is recorded. */
  chosen: z.boolean(),
  today: isoDateSchema,
  timeZone: z.string(),
  goals: studyGoalsSchema,
  newWords: goalPartProgressSchema,
  reviews: goalPartProgressSchema,
  practice: goalPartProgressSchema,
  due: z.object({ total: z.number().int(), overdue: z.number().int() }),
  streak: z.object({ current: z.number().int(), longest: z.number().int(), metToday: z.boolean() }),
});

/** Bulk archive or resume. Words are archived, never deleted. */
export const archiveEntriesRequestSchema = z.strictObject({
  ids: z.array(pageIdSchema).min(1).max(500),
  archived: z.boolean(),
});

export const archiveEntriesResponseSchema = z.object({
  archived: z.number().int(),
  entries: z.array(vocabularyEntrySchema),
});

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
  /** Whether a review moves a word by default, and the value the switch starts on. */
  countReviewsTowardMastery: z.boolean().default(true),
  /** The FSRS-first name for the same setting. */
  countReviewsTowardSchedule: z.boolean().optional(),
  /** True when FSRS is the only scheduler. */
  fsrsOnly: z.boolean().default(false),
  /** The two daily goals, where the account can keep them. */
  goals: studyGoalsSchema.nullable().default(null),
  /** The most reviews offered in one day; `null` means show everything due. */
  maxReviewsPerDay: z.number().int().min(1).max(1000).nullable().default(null),
  /** The interface language. Word meanings stay Vietnamese. */
  uiLanguage: uiLanguageSchema.nullable().default(null),
});

export const updateSettingsRequestSchema = z
  .strictObject({
    timeZone: timeZoneSchema.optional(),
    fsrsRetention: z.number().min(0.7).max(0.97).optional(),
    countReviewsTowardMastery: z.boolean().optional(),
    countReviewsTowardSchedule: z.boolean().optional(),
    maxReviewsPerDay: z.number().int().min(1).max(1000).nullable().optional(),
    /** `null` goes back to following the browser. */
    uiLanguage: uiLanguageSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.timeZone !== undefined ||
      value.fsrsRetention !== undefined ||
      value.countReviewsTowardMastery !== undefined ||
      value.countReviewsTowardSchedule !== undefined ||
      value.maxReviewsPerDay !== undefined ||
      value.uiLanguage !== undefined,
    'Nothing to change',
  );

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  current: reviewStateSchema.optional(),
  /** Existing entries with the same word, when a create or rename was refused as a duplicate. */
  duplicates: z.array(vocabularyEntrySchema).optional(),
  /** What is wrong with a nickname that was refused. */
  problem: z.string().optional(),
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
export type PracticeMasteryResponse = z.infer<typeof practiceMasteryResponseSchema>;
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
export type StudyGoals = z.infer<typeof studyGoalsSchema>;
export type UpdateStudyGoalsInput = z.input<typeof updateStudyGoalsRequestSchema>;
export type StudyGoalsResponse = z.infer<typeof studyGoalsResponseSchema>;
export type AnswerGame = z.infer<typeof answerGameSchema>;
export type GameResponse = z.infer<typeof gameResponseSchema>;
export type GameQuestView = z.infer<typeof gameQuestSchema>;
export type GameRewardView = z.infer<typeof gameRewardSchema>;

// ---- The game (docs/gamification-plan.md, phase 1) ----

export const gameQuestSchema = z.object({
  period: z.enum(['day', 'week']),
  kind: z.string(),
  target: z.number().int(),
  progress: z.number().int(),
  reward: z.number().int(),
  completed: z.boolean(),
});

export const gameRewardSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'level',
    'badge',
    'quest',
    'quests_all',
    'checkin',
    'freeze_granted',
    'freeze_used',
    'comeback',
    'league',
    'challenge',
    'chest',
    'boss',
    'set',
    'pvp',
    'pvp_season',
  ]),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const gameResponseSchema = z.object({
  /** False where the game cannot be kept: the database predates version 17, or the server is not set up for it. */
  available: z.boolean(),
  /** Why it is not available, in a sentence for the owner. */
  reason: z.string().nullable(),
  today: isoDateSchema,
  totalXp: z.number().int(),
  level: z.object({ level: z.number().int(), into: z.number().int(), needed: z.number().int() }),
  combo: z.object({ count: z.number().int(), bonus: z.number().int(), longest: z.number().int() }),
  /** Until when coming back doubles XP, if it does now. */
  comebackUntil: z.string().nullable(),
  quests: z.object({ day: z.array(gameQuestSchema), week: gameQuestSchema.nullable() }),
  badges: z.array(z.object({ badge: z.string(), tier: z.number().int(), earnedAt: z.string() })),
  /** Where each badge's count stands now, for the way to its next tier. */
  badgeValues: z.record(z.string(), z.number()),
  freezes: z.object({ held: z.number().int(), max: z.number().int() }),
  checkin: z.object({ day: z.number().int(), lastOn: isoDateSchema.nullable() }),
  /** How many days ahead "review early" reaches. */
  earlyDays: z.number().int().min(1).max(14),
  /** Base XP earned today from reviews and from practice, against each one's daily limit. */
  dailyXp: z
    .object({
      review: z.object({ earned: z.number().int(), cap: z.number().int() }),
      practice: z.object({ earned: z.number().int(), cap: z.number().int() }),
    })
    .optional(),
  /** Rewards waiting to be claimed, oldest first. */
  rewards: z.array(gameRewardSchema),
  /** Phase 3 (schema version 19); absent or null where the economy is not kept. */
  economy: z
    .object({
      stardust: z.number().int(),
      /** Companions leading now. */
      pets: z.array(z.object({ id: z.string(), form: z.number().int(), days: z.number().int(), mood: z.enum(['happy', 'sad']) })),
      slots: z.number().int(),
      /** The XP the leading companions add, in percent, after the cap. */
      petBonus: z.number().int(),
      theme: z.string().nullable(),
      boostUntil: z.string().nullable(),
      /** Today's golden hour, as the hour it starts in the account's own time; null when switched off. */
      goldenHour: z.number().int().nullable(),
      goldenNow: z.boolean(),
      sunday: z.boolean(),
      month: z.object({ count: z.number().int(), target: z.number().int(), done: z.boolean() }).nullable(),
    })
    .nullable()
    .optional(),
  /** Chests opened by the claim this answers. */
  opened: z
    .array(
      z.object({
        reward: z.string(),
        contents: z.object({
          rarity: z.enum(['common', 'rare', 'legendary']),
          stardust: z.number().int(),
          xp: z.number().int(),
          items: z.array(z.string()),
          duplicates: z.array(z.string()),
        }),
      }),
    )
    .optional(),
});

export const gameClaimRequestSchema = z.strictObject({
  /** The rewards to claim; `all` claims every one waiting. */
  ids: z.union([z.array(z.uuid()).min(1).max(200), z.literal('all')]),
});

export const gameSettingsRequestSchema = z.strictObject({
  earlyDays: z.number().int().min(1).max(14),
});

// ---- The economy (docs/gamification-plan.md, phase 3) ----

export const SHOP_SERVICES = ['freeze', 'boost', 'repair', 'slot'] as const;

export const shopResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  today: isoDateSchema,
  stardust: z.number().int(),
  items: z.array(z.object({ item: z.string(), price: z.number().int(), owned: z.boolean() })),
  services: z.array(
    z.object({
      kind: z.enum(SHOP_SERVICES),
      price: z.number().int(),
      /** Why it cannot be bought now, if it cannot. */
      blocked: z.enum(['held', 'owned', 'nothing', 'full']).nullable(),
    }),
  ),
});

export const buyRequestSchema = z.union([
  z.strictObject({ kind: z.literal('item'), item: z.string().min(1).max(60) }),
  z.strictObject({ kind: z.enum(SHOP_SERVICES) }),
]);

export const collectionResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  stardust: z.number().int(),
  owned: z.array(z.string()),
  slots: z.number().int(),
  leading: z.array(z.string()),
  /** Days studied with each companion leading. */
  petDays: z.record(z.string(), z.number().int()),
  sets: z.array(z.object({ id: z.string(), have: z.number().int(), total: z.number().int(), done: z.boolean() })),
  theme: z.string().nullable(),
});

export const equipRequestSchema = z.strictObject({
  pets: z.array(z.string().max(60)).max(5).optional(),
  theme: z.string().max(60).nullable().optional(),
});

export const starterRequestSchema = z.strictObject({ pet: z.string().max(60) });

export const bossResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  week: isoDateSchema,
  words: z.array(z.object({ id: z.string(), word: z.string() })),
  hp: z.number(),
  max: z.number().int(),
  correct: z.number().int(),
  wrong: z.number().int(),
  won: z.boolean(),
});

export const gameEventsSchema = z.object({ goldenHour: z.boolean(), sunday: z.boolean(), monthly: z.boolean(), boss: z.boolean() });

// ---- Reminders (docs/gamification-plan.md, phase 4) ----

const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const notificationSettingsSchema = z.object({
  streak: z.boolean(),
  league: z.boolean(),
  reminder: z.boolean(),
  social: z.boolean(),
  /** The daily reminder's time, and the quiet hours, in the account's own time (HH:MM). */
  reminderAt: clockSchema,
  quietFrom: clockSchema,
  quietUntil: clockSchema,
});

export const notificationsResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  /** The server's VAPID public key, for the browser to subscribe with. */
  publicKey: z.string().nullable(),
  settings: notificationSettingsSchema,
  /** The push endpoints of the account's devices. */
  devices: z.array(z.string()),
});

export const pushSubscribeRequestSchema = z.strictObject({
  endpoint: z.url().startsWith('https://').max(1000),
  keys: z.strictObject({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export const pushUnsubscribeRequestSchema = z.strictObject({ endpoint: z.string().max(1000) });

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

// ---- PvP (docs/gamification-plan.md, phase 5) ----

export const pvpLobbySchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  season: z.string(),
  rating: z.number().int(),
  tier: z.number().int().min(1).max(8),
  record: z.object({ wins: z.number().int(), losses: z.number().int(), draws: z.number().int() }),
  /** The warning that the other player will see some of one's words has been shown. */
  consented: z.boolean(),
  /** Matchmaking is locked until then, after leaving matches. */
  lockedUntil: z.string().nullable(),
  waiting: z.object({ mode: z.enum(['ranked', 'friend']), since: z.string(), friend: z.string().nullable() }).nullable(),
  /** A match in progress, to go back to. */
  matchId: z.string().nullable(),
  invites: z.array(z.object({ nickname: z.string(), at: z.string() })),
  headToHead: z.array(z.object({ nickname: z.string(), wins: z.number().int(), losses: z.number().int(), draws: z.number().int() })),
  recent: z.array(
    z.object({ id: z.string(), mode: z.enum(['ranked', 'friend', 'rival']), opponent: z.string().nullable(), result: z.enum(['won', 'lost', 'draw']), at: z.string() }),
  ),
});

export const pvpTickSchema = z.object({ state: z.enum(['idle', 'waiting', 'match']), matchId: z.string().nullable() });

const pvpPlayerSchema = z.object({
  nickname: z.string().nullable(),
  rating: z.number().int(),
  hp: z.number().int(),
  correct: z.number().int(),
});

export const pvpMatchSchema = z.object({
  id: z.string(),
  mode: z.enum(['ranked', 'friend', 'rival']),
  /** The server's clock, so the page can count down from its own. */
  now: z.number(),
  endsAt: z.number(),
  me: pvpPlayerSchema.extend({ wrong: z.number().int(), lockedUntil: z.number(), skill: z.string().nullable() }),
  them: pvpPlayerSchema,
  /** The question to answer now, without its answer; null once there are none or the match is over. */
  question: z.object({ index: z.number().int(), direction: z.enum(['en-vi', 'vi-en']), prompt: z.string(), options: z.array(z.string()) }).nullable(),
  /** How the last answer went, for the page to show. */
  last: z.object({ index: z.number().int(), correct: z.boolean(), crit: z.boolean(), damage: z.number().int(), right: z.number().int() }).nullable(),
  finished: z.boolean(),
  result: z.enum(['won', 'lost', 'draw']).nullable(),
  reason: z.enum(['hp', 'time', 'left']).nullable(),
  reward: z.object({ xp: z.number().int(), stardust: z.number().int(), ratingFrom: z.number().int(), ratingTo: z.number().int() }).nullable(),
  /** After the match: the other side's words, to add to one's own. */
  words: z.array(z.object({ word: z.string(), meaning: z.string() })),
});

export const pvpAnswerRequestSchema = z.strictObject({ index: z.number().int().min(0).max(200), choice: z.number().int().min(0).max(3) });
export const pvpJoinRequestSchema = z.strictObject({ mode: z.literal('ranked') });

export type PvpLobby = z.infer<typeof pvpLobbySchema>;
export type PvpMatch = z.infer<typeof pvpMatchSchema>;
export type PvpTick = z.infer<typeof pvpTickSchema>;

export type ShopResponse = z.infer<typeof shopResponseSchema>;
export type BuyRequest = z.infer<typeof buyRequestSchema>;
export type CollectionResponse = z.infer<typeof collectionResponseSchema>;
export type BossResponse = z.infer<typeof bossResponseSchema>;
export type GameEvents = z.infer<typeof gameEventsSchema>;

// ---- Competition (docs/gamification-plan.md, phase 2) ----
// Other accounts appear only by nickname: never an email, an id, a word or a schedule.

export const NICKNAME_PROBLEMS = ['length', 'characters', 'blocked', 'taken'] as const;

const tierSchema = z.number().int().min(1).max(8);

export const leagueRowSchema = z.object({
  /** Null for a profile an admin hid. */
  nickname: z.string().nullable(),
  level: z.number().int(),
  xp: z.number().int(),
  rank: z.number().int(),
  me: z.boolean(),
  zone: z.enum(['up', 'down', 'stay']),
});

export const leagueResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  /** The Monday the league week started, in Vietnam's time, and when it ends. */
  week: isoDateSchema,
  endsAt: z.string(),
  nickname: z.string().nullable(),
  tier: tierSchema,
  inLeagues: z.boolean(),
  weekXp: z.number().int(),
  /** Null until the first XP of the week puts the account in a group. */
  group: z.object({ tier: tierSchema, rows: z.array(leagueRowSchema) }).nullable(),
});

export const profileResponseSchema = z.object({
  nickname: z.string(),
  frame: z.string().nullable(),
  title: z.string().nullable(),
  level: z.number().int(),
  totalXp: z.number().int(),
  tier: tierSchema,
  streak: z.number().int(),
  mastered: z.number().int(),
  badges: z.array(z.object({ badge: z.string(), tier: z.number().int() })),
  me: z.boolean(),
  /** A profile its owner keeps to themselves: no following, no challenges. */
  limited: z.boolean(),
  following: z.boolean(),
  followedBy: z.boolean(),
  blocked: z.boolean(),
  /** Phase 3: what the profile shows off. */
  showcase: z.object({ leading: z.array(z.string()), items: z.array(z.string()) }).optional(),
  /** Only on one's own profile. */
  inLeagues: z.boolean().optional(),
  admin: z.boolean().optional(),
});

export const profileUpdateRequestSchema = z.strictObject({
  nickname: z.string().max(60).optional(),
  inLeagues: z.boolean().optional(),
  /** Phase 3: a frame and a title the account owns, or null to wear none. */
  frame: z.string().max(60).nullable().optional(),
  title: z.string().max(60).nullable().optional(),
});

export const profileSearchResponseSchema = z.object({
  players: z.array(z.object({ nickname: z.string(), level: z.number().int(), tier: tierSchema })),
});

export const friendSchema = z.object({
  nickname: z.string(),
  level: z.number().int(),
  tier: tierSchema,
  weekXp: z.number().int(),
  /** Following each other; only friends see each other's streak. */
  mutual: z.boolean(),
  streak: z.number().int().nullable(),
  /** Days in a row both met their goals. */
  sharedStreak: z.number().int().nullable(),
});

export const challengeSchema = z.object({
  id: z.string(),
  week: isoDateSchema,
  /** This week's, still running. */
  current: z.boolean(),
  nickname: z.string().nullable(),
  /** Sent by me; otherwise sent to me. */
  mine: z.boolean(),
  accepted: z.boolean(),
  settled: z.boolean(),
  result: z.enum(['won', 'lost', 'draw']).nullable(),
  myXp: z.number().int(),
  otherXp: z.number().int(),
});

export const friendsResponseSchema = z.object({
  week: isoDateSchema,
  endsAt: z.string(),
  nickname: z.string().nullable(),
  weekXp: z.number().int(),
  friends: z.array(friendSchema),
  challenges: z.array(challengeSchema),
});

export const nicknameRequestSchema = z.strictObject({ nickname: z.string().min(1).max(60) });
export const inviteAcceptRequestSchema = z.strictObject({ token: z.string().min(16).max(64) });
export const inviteResponseSchema = z.object({ token: z.string(), expiresAt: z.string() });
export const reportRequestSchema = z.strictObject({ nickname: z.string().min(1).max(60), reason: z.string().trim().min(1).max(300) });

export const adminReportSchema = z.object({
  id: z.string(),
  target: z.string(),
  nickname: z.string(),
  hidden: z.boolean(),
  reason: z.string(),
  createdAt: z.string(),
  reports: z.number().int(),
});
export const adminResponseSchema = z.object({ reports: z.array(adminReportSchema) });
export const adminActionRequestSchema = z.strictObject({
  target: z.uuid(),
  action: z.enum(['rename', 'hide', 'unhide', 'resolve']),
});

export type LeagueResponse = z.infer<typeof leagueResponseSchema>;
export type LeagueRow = z.infer<typeof leagueRowSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type FriendsResponse = z.infer<typeof friendsResponseSchema>;
export type Friend = z.infer<typeof friendSchema>;
export type Challenge = z.infer<typeof challengeSchema>;
export type AdminResponse = z.infer<typeof adminResponseSchema>;
export type AdminReport = z.infer<typeof adminReportSchema>;
export type ArchiveEntriesRequest = z.infer<typeof archiveEntriesRequestSchema>;
export type ArchiveEntriesResponse = z.infer<typeof archiveEntriesResponseSchema>;

// ---- AI Chat ----

export const AI_MODES = ['general', 'vocabulary_expert'] as const;
export type AiMode = typeof AI_MODES[number];

export const aiConversationSchema = z.object({
  id: z.string().uuid(),
  mode: z.enum(AI_MODES),
  title: z.string().max(200),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AiConversation = z.infer<typeof aiConversationSchema>;

export const aiConversationListResponseSchema = z.object({
  conversations: z.array(aiConversationSchema),
});
export type AiConversationListResponse = z.infer<typeof aiConversationListResponseSchema>;

export const aiMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  metadata: z.unknown(),
  createdAt: z.string(),
});
export type AiMessage = z.infer<typeof aiMessageSchema>;

export const aiMessageListResponseSchema = z.object({
  messages: z.array(aiMessageSchema),
});
export type AiMessageListResponse = z.infer<typeof aiMessageListResponseSchema>;

/** The word one Vocabulary Expert reply was added to, from the "Add Word" action. */
export const aiMessageSavedRequestSchema = z.strictObject({
  vocabularyId: z.uuid(),
});

export const aiMessageSavedResponseSchema = z.object({
  /** False when the database is older than version 12 and has nowhere to keep the link. */
  saved: z.boolean(),
});
export type AiMessageSavedResponse = z.infer<typeof aiMessageSavedResponseSchema>;

export const aiConversationCreateSchema = z.strictObject({
  mode: z.enum(AI_MODES),
  title: z.string().max(200).optional(),
});
export type AiConversationCreateRequest = z.infer<typeof aiConversationCreateSchema>;

export const aiConversationUpdateSchema = z.strictObject({
  title: z.string().max(200),
});
export type AiConversationUpdateRequest = z.infer<typeof aiConversationUpdateSchema>;

export const aiMessageSendSchema = z.strictObject({
  content: z.string().min(1).max(32000),
});
export type AiMessageSendRequest = z.infer<typeof aiMessageSendSchema>;

export type AiStreamChunk = 
  | { type: 'delta'; delta: string }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null; finishReason?: string | null }
  | { type: 'error'; code: string; message: string };
