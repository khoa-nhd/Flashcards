/**
 * Wording that depends on where the vocabulary is kept, so the app never
 * names a place the words are not in.
 */
import type { VocabularyListResponse } from '../../shared/api.js';

export type DataMode = VocabularyListResponse['mode'];

/** True only while the words really live in Notion. Unknown counts as "no". */
export const inNotion = (mode: DataMode | null | undefined): boolean => mode === 'notion';

/** `forNotion` while the words live in Notion, `otherwise` for every other store. */
export function wording<T>(mode: DataMode | null | undefined, forNotion: T, otherwise: T): T {
  return inNotion(mode) ? forNotion : otherwise;
}
