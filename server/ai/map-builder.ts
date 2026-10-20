/**
 * Draft maps: what a language model proposes when a map is generated from a
 * topic or word, or an existing one is expanded.
 *
 * The model is asked for labels, never ids — it is shown the words the
 * learner offered and replies naming them, so it cannot reach a word that
 * was not offered, and cannot invent a reference the server must trust.
 * What comes back is a draft: the service keeps only the kinds the map's
 * type accepts, only edges whose ends it can resolve, and turns every
 * unfamiliar word into a candidate that stays unsaved until the learner says
 * otherwise. The model's lexical judgement is a suggestion, not a fact.
 */
import { aiMapDraftSchema, type AiMapDraft } from '../../shared/ai.js';
import { MAP_EDGE_KINDS_BY_TYPE, VOCAB_MAP_TYPE_LABELS, type VocabMapType } from '../../shared/vocab-map.js';
import { AiError, type AiAdapter } from './adapter.js';
import type { RateLimiter } from './rate-limit.js';

export interface MapBuilderOptions {
  adapter: AiAdapter;
  limiter: RateLimiter;
}

/** How often one account may ask for a map. The same order as the other features'. */
export const MAPS_AI_RATE = { capacity: 5, refillMs: 60_000 } as const;

/** How each map type is described to the model, in its own terms. */
const TYPE_GUIDANCE: Record<Exclude<VocabMapType, 'personal'>, string> = {
  semantic:
    'Connect words whose MEANINGS relate: "synonym" (same meaning), "antonym" (opposite), "hypernym" (the broader category), "hyponym" (a narrower member), "related" (loosely connected), "confused" (often mixed up). Two words are rarely synonyms in every context — when a relationship holds only for one meaning, say so in the note.',
  word_family:
    'Connect words through how they are formed: "inflection" (the same word in another form: run/running), "derivation" (formed from another word using a prefix, suffix or root change: decide/decision), "related_form" (a looser family link). Never claim a derivation without clear word-forming evidence.',
  collocation:
    'Connect words that naturally go together: "verb_noun" (make a decision), "adjective_noun" (heavy rain), "adverb_adjective" (deeply sorry), "collocation" (any other natural pair), "other_pattern" (an expression of your own). For every verb_noun, adjective_noun, adverb_adjective and other_pattern edge, put the combination itself in "pattern".',
  thematic:
    'Organise words around a topic: give nodes a "group" naming their topic or subtopic ("Travel", "Travel > Airports"). Connect a subtopic to its wider topic with "subtopic", and genuinely linked words with "related". Words that belong to no single topic can be left without a group.',
  nuance:
    'Compare expressions that are close but different: every edge should be "contrast", and its "note" must state the actual difference — register (formal/casual), intensity (slight/strong), connotation (positive/negative), usage or collocation. "related" may connect words that are merely associated. Never reduce this to a list of synonyms.',
  scenario:
    'Arrange phrases as they are used in one practical situation, in the order they would be spoken or acted: "step" edges point from an earlier moment to a later one. Put each node\'s moment in "group" if it helps (e.g. "Arriving", "Ordering").',
  function:
    'Group phrases by what the speaker wants to accomplish: give each node a "group" naming the intention ("Agreeing", "Disagreeing politely", "Asking for clarification", "Making a suggestion"). Connect alternative ways of saying the same thing with "phrase_variant", and merely associated phrases with "related".',
};

const replyShape =
  'Reply with a JSON object only: {"nodes": [{"label": string, "note": string|null, "group": string|null}], ' +
  '"edges": [{"fromLabel": string, "toLabel": string, "kind": string, "pattern": string|null, "note": string|null}]}.' +
  ' Name every edge end by its exact node label from your own node list.';

const systemFor = (type: Exclude<VocabMapType, 'personal'>): string =>
  [
    `You help an English learner build a "${VOCAB_MAP_TYPE_LABELS[type]}" for their vocabulary.`,
    TYPE_GUIDANCE[type],
    `Relationship kinds this map accepts: ${MAP_EDGE_KINDS_BY_TYPE[type].join(', ')}. Use only these.`,
    replyShape,
    'Suggest only words and phrases an English learner could actually meet; keep every note short and concrete.',
  ].join('\n');

export class MapBuilder {
  private readonly adapter: AiAdapter;
  private readonly limiter: RateLimiter;

  constructor(options: MapBuilderOptions) {
    this.adapter = options.adapter;
    this.limiter = options.limiter;
  }

  /** A first draft: the learner's own words at the centre, suggestions around them. */
  async generate(
    accountKey: string,
    request: {
      type: Exclude<VocabMapType, 'personal'>;
      topic?: string | undefined;
      seeds: ReadonlyArray<{ word: string; meaning?: string | null | undefined }>;
    },
  ): Promise<AiMapDraft> {
    if (!this.limiter.allow(accountKey)) {
      throw new AiError('rate_limited', 'Too many AI requests just now. Try again in a minute.');
    }
    const lines: string[] = [];
    if (request.topic !== undefined && request.topic !== '') lines.push(`The map is about: ${request.topic}`);
    if (request.seeds.length > 0) {
      lines.push('These words already exist in the learner\'s vocabulary — name them in edges by their exact spelling:');
      for (const seed of request.seeds) {
        lines.push(`- ${seed.word}${seed.meaning ? ` ( ${seed.meaning} )` : ''}`);
      }
      lines.push('Every node you add beyond these is a NEW word the learner has not saved yet.');
    } else {
      lines.push('The learner has no starting words: propose a useful set of nodes for this map.');
    }
    lines.push('At most 10 nodes and 20 edges.');
    return this.ask(request.type, lines);
  }

  /** More of the same map, judged against what it already holds. */
  async expand(
    accountKey: string,
    request: {
      type: Exclude<VocabMapType, 'personal'>;
      title: string;
      nodes: ReadonlyArray<{ label: string; kind: 'saved' | 'candidate'; group: string | null }>;
      edges: ReadonlyArray<{ kind: string }>;
    },
  ): Promise<AiMapDraft> {
    if (!this.limiter.allow(accountKey)) {
      throw new AiError('rate_limited', 'Too many AI requests just now. Try again in a minute.');
    }
    const lines = [`The map is called "${request.title}".`];
    if (request.nodes.length > 0) {
      lines.push('It already holds these nodes:');
      for (const node of request.nodes) {
        lines.push(`- ${node.label}${node.group === null ? '' : ` [${node.group}]`}${node.kind === 'saved' ? ' (saved word)' : ' (suggestion)'}`);
      }
    } else {
      lines.push('It is empty.');
    }
    if (request.edges.length > 0) lines.push(`It already holds ${request.edges.length} relationships.`);
    lines.push('Suggest up to 10 further nodes and up to 20 relationships that fit what is there — do not repeat what the map already has.');
    lines.push('Nodes you have not been given are NEW words the learner has not saved yet.');
    return this.ask(request.type, lines);
  }

  private async ask(type: Exclude<VocabMapType, 'personal'>, promptLines: string[]): Promise<AiMapDraft> {
    const answer = await this.adapter.ask(
      { system: systemFor(type), prompt: promptLines.join('\n'), maxOutputTokens: 1200 },
      aiMapDraftSchema,
    );
    // The schema caps the arrays; nothing else about the answer is trusted
    // until the service checks each node and edge against the map's own rules.
    return { nodes: answer.nodes, edges: answer.edges };
  }
}
