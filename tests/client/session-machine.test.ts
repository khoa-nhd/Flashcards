import { describe, expect, it } from 'vitest';
import {
  canUndo,
  currentCard,
  initialSessionState,
  isSaving,
  saveIssue,
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

/** Two cards, the first flipped and answered: the answer is in flight, the next card is up. */
const saving = () => run(loaded(2), { type: 'FLIP' }, grade('remember'));

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
    const settled = run(saving(), { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true });
    const reloading = transition(settled, { type: 'LOAD' });
    expect(reloading).toMatchObject({ status: 'loading', cards: [], index: 0, tally: { remember: 0 } });
    expect(transition(loaded(0), { type: 'LOAD' }).status).toBe('loading');
  });

  it('refuses to reload while a save is in flight', () => {
    const inFlight = saving();
    expect(transition(inFlight, { type: 'LOAD' })).toBe(inFlight);
  });

  it('ignores a late load result once the session has moved on', () => {
    const ready = loaded(2);
    expect(transition(ready, { type: 'LOAD_SUCCEEDED', cards: [], meta })).toBe(ready);
    expect(transition(ready, { type: 'LOAD_FAILED', message: 'x', unauthorized: false })).toBe(ready);
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

  it('can flip the next card while an earlier answer is still saving', () => {
    const inFlight = saving();
    expect(isSaving(inFlight)).toBe(true);
    const next = flip(inFlight);
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
    expect(answered.saving).toMatchObject({ index: 0, action: 'not_remember', requestId: 'r1' });
  });

  it('completes after the last card, while its answer is still in flight', () => {
    const done = run(loaded(1), { type: 'FLIP' }, grade('remember'));
    expect(done).toMatchObject({ status: 'completed', index: 1 });
    expect(currentCard(done)).toBeNull();
    expect(isSaving(done)).toBe(true);
  });

  it('a second answer while one is saving changes nothing', () => {
    const inFlight = saving();
    const onNext = flip(inFlight);
    expect(transition(onNext, grade('not_remember'))).toBe(onNext);
  });

  it('is blocked while a failed answer is unresolved', () => {
    const failed = transition(saving(), { type: 'SAVE_FAILED', requestId: 'r1', message: 'offline' });
    const onNext = flip(failed);
    expect(transition(onNext, grade('remember', 'r2'))).toBe(onNext);
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

describe('saving', () => {
  it('clears the pending answer on success and offers Undo for a stored one', () => {
    const settled = transition(saving(), { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true });
    expect(settled).toMatchObject({ index: 1, error: null, saving: null });
    expect(settled.lastSaved).toMatchObject({ index: 0, action: 'remember', requestId: 'r1' });
    expect(isSaving(settled)).toBe(false);
  });

  it('does not offer Undo for an answer the server only pretended to store', () => {
    const settled = transition(saving(), { type: 'SAVE_SETTLED', requestId: 'r1', undoable: false });
    expect(settled.lastSaved).toBeNull();
  });

  it('ignores a result whose request id is not the one in flight', () => {
    const inFlight = saving();
    expect(transition(inFlight, { type: 'SAVE_SETTLED', requestId: 'other', undoable: true })).toBe(inFlight);
    expect(transition(inFlight, { type: 'SAVE_FAILED', requestId: 'other', message: 'x' })).toBe(inFlight);
  });

  it('ignores save results when nothing is in flight', () => {
    for (const state of [loaded(2), flip(loaded(2)), loaded(0)]) {
      expect(transition(state, { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true })).toBe(state);
      expect(transition(state, { type: 'SAVE_FAILED', requestId: 'r1', message: 'x' })).toBe(state);
      expect(transition(state, { type: 'SAVE_CONFLICT', requestId: 'r1', message: 'x' })).toBe(state);
    }
  });
});

describe('save failures', () => {
  const failed = () => transition(saving(), { type: 'SAVE_FAILED', requestId: 'r1', message: 'offline' });

  it('keeps the answer and flags it, without stepping back over the card', () => {
    const state = failed();
    expect(state).toMatchObject({ status: 'ready', index: 1, error: { kind: 'save', message: 'offline' } });
    expect(saveIssue(state)).toMatchObject({ kind: 'save' });
    expect(state.failed).toMatchObject({ index: 0, action: 'remember', requestId: 'r1' });
  });

  it('retries the identical answer', () => {
    const retrying = transition(failed(), { type: 'RETRY_SAVE' });
    expect(retrying).toMatchObject({ error: null, saving: { index: 0, action: 'remember', requestId: 'r1' } });
    expect(retrying.failed).toBeNull();
  });

  it('can be discarded, giving its optimistic answer back', () => {
    const discarded = transition(failed(), { type: 'CANCEL_SAVE' });
    expect(discarded).toMatchObject({ index: 1, error: null, saving: null, failed: null });
    expect(discarded.tally).toEqual({ remember: 0, notRemember: 0, skipped: 0 });
  });

  it('cannot be skipped as if the record had changed', () => {
    const state = failed();
    expect(transition(state, { type: 'SKIP_CARD' })).toBe(state);
  });
});

describe('conflicts', () => {
  const conflicted = () => transition(saving(), { type: 'SAVE_CONFLICT', requestId: 'r1', message: 'changed elsewhere' });

  it('flags the answer and counts the card as changed elsewhere', () => {
    const state = conflicted();
    expect(state).toMatchObject({ status: 'ready', index: 1, error: { kind: 'conflict' } });
    expect(state.tally).toEqual({ remember: 0, notRemember: 0, skipped: 1 });
  });

  it('cannot be retried, only passed', () => {
    const state = conflicted();
    expect(transition(state, { type: 'RETRY_SAVE' })).toBe(state);
    expect(transition(state, { type: 'CANCEL_SAVE' })).toBe(state);
    expect(transition(state, { type: 'SKIP_CARD' })).toMatchObject({ error: null });
  });
});

describe('undo', () => {
  const oneSaved = () => transition(saving(), { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true });

  it('is offered for the confirmed answer just before the current position', () => {
    expect(canUndo(oneSaved())).toBe(true);
  });

  it('is not offered while an answer is still in flight', () => {
    const state = run(oneSaved(), { type: 'FLIP' }, grade('remember', 'r2'));
    expect(isSaving(state)).toBe(true);
    expect(state.lastSaved).not.toBeNull();
    expect(canUndo(state)).toBe(false);
  });

  it('is not offered for a card that was skipped or failed in between', () => {
    const state = transition(
      run(saving(), { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true }, { type: 'FLIP' }, grade('remember', 'r2')),
      { type: 'SAVE_FAILED', requestId: 'r2', message: 'offline' },
    );
    expect(transition(state, { type: 'CANCEL_SAVE' }).lastSaved).not.toBeNull();
    expect(canUndo(transition(state, { type: 'CANCEL_SAVE' }))).toBe(false);
  });

  it('returns to the answered card unflipped and takes the answer back', () => {
    const undoing = transition(oneSaved(), { type: 'UNDO' });
    expect(undoing.undoing).toBe(true);
    const done = transition(undoing, { type: 'UNDO_SUCCEEDED' });
    expect(done).toMatchObject({ status: 'ready', index: 0, lastSaved: null, undoing: false });
    expect(done.tally).toEqual({ remember: 0, notRemember: 0, skipped: 0 });
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
