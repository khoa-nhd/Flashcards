/**
 * Organising vocabulary: collections, further examples, and relationships
 * between words. Names, limits and the few rules that both the browser and
 * the server need to agree on.
 *
 * Nothing here is inferred. A collection holds the words its owner put in it,
 * and two words are related only because their owner said so.
 */

/** The same limits the database checks. */
export const LIBRARY_LIMITS = { collectionName: 80, example: 2000, source: 300 } as const;

/**
 * The kinds of relationship. Each reads the same in both directions, so a
 * pair is stored once whichever word it was entered from.
 */
export const RELATION_KINDS = ['synonym', 'antonym', 'word_family', 'collocation', 'related', 'confused'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const RELATION_LABELS: Record<RelationKind, string> = {
  synonym: 'Synonym',
  antonym: 'Antonym',
  word_family: 'Word family',
  collocation: 'Collocation',
  related: 'Related',
  confused: 'Often confused with',
};

/** A name as stored: Unicode-normalised, trimmed, inner whitespace collapsed. */
export const tidyName = (name: string): string => name.normalize('NFC').trim().replace(/\s+/g, ' ');

/** The form two collection names are compared in: "IELTS" and "ielts " are the same collection. */
export const collectionKey = (name: string): string => tidyName(name).toLowerCase();

/**
 * The two ends of a relationship in the one order they are stored in, so
 * that entering it from either word gives the same row. `null` for a word
 * related to itself, which means nothing.
 */
export function orderPair(a: string, b: string): [low: string, high: string] | null {
  if (a === b) return null;
  return a < b ? [a, b] : [b, a];
}

export interface Collection {
  id: string;
  name: string;
  /** Live words in the collection. */
  wordIds: string[];
}

export interface ExtraExample {
  id: string;
  vocabularyId: string;
  sentence: string;
  /** Where the sentence came from, if the owner noted it. */
  source: string | null;
  /** Shown first among the word's further examples. At most one per word. */
  preferred: boolean;
}

export interface Relation {
  id: string;
  kind: RelationKind;
  /** The two related words. Their order carries no meaning. */
  a: string;
  b: string;
}

/** The word at the other end of a relationship from `id`, or `null` if `id` is not part of it. */
export function otherEnd(relation: Pick<Relation, 'a' | 'b'>, id: string): string | null {
  if (relation.a === id) return relation.b;
  if (relation.b === id) return relation.a;
  return null;
}
