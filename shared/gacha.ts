/**
 * Loot chests: the rarity table, the pity that keeps a bad run from lasting
 * forever, and the duplicate recycler. Pure functions only: the same rules run
 * on the server that opens a chest and in the tests that simulate ten thousand
 * openings, and the browser only ever draws what the server rolled.
 *
 * The economy is closed on purpose:
 * - Keys open chests. Every day grants a few (GACHA_KEYS_PER_DAY), once.
 * - A duplicate becomes shards, and shards buy more keys, so a long unlucky
 *   run still moves forward instead of feeling wasted.
 */

export const RARITIES = ['common', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

/** What one copy of a duplicate is worth, by rarity. */
export const DUPLICATE_SHARDS: Record<Rarity, number> = {
  common: 2,
  rare: 6,
  epic: 20,
  legendary: 60,
};

export const GACHA_KEYS_PER_DAY = 3;
export const GACHA_KEY_CAP = 99;
/** Shards that buy one more key. */
export const GACHA_SHARDS_PER_KEY = 10;
/** The most chests one request may open. */
export const GACHA_MAX_BATCH = 10;

export interface GachaItem {
  id: string;
  name: string;
  nameVi: string;
  /** A line of flavour under the name on the reward card. */
  flavor: string;
  flavorVi: string;
  rarity: Rarity;
  /** Drawn on the card. The app ships no artwork. */
  glyph: string;
}

/**
 * The collectible pool. Rarity is a property of the item, so a chest can only
 * ever hand out an item that matches the rarity the roll chose.
 */
export const GACHA_ITEMS: readonly GachaItem[] = [
  { id: 'paper-crane', name: 'Paper Crane', nameVi: 'Hạc giấy', rarity: 'common', glyph: '🕊️', flavor: 'Folded from a page you have already learned.', flavorVi: 'Gấp từ một trang bạn đã học xong.' },
  { id: 'pocket-lantern', name: 'Pocket Lantern', nameVi: 'Đèn lồng bỏ túi', rarity: 'common', glyph: '🏮', flavor: 'A small light for the words you almost forgot.', flavorVi: 'Chút sáng cho những từ bạn gần như đã quên.' },
  { id: 'ink-bottle', name: 'Ink Bottle', nameVi: 'Lọ mực', rarity: 'common', glyph: '🖋️', flavor: 'Still half full, like your notebook.', flavorVi: 'Vẫn còn nửa lọ, như cuốn sổ của bạn.' },
  { id: 'well-thumbed-card', name: 'Well-Thumbed Card', nameVi: 'Thẻ đã mòn tay', rarity: 'common', glyph: '🃏', flavor: 'Its corners remember every review.', flavorVi: 'Mép thẻ nhớ từng buổi ôn.' },
  { id: 'brass-compass', name: 'Brass Compass', nameVi: 'La bàn đồng', rarity: 'rare', glyph: '🧭', flavor: 'Points at the word you have not met yet.', flavorVi: 'Chỉ về từ bạn chưa gặp.' },
  { id: 'glass-hourglass', name: 'Glass Hourglass', nameVi: 'Đồng hồ cát', rarity: 'rare', glyph: '⏳', flavor: 'It only counts time spent remembering.', flavorVi: 'Nó chỉ đếm thời gian dành cho việc nhớ.' },
  { id: 'moth-wing-pin', name: 'Moth-Wing Pin', nameVi: 'Ghim cánh bướm đêm', rarity: 'rare', glyph: '🦋', flavor: 'Drawn to the lamp of a hard word.', flavorVi: 'Bị hút về phía ngọn đèn của một từ khó.' },
  { id: 'tide-chart', name: 'Tide Chart', nameVi: 'Hải đồ thủy triều', rarity: 'rare', glyph: '🗺️', flavor: 'Shows when the forgetting tide comes in.', flavorVi: 'Cho thấy khi nào thủy triều lãng quên dâng.' },
  { id: 'silver-quill', name: 'Silver Quill', nameVi: 'Bút lông bạc', rarity: 'epic', glyph: '🪶', flavor: 'Writes a word once and it stays written.', flavorVi: 'Viết một từ một lần, và nó ở lại.' },
  { id: 'memory-prism', name: 'Memory Prism', nameVi: 'Lăng kính ký ức', rarity: 'epic', glyph: '🔮', flavor: 'Splits one memory into every shade it has.', flavorVi: 'Tách một ký ức thành mọi sắc độ của nó.' },
  { id: 'golden-owl', name: 'Golden Owl', nameVi: 'Cú vàng', rarity: 'legendary', glyph: '🦉', flavor: 'It has read every card in the box, twice.', flavorVi: 'Nó đã đọc mọi tấm thẻ trong hộp, hai lần.' },
  { id: 'eternal-lexicon', name: 'Eternal Lexicon', nameVi: 'Tự điển vĩnh cửu', rarity: 'legendary', glyph: '📜', flavor: 'Every word you ever learn is written here.', flavorVi: 'Mọi từ bạn từng học đều được ghi ở đây.' },
];

export interface ChestType {
  id: string;
  name: string;
  nameVi: string;
  description: string;
  descriptionVi: string;
  /** Keys one opening costs. */
  costKeys: number;
  /** Base rarity odds, summing to 1. */
  rates: Record<Rarity, number>;
  /** Openings without an epic-or-better that guarantee one. */
  epicPity: number;
  /** Openings without a legendary at which the legendary odds start to climb. */
  softPityAfter: number;
  /** Added legendary chance per opening past `softPityAfter`. */
  softPityStep: number;
  /** The most that bonus may reach. */
  softPityCap: number;
  /** Opening without a legendary that guarantees one. */
  hardPity: number;
}

export const CHESTS: readonly ChestType[] = [
  {
    id: 'wooden',
    name: 'Wooden chest',
    nameVi: 'Rương gỗ',
    description: 'One key. Most of what falls out is ordinary, and that is fine.',
    descriptionVi: 'Một chìa khoá. Phần lớn đồ rơi ra là thường, và thế cũng ổn.',
    costKeys: 1,
    rates: { common: 0.7, rare: 0.22, epic: 0.07, legendary: 0.01 },
    epicPity: 10,
    softPityAfter: 20,
    softPityStep: 0.06,
    softPityCap: 0.45,
    hardPity: 60,
  },
  {
    id: 'silver',
    name: 'Silver chest',
    nameVi: 'Rương bạc',
    description: 'Three keys. Better seams, better odds, the same luck.',
    descriptionVi: 'Ba chìa khoá. Đường ghép đẹp hơn, tỉ lệ tốt hơn.',
    costKeys: 3,
    rates: { common: 0.55, rare: 0.3, epic: 0.12, legendary: 0.03 },
    epicPity: 10,
    softPityAfter: 15,
    softPityStep: 0.05,
    softPityCap: 0.45,
    hardPity: 50,
  },
  {
    id: 'golden',
    name: 'Golden chest',
    nameVi: 'Rương vàng',
    description: 'Ten keys. It hums before you touch it.',
    descriptionVi: 'Mười chìa khoá. Nó ngân lên trước khi bạn chạm vào.',
    costKeys: 10,
    rates: { common: 0.35, rare: 0.35, epic: 0.22, legendary: 0.08 },
    epicPity: 8,
    softPityAfter: 10,
    softPityStep: 0.06,
    softPityCap: 0.6,
    hardPity: 40,
  },
];

export function chestById(id: string): ChestType | null {
  return CHESTS.find((chest) => chest.id === id) ?? null;
}

/** How far this account is from the pity it is owed. */
export interface PityState {
  /** Openings since the last epic or legendary. */
  sinceEpic: number;
  /** Openings since the last legendary. */
  sinceLegendary: number;
}

export const NO_PITY: PityState = { sinceEpic: 0, sinceLegendary: 0 };

export type Random = () => number;

/** A uniform number in [0, 1) from the platform's cryptographic source. */
export function secureRandom(): number {
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0]! / 0x1_0000_0000;
}

/** A small seeded generator, so a simulation can be repeated exactly in a test. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Scales a set of odds back to 1 after some were removed. */
function renormalize(rates: Record<Rarity, number>): Record<Rarity, number> {
  const total = RARITIES.reduce((sum, rarity) => sum + rates[rarity], 0);
  if (total <= 0) return { ...rates, legendary: 1 };
  return RARITIES.reduce(
    (next, rarity) => {
      next[rarity] = rates[rarity] / total;
      return next;
    },
    {} as Record<Rarity, number>,
  );
}

/**
 * The odds this opening is actually made at: the chest's own, with the epic
 * floor and the climbing legendary chance the pity owes the account.
 */
export function effectiveRates(chest: ChestType, pity: PityState): Record<Rarity, number> {
  const opening = pity.sinceLegendary + 1;
  let rates: Record<Rarity, number> = { ...chest.rates };
  if (pity.sinceEpic + 1 >= chest.epicPity) {
    // Nothing below epic: this opening is epic or better, as the pity promised.
    rates = renormalize({ ...rates, common: 0, rare: 0 });
  }
  if (opening > chest.softPityAfter) {
    const bonus = Math.min(chest.softPityCap, (opening - chest.softPityAfter) * chest.softPityStep);
    rates.legendary += bonus;
    // The bonus is taken from the ordinary end, never invented.
    const fromCommon = Math.min(rates.common, bonus);
    rates.common -= fromCommon;
    rates.rare = Math.max(0, rates.rare - (bonus - fromCommon));
  }
  return renormalize(rates);
}

function pickWeighted(rates: Record<Rarity, number>, random: Random): Rarity {
  const roll = random();
  let seen = 0;
  for (const rarity of RARITIES) {
    seen += rates[rarity];
    if (roll < seen) return rarity;
  }
  return 'common';
}

/** The rarity one opening lands on, pity included. */
export function rollRarity(chest: ChestType, pity: PityState, random: Random = secureRandom): Rarity {
  if (pity.sinceLegendary + 1 >= chest.hardPity) return 'legendary';
  return pickWeighted(effectiveRates(chest, pity), random);
}

const ITEMS_BY_RARITY: Record<Rarity, readonly GachaItem[]> = RARITIES.reduce(
  (pool, rarity) => {
    pool[rarity] = GACHA_ITEMS.filter((item) => item.rarity === rarity);
    return pool;
  },
  {} as Record<Rarity, GachaItem[]>,
);

/** One item of this rarity, falling back a step when the pool is empty. */
export function pickItem(rarity: Rarity, random: Random = secureRandom): GachaItem {
  for (let index = RARITIES.indexOf(rarity); index >= 0; index -= 1) {
    const pool = ITEMS_BY_RARITY[RARITIES[index]!]!;
    if (pool.length > 0) return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
  }
  return GACHA_ITEMS[0]!;
}

export function itemById(id: string): GachaItem | null {
  return GACHA_ITEMS.find((item) => item.id === id) ?? null;
}

export interface OpeningResult {
  itemId: string;
  rarity: Rarity;
  /** It was already in the collection, so it became shards instead. */
  duplicate: boolean;
  /** What the duplicate was worth; 0 when the item was new. */
  shards: number;
}

export interface Opening {
  results: OpeningResult[];
  pity: PityState;
  shardsGained: number;
}

export interface OpenInput {
  chest: ChestType;
  pity: PityState;
  /** The items the account already owns. */
  owned: ReadonlySet<string>;
  count: number;
  random?: Random;
}

/**
 * Opens `count` chests in one go. The server decides every result here; the
 * browser is told what happened rather than asked to believe it.
 *
 * A batch is resolved in order: a second copy of the same item inside one
 * batch is a duplicate too, and is recycled the same way.
 */
export function openChests({ chest, pity, owned, count, random = secureRandom }: OpenInput): Opening {
  if (!Number.isInteger(count) || count < 1 || count > GACHA_MAX_BATCH) {
    throw new RangeError(`A batch opens between 1 and ${GACHA_MAX_BATCH} chests.`);
  }
  let state: PityState = { ...pity };
  const seen = new Set(owned);
  const results: OpeningResult[] = [];
  let shardsGained = 0;
  for (let index = 0; index < count; index += 1) {
    const rarity = rollRarity(chest, state, random);
    const item = pickItem(rarity, random);
    const duplicate = seen.has(item.id);
    if (duplicate) {
      const shards = DUPLICATE_SHARDS[rarity];
      shardsGained += shards;
      results.push({ itemId: item.id, rarity, duplicate: true, shards });
    } else {
      seen.add(item.id);
      results.push({ itemId: item.id, rarity, duplicate: false, shards: 0 });
    }
    state = {
      sinceEpic: rarity === 'epic' || rarity === 'legendary' ? 0 : state.sinceEpic + 1,
      sinceLegendary: rarity === 'legendary' ? 0 : state.sinceLegendary + 1,
    };
  }
  return { results, pity: state, shardsGained };
}

/** The keys a day's visit is worth, granted once per calendar day. */
export function dailyKeysDue(lastGrantDay: string | null, today: string, keys: number): number {
  if (lastGrantDay === today) return 0;
  return Math.max(0, Math.min(GACHA_KEYS_PER_DAY, GACHA_KEY_CAP - keys));
}

/** How many keys this many shards can buy, and what they cost. */
export function exchangeShards(shards: number, wanted: number): { keys: number; cost: number } | null {
  if (!Number.isInteger(wanted) || wanted < 1) return null;
  const keys = Math.min(wanted, Math.floor(shards / GACHA_SHARDS_PER_KEY));
  if (keys < 1) return null;
  return { keys, cost: keys * GACHA_SHARDS_PER_KEY };
}
