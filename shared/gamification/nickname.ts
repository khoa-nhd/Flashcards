/**
 * Nicknames (docs/gamification-plan.md, 2.1): what everyone else sees instead
 * of an email. A new account gets a random one like "Cú Đêm 4821"; bots in the
 * leagues get theirs the same way, so nothing tells them apart.
 */
import { isBlocked } from './blocklist.js';
import { seededRandom } from './quests.js';

export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 20;

export type NicknameProblem = 'length' | 'characters' | 'blocked';

/** Spaces trimmed and squeezed, in one Unicode form, so equal names compare equal. */
export function tidyNickname(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** What is wrong with a nickname, or null when it can be used. Taken names are the database's to say. */
export function nicknameProblem(name: string): NicknameProblem | null {
  const tidy = tidyNickname(name);
  const length = [...tidy].length;
  if (length < NICKNAME_MIN || length > NICKNAME_MAX) return 'length';
  if (!/^[\p{L}\p{N}_ ]+$/u.test(tidy)) return 'characters';
  if (isBlocked(tidy)) return 'blocked';
  return null;
}

const ANIMALS = [
  'Cú',
  'Mèo',
  'Cáo',
  'Sói',
  'Hổ',
  'Gấu',
  'Thỏ',
  'Rùa',
  'Cá Voi',
  'Đom Đóm',
  'Chim Sẻ',
  'Hươu',
  'Rái Cá',
  'Sóc',
  'Gấu Trúc',
  'Cò',
  'Chồn',
  'Sẻ',
  'Hạc',
  'Cá Heo',
  'Báo',
  'Nai',
  'Ếch',
  'Bướm',
];
const TRAITS = ['Đêm', 'Trăng', 'Sao', 'Mây', 'Gió', 'Sương', 'Bạc', 'Nhỏ', 'Vui', 'Lặng', 'Chăm', 'Nhanh', 'Xanh', 'Mơ'];

/** A random nickname, the same for the same seed. */
export function randomNickname(seed: string): string {
  const random = seededRandom(`nickname:${seed}`);
  const animal = ANIMALS[Math.floor(random() * ANIMALS.length)]!;
  const trait = TRAITS[Math.floor(random() * TRAITS.length)]!;
  const number = 1000 + Math.floor(random() * 9000);
  return `${animal} ${trait} ${number}`;
}

// ---- Rivals' handles ----
// League rivals are named like players on chess and game sites: handles, not
// the Vietnamese animal names new accounts start with.

const HANDLE_WORDS = [
  'Knight', 'Rook', 'Bishop', 'Pawn', 'Gambit', 'Blitz', 'Endgame', 'Castle', 'Checkmate', 'Zugzwang',
  'Shadow', 'Ghost', 'Ninja', 'Viper', 'Falcon', 'Raven', 'Wolf', 'Tiger', 'Panda', 'Otter', 'Fox', 'Koala',
  'Pixel', 'Byte', 'Glitch', 'Turbo', 'Nova', 'Comet', 'Nebula', 'Quasar', 'Orbit', 'Rocket',
  'Taco', 'Waffle', 'Pickle', 'Noodle', 'Mango', 'Biscuit', 'Muffin', 'Nacho', 'Bagel',
  'Storm', 'Frost', 'Blaze', 'Ember', 'Thunder', 'Echo', 'Drift', 'Sage', 'Rune', 'Wizard', 'Bard', 'Rogue',
];
const HANDLE_ADJECTIVES = [
  'Silent', 'Lazy', 'Sneaky', 'Crispy', 'Salty', 'Spicy', 'Sleepy', 'Lucky', 'Angry', 'Fuzzy', 'Cosmic',
  'Mighty', 'Tiny', 'Grumpy', 'Swift', 'Clumsy', 'Brave', 'Wild', 'Frozen', 'Golden', 'Dark', 'Happy',
];
const FIRST_NAMES = [
  'alex', 'sam', 'max', 'leo', 'mia', 'zoe', 'liam', 'noah', 'emma', 'lucas', 'nina', 'omar', 'yuki', 'ivan',
  'sofia', 'diego', 'arjun', 'mateo', 'elena', 'kai', 'ravi', 'chloe', 'felix', 'hana', 'jonas', 'luca',
];
const SUFFIXES = ['gg', 'pro', 'xd', 'yt', 'tv', 'og', 'irl', 'fan', 'main', 'king', 'queen', 'lol'];

/** A gamer-style handle, the same for the same seed, such as "SneakyRook_42" or "noah2009". */
export function botNickname(seed: string): string {
  const random = seededRandom(`handle:${seed}`);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const digits = (low: number, high: number) => String(low + Math.floor(random() * (high - low)));
  const word = pick(HANDLE_WORDS);
  const shapes = [
    () => `${pick(HANDLE_ADJECTIVES)}${word}`,
    () => `${pick(HANDLE_ADJECTIVES)}${word}${digits(1, 100)}`,
    () => `${word}_${digits(1, 1000)}`,
    () => `${pick(FIRST_NAMES)}${digits(1990, 2013)}`,
    () => `${pick(FIRST_NAMES)}_${word.toLowerCase()}`,
    () => `xX_${word}_Xx`,
    () => `${word.toLowerCase()}${pick(SUFFIXES)}`,
    () => `The${word}${digits(1, 10)}`,
    () => `${pick(FIRST_NAMES)}_${pick(SUFFIXES)}`,
    () => `${word}${word === 'Pawn' ? 'Storm' : 'Master'}${digits(1, 100)}`,
    () => `not_${pick(FIRST_NAMES)}`,
    () => `${pick(HANDLE_ADJECTIVES).toLowerCase()}_${word.toLowerCase()}${digits(1, 100)}`,
  ];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const handle = pick(shapes)();
    if (nicknameProblem(handle) === null) return handle;
  }
  return `${word}${digits(10, 100)}`;
}
