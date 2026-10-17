/**
 * The reviewer's own choice of whether a review moves a word. It belongs to the
 * account, is kept on this device as well, and outlives a connection that is
 * not there and a reply that arrives out of order.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCountingPreference } from '../../src/lib/counting-preference.js';
import { createMemoryStore } from '../../src/lib/offline/storage.js';

const KEY = 'acc:preference:counting';

function setup(save: (value: boolean) => Promise<unknown> = async () => ({})) {
  const store = createMemoryStore();
  const saver = vi.fn(save);
  const counting = createCountingPreference({ store, accountId: 'acc', save: saver });
  return { store, save: saver, counting };
}

describe('whether a review counts towards mastery', () => {
  it('counts by default, and remembers a change on this device', async () => {
    const { store, counting } = setup();
    expect(counting.get()).toBe(true);

    counting.set(false);
    expect(counting.get()).toBe(false);
    await vi.waitFor(async () => expect(await store.kv.get(KEY)).toMatchObject({ value: false }));
  });

  it('tells anything watching when the choice changes', () => {
    const { counting } = setup();
    const listener = vi.fn();
    const unsubscribe = counting.subscribe(listener);

    counting.set(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    counting.set(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('starts from the copy this device kept, and writes a change through to the account', async () => {
    const store = createMemoryStore();
    await store.kv.put(KEY, { value: false, pending: false });
    const save = vi.fn(async () => ({}));
    const counting = createCountingPreference({ store, accountId: 'acc', save });

    await vi.waitFor(() => expect(counting.get()).toBe(false));
    counting.set(true);
    expect(save).toHaveBeenCalledWith(true);
    // Sent, and marked as no longer waiting to be sent.
    await vi.waitFor(async () => expect(await store.kv.get(KEY)).toEqual({ value: true, pending: false }));
  });

  it('takes the account’s stored choice when nothing has been chosen here', async () => {
    const { counting } = setup();
    counting.adopt(false);
    expect(counting.get()).toBe(false);
  });

  it('starts the weakest words from off without telling the account', async () => {
    const { counting, save, store } = setup();
    counting.preset(false);
    expect(counting.get()).toBe(false);
    // Nobody chose this, so the account is told nothing…
    expect(save).not.toHaveBeenCalled();
    // …though it is what the reviewer sees, so it is kept here.
    await vi.waitFor(async () => expect(await store.kv.get(KEY)).toMatchObject({ value: false }));

    // The flip is the reviewer's own, and that one is remembered.
    counting.set(true);
    expect(save).toHaveBeenCalledWith(true);
  });

  it('does not read the account’s value over a starting point the screen chose', () => {
    const { counting } = setup();
    counting.preset(false);
    counting.adopt(true);
    expect(counting.get()).toBe(false);
  });

  it('keeps a change made here when the account stored something older', async () => {
    const { counting } = setup();
    counting.set(false);
    // The read of the account started before the flip and lands after it.
    counting.adopt(true);
    expect(counting.get()).toBe(false);
  });

  it('holds a change the account could not be told about, and sends it when it next can', async () => {
    const { counting, save } = setup(async () => {
      // As in the sample data, which has no account to keep settings in.
      throw new Error('not_editable');
    });
    counting.set(false);
    expect(counting.get()).toBe(false);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    // The account is read again — a later attempt — and the waiting change wins.
    counting.adopt(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(counting.get()).toBe(false);
    expect(save).toHaveBeenLastCalledWith(false);
  });

  it('does not put an older value back when a reply arrives after another flip', async () => {
    const replies: Array<{ value: boolean; resolve: () => void }> = [];
    const { counting } = setup(
      (value) =>
        new Promise<void>((resolve) => {
          replies.push({ value, resolve });
        }),
    );

    counting.set(false);
    counting.set(true);
    // The first send is answered last: it must not undo the newer choice.
    replies[0]!.resolve();
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(counting.get()).toBe(true);
    counting.adopt(false);
    expect(counting.get()).toBe(true);
  });
});
