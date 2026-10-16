import { describe, expect, it } from 'vitest';
import {
  canUndo,
  currentCard,
  initialSessionState,
  isSaving,
  pendingCount,
  transition,
  type SessionEvent,
  type SessionState,
} from '../../src/lib/session-machine.js';
import { card, queueResponse } from '../helpers/fixtures.js';

const { cards: _unused, ...meta } = queueResponse([]);
void _unused;

const run = (state: SessionState, ...events: SessionEvent[]) => events.reduce(transition, state);
const loaded = (count: number) =>
  transition(initialSessionState, {
    type: 'LOAD_SUCCEEDED',
    cards: Array.from({ length: count }, (_, index) => card(index + 1)),
    meta,
  });

const grade = (action: 'remember' | 'not_remember', requestId = 'r1'): SessionEvent => ({
  type: 'GRADE',
  action,
  requestId,
  durationMs: 1200,
});
const flip = (state: SessionState) => transition(state, { type: 'FLIP' });

/** Two cards, the first flipped and answered: the answer waits, the next card is up. */
const answering = () => run(loaded(2), { type: 'FLIP' }, grade('remember'));
const settled = (requestId = 'r1', undoable = true) =>
  transition(answering(), { type: 'SAVE_SETTLED', requestId, undoable });
const refused = (requestId = 'r1', kind: 'save' | 'conflict' = 'save', message = 'offline') =>
  transition(answering(), { type: 'SAVE_REFUSED', requestId, kind, message });

const answerOf = (answers: readonly { requestId: string }[], requestId: string) =>
  answers.find((answer) => answer.requestId === requestId);

describe('loading', () => {
  it('starts in loading and becomes ready on the first card', () => {
    expect(initialSessionState.status).toBe('loading');
    const state = loaded(3);
    expect(state.status).toBe('ready');
    expect(state.index).toBe(0);
    expect(currentCard(state)?.id).toBe(card(1).id);
  });

  it('goes straight to completed when the queue is empty', () => {
    expect(loaded(0).status).toBe('completed');
  });

  it('records a load failure', () => {
    const state = transition(initialSessionState, { type: 'LOAD_FAILED', message: 'no network', unauthorized: false });
    expect(state).toMatchObject({ status: 'error', error: { kind: 'load', message: 'no network', unauthorized: false } });
  });

  it('can reload from any settled state, resetting the session', () => {
    const reloading = transition(settled(), { type: 'LOAD' });
    expect(reloading).toMatchObject({ status: 'loading', cards: [], index: 0, tally: { remember: 0 } });
    expect(transition(loaded(0), { type: 'LOAD' }).status).toBe('loading');
  });

  it('can reload while answers are still waiting: their writes are the outbox’s', () => {
    const waiting = answering();
    const reloading = transition(waiting, { type: 'LOAD' });
    expect(reloading).toMatchObject({ status: 'loading', pending: [], refused: [] });
  });

  it('ignores a late load result once the session has moved on', () => {
    const ready = loaded(2);
    expect(transition(ready, { type: 'LOAD_SUCCEEDED', cards: [], meta })).toBe(ready);
    expect(transition(ready, { type: 'LOAD_FAILED', message: 'x', unauthorized: false })).toBe(ready);
  });

  it('resumes a sitting from this device’s own storage', () => {
    const pending = [
      { index: 0, word: card(1).word, action: 'remember' as const, requestId: 'r1', durationMs: 900, confidence: null },
    ];
    const state = transition(initialSessionState, {
      type: 'LOAD_RESTORED',
      cards: [card(1), card(2)],
      meta,
      index: 1,
      tally: { remember: 1, notRemember: 0, skipped: 0 },
      pending,
      refused: [],
      lastSaved: null,
    });
    expect(state).toMatchObject({ status: 'ready', index: 1, source: 'cache', tally: { remember: 1 } });
    expect(pendingCount(state)).toBe(1);
    expect(state.pending[0]).toMatchObject({ requestId: 'r1', action: 'remember' });
    // A restore is only valid while the session is still loading.
    expect(transition(state, { type: 'LOAD_RESTORED', cards: [], meta, index: 0, tally: state.tally, pending: [], refused: [], lastSaved: null })).toBe(state);
  });
});

describe('flipping', () => {
  it('toggles between front and back', () => {
    const flipped = flip(loaded(1));
    expect(flipped.status).toBe('flipped');
    expect(flip(flipped).status).toBe('ready');
  });

  it('is ignored while loading or completed', () => {
    for (const state of [initialSessionState, loaded(0)]) {
      expect(transition(state, { type: 'FLIP' })).toBe(state);
    }
  });

  it('can flip the next card while an earlier answer is still waiting', () => {
    const waiting = answering();
    expect(isSaving(waiting)).toBe(true);
    const next = flip(waiting);
    expect(next.status).toBe('flipped');
    expect(next.index).toBe(1);
  });
});

describe('grading', () => {
  it('is only possible once the card is flipped', () => {
    const ready = loaded(2);
    expect(transition(ready, grade('remember'))).toBe(ready);
    expect(transition(ready, grade('not_remember'))).toBe(ready);
  });

  it('advances at once, keeping the answer as still to be confirmed', () => {
    const answered = run(loaded(2), { type: 'FLIP' }, grade('not_remember'));
    expect(answered).toMatchObject({ status: 'ready', index: 1 });
    expect(answered.tally).toEqual({ remember: 0, notRemember: 1, skipped: 0 });
    expect(isSaving(answered)).toBe(true);
    expect(answerOf(answered.pending, 'r1')).toMatchObject({ index: 0, action: 'not_remember', requestId: 'r1' });
  });

  it('accepts another answer while the first is still waiting', () => {
    const state = run(
      loaded(3),
      { type: 'FLIP' },
      grade('remember', 'r1'),
      { type: 'FLIP' },
      grade('not_remember', 'r2'),
    );
    expect(state).toMatchObject({ status: 'ready', index: 2 });
    expect(state.tally).toEqual({ remember: 1, notRemember: 1, skipped: 0 });
    expect(state.pending.map((answer) => answer.requestId)).toEqual(['r1', 'r2']);
  });

  it('completes after the last card, while its answer is still in flight', () => {
    const done = run(loaded(1), { type: 'FLIP' }, grade('remember'));
    expect(done).toMatchObject({ status: 'completed', index: 1 });
    expect(currentCard(done)).toBeNull();
    expect(isSaving(done)).toBe(true);
  });

  it('is blocked while an Undo is in flight', () => {
    const undoing = transition(settled(), { type: 'UNDO' });
    const onNext = flip(undoing);
    expect(transition(onNext, grade('not_remember', 'r2'))).toBe(onNext);
  });

  it('counts each kind of answer', () => {
    const state = run(
      loaded(3),
      { type: 'FLIP' },
      grade('not_remember', 'r1'),
      { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true },
      { type: 'FLIP' },
      grade('remember', 'r2'),
      { type: 'SAVE_SETTLED', requestId: 'r2', undoable: true },
    );
    expect(state.tally).toEqual({ remember: 1, notRemember: 1, skipped: 0 });
    expect(state.index).toBe(2);
  });
});

describe('confirmations', () => {
  it('clears the waiting answer on success and offers Undo for a stored one', () => {
    const state = settled();
    expect(state).toMatchObject({ index: 1, error: null, pending: [] });
    expect(state.lastSaved).toMatchObject({ index: 0, action: 'remember', requestId: 'r1' });
    expect(isSaving(state)).toBe(false);
  });

  it('does not offer Undo for an answer the server only pretended to store', () => {
    expect(settled('r1', false).lastSaved).toBeNull();
  });

  it('ignores a result whose request id is not this session’s', () => {
    const waiting = answering();
    expect(transition(waiting, { type: 'SAVE_SETTLED', requestId: 'other', undoable: true })).toBe(waiting);
    expect(transition(waiting, { type: 'SAVE_REFUSED', requestId: 'other', kind: 'save', message: 'x' })).toBe(waiting);
  });

  it('ignores results when nothing is waiting', () => {
    for (const state of [loaded(2), flip(loaded(2)), loaded(0)]) {
      expect(transition(state, { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true })).toBe(state);
      expect(transition(state, { type: 'SAVE_REFUSED', requestId: 'r1', kind: 'save', message: 'x' })).toBe(state);
    }
  });

  it('a confirmation clears whichever answer it names, waiting or refused', () => {
    const state = run(refused(), { type: 'RETRY_SAVE', requestId: 'r1' }, { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true });
    expect(state.pending).toEqual([]);
    expect(state.refused).toEqual([]);
    expect(state.tally).toEqual({ remember: 1, notRemember: 0, skipped: 0 });
  });
});

describe('refusals', () => {
  it('moves the answer out of the way and stops counting it', () => {
    const state = refused();
    expect(state).toMatchObject({ status: 'ready', index: 1, pending: [] });
    expect(state.tally).toEqual({ remember: 0, notRemember: 0, skipped: 1 });
    expect(answerOf(state.refused, 'r1')).toMatchObject({ index: 0, action: 'remember', kind: 'save', message: 'offline' });
  });

  it('records a conflict differently from a plain failure', () => {
    expect(answerOf(refused('r1', 'conflict', 'changed elsewhere').refused, 'r1')).toMatchObject({ kind: 'conflict' });
  });

  it('retrying puts it back on its way and counts it again', () => {
    const state = transition(refused(), { type: 'RETRY_SAVE', requestId: 'r1' });
    expect(state.refused).toEqual([]);
    expect(answerOf(state.pending, 'r1')).toMatchObject({ index: 0, action: 'remember' });
    expect(state.tally).toEqual({ remember: 1, notRemember: 0, skipped: 0 });
  });

  it('a second refusal puts it back out of the way', () => {
    const state = run(refused(), { type: 'RETRY_SAVE', requestId: 'r1' }, { type: 'SAVE_REFUSED', requestId: 'r1', kind: 'save', message: 'still offline' });
    expect(state.pending).toEqual([]);
    expect(answerOf(state.refused, 'r1')).toMatchObject({ message: 'still offline' });
    expect(state.tally).toEqual({ remember: 0, notRemember: 0, skipped: 1 });
  });

  it('dismissing gives up on it without ever counting it', () => {
    const state = transition(refused(), { type: 'DISMISS_REFUSAL', requestId: 'r1' });
    expect(state.refused).toEqual([]);
    expect(state.pending).toEqual([]);
    expect(state.tally).toEqual({ remember: 0, notRemember: 0, skipped: 1 });
    expect(transition(state, { type: 'DISMISS_REFUSAL', requestId: 'r1' })).toBe(state);
  });

  it('only names answers it actually has', () => {
    const waiting = answering();
    expect(transition(waiting, { type: 'RETRY_SAVE', requestId: 'nope' })).toBe(waiting);
    expect(transition(waiting, { type: 'DISMISS_REFUSAL', requestId: 'nope' })).toBe(waiting);
  });
});

describe('undo', () => {
  const oneSaved = () => settled();

  it('is offered for the confirmed answer just before the current position', () => {
    expect(canUndo(oneSaved())).toBe(true);
  });

  it('is not offered while a later answer has taken its place', () => {
    const state = run(oneSaved(), { type: 'FLIP' }, grade('remember', 'r2'));
    expect(isSaving(state)).toBe(true);
    expect(state.lastSaved).not.toBeNull();
    expect(canUndo(state)).toBe(false);
  });

  it('is not offered for a card that was answered between', () => {
    const state = run(oneSaved(), { type: 'FLIP' }, grade('remember', 'r2'), { type: 'SAVE_REFUSED', requestId: 'r2', kind: 'save', message: 'offline' });
    expect(state.lastSaved).not.toBeNull();
    expect(canUndo(state)).toBe(false);
  });

  it('returns to the answered card unflipped and takes the answer back', () => {
    const undoing = transition(oneSaved(), { type: 'UNDO' });
    expect(undoing.undoing).toBe(true);
    const done = transition(undoing, { type: 'UNDO_SUCCEEDED' });
    expect(done).toMatchObject({ status: 'ready', index: 0, lastSaved: null, undoing: false });
    expect(done.tally).toEqual({ remember: 0, notRemember: 0, skipped: 0 });
    expect(done.revealed).toBe(true);
  });

  it('keeps the offer when Undo fails for a reason that may pass', () => {
    const state = transition(transition(oneSaved(), { type: 'UNDO' }), {
      type: 'UNDO_FAILED',
      message: 'offline',
      final: false,
    });
    expect(state.undoing).toBe(false);
    expect(state.lastSaved).not.toBeNull();
    expect(state.undoError).toBe('offline');
  });

  it('withdraws the offer when the answer can no longer be undone', () => {
    const state = transition(transition(oneSaved(), { type: 'UNDO' }), {
      type: 'UNDO_FAILED',
      message: 'too late',
      final: true,
    });
    expect(state.lastSaved).toBeNull();
  });
});
