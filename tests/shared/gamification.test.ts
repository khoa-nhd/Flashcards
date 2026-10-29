import { describe, expect, it } from 'vitest';
import { BADGES, newTiers, type BadgeMetrics } from '../../shared/gamification/badges.js';
import { INITIAL_STATE, claim, sync, weekStartOf, type GameSnapshot, type SyncContext } from '../../shared/gamification/engine.js';
import { levelOf, xpForLevel, xpToNext } from '../../shared/gamification/levels.js';
import { drawDailyQuests, drawWeeklyQuest } from '../../shared/gamification/quests.js';
import { daysToCover, nextCheckinDay } from '../../shared/gamification/streak.js';
import { answerReason, comboBonus, withBonus, type AnswerEvent } from '../../shared/gamification/xp.js';
import { streakOf } from '../../shared/study-goals.js';

const TODAY = '2026-10-29'; // a Thursday
const NOW = '2026-10-29T12:00:00.000Z';
const GOALS = { newWords: 10, reviews: 30, practice: 20 };
const NO_METRICS = { wordsStudied: 0, mastered: 0, reviews: 0, practice: 0, durationMs: 0, nightAnswers: 0 };

let sequence = 0;
const answer = (overrides: Partial<AnswerEvent> = {}): AnswerEvent => ({
  id: `log-${(sequence += 1)}`,
  kind: 'review',
  undoes: null,
  at: NOW,
  on: TODAY,
  isNew: false,
  counted: true,
  wasDue: true,
  durationMs: 4000,
  mode: 'flashcard',
  mastered: false,
  ...overrides,
});

/** Answers `seconds` apart, starting at noon. */
const run = (count: number, seconds = 5, overrides: Partial<AnswerEvent> = {}) =>
  Array.from({ length: count }, (_, at) => answer({ at: new Date(Date.parse(NOW) + at * seconds * 1000).toISOString(), ...overrides }));

const empty = (overrides: Partial<GameSnapshot> = {}): GameSnapshot => ({
  version: 0,
  totalXp: 0,
  state: { ...INITIAL_STATE, installedAt: '2026-10-01T00:00:00.000Z' },
  quests: [],
  badges: [],
  freezes: [],
  rewards: [],
  ...overrides,
});

const context = (overrides: Partial<SyncContext> = {}): SyncContext => {
  let id = 0;
  return {
    account: 'account-1',
    now: NOW,
    today: TODAY,
    goals: GOALS,
    answers: [],
    undone: new Map(),
    metDays: [],
    metToday: false,
    addedToday: 0,
    metrics: NO_METRICS,
    newId: () => `id-${(id += 1)}`,
    ...overrides,
  };
};

const xpOf = (change: ReturnType<typeof sync>, source = 'answer') =>
  change.ledger.filter((entry) => entry.source === source).reduce((sum, entry) => sum + entry.amount, 0);

describe('levels', () => {
  it('costs 100 XP for level 2 and about 15% more for each level after', () => {
    expect(xpToNext(1)).toBe(100);
    expect(xpToNext(2)).toBe(115);
    expect(xpForLevel(10)).toBe(1678);
    expect(levelOf(0)).toEqual({ level: 1, into: 0, needed: 100 });
    expect(levelOf(99).level).toBe(1);
    expect(levelOf(100)).toEqual({ level: 2, into: 0, needed: 115 });
    expect(levelOf(xpForLevel(20)).level).toBe(20);
    // A negative total (everything taken back) is simply no XP.
    expect(levelOf(-50).level).toBe(1);
  });
});

describe('what an answer is worth', () => {
  it('pays the same whether the word was remembered or not, by how the answer was saved', () => {
    expect(answerReason(answer())).toBe('due');
    expect(answerReason(answer({ isNew: true }))).toBe('new');
    expect(answerReason(answer({ wasDue: false }))).toBe('early');
    expect(answerReason(answer({ counted: false }))).toBe('extra');
    expect(answerReason(answer({ kind: 'practice' }))).toBe('practice');
    expect(answerReason(answer({ kind: 'undo' }))).toBeNull();
  });

  it('adds bonuses together rather than multiplying them', () => {
    expect(comboBonus(9)).toBe(0);
    expect(comboBonus(10)).toBe(10);
    expect(comboBonus(25)).toBe(25);
    expect(comboBonus(50)).toBe(50);
    expect(withBonus(10, 50 + 100)).toBe(25);
  });

  it('counts due reviews, new words, early and extra reviews and practice at their own rates', () => {
    const change = sync(
      empty(),
      context({
        answers: [
          answer({ at: '2026-10-29T08:00:00.000Z' }),
          answer({ isNew: true, at: '2026-10-29T08:10:00.000Z' }),
          answer({ wasDue: false, at: '2026-10-29T08:20:00.000Z' }),
          answer({ counted: false, at: '2026-10-29T08:30:00.000Z' }),
          answer({ kind: 'practice', at: '2026-10-29T08:40:00.000Z' }),
        ],
      }),
    );
    expect(change.ledger.filter((entry) => entry.source === 'answer').map((entry) => [entry.reason, entry.amount])).toEqual([
      ['due', 10],
      ['new', 17],
      ['early', 5],
      ['extra', 5],
      ['practice', 5],
    ]);
  });
});

describe('combo', () => {
  it('grows with answers in a row, and ends after two quiet minutes', () => {
    const change = sync(empty(), context({ answers: run(12, 5) }));
    const amounts = change.ledger.map((entry) => entry.amount);
    // The 10th answer in a row starts the +10%.
    expect(amounts.slice(0, 9)).toEqual(Array(9).fill(10));
    expect(amounts.slice(9)).toEqual([11, 11, 11]);
    expect(change.state.combo).toBe(12);

    const later = sync({ ...empty(), state: change.state }, context({ answers: [answer({ at: '2026-10-29T12:10:00.000Z' })] }));
    expect(later.state.combo).toBe(1);
    expect(later.ledger[0]!.amount).toBe(10);
  });

  it('gives no combo or comeback for answers from before the game counted the account', () => {
    const snapshot = empty({ state: { ...INITIAL_STATE, installedAt: '2026-10-29T13:00:00.000Z' } });
    const change = sync(snapshot, context({ answers: run(30, 5) }));
    expect(change.ledger.every((entry) => entry.amount === 10)).toBe(true);
    expect(change.rewards.some((reward) => reward.kind === 'checkin')).toBe(false);
  });
});

describe('undo', () => {
  it('takes back exactly what the answer was given', () => {
    const first = answer({ isNew: true });
    const undo = answer({ kind: 'undo', undoes: first.id, at: '2026-10-29T12:00:30.000Z' });
    const change = sync(empty(), context({ answers: [first, undo] }));
    expect(change.ledger.map((entry) => entry.amount)).toEqual([17, -17]);

    // An answer counted on an earlier visit is taken back from the ledger's record of it.
    const alone = sync(
      empty(),
      context({ answers: [answer({ kind: 'undo', undoes: 'earlier' })], undone: new Map([['earlier', { amount: 11, reason: 'due', on: TODAY }]]) }),
    );
    expect(alone.ledger[0]!.amount).toBe(-11);
  });
});

describe('coming back', () => {
  it('doubles XP for a day after three days or more without an answer', () => {
    const snapshot = empty({ state: { ...INITIAL_STATE, installedAt: '2026-10-01T00:00:00.000Z', lastActiveOn: '2026-10-25' } });
    const change = sync(snapshot, context({ answers: [answer()] }));
    expect(change.ledger[0]!.amount).toBe(20);
    expect(change.rewards.find((reward) => reward.kind === 'comeback')?.payload).toMatchObject({ days: 3 });

    const soon = empty({ state: { ...INITIAL_STATE, installedAt: '2026-10-01T00:00:00.000Z', lastActiveOn: '2026-10-27' } });
    expect(sync(soon, context({ answers: [answer()] })).ledger[0]!.amount).toBe(10);
  });
});

describe('check-in', () => {
  it('moves one day along after yesterday, and back to day 1 after a gap', () => {
    expect(nextCheckinDay({ day: 3, lastOn: '2026-10-28' }, TODAY)).toBe(4);
    expect(nextCheckinDay({ day: 7, lastOn: '2026-10-28' }, TODAY)).toBe(1);
    expect(nextCheckinDay({ day: 5, lastOn: '2026-10-26' }, TODAY)).toBe(1);
  });

  it('is given once, with the first answer of the day', () => {
    const snapshot = empty({ state: { ...INITIAL_STATE, installedAt: '2026-10-01T00:00:00.000Z', checkin: { day: 6, lastOn: '2026-10-28' }, lastActiveOn: '2026-10-28' } });
    const change = sync(snapshot, context({ answers: run(3) }));
    expect(change.rewards.filter((reward) => reward.kind === 'checkin').map((reward) => reward.payload)).toEqual([{ day: 7, xp: 100 }]);
  });
});

describe('goal days', () => {
  it('gives 50 XP once for every met day, history included', () => {
    const change = sync(empty(), context({ metDays: ['2026-10-20', '2026-10-21'], metToday: true }));
    expect(change.ledger.filter((entry) => entry.source === 'goal').map((entry) => entry.sourceId)).toEqual([
      '2026-10-20',
      '2026-10-21',
      TODAY,
    ]);
    const again = sync({ ...empty(), state: change.state }, context({ metDays: ['2026-10-20', '2026-10-21'], metToday: true }));
    expect(xpOf(again, 'goal')).toBe(0);
  });
});

describe('quests', () => {
  it('draws the same three a day and one a week for an account, and different ones for another', () => {
    expect(drawDailyQuests('a', TODAY, GOALS)).toEqual(drawDailyQuests('a', TODAY, GOALS));
    expect(new Set(drawDailyQuests('a', TODAY, GOALS).map((quest) => quest.kind)).size).toBe(3);
    const seen = new Set(['a', 'b', 'c', 'd', 'e'].map((who) => drawDailyQuests(who, TODAY, GOALS).map((q) => q.kind).join()));
    expect(seen.size).toBeGreaterThan(1);
    expect(drawWeeklyQuest('a', weekStartOf(TODAY), GOALS).start).toBe('2026-10-26');
  });

  it('leaves out the new-word quest in maintenance mode', () => {
    for (const who of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(drawDailyQuests(who, TODAY, { ...GOALS, newWords: 0 }).some((quest) => quest.kind === 'new_words')).toBe(false);
    }
  });

  it('counts answers towards today, rewards each completed quest, and all three together', () => {
    const quests = [
      { period: 'day' as const, start: TODAY, slot: 0, kind: 'due_reviews' as const, target: 3, reward: 30, progress: 0, completedAt: null },
      { period: 'day' as const, start: TODAY, slot: 1, kind: 'practice' as const, target: 1, reward: 25, progress: 0, completedAt: null },
      { period: 'day' as const, start: TODAY, slot: 2, kind: 'goal' as const, target: 1, reward: 40, progress: 0, completedAt: null },
      { period: 'week' as const, start: '2026-10-26', slot: 0, kind: 'week_reviews' as const, target: 100, reward: 300, progress: 10, completedAt: null },
    ];
    const change = sync(empty({ quests }), context({ answers: [...run(3), answer({ kind: 'practice', at: '2026-10-29T12:05:00.000Z' })], metToday: true }));
    const done = change.rewards.filter((reward) => reward.kind === 'quest').map((reward) => reward.payload.quest);
    expect(done.sort()).toEqual(['due_reviews', 'goal', 'practice']);
    expect(change.rewards.find((reward) => reward.kind === 'quests_all')?.payload).toEqual({ xp: 50 });
    expect(change.quests.find((quest) => quest.kind === 'week_reviews')?.progress).toBe(13);
  });
});

describe('streak freezes', () => {
  it('covers a missed day only when every missed day can be covered', () => {
    expect(daysToCover(['2026-10-27'], [], 1, TODAY)).toEqual(['2026-10-28']);
    expect(daysToCover(['2026-10-26'], [], 1, TODAY)).toEqual([]);
    expect(daysToCover(['2026-10-26'], [], 2, TODAY)).toEqual(['2026-10-27', '2026-10-28']);
    expect(daysToCover(['2026-10-28'], [], 2, TODAY)).toEqual([]);
  });

  it('keeps the streak going over a covered day without adding to it', () => {
    expect(streakOf(['2026-10-26', '2026-10-27'], TODAY, false, ['2026-10-28'])).toMatchObject({ current: 2 });
    expect(streakOf(['2026-10-26', '2026-10-27'], TODAY, true, ['2026-10-28'])).toMatchObject({ current: 3, longest: 3 });
    expect(streakOf(['2026-10-26', '2026-10-27'], TODAY, false)).toMatchObject({ current: 0 });
  });

  it('spends a held freeze on a missed day, and gives one at every seventh day', () => {
    const freezes = [{ id: 'f1', grantedOn: '2026-10-20', usedOn: null }];
    const used = sync(empty({ freezes }), context({ metDays: ['2026-10-26', '2026-10-27'] }));
    expect(used.freezes).toEqual([{ id: 'f1', grantedOn: '2026-10-20', usedOn: '2026-10-28' }]);
    expect(used.rewards.find((reward) => reward.kind === 'freeze_used')?.payload).toEqual({ days: ['2026-10-28'] });

    const week = ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'];
    const granted = sync(empty(), context({ metDays: week, metToday: true }));
    expect(granted.freezes).toHaveLength(1);
    expect(granted.rewards.find((reward) => reward.kind === 'freeze_granted')?.payload).toEqual({ streak: 7 });
    // Not twice in the same day, and never more than two held.
    expect(sync({ ...empty(), state: granted.state, freezes: granted.freezes }, context({ metDays: week, metToday: true })).freezes).toHaveLength(0);
    const full = [
      { id: 'a', grantedOn: '2026-10-01', usedOn: null },
      { id: 'b', grantedOn: '2026-10-08', usedOn: null },
    ];
    expect(sync(empty({ freezes: full }), context({ metDays: week, metToday: true })).freezes).toHaveLength(0);
  });
});

describe('badges', () => {
  const metrics: BadgeMetrics = { ...NO_METRICS, wordsStudied: 120, reviews: 1500, longestStreak: 8, longestCombo: 30 };

  it('earns every tier reached, once', () => {
    const earned = newTiers(metrics, new Set());
    expect(earned).toEqual([
      { badge: 'words_studied', tier: 1 },
      { badge: 'words_studied', tier: 2 },
      { badge: 'reviews', tier: 1 },
      { badge: 'reviews', tier: 2 },
      { badge: 'streak', tier: 1 },
      { badge: 'combo', tier: 1 },
    ]);
    expect(newTiers(metrics, new Set(earned.map((badge) => `${badge.badge}:${badge.tier}`)))).toEqual([]);
    expect(BADGES.every((badge) => badge.tiers.every((value, at) => at === 0 || value > badge.tiers[at - 1]!))).toBe(true);
  });
});

describe('levels announced and rewards claimed', () => {
  it('announces a level above 1 once, and gives a reward its XP when claimed', () => {
    const answers = run(11, 300);
    const change = sync(empty(), context({ answers }));
    expect(change.rewards.find((reward) => reward.kind === 'level')?.payload).toMatchObject({ level: 2 });
    expect(change.state.levelAnnounced).toBe(2);

    const snapshot = empty({
      totalXp: 90,
      state: { ...change.state, levelAnnounced: 1 },
      rewards: [{ id: 'r1', kind: 'checkin', payload: { day: 1, xp: 10 }, createdAt: NOW }],
    });
    const claimed = claim(snapshot, ['r1', 'unknown'], NOW, TODAY, () => 'new');
    expect(claimed.claimed).toEqual(['r1']);
    expect(claimed.ledger).toEqual([expect.objectContaining({ source: 'reward', sourceId: 'r1', amount: 10 })]);
    expect(claimed.rewards).toEqual([expect.objectContaining({ kind: 'level', payload: { level: 2, from: 1 } })]);
  });

  it('says nothing for a new account at level 1', () => {
    expect(sync(empty(), context()).rewards.filter((reward) => reward.kind === 'level')).toEqual([]);
  });
});
