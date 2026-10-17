/**
 * The thinking engine: dwell by length, the stage ladder, seeded
 * determinism, the no-repeat promises within and across waits, emoji drawn
 * only from a line's own tags (never on trivia), the lone-emoji ticks, the
 * trivia-to-phrases handover, and reduced motion holding one pick.
 */
import { describe, expect, it } from 'vitest';
import { PERSONAS, STAGE_ORDER, TARGETS, TRIVIA_FACTS, TRIVIA_FRAMINGS, type PersonaId } from '../../src/lib/thinking-content.js';
import { EMOJI_POOL } from '../../src/lib/emoji-pool.generated.js';
import {
  DWELL_MAX_MS,
  DWELL_MIN_MS,
  RECENT_MEMORY,
  TRIVIA_MAX_WORDS,
  createThinkingSession,
  dwellForText,
  expandEmojiChoices,
  seedFromString,
  stageIndexAt,
  triviaLine,
  type Flavor,
  type ThinkingItem,
  type ThinkingMemory,
  type ThinkingSession,
} from '../../src/lib/thinking-engine.js';

const freshMemory = (): ThinkingMemory => ({ recent: [], lastFlavor: null, lastPersona: null });

const seconds = (text: string) => text.trim().split(/\s+/).length;

/** Every tick, stepping over each item's own dwell time. */
function walk(session: ThinkingSession, steps: number): ThinkingItem[] {
  const items: ThinkingItem[] = [];
  let at = 0;
  for (let i = 0; i < steps; i++) {
    const item = session.at(at);
    items.push(item);
    at += item.dwellMs;
  }
  return items;
}

/** The tags of the line an item rendered, looked up in the authored content. */
function tagsOf(item: ThinkingItem, persona: PersonaId): string[] {
  if (item.kind === 'stage') {
    const pool = PERSONAS[persona].stages[STAGE_ORDER[item.stage!]!]!;
    return pool.find((line) => line.text === item.text)!.tags;
  }
  const rest = item.text.replace(/…$/, '');
  const opener = PERSONAS[persona].openers.find((candidate) => rest.startsWith(`${candidate.text} `))!;
  const target = TARGETS.find((candidate) => candidate.text === rest.slice(opener.text.length + 1))!;
  return [...opener.tags, ...target.tags];
}

/** A session of a wanted flavor, seeded deterministically. */
function sessionOfFlavor(flavor: Flavor, memory = freshMemory()): ThinkingSession {
  for (let seed = 1; seed < 500; seed++) {
    const session = createThinkingSession({ seed: seedFromString(`flavor-${flavor}-${seed}`), memory });
    if (session.flavor === flavor) return session;
  }
  throw new Error(`No ${flavor} session found`);
}

describe('dwellForText', () => {
  it('keeps short lines at a second and long ones bounded', () => {
    expect(dwellForText('a'.repeat(1))).toBe(DWELL_MIN_MS);
    expect(dwellForText('a'.repeat(22))).toBe(DWELL_MIN_MS);
    expect(dwellForText('a'.repeat(30))).toBe(1350);
    expect(dwellForText('a'.repeat(200))).toBe(DWELL_MAX_MS);
  });

  it('never shrinks as text grows', () => {
    let previous = 0;
    for (let length = 1; length <= 200; length++) {
      const dwell = dwellForText('a'.repeat(length));
      expect(dwell).toBeGreaterThanOrEqual(previous);
      previous = dwell;
    }
  });
});

describe('stageIndexAt', () => {
  it('walks the ladder at its thresholds', () => {
    expect(stageIndexAt(0)).toBe(0);
    expect(stageIndexAt(1499)).toBe(0);
    expect(stageIndexAt(1500)).toBe(1);
    expect(stageIndexAt(3999)).toBe(1);
    expect(stageIndexAt(4000)).toBe(2);
    expect(stageIndexAt(7999)).toBe(2);
    expect(stageIndexAt(8000)).toBe(3);
    expect(stageIndexAt(600_000)).toBe(3);
  });
});

describe('expandEmojiChoices', () => {
  it('unions the buckets of the tags, deduplicated', () => {
    const union = expandEmojiChoices(['books', 'detective', 'books']);
    expect(union.length).toBeGreaterThan(0);
    expect(new Set(union).size).toBe(union.length);
    expect(union.length).toBeGreaterThan(expandEmojiChoices(['books']).length);
  });

  it('ignores unknown tags', () => {
    expect(expandEmojiChoices(['nonsense'])).toEqual([]);
  });
});

describe('triviaLine', () => {
  it('prepends a framing of the persona to the fact', () => {
    expect(triviaLine('librarian', 0, 0)).toBe(`${TRIVIA_FRAMINGS.librarian[0]} ${TRIVIA_FACTS[0]}`);
    expect(triviaLine('noir', TRIVIA_FACTS.length, 1)).toBe(`${TRIVIA_FRAMINGS.noir[1]} ${TRIVIA_FACTS[0]}`);
  });
});

describe('a thinking session', () => {
  it('replays identically from the same seed', () => {
    const first = createThinkingSession({ seed: seedFromString('same-seed'), memory: freshMemory() });
    const second = createThinkingSession({ seed: seedFromString('same-seed'), memory: freshMemory() });
    expect(second.flavor).toBe(first.flavor);
    expect(second.persona).toBe(first.persona);
    expect(walk(second, 5)).toEqual(walk(first, 5));
  });

  it('never repeats the flavor or the persona of the previous wait', () => {
    const memory = freshMemory();
    const flavors: Flavor[] = [];
    const personas: PersonaId[] = [];
    for (let i = 0; i < 24; i++) {
      const session = createThinkingSession({ seed: seedFromString(`wait-${i}`), memory });
      flavors.push(session.flavor);
      personas.push(session.persona);
    }
    for (let i = 1; i < flavors.length; i++) {
      expect(flavors[i]).not.toBe(flavors[i - 1]);
      expect(personas[i]).not.toBe(personas[i - 1]);
    }
  });

  it('never shows the same line twice within one wait', () => {
    const steps: Record<Flavor, number> = { phrases: 25, trivia: 10, stages: 8 };
    for (const flavor of ['phrases', 'stages', 'trivia'] as Flavor[]) {
      const items = walk(sessionOfFlavor(flavor), steps[flavor]);
      expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
      expect(new Set(items.map((item) => item.text)).size).toBe(items.length);
    }
  });

  it('holds each line for its own dwell time', () => {
    for (const item of walk(sessionOfFlavor('phrases'), 12)) {
      expect(item.dwellMs).toBe(dwellForText(item.text));
    }
  });

  it('appends emoji only from the line’s own tags, and never on trivia', () => {
    const session = sessionOfFlavor('phrases');
    let sawAppendix = false;
    for (const item of walk(session, 60)) {
      if (item.emoji !== null) {
        sawAppendix = true;
        expect(expandEmojiChoices(tagsOf(item, session.persona))).toContain(item.emoji);
      }
    }
    expect(sawAppendix).toBe(true);
  });

  it('never puts emoji on two ticks in a row', () => {
    const items = walk(sessionOfFlavor('phrases'), 80);
    for (let i = 1; i < items.length; i++) {
      const before = items[i - 1]!.emoji !== null || items[i - 1]!.kind === 'emoji';
      const now = items[i]!.emoji !== null || items[i]!.kind === 'emoji';
      expect(before && now).toBe(false);
    }
  });

  it('drops lone emoji from the full pool now and then, only among phrases', () => {
    const items = walk(sessionOfFlavor('phrases'), 400);
    const lone = items.filter((item) => item.kind === 'emoji');
    expect(lone.length).toBeGreaterThan(0);
    for (const item of lone) expect(EMOJI_POOL).toContain(item.text);
  });

  it('tells trivia within the word limit, framed in the persona’s voice', () => {
    const session = sessionOfFlavor('trivia');
    const items = walk(session, 10);
    for (const item of items) {
      expect(item.kind).toBe('trivia');
      expect(seconds(item.text)).toBeLessThanOrEqual(TRIVIA_MAX_WORDS);
      expect(TRIVIA_FRAMINGS[session.persona].some((framing) => item.text.startsWith(framing))).toBe(true);
      expect(item.emoji).toBeNull();
    }
  });

  it('keeps stage lines inside the stage the clock is in', () => {
    const session = sessionOfFlavor('stages');
    const expected: Array<[number, number]> = [
      [0, 0],
      [1600, 1],
      [4300, 2],
      [9000, 3],
    ];
    for (const [at, stage] of expected) {
      const item = session.at(at);
      expect(item.kind).toBe('stage');
      expect(item.stage).toBe(stage);
      const pool = PERSONAS[session.persona].stages[STAGE_ORDER[stage]!]!;
      expect(pool.some((line) => line.text === item.text)).toBe(true);
    }
  });

  it('hands a trivia wait over to phrasing once the reply streams', () => {
    const session = sessionOfFlavor('trivia');
    expect(session.at(0).kind).toBe('trivia');
    const handed = session.at(1000, { streaming: true });
    expect(handed.kind).toBe('phrase');
    expect(handed.text.endsWith('…')).toBe(true);
    expect(session.at(5000, { streaming: true }).kind).toBe('phrase');
    // The handover is one-way: later calls without the flag stay phrased.
    expect(session.at(9000).kind).toBe('phrase');
  });

  it('holds one pick for the whole wait under reduced motion', () => {
    const session = createThinkingSession({ seed: seedFromString('calm'), reducedMotion: true, memory: freshMemory() });
    const held = session.at(0);
    expect(session.at(30_000).key).toBe(held.key);
    expect(session.at(30_000, { streaming: true }).key).toBe(held.key);
  });

  it('avoids the lines rendered by the last few waits', () => {
    const memory = freshMemory();
    const seed = seedFromString('recent-lines');
    const before = createThinkingSession({ seed, memory });
    const shown = walk(before, 10).filter((item) => item.kind !== 'emoji');
    expect(memory.recent.length).toBeGreaterThan(0);
    expect(memory.recent.length).toBeLessThanOrEqual(RECENT_MEMORY);
    expect(new Set(memory.recent).size).toBe(memory.recent.length);

    const recent = new Set(memory.recent);
    const after = createThinkingSession({ seed, memory: { ...memory, lastFlavor: null, lastPersona: null } });
    const next = walk(after, 5).filter((item) => item.kind !== 'emoji');
    for (const item of next) expect(recent.has(item.key)).toBe(false);
    expect(shown.length).toBeGreaterThan(0);
  });
});
