/**
 * What the AI features send and accept, in one place both sides agree on.
 * Split from api.ts only to keep each contract small; it is the same idea:
 * strict limits in, plain data out, and a language model's reply is never
 * trusted until it matches one of these schemas.
 */
import { z } from 'zod';
import { EXAM_MODES } from './study-modes.js';

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

// ---------------------------------------------------------------------------
// A suggested structure for an exam
// ---------------------------------------------------------------------------

export const aiExamPlanRequestSchema = z.strictObject({
  /** The words to plan around, as ids; the builder sends the words it will draw from. */
  words: z.array(z.uuid()).min(1).max(30),
});

export type AiExamPlanRequest = z.infer<typeof aiExamPlanRequestSchema>;

export const aiExamPlanSectionSchema = z.object({
  mode: z.enum(EXAM_MODES),
  /** How many questions, within the builder's own limits. */
  count: z.number().int().min(1).max(50),
  /** Minutes for the section's own clock; null means counted by questions only. */
  minutes: z.number().int().min(1).max(120).nullable(),
});

export const aiExamPlanResponseSchema = z.object({
  /** At most the number of sections the builder itself allows. */
  sections: z.array(aiExamPlanSectionSchema).min(1).max(6),
  /** One line on why this shape, shown above the draft so the choice is explained. */
  reason: z.string().max(300),
});

export type AiExamPlanResponse = z.infer<typeof aiExamPlanResponseSchema>;

// ---------------------------------------------------------------------------
// A draft map for Vocabulary Maps
// ---------------------------------------------------------------------------

/**
 * What the model may propose when a map is generated or expanded. It names
 * nodes by their label, never by id: the server owns every reference, so a
 * model cannot point a map at a word the learner never offered.
 */
export const aiMapDraftNodeSchema = z.object({
  label: z.string().min(1).max(200),
  note: z.string().max(300).nullable().optional(),
  group: z.string().max(120).nullable().optional(),
});

export const aiMapDraftEdgeSchema = z.object({
  fromLabel: z.string().min(1).max(200),
  toLabel: z.string().min(1).max(200),
  /** A relationship kind such as "synonym"; the server keeps only those the map's type accepts. */
  kind: z.string().min(1).max(40),
  pattern: z.string().max(300).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

export const aiMapDraftSchema = z.object({
  nodes: z.array(aiMapDraftNodeSchema).max(12),
  edges: z.array(aiMapDraftEdgeSchema).max(24),
});

export type AiMapDraft = z.infer<typeof aiMapDraftSchema>;

// ---------------------------------------------------------------------------
// A generated reading for Discovery
// ---------------------------------------------------------------------------

/** What the learner offers to generate from: exactly one of these. */
export const aiDiscoveryRequestSchema = z
  .strictObject({
    /** A topic the learner typed. */
    topic: z.string().min(1).max(200).optional(),
    /** A saved collection, read for its words. The collection itself is never changed. */
    collectionId: z.uuid().optional(),
    /** A group of words the learner chose. */
    words: z.array(z.string().min(1).max(200)).min(1).max(30).optional(),
    /** What the text should help the learner do, if they said. */
    objective: z.string().max(200).optional(),
    length: z.enum(['short', 'medium']).optional(),
    requestId: z.uuid(),
  })
  .refine((value) => [value.topic !== undefined, value.collectionId !== undefined, value.words !== undefined].filter(Boolean).length === 1, {
    message: 'Give a topic, a collection or a list of words — exactly one.',
  });

export type AiDiscoveryRequest = z.infer<typeof aiDiscoveryRequestSchema>;

/** One word the model points at inside its own text. It can only ever be a word that is there. */
export const aiDiscoverySuggestionSchema = z.object({
  word: z.string().min(1).max(200),
  sentence: z.string().max(1000).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

/**
 * What the model may answer: a passage to read, and the words in it worth
 * stopping on. Every suggestion must be found in `text` as written — the
 * server checks before the draft is even shown — and nothing is stored
 * until the learner accepts the preview.
 */
export const aiDiscoveryDraftSchema = z.object({
  title: z.string().min(1).max(200),
  text: z.string().min(100).max(AI_LIMITS.passage),
  suggestions: z.array(aiDiscoverySuggestionSchema).max(30).default([]),
});

export type AiDiscoveryDraft = z.infer<typeof aiDiscoveryDraftSchema>;
