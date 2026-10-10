/**
 * The form of a word used to decide whether two entries are "the same word":
 * Unicode-normalised, trimmed, inner whitespace collapsed, case-insensitive.
 */
export function normalizeWord(word: string): string {
  return word.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Trims and collapses whitespace without changing case; what gets stored as the word. */
export function tidyWord(word: string): string {
  return word.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Case-insensitive partial match of `query` against any of the given texts. */
export function matchesQuery(query: string, texts: ReadonlyArray<string | null>): boolean {
  const needle = normalizeWord(query);
  if (needle === '') return true;
  return texts.some((text) => text !== null && normalizeWord(text).includes(needle));
}
