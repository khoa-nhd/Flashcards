/**
 * PvP word duels (docs/gamification-plan.md, phase 5). Pure: the server is the
 * referee and runs these rules; the browser only shows what it is told.
 *
 * Two players answer the same sequence of four-option questions, each at
 * their own pace. A right answer hurts the other side, a fast one hurts more;
 * a wrong one locks the player out for a moment. Two minutes at most.
 */
import { botNickname } from './gamification/nickname.js';
import { seededRandom } from './gamification/quests.js';
import { COMMON_WORDS } from './pvp-words.js';

export const PVP = {
  hp: 100,
  hit: 10,
  /** A right answer within this long of the question showing is a critical hit. */
  critMs: 3000,
  crit: 15,
  /** A wrong answer locks the player out for this long. */
  lockMs: 3000,
  durationMs: 120_000,
  questions: 40,
  /** A player not heard from for this long has left the match, and loses it. */
  goneMs: 15_000,
  /** Waiting this long for an opponent brings a rival instead. */
  botAfterMs: 10_000,
  /** A friend has this long to accept an invitation. */
  inviteMs: 60_000,
  /** Leaving this many matches in a day locks matchmaking for a while. */
  abandonLimit: 3,
  abandonLockMs: 5 * 60_000,
} as const;

// ---- Rating (5.4) ----

export const RATING_START = 1000;
export const ELO_K = 32;

/** A player's new rating after a match: `score` is 1 for a win, 0.5 for a draw, 0 for a loss. */
export function elo(rating: number, opponent: number, score: 0 | 0.5 | 1): number {
  const expected = 1 / (1 + 10 ** ((opponent - rating) / 400));
  return Math.round(rating + ELO_K * (score - expected));
}

/** A rating carried into a new monthly season: halfway back to the start. */
export const seasonCarry = (rating: number) => Math.round(RATING_START + (rating - RATING_START) / 2);

export const seasonOf = (at: string | Date) => new Date(at).toISOString().slice(0, 7);

/** The league tier a rating sits in, 1 (Bronze) to 8 (Star). */
export function ratingTier(rating: number): number {
  const steps = [900, 1050, 1200, 1350, 1500, 1650, 1800];
  return 1 + steps.filter((step) => rating >= step).length;
}

/** Stardust at the end of a season for the tier reached. */
export const seasonStardust = (tier: number) => tier * 60;

// ---- Rewards (5.4) ----

export const PVP_XP = { perAnswer: 5, win: 30, halfAfterMatches: 20 } as const;
export const PVP_STARDUST = { win: 20, draw: 10 } as const;

/**
 * What a finished match gives, beyond the answers on one's own words (those
 * are practice, and earn as practice does): 5 XP for each answer on the other
 * side's words, 30 more for a win; from the 21st match of the day, half.
 */
export function matchReward(otherWordAnswers: number, result: 'won' | 'lost' | 'draw', matchesToday: number): { xp: number; stardust: number } {
  const base = otherWordAnswers * PVP_XP.perAnswer + (result === 'won' ? PVP_XP.win : 0);
  const xp = matchesToday > PVP_XP.halfAfterMatches ? Math.floor(base / 2) : base;
  const stardust = result === 'won' ? PVP_STARDUST.win : result === 'draw' ? PVP_STARDUST.draw : 0;
  return { xp, stardust };
}

// ---- Companions in battle (5.3) ----

export type BattleSkill = 'damage' | 'lock' | 'crit' | 'shield' | 'heal';

/** The skill the leading companion brings to a match; only the first one leads into battle. */
export const BATTLE_SKILL: Record<string, BattleSkill> = {
  pet_owl: 'damage',
  pet_dragon: 'damage',
  pet_rabbit: 'lock',
  pet_fox: 'crit',
  pet_cat: 'shield',
  pet_whale: 'heal',
};

/** What each skill does. Each is worth about a fifth of a match at most. */
export const SKILL = {
  /** Extra damage on every right answer. */
  damage: 2,
  /** The lock after a wrong answer is this much shorter. */
  lockMs: 1000,
  /** The critical window is this much longer. */
  critMs: 1000,
  /** Once, below this health, this much comes back. */
  healBelow: 40,
  heal: 20,
} as const;

// ---- Questions (5.2) ----

export interface PoolWord {
  word: string;
  meaning: string;
  /** Whose word it is: a player's id, or `common`. */
  owner: string;
  /** The word's id in its owner's vocabulary, where it has one. */
  vocabularyId: string | null;
  pos?: string;
}

export interface Question {
  index: number;
  direction: 'en-vi' | 'vi-en';
  prompt: string;
  options: string[];
  answer: number;
  owner: string;
  vocabularyId: string | null;
  word: string;
  meaning: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let at = out.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [out[at], out[other]] = [out[other]!, out[at]!];
  }
  return out;
}

/**
 * The match's questions: half from each player's words, in turn, each asked
 * English to Vietnamese or the other way at random, with three wrong options
 * of the same kind of word where that is known, and never a second right one.
 */
export function buildQuestions(seed: string, pools: [readonly PoolWord[], readonly PoolWord[]], count: number = PVP.questions): Question[] {
  const random = seededRandom(`pvp:${seed}`);
  const common: PoolWord[] = COMMON_WORDS.map((each) => ({ word: each.word, meaning: each.meaning, owner: 'common', vocabularyId: null, pos: each.pos }));
  const sides = pools.map((pool) => (pool.length > 0 ? shuffle(pool, random) : shuffle(common, random)));
  const everything = [...pools[0], ...pools[1], ...common];
  const questions: Question[] = [];
  for (let index = 0; index < count; index += 1) {
    const side = sides[index % 2]!;
    const word = side[Math.floor(index / 2) % side.length]!;
    const direction = random() < 0.5 ? 'en-vi' : 'vi-en';
    const shown = (entry: PoolWord) => (direction === 'en-vi' ? entry.meaning : entry.word);
    const right = shown(word);
    const candidates = everything.filter((entry) => !same(entry.word, word.word) && !same(entry.meaning, word.meaning) && !same(shown(entry), right));
    const alike = word.pos === undefined ? [] : candidates.filter((entry) => entry.pos === word.pos);
    const wrong: string[] = [];
    for (const entry of [...shuffle(alike, random), ...shuffle(candidates, random)]) {
      if (wrong.length === 3) break;
      if (!wrong.some((each) => same(each, shown(entry)))) wrong.push(shown(entry));
    }
    const options = shuffle([right, ...wrong], random);
    questions.push({
      index,
      direction,
      prompt: direction === 'en-vi' ? word.word : word.meaning,
      options,
      answer: options.indexOf(right),
      owner: word.owner,
      vocabularyId: word.vocabularyId,
      word: word.word,
      meaning: word.meaning,
    });
  }
  return questions;
}

// ---- The match (5.3) ----

export type Side = 'a' | 'b';

export interface PlayerState {
  hp: number;
  /** The question this player is on. */
  at: number;
  /** When the current question showed (after any lock). */
  shownAt: number;
  lockedUntil: number;
  lastSeen: number;
  correct: number;
  wrong: number;
  /** Answers on words that are not this player's own: they earn XP in the match's reward, not as practice. */
  away: number;
  /** The shield is used, the heal is used. */
  shieldUsed: boolean;
  healUsed: boolean;
  skill: BattleSkill | null;
}

export interface MatchState {
  startedAt: number;
  endsAt: number;
  a: PlayerState;
  b: PlayerState;
  finished: boolean;
  /** `draw` for a draw; set once finished. */
  winner: Side | 'draw' | null;
  /** How it ended. */
  reason: 'hp' | 'time' | 'left' | null;
}

const other = (side: Side): Side => (side === 'a' ? 'b' : 'a');

export function startMatch(now: number, skills: [BattleSkill | null, BattleSkill | null]): MatchState {
  const player = (skill: BattleSkill | null): PlayerState => ({
    hp: PVP.hp,
    at: 0,
    shownAt: now,
    lockedUntil: 0,
    lastSeen: now,
    correct: 0,
    wrong: 0,
    away: 0,
    shieldUsed: false,
    healUsed: false,
    skill,
  });
  return { startedAt: now, endsAt: now + PVP.durationMs, a: player(skills[0]), b: player(skills[1]), finished: false, winner: null, reason: null };
}

export type AnswerOutcome =
  | { kind: 'scored'; correct: boolean; crit: boolean; damage: number; state: MatchState }
  | { kind: 'locked'; until: number }
  | { kind: 'stale' }
  | { kind: 'over' };

/** One answer, judged against the question's right option. */
export function answer(state: MatchState, side: Side, index: number, correct: boolean, now: number): AnswerOutcome {
  const settled = settle(state, now);
  if (settled.finished) return { kind: 'over' };
  const me = { ...settled[side] };
  const them = { ...settled[other(side)] };
  if (index !== me.at) return { kind: 'stale' };
  if (now < me.lockedUntil) return { kind: 'locked', until: me.lockedUntil };
  me.lastSeen = now;
  let damage = 0;
  let crit = false;
  if (correct) {
    const window = PVP.critMs + (me.skill === 'crit' ? SKILL.critMs : 0);
    crit = now - me.shownAt <= window;
    damage = (crit ? PVP.crit : PVP.hit) + (me.skill === 'damage' ? SKILL.damage : 0);
    if (them.skill === 'shield' && !them.shieldUsed) {
      them.shieldUsed = true;
      damage = 0;
    }
    them.hp = Math.max(0, them.hp - damage);
    if (them.skill === 'heal' && !them.healUsed && them.hp > 0 && them.hp <= SKILL.healBelow) {
      them.healUsed = true;
      them.hp = Math.min(PVP.hp, them.hp + SKILL.heal);
    }
    me.correct += 1;
    me.shownAt = now;
  } else {
    me.wrong += 1;
    me.lockedUntil = now + PVP.lockMs - (me.skill === 'lock' ? SKILL.lockMs : 0);
    me.shownAt = me.lockedUntil;
  }
  me.at += 1;
  const next: MatchState = { ...settled, [side]: me, [other(side)]: them };
  return { kind: 'scored', correct, crit, damage, state: settle(next, now) };
}

/** Marks a player as present. */
export function seen(state: MatchState, side: Side, now: number): MatchState {
  return settle({ ...state, [side]: { ...state[side], lastSeen: now } }, now);
}

/** Ends the match if it is over: no health left, time up, or a player gone too long (or given up). */
export function settle(state: MatchState, now: number, leaving: Side | null = null): MatchState {
  if (state.finished) return state;
  const end = (winner: Side | 'draw', reason: MatchState['reason']): MatchState => ({ ...state, finished: true, winner, reason });
  if (leaving !== null) return end(other(leaving), 'left');
  if (state.a.hp <= 0 && state.b.hp <= 0) return end('draw', 'hp');
  if (state.a.hp <= 0) return end('b', 'hp');
  if (state.b.hp <= 0) return end('a', 'hp');
  const goneA = now - state.a.lastSeen > PVP.goneMs;
  const goneB = now - state.b.lastSeen > PVP.goneMs;
  if (goneA !== goneB) return end(goneA ? 'b' : 'a', 'left');
  if (now >= state.endsAt) return end(state.a.hp === state.b.hp ? 'draw' : state.a.hp > state.b.hp ? 'a' : 'b', 'time');
  return state;
}

// ---- Rivals (5.1, 5.5) ----

export interface Rival {
  nickname: string;
  rating: number;
  /** How often it answers right, and how long it takes, on average. */
  accuracy: number;
  paceMs: number;
  skill: BattleSkill | null;
  /** Its answers: when (ms after the start) and whether right. */
  plan: Array<{ at: number; correct: boolean }>;
}

/** A rival for a player of `rating`, the same for the same match. Its words are everyday ones. */
export function rivalFor(matchId: string, rating: number): Rival {
  const random = seededRandom(`pvp-rival:${matchId}`);
  const own = Math.round(rating + (random() - 0.5) * 120);
  const tier = ratingTier(own);
  const accuracy = Math.min(0.9, 0.55 + tier * 0.04 + (random() - 0.5) * 0.1);
  const paceMs = Math.max(1800, 6200 - tier * 450 + (random() - 0.5) * 800);
  const skills: Array<BattleSkill | null> = [null, 'damage', 'lock', 'crit', 'shield', 'heal'];
  const skill = tier >= 3 ? skills[Math.floor(random() * skills.length)]! : null;
  const plan: Rival['plan'] = [];
  let at = 0;
  for (let index = 0; index < PVP.questions; index += 1) {
    at += Math.round(paceMs * (0.55 + random() * 0.9));
    const correct = random() < accuracy;
    plan.push({ at, correct });
    if (!correct) at += PVP.lockMs - (skill === 'lock' ? SKILL.lockMs : 0);
  }
  return { nickname: botNickname(`pvp:${matchId}`), rating: own, accuracy, paceMs, skill, plan };
}

/** Plays a rival's answers that are due by `now`. The rival is always side `b`. */
export function playRival(state: MatchState, rival: Rival, now: number): MatchState {
  let current = { ...state, b: { ...state.b, lastSeen: now } };
  for (let index = current.b.at; index < rival.plan.length && !current.finished; index += 1) {
    const move = rival.plan[index]!;
    const when = current.startedAt + move.at;
    if (when > now) break;
    const outcome = answer(current, 'b', index, move.correct, Math.max(when, current.b.lockedUntil));
    if (outcome.kind !== 'scored') break;
    current = { ...outcome.state, b: { ...outcome.state.b, lastSeen: now } };
  }
  return settle(current, now);
}

/** How far the matchmaker looks for an opponent: wider the longer one waits. */
export const ratingWindow = (waitedMs: number) => 100 + Math.floor(waitedMs / 1000) * 20;
