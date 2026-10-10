import { describe, expect, it, vi } from 'vitest';
import type { QueueResponse, ReviewActionResponse, ReviewUndoResponse } from '../../shared/api.js';
import { ApiError, type ReviewApi } from '../../src/lib/api-client.js';
import { createSessionController } from '../../src/lib/session-controller.js';
import { currentCard } from '../../src/lib/session-machine.js';
import { card, deferred, queueResponse, type Deferred } from '../helpers/fixtures.js';

const applied: ReviewActionResponse = { outcome: 'applied', state: null };

/** An API whose every save stays pending until the test settles it. */
function setup(cardCount = 3, queue: Partial<QueueResponse> = {}) {
  const saves: Array<Deferred<ReviewActionResponse>> = [];
  const undos: Array<Deferred<ReviewUndoResponse>> = [];
  const api = {
    fetchQueue: vi.fn(async () =>
      queueResponse(Array.from({ length: cardCount }, (_, index) => card(index + 1)), queue),
    ),
    submitAction: vi.fn<ReviewApi['submitAction']>(() => {
      const pending = deferred<ReviewActionResponse>();
      saves.push(pending);
      return pending.promise;
    }),
    undoAction: vi.fn<ReviewApi['undoAction']>(() => {
      const pending = deferred<ReviewUndoResponse>();
      undos.push(pending);
      return pending.promise;
    }),
  };
  const onSaved = vi.fn();
  const session = createSessionController(api, onSaved);
  return { api, session, saves, undos, onSaved };
}

const WITH_UNDO = { capabilities: { sessions: true, undo: true, fsrs: false, analytics: false } };
const undone: ReviewUndoResponse = { outcome: 'undone', pageId: card(1).id, state: { mastery: 3, nextReview: card(1).nextReview } };

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
      sessionId: session.sessionId(),
    });
  });

  it('never sends a mastery or a date for the server to store', async () => {
    const { api, session } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    const sent = api.submitAction.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(sent).sort()).toEqual(['action', 'durationMs', 'expected', 'pageId', 'requestId', 'sessionId']);
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

describe('undoing the last answer', () => {
  /** Loads, flips and answers the first card, and has the server confirm it. */
  async function answered(queue: Partial<QueueResponse> = WITH_UNDO) {
    const context = setup(3, queue);
    await context.session.load();
    context.session.flip();
    context.session.grade('remember');
    context.saves[0]?.resolve({ outcome: 'applied', state: { mastery: 4, nextReview: '2026-10-12' } });
    await settled();
    return context;
  }

  it('is offered only for an answer the server confirmed', async () => {
    const { session, saves } = setup(3, WITH_UNDO);
    await session.load();
    expect(session.undo()).toBe(false);
    session.flip();
    session.grade('remember');
    // Still saving: there is nothing confirmed to take back yet.
    expect(session.undo()).toBe(false);
    saves[0]?.resolve({ outcome: 'applied', state: { mastery: 4, nextReview: '2026-10-12' } });
    await settled();
    expect(session.getState().lastSaved).toMatchObject({ index: 0, action: 'remember' });
  });

  it('names the saved answer, goes back to its card and corrects the count', async () => {
    const { api, session, undos, onSaved } = await answered();
    const savedAs = api.submitAction.mock.calls[0]?.[0].requestId;
    expect(session.getState()).toMatchObject({ index: 1, tally: { remember: 1 } });

    expect(session.undo()).toBe(true);
    expect(session.getState().undoing).toBe(true);
    expect(api.undoAction).toHaveBeenCalledWith({ reviewRequestId: savedAs, requestId: expect.any(String) });
    expect(api.undoAction.mock.calls[0]?.[0].requestId).not.toBe(savedAs);

    undos[0]?.resolve(undone);
    await settled();
    expect(session.getState()).toMatchObject({
      status: 'ready',
      index: 0,
      tally: { remember: 0, notRemember: 0 },
      lastSaved: null,
      undoing: false,
    });
    expect(currentCard(session.getState())?.word).toBe('word-1');
    // Once for the save and once for the undo: other pages must re-read both times.
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it('cannot be started twice, and blocks answering while it is in flight', async () => {
    const { api, session, undos } = await answered();
    session.undo();
    expect(session.undo()).toBe(false);
    session.flip();
    expect(session.grade('remember')).toBe(false);
    expect(api.undoAction).toHaveBeenCalledTimes(1);
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    undos[0]?.resolve(undone);
    await settled();
  });

  it('keeps the offer and repeats the same request after a connection failure', async () => {
    const { api, session, undos } = await answered();
    session.undo();
    undos[0]?.reject(new ApiError('network', 'Could not reach the server. Check your connection.'));
    await settled();
    expect(session.getState()).toMatchObject({ index: 1, undoing: false, undoError: 'Could not reach the server. Check your connection.' });
    expect(session.getState().lastSaved).not.toBeNull();

    expect(session.undo()).toBe(true);
    expect(api.undoAction.mock.calls[1]).toEqual(api.undoAction.mock.calls[0]);
    undos[1]?.resolve({ ...undone, outcome: 'already_undone' });
    await settled();
    expect(session.getState()).toMatchObject({ index: 0, lastSaved: null, undoError: null });
  });

  it('withdraws the offer when the answer can no longer be undone', async () => {
    const { session, undos } = await answered();
    session.undo();
    undos[0]?.reject(new ApiError('conflict', 'This card has been reviewed again since then.', 409));
    await settled();
    expect(session.getState()).toMatchObject({
      index: 1,
      tally: { remember: 1 },
      lastSaved: null,
      undoError: 'This card has been reviewed again since then.',
    });
    expect(session.undo()).toBe(false);
  });

  it('is not offered where the store cannot undo, or for a preview that saved nothing', async () => {
    const plain = await answered({ capabilities: { sessions: false, undo: false, fsrs: false, analytics: false } });
    expect(plain.session.getState().lastSaved).toBeNull();
    expect(plain.session.undo()).toBe(false);

    const preview = setup(3, WITH_UNDO);
    await preview.session.load();
    preview.session.flip();
    preview.session.grade('remember');
    preview.saves[0]?.resolve({ outcome: 'dry_run', state: { mastery: 4, nextReview: '2026-10-12' } });
    await settled();
    expect(preview.session.getState().lastSaved).toBeNull();
  });

  it('only ever offers the latest answer', async () => {
    const { api, session, saves } = await answered();
    session.flip();
    session.grade('not_remember');
    saves[1]?.resolve(applied);
    await settled();
    expect(session.getState().lastSaved).toMatchObject({ index: 1, action: 'not_remember' });
    session.undo();
    expect(api.undoAction).toHaveBeenCalledWith(
      expect.objectContaining({ reviewRequestId: api.submitAction.mock.calls[1]?.[0].requestId }),
    );
  });

  it('works from the end of the session', async () => {
    const { session, saves, undos } = setup(1, WITH_UNDO);
    await session.load();
    session.flip();
    session.grade('remember');
    saves[0]?.resolve(applied);
    await settled();
    expect(session.getState().status).toBe('completed');

    expect(session.undo()).toBe(true);
    undos[0]?.resolve(undone);
    await settled();
    expect(session.getState()).toMatchObject({ status: 'ready', index: 0 });
  });
});

describe('narrowing the queue', () => {
  it('asks for everything due unless told otherwise', async () => {
    const { api, session } = setup();
    await session.load();
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null });
  });

  it('asks for the weakest words when told to, and keeps to them on a plain reload', async () => {
    const { api, session } = setup();
    await session.load({ focus: 'weak' });
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: 'weak' });

    // Refresh passes nothing: it re-reads the same selection.
    await session.load();
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: 'weak' });

    await session.load({ focus: null });
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null });
  });

  it('does not change the selection while an answer is being saved', async () => {
    const { api, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await session.load({ focus: 'weak' });
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);

    saves[0]?.resolve(applied);
    await settled();
    await session.load();
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null });
  });
});

describe('the session id', () => {
  it('is the same for every answer of one sitting and new after a reload', async () => {
    const { api, session, saves } = setup(3);
    await session.load();
    const first = session.sessionId();
    for (const index of [0, 1]) {
      session.flip();
      session.grade('remember');
      saves[index]?.resolve(applied);
      await settled();
    }
    expect(api.submitAction.mock.calls.map(([request]) => request.sessionId)).toEqual([first, first]);

    await session.load();
    expect(session.sessionId()).not.toBe(first);
  });
});
