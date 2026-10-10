import { describe, expect, it, vi } from 'vitest';
import type { QueueResponse, ReviewActionResponse } from '../../shared/api.js';
import { ApiError, type ReviewApi } from '../../src/lib/api-client.js';
import { createSessionController } from '../../src/lib/session-controller.js';
import { currentCard } from '../../src/lib/session-machine.js';
import { card, deferred, queueResponse, type Deferred } from '../helpers/fixtures.js';

const applied: ReviewActionResponse = { outcome: 'applied', state: null };

/** An API whose every save stays pending until the test settles it. */
function setup(cardCount = 3) {
  const saves: Array<Deferred<ReviewActionResponse>> = [];
  const api = {
    fetchQueue: vi.fn(async () => queueResponse(Array.from({ length: cardCount }, (_, index) => card(index + 1)))),
    submitAction: vi.fn<ReviewApi['submitAction']>(() => {
      const pending = deferred<ReviewActionResponse>();
      saves.push(pending);
      return pending.promise;
    }),
  };
  const session = createSessionController(api);
  return { api, session, saves };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('loading', () => {
  it('loads the queue and shows the first card', async () => {
    const { session } = setup();
    expect(session.getState().status).toBe('loading');
    await session.load();
    expect(session.getState()).toMatchObject({ status: 'ready', index: 0, meta: { writesEnabled: true } });
    expect(currentCard(session.getState())?.word).toBe('word-1');
  });

  it('reports a load failure and whether a password is needed', async () => {
    const { api, session } = setup();
    api.fetchQueue.mockRejectedValueOnce(new ApiError('unauthorized', 'Enter the access password.', 401));
    await session.load();
    expect(session.getState().error).toEqual({ kind: 'load', message: 'Enter the access password.', unauthorized: true });

    api.fetchQueue.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    await session.load();
    expect(session.getState().error).toMatchObject({ kind: 'load', unauthorized: false });
  });

  it('lets only the latest of two overlapping loads win', async () => {
    const { api, session } = setup();
    const slow = deferred<QueueResponse>();
    const fast = deferred<QueueResponse>();
    api.fetchQueue.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const first = session.load();
    const second = session.load();
    fast.resolve(queueResponse([card(7)]));
    await second;
    slow.resolve(queueResponse([card(1), card(2)]));
    await first;
    expect(session.getState().cards.map((item) => item.id)).toEqual([card(7).id]);
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const { session } = setup();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    await session.load();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    unsubscribe();
    session.flip();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('answering', () => {
  it('does nothing until the card is flipped', async () => {
    const { api, session } = setup();
    await session.load();
    expect(session.grade('remember')).toBe(false);
    expect(session.grade('not_remember')).toBe(false);
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(session.getState().status).toBe('ready');
  });

  it('sends the card id, the answer and the state the reviewer saw', async () => {
    const { api, session } = setup();
    await session.load();
    session.flip();
    expect(session.grade('not_remember')).toBe(true);
    expect(api.submitAction).toHaveBeenCalledWith({
      pageId: card(1).id,
      action: 'not_remember',
      expected: { mastery: 3, nextReview: card(1).nextReview },
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      durationMs: expect.any(Number),
    });
  });

  it('never sends a mastery or a date for the server to store', async () => {
    const { api, session } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    const sent = api.submitAction.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(sent).sort()).toEqual(['action', 'durationMs', 'expected', 'pageId', 'requestId']);
  });

  it('stays on the card until the server confirms, then shows the next front', async () => {
    const { session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    expect(session.getState()).toMatchObject({ status: 'saving', index: 0 });

    saves[0]?.resolve(applied);
    await settled();
    expect(session.getState()).toMatchObject({ status: 'ready', index: 1 });
    expect(currentCard(session.getState())?.word).toBe('word-2');
  });

  it('submits once however many times the answer is repeated', async () => {
    const { api, session } = setup();
    await session.load();
    session.flip();
    expect(session.grade('remember')).toBe(true);
    // Same tick: a double key press, a click during a swipe, the other answer…
    expect(session.grade('remember')).toBe(false);
    expect(session.grade('not_remember')).toBe(false);
    session.flip();
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ status: 'saving', pendingAction: 'remember' });
  });

  it('cannot reload while saving', async () => {
    const { api, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await session.load();
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);
    expect(session.getState().status).toBe('saving');
    saves[0]?.resolve(applied);
    await settled();
    expect(session.getState().index).toBe(1);
  });

  it('completes after the last card', async () => {
    const { session, saves } = setup(1);
    await session.load();
    session.flip();
    session.grade('remember');
    saves[0]?.resolve(applied);
    await settled();
    expect(session.getState()).toMatchObject({ status: 'completed', tally: { remember: 1 } });
  });
});

describe('when a save fails', () => {
  it('keeps the card, shows the reason, and does not advance', async () => {
    const { session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    saves[0]?.reject(new ApiError('network', 'Could not reach the server.'));
    await settled();
    expect(session.getState()).toMatchObject({
      status: 'error',
      index: 0,
      error: { kind: 'save', message: 'Could not reach the server.' },
      tally: { remember: 0 },
    });
    expect(currentCard(session.getState())?.word).toBe('word-1');
  });

  it('retries with an identical request so the server can reconcile it', async () => {
    const { api, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    saves[0]?.reject(new ApiError('timeout', 'No confirmation arrived in time.'));
    await settled();

    session.retrySave();
    session.retrySave(); // a double click on Retry
    expect(api.submitAction).toHaveBeenCalledTimes(2);
    expect(api.submitAction.mock.calls[1]).toEqual(api.submitAction.mock.calls[0]);

    // The first attempt had in fact landed; the server says so and the session moves on once.
    saves[1]?.resolve({ outcome: 'already_applied', state: { mastery: 4, nextReview: '2026-10-13' } });
    await settled();
    expect(session.getState()).toMatchObject({ status: 'ready', index: 1, tally: { remember: 1 } });
  });

  it('can go back to the card instead of retrying', async () => {
    const { api, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    saves[0]?.reject(new Error('unexpected'));
    await settled();
    expect(session.getState().error?.message).toBe('Something unexpected went wrong.');

    session.cancelSave();
    expect(session.getState()).toMatchObject({ status: 'flipped', index: 0, pendingAction: null });
    expect(session.grade('not_remember')).toBe(true);
    expect(api.submitAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'not_remember' }));
    // A different answer is a different submission, not a repeat of the failed one.
    const [first, second] = api.submitAction.mock.calls.map(([request]) => request.requestId);
    expect(second).not.toBe(first);
  });

  it('gives every answer its own request id', async () => {
    const { api, session, saves } = setup();
    await session.load();
    for (const index of [0, 1, 2]) {
      session.flip();
      session.grade('remember');
      saves[index]?.resolve(applied);
      await settled();
    }
    const ids = api.submitAction.mock.calls.map(([request]) => request.requestId);
    expect(new Set(ids).size).toBe(3);
  });

  it('treats a conflict as a stale card: no retry, explicit skip only', async () => {
    const { api, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    saves[0]?.reject(new ApiError('conflict', 'This card was changed after it was loaded.', 409));
    await settled();
    expect(session.getState()).toMatchObject({ status: 'error', index: 0, error: { kind: 'conflict' } });

    session.retrySave();
    expect(api.submitAction).toHaveBeenCalledTimes(1);

    session.skipCard();
    expect(session.getState()).toMatchObject({ status: 'ready', index: 1, tally: { remember: 0, skipped: 1 } });
  });
});
