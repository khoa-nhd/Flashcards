/**
 * The authored content and the generated emoji pool, checked so a careless
 * edit is caught here rather than in the chat bubble: tag coverage, bucket
 * hygiene, the trivia word limit in every voice, and the variety floor that
 * the "thousands of combinations" promise rests on.
 */
import { describe, expect, it } from 'vitest';
import {
  EMOJI_BUCKETS,
  EMOJI_DENYLIST,
  PERSONAS,
  STAGE_ORDER,
  TARGETS,
  TRIVIA_FACTS,
  TRIVIA_FRAMINGS,
  type TaggedLine,
} from '../../src/lib/thinking-content.js';
import { EMOJI_POOL } from '../../src/lib/emoji-pool.generated.js';
import { TRIVIA_MAX_WORDS, expandEmojiChoices } from '../../src/lib/thinking-engine.js';

const words = (text: string) => text.trim().split(/\s+/).length;

const taggedLines = (): TaggedLine[] => [
  ...TARGETS,
  ...Object.values(PERSONAS).flatMap((persona) => [
    ...persona.openers,
    ...STAGE_ORDER.flatMap((stage) => persona.stages[stage]),
  ]),
];

describe('the emoji pool', () => {
  it('is big, unique and clean', () => {
    expect(EMOJI_POOL.length).toBeGreaterThanOrEqual(1500);
    expect(new Set(EMOJI_POOL).size).toBe(EMOJI_POOL.length);
    for (const emoji of EMOJI_POOL) {
      expect(emoji.length).toBeGreaterThan(0);
      expect(emoji).not.toMatch(/\s/);
      expect(EMOJI_DENYLIST).not.toContain(emoji);
    }
  });
});

describe('the emoji buckets', () => {
  it('are non-empty, unique and free of denied emoji', () => {
    const seen = new Set<string>();
    for (const [id, bucket] of Object.entries(EMOJI_BUCKETS)) {
      expect(bucket.length, id).toBeGreaterThan(0);
      for (const emoji of bucket) {
        expect(seen.has(emoji), `${emoji} repeated (${id})`).toBe(false);
        seen.add(emoji);
        expect(EMOJI_DENYLIST).not.toContain(emoji);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(100);
  });
});

describe('the authored lines', () => {
  it('ships the promised seed', () => {
    expect(TARGETS).toHaveLength(24);
    expect(Object.keys(PERSONAS)).toHaveLength(3);
    for (const persona of Object.values(PERSONAS)) {
      expect(persona.openers).toHaveLength(20);
      for (const stage of STAGE_ORDER) expect(persona.stages[stage]).toHaveLength(5);
    }
    expect(TRIVIA_FACTS).toHaveLength(30);
    for (const framings of Object.values(TRIVIA_FRAMINGS)) expect(framings).toHaveLength(4);
  });

  it('tags every line with 2 to 4 existing buckets', () => {
    for (const line of taggedLines()) {
      expect(line.tags.length, line.text).toBeGreaterThanOrEqual(2);
      expect(line.tags.length, line.text).toBeLessThanOrEqual(4);
      for (const tag of line.tags) expect(EMOJI_BUCKETS[tag], `${line.text} → ${tag}`).toBeDefined();
      expect(expandEmojiChoices(line.tags).length, line.text).toBeGreaterThan(0);
    }
  });
});

describe('the trivia', () => {
  it('stays inside the word limit in every voice', () => {
    expect(words(TRIVIA_FACTS[0]!)).toBeLessThanOrEqual(TRIVIA_MAX_WORDS);
    for (const fact of TRIVIA_FACTS) {
      expect(fact.endsWith('.'), fact).toBe(true);
      for (const framings of Object.values(TRIVIA_FRAMINGS)) {
        expect(framings.every((framing) => framing.endsWith(':'))).toBe(true);
        for (const framing of framings) {
          expect(words(`${framing} ${fact}`), `${framing} ${fact}`).toBeLessThanOrEqual(TRIVIA_MAX_WORDS);
        }
      }
    }
  });
});

describe('the variety floor', () => {
  it('renders more than ten thousand distinct strings', () => {
    let total = EMOJI_POOL.length; // lone-emoji ticks
    for (const persona of Object.values(PERSONAS)) {
      for (const opener of persona.openers) {
        for (const target of TARGETS) {
          total += 1 + expandEmojiChoices([...opener.tags, ...target.tags]).length;
        }
      }
      for (const stage of STAGE_ORDER) {
        for (const line of persona.stages[stage]) {
          total += 1 + expandEmojiChoices(line.tags).length;
        }
      }
    }
    total += Object.keys(PERSONAS).length * TRIVIA_FACTS.length * Object.values(TRIVIA_FRAMINGS)[0]!.length;
    expect(total).toBeGreaterThanOrEqual(10_000);
  });
});
