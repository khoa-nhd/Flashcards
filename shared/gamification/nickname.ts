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
