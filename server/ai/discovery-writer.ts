/**
 * Generated discovery content: what a language model writes when the
 * learner asks for a reading around a topic, a collection or a group of
 * words.
 *
 * The model writes prose and points at words inside its own text — it
 * never receives a saved word id, a collection row or any account data
 * beyond the plain words it was offered, and its reply is only a draft:
 * nothing is stored until the learner accepts the preview, and every
 * suggested word must be found in the text as written before the draft is
 * even shown. What comes back cannot overwrite anything, because it is
 * never written anywhere without that acceptance.
 */
import { aiDiscoveryDraftSchema, type AiDiscoveryDraft } from '../../shared/ai.js';
import type { DiscoverySeeds } from '../discovery-service.js';
import { AiError, type AiAdapter } from './adapter.js';
import type { RateLimiter } from './rate-limit.js';

export interface DiscoveryWriterOptions {
  adapter: AiAdapter;
  limiter: RateLimiter;
}

/** How often one account may ask for a draft. The same order as the other features'. */
export const DISCOVERY_AI_RATE = { capacity: 5, refillMs: 60_000 } as const;

const replyShape =
  'Reply with a JSON object only: {"title": string, "text": string, ' +
  '"suggestions": [{"word": string, "sentence": string|null, "note": string|null}]}.';

const system = [
  'You write short, natural English readings for a language learner to discover vocabulary in context.',
  'The text must be genuine prose a learner could read for pleasure or study — a situation, an account, an explanation — never a list of definitions, never a glossary, never bullet points of words.',
  'Work only from what you are given: a topic, a group of words, or a collection named with its words. Weave those words in naturally where they fit; do not force every one in if a sentence would suffer.',
  '"suggestions" points at up to 12 words in your own text that a learner might want to stop on: a useful word, an idiom, a collocation. Every suggested word must appear in "text" exactly as written there.',
  '"sentence" is the sentence of your own text the word appears in; "note" is at most a short hint of why it matters (a nuance, a typical partner word). Never a dictionary definition.',
  replyShape,
  'Keep the title under 12 words. Write for a learner around B1–B2; if the topic implies otherwise, say so in the note of one suggestion.',
].join('\n');

const LENGTH_GUIDANCE: Record<'short' | 'medium', string> = {
  short: 'Between 120 and 180 words.',
  medium: 'Between 280 and 400 words.',
};

export class DiscoveryWriter {
  private readonly adapter: AiAdapter;
  private readonly limiter: RateLimiter;

  constructor(options: DiscoveryWriterOptions) {
    this.adapter = options.adapter;
    this.limiter = options.limiter;
  }

  /**
   * A draft reading. Pure: the caller decides what to do with it, and
   * nothing about the account was sent beyond `seeds.words` — for a
   * collection only its plain words, never its id or contents as rows.
   */
  async draft(
    accountKey: string,
    request: { seeds: DiscoverySeeds; objective?: string | undefined; length?: 'short' | 'medium' | undefined },
  ): Promise<AiDiscoveryDraft> {
    if (!this.limiter.allow(accountKey)) {
      throw new AiError('rate_limited', 'Too many AI requests just now. Try again in a minute.');
    }
    const lines: string[] = [];
    switch (request.seeds.from.kind) {
      case 'topic':
        lines.push(`The reading is about: ${request.seeds.from.topic}`);
        break;
      case 'collection':
        lines.push(`Write from the learner's collection "${request.seeds.from.name}".`);
        break;
      case 'words':
        lines.push('Write around these words the learner chose:');
        break;
    }
    if (request.seeds.words.length > 0) {
      if (request.seeds.from.kind !== 'words') lines.push('These words are already in the learner\'s vocabulary — work them in:');
      for (const word of request.seeds.words) lines.push(`- ${word}`);
    }
    if (request.objective !== undefined && request.objective !== '') {
      lines.push(`The learner is working towards: ${request.objective}`);
    }
    lines.push(LENGTH_GUIDANCE[request.length ?? 'short']);
    const answer = await this.adapter.ask({ system, prompt: lines.join('\n'), maxOutputTokens: 2000 }, aiDiscoveryDraftSchema);
    // The schema caps every field; the service then insists each suggested
    // word really appears in the text before this draft reaches a screen.
    return {
      title: answer.title,
      text: answer.text,
      suggestions: answer.suggestions.map((suggestion) => ({
        word: suggestion.word,
        sentence: suggestion.sentence ?? undefined,
        note: suggestion.note ?? undefined,
      })),
    };
  }
}
