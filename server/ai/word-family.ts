/**
 * Word families: which words were formed from one root ("decide", "decision",
 * "decisive"), and which end of them is the base.
 *
 * The model is asked only for what a learner cannot see by looking at one
 * word: the members of the family, a short gloss for each, and which member
 * is the root. Everything it answers is a draft the reader reviews - untick a
 * member, fix a gloss, point the links somewhere else - before any word is
 * created or linked. A family the reader then builds by hand is just as good,
 * and the words, the links and the schedule stay theirs.
 */
import { aiWordFamilyResponseSchema, type AiWordFamilyRequest, type AiWordFamilyResponse } from '../../shared/ai.js';
import { AiError, type AiAdapter } from './adapter.js';
import type { RateLimiter } from './rate-limit.js';

export interface WordFamilyOptions {
  adapter: AiAdapter;
  limiter: RateLimiter;
}

/** How often one account may ask for a family. The same order as the reader's. */
export const WORD_FAMILY_RATE = { capacity: 5, refillMs: 60_000 } as const;

const SYSTEM = [
  'You help an English learner see how words are formed from one root.',
  'You are given a word from the learner\'s flashcards.',
  'Reply with a JSON object only: {"family": [{"word": string, "gloss": string|null, "root": boolean}]}.',
  'List the common members of this word family: the root itself and the words formed from it.',
  'The requested word must appear in the list exactly once.',
  'Exactly one member has "root": true - the base form the others were formed from.',
  'When the requested word IS the base form, it is that one.',
  'gloss: a short natural Vietnamese meaning of that member in this family, or null when unsure.',
  'Only list words genuinely formed from this root; a family of one, the word as its own root, is a valid answer.',
].join('\n');

export class WordFamily {
  private readonly adapter: AiAdapter;
  private readonly limiter: RateLimiter;

  constructor(options: WordFamilyOptions) {
    this.adapter = options.adapter;
    this.limiter = options.limiter;
  }

  async suggest(accountKey: string, request: AiWordFamilyRequest): Promise<AiWordFamilyResponse> {
    if (!this.limiter.allow(accountKey)) {
      throw new AiError('rate_limited', 'Too many AI requests just now. Try again in a minute.');
    }
    const lines = [`Word: ${request.word}`];
    if (request.meaning) lines.push(`Meaning: ${request.meaning}`);
    if (request.definition) lines.push(`Definition: ${request.definition}`);
    const answer = await this.adapter.ask(
      { system: SYSTEM, prompt: lines.join('\n'), maxOutputTokens: 500 },
      aiWordFamilyResponseSchema,
    );
    return { family: answer.family };
  }
}
