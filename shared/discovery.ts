/**
 * Discovery & Input: what a source may hold, the line between a marked
 * selection and saved vocabulary, and the requests both sides agree on.
 *
 * Three rules are visible in these shapes themselves:
 *   - nothing here is a vocabulary entry. A source holds text (or a
 *     transcript), a mark holds one selection and its context — a word is
 *     created only by the ordinary word path, reached from a mark or a
 *     selection on the learner's explicit Save;
 *   - a mark's context stays small: the sentence or cue around the
 *     selection, never the source it came from;
 *   - positions are restorable state (where the reader was, where the
 *     listener stopped), last write wins, and never carry learning data.
 */
import { z } from 'zod';
import { createEntryRequestSchema, vocabularyEntrySchema } from './api.js';

/** Caps the database also checks. Content is bounded so one source is a reading, not a whole book. */
export const DISCOVERY_LIMITS = {
  title: 200,
  origin: 400,
  content: 120_000,
  label: 200,
  context: 2_000,
  note: 600,
  suggestionWord: 200,
  suggestions: 30,
  sources: 200,
} as const;

/** Where a source came from. `capture` is the standing home of quick-capture marks. */
export const DISCOVERY_SOURCE_KINDS = ['text', 'reading', 'listening', 'generated', 'imported', 'web', 'capture'] as const;
export type DiscoverySourceKind = (typeof DISCOVERY_SOURCE_KINDS)[number];
export const isDiscoverySourceKind = (value: string): value is DiscoverySourceKind =>
  (DISCOVERY_SOURCE_KINDS as readonly string[]).includes(value);

/** How the content reads: ordinary prose, or a transcript whose lines may carry timestamps. */
export const DISCOVERY_CONTENT_KINDS = ['plain', 'transcript'] as const;
export type DiscoveryContentKind = (typeof DISCOVERY_CONTENT_KINDS)[number];

export interface DiscoveryPosition {
  /** Reading: how far into the content the reader was, in characters. */
  offset?: number;
  /** Listening: where the listener stopped, in seconds. */
  seconds?: number;
}

export const discoveryPositionSchema = z
  .strictObject({
    offset: z.number().int().min(0).max(DISCOVERY_LIMITS.content).optional(),
    seconds: z.number().min(0).max(24 * 60 * 60).optional(),
  })
  .refine((value) => value.offset !== undefined || value.seconds !== undefined, {
    message: 'A position needs a character offset or a number of seconds.',
  });

/** NFC and trim; for titles and labels whitespace collapses, for content it is kept. */
export function tidyDiscoveryTitle(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** The same normalisation the word field uses, so a phrase mark dedupes like a word. */
export function tidyDiscoveryLabel(value: string): string {
  return tidyDiscoveryTitle(value);
}

export function tidyDiscoveryContent(value: string): string {
  return value.normalize('NFC').trim();
}

/**
 * The stretch of text around one offset a mark or an explanation keeps:
 * the sentence it sits in, capped — never the whole source.
 */
export function sentenceAround(text: string, offset: number, max = DISCOVERY_LIMITS.context): string {
  if (text.length === 0) return '';
  const at = Math.max(0, Math.min(offset, text.length - 1));
  const isEnd = (index: number): boolean => /[.!?\n]/.test(text[index] ?? '');
  let start = at;
  while (start > 0 && !isEnd(start - 1)) start -= 1;
  if (start > 0 && isEnd(start - 1)) start += 1;
  let end = at;
  while (end < text.length && !isEnd(end)) end += 1;
  if (end < text.length) end += 1;
  const slice = text.slice(Math.max(0, start), Math.min(text.length, end)).trim();
  if (slice.length <= max) return slice;
  // A sentence longer than the cap: keep the window around the selection itself.
  const from = Math.max(0, at - start - Math.floor(max / 2));
  return text.slice(start + from, start + from + max).trim();
}

/**
 * The window of a source sent for an explanation: enough around the
 * selection for the picked sentence, never the whole source — the server
 * picks the sentence from this before anything reaches a model.
 */
export function contextWindow(text: string, offset: number, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const from = Math.max(0, Math.min(offset - half, text.length - max));
  return text.slice(from, from + max);
}

// ---------------------------------------------------------------------------
// Marks: a selection kept for later, or kept as the context of a saved word
// ---------------------------------------------------------------------------

export const discoveryMarkSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  /** The selection as it appeared — its text, not a vocabulary id. */
  label: z.string(),
  /** The sentence or cue around it, capped: the source itself is never copied here. */
  context: z.string(),
  /** Reading/text: where the selection starts in the source. */
  offset: z.number().int().nullable(),
  /** Listening: the cue's window, in milliseconds. Both set or both absent. */
  cueStart: z.number().int().nullable(),
  cueEnd: z.number().int().nullable(),
  /** The reader's own note on the selection. */
  note: z.string(),
  /** Set only by an explicit save: the word this mark became. Null means still marked for later. */
  vocabularyId: z.string().nullable(),
  savedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type DiscoveryMark = z.infer<typeof discoveryMarkSchema>;

/** A mark as the "marked for later" list shows it, with where it came from. */
export const discoveryMarkViewSchema = discoveryMarkSchema.extend({
  sourceTitle: z.string(),
  sourceKind: z.enum(DISCOVERY_SOURCE_KINDS),
});

export type DiscoveryMarkView = z.infer<typeof discoveryMarkViewSchema>;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const discoverySourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(DISCOVERY_SOURCE_KINDS),
  title: z.string(),
  /** Where it came from: a URL, a file name, `typed`, `ai` — provenance, never content. */
  origin: z.string(),
  contentKind: z.enum(DISCOVERY_CONTENT_KINDS),
  position: z.object({ offset: z.number().optional(), seconds: z.number().optional() }),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** How many selections are still waiting, and how many became words. */
  markedCount: z.number().int(),
  savedCount: z.number().int(),
});

export type DiscoverySource = z.infer<typeof discoverySourceSchema>;

export const discoverySourceDocumentSchema = discoverySourceSchema.extend({
  content: z.string(),
  marks: z.array(discoveryMarkSchema),
});

export type DiscoverySourceDocument = z.infer<typeof discoverySourceDocumentSchema>;

/** What an AI may suggest for generated content: words that appear in the text, never new ones. */
export const discoverySuggestionSchema = z.strictObject({
  word: z.string().min(1).max(DISCOVERY_LIMITS.suggestionWord),
  /** The sentence of the generated text the word appears in, where the model gave one. */
  sentence: z.string().max(DISCOVERY_LIMITS.context).optional(),
  /** Why it is worth a look. */
  note: z.string().max(DISCOVERY_LIMITS.note).optional(),
});

export type DiscoverySuggestion = z.infer<typeof discoverySuggestionSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const createDiscoverySourceRequestSchema = z.strictObject({
  kind: z.enum(DISCOVERY_SOURCE_KINDS),
  title: z.string().max(DISCOVERY_LIMITS.title, `Keep the title under ${DISCOVERY_LIMITS.title} characters`),
  origin: z.string().max(DISCOVERY_LIMITS.origin).optional(),
  content: z.string().max(DISCOVERY_LIMITS.content, `Keep the text under ${DISCOVERY_LIMITS.content.toLocaleString('en-US')} characters — import an excerpt rather than a whole book`),
  contentKind: z.enum(DISCOVERY_CONTENT_KINDS).optional(),
  position: discoveryPositionSchema.optional(),
  /**
   * Accepted on creation and stored as marks, still unsaved: generated
   * content arrives with its suggested words, each of which must appear in
   * the text. They stay "marked for later" until the learner saves one.
   */
  suggestions: z.array(discoverySuggestionSchema).max(DISCOVERY_LIMITS.suggestions).optional(),
  requestId: z.uuid().optional(),
});

export type CreateDiscoverySourceRequest = z.infer<typeof createDiscoverySourceRequestSchema>;

export const updateDiscoverySourceRequestSchema = z
  .strictObject({
    title: z.string().max(DISCOVERY_LIMITS.title).optional(),
    position: discoveryPositionSchema.optional(),
    /** The revision the edit was taken from; a stale hand is refused. Omitted for a position save. */
    ifMatch: z.number().int().optional(),
  })
  .refine((value) => value.title !== undefined || value.position !== undefined, {
    message: 'Give a new title or a position.',
  });

export type UpdateDiscoverySourceRequest = z.infer<typeof updateDiscoverySourceRequestSchema>;

export const markSelectionRequestSchema = z
  .strictObject({
    sourceId: z.uuid(),
    label: z.string().min(1, 'Select something first').max(DISCOVERY_LIMITS.label),
    context: z.string().max(DISCOVERY_LIMITS.context).optional(),
    offset: z.number().int().min(0).optional(),
    cueStart: z.number().int().min(0).optional(),
    cueEnd: z.number().int().min(0).optional(),
    note: z.string().max(DISCOVERY_LIMITS.note).optional(),
    requestId: z.uuid(),
  })
  .refine((value) => (value.cueStart === undefined) === (value.cueEnd === undefined), {
    message: 'A cue needs both its start and its end.',
  });

export type MarkSelectionRequest = z.infer<typeof markSelectionRequestSchema>;

/**
 * Save Now: the ordinary word creation, with where it was found. The word
 * goes through the very same request as the Add form — its duplicate check
 * and its one-submission-per-request-id rule included.
 */
export const saveSelectionRequestSchema = createEntryRequestSchema.extend({
  sourceId: z.uuid(),
  context: z.string().max(DISCOVERY_LIMITS.context).optional(),
  offset: z.number().int().min(0).optional(),
  cueStart: z.number().int().min(0).optional(),
  cueEnd: z.number().int().min(0).optional(),
  note: z.string().max(DISCOVERY_LIMITS.note).optional(),
});

export type SaveSelectionRequest = z.infer<typeof saveSelectionRequestSchema>;

/**
 * Processing a marked item later: the same word creation, without a word
 * field — the mark already holds the selection being saved, and the word it
 * becomes is the mark's own label. Nothing else may decide otherwise.
 */
export const saveMarkRequestSchema = createEntryRequestSchema.omit({ word: true });

export type SaveMarkRequest = z.infer<typeof saveMarkRequestSchema>;

export const fetchUrlRequestSchema = z.strictObject({
  url: z.string().min(4).max(2000),
});

export const fetchUrlResponseSchema = z.strictObject({
  title: z.string(),
  text: z.string(),
  origin: z.string(),
});

export type FetchUrlResponse = z.infer<typeof fetchUrlResponseSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const discoveryListResponseSchema = z.object({ sources: z.array(discoverySourceSchema) });
/** What a create or an edit answers with: the summary, no content to carry twice. */
export const discoverySourceSummaryResponseSchema = z.object({ source: discoverySourceSchema });
export const discoverySourceResponseSchema = z.object({ source: discoverySourceDocumentSchema });
export const discoveryMarksResponseSchema = z.object({ marks: z.array(discoveryMarkViewSchema) });
export const discoveryMarkResponseSchema = z.object({ mark: discoveryMarkSchema });
export const discoverySaveResponseSchema = z.object({ entry: vocabularyEntrySchema, mark: discoveryMarkSchema });
export const discoveryContextResponseSchema = z.object({
  source: discoverySourceSchema,
  mark: discoveryMarkSchema,
});
