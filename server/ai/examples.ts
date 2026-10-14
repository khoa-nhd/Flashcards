/**
 * Example sentences for a word the reader is adding, shown beside the ones
 * they already wrote.
 *
 * The request carries the collocations saved for the word, so the sentences
 * demonstrate the phrases the reader is actually studying rather than any
 * sentence the model likes. Every sentence comes back as a draft - the reader
 * reads it, edits it if they want, and only then saves it into the card's
 * examples, with the ordinary write path. Nothing is stored by asking.
 */
import { aiExamplesResponseSchema, type AiExamplesRequest, type AiExamplesResponse } from '../../shared/ai.js';
import { AiError, type AiAdapter } from './adapter.js';
import type { RateLimiter } from './rate-limit.js';

export interface ExamplesOptions {
  adapter: AiAdapter;
  limiter: RateLimiter;
}

/** How often one account may ask for sentences. The same order as the reader's. */
export const EXAMPLES_RATE = { capacity: 5, refillMs: 60_000 } as const;

const SYSTEM = [
  'You help an English learner collect example sentences for a flashcard.',
  'You are given a word from the learner\'s flashcards, and the collocations saved for it.',
  'Reply with a JSON object only: {"examples": [{"sentence": string, "uses": string|null}]}.',
  'Write natural English sentences a teacher would accept, at a level just above the learner\'s word.',
  'When collocations are given, some sentences must show one of them in natural use,',
  'with "uses" naming that collocation spelled exactly as given.',
  '"uses" must be one of the given collocations, or null when the sentence demonstrates none of them.',
  'Do not repeat a sentence the learner has already written.',
].join('\n');

export class Examples {
  private readonly adapter: AiAdapter;
  private readonly limiter: RateLimiter;

  constructor(options: ExamplesOptions) {
    this.adapter = options.adapter;
    this.limiter = options.limiter;
  }

  async suggest(accountKey: string, request: AiExamplesRequest): Promise<AiExamplesResponse> {
    if (!this.limiter.allow(accountKey)) {
      throw new AiError('rate_limited', 'Too many AI requests just now. Try again in a minute.');
    }
    const lines = [`Word: ${request.word}`];
    if (request.meaning) lines.push(`Meaning: ${request.meaning}`);
    if (request.definition) lines.push(`Definition: ${request.definition}`);
    if (request.example) lines.push(`Already written by the learner: ${request.example}`);
    lines.push(
      request.collocations.length > 0
        ? `Collocations: ${request.collocations.join('; ')}`
        : 'Collocations: none saved for this word.',
    );
    const answer = await this.adapter.ask(
      { system: SYSTEM, prompt: lines.join('\n'), maxOutputTokens: 700 },
      aiExamplesResponseSchema,
    );
    return { examples: answer.examples };
  }
}
