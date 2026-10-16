import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client.js';
import { createMemoryStore, type LocalStore, type OutboxRecord } from '../../src/lib/offline/storage.js';
import { createSyncEngine, type SyncEngine, type SyncEvent } from '../../src/lib/offline/sync-engine.js';

const engines: SyncEngine[] = [];

/** An engine whose clock the test moves: backoff then only passes when asked. */
type TestEngine = SyncEngine & { advance(ms: number): void };

function engine(sender: (op: OutboxRecord) => Promise<unknown>, store: LocalStore = createMemoryStore()): TestEngine {
  let clock = 1_000_000;
  const created = createSyncEngine({
    accountId: 'account-1',
    store,
    sender,
    now: () => clock,
    backoffMs: { base: 1_000, max: 60_000 },
  });
  engines.push(created);
  return Object.assign(created, {
    advance: (ms: number) => {
      clock += ms;
    },
  });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await flush();
};

afterEach(() => {
  for (const running of engines.splice(0)) running.stop();
});

describe('enqueue and send', () => {
  it('stores an operation, sends it, and forgets it once the server takes it', async () => {
    const sent: OutboxRecord[] = [];
    const sync = engine(async (op) => {
      sent.push(op);
      return { outcome: 'applied', state: { mastery: 4, nextReview: '2026-10-13' } };
    });
    await sync.ready();
    const id = sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    expect(sent.map((op) => op.id)).toEqual([id]);
    expect(sent[0]).toMatchObject({ accountId: 'account-1', status: 'syncing', attempts: 0 });
    expect(await sync.ops()).toEqual([]);
    expect(sync.getState()).toMatchObject({ pending: 0, refused: 0 });
  });

  it('hands the server answer to listeners, once', async () => {
    const events: SyncEvent[] = [];
    const sync = engine(async () => ({ outcome: 'applied', state: { mastery: 2, nextReview: null } }));
    sync.subscribeEvents((event) => events.push(event));
    await sync.ready();
    sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'settled', value: { outcome: 'applied' } });
  });

  it('persists an operation before it is sent', async () => {
    const store = createMemoryStore();
    let storedWhenSent = 0;
    const sync = engine(async () => {
      storedWhenSent = (await store.outbox.list('account-1')).length;
      return {};
    }, store);
    await sync.ready();
    sync.enqueue({ kind: 'practice', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    expect(storedWhenSent).toBe(1);
  });

  it('keeps the order the operations were made in', async () => {
    const order: string[] = [];
    const sync = engine(async (op) => {
      order.push(String(op.payload.pageId));
      return {};
    });
    await sync.ready();
    for (const pageId of ['a', 'b', 'c']) sync.enqueue({ kind: 'review_action', payload: { pageId }, entity: pageId });
    await settle(8);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('retrying', () => {
  it('keeps an operation the server could not be reached for, and sends it again', async () => {
    let attempts = 0;
    const sync = engine(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError('network', 'Could not reach the server.');
      return { outcome: 'applied' };
    });
    await sync.ready();
    sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    const [waiting] = await sync.ops();
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1, lastError: 'Could not reach the server.' });
    expect(sync.getState()).toMatchObject({ pending: 1, lastError: 'Could not reach the server.' });

    // Nothing is attempted again until the backoff has passed; then whatever
    // wakes the pump — the timer, going online, or opening the tab — sends it.
    sync.kick();
    await settle();
    expect(attempts).toBe(1);
    sync.advance(60_000);
    sync.kick();
    await settle();
    expect(attempts).toBe(2);
    expect(await sync.ops()).toEqual([]);
  });

  it('waits for the word before sending a later operation about it', async () => {
    const releases: Array<() => void> = [];
    const sent: string[] = [];
    const sync = engine(async (op) => {
      const label = op.payload.step as string;
      sent.push(label);
      if (label === 'first') await new Promise<void>((resolve) => releases.push(resolve));
      return {};
    });
    await sync.ready();
    sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1', step: 'first' }, entity: 'card-1' });
    sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1', step: 'second' }, entity: 'card-1' });
    await settle();
    expect(sent).toEqual(['first']);
    releases.shift()?.();
    await settle();
    expect(sent).toEqual(['first', 'second']);
  });

  it('does not let one refused word block a different word', async () => {
    const sent: string[] = [];
    const sync = engine(async (op) => {
      sent.push(String(op.payload.pageId));
      if (op.payload.pageId === 'bad') throw new ApiError('conflict', 'Changed elsewhere.', 409);
      return {};
    });
    await sync.ready();
    sync.enqueue({ kind: 'review_action', payload: { pageId: 'bad' }, entity: 'bad' });
    sync.enqueue({ kind: 'review_action', payload: { pageId: 'good' }, entity: 'good' });
    await settle(6);
    expect(sent).toEqual(['bad', 'good']);
    expect(await sync.ops()).toHaveLength(1);
  });
});

describe('refusals', () => {
  it('keeps a refused operation visible and does not send it again by itself', async () => {
    const sender = vi.fn(async () => {
      throw new ApiError('conflict', 'This card was changed after it was loaded.', 409);
    });
    const events: SyncEvent[] = [];
    const sync = engine(sender);
    sync.subscribeEvents((event) => events.push(event));
    await sync.ready();
    sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    sync.kick();
    await settle();
    expect(sender).toHaveBeenCalledTimes(1);
    const [refused] = await sync.ops();
    expect(refused).toMatchObject({ status: 'failed', lastErrorCode: 'conflict' });
    expect(sync.getState()).toMatchObject({ refused: 1, pending: 0 });
    expect(events.map((event) => event.type)).toEqual(['refused']);
  });

  it('sends a refused operation again when asked to retry', async () => {
    let refuse = true;
    const sync = engine(async () => {
      if (refuse) throw new ApiError('conflict', 'Changed elsewhere.', 409);
      return { outcome: 'applied' };
    });
    await sync.ready();
    const id = sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    refuse = false;
    sync.retry(id);
    await settle();
    expect(await sync.ops()).toEqual([]);
    expect(sync.getState()).toMatchObject({ refused: 0, pending: 0 });
  });

  it('drops a refused operation when the person dismisses it', async () => {
    const events: SyncEvent[] = [];
    const sync = engine(async () => {
      throw new ApiError('not_found', 'That card is not in your vocabulary.', 404);
    });
    sync.subscribeEvents((event) => events.push(event));
    await sync.ready();
    const id = sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    sync.dismiss(id);
    await settle();
    expect(await sync.ops()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['refused', 'dismissed']);
  });

  it('retries a server error, which may be temporary', async () => {
    let attempts = 0;
    const sync = engine(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError('scheduler_failed', 'Nothing was saved.', 500);
      return {};
    });
    await sync.ready();
    sync.enqueue({ kind: 'review_action', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    expect(sync.getState().refused).toBe(0);
    expect(await sync.ops()).toHaveLength(1);
    sync.advance(60_000);
    sync.kick();
    await settle();
    expect(await sync.ops()).toEqual([]);
  });
});

describe('several tabs', () => {
  it('sends each operation once when two engines share one outbox', async () => {
    const store = createMemoryStore();
    const sender = vi.fn(async () => ({}));
    const first = engine(sender, store);
    const second = engine(sender, store);
    await Promise.all([first.ready(), second.ready()]);
    first.enqueue({ kind: 'practice', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle(6);
    second.kick();
    await settle(6);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await first.ops()).toEqual([]);
  });
});

describe('storage that cannot be opened', () => {
  it('reports itself as memory-only and keeps working', async () => {
    const sync = engine(async () => ({}));
    await sync.ready();
    expect(sync.getState().memoryOnly).toBe(true);
    sync.enqueue({ kind: 'practice', payload: { pageId: 'card-1' }, entity: 'card-1' });
    await settle();
    expect(await sync.ops()).toEqual([]);
  });
});

describe('sequence numbers', () => {
  it('continue after a reload, so restored operations keep their order', async () => {
    const store = createMemoryStore();
    const first = engine(async () => {
      throw new ApiError('network', 'Offline.');
    }, store);
    await first.ready();
    first.enqueue({ kind: 'practice', payload: { pageId: 'a' }, entity: 'a' });
    await settle();
    first.stop();

    const order: string[] = [];
    const second = engine(async (op) => {
      order.push(String(op.payload.pageId));
      return {};
    }, store);
    await second.ready();
    second.enqueue({ kind: 'practice', payload: { pageId: 'b' }, entity: 'b' });
    // Time has passed since the first tab went away, so its backoff is over.
    second.advance(60_000);
    await settle(8);
    expect(order).toEqual(['a', 'b']);
  });
});
