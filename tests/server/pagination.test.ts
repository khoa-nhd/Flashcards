import { describe, expect, it, vi } from 'vitest';
import { collectPaginated } from '../../server/notion/pagination.js';

const page = (results: unknown[], next: string | null) => ({ results, has_more: next !== null, next_cursor: next });

describe('collectPaginated', () => {
  it('returns a single page as is', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([1, 2], null));
    await expect(collectPaginated(fetchPage)).resolves.toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(undefined);
  });

  it('follows every cursor and keeps results in order', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page(['a', 'b'], 'c1'))
      .mockResolvedValueOnce(page(['c'], 'c2'))
      .mockResolvedValueOnce(page(['d'], null));
    await expect(collectPaginated(fetchPage)).resolves.toEqual(['a', 'b', 'c', 'd']);
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'c1', 'c2']);
  });

  it('handles an empty result', async () => {
    await expect(collectPaginated(async () => page([], null))).resolves.toEqual([]);
  });

  it('fails rather than return a truncated list when the cursor is missing', async () => {
    const broken = { results: [1], has_more: true, next_cursor: null };
    await expect(collectPaginated(async () => broken)).rejects.toThrow(/no cursor/);
  });

  it('fails on a repeating cursor instead of looping forever', async () => {
    await expect(collectPaginated(async () => page([1], 'same'))).rejects.toThrow(/same cursor/);
  });

  it('fails on a malformed response', async () => {
    await expect(collectPaginated(async () => ({ results: 'nope' }))).rejects.toThrow(/malformed/);
  });

  it('stops at the page limit', async () => {
    let n = 0;
    await expect(collectPaginated(async () => page([n], `c${n++}`), { maxPages: 3 })).rejects.toThrow(/3 pages/);
  });

  it('propagates a failure from any page', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(page([1], 'c1')).mockRejectedValueOnce(new Error('boom'));
    await expect(collectPaginated(fetchPage)).rejects.toThrow('boom');
  });
});
