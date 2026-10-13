/**
 * Smart Reader: what a word means in the sentence the reader picked it from.
 *
 * The sentence is taken from the reader's own text by this server
 * (shared/sentences.ts) and is never written by the model, so the example on
 * the card is always the reader's own wording. The model is asked only for
 * the two things a reading learner cannot write themselves: a short English
 * definition of that sense, and a natural Vietnamese meaning. Both may come
 * back null — "not confident" is a better answer than an invented sense,
 * because the reader is going to check the form before saving anyway.
 */
import { sentenceContaining } from '../../shared/sentences.js';
import { aiSenseSchema, type AiExtractRequest, type AiExtractResponse } from '../../shared/ai.js';
import { HttpError } from '../errors.js';
import { AiError, type AiAdapter } from './adapter.js';
import type { RateLimiter } from './rate-limit.js';

export interface SmartReaderOptions {
  adapter: AiAdapter;
  limiter: RateLimiter;
}

/**
 * How often one account may ask the model anything. Free tiers run out in
 * tens of requests per minute, and the reader's own throttle is a courtesy,
 * not the limit that matters: this one is checked before a request is made,
 * so a stuck interface cannot spend the whole quota.
 */
export const AI_RATE = { capacity: 5, refillMs: 60_000 } as const;

const SYSTEM = [
  'You help an English learner build flashcards from their own reading.',
  'You are given one sentence from a passage, and the word in it that the learner picked.',
  'Reply with a JSON object only: {"definition": string|null, "meaning": string|null}.',
  'Definition: a short English definition of the word AS USED in that sentence, not every sense it can have.',
  'Meaning: a natural Vietnamese translation of that same sense.',
  'If the sense is unclear, or you are not confident, use null for that field.',
  'Never guess a sense that is not shown by the sentence.',
].join('\n');

export class SmartReader {
  private readonly adapter: AiAdapter;
  private readonly limiter: RateLimiter;

  constructor(options: SmartReaderOptions) {
    this.adapter = options.adapter;
    this.limiter = options.limiter;
  }

  async extract(accountKey: string, request: AiExtractRequest): Promise<AiExtractResponse> {
    if (!this.limiter.allow(accountKey)) {
      throw new AiError('rate_limited', 'Too many AI requests just now. Try again in a minute.');
    }
    const sentence = sentenceContaining(request.text, request.word);
    if (sentence === null) {
      // The reader's own text did not hold the word: a mistake here is theirs to
      // fix, not the model's to answer, so it is refused before any quota is spent.
      throw new HttpError(400, 'invalid_request', 'That word was not found in the text.');
    }
    const sense = await this.adapter.ask(
      {
        system: SYSTEM,
        prompt: `Word: ${request.word}\nSentence: ${sentence}`,
        maxOutputTokens: 300,
      },
      aiSenseSchema,
    );
    return { sentence, definition: sense.definition, meaning: sense.meaning };
  }
}

/** An AI failure as the HTTP error the browser's fallback understands. */
export function aiErrorToHttp(error: AiError): { status: 409 | 429 | 502 | 503; code: string; message: string } {
  switch (error.failure) {
    case 'rate_limited':
      return { status: 429, code: 'rate_limited', message: error.message };
    case 'invalid_output':
      return { status: 502, code: 'ai_invalid', message: error.message };
    case 'not_configured':
      return { status: 409, code: 'not_supported', message: 'AI assistance is not configured on this server.' };
    default:
      return { status: 503, code: 'ai_unavailable', message: 'The AI service did not answer. Carry on by hand.' };
  }
}
