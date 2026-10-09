import { z } from 'zod';

export const listPageSchema = z.object({
  results: z.array(z.unknown()),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

export type ListPage = z.infer<typeof listPageSchema>;

/**
 * Follows `next_cursor` until Notion reports no more results. Stops loudly on
 * a malformed or repeating cursor instead of looping or returning a partial
 * queue that looks complete.
 */
export async function collectPaginated(
  fetchPage: (cursor: string | undefined) => Promise<unknown>,
  { maxPages = 500 }: { maxPages?: number } = {},
): Promise<unknown[]> {
  const results: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const parsed = listPageSchema.safeParse(await fetchPage(cursor));
    if (!parsed.success) throw new Error('Notion returned a malformed list response.');
    results.push(...parsed.data.results);

    if (!parsed.data.has_more) return results;
    const next = parsed.data.next_cursor;
    if (next === null) throw new Error('Notion reported more results but gave no cursor.');
    if (seenCursors.has(next)) throw new Error('Notion returned the same cursor twice.');
    seenCursors.add(next);
    cursor = next;
  }

  throw new Error(`Stopped after ${maxPages} pages of Notion results.`);
}
