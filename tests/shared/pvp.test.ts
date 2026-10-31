import { describe, expect, it } from 'vitest';
import {
  PVP,
  SKILL,
  answer,
  buildQuestions,
  elo,
  matchReward,
  playRival,
  ratingTier,
  rivalFor,
  seasonCarry,
  settle,
  startMatch,
  type PoolWord,
} from '../../shared/pvp.js';

const pool = (owner: string, count: number): PoolWord[] =>
  Array.from({ length: count }, (_, at) => ({ word: `${owner}word${at}`, meaning: `${owner} nghĩa ${at}`, owner, vocabularyId: `${owner}-${at}` }));

describe('questions', () => {
  const questions = buildQuestions('m1', [pool('a', 10), pool('b', 10)]);

  it('come half from each side, with four different options and one right one', () => {
    expect(questions).toHaveLength(PVP.questions);
    expect(questions.filter((q) => q.owner === 'a')).toHaveLength(PVP.questions / 2);
    for (const q of questions) {
      expect(new Set(q.options.map((option) => option.toLowerCase())).size).toBe(4);
      const right = q.direction === 'en-vi' ? q.meaning : q.word;
      expect(q.options[q.answer]).toBe(right);
      expect(q.prompt).toBe(q.direction === 'en-vi' ? q.word : q.meaning);
    }
    expect(new Set(questions.map((q) => q.direction)).size).toBe(2);
  });

  it('are the same for the same match', () => {
    expect(buildQuestions('m1', [pool('a', 10), pool('b', 10)])).toEqual(questions);
  });

  it('use everyday words where a side has none', () => {
    const rival = buildQuestions('m2', [pool('a', 5), []]);
    expect(rival.filter((q) => q.owner === 'common')).toHaveLength(PVP.questions / 2);
  });
});

describe('answers', () => {
  const start = () => startMatch(0, [null, null]);

  it('hurt by 10, by 15 within three seconds, and lock for three seconds when wrong', () => {
    const fast = answer(start(), 'a', 0, true, 2000);
    expect(fast).toMatchObject({ kind: 'scored', crit: true, damage: PVP.crit });
    const slow = answer(start(), 'a', 0, true, 5000);
    expect(slow).toMatchObject({ kind: 'scored', crit: false, damage: PVP.hit });
    const wrong = answer(start(), 'a', 0, false, 1000);
    if (wrong.kind !== 'scored') throw new Error('expected an answer');
    expect(wrong.state.a.lockedUntil).toBe(1000 + PVP.lockMs);
    expect(answer(wrong.state, 'a', 1, true, 2000)).toEqual({ kind: 'locked', until: 1000 + PVP.lockMs });
    expect(answer(wrong.state, 'a', 1, true, 4100)).toMatchObject({ kind: 'scored', crit: true });
  });

  it('refuse an answer to a question that is not the one on screen', () => {
    expect(answer(start(), 'a', 3, true, 1000)).toEqual({ kind: 'stale' });
  });

  it('give each companion its skill: more damage, a shorter lock, a longer window, a shield, a heal', () => {
    const damage = answer(startMatch(0, ['damage', null]), 'a', 0, true, 5000);
    expect(damage).toMatchObject({ damage: PVP.hit + SKILL.damage });
    const lock = answer(startMatch(0, ['lock', null]), 'a', 0, false, 0);
    if (lock.kind !== 'scored') throw new Error('expected an answer');
    expect(lock.state.a.lockedUntil).toBe(PVP.lockMs - SKILL.lockMs);
    expect(answer(startMatch(0, ['crit', null]), 'a', 0, true, 3800)).toMatchObject({ crit: true });
    const shield = answer(startMatch(0, [null, 'shield']), 'a', 0, true, 5000);
    expect(shield).toMatchObject({ damage: 0 });
    let healed = startMatch(0, [null, 'heal']);
    for (let index = 0; index < 4; index += 1) {
      const step = answer(healed, 'a', index, true, 1000 * (index + 1));
      if (step.kind !== 'scored') throw new Error('expected an answer');
      healed = step.state;
    }
    // Four fast hits take it to 40: the heal brings it back to 60, once.
    expect(healed.b.hp).toBe(100 - 4 * PVP.crit + SKILL.heal);
  });
});

describe('the end', () => {
  it('comes when health runs out, when time is up, or when a player has gone', () => {
    const zero = { ...startMatch(0, [null, null]) };
    zero.b = { ...zero.b, hp: 0 };
    expect(settle(zero, 10)).toMatchObject({ finished: true, winner: 'a', reason: 'hp' });
    const timed = startMatch(0, [null, null]);
    expect(settle({ ...timed, a: { ...timed.a, hp: 80 }, b: { ...timed.b, hp: 60 } }, PVP.durationMs)).toMatchObject({ winner: 'a', reason: 'time' });
    expect(settle({ ...timed, a: { ...timed.a, lastSeen: PVP.durationMs - 1 }, b: { ...timed.b, lastSeen: PVP.durationMs - 1 } }, PVP.durationMs)).toMatchObject({ winner: 'draw' });
    // Player a has not been heard from for longer than 15 seconds; player b just now.
    const late = PVP.goneMs + 5000;
    expect(settle({ ...timed, b: { ...timed.b, lastSeen: late - 1000 } }, late)).toMatchObject({ winner: 'b', reason: 'left' });
    // Both quiet is no one leaving: the match runs on.
    expect(settle(timed, late)).toMatchObject({ finished: false });
    expect(settle(timed, 1000, 'a')).toMatchObject({ winner: 'b', reason: 'left' });
  });
});

describe('ratings and rewards', () => {
  it('follow Elo with K = 32, and carry halfway back each season', () => {
    expect(elo(1000, 1000, 1)).toBe(1016);
    expect(elo(1000, 1000, 0)).toBe(984);
    expect(elo(1000, 1000, 0.5)).toBe(1000);
    expect(elo(1400, 1000, 1)).toBeLessThan(1404);
    expect(seasonCarry(1400)).toBe(1200);
    expect(ratingTier(899)).toBe(1);
    expect(ratingTier(1000)).toBe(2);
    expect(ratingTier(1900)).toBe(8);
  });

  it('give 5 XP for each answer on the other side’s words, 30 for a win, half from the 21st match', () => {
    expect(matchReward(6, 'won', 3)).toEqual({ xp: 60, stardust: 20 });
    expect(matchReward(6, 'lost', 3)).toEqual({ xp: 30, stardust: 0 });
    expect(matchReward(6, 'won', 21)).toEqual({ xp: 30, stardust: 20 });
  });
});

describe('rivals', () => {
  it('are the same for the same match, and play only what is due', () => {
    expect(rivalFor('m1', 1000)).toEqual(rivalFor('m1', 1000));
    const rival = rivalFor('m1', 1000);
    let state = startMatch(0, [null, rival.skill]);
    let last = 0;
    for (let at = 0; at <= PVP.durationMs; at += 1000) {
      state = playRival({ ...state, a: { ...state.a, lastSeen: at } }, rival, at);
      expect(state.b.at).toBeGreaterThanOrEqual(last);
      last = state.b.at;
    }
    expect(last).toBeGreaterThan(5);
  });

  it('get better in higher tiers', () => {
    const low = rivalFor('m1', 850);
    const high = rivalFor('m1', 1850);
    expect(high.accuracy).toBeGreaterThan(low.accuracy);
    expect(high.paceMs).toBeLessThan(low.paceMs);
  });
});
