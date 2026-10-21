import { describe, expect, it, vi } from 'vitest';
import {
  NO_CAPABILITIES,
  type QueueResponse,
  type ReviewActionResponse,
  type ReviewUndoResponse,
} from '../../shared/api.js';
import { ApiError, type AppApi, type ReviewApi } from '../../src/lib/api-client.js';
import { createSender } from '../../src/lib/offline/send.js';
import { createMemoryStore } from '../../src/lib/offline/storage.js';
import { createSyncEngine } from '../../src/lib/offline/sync-engine.js';
import { createSessionController } from '../../src/lib/session-controller.js';
import { currentCard } from '../../src/lib/session-machine.js';
import { card, deferred, queueResponse, type Deferred } from '../helpers/fixtures.js';

const applied: ReviewActionResponse = { outcome: 'applied', state: null };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Waits for something the pump does in the background (sending starts after the write is stored). */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error('Timed out waiting for a background change.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** An API whose every save stays pending until the test settles it. */
function setup(cardCount = 3, queue: Partial<QueueResponse> = {}) {
  const saves: Array<Deferred<ReviewActionResponse>> = [];
  const undos: Array<Deferred<ReviewUndoResponse>> = [];
  const api = {
    fetchQueue: vi.fn(async () => queueResponse(Array.from({ length: cardCount }, (_, index) => card(index + 1)), queue)),
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
  const store = createMemoryStore();
  const engine = createSyncEngine({
    accountId: 'test',
    store,
    sender: createSender(api as unknown as AppApi, (id) => id),
    // Real, short retries: the pump is exercised without waiting seconds.
    backoffMs: { base: 10, max: 20 },
  });
  const onSaved = vi.fn();
  const session = createSessionController({
    api,
    engine,
    store,
    accountId: 'test',
    countsTowardMastery: () => true,
    onSaved,
  });
  return { api, engine, session, store, saves, undos, onSaved };
}

const WITH_UNDO = { capabilities: { ...NO_CAPABILITIES, sessions: true, undo: true } };
const undone: ReviewUndoResponse = { outcome: 'undone', pageId: card(1).id, state: { mastery: 3, nextReview: card(1).nextReview } };

/** The request id of the answer now waiting, or of the one the server refused. */
const answerId = (session: ReturnType<typeof setup>['session']): string => {
  const state = session.getState();
  const answer = state.refused[0] ?? state.pending[0];
  if (answer === undefined) throw new Error('No answer is waiting.');
  return answer.requestId;
};

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
    await flush();
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(session.getState().status).toBe('ready');
  });

  it('sends the card id, the answer, the state the reviewer saw, and when it was answered', async () => {
    const { api, session } = setup();
    await session.load();
    session.flip();
    expect(session.grade('not_remember')).toBe(true);
    await waitFor(() => api.submitAction.mock.calls.length === 1);
    expect(api.submitAction).toHaveBeenCalledWith({
      pageId: card(1).id,
      action: 'not_remember',
      expected: { mastery: 3, nextReview: card(1).nextReview },
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      durationMs: expect.any(Number),
      sessionId: session.sessionId(),
      allowNotDue: false,
      countsTowardMastery: true,
      answeredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('never sends a mastery or a date for the server to store', async () => {
    const { api, session } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => api.submitAction.mock.calls.length === 1);
    const sent = api.submitAction.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(sent).sort()).toEqual([
      'action',
      'allowNotDue',
      'answeredAt',
      'countsTowardMastery',
      'durationMs',
      'expected',
      'pageId',
      'requestId',
      'sessionId',
    ]);
  });

  it('shows the next front at once and records the answer behind it', async () => {
    const { session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    // The card has already moved on; the answer is still on its way.
    expect(session.getState()).toMatchObject({ status: 'ready', index: 1 });
    expect(session.getState().pending[0]).toMatchObject({ index: 0, action: 'remember' });

    await waitFor(() => saves.length === 1);
    saves[0]?.resolve(applied);
    await waitFor(() => session.getState().pending.length === 0);
    expect(session.getState()).toMatchObject({ status: 'ready', index: 1 });
    expect(currentCard(session.getState())?.word).toBe('word-2');
  });

  it('accepts the next answer while the first is still on its way', async () => {
    const { api, session, saves } = setup();
    await session.load();
    session.flip();
    expect(session.grade('remember')).toBe(true);
    // The same tick: grading again is refused (the card has moved on), but the
    // next card can be answered without waiting for the first write.
    expect(session.grade('not_remember')).toBe(false);
    session.flip();
    expect(session.grade('not_remember')).toBe(true);
    expect(session.getState()).toMatchObject({ index: 2 });
    expect(session.getState().pending).toHaveLength(2);
    // The second answer is recorded and waits its turn; it goes out as soon as
    // the first write lands, without the session waiting for it.
    await waitFor(() => saves.length === 1);
    saves[0]?.resolve(applied);
    await waitFor(() => api.submitAction.mock.calls.length === 2);
  });

  it('reloads while answers are still waiting: their writes are not on the session', async () => {
    const { api, engine, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);

    await session.load();
    expect(api.fetchQueue).toHaveBeenCalledTimes(2);
    expect(session.getState()).toMatchObject({ status: 'ready', index: 0, pending: [] });
    // The answer itself is untouched: it is still in the outbox.
    expect((await engine.ops()).length).toBe(1);

    saves[0]?.resolve(applied);
    await waitFor(async () => (await engine.ops()).length === 0);
  });

  it('completes after the last card', async () => {
    const { session, saves } = setup(1);
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    saves[0]?.resolve(applied);
    await waitFor(() => session.getState().status === 'completed');
    expect(session.getState()).toMatchObject({ tally: { remember: 1 } });
  });
});

describe('when a save is refused', () => {
  it('keeps the answer in the refused list, out of the way of the next card', async () => {
    const { session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    saves[0]?.reject(new ApiError('conflict', 'This card was changed after it was loaded.', 409));
    await waitFor(() => session.getState().refused.length === 1);
    expect(session.getState()).toMatchObject({
      status: 'ready',
      index: 1,
      tally: { remember: 0, notRemember: 0, skipped: 1 },
    });
    expect(session.getState().refused[0]).toMatchObject({ index: 0, action: 'remember', kind: 'conflict' });
    expect(currentCard(session.getState())?.word).toBe('word-2');
  });

  it('retries under the same request id, so one the server did store is never stored twice', async () => {
    const { api, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    saves[0]?.reject(new ApiError('conflict', 'This card was changed after it was loaded.', 409));
    await waitFor(() => session.getState().refused.length === 1);

    const requestId = answerId(session);
    session.retryRefusal(requestId);
    await waitFor(() => saves.length === 2);
    expect(saves[1] !== saves[0]).toBe(true);
    expect(api.submitAction.mock.calls[1]).toEqual(api.submitAction.mock.calls[0]);

    // The first attempt had in fact landed; the server says so and the session counts it once.
    saves[1]?.resolve({ outcome: 'already_applied', state: { mastery: 4, nextReview: '2026-10-13' } });
    await waitFor(() => session.getState().refused.length === 0);
    expect(session.getState()).toMatchObject({ status: 'ready', index: 1, tally: { remember: 1, skipped: 0 } });
  });

  it('can give up on a refused answer without ever counting it', async () => {
    const { api, engine, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    saves[0]?.reject(new ApiError('forbidden', 'The database refused this change.', 403));
    await waitFor(() => session.getState().refused.length === 1);

    session.dismissRefusal(answerId(session));
    expect(session.getState()).toMatchObject({ refused: [], tally: { remember: 0, skipped: 1 } });
    expect(await engine.ops()).toEqual([]);

    // The next card is a fresh answer, not a repeat of the refused one.
    session.flip();
    expect(session.grade('not_remember')).toBe(true);
    await waitFor(() => saves.length === 2);
    const [first, second] = api.submitAction.mock.calls.map(([request]) => request.requestId);
    expect(second).not.toBe(first);
  });

  it('keeps trying on its own when the server cannot be reached', async () => {
    const { api, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    // No status: the request never reached the server, so it is worth sending again.
    saves[0]?.reject(new ApiError('network', 'Could not reach the server.'));
    await waitFor(() => saves.length === 2);
    expect(session.getState().refused).toEqual([]);
    expect(session.getState().pending).toHaveLength(1);
    expect(api.submitAction.mock.calls[1]).toEqual(api.submitAction.mock.calls[0]);

    saves[1]?.resolve(applied);
    await waitFor(() => session.getState().pending.length === 0);
    expect(session.getState()).toMatchObject({ refused: [], tally: { remember: 1 } });
  });

  it('gives every answer its own request id', async () => {
    const { api, session, saves } = setup();
    await session.load();
    for (const index of [0, 1, 2]) {
      session.flip();
      session.grade('remember');
      await waitFor(() => saves.length === index + 1);
      saves[index]?.resolve(applied);
      await waitFor(() => session.getState().pending.length === 0);
    }
    const ids = api.submitAction.mock.calls.map(([request]) => request.requestId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('undoing the last answer', () => {
  /** Loads, flips and answers the first card, and has the server confirm it. */
  async function answered(queue: Partial<QueueResponse> = WITH_UNDO) {
    const context = setup(3, queue);
    await context.session.load();
    context.session.flip();
    context.session.grade('remember');
    await waitFor(() => context.saves.length === 1);
    context.saves[0]?.resolve({ outcome: 'applied', state: { mastery: 4, nextReview: '2026-10-12' } });
    await waitFor(() => context.session.getState().lastSaved !== null);
    return context;
  }

  it('is offered only for an answer the server confirmed', async () => {
    const { session, saves } = setup(3, WITH_UNDO);
    await session.load();
    expect(session.undo()).toBe(false);
    session.flip();
    session.grade('remember');
    // Still on its way: there is nothing confirmed to take back yet.
    expect(session.undo()).toBe(false);
    await waitFor(() => saves.length === 1);
    saves[0]?.resolve({ outcome: 'applied', state: { mastery: 4, nextReview: '2026-10-12' } });
    await waitFor(() => session.getState().lastSaved !== null);
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
    await waitFor(() => session.getState().undoing === false && session.getState().lastSaved === null);
    expect(session.getState()).toMatchObject({
      status: 'ready',
      index: 0,
      tally: { remember: 0, notRemember: 0 },
    });
    expect(currentCard(session.getState())?.word).toBe('word-1');
    // Once for the save and once for the undo: other pages must re-read both times.
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it('answers the card again at the revision the Undo left it at, where the server keeps revisions', async () => {
    const context = setup(3, WITH_UNDO);
    context.api.fetchQueue.mockImplementation(async () =>
      queueResponse([card(1, { revision: 4 }), card(2, { revision: 0 })], WITH_UNDO),
    );
    const { api, session, saves, undos } = context;
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    expect(api.submitAction.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 4 });
    saves[0]?.resolve({ outcome: 'applied', state: { mastery: 2, nextReview: '2026-10-12', revision: 5 } });
    await waitFor(() => session.getState().lastSaved !== null);

    session.undo();
    undos[0]?.resolve({ outcome: 'undone', pageId: card(1).id, state: { mastery: 1, nextReview: card(1).nextReview, revision: 6 } });
    await waitFor(() => session.getState().undoing === false && session.getState().lastSaved === null);
    expect(currentCard(session.getState())).toMatchObject({ word: 'word-1', revision: 6 });

    session.flip();
    session.grade('not_remember');
    await waitFor(() => saves.length === 2);
    expect(api.submitAction.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 6, action: 'not_remember' });
  });

  it('sends no revision for a card that has none', async () => {
    const { api, session, saves } = setup(1);
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    expect(api.submitAction.mock.calls[0]?.[0]).not.toHaveProperty('expectedRevision');
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
    await waitFor(() => session.getState().undoing === false);
  });

  it('keeps the offer and repeats the same request after a connection failure', async () => {
    const { api, session, undos } = await answered();
    session.undo();
    undos[0]?.reject(new ApiError('network', 'Could not reach the server. Check your connection.'));
    await waitFor(() => session.getState().undoing === false);
    expect(session.getState()).toMatchObject({ index: 1, undoError: 'Could not reach the server. Check your connection.' });
    expect(session.getState().lastSaved).not.toBeNull();

    expect(session.undo()).toBe(true);
    expect(api.undoAction.mock.calls[1]).toEqual(api.undoAction.mock.calls[0]);
    undos[1]?.resolve({ ...undone, outcome: 'already_undone' });
    await waitFor(() => session.getState().lastSaved === null);
    expect(session.getState()).toMatchObject({ index: 0, undoError: null });
  });

  it('withdraws the offer when the answer can no longer be undone', async () => {
    const { session, undos } = await answered();
    session.undo();
    undos[0]?.reject(new ApiError('conflict', 'This card has been reviewed again since then.', 409));
    await waitFor(() => session.getState().lastSaved === null);
    expect(session.getState()).toMatchObject({
      index: 1,
      tally: { remember: 1 },
      undoError: 'This card has been reviewed again since then.',
    });
    expect(session.undo()).toBe(false);
  });

  it('is not offered where the store cannot undo, or for a preview that saved nothing', async () => {
    const plain = setup(3, { capabilities: NO_CAPABILITIES });
    await plain.session.load();
    plain.session.flip();
    plain.session.grade('remember');
    await waitFor(() => plain.saves.length === 1);
    plain.saves[0]?.resolve({ outcome: 'applied', state: null });
    await waitFor(() => plain.session.getState().pending.length === 0);
    expect(plain.session.getState().lastSaved).toBeNull();
    expect(plain.session.undo()).toBe(false);

    const preview = setup(3, WITH_UNDO);
    await preview.session.load();
    preview.session.flip();
    preview.session.grade('remember');
    await waitFor(() => preview.saves.length === 1);
    preview.saves[0]?.resolve({ outcome: 'dry_run', state: { mastery: 4, nextReview: '2026-10-12' } });
    await waitFor(() => preview.session.getState().pending.length === 0);
    expect(preview.session.getState().lastSaved).toBeNull();
  });

  it('only ever offers the latest answer', async () => {
    const { api, session, saves } = await answered();
    session.flip();
    session.grade('not_remember');
    await waitFor(() => saves.length === 2);
    saves[1]?.resolve(applied);
    await waitFor(() => session.getState().lastSaved?.index === 1);
    expect(session.getState().lastSaved).toMatchObject({ action: 'not_remember' });
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
    await waitFor(() => saves.length === 1);
    saves[0]?.resolve(applied);
    await waitFor(() => session.getState().status === 'completed');
    // The completion shows first; the confirmation of the last write follows.
    await waitFor(() => session.getState().lastSaved !== null);

    expect(session.undo()).toBe(true);
    undos[0]?.resolve(undone);
    await waitFor(() => session.getState().status === 'ready');
    expect(session.getState()).toMatchObject({ index: 0 });
  });
});

describe('narrowing the queue', () => {
  it('asks for everything due unless told otherwise', async () => {
    const { api, session } = setup();
    await session.load();
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'all' } });
  });

  it('asks for the weakest words when told to, and keeps to them on a plain reload', async () => {
    const { api, session } = setup();
    await session.load({ scope: { kind: 'weak' } });
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'weak' } });

    // Refresh passes nothing: it re-reads the same selection.
    await session.load();
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'weak' } });

    await session.load({ scope: { kind: 'all' } });
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'all' } });
  });

  it('changes the selection while an answer is still waiting: the write is the outbox’s', async () => {
    const { api, engine, session, saves } = setup();
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);

    await session.load({ scope: { kind: 'weak' } });
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'weak' } });
    expect((await engine.ops()).length).toBe(1);

    saves[0]?.resolve(applied);
    await waitFor(async () => (await engine.ops()).length === 0);
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
      await waitFor(() => saves.length === index + 1);
      saves[index]?.resolve(applied);
      await flush();
    }
    expect(api.submitAction.mock.calls.map(([request]) => request.sessionId)).toEqual([first, first]);

    await session.load();
    expect(session.sessionId()).not.toBe(first);
  });
});

describe('without a connection', () => {
  it('resumes the sitting from this device after a reload, with the answers still on their way', async () => {
    const { api, engine, store, session, saves } = setup(2);
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    // The write cannot be delivered; it stays in the outbox.
    saves[0]?.reject(new ApiError('network', 'Could not reach the server.'));
    await flush();

    // A reload: the queue cannot be fetched either, so the last one comes back
    // from this device, with the sitting where it stopped.
    api.fetchQueue.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    const reloaded = createSessionController({
      api,
      engine,
      store,
      accountId: 'test',
      countsTowardMastery: () => true,
    });
    await reloaded.load();
    const state = reloaded.getState();
    expect(state).toMatchObject({ status: 'ready', source: 'cache', index: 1, tally: { remember: 1 } });
    expect(currentCard(state)?.word).toBe('word-2');
    expect(state.pending.map((answer) => answer.word)).toEqual(['word-1']);
    expect((await engine.ops()).length).toBe(1);
  });

  it('adopts answers the server refused in an earlier sitting, so they can still be decided on', async () => {
    const { api, engine, store, session, saves } = setup(2);
    await session.load();
    session.flip();
    session.grade('remember');
    await waitFor(() => saves.length === 1);
    saves[0]?.reject(new ApiError('forbidden', 'The database refused this change.', 403));
    await waitFor(() => session.getState().refused.length === 1);
    const requestId = session.getState().refused[0]?.requestId;
    expect(requestId).toBeDefined();

    // The queue loads afresh, as after a reload; the refused answer is still in
    // the outbox and is taken back into the sitting's list.
    const reloaded = createSessionController({
      api,
      engine,
      store,
      accountId: 'test',
      countsTowardMastery: () => true,
    });
    await reloaded.load();
    expect(reloaded.getState().refused.map((answer) => answer.requestId)).toEqual([requestId]);

    // Retrying from here sends it again under the very same id.
    reloaded.retryRefusal(requestId!);
    await waitFor(() => saves.length === 2);
    expect(api.submitAction.mock.calls[1]?.[0].requestId).toBe(requestId);
    saves[1]?.resolve(applied);
    await waitFor(() => reloaded.getState().refused.length === 0);
    expect(reloaded.getState().tally.remember).toBe(1);
  });
});
