/**
 * The thinking engine: what the chat bubble "thinks" while the reply is on
 * its way. Pure and seeded — the same seed always replays the same wait, so
 * tests and demos can rewind time at will.
 *
 * One session is one wait, and one wait belongs to exactly one flavor
 * (stages, phrases or trivia) and one persona, picked so neither repeats the
 * previous wait. Every tick picks a line, rolls for an appended emoji
 * (matched through the line's tags), and holds it for a dwell time that
 * grows with the text — never twice the same line within a wait, never a
 * repeat of the last few lines across waits.
 */
import type { PersonaId } from './thinking-content.js';
import { EMOJI_BUCKETS, PERSONAS, STAGE_ORDER, TARGETS, TRIVIA_FACTS, TRIVIA_FRAMINGS } from './thinking-content.js';
import { EMOJI_POOL } from './emoji-pool.generated.js';

export type Flavor = 'stages' | 'phrases' | 'trivia';
export type ThinkingKind = 'phrase' | 'stage' | 'trivia' | 'emoji';

export interface ThinkingItem {
  kind: ThinkingKind;
  /** Unique per rendered line; also the React key for the swap animation. */
  key: string;
  text: string;
  /** Emoji shown after the text; never on trivia. */
  emoji: string | null;
  /** Current ladder step for stage lines, else null. */
  stage: number | null;
  dwellMs: number;
}

/** What one wait remembers for the next ones; session-only, no storage. */
export interface ThinkingMemory {
  recent: string[];
  lastFlavor: Flavor | null;
  lastPersona: PersonaId | null;
}

export const thinkingMemory: ThinkingMemory = { recent: [], lastFlavor: null, lastPersona: null };

export const FLAVORS: Flavor[] = ['stages', 'phrases', 'trivia'];
export const PERSONA_IDS: PersonaId[] = ['librarian', 'noir', 'grad'];

export const DWELL_PER_CHAR_MS = 45;
export const DWELL_MIN_MS = 1000;
export const DWELL_MAX_MS = 6000;
/** When each ladder step begins: reading, searching, composing, still going. */
export const STAGE_THRESHOLDS = [0, 1500, 4000, 8000];
export const APPENDIX_CHANCE = 1 / 3;
export const LONE_EMOJI_CHANCE = 1 / 20;
export const RECENT_MEMORY = 15;
export const TRIVIA_MAX_WORDS = 20;

/** The longer the line, the longer it stays — bounded for sanity. */
export function dwellForText(text: string): number {
  return Math.min(DWELL_MAX_MS, Math.max(DWELL_MIN_MS, Math.round(text.length * DWELL_PER_CHAR_MS)));
}

/** The ladder step elapsed time falls in: 0 reading … 3 still going. */
export function stageIndexAt(elapsedMs: number): number {
  let index = 0;
  for (let i = 0; i < STAGE_THRESHOLDS.length; i++) {
    if (elapsedMs >= STAGE_THRESHOLDS[i]!) index = i;
  }
  return index;
}

/** Every emoji the line's tags allow, deduplicated. */
export function expandEmojiChoices(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    for (const emoji of EMOJI_BUCKETS[tag] ?? []) seen.add(emoji);
  }
  return [...seen];
}

/** One trivia line: the persona's framing in front of the fact. */
export function triviaLine(persona: PersonaId, factIndex: number, framingIndex: number): string {
  const framing = TRIVIA_FRAMINGS[persona][framingIndex % TRIVIA_FRAMINGS[persona].length]!;
  const fact = TRIVIA_FACTS[factIndex % TRIVIA_FACTS.length]!;
  return `${framing} ${fact}`;
}

/** A stable 32-bit seed from a message id (xmur3). */
export function seedFromString(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number): () => number {
  // Scramble the seed first (splitmix32 finish): nearby seeds must not
  // produce nearby sequences.
  let a = seed >>> 0;
  a = (a + 0x9e3779b9) | 0;
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  a = (a ^ (a >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickAvoiding<T>(pool: T[], previous: T | null, rand: () => number): T {
  const choices = previous === null ? pool : pool.filter((value) => value !== previous);
  return choices[Math.floor(rand() * choices.length)] ?? pool[0]!;
}

function remember(memory: ThinkingMemory, key: string): void {
  memory.recent.push(key);
  if (memory.recent.length > RECENT_MEMORY) memory.recent.shift();
}

interface Chain {
  kind: 'phrases' | 'stages' | 'trivia';
  used: Set<string>;
  current: ThinkingItem | null;
  dueAt: number;
  lastEmoji: boolean;
}

export interface ThinkingSession {
  flavor: Flavor;
  persona: PersonaId;
  /**
   * The item to show at `elapsedMs` since the message was sent. Calling it
   * again with an earlier time returns what was showing then.
   */
  at(elapsedMs: number, options?: { streaming?: boolean }): ThinkingItem;
}

export function createThinkingSession(options: {
  seed: number;
  reducedMotion?: boolean;
  memory?: ThinkingMemory;
}): ThinkingSession {
  const { seed, reducedMotion = false, memory = thinkingMemory } = options;
  const rand = mulberry32(seed);
  const flavor = pickAvoiding(FLAVORS, memory.lastFlavor, rand);
  const persona = pickAvoiding(PERSONA_IDS, memory.lastPersona, rand);
  memory.lastFlavor = flavor;
  memory.lastPersona = persona;

  const content = PERSONAS[persona];
  let chain: Chain = { kind: flavor, used: new Set(), current: null, dueAt: 0, lastEmoji: false };
  let handedOver = false;
  let held: ThinkingItem | null = null;

  const chooseTagEmoji = (openerTags: string[], targetTags: string[]): string => {
    // The line's subject leads; the opening phrase gets its say too.
    const [primary, secondary] = [expandEmojiChoices(targetTags), expandEmojiChoices(openerTags)];
    const pool = rand() < 2 / 3 ? primary : secondary;
    const fallback = pool.length > 0 ? pool : primary.length > 0 ? primary : secondary;
    return fallback[Math.floor(rand() * fallback.length)] ?? EMOJI_POOL[0]!;
  };

  /** Whether an attempt may settle on this key: recent keys lose priority first. */
  const eligible = (attempt: number, key: string): boolean =>
    (attempt > 40 || !memory.recent.includes(key)) && (attempt > 200 || !chain.used.has(key));

  /** One pick from `max` options, its key given by `keyOf`, never a repeat. */
  const pickIndex = (max: number, keyOf: (index: number) => string): { index: number; key: string } => {
    for (let attempt = 0; ; attempt++) {
      const index = Math.floor(rand() * max);
      const key = keyOf(index);
      if (eligible(attempt, key)) {
        chain.used.add(key);
        return { index, key };
      }
    }
  };

  const pickPhrasePair = (): { openerIndex: number; targetIndex: number; key: string } => {
    for (let attempt = 0; ; attempt++) {
      const openerIndex = Math.floor(rand() * content.openers.length);
      const targetIndex = Math.floor(rand() * TARGETS.length);
      const key = `p:${persona}:${openerIndex}:${targetIndex}`;
      if (eligible(attempt, key)) {
        chain.used.add(key);
        return { openerIndex, targetIndex, key };
      }
    }
  };

  const pickPhrase = (): ThinkingItem => {
    if (!chain.lastEmoji && rand() < LONE_EMOJI_CHANCE) {
      let glyph = EMOJI_POOL[Math.floor(rand() * EMOJI_POOL.length)]!;
      for (let attempt = 0; attempt < 8 && chain.used.has(`e:${glyph}`); attempt++) {
        glyph = EMOJI_POOL[Math.floor(rand() * EMOJI_POOL.length)]!;
      }
      chain.used.add(`e:${glyph}`);
      chain.lastEmoji = true;
      return { kind: 'emoji', key: `e:${glyph}`, text: glyph, emoji: null, stage: null, dwellMs: DWELL_MIN_MS };
    }

    const { openerIndex, targetIndex, key } = pickPhrasePair();
    remember(memory, key);

    const opener = content.openers[openerIndex]!;
    const target = TARGETS[targetIndex]!;
    const text = `${opener.text} ${target.text}…`;
    let emoji: string | null = null;
    if (!chain.lastEmoji && rand() < APPENDIX_CHANCE) emoji = chooseTagEmoji(opener.tags, target.tags);
    chain.lastEmoji = emoji !== null;
    return { kind: 'phrase', key, text, emoji, stage: null, dwellMs: dwellForText(text) };
  };

  const pickStage = (elapsedMs: number): ThinkingItem => {
    const stage = stageIndexAt(elapsedMs);
    const pool = content.stages[STAGE_ORDER[stage]!]!;
    const { index, key } = pickIndex(pool.length, (i) => `s:${stage}:${persona}:${i}`);
    remember(memory, key);
    const line = pool[index]!;
    let emoji: string | null = null;
    if (!chain.lastEmoji && rand() < APPENDIX_CHANCE) emoji = chooseTagEmoji(line.tags, line.tags);
    chain.lastEmoji = emoji !== null;
    return { kind: 'stage', key, text: line.text, emoji, stage, dwellMs: dwellForText(line.text) };
  };

  const pickTrivia = (): ThinkingItem => {
    const framed = TRIVIA_FACTS.length * TRIVIA_FRAMINGS[persona].length;
    const { index, key } = pickIndex(framed, (i) => `t:${persona}:${i}`);
    remember(memory, key);
    chain.lastEmoji = false;
    const text = triviaLine(persona, index % TRIVIA_FACTS.length, Math.floor(index / TRIVIA_FACTS.length));
    return { kind: 'trivia', key, text, emoji: null, stage: null, dwellMs: dwellForText(text) };
  };

  const generate = (elapsedMs: number): ThinkingItem => {
    if (chain.kind === 'phrases') return pickPhrase();
    if (chain.kind === 'stages') return pickStage(elapsedMs);
    return pickTrivia();
  };

  return {
    flavor,
    persona,
    at(elapsedMs, { streaming = false } = {}) {
      if (reducedMotion) {
        held ??= generate(0);
        return held;
      }
      if (flavor === 'trivia' && !handedOver && streaming) {
        // Trivia is for the empty bubble; once the reply starts, it walks.
        handedOver = true;
        chain = { kind: 'phrases', used: chain.used, current: null, dueAt: Math.max(0, elapsedMs), lastEmoji: false };
      }
      const t = Math.max(0, elapsedMs);
      let guard = 0;
      while (chain.dueAt <= t && guard++ < 1000) {
        chain.current = generate(t);
        chain.dueAt += chain.current.dwellMs;
      }
      return chain.current ?? generate(0);
    },
  };
}
