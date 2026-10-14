/**
 * What the AI features send and accept, in one place both sides agree on.
 * Split from api.ts only to keep each contract small; it is the same idea:
 * strict limits in, plain data out, and a language model's reply is never
 * trusted until it matches one of these schemas.
 */
import { z } from 'zod';

/** A pasted reading is capped well below the server's body limit; the word is one phrase. */
export const AI_LIMITS = { passage: 40_000, word: 200, field: 600 } as const;

export const aiExtractRequestSchema = z.strictObject({
  /** The passage the reader is working through. Only the picked sentence ever leaves the server. */
  text: z.string().min(1).max(AI_LIMITS.passage),
  /** The word or phrase the reader highlighted. */
  word: z.string().min(1).max(AI_LIMITS.word),
});

export type AiExtractRequest = z.infer<typeof aiExtractRequestSchema>;

/**
 * What the model may answer for a picked word. `null` is a first-class answer:
 * "not confident" is a better reply than an invented sense, and the form
 * simply stays empty for the reader to fill.
 */
export const aiSenseSchema = z.object({
  definition: z.string().max(AI_LIMITS.field).nullable(),
  meaning: z.string().max(AI_LIMITS.field).nullable(),
});

export const aiExtractResponseSchema = z.object({
  /** Taken from the reader's own text by the server, never written by the model. */
  sentence: z.string(),
  definition: z.string().max(AI_LIMITS.field).nullable(),
  meaning: z.string().max(AI_LIMITS.field).nullable(),
});

export type AiExtractResponse = z.infer<typeof aiExtractResponseSchema>;

// ---------------------------------------------------------------------------
// Word families: which words were formed from one root
// ---------------------------------------------------------------------------

export const aiWordFamilyRequestSchema = z.strictObject({
  /** The word the family is built around, as it sits on the card. */
  word: z.string().min(1).max(AI_LIMITS.word),
  meaning: z.string().max(AI_LIMITS.field).nullable().optional(),
  definition: z.string().max(AI_LIMITS.field).nullable().optional(),
});

export type AiWordFamilyRequest = z.infer<typeof aiWordFamilyRequestSchema>;

export const aiFamilyMemberSchema = z.object({
  word: z.string().min(1).max(AI_LIMITS.word),
  /** A short Vietnamese meaning of this member in this family; null when unsure. */
  gloss: z.string().max(AI_LIMITS.field).nullable(),
  /** True for the base form the others were formed from. Exactly one row has it. */
  root: z.boolean(),
});

export const aiWordFamilyResponseSchema = z.object({
  /** Always includes the requested word itself; exactly one member has root: true. */
  family: z.array(aiFamilyMemberSchema),
});

export type AiWordFamilyResponse = z.infer<typeof aiWordFamilyResponseSchema>;

// ---------------------------------------------------------------------------
// Example sentences for a word being added
// ---------------------------------------------------------------------------

export const aiExamplesRequestSchema = z.strictObject({
  word: z.string().min(1).max(AI_LIMITS.word),
  meaning: z.string().max(AI_LIMITS.field).nullable().optional(),
  definition: z.string().max(AI_LIMITS.field).nullable().optional(),
  example: z.string().max(AI_LIMITS.field).nullable().optional(),
  /** The collocations already saved for this word, so the sentences show them in use. */
  collocations: z.array(z.string().max(AI_LIMITS.word)).max(10),
});

export type AiExamplesRequest = z.infer<typeof aiExamplesRequestSchema>;

export const aiSuggestedExampleSchema = z.object({
  sentence: z.string(),
  /** The collocation this sentence demonstrates, spelled exactly as given; null when it demonstrates none. */
  uses: z.string().nullable(),
});

export const aiExamplesResponseSchema = z.object({
  examples: z.array(aiSuggestedExampleSchema),
});

export type AiExamplesResponse = z.infer<typeof aiExamplesResponseSchema>;
