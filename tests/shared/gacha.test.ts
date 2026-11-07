/**
 * The chests' arithmetic, run the way the server runs it: ten thousand
 * openings, the pity carried between them, and the recycler closing the loop.
 */
import { describe, expect, it } from 'vitest';
import {
  CHESTS,
  DUPLICATE_SHARDS,
  GACHA_ITEMS,
  GACHA_KEYS_PER_DAY,
  GACHA_KEY_CAP,
  GACHA_MAX_BATCH,
  GACHA_SHARDS_PER_KEY,
  NO_PITY,
  chestById,
  dailyKeysDue,
  effectiveRates,
  exchangeShards,
  itemById,
  openChests,
  pickItem,
  rollRarity,
  seededRandom,
  type Rarity,
} from '../../shared/gacha.js';

const wooden = chestById('wooden')!;

/** Ten thousand single openings, pity carried from one to the next. */
function simulate(count = 10_000, seed = 20261104) {
  const random = seededRandom(seed);
  let pity = { ...NO_PITY };
  const owned = new Set<string>();
  const tally: Record<Rarity, number> = { common: 0, rare: 0, epic: 0, legendary: 0 };
  let duplicates = 0;
  let shards = 0;
  let longestDryLegendary = 0;
  let dry = 0;
  for (let index = 0; index < count; index += 1) {
    const opening = openChests({ chest: wooden, pity, owned, count: 1, random });
    const result = opening.results[0]!;
    tally[result.rarity] += 1;
    if (result.duplicate) duplicates += 1;
    else owned.add(result.itemId);
    shards += opening.shardsGained;
    pity = opening.pity;
    dry = result.rarity === 'legendary' ? 0 : dry + 1;
    longestDryLegendary = Math.max(longestDryLegendary, dry);
  }
  return { tally, duplicates, shards, longestDryLegendary, pity };
}

describe('the drop table', () => {
  it('lands on the configured odds when no pity is owed', () => {
    // Fresh pity on every roll, so this measures the table itself, not the pity.
    const random = seededRandom(20261104);
    const rolls = 20_000;
    const tally: Record<Rarity, number> = { common: 0, rare: 0, epic: 0, legendary: 0 };
    for (let index = 0; index < rolls; index += 1) tally[rollRarity(wooden, NO_PITY, random)] += 1;
    for (const chest of CHESTS) {
      const odds = effectiveRates(chest, NO_PITY);
      expect(odds.common).toBeCloseTo(chest.rates.common, 10);
      expect(odds.rare).toBeCloseTo(chest.rates.rare, 10);
      expect(odds.epic).toBeCloseTo(chest.rates.epic, 10);
      expect(odds.legendary).toBeCloseTo(chest.rates.legendary, 10);
    }
    // Two tenths of a percent either way at twenty thousand rolls.
    expect(tally.common / rolls).toBeCloseTo(wooden.rates.common, 2);
    expect(tally.rare / rolls).toBeCloseTo(wooden.rates.rare, 2);
    expect(tally.epic / rolls).toBeCloseTo(wooden.rates.epic, 2);
    expect(tally.legendary / rolls).toBeCloseTo(wooden.rates.legendary, 2);
  });

  it('still keeps the ladder over 10,000 openings with the pity carried along', () => {
    const { tally } = simulate();
    const total = Object.values(tally).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(10_000);
    // The pity only ever moves odds upward: nothing out of order, nothing absent.
    expect(tally.common).toBeGreaterThan(tally.rare);
    expect(tally.rare).toBeGreaterThan(tally.epic);
    expect(tally.epic).toBeGreaterThan(tally.legendary);
    expect(tally.legendary).toBeGreaterThan(0);
    // And it shifts the same way whatever the seed, so the table is stable.
    const other = simulate(10_000, 7).tally;
    for (const rarity of ['common', 'rare', 'epic', 'legendary'] as const) {
      expect(Math.abs(tally[rarity] - other[rarity]) / total).toBeLessThan(0.02);
    }
  });

  it('never lets a legendary wait longer than the hard pity, and keeps the epic floor', () => {
    const { longestDryLegendary } = simulate();
    expect(longestDryLegendary).toBeLessThan(wooden.hardPity);
  });

  it('gives the same run twice from the same seed, so a bug can be replayed', () => {
    const first = simulate(500, 99);
    const second = simulate(500, 99);
    expect(first).toEqual(second);
    expect(simulate(500, 100).tally).not.toEqual(first.tally);
  });

  it('is the same for every chest, once the odds are read off the chest itself', () => {
    for (const chest of CHESTS) {
      const odds = effectiveRates(chest, NO_PITY);
      expect(Object.values(odds).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
      for (const rarity of Object.keys(odds) as Rarity[]) expect(odds[rarity]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the pity', () => {
  it('hands over a legendary the moment the hard pity is reached, whatever the dice say', () => {
    const alwaysHigh = () => 0.999;
    expect(rollRarity(wooden, { sinceEpic: 0, sinceLegendary: wooden.hardPity - 1 }, alwaysHigh)).toBe('legendary');
  });

  it('makes the last opening before the epic pity an epic-or-better', () => {
    const random = seededRandom(3);
    for (let index = 0; index < 50; index += 1) {
      expect(['epic', 'legendary']).toContain(rollRarity(wooden, { sinceEpic: wooden.epicPity - 1, sinceLegendary: 0 }, random));
    }
  });

  it('climbs the legendary odds during soft pity, without inventing probability', () => {
    const base = effectiveRates(wooden, NO_PITY).legendary;
    const soft = effectiveRates(wooden, { sinceEpic: 0, sinceLegendary: wooden.softPityAfter + 5 }).legendary;
    expect(soft).toBeGreaterThan(base);
    const capped = effectiveRates(wooden, { sinceEpic: 0, sinceLegendary: wooden.hardPity - 1 }).legendary;
    // The cap limits the bonus added on top of the chest's own legendary odds.
    expect(capped).toBeLessThanOrEqual(wooden.rates.legendary + wooden.softPityCap + 0.0001);
  });

  it('resets the epic count on an epic and both counts on a legendary', () => {
    const random = seededRandom(11);
    let pity = { sinceEpic: 0, sinceLegendary: 0 };
    const owned = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const opening = openChests({ chest: wooden, pity, owned, count: 1, random });
      const result = opening.results[0]!;
      if (result.rarity === 'legendary') expect(opening.pity).toEqual({ sinceEpic: 0, sinceLegendary: 0 });
      else if (result.rarity === 'epic') {
        expect(opening.pity.sinceEpic).toBe(0);
        expect(opening.pity.sinceLegendary).toBe(pity.sinceLegendary + 1);
      } else {
        expect(opening.pity.sinceEpic).toBe(pity.sinceEpic + 1);
        expect(opening.pity.sinceLegendary).toBe(pity.sinceLegendary + 1);
      }
      for (const item of owned) expect(itemById(item)).not.toBeNull();
      if (!result.duplicate) owned.add(result.itemId);
      pity = opening.pity;
    }
  });
});

describe('duplicates', () => {
  it('recycles a whole collection into shards, and the shards add up', () => {
    const owned = new Set(GACHA_ITEMS.map((item) => item.id));
    const opening = openChests({ chest: wooden, pity: NO_PITY, owned, count: 10, random: seededRandom(5) });
    expect(opening.results).toHaveLength(10);
    for (const result of opening.results) {
      expect(result.duplicate).toBe(true);
      expect(result.shards).toBe(DUPLICATE_SHARDS[result.rarity]);
    }
    expect(opening.shardsGained).toBe(opening.results.reduce((sum, result) => sum + result.shards, 0));
  });

  it('counts the second copy inside one batch as a duplicate too', () => {
    // One item per rarity, so a repeat inside a batch can only be the same item.
    const opening = openChests({ chest: wooden, pity: NO_PITY, owned: new Set(), count: 10, random: seededRandom(1) });
    const seen = new Set<string>();
    for (const result of opening.results) {
      expect(result.duplicate).toBe(seen.has(result.itemId));
      seen.add(result.itemId);
    }
  });

  it('only ever hands out an item of the rarity it rolled', () => {
    const random = seededRandom(17);
    for (let index = 0; index < 500; index += 1) {
      const rarity = rollRarity(wooden, NO_PITY, random);
      expect(pickItem(rarity, random).rarity).toBe(rarity);
    }
  });
});

describe('the closed economy', () => {
  it('grants the daily keys once a day, never past the cap', () => {
    expect(dailyKeysDue(null, '2026-11-04', 0)).toBe(GACHA_KEYS_PER_DAY);
    expect(dailyKeysDue('2026-11-04', '2026-11-04', 0)).toBe(0);
    expect(dailyKeysDue('2026-11-03', '2026-11-04', 0)).toBe(GACHA_KEYS_PER_DAY);
    expect(dailyKeysDue('2026-11-03', '2026-11-04', GACHA_KEY_CAP - 1)).toBe(1);
    expect(dailyKeysDue('2026-11-03', '2026-11-04', GACHA_KEY_CAP)).toBe(0);
  });

  it('trades shards for whole keys only', () => {
    expect(exchangeShards(GACHA_SHARDS_PER_KEY * 2 + 5, 2)).toEqual({ keys: 2, cost: GACHA_SHARDS_PER_KEY * 2 });
    expect(exchangeShards(GACHA_SHARDS_PER_KEY * 2, 9)).toEqual({ keys: 2, cost: GACHA_SHARDS_PER_KEY * 2 });
    expect(exchangeShards(GACHA_SHARDS_PER_KEY - 1, 1)).toBeNull();
    expect(exchangeShards(100, 0)).toBeNull();
  });

  it('refuses a batch larger than ten rather than rolling one', () => {
    expect(() =>
      openChests({ chest: wooden, pity: NO_PITY, owned: new Set(), count: GACHA_MAX_BATCH + 1 }),
    ).toThrow(RangeError);
  });
});
