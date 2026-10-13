/**
 * Writing coach: a short note on the sentence the reviewer wrote for the
 * Writing Challenge, and one model sentence to show the word used well.
 *
 * The verdict is not the model's to give. The word-use check in
 * shared/study-modes.ts has already decided, and this note arrives after it,
 * changing nothing: never `correct`, never a word's schedule. Every way a call
 * can fail — no key, no quota, a reply that is not the shape asked for —
 * comes back as `null`, so a practice answer is always answered.
 */
import { z } from 'zod';
import { tidy } from '../../shared/study-modes.js';
import type { AiAdapter } from './adapter.js';
import type { RateLimiter } from './rate-limit.js';

export interface WritingCoachOptions {
  adapter: AiAdapter;
  limiter: RateLimiter;
}

/**
 * How often the model may be asked for a writing note. One bucket for the
 * whole process, checked before a request is made, so a stuck interface
 * cannot spend the whole quota.
 */
export const WRITING_COACH_RATE = { capacity: 10, refillMs: 60_000 } as const;

/** Below this there is too little to say, so no quota is spent on asking. */
const MIN_TEXT_LENGTH = 30;

/** What the reply must carry. Anything else counts as a failure, and failures are `null`. */
const coachNoteSchema = z.object({
  feedback: z.string().max(1500),
  modelAnswer: z.string().max(300),
});

const SYSTEM = [
  'You are an English writing coach for a learner practising with flashcards.',
  'The learner writes one sentence using a given word. Judge nothing: their answer has already been marked.',
  'Reply with a JSON object only: {"feedback": string, "modelAnswer": string}.',
  'feedback: two to four short sentences addressed to the learner, in English.',
  'Give ONE concrete improvement they can make to the sentence — wording, grammar or how the word is used.',
  'Never invent anything about the learner’s life, and never add praise that is not about the sentence itself.',
  'modelAnswer: one natural English sentence of its own that uses the given word well.',
].join('\n');

/** The coach's note, when there is one. */
export interface WritingCoachNote {
  feedback: string;
  modelAnswer: string;
}

export interface WritingCoach {
  /**
   * A note on this sentence, or `null` when there is none to give: the text
   * is too short to comment on, the quota is spent, or the model failed.
   */
  note(input: { word: string; meaning: string | null; text: string }): Promise<WritingCoachNote | null>;
}

export function createWritingCoach(options: WritingCoachOptions): WritingCoach {
  const { adapter, limiter } = options;
  return {
    async note({ word, meaning, text }) {
      try {
        const sentence = tidy(text);
        if (sentence.length < MIN_TEXT_LENGTH) return null;
        // One bucket for the whole process: the key never varies by account.
        if (!limiter.allow('writing-coach')) return null;
        const asked = await adapter.ask(
          {
            system: SYSTEM,
            prompt: `Word: ${word}\n${meaning === null || meaning === '' ? '' : `Meaning: ${meaning}\n`}Sentence: ${sentence}`,
            maxOutputTokens: 500,
          },
          coachNoteSchema,
        );
        return { feedback: asked.feedback, modelAnswer: asked.modelAnswer };
      } catch {
        // The note is an extra, so every failure is simply "no note this time".
        return null;
      }
    },
  };
}
