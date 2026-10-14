/**
 * A suggested structure for an exam: how many sections, which kinds of
 * question, and roughly how long each should be.
 *
 * The account's own words are resolved and judged by this server with the
 * same eligibility rules the builder uses (shared/study-modes.ts), so the
 * model is told only which words can take which kind of question — never
 * another account's data, never history. Its answer is a draft: the exam
 * builder shows it with its reason, and the reader presses "Use this plan"
 * (or edits the sections by hand) before anything runs. Sections naming a
 * mode no word can take, and counts beyond what the words support, are
 * dropped here rather than left for the builder to stumble over.
 */
import { aiExamPlanResponseSchema, type AiExamPlanResponse } from '../../shared/ai.js';
import {
  EXAM_MODES,
  ineligibility,
  type PracticeWord,
  type StudyMode,
} from '../../shared/study-modes.js';
import { AiError, type AiAdapter } from './adapter.js';
import type { RateLimiter } from './rate-limit.js';

export interface ExamPlanOptions {
  adapter: AiAdapter;
  limiter: RateLimiter;
}

/** How often one account may ask for a plan. The same order as the reader's. */
export const EXAM_PLAN_RATE = { capacity: 5, refillMs: 60_000 } as const;

/** The builder's own limits, so a plan always fits what the form will accept. */
export const PLAN_LIMITS = { sections: 4, questions: 30, countMin: 1, countMax: 50, minutesMax: 120 } as const;

const SYSTEM = [
  'You design short vocabulary exams for an English learner.',
  'Reply with a JSON object only: {"sections": [{"mode": string, "count": number, "minutes": number|null}], "reason": string}.',
  `"mode" must be one of: ${EXAM_MODES.join(', ')}, and may only be used where the words below say it is usable.`,
  `"count" is the number of questions for that section, between 1 and ${PLAN_LIMITS.countMax}.`,
  `"minutes" is the section's own time limit in minutes (1-${PLAN_LIMITS.minutesMax}), or null for no clock.`,
  `At most ${PLAN_LIMITS.sections} sections, and at most ${PLAN_LIMITS.questions} questions in total.`,
  'Aim the exam at the words described: prefer the kinds of question those words most need practice in.',
  '"reason": one short English sentence explaining the shape of the exam to the learner.',
].join('\n');

/** One word as the model may see it: its text and which questions it can take. */
function describe(word: PracticeWord, pool: readonly PracticeWord[]): string {
  const usable = EXAM_MODES.filter((mode) => ineligibility(mode, word, pool) === null);
  const meaning = word.meaning ?? word.definition ?? '';
  return `- ${word.word} | ${meaning} | usable: ${usable.join(', ') || 'none'}`;
}

export class ExamPlan {
  private readonly adapter: AiAdapter;
  private readonly limiter: RateLimiter;

  constructor(options: ExamPlanOptions) {
    this.adapter = options.adapter;
    this.limiter = options.limiter;
  }

  async suggest(accountKey: string, words: PracticeWord[]): Promise<AiExamPlanResponse> {
    if (!this.limiter.allow(accountKey)) {
      throw new AiError('rate_limited', 'Too many AI requests just now. Try again in a minute.');
    }
    if (words.length === 0) {
      throw new AiError('invalid_output', 'The model suggested nothing usable.');
    }
    // Which words each mode can actually draw from — the same question the
    // builder asks, asked here so the prompt carries facts, not guesses.
    const usable = new Map<StudyMode, number>(
      EXAM_MODES.map((mode) => [mode, words.filter((word) => ineligibility(mode, word, words) === null).length]),
    );
    const answer = await this.adapter.ask(
      {
        system: SYSTEM,
        prompt: [
          `${words.length} words in the learner's exam pool:`,
          `usable in total — ${EXAM_MODES.map((mode) => `${mode}: ${usable.get(mode) ?? 0}`).join('; ')}`,
          ...words.map((word) => describe(word, words)),
        ].join('\n'),
        maxOutputTokens: 500,
      },
      aiExamPlanResponseSchema,
    );

    // Keep only what the words support, and clamp everything into the
    // builder's own limits: a section no word can take, or a count larger
    // than the pool behind it, is dropped rather than passed on broken.
    let left = PLAN_LIMITS.questions;
    const sections: AiExamPlanResponse['sections'] = [];
    for (const section of answer.sections) {
      const capacity = usable.get(section.mode) ?? 0;
      if (capacity === 0 || left <= 0 || sections.length >= PLAN_LIMITS.sections) continue;
      const count = Math.min(Math.max(section.count, PLAN_LIMITS.countMin), PLAN_LIMITS.countMax, capacity, left);
      sections.push({
        mode: section.mode,
        count,
        minutes:
          section.minutes === null ? null : Math.min(Math.max(section.minutes, 1), PLAN_LIMITS.minutesMax),
      });
      left -= count;
    }
    if (sections.length === 0) throw new AiError('invalid_output', 'The model suggested nothing usable.');
    return { sections, reason: answer.reason };
  }
}
