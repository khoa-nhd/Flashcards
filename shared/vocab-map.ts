/**
 * Vocabulary Maps: the rules both the browser and the server agree on. A map
 * is a diagram the learner draws with their own words — saved vocabulary by
 * canonical id, a specific sense where a relationship is about one meaning
 * only, and AI suggestions kept apart as candidates until they are explicitly
 * saved as words.
 *
 * Three invariants live here and are enforced by the server:
 *   - saving a map never saves a word; a candidate is map data, not vocabulary;
 *   - nodes reference canonical ids, never a copy of a word's text (saved
 *     nodes carry no stored label — the word is read live, so renaming a word
 *     updates every map it sits in without touching the map);
 *   - nothing a map does changes a schedule, mastery or review history.
 */
import { z } from 'zod';
import { pageIdSchema } from './api.js';

/** The same limits the database and the service check. */
export const VOCAB_MAP_LIMITS = {
  title: 120,
  description: 600,
  label: 80,
  note: 600,
  pattern: 120,
  group: 60,
  step: 999,
  nodes: 60,
  edges: 120,
  expandNodes: 10,
  expandEdges: 20,
} as const;

/** The eight learning experiences. `personal` is drawn from saved data and is never created by hand. */
export const VOCAB_MAP_TYPES = [
  'semantic',
  'word_family',
  'collocation',
  'thematic',
  'nuance',
  'scenario',
  'function',
  'personal',
] as const;
export type VocabMapType = (typeof VOCAB_MAP_TYPES)[number];

/** The types a learner may create. The personal map is derived, never stored. */
export const CREATABLE_MAP_TYPES = [
  'semantic',
  'word_family',
  'collocation',
  'thematic',
  'nuance',
  'scenario',
  'function',
] as const;
export type CreatableMapType = (typeof CREATABLE_MAP_TYPES)[number];

export const VOCAB_MAP_TYPE_LABELS: Record<VocabMapType, string> = {
  semantic: 'Semantic relationships',
  word_family: 'Word family',
  collocation: 'Collocations',
  thematic: 'Thematic',
  nuance: 'Nuance & contrast',
  scenario: 'Scenario',
  function: 'Communicative function',
  personal: 'Personal knowledge',
};

export const VOCAB_MAP_TYPE_HINTS: Record<VocabMapType, string> = {
  semantic: 'Synonyms, antonyms and broader or narrower meanings, tied to the sense they hold them in.',
  word_family: 'Inflections and derivations around a root, with the direction of forming shown.',
  collocation: 'Words that naturally go together, as verb + noun or adjective + noun, with an example each.',
  thematic: 'Vocabulary grouped by topic and subtopic, with words that cross topics set apart.',
  nuance: 'Close expressions compared side by side: register, intensity, connotation and the difference.',
  scenario: 'A situation walked through in order, from the first step to the last.',
  function: 'Phrases grouped by what the speaker wants to do: agree, disagree politely, ask for clarification.',
  personal: 'Your vocabulary and every saved connection, drawn live from your library and maps.',
};

/**
 * Every relationship kind any map may store. A kind fixes how the edge reads;
 * the map's own type decides which kinds it accepts (below).
 */
export const MAP_EDGE_KINDS = [
  'synonym',
  'antonym',
  'hypernym',
  'hyponym',
  'related',
  'confused',
  'inflection',
  'derivation',
  'related_form',
  'verb_noun',
  'adjective_noun',
  'adverb_adjective',
  'collocation',
  'other_pattern',
  'contrast',
  'subtopic',
  'step',
  'phrase_variant',
] as const;
export type MapEdgeKind = (typeof MAP_EDGE_KINDS)[number];

export const MAP_EDGE_LABELS: Record<MapEdgeKind, string> = {
  synonym: 'Synonym of',
  antonym: 'Antonym of',
  hypernym: 'Broader meaning',
  hyponym: 'Narrower meaning',
  related: 'Related to',
  confused: 'Often confused with',
  inflection: 'Inflected form of',
  derivation: 'Derived from',
  related_form: 'Related form of',
  verb_noun: 'Verb + noun',
  adjective_noun: 'Adjective + noun',
  adverb_adjective: 'Adverb + adjective',
  collocation: 'Collocates with',
  other_pattern: 'Pattern',
  contrast: 'Contrasts with',
  subtopic: 'Part of the topic',
  step: 'Then',
  phrase_variant: 'Another way to say it',
};

/** Which kinds each map type accepts. The server refuses anything else. */
export const MAP_EDGE_KINDS_BY_TYPE: Record<VocabMapType, readonly MapEdgeKind[]> = {
  semantic: ['synonym', 'antonym', 'hypernym', 'hyponym', 'related', 'confused'],
  word_family: ['inflection', 'derivation', 'related_form'],
  collocation: ['verb_noun', 'adjective_noun', 'adverb_adjective', 'collocation', 'other_pattern'],
  thematic: ['subtopic', 'related', 'synonym', 'antonym'],
  nuance: ['contrast', 'related'],
  scenario: ['step'],
  function: ['phrase_variant', 'related'],
  personal: ['synonym', 'antonym', 'confused', 'related', 'related_form', 'collocation'],
};

/** Collocation edges carry the combination itself as the pattern text. */
export const EDGE_KIND_NEEDS_PATTERN: readonly MapEdgeKind[] = [
  'verb_noun',
  'adjective_noun',
  'adverb_adjective',
  'other_pattern',
];

export function edgeKindAllowed(type: VocabMapType, kind: MapEdgeKind): boolean {
  return MAP_EDGE_KINDS_BY_TYPE[type].includes(kind);
}

export function edgeKindNeedsPattern(kind: MapEdgeKind): boolean {
  return EDGE_KIND_NEEDS_PATTERN.includes(kind);
}

/** A contrast edge must say what the difference is. */
export function edgeKindNeedsNote(type: VocabMapType, kind: MapEdgeKind): boolean {
  return type === 'nuance' && kind === 'contrast';
}

/** Whether a stored kind is one this version understands. */
export function isMapEdgeKind(kind: string): kind is MapEdgeKind {
  return (MAP_EDGE_KINDS as readonly string[]).includes(kind);
}

export function isVocabMapType(type: string): type is VocabMapType {
  return (VOCAB_MAP_TYPES as readonly string[]).includes(type);
}

export type MapNodeKind = 'saved' | 'candidate';

/** A name as stored: Unicode-normalised, trimmed, inner whitespace collapsed. */
export const tidyMapText = (value: string): string => value.normalize('NFC').trim().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// Stored shapes, as the server sends them
// ---------------------------------------------------------------------------

export const mapWordSchema = z.strictObject({
  id: z.string(),
  word: z.string(),
  meaning: z.string().nullable(),
});
export type MapWord = z.infer<typeof mapWordSchema>;

export const mapSenseSchema = z.strictObject({
  id: z.string(),
  meaning: z.string().nullable(),
});
export type MapSense = z.infer<typeof mapSenseSchema>;

export const vocabMapNodeSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['saved', 'candidate']),
  /** Saved nodes only: the canonical word this node stands for. */
  vocabularyId: z.string().nullable(),
  /** Saved nodes only: one particular meaning, where the relationship is about that meaning. */
  senseId: z.string().nullable(),
  /** Candidates only: the suggested word itself. Saved words read their label live. */
  label: z.string().nullable(),
  note: z.string(),
  /** A topic, subtopic or communicative intention this node sits under. */
  group: z.string().nullable(),
  /** Scenario maps: the step this node belongs to. */
  step: z.number().int().nullable(),
  /** Saved layout position; null until the learner moves it. */
  x: z.number().int().nullable(),
  y: z.number().int().nullable(),
  /** Saved nodes only: the word as it stands now, so a rename shows everywhere at once. */
  word: mapWordSchema.nullable(),
  /** Set when the node points at one sense of its word. */
  sense: mapSenseSchema.nullable(),
});
export type VocabMapNode = z.infer<typeof vocabMapNodeSchema>;

export const vocabMapEdgeSchema = z.strictObject({
  id: z.string(),
  fromNodeId: z.string(),
  toNodeId: z.string(),
  kind: z.enum(MAP_EDGE_KINDS),
  /** The combination text for a collocation pattern, empty for other kinds. */
  pattern: z.string(),
  /** Free text: the difference a contrast draws, or a note on the link. */
  note: z.string(),
});
export type VocabMapEdge = z.infer<typeof vocabMapEdgeSchema>;

export const vocabMapSummarySchema = z.strictObject({
  id: z.string(),
  type: z.enum(VOCAB_MAP_TYPES),
  title: z.string(),
  description: z.string(),
  /** Bumps on every structural change; carried back as an optimistic lock. */
  revision: z.number().int(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VocabMapSummary = z.infer<typeof vocabMapSummarySchema>;

export const vocabMapDocumentSchema = vocabMapSummarySchema.extend({
  nodes: z.array(vocabMapNodeSchema),
  edges: z.array(vocabMapEdgeSchema),
});
export type VocabMapDocument = z.infer<typeof vocabMapDocumentSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const createMapRequestSchema = z.strictObject({
  type: z.enum(CREATABLE_MAP_TYPES),
  title: z.string().min(1).max(VOCAB_MAP_LIMITS.title),
  description: z.string().max(VOCAB_MAP_LIMITS.description).optional(),
  /** A repeated request id returns the map the first one made. */
  requestId: pageIdSchema.optional(),
});
export type CreateMapRequest = z.infer<typeof createMapRequestSchema>;

export const updateMapRequestSchema = z.strictObject({
  title: z.string().min(1).max(VOCAB_MAP_LIMITS.title).optional(),
  description: z.string().max(VOCAB_MAP_LIMITS.description).optional(),
  /** The revision the client last saw; a mismatch is a 409, not a silent overwrite. */
  ifMatch: z.number().int().min(1).optional(),
});
export type UpdateMapRequest = z.infer<typeof updateMapRequestSchema>;

export const addMapNodeRequestSchema = z.strictObject({
  kind: z.enum(['saved', 'candidate']),
  /** Required for a saved node; refused for a candidate. */
  vocabularyId: pageIdSchema.optional(),
  /** One particular meaning of that word, where the relationship is about that meaning. */
  senseId: pageIdSchema.optional(),
  /** Required for a candidate; refused for a saved node. */
  label: z.string().min(1).max(VOCAB_MAP_LIMITS.label).optional(),
  note: z.string().max(VOCAB_MAP_LIMITS.note).optional(),
  group: z.string().max(VOCAB_MAP_LIMITS.group).nullable().optional(),
  step: z.number().int().min(1).max(VOCAB_MAP_LIMITS.step).nullable().optional(),
  requestId: pageIdSchema.optional(),
});
export type AddMapNodeRequest = z.infer<typeof addMapNodeRequestSchema>;

export const updateMapNodeRequestSchema = z.strictObject({
  /** Candidates only: correct the suggested word's text. */
  label: z.string().min(1).max(VOCAB_MAP_LIMITS.label).optional(),
  note: z.string().max(VOCAB_MAP_LIMITS.note).optional(),
  group: z.string().max(VOCAB_MAP_LIMITS.group).nullable().optional(),
  step: z.number().int().min(1).max(VOCAB_MAP_LIMITS.step).nullable().optional(),
  ifMatch: z.number().int().min(1).optional(),
});
export type UpdateMapNodeRequest = z.infer<typeof updateMapNodeRequestSchema>;

export const addMapEdgeRequestSchema = z.strictObject({
  fromNodeId: pageIdSchema,
  toNodeId: pageIdSchema,
  kind: z.enum(MAP_EDGE_KINDS),
  /** The combination, for the kinds that name one (verb + noun and friends). */
  pattern: z.string().max(VOCAB_MAP_LIMITS.pattern).optional(),
  /** The difference, for a contrast; a note on the link for anything else. */
  note: z.string().max(VOCAB_MAP_LIMITS.note).optional(),
});
export type AddMapEdgeRequest = z.infer<typeof addMapEdgeRequestSchema>;

export const updateMapEdgeRequestSchema = z.strictObject({
  pattern: z.string().max(VOCAB_MAP_LIMITS.pattern).optional(),
  note: z.string().max(VOCAB_MAP_LIMITS.note).optional(),
  ifMatch: z.number().int().min(1).optional(),
});
export type UpdateMapEdgeRequest = z.infer<typeof updateMapEdgeRequestSchema>;

export const saveMapLayoutRequestSchema = z.strictObject({
  positions: z
    .array(
      z.strictObject({
        nodeId: pageIdSchema,
        x: z.number().int().min(-2000).max(2000),
        y: z.number().int().min(-2000).max(2000),
      }),
    )
    .max(VOCAB_MAP_LIMITS.nodes),
  ifMatch: z.number().int().min(1).optional(),
});
export type SaveMapLayoutRequest = z.infer<typeof saveMapLayoutRequestSchema>;

/** Turning a candidate into a real word: the one place a map may create vocabulary, on this explicit request. */
export const saveCandidateRequestSchema = z.strictObject({
  /** The word is created from the candidate's label; senses and meaning are edited afterwards like any word. */
  requestId: pageIdSchema.optional(),
});
export type SaveCandidateRequest = z.infer<typeof saveCandidateRequestSchema>;

export const generateMapRequestSchema = z.strictObject({
  type: z.enum(CREATABLE_MAP_TYPES),
  title: z.string().min(1).max(VOCAB_MAP_LIMITS.title).optional(),
  /** What the map is about. With no word or collection given, the map starts from the topic alone. */
  topic: z.string().max(200).optional(),
  /** Start from one saved word: it lands as a saved node, suggestions stay candidates. */
  vocabularyId: pageIdSchema.optional(),
  /** Start from a saved collection: its words land as saved nodes. */
  collectionId: pageIdSchema.optional(),
  requestId: pageIdSchema.optional(),
});
export type GenerateMapRequest = z.infer<typeof generateMapRequestSchema>;

export const expandMapRequestSchema = z.strictObject({
  /** With `apply`, the validated suggestions become candidate nodes; without it they are only proposed. */
  apply: z.boolean().optional(),
  requestId: pageIdSchema.optional(),
});
export type ExpandMapRequest = z.infer<typeof expandMapRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const mapSuggestionNodeSchema = z.strictObject({
  label: z.string(),
  note: z.string(),
  group: z.string().nullable(),
});

export const mapSuggestionEdgeSchema = z.strictObject({
  fromLabel: z.string(),
  toLabel: z.string(),
  kind: z.enum(MAP_EDGE_KINDS),
  pattern: z.string(),
  note: z.string(),
});

/** What a model proposed, named by label. Applying it turns labels into candidate nodes. */
export const mapSuggestionsSchema = z.strictObject({
  nodes: z.array(mapSuggestionNodeSchema),
  edges: z.array(mapSuggestionEdgeSchema),
});
export type MapSuggestions = z.infer<typeof mapSuggestionsSchema>;

export const mapsListResponseSchema = z.strictObject({ maps: z.array(vocabMapSummarySchema) });
export const mapResponseSchema = z.strictObject({ map: vocabMapDocumentSchema });
export const mapSummaryResponseSchema = z.strictObject({ map: vocabMapSummarySchema });
export const mapNodeResponseSchema = z.strictObject({ node: vocabMapNodeSchema });
export const mapEdgeResponseSchema = z.strictObject({ edge: vocabMapEdgeSchema });
export const mapDeletedResponseSchema = z.strictObject({ id: z.string(), deleted: z.literal(true) });
export const saveCandidateResponseSchema = z.strictObject({ node: vocabMapNodeSchema, entryId: z.string() });
export const expandMapResponseSchema = z.strictObject({ suggestions: mapSuggestionsSchema, applied: z.boolean() });

export const personalMapStatsSchema = z.strictObject({
  words: z.number().int(),
  maps: z.number().int(),
  collections: z.number().int(),
  relations: z.number().int(),
  senses: z.number().int(),
});
export const personalMapResponseSchema = z.strictObject({
  personal: vocabMapDocumentSchema,
  stats: personalMapStatsSchema,
});
export type PersonalMapResponse = z.infer<typeof personalMapResponseSchema>;

/** The kind a saved library relationship is drawn as on the personal map. */
export const LIBRARY_RELATION_TO_EDGE: Record<string, MapEdgeKind> = {
  synonym: 'synonym',
  antonym: 'antonym',
  word_family: 'related_form',
  collocation: 'collocation',
  related: 'related',
  confused: 'confused',
};
