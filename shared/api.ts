/** The HTTP contract between the browser and the server, validated on both ends. */
import { z } from 'zod';
import { isIsoDate } from './dates.js';

export const isoDateSchema = z.string().refine(isIsoDate, 'Expected a YYYY-MM-DD calendar date');

export const reviewActionSchema = z.enum(['remember', 'not_remember']);

export const reviewStateSchema = z.object({
  mastery: z.number(),
  nextReview: isoDateSchema.nullable(),
});

const NOTION_ID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export const pageIdSchema = z.string().regex(NOTION_ID_PATTERN, 'Expected a Notion page id');

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

export const queueResponseSchema = z.object({
  cards: z.array(reviewCardSchema),
  today: isoDateSchema,
  timeZone: z.string(),
  mode: z.enum(['mock', 'notion']),
  /** False while the app is a read-only preview: grading saves nothing. */
  writesEnabled: z.boolean(),
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
});

export const reviewActionResponseSchema = z.object({
  outcome: z.enum(['applied', 'already_applied', 'dry_run']),
  /** The record's confirmed state. For `dry_run`, what would have been written (if known). */
  state: reviewStateSchema.nullable(),
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

/** Limits for what the app will write. Generous for a vocabulary note, far below Notion's own. */
export const FIELD_LIMITS = { word: 200, text: 6000 } as const;

/** A full vocabulary record as the bank, dashboard and calendar see it. */
export const vocabularyEntrySchema = z.object({
  id: z.string().min(1),
  word: z.string(),
  meaning: z.string().nullable(),
  definition: z.string().nullable(),
  example: z.string().nullable(),
  mastery: z.number().nullable(),
  reviewDate: isoDateSchema.nullable(),
  dateAdded: isoDateSchema.nullable(),
  reviewStatus: reviewStatusSchema,
  /** Whether the word is in the review queue right now, by the same rule the Review tab uses. */
  reviewable: z.boolean(),
  /** Text fields that carry formatting in Notion, which a plain-text edit would flatten. */
  formattedFields: z.array(z.string()),
  /** Link to the page in Notion. */
  url: z.string().nullable(),
  /** Notion's own timestamps, kept apart from the user-entered Date Added. */
  createdTime: z.string().nullable(),
  lastEditedTime: z.string().nullable(),
});

export const vocabularyListResponseSchema = z.object({
  entries: z.array(vocabularyEntrySchema),
  today: isoDateSchema,
  timeZone: z.string(),
  mode: z.enum(['mock', 'notion']),
  /** False when the app may not change Notion; adding, editing and deleting are then unavailable. */
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

export const loginRequestSchema = z.strictObject({
  password: z.string().min(1).max(512),
});

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
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type VocabularyEntry = z.infer<typeof vocabularyEntrySchema>;
export type VocabularyListResponse = z.infer<typeof vocabularyListResponseSchema>;
export type CreateEntryRequest = z.infer<typeof createEntryRequestSchema>;
/** The form of a create request before validation trims and tidies it. */
export type CreateEntryInput = z.input<typeof createEntryRequestSchema>;
export type UpdateEntryRequest = z.infer<typeof updateEntryRequestSchema>;
export type UpdateEntryInput = z.input<typeof updateEntryRequestSchema>;
