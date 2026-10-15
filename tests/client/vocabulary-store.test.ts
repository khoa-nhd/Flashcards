import { describe, expect, it, vi } from 'vitest';
import type { CreateEntryInput, VocabularyEntry, VocabularyListResponse } from '../../shared/api.js';
import { ApiError } from '../../src/lib/api-client.js';
import { DEFAULT_SETTINGS, createSettingsStore } from '../../src/lib/settings.js';
import { MAX_AGE_MS, createVocabularyStore } from '../../src/lib/vocabulary-store.js';
import { entry, vocabularyList } from '../helpers/fake-api.js';
import { deferred, pageId } from '../helpers/fixtures.js';

function setup(entries = [entry(1), entry(2)]) {
  let clock = 1_000_000;
  const fetchVocabulary = vi.fn(async () => vocabularyList(entries));
  const createEntry = vi.fn(async (input: CreateEntryInput) =>
    entry(99, { word: input.word, dateAdded: '2026-10-01' }),
  );
  const updateEntry = vi.fn(async (id: string) => {
    const found = entries.find((item) => item.id === id) ?? entry(1);
    return { ...found };
  });
  const deleteEntry = vi.fn(async () => {});
  const store = createVocabularyStore({ fetchVocabulary, createEntry, updateEntry, deleteEntry }, () => clock);
  return { store, fetchVocabulary, createEntry, updateEntry, deleteEntry, advance: (ms: number) => (clock += ms) };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('loading', () => {
  it('starts idle and loads on first use', async () => {
    const { store, fetchVocabulary } = setup();
    expect(store.getState().status).toBe('idle');
    store.ensureFresh();
    expect(store.getState().status).toBe('loading');
    await settled();
    expect(store.getState()).toMatchObject({ status: 'ready', refreshing: false, stale: false, error: null });
    expect(store.getState().entries.map((item) => item.id)).toEqual([entry(1).id, entry(2).id]);
    expect(store.getState().meta).toMatchObject({ writesEnabled: true, defaults: { mastery: 1 } });
    expect(fetchVocabulary).toHaveBeenCalledTimes(1);
  });

  it('does not fetch again when pages ask repeatedly, as on every tab switch', async () => {
    const { store, fetchVocabulary } = setup();
    store.ensureFresh();
    store.ensureFresh();
    await settled();
    store.ensureFresh();
    store.ensureFresh();
    await settled();
    expect(fetchVocabulary).toHaveBeenCalledTimes(1);
  });

  it('re-reads in the background once the data is old, keeping it on screen meanwhile', async () => {
    const { store, fetchVocabulary, advance } = setup();
    store.ensureFresh();
    await settled();
    advance(MAX_AGE_MS + 1);
    store.ensureFresh();
    expect(store.getState()).toMatchObject({ status: 'ready', refreshing: true });
    expect(store.getState().entries).toHaveLength(2);
    await settled();
    expect(store.getState().refreshing).toBe(false);
    expect(fetchVocabulary).toHaveBeenCalledTimes(2);
  });

  it('re-reads when marked stale, for example after a review was saved', async () => {
    const { store, fetchVocabulary } = setup();
    store.ensureFresh();
    await settled();
    store.markStale();
    expect(store.getState().stale).toBe(true);
    store.ensureFresh();
    await settled();
    expect(store.getState().stale).toBe(false);
    expect(fetchVocabulary).toHaveBeenCalledTimes(2);
  });

  it('reports a first-load failure and can be retried', async () => {
    const { store, fetchVocabulary } = setup();
    fetchVocabulary.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    store.ensureFresh();
    await settled();
    expect(store.getState()).toMatchObject({ status: 'error', error: { message: 'Could not reach the server.', unauthorized: false } });
    await store.reload();
    expect(store.getState().status).toBe('ready');
  });

  it('keeps the existing data when a refresh fails', async () => {
    const { store, fetchVocabulary } = setup();
    store.ensureFresh();
    await settled();
    fetchVocabulary.mockRejectedValueOnce(new ApiError('rate_limited', 'The database is temporarily unavailable.', 429));
    await store.reload();
    expect(store.getState()).toMatchObject({ status: 'ready', refreshing: false, error: { message: 'The database is temporarily unavailable.' } });
    expect(store.getState().entries).toHaveLength(2);
  });

  it('flags a missing password', async () => {
    const { store, fetchVocabulary } = setup();
    fetchVocabulary.mockRejectedValueOnce(new ApiError('unauthorized', 'Enter the access password.', 401));
    store.ensureFresh();
    await settled();
    expect(store.getState().error?.unauthorized).toBe(true);
  });

  it('shares one request between simultaneous reloads', async () => {
    const { store, fetchVocabulary } = setup();
    await Promise.all([store.reload(), store.reload(), store.reload()]);
    expect(fetchVocabulary).toHaveBeenCalledTimes(1);
  });
});

describe('local changes', () => {
  it('adds a newly created word at the top and replaces an edited one in place', async () => {
    const { store } = setup();
    await store.reload();
    store.upsert(entry(3, { word: 'new' }));
    store.upsert(entry(1, { word: 'edited' }));
    expect(store.getState().entries.map((item) => item.word)).toEqual(['new', 'edited', 'word-2']);
  });

  it('removes a deleted word', async () => {
    const { store } = setup();
    await store.reload();
    store.remove(entry(1).id);
    expect(store.getState().entries.map((item) => item.id)).toEqual([entry(2).id]);
  });

  it('notifies subscribers of every change and stops after unsubscribing', async () => {
    const { store } = setup();
    await store.reload();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.upsert(entry(3));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.remove(entry(3).id);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not let a response that started earlier undo a newer change', async () => {
    const { store, fetchVocabulary } = setup();
    await store.reload();

    // A slow refresh is in flight when a word is added.
    const slow = deferred<VocabularyListResponse>();
    fetchVocabulary.mockReturnValueOnce(slow.promise);
    fetchVocabulary.mockResolvedValueOnce(vocabularyList([entry(9, { word: 'added' }), entry(1), entry(2)]));
    const reloading = store.reload();
    store.upsert(entry(9, { word: 'added' }));

    // The stale snapshot, taken before the word existed, arrives.
    slow.resolve(vocabularyList([entry(1), entry(2)]));
    await reloading;

    expect(store.getState().entries.map((item) => item.word)).toEqual(['added', 'word-1', 'word-2']);
    // It was discarded and the list read again.
    expect(fetchVocabulary).toHaveBeenCalledTimes(3);
  });
});

describe('optimistic writes', () => {
  it('adds a word at once and replaces it with the stored record', async () => {
    const { store, createEntry } = setup();
    await store.reload();
    const pending = deferred<VocabularyEntry>();
    createEntry.mockReturnValueOnce(pending.promise);

    const { localId, result } = store.create({ word: 'luminous', requestId: 'r1' });
    expect(store.getState().entries[0]?.word).toBe('luminous');
    expect(store.getState().pending).toEqual([{ id: localId, operation: 'create', status: 'saving', error: null }]);
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1' }));

    pending.resolve(entry(50, { word: 'luminous' }));
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(store.getState().entries[0]?.id).toBe(pageId(50));
    expect(store.getState().entries.map((item) => item.word)).toEqual(['luminous', 'word-1', 'word-2']);
    expect(store.getState().pending).toHaveLength(0);
  });

  it('takes an added word back out when the database refuses it', async () => {
    const { store, createEntry } = setup();
    await store.reload();
    createEntry.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));

    const { localId, result } = store.create({ word: 'zeal', requestId: 'r1' });
    expect(store.getState().entries.some((item) => item.word === 'zeal')).toBe(true);

    const outcome = await result;
    expect(outcome).toMatchObject({ ok: false, code: 'forbidden', message: 'The database refused this change.' });
    expect(store.getState().entries.some((item) => item.word === 'zeal')).toBe(false);
    expect(store.getState().pending).toEqual([
      { id: localId, operation: 'create', status: 'failed', error: 'The database refused this change.' },
    ]);
  });

  it('sends a failed word again under the same request id', async () => {
    const { store, createEntry } = setup();
    await store.reload();
    createEntry.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    const { localId, result } = store.create({ word: 'zeal', requestId: 'r1' });
    await result;

    createEntry.mockResolvedValueOnce(entry(50, { word: 'zeal' }));
    const retried = store.retry(localId);
    expect(retried).not.toBeNull();
    expect(store.getState().entries.some((item) => item.word === 'zeal')).toBe(true);

    await expect(retried).resolves.toMatchObject({ ok: true });
    expect(store.getState().entries[0]?.id).toBe(pageId(50));
    expect(createEntry.mock.calls.every((call) => call[0].requestId === 'r1')).toBe(true);
    expect(store.getState().pending).toHaveLength(0);
  });

  it('keeps a word that is still being saved when the list is read again', async () => {
    const { store, createEntry } = setup();
    await store.reload();
    const pending = deferred<VocabularyEntry>();
    createEntry.mockReturnValueOnce(pending.promise);

    const { result } = store.create({ word: 'luminous', requestId: 'r1' });
    await store.reload();
    expect(store.getState().entries.some((item) => item.word === 'luminous')).toBe(true);

    pending.resolve(entry(50, { word: 'luminous' }));
    await result;
    expect(store.getState().entries.some((item) => item.word === 'luminous')).toBe(true);
  });

  it('applies an edit at once and undoes it when the database refuses', async () => {
    const { store, updateEntry } = setup();
    await store.reload();
    updateEntry.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));

    const { entry: optimistic, result } = store.update(pageId(1), { meaning: 'mới' });
    expect(optimistic.meaning).toBe('mới');
    expect(store.getState().entries.find((item) => item.id === pageId(1))?.meaning).toBe('mới');

    await expect(result).resolves.toMatchObject({ ok: false, code: 'forbidden' });
    expect(store.getState().entries.find((item) => item.id === pageId(1))?.meaning).toBe('nghĩa 1');
  });

  it('takes a word out at once and puts it back when the database refuses', async () => {
    const { store, deleteEntry } = setup();
    await store.reload();
    deleteEntry.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));

    const { result } = store.trash(pageId(1));
    expect(store.getState().entries.some((item) => item.id === pageId(1))).toBe(false);

    await expect(result).resolves.toMatchObject({ ok: false, code: 'forbidden' });
    expect(store.getState().entries.some((item) => item.id === pageId(1))).toBe(true);
  });

  it('clears a failed write the user gives up on', async () => {
    const { store, createEntry } = setup();
    await store.reload();
    createEntry.mockRejectedValueOnce(new ApiError('forbidden', 'no'));
    const { localId, result } = store.create({ word: 'zeal', requestId: 'r1' });
    await result;
    expect(store.getState().pending).toHaveLength(1);

    store.dismiss(localId);
    expect(store.getState().pending).toHaveLength(0);
    expect(store.retry(localId)).toBeNull();
  });
});

describe('preferences', () => {
  const memoryStorage = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
  };

  it('start from the defaults', () => {
    expect(createSettingsStore(memoryStorage()).getState()).toEqual(DEFAULT_SETTINGS);
  });

  it('persist changes and read them back', () => {
    const storage = memoryStorage();
    createSettingsStore(storage).update({ bankView: 'list', bankPageSize: 25, reduceMotion: true });
    expect(createSettingsStore(storage).getState()).toMatchObject({ bankView: 'list', bankPageSize: 25, reduceMotion: true });
  });

  it('fall back to defaults for corrupt or unknown stored values', () => {
    const storage = memoryStorage();
    storage.data.set('vocabulary-review:settings:v1', '{not json');
    expect(createSettingsStore(storage).getState()).toEqual(DEFAULT_SETTINGS);
    storage.data.set('vocabulary-review:settings:v1', JSON.stringify({ bankView: 'grid', bankPageSize: 7 }));
    expect(createSettingsStore(storage).getState()).toEqual(DEFAULT_SETTINGS);
  });

  it('keep valid stored values when a newer setting is missing from storage', () => {
    const storage = memoryStorage();
    storage.data.set('vocabulary-review:settings:v1', JSON.stringify({ bankView: 'list' }));
    expect(createSettingsStore(storage).getState()).toEqual({ ...DEFAULT_SETTINGS, bankView: 'list' });
  });

  it('ignore an invalid update and work without any storage', () => {
    const store = createSettingsStore(null);
    store.update({ bankPageSize: 7 as never });
    expect(store.getState()).toEqual(DEFAULT_SETTINGS);
    store.update({ dashboardDays: 90 });
    expect(store.getState().dashboardDays).toBe(90);
    store.reset();
    expect(store.getState()).toEqual(DEFAULT_SETTINGS);
  });

  it('never stores anything but display preferences', () => {
    const storage = memoryStorage();
    createSettingsStore(storage).update({ bankView: 'list' });
    const stored = JSON.parse([...storage.data.values()][0] ?? '{}');
    expect(Object.keys(stored).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});
