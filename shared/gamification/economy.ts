/**
 * Stardust, the shop, chests, companions, the weekly boss and events
 * (docs/gamification-plan.md, phase 3). Pure: randomness comes in as a
 * function, so the server draws with a secure source and the tests with a seed.
 */
import { addDays, compareDates, type IsoDate } from '../dates.js';
import {
  DUPLICATE_STARDUST,
  ITEMS,
  PET_FORMS,
  PET_SLOTS_MAX,
  PET_XP_CAP,
  PETS,
  PRICE,
  SLOT_PRICE,
  itemById,
  petById,
  type Item,
  type Rarity,
} from './catalog.js';
import { seededRandom } from './quests.js';

// ---- Stardust (3.1) ----

export const STARDUST = {
  /** Per level reached: 20 times the level, at most 500. */
  level: (level: number) => Math.min(500, 20 * level),
  dailyQuest: 10,
  allQuests: 20,
  weeklyQuest: 150,
  /** League places 1 to 3, and going up a league. */
  leagueRank: [200, 150, 100] as const,
  promotion: 50,
  boss: 200,
} as const;

/** Stardust a league result gives. */
export function leagueStardust(rank: number, outcome: 'up' | 'down' | 'stay'): number {
  return (STARDUST.leagueRank[rank - 1] ?? 0) + (outcome === 'up' ? STARDUST.promotion : 0);
}

// ---- The shop (3.2) ----

export type ShopOffer =
  | { kind: 'item'; item: string; price: number }
  | { kind: 'freeze'; price: number }
  | { kind: 'boost'; price: number }
  | { kind: 'repair'; price: number }
  | { kind: 'slot'; price: number };

export const ALWAYS = { freeze: 200, boost: 150, repair: 500, slot: SLOT_PRICE } as const;
/** A bought boost doubles XP for this long. */
export const BOOST_MS = 15 * 60_000;
export const BOOST_BONUS = 100;
/** A streak broken this many days ago or less can be repaired. */
export const REPAIR_DAYS = 2;
export const SHOP_DAILY = 4;

/** The day's four items: the same all day for one account, new at midnight. */
export function dailyShop(account: string, day: IsoDate): string[] {
  const random = seededRandom(`shop:${account}:${day}`);
  const pool = ITEMS.filter((item) => item.sold);
  const picked: string[] = [];
  while (picked.length < SHOP_DAILY && pool.length > 0) picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!.id);
  return picked;
}

export const priceOf = (item: Item): number => PRICE[item.rarity];

/**
 * The days a repair would cover: the days missed since the last met (or
 * covered) day, when the streak broke no more than two days ago. Empty when
 * there is nothing to repair.
 */
export function repairDays(metDays: readonly IsoDate[], covered: readonly IsoDate[], today: IsoDate): IsoDate[] {
  const kept = [...metDays, ...covered].filter((day) => compareDates(day, today) < 0).sort(compareDates);
  const last = kept.at(-1);
  if (last === undefined) return [];
  const gap: IsoDate[] = [];
  for (let day = addDays(last, 1); compareDates(day, today) < 0; day = addDays(day, 1)) gap.push(day);
  return gap.length > 0 && gap.length <= REPAIR_DAYS ? gap : [];
}

// ---- Chests (3.3) ----

export type ChestRarity = 'common' | 'rare' | 'legendary';

/** What a chest is: 70% common, 25% rare, 5% legendary; from a 30-day streak, 30% rare and 7% legendary. */
export function chestRarity(random: () => number, streak: number, extraRarePercent = 0): ChestRarity {
  const legendary = streak >= 30 ? 7 : 5;
  const rare = (streak >= 30 ? 30 : 25) + extraRarePercent;
  const roll = random() * 100;
  if (roll < legendary) return 'legendary';
  if (roll < legendary + rare) return 'rare';
  return 'common';
}

export interface ChestContents {
  rarity: ChestRarity;
  stardust: number;
  xp: number;
  /** Items new to the account. */
  items: string[];
  /** Items already owned, turned into stardust (counted in `stardust`). */
  duplicates: string[];
}

const pick = <T>(items: readonly T[], random: () => number): T | undefined => items[Math.floor(random() * items.length)];
const between = (low: number, high: number, random: () => number) => low + Math.floor(random() * (high - low + 1));

/** Opens a chest of a rarity against what the account owns. */
export function openChest(rarity: ChestRarity, random: () => number, owned: ReadonlySet<string>): ChestContents {
  const contents: ChestContents = { rarity, stardust: 0, xp: 0, items: [], duplicates: [] };
  const give = (id: string | undefined) => {
    if (id === undefined) return;
    if (owned.has(id) || contents.items.includes(id)) {
      contents.duplicates.push(id);
      contents.stardust += DUPLICATE_STARDUST[itemById(id)?.rarity ?? 'common'];
    } else {
      contents.items.push(id);
    }
  };
  const ofKind = (kinds: Item['kind'][], rarities: Rarity[]) =>
    ITEMS.filter((item) => kinds.includes(item.kind) && rarities.includes(item.rarity)).map((item) => item.id);

  if (rarity === 'common') {
    if (random() < 0.5) contents.stardust += between(30, 60, random);
    else contents.xp += 50;
    return contents;
  }
  if (rarity === 'rare') {
    contents.stardust += between(100, 200, random);
    give(random() < 0.6 ? pick(ofKind(['card'], ['common', 'rare']), random) : pick(ofKind(['frame'], ['common', 'rare']), random));
    return contents;
  }
  contents.stardust += 400;
  const newPets = PETS.map((pet) => pet.id).filter((id) => !owned.has(id));
  if (newPets.length > 0 && random() < 0.4) give(pick(newPets, random));
  else give(pick(ofKind(['card', 'frame', 'theme'], ['epic', 'legendary']), random));
  if (!owned.has('slot_key') && random() < 0.2) give('slot_key');
  return contents;
}

// ---- Companions (3.5) ----

export interface PetState {
  /** Companions leading now, in slot order. */
  active: string[];
  /** Days studied with each companion leading. */
  days: Record<string, number>;
  /** Reached Gold in a league once: that opens a slot for good. */
  goldReached: boolean;
}

export const INITIAL_PETS: PetState = { active: [], days: {}, goldReached: false };

/** How many companions can lead: one to start, then level 20, Gold, one bought and one from a key. */
export function petSlots(level: number, pets: PetState, owned: ReadonlySet<string>): number {
  return Math.min(
    PET_SLOTS_MAX,
    1 + (level >= 20 ? 1 : 0) + (pets.goldReached ? 1 : 0) + (owned.has('slot_bought') ? 1 : 0) + (owned.has('slot_key') ? 1 : 0),
  );
}

/** A companion's form, 1 to 4, from the days studied with it leading. */
export function petForm(days: number): number {
  return PET_FORMS.filter((threshold) => days >= threshold).length;
}

/** Happy while studying; after two days away a companion is sad and its skill rests until the next study. */
export function petMood(lastActiveOn: IsoDate | null, today: IsoDate): 'happy' | 'sad' {
  if (lastActiveOn === null) return 'happy';
  return compareDates(addDays(lastActiveOn, 2), today) <= 0 ? 'sad' : 'happy';
}

/** What the leading companions add: XP (capped together), a longer combo pause, rarer chests. */
export function petEffects(active: readonly string[]): { xpPercent: number; comboExtraMs: number; chestRarePercent: number } {
  let xp = 0;
  let combo = 0;
  let chest = 0;
  for (const id of active) {
    const skill = petById(id)?.skill;
    if (skill === undefined) continue;
    xp += skill.kind === 'xp' ? skill.percent : skill.kind === 'combo' ? skill.percent : skill.xp;
    if (skill.kind === 'combo') combo = Math.max(combo, skill.extraMs);
    if (skill.kind === 'chest') chest += skill.percent;
  }
  return { xpPercent: Math.min(PET_XP_CAP, xp), comboExtraMs: combo, chestRarePercent: chest };
}

// ---- Events (3.7) ----

export interface EventSwitches {
  goldenHour: boolean;
  sunday: boolean;
  monthly: boolean;
  boss: boolean;
}

export const ALL_EVENTS: EventSwitches = { goldenHour: true, sunday: true, monthly: true, boss: true };

export const GOLDEN_HOUR_BONUS = 100;
export const SUNDAY_BONUS = 50;

/** The day's golden hour, in the account's own time: it starts at 19, 20 or 21 o'clock. */
export function goldenHour(account: string, day: IsoDate): number {
  return 19 + Math.floor(seededRandom(`golden:${account}:${day}`)() * 3);
}

/** The month's challenge: this many answers within the month earns its badge. */
export const MONTHLY_TARGET = 1000;
export const monthKey = (day: IsoDate) => day.slice(0, 7);
export const monthBadge = (month: string) => `month_${month.replace('-', '_')}`;

// ---- The weekly boss (3.6) ----

export const BOSS_WORDS = 15;
/** Hits to beat it: each word remembered in practice is one, each one forgotten heals half. */
export const BOSS_HP = 40;
export const BOSS_HEAL = 0.5;
export const BOSS_XP = 300;

export function bossHealth(correct: number, wrong: number): number {
  return Math.max(0, Math.min(BOSS_HP, BOSS_HP - correct + wrong * BOSS_HEAL));
}

export const isPet = (id: string) => petById(id) !== undefined;
