/**
 * Everything that can be collected (docs/gamification-plan.md, 3.4): companions,
 * constellation cards, avatar frames, titles and colour themes. Nothing here is
 * sold for real money and nothing can be traded between accounts.
 *
 * Constellation cards carry the 88 IAU names, which are facts. Their pictures
 * are drawn from each card's id, as decoration: they are not star maps, so no
 * star catalogue or line data (some of which is GPL) is in this public repo.
 */

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export type ItemKind = 'pet' | 'card' | 'frame' | 'title' | 'theme' | 'slot';

export interface Item {
  id: string;
  kind: ItemKind;
  rarity: Rarity;
  en: string;
  vi: string;
  /** Sold in the daily shop at its rarity's price; false for what only chests, sets or feats give. */
  sold: boolean;
}

export const RARITIES: readonly Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** What the shop asks for an item of each rarity, in stardust. */
export const PRICE: Record<Rarity, number> = { common: 120, rare: 300, epic: 600, legendary: 1200 };

/** Stardust for an item already owned when it comes again (plan 3.1: 10 / 40 / 150, with epic between). */
export const DUPLICATE_STARDUST: Record<Rarity, number> = { common: 10, rare: 40, epic: 80, legendary: 150 };

// ---- Companions (3.5) ----

export type PetSkill =
  | { kind: 'xp'; percent: number }
  /** The combo survives a longer pause between answers. */
  | { kind: 'combo'; extraMs: number; percent: number }
  /** Chests come out rare or better more often. */
  | { kind: 'chest'; percent: number; xp: number };

export interface Pet {
  id: string;
  en: string;
  vi: string;
  skill: PetSkill;
}

export const PETS: readonly Pet[] = [
  { id: 'pet_owl', en: 'Night owl', vi: 'Cú đêm', skill: { kind: 'xp', percent: 10 } },
  { id: 'pet_rabbit', en: 'Moon rabbit', vi: 'Thỏ trăng', skill: { kind: 'xp', percent: 8 } },
  { id: 'pet_fox', en: 'Star fox', vi: 'Cáo sao', skill: { kind: 'chest', percent: 2, xp: 5 } },
  { id: 'pet_cat', en: 'Cloud cat', vi: 'Mèo mây', skill: { kind: 'combo', extraMs: 60_000, percent: 5 } },
  { id: 'pet_whale', en: 'Night whale', vi: 'Cá voi đêm', skill: { kind: 'xp', percent: 7 } },
  { id: 'pet_dragon', en: 'Little star dragon', vi: 'Rồng sao nhỏ', skill: { kind: 'xp', percent: 10 } },
];

/** Days studied with a companion leading at which it takes its next form; four forms in all. */
export const PET_FORMS = [0, 7, 30, 100] as const;

/** The most XP companions add together, in percent (the owner's cap). */
export const PET_XP_CAP = 25;

/** How many companions can lead at once. */
export const PET_SLOTS_MAX = 5;

/** The slot bought with stardust, and the one a key from a legendary chest opens. */
export const SLOT_PRICE = 1500;

// ---- Constellations ----

/** The 88 IAU constellations. */
const CONSTELLATIONS = [
  'Andromeda',
  'Antlia',
  'Apus',
  'Aquarius',
  'Aquila',
  'Ara',
  'Aries',
  'Auriga',
  'Boötes',
  'Caelum',
  'Camelopardalis',
  'Cancer',
  'Canes Venatici',
  'Canis Major',
  'Canis Minor',
  'Capricornus',
  'Carina',
  'Cassiopeia',
  'Centaurus',
  'Cepheus',
  'Cetus',
  'Chamaeleon',
  'Circinus',
  'Columba',
  'Coma Berenices',
  'Corona Australis',
  'Corona Borealis',
  'Corvus',
  'Crater',
  'Crux',
  'Cygnus',
  'Delphinus',
  'Dorado',
  'Draco',
  'Equuleus',
  'Eridanus',
  'Fornax',
  'Gemini',
  'Grus',
  'Hercules',
  'Horologium',
  'Hydra',
  'Hydrus',
  'Indus',
  'Lacerta',
  'Leo',
  'Leo Minor',
  'Lepus',
  'Libra',
  'Lupus',
  'Lynx',
  'Lyra',
  'Mensa',
  'Microscopium',
  'Monoceros',
  'Musca',
  'Norma',
  'Octans',
  'Ophiuchus',
  'Orion',
  'Pavo',
  'Pegasus',
  'Perseus',
  'Phoenix',
  'Pictor',
  'Pisces',
  'Piscis Austrinus',
  'Puppis',
  'Pyxis',
  'Reticulum',
  'Sagitta',
  'Sagittarius',
  'Scorpius',
  'Sculptor',
  'Scutum',
  'Serpens',
  'Sextans',
  'Taurus',
  'Telescopium',
  'Triangulum',
  'Triangulum Australe',
  'Tucana',
  'Ursa Major',
  'Ursa Minor',
  'Vela',
  'Virgo',
  'Volans',
  'Vulpecula',
] as const;

/** Vietnamese names for the best-known ones; the rest keep the IAU name, as Vietnamese star charts do. */
const CONSTELLATION_VI: Record<string, string> = {
  Aries: 'Bạch Dương',
  Taurus: 'Kim Ngưu',
  Gemini: 'Song Tử',
  Cancer: 'Cự Giải',
  Leo: 'Sư Tử',
  Virgo: 'Xử Nữ',
  Libra: 'Thiên Bình',
  Scorpius: 'Bọ Cạp',
  Sagittarius: 'Nhân Mã',
  Capricornus: 'Ma Kết',
  Aquarius: 'Bảo Bình',
  Pisces: 'Song Ngư',
  'Ursa Major': 'Đại Hùng',
  'Ursa Minor': 'Tiểu Hùng',
  Orion: 'Lạp Hộ',
  Cassiopeia: 'Thiên Hậu',
  Crux: 'Nam Thập Tự',
  Draco: 'Thiên Long',
  Cygnus: 'Thiên Nga',
  Lyra: 'Thiên Cầm',
  Aquila: 'Thiên Ưng',
  Andromeda: 'Tiên Nữ',
  Perseus: 'Anh Tiên',
  Pegasus: 'Phi Mã',
  'Canis Major': 'Đại Khuyển',
  'Canis Minor': 'Tiểu Khuyển',
};

const ZODIAC = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpius',
  'Sagittarius',
  'Capricornus',
  'Aquarius',
  'Pisces',
];
const LEGENDARY_CARDS = ['Orion', 'Ursa Major', 'Crux', 'Scorpius'];
const RARE_CARDS = [
  'Andromeda',
  'Aquila',
  'Auriga',
  'Boötes',
  'Canis Major',
  'Canis Minor',
  'Cygnus',
  'Lyra',
  'Pegasus',
  'Perseus',
  'Draco',
  'Ursa Minor',
  'Cepheus',
  'Centaurus',
  'Hercules',
  'Hydra',
  'Carina',
  'Corona Borealis',
  'Delphinus',
  'Ophiuchus',
];

export const cardId = (name: string) => `card_${name.toLowerCase().replace(/ö/g, 'o').replace(/\s+/g, '_')}`;

function cardRarity(name: string): Rarity {
  if (LEGENDARY_CARDS.includes(name)) return 'legendary';
  if (ZODIAC.includes(name) || name === 'Cassiopeia') return 'epic';
  if (RARE_CARDS.includes(name)) return 'rare';
  return 'common';
}

/** Sets of cards; completing one gives its stardust and its title once. */
export interface CardSet {
  id: string;
  en: string;
  vi: string;
  cards: string[];
  stardust: number;
  title: string;
}

export const CARD_SETS: readonly CardSet[] = [
  { id: 'set_zodiac', en: 'The zodiac', vi: 'Hoàng đạo', cards: ZODIAC.map(cardId), stardust: 600, title: 'title_zodiac' },
  {
    id: 'set_north',
    en: 'Around the north pole',
    vi: 'Quanh cực Bắc',
    cards: ['Ursa Major', 'Ursa Minor', 'Draco', 'Cepheus', 'Cassiopeia', 'Camelopardalis'].map(cardId),
    stardust: 400,
    title: 'title_north',
  },
  {
    id: 'set_argo',
    en: 'The ship Argo',
    vi: 'Con tàu Argo',
    cards: ['Carina', 'Puppis', 'Vela', 'Pyxis'].map(cardId),
    stardust: 300,
    title: 'title_argo',
  },
  {
    id: 'set_hunt',
    en: 'Orion’s hunt',
    vi: 'Cuộc săn của Lạp Hộ',
    cards: ['Orion', 'Canis Major', 'Canis Minor', 'Lepus', 'Monoceros'].map(cardId),
    stardust: 400,
    title: 'title_hunt',
  },
];

// ---- The catalogue ----

const pets: Item[] = PETS.map((pet) => ({ id: pet.id, kind: 'pet', rarity: 'legendary', en: pet.en, vi: pet.vi, sold: false }));

const cards: Item[] = CONSTELLATIONS.map((name) => ({
  id: cardId(name),
  kind: 'card',
  rarity: cardRarity(name),
  en: name,
  vi: CONSTELLATION_VI[name] ?? name,
  // Legendary cards come only from chests.
  sold: cardRarity(name) !== 'legendary',
}));

const frames: Item[] = [
  { id: 'frame_moon', kind: 'frame', rarity: 'common', en: 'Moonlight', vi: 'Ánh trăng', sold: true },
  { id: 'frame_frost', kind: 'frame', rarity: 'common', en: 'Frost', vi: 'Sương giá', sold: true },
  { id: 'frame_dusk', kind: 'frame', rarity: 'common', en: 'Dusk', vi: 'Hoàng hôn', sold: true },
  { id: 'frame_aurora', kind: 'frame', rarity: 'rare', en: 'Aurora', vi: 'Cực quang', sold: true },
  { id: 'frame_comet', kind: 'frame', rarity: 'rare', en: 'Comet', vi: 'Sao chổi', sold: true },
  { id: 'frame_nebula', kind: 'frame', rarity: 'epic', en: 'Nebula', vi: 'Tinh vân', sold: true },
  { id: 'frame_eclipse', kind: 'frame', rarity: 'legendary', en: 'Eclipse', vi: 'Nhật thực', sold: false },
];

const titles: Item[] = [
  { id: 'title_reader', kind: 'title', rarity: 'common', en: 'Night reader', vi: 'Người đọc đêm', sold: true },
  { id: 'title_steady', kind: 'title', rarity: 'common', en: 'Steady learner', vi: 'Học đều đặn', sold: true },
  { id: 'title_collector', kind: 'title', rarity: 'common', en: 'Word collector', vi: 'Người gom chữ', sold: true },
  { id: 'title_gazer', kind: 'title', rarity: 'rare', en: 'Stargazer', vi: 'Người ngắm sao', sold: true },
  { id: 'title_walker', kind: 'title', rarity: 'rare', en: 'Moon walker', vi: 'Kẻ dạo trăng', sold: true },
  { id: 'title_polyglot', kind: 'title', rarity: 'epic', en: 'Polyglot', vi: 'Đa ngôn', sold: true },
  // Earned only: by sets, the weekly boss.
  { id: 'title_zodiac', kind: 'title', rarity: 'epic', en: 'Keeper of the zodiac', vi: 'Người giữ hoàng đạo', sold: false },
  { id: 'title_north', kind: 'title', rarity: 'epic', en: 'North star', vi: 'Sao Bắc Cực', sold: false },
  { id: 'title_argo', kind: 'title', rarity: 'epic', en: 'Argonaut', vi: 'Thủy thủ Argo', sold: false },
  { id: 'title_hunt', kind: 'title', rarity: 'epic', en: 'Hunter', vi: 'Thợ săn', sold: false },
  { id: 'title_boss', kind: 'title', rarity: 'legendary', en: 'Boss slayer', vi: 'Diệt boss', sold: false },
];

const themes: Item[] = [
  { id: 'theme_dawn', kind: 'theme', rarity: 'rare', en: 'Dawn', vi: 'Bình minh', sold: true },
  { id: 'theme_aurora', kind: 'theme', rarity: 'rare', en: 'Aurora', vi: 'Cực quang', sold: true },
  { id: 'theme_ember', kind: 'theme', rarity: 'epic', en: 'Ember', vi: 'Than hồng', sold: true },
  { id: 'theme_lilac', kind: 'theme', rarity: 'epic', en: 'Lilac', vi: 'Tử đinh hương', sold: true },
];

const slots: Item[] = [
  { id: 'slot_bought', kind: 'slot', rarity: 'legendary', en: 'Companion slot', vi: 'Ô linh vật', sold: false },
  { id: 'slot_key', kind: 'slot', rarity: 'legendary', en: 'Companion slot key', vi: 'Chìa khóa ô linh vật', sold: false },
];

export const ITEMS: readonly Item[] = [...pets, ...cards, ...frames, ...titles, ...themes, ...slots];

const byId = new Map(ITEMS.map((item) => [item.id, item]));

export const itemById = (id: string): Item | undefined => byId.get(id);
export const petById = (id: string): Pet | undefined => PETS.find((pet) => pet.id === id);
