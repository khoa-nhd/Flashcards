/**
 * Finding the sentence that holds a word, for the Smart Reader. The reader
 * pastes a passage and picks a word; the app needs the sentence around it to
 * use as the card's example. This runs on the server before anything is sent
 * to a language model, so the model only ever sees one sentence — cheaper,
 * and it cannot invent context that was never there.
 *
 * Deliberately simple: a phrase match with word edges, then the sentence
 * boundaries nearest around it. Not a linguist — a reader's approximation.
 */

/** As text is kept in an example: spaces collapsed, nothing trimmed away but the ends. */
const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The phrase with its edges: letters and digits, not punctuation, touch a word. */
const edges = (phrase: string) => {
  const left = /^[A-Za-zÀ-ɏ]/.test(phrase) ? '\\b' : '';
  const right = /[A-Za-zÀ-ɏ0-9]$/.test(phrase) ? '\\b' : '';
  return `${left}${escaped(phrase)}${right}`;
};

/** Where a sentence ends: a full stop, question or exclamation, then a space or line break. */
const END = /[.!?]["'”’)\]]?(?=\s|$)/g;

/**
 * The sentence containing `phrase` in `text`, tidied for use as an example:
 * collapsed spaces, no line breaks. The surrounding sentence is kept exactly
 * as written, so nothing about the wording is the app's invention.
 * `null` when the phrase is not in the text, or no sentence boundary fits.
 */
export function sentenceContaining(text: string, phrase: string): string | null {
  const needle = tidy(phrase);
  if (needle === '') return null;
  const found = new RegExp(edges(needle), 'i').exec(text);
  if (found === null) return null;
  const from = found.index;
  const to = from + found[0].length;

  // The last sentence end before the phrase, and the first at or after its end.
  let start = 0;
  END.lastIndex = 0;
  for (let match = END.exec(text); match !== null; match = END.exec(text)) {
    if (match.index >= from) break;
    start = match.index + match[0].length;
  }
  let end = text.length;
  END.lastIndex = to;
  const after = END.exec(text);
  if (after !== null) end = after.index + after[0].length;

  const sentence = text.slice(start, end).trim();
  if (sentence === '') return null;
  const tidyed = sentence.replace(/\s+/g, ' ').trim();
  // A cap: an unnaturally long "sentence" (a list, a wall of text) is not usable as an example.
  return tidyed.length > 1000 ? null : tidyed;
}
