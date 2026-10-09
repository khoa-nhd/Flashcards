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

export const loginRequestSchema = z.strictObject({
  password: z.string().min(1).max(512),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  current: reviewStateSchema.optional(),
});

export type CardField = z.infer<typeof cardFieldSchema>;
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export type SkippedRecord = z.infer<typeof skippedRecordSchema>;
export type QueueResponse = z.infer<typeof queueResponseSchema>;
export type ReviewActionRequest = z.infer<typeof reviewActionRequestSchema>;
export type ReviewActionResponse = z.infer<typeof reviewActionResponseSchema>;
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
