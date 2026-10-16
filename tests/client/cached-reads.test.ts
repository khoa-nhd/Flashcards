/**
 * The reads that survive a lost connection: only a failure to reach the server
 * is answered from this device's copy, and a copy that is too old — or from
 * another day, where the day decides what is shown — is not used at all.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsResponse } from '../../shared/api.js';
import { ApiError, type AppApi } from '../../src/lib/api-client.js';
import { withCachedReads } from '../../src/lib/offline/cached-api.js';
import { createMemoryStore } from '../../src/lib/offline/storage.js';
import { entry } from '../helpers/fake-api.js';
import { pageId } from '../helpers/fixtures.js';

const unreachable = () => new ApiError('network', 'Could not reach the server.');

function setup() {
  let clock = new Date(2026, 9, 9, 12, 0, 0).getTime();
  const store = createMemoryStore();
  const api = {
    fetchAnalytics: vi.fn(async () => ({ ok: true }) as unknown as AnalyticsResponse),
    fetchEntry: vi.fn(async (id: string) => entry(Number(id.slice(-12)))),
    fetchVocabulary: vi.fn(async () => ({ entries: [] })),
    createEntry: vi.fn(async () => entry(9)),
    submitAction: vi.fn(async () => ({ outcome: 'applied', state: null })),
  };
  const wrapped = withCachedReads(api as unknown as AppApi, { store, accountId: 'acc', now: () => clock });
  return {
    api,
    wrapped,
    advance(days: number) {
      clock += days * 24 * 60 * 60 * 1000;
    },
  };
}

describe('reads that survive a lost connection', () => {
  it('serves the last read when the server cannot be reached', async () => {
    const { api, wrapped } = setup();
    const first = await wrapped.fetchAnalytics();
    expect(api.fetchAnalytics).toHaveBeenCalledTimes(1);

    api.fetchAnalytics.mockRejectedValueOnce(unreachable());
    await expect(wrapped.fetchAnalytics()).resolves.toEqual(first);
  });

  it('keeps throwing a refusal instead of answering it from the copy', async () => {
    const { api, wrapped } = setup();
    await wrapped.fetchAnalytics();
    api.fetchAnalytics.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));
    await expect(wrapped.fetchAnalytics()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('never shows yesterday’s copy of something that depends on the day', async () => {
    const { api, wrapped, advance } = setup();
    await wrapped.fetchAnalytics();
    advance(1);
    api.fetchAnalytics.mockRejectedValueOnce(unreachable());
    await expect(wrapped.fetchAnalytics()).rejects.toMatchObject({ code: 'network' });
  });

  it('stops using a copy that is over a week old', async () => {
    const { api, wrapped, advance } = setup();
    await wrapped.fetchEntry(pageId(1));
    advance(6);
    // A word read is not tied to a day; within the week it is still useful.
    api.fetchEntry.mockRejectedValueOnce(unreachable());
    await expect(wrapped.fetchEntry(pageId(1))).resolves.toMatchObject({ id: pageId(1) });

    advance(2);
    api.fetchEntry.mockRejectedValueOnce(unreachable());
    await expect(wrapped.fetchEntry(pageId(1))).rejects.toMatchObject({ code: 'network' });
  });

  it('keeps reads apart by their arguments', async () => {
    const { api, wrapped } = setup();
    const kept = await wrapped.fetchEntry(pageId(1));
    api.fetchEntry.mockRejectedValueOnce(unreachable());
    await expect(wrapped.fetchEntry(pageId(2))).rejects.toMatchObject({ code: 'network' });

    api.fetchEntry.mockRejectedValueOnce(unreachable());
    await expect(wrapped.fetchEntry(pageId(1))).resolves.toMatchObject({ id: kept.id });
  });

  it('never mixes one account’s copy into another’s', async () => {
    const { api, wrapped } = setup();
    await wrapped.fetchAnalytics();

    const store = createMemoryStore();
    const other = withCachedReads(api as unknown as AppApi, { store, accountId: 'other' });
    api.fetchAnalytics.mockRejectedValueOnce(unreachable());
    await expect(other.fetchAnalytics()).rejects.toMatchObject({ code: 'network' });
  });

  it('leaves the queue, the vocabulary and every write alone', () => {
    const { api, wrapped } = setup();
    const untouched = api as unknown as Record<string, unknown>;
    for (const name of ['fetchVocabulary', 'createEntry', 'submitAction'] as const) {
      expect(wrapped[name]).toBe(untouched[name]);
    }
  });
});
