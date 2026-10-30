import { describe, expect, it } from 'vitest';
import { CARD_SETS, ITEMS, PET_XP_CAP, PETS, cardId, itemById } from '../../shared/gamification/catalog.js';
import {
  BOSS_HP,
  STARDUST,
  bossHealth,
  chestRarity,
  dailyShop,
  goldenHour,
  leagueStardust,
  openChest,
  petEffects,
  petForm,
  petMood,
  petSlots,
  repairDays,
  INITIAL_PETS,
} from '../../shared/gamification/economy.js';
import {
  INITIAL_STATE,
  addItems,
  claim,
  stateChange,
  sync,
  type GameSnapshot,
  type SyncContext,
} from '../../shared/gamification/engine.js';
import { seededRandom } from '../../shared/gamification/quests.js';
import { settleGroup } from '../../shared/gamification/league.js';
import type { AnswerEvent } from '../../shared/gamification/xp.js';

const TODAY = '2026-10-29'; // a Thursday
const NOW = '2026-10-29T05:00:00.000Z'; // 12:00 in Ho Chi Minh City

const snapshot = (overrides: Partial<GameSnapshot> = {}): GameSnapshot => ({
  version: 0,
  totalXp: 0,
  state: { ...INITIAL_STATE, installedAt: '2026-10-01T00:00:00.000Z' },
  quests: [],
  badges: [],
  freezes: [],
  rewards: [],
  stardust: 0,
  inventory: [],
  ...overrides,
});

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

const economy = { timeZone: 'Asia/Ho_Chi_Minh', events: { goldenHour: false, sunday: true, monthly: true, boss: true } };
const context = (overrides: Partial<SyncContext> = {}): SyncContext => {
  let id = 0;
  return {
    account: 'account-1',
    now: NOW,
    today: TODAY,
    goals: { newWords: 10, reviews: 30, practice: 20 },
    answers: [],
    undone: new Map(),
    metDays: [],
    metToday: false,
    addedToday: 0,
    metrics: { wordsStudied: 0, mastered: 0, reviews: 0, practice: 0, durationMs: 0, nightAnswers: 0 },
    newId: () => `id-${(id += 1)}`,
    economy,
    ...overrides,
  };
};
const answerXp = (change: ReturnType<typeof sync>) =>
  change.ledger.filter((entry) => entry.source === 'answer').map((entry) => entry.amount);

describe('the catalogue', () => {
  it('has the 88 constellations, six companions, and unique ids', () => {
    expect(ITEMS.filter((item) => item.kind === 'card')).toHaveLength(88);
    expect(PETS).toHaveLength(6);
    expect(new Set(ITEMS.map((item) => item.id)).size).toBe(ITEMS.length);
    for (const set of CARD_SETS) for (const card of set.cards) expect(itemById(card), card).toBeDefined();
  });
});

describe('stardust', () => {
  it('follows the plan’s table', () => {
    expect(STARDUST.level(5)).toBe(100);
    expect(STARDUST.level(40)).toBe(500);
    expect(leagueStardust(1, 'up')).toBe(250);
    expect(leagueStardust(3, 'stay')).toBe(100);
    expect(leagueStardust(4, 'up')).toBe(50);
    expect(leagueStardust(12, 'stay')).toBe(0);
  });

  it('comes with level, quest and league rewards, to claim', () => {
    const up = sync(
      snapshot(),
      context({ answers: Array.from({ length: 11 }, (_, at) => answer({ at: new Date(Date.parse(NOW) + at * 5000).toISOString() })) }),
    );
    expect(up.rewards.find((reward) => reward.kind === 'level')?.payload).toMatchObject({ level: 2, stardust: 40 });
    const [member] = settleGroup({ id: 'g', tier: 2, createdAt: NOW, members: [{ user: 'u', xp: 100_000, joinedAt: NOW }] }, '2026-10-26');
    expect(member!.reward).toMatchObject({ rank: 1, outcome: 'up', stardust: 250 });
  });

  it('is not given where the database keeps none', () => {
    const plain = sync(snapshot(), context({ economy: null, answers: Array.from({ length: 11 }, () => answer()) }));
    expect(plain.rewards.find((reward) => reward.kind === 'level')?.payload.stardust).toBeUndefined();
  });
});

describe('the shop', () => {
  it('offers four items a day, the same all day, and new ones the next', () => {
    expect(dailyShop('a', TODAY)).toHaveLength(4);
    expect(dailyShop('a', TODAY)).toEqual(dailyShop('a', TODAY));
    expect(dailyShop('a', TODAY)).not.toEqual(dailyShop('a', '2026-10-30'));
    for (const id of dailyShop('a', TODAY)) expect(itemById(id)?.sold).toBe(true);
  });

  it('repairs a streak broken no more than two days ago', () => {
    expect(repairDays(['2026-10-26'], [], TODAY)).toEqual(['2026-10-27', '2026-10-28']);
    expect(repairDays(['2026-10-25'], [], TODAY)).toEqual([]);
    expect(repairDays(['2026-10-28'], [], TODAY)).toEqual([]);
  });
});

describe('chests', () => {
  const tally = (streak: number, extra = 0) => {
    const random = seededRandom('chests');
    const counts = { common: 0, rare: 0, legendary: 0 };
    for (let at = 0; at < 20_000; at += 1) counts[chestRarity(random, streak, extra)] += 1;
    return counts;
  };

  it('come out 70% common, 25% rare, 5% legendary', () => {
    const counts = tally(5);
    expect(counts.common / 20_000).toBeCloseTo(0.7, 1);
    expect(counts.rare / 20_000).toBeCloseTo(0.25, 1);
    expect(counts.legendary / 20_000).toBeGreaterThan(0.04);
    expect(counts.legendary / 20_000).toBeLessThan(0.06);
  });

  it('come out rarer from a 30-day streak', () => {
    const counts = tally(30);
    expect(counts.legendary / 20_000).toBeGreaterThan(0.06);
    expect(counts.rare / 20_000).toBeCloseTo(0.3, 1);
  });

  it('hold what the plan says, and turn an item already owned into stardust', () => {
    const random = seededRandom('open');
    for (let at = 0; at < 200; at += 1) {
      const common = openChest('common', random, new Set());
      expect(common.stardust > 0 !== common.xp > 0).toBe(true);
      const rare = openChest('rare', random, new Set());
      expect(rare.stardust).toBeGreaterThanOrEqual(100);
      expect(rare.items.length + rare.duplicates.length).toBe(1);
      const legendary = openChest('legendary', random, new Set());
      expect(legendary.stardust).toBeGreaterThanOrEqual(400);
    }
    const everything = new Set(ITEMS.map((item) => item.id));
    const again = openChest('rare', seededRandom('dup'), everything);
    expect(again.items).toEqual([]);
    expect(again.duplicates).toHaveLength(1);
  });

  it('are given once for each day the goals are met, and opened once when claimed', () => {
    const met = sync(snapshot(), context({ metDays: [], metToday: true }));
    const chest = met.rewards.find((reward) => reward.kind === 'chest')!;
    expect(chest).toBeDefined();
    const after = snapshot({ rewards: [chest], state: met.state });
    const opened = claim(after, [chest.id], NOW, TODAY, () => 'x', seededRandom('claim'));
    expect(opened.opened).toHaveLength(1);
    expect(opened.claimed).toEqual([chest.id]);
    // Without a random source (a database before version 19) a chest stays closed.
    expect(claim(after, [chest.id], NOW, TODAY, () => 'x', null).claimed).toEqual([]);
  });

  it('makes the seventh check-in a rare chest', () => {
    const state = { ...INITIAL_STATE, installedAt: '2026-10-01T00:00:00.000Z', checkin: { day: 6, lastOn: '2026-10-28' } };
    const change = sync(snapshot({ state }), context({ answers: [answer()] }));
    expect(change.rewards.find((reward) => reward.kind === 'checkin')?.payload).toEqual({ day: 7, chest: 'rare' });
  });
});

describe('companions', () => {
  it('add XP together, never more than 25%', () => {
    expect(petEffects(['pet_owl']).xpPercent).toBe(10);
    expect(petEffects(PETS.map((pet) => pet.id)).xpPercent).toBe(PET_XP_CAP);
  });

  it('raise an answer’s XP with the other bonuses, added together', () => {
    const state = {
      ...INITIAL_STATE,
      installedAt: '2026-10-01T00:00:00.000Z',
      pets: { ...INITIAL_PETS, active: ['pet_owl', 'pet_dragon'] },
    };
    expect(answerXp(sync(snapshot({ state }), context({ answers: [answer()] })))).toEqual([12]);
  });

  it('grow with each day studied leading, through four forms', () => {
    expect([0, 6, 7, 29, 30, 100].map(petForm)).toEqual([1, 1, 2, 2, 3, 4]);
    const state = {
      ...INITIAL_STATE,
      installedAt: '2026-10-01T00:00:00.000Z',
      lastActiveOn: '2026-10-28',
      pets: { ...INITIAL_PETS, active: ['pet_owl'] },
    };
    expect(sync(snapshot({ state }), context({ answers: [answer(), answer()] })).state.pets.days).toEqual({ pet_owl: 1 });
  });

  it('are sad after two days away, never gone', () => {
    expect(petMood('2026-10-28', TODAY)).toBe('happy');
    expect(petMood('2026-10-27', TODAY)).toBe('sad');
  });

  it('get a slot each from level 20, Gold, the shop and a key, up to five', () => {
    const none = new Set<string>();
    expect(petSlots(1, INITIAL_PETS, none)).toBe(1);
    expect(petSlots(20, { ...INITIAL_PETS, goldReached: true }, new Set(['slot_bought', 'slot_key']))).toBe(5);
  });
});

describe('events', () => {
  it('give +50% on a Sunday', () => {
    const sunday = '2026-11-01';
    const at = '2026-11-01T05:00:00.000Z';
    const change = sync(snapshot(), context({ today: sunday, now: at, answers: [answer({ on: sunday, at })] }));
    expect(answerXp(change)).toEqual([15]);
  });

  it('double XP in the golden hour', () => {
    const hour = goldenHour('account-1', TODAY);
    const at = new Date(Date.parse(`${TODAY}T00:00:00+07:00`) + hour * 3_600_000 + 60_000).toISOString();
    const on = sync(
      snapshot(),
      context({ economy: { ...economy, events: { ...economy.events, goldenHour: true } }, answers: [answer({ at })] }),
    );
    expect(answerXp(on)).toEqual([20]);
    expect(answerXp(sync(snapshot(), context({ answers: [answer({ at })] })))).toEqual([10]);
  });
});

describe('the weekly boss', () => {
  it('loses a hit for each word remembered and heals half for each forgotten', () => {
    expect(bossHealth(0, 0)).toBe(BOSS_HP);
    expect(bossHealth(10, 4)).toBe(BOSS_HP - 8);
    expect(bossHealth(100, 0)).toBe(0);
  });
});

describe('card sets', () => {
  it('give their reward and title once, when the last card comes', () => {
    const set = CARD_SETS.find((each) => each.id === 'set_argo')!;
    const base = snapshot({ inventory: set.cards.slice(0, 3) });
    const change = stateChange(base, base.state);
    addItems(change, new Set(base.inventory), [set.cards[3]!], 'shop', NOW, () => 'r');
    expect(change.inventory.map((entry) => entry.item)).toEqual([cardId('Pyxis'), 'title_argo']);
    expect(change.rewards).toEqual([expect.objectContaining({ kind: 'set', payload: expect.objectContaining({ stardust: 300 }) })]);
    expect(change.state.setsDone).toEqual(['set_argo']);
  });
});
