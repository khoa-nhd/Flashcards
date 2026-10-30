import { describe, expect, it } from 'vitest';
import { isBlocked } from '../../shared/gamification/blocklist.js';
import { INITIAL_STATE, sync, type GameSnapshot, type SyncContext } from '../../shared/gamification/engine.js';
import {
  GROUP_SIZE,
  botFor,
  botXp,
  groupBots,
  leagueWeekOf,
  outcomeOf,
  rankStandings,
  settleGroup,
  weekEndsAt,
  weekStartsAt,
} from '../../shared/gamification/league.js';
import { nicknameProblem, randomNickname } from '../../shared/gamification/nickname.js';
import { RATE_LIMIT, type AnswerEvent } from '../../shared/gamification/xp.js';

const WEEK = '2026-10-26';

describe('league weeks', () => {
  it('run from Monday 00:00 to Sunday 24:00 in Vietnam, whatever the zone of the server', () => {
    expect(leagueWeekOf('2026-11-01T16:59:00Z')).toBe(WEEK); // Sunday 23:59 in Vietnam
    expect(leagueWeekOf('2026-11-01T17:00:00Z')).toBe('2026-11-02'); // Monday 00:00
    expect(weekStartsAt(WEEK)).toBe('2026-10-25T17:00:00.000Z');
    expect(weekEndsAt(WEEK)).toBe('2026-11-01T17:00:00.000Z');
  });
});

describe('rivals', () => {
  it('are the same for the same group and seat, and differ between groups', () => {
    expect(botFor('group-a', 3, 4)).toEqual(botFor('group-a', 3, 4));
    expect(botFor('group-a', 3, 4).nickname).not.toBe(botFor('group-b', 3, 4).nickname);
  });

  it('only ever gain XP as the week goes on, and stop at the week’s end', () => {
    for (let seat = 0; seat < GROUP_SIZE; seat += 1) {
      const bot = botFor('group-a', 2, seat);
      let last = 0;
      for (let hour = 0; hour <= 7 * 24 + 5; hour += 1) {
        const xp = botXp(bot, WEEK, new Date(Date.parse(weekStartsAt(WEEK)) + hour * 3_600_000));
        expect(xp).toBeGreaterThanOrEqual(last);
        last = xp;
      }
      expect(last).toBe(botXp(bot, WEEK, weekEndsAt(WEEK)));
      expect(Math.abs(last - bot.target)).toBeLessThanOrEqual(1);
    }
    expect(botXp(botFor('group-a', 2, 0), WEEK, '2026-10-20T00:00:00Z')).toBe(0);
  });

  it('earn more in higher tiers', () => {
    const total = (tier: number) => groupBots('group-a', tier, 0).reduce((sum, bot) => sum + bot.target, 0);
    expect(total(8)).toBeGreaterThan(total(4));
    expect(total(4)).toBeGreaterThan(total(1));
  });

  it('fill every seat no real person holds; the one with the smallest week leaves when someone joins', () => {
    const nineteen = groupBots('group-a', 1, 1);
    const eighteen = groupBots('group-a', 1, 2);
    expect(nineteen).toHaveLength(19);
    expect(eighteen).toHaveLength(18);
    const left = nineteen.filter((bot) => !eighteen.some((kept) => kept.seat === bot.seat));
    expect(left).toHaveLength(1);
    expect(left[0]!.target).toBe(Math.min(...nineteen.map((bot) => bot.target)));
    expect(groupBots('group-a', 1, 25)).toEqual([]);
  });
});

describe('ranking and settling', () => {
  it('ranks by XP, then by who joined first', () => {
    const ranked = rankStandings([
      { id: 'late', xp: 50, joinedAt: '2026-10-27T00:00:00Z' },
      { id: 'early', xp: 50, joinedAt: '2026-10-26T00:00:00Z' },
      { id: 'top', xp: 90, joinedAt: '2026-10-28T00:00:00Z' },
    ]);
    expect(ranked.map((each) => [each.id, each.rank])).toEqual([
      ['top', 1],
      ['early', 2],
      ['late', 3],
    ]);
  });

  it('moves the top five up and the bottom five down, but never Bronze down, Star up, or anyone with no XP', () => {
    expect(outcomeOf(5, 20, 3, 10)).toBe('up');
    expect(outcomeOf(6, 20, 3, 10)).toBe('stay');
    expect(outcomeOf(16, 20, 3, 10)).toBe('down');
    expect(outcomeOf(20, 20, 1, 10)).toBe('stay');
    expect(outcomeOf(1, 20, 8, 10)).toBe('stay');
    expect(outcomeOf(18, 20, 3, 0)).toBe('stay');
  });

  it('settles a group with its rivals counted at the week’s end', () => {
    const group = {
      id: 'group-a',
      tier: 2,
      createdAt: '2026-10-26T01:00:00Z',
      members: [
        { user: 'grinder', xp: 100_000, joinedAt: '2026-10-26T02:00:00Z' },
        { user: 'idle', xp: 1, joinedAt: '2026-10-26T03:00:00Z' },
      ],
    };
    const [top, bottom] = settleGroup(group, WEEK);
    expect(top).toMatchObject({
      user: 'grinder',
      rank: 1,
      outcome: 'up',
      tier: 3,
    });
    expect(bottom).toMatchObject({
      user: 'idle',
      rank: 20,
      outcome: 'down',
      tier: 1,
    });
    expect(bottom!.reward).toEqual({
      week: WEEK,
      from: 2,
      tier: 1,
      rank: 20,
      outcome: 'down',
    });
    expect(settleGroup(group, WEEK)).toEqual([top, bottom]);
  });
});

describe('nicknames', () => {
  it('are 3 to 20 letters, digits, spaces or underscores', () => {
    expect(nicknameProblem('Cú Đêm 4821')).toBeNull();
    expect(nicknameProblem('ab')).toBe('length');
    expect(nicknameProblem('a'.repeat(21))).toBe('length');
    expect(nicknameProblem('<b>hi</b>')).toBe('characters');
    expect(nicknameProblem('moon_owl')).toBeNull();
  });

  it('catch swear words with accents dropped and letters repeated, but not innocent words', () => {
    for (const name of ['Fuuuck', 'f u c k', 'Dit me may', 'vcl lắm', 'Đồ lồn', 'admin']) expect(isBlocked(name), name).toBe(true);
    for (const name of ['Cá Lớn', 'Các bạn', 'Class act', 'Grape', 'Đèo Gió']) expect(isBlocked(name), name).toBe(false);
  });

  it('come out random but repeatable, and always usable', () => {
    expect(randomNickname('a')).toBe(randomNickname('a'));
    for (let at = 0; at < 300; at += 1) expect(nicknameProblem(randomNickname(`seed-${at}`))).toBeNull();
  });
});

describe('earning limits', () => {
  const NOW = '2026-10-29T12:00:00.000Z';
  let sequence = 0;
  const answer = (at: number, overrides: Partial<AnswerEvent> = {}): AnswerEvent => {
    const time = new Date(Date.parse(NOW) + at).toISOString();
    return {
      id: `log-${(sequence += 1)}`,
      kind: 'review',
      undoes: null,
      at: time,
      on: '2026-10-29',
      isNew: false,
      counted: true,
      wasDue: true,
      durationMs: 4000,
      mode: 'flashcard',
      mastered: false,
      recordedAt: time,
      ...overrides,
    };
  };
  const snapshot: GameSnapshot = {
    version: 0,
    totalXp: 0,
    state: { ...INITIAL_STATE, installedAt: '2026-10-01T00:00:00.000Z' },
    quests: [],
    badges: [],
    freezes: [],
    rewards: [],
    stardust: 0,
    inventory: [],
  };
  const context = (answers: AnswerEvent[]): SyncContext => {
    let id = 0;
    return {
      account: 'account-1',
      now: NOW,
      today: '2026-10-29',
      goals: { newWords: 10, reviews: 30, practice: 20 },
      answers,
      undone: new Map(),
      metDays: [],
      metToday: false,
      addedToday: 0,
      metrics: {
        wordsStudied: 0,
        mastered: 0,
        reviews: 0,
        practice: 0,
        durationMs: 0,
        nightAnswers: 0,
      },
      newId: () => `id-${(id += 1)}`,
    };
  };
  const amounts = (answers: AnswerEvent[]) =>
    sync(snapshot, context(answers))
      .ledger.filter((entry) => entry.source === 'answer')
      .map((entry) => entry.amount);

  it('gives nothing for an answer less than 600 ms after the one before', () => {
    expect(amounts([answer(0), answer(RATE_LIMIT.minGapMs - 1), answer(RATE_LIMIT.minGapMs * 3)])).toEqual([10, 0, 10]);
  });

  it('gives XP to at most 90 answers in any minute', () => {
    // 650 ms apart: the 91st to the 93rd fall in the same minute as the first, the 94th does not.
    const given = amounts(Array.from({ length: 94 }, (_, at) => answer(at * 650)));
    expect(given.slice(0, RATE_LIMIT.perMinute).every((amount) => amount > 0)).toBe(true);
    expect(given.slice(90, 93)).toEqual([0, 0, 0]);
    expect(given[93]).toBeGreaterThan(0);
  });

  it('carries the limits over to the next count', () => {
    const first = sync(snapshot, context([answer(0)]));
    const next = sync({ ...snapshot, version: 1, state: first.state }, context([answer(100)]));
    expect(next.ledger.map((entry) => entry.amount)).toEqual([0]);
  });

  it('does not limit answers saved before the database kept its own time', () => {
    expect(amounts([answer(0, { recordedAt: null }), answer(1, { recordedAt: null })])).toEqual([10, 10]);
  });

  it('takes back nothing, and no quest progress, when an answer past a limit is undone', () => {
    const fast = answer(100);
    const change = sync(snapshot, context([answer(0), fast, answer(5000, { kind: 'undo', undoes: fast.id })]));
    expect(change.ledger.map((entry) => entry.amount)).toEqual([10, 0, 0]);
  });
});
