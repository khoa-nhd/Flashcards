/**
 * Words a nickname may not contain (docs/gamification-plan.md, 2.1), English
 * and Vietnamese. Names are compared after lower-casing, dropping accents and
 * squeezing repeated letters, so "Fuuuck" and "đjt" are caught.
 *
 * Some Vietnamese swear words are ordinary words once their accents go
 * ("lồn" and "lớn", "cặc" and "các"), so those are matched with their accents
 * kept. Short words are matched as whole words only, so "class" and "grape"
 * are fine.
 */

/** Matched anywhere in the name, accents dropped. */
const ANYWHERE = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'whore',
  'slut',
  'asshole',
  'bastard',
  'porn',
  'penis',
  'vagina',
  'pussy',
  'hitler',
  'nazi',
  'ditme',
  'ditcon',
  'dume',
  'dcm',
  'dkm',
  'vcl',
  'vkl',
  'occho',
  'chode',
];

/** Matched as whole words only, accents dropped. */
const WHOLE = ['ass', 'dick', 'cock', 'cum', 'sex', 'rape', 'dm', 'dmm', 'cmm', 'dit', 'djt', 'vl', 'clm', 'duma'];

/** Matched as whole words with their accents kept. */
const WITH_ACCENTS = ['lồn', 'cặc', 'buồi', 'đéo', 'địt', 'đụ', 'đĩ', 'cứt'];

/** Names that would pass for the app or its staff. */
const RESERVED = ['admin', 'administrator', 'moderator', 'mod', 'support', 'staff', 'system', 'flashcards', 'official'];

const squeeze = (text: string) => text.replace(/(.)\1+/gu, '$1');

/** Lower case, without accents (đ is d), repeated letters squeezed. */
export function plain(text: string): string {
  return squeeze(text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd'));
}

const words = (text: string) => text.split(/[\s_]+/u).filter(Boolean);

/** Whether a name contains a word on the list, or is a reserved name. */
export function isBlocked(name: string): boolean {
  const flat = plain(name);
  const joined = flat.replace(/[\s_]+/gu, '');
  if (ANYWHERE.some((word) => joined.includes(plain(word).replace(/\s/g, '')))) return true;
  const plainWords = words(flat).map((word) => word.replace(/\d+/g, ''));
  if (WHOLE.some((word) => plainWords.includes(plain(word)))) return true;
  const accented = words(squeeze(name.toLowerCase().normalize('NFC')));
  if (WITH_ACCENTS.some((word) => accented.includes(word))) return true;
  return RESERVED.some((word) => plainWords.includes(word) || joined === word);
}
