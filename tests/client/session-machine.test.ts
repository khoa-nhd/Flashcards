import { describe, expect, it } from 'vitest';
import {
  currentCard,
  initialSessionState,
  transition,
  type SessionEvent,
  type SessionState,
  type SessionStatus,
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

const stateIn = (status: SessionStatus): SessionState => {
  switch (status) {
    case 'loading':
      return initialSessionState;
    case 'ready':
      return loaded(2);
    case 'flipped':
      return run(loaded(2), { type: 'FLIP' });
    case 'saving':
      return run(loaded(2), { type: 'FLIP' }, { type: 'GRADE', action: 'remember' });
    case 'error':
      return run(stateIn('saving'), { type: 'SAVE_FAILED', message: 'offline' });
    case 'completed':
      return loaded(0);
  }
};

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
    const midway = run(loaded(3), { type: 'FLIP' }, { type: 'GRADE', action: 'remember' }, { type: 'SAVE_SUCCEEDED' });
    const reloading = transition(midway, { type: 'LOAD' });
    expect(reloading).toMatchObject({ status: 'loading', cards: [], index: 0, tally: { remember: 0 } });
    expect(transition(stateIn('completed'), { type: 'LOAD' }).status).toBe('loading');
    expect(transition(stateIn('error'), { type: 'LOAD' }).status).toBe('loading');
  });

  it('refuses to reload while a save is in flight', () => {
    const saving = stateIn('saving');
    expect(transition(saving, { type: 'LOAD' })).toBe(saving);
  });

  it('ignores a late load result once the session has moved on', () => {
    const ready = loaded(2);
    expect(transition(ready, { type: 'LOAD_SUCCEEDED', cards: [], meta })).toBe(ready);
    expect(transition(ready, { type: 'LOAD_FAILED', message: 'x', unauthorized: false })).toBe(ready);
  });
});

describe('flipping', () => {
  it('toggles between front and back', () => {
    const flipped = transition(loaded(1), { type: 'FLIP' });
    expect(flipped.status).toBe('flipped');
    expect(transition(flipped, { type: 'FLIP' }).status).toBe('ready');
  });

  it.each(['loading', 'saving', 'error', 'completed'] as const)('is ignored while %s', (status) => {
    const state = stateIn(status);
    expect(transition(state, { type: 'FLIP' })).toBe(state);
  });
});

describe('grading', () => {
  it('is only possible once the card is flipped', () => {
    const ready = loaded(2);
    expect(transition(ready, { type: 'GRADE', action: 'remember' })).toBe(ready);
    expect(transition(ready, { type: 'GRADE', action: 'not_remember' })).toBe(ready);
    const saving = run(ready, { type: 'FLIP' }, { type: 'GRADE', action: 'not_remember' });
    expect(saving).toMatchObject({ status: 'saving', pendingAction: 'not_remember', index: 0 });
  });

  it.each(['loading', 'ready', 'saving', 'error', 'completed'] as const)('is ignored while %s', (status) => {
    const state = stateIn(status);
    expect(transition(state, { type: 'GRADE', action: 'remember' })).toBe(state);
  });

  it('a second answer while saving changes nothing', () => {
    const saving = stateIn('saving');
    expect(transition(saving, { type: 'GRADE', action: 'not_remember' })).toBe(saving);
    expect(saving.pendingAction).toBe('remember');
  });
});

describe('saving', () => {
  it('advances to the front of the next card only when the save succeeds', () => {
    const saving = stateIn('saving');
    expect(saving.index).toBe(0);
    const next = transition(saving, { type: 'SAVE_SUCCEEDED' });
    expect(next).toMatchObject({ status: 'ready', index: 1, pendingAction: null, error: null });
    expect(next.tally).toEqual({ remember: 1, notRemember: 0, skipped: 0 });
  });

  it('counts each kind of answer', () => {
    const state = run(
      loaded(3),
      { type: 'FLIP' },
      { type: 'GRADE', action: 'not_remember' },
      { type: 'SAVE_SUCCEEDED' },
      { type: 'FLIP' },
      { type: 'GRADE', action: 'remember' },
      { type: 'SAVE_SUCCEEDED' },
    );
    expect(state.tally).toEqual({ remember: 1, notRemember: 1, skipped: 0 });
    expect(state.index).toBe(2);
  });

  it('completes after the last card', () => {
    const done = run(loaded(1), { type: 'FLIP' }, { type: 'GRADE', action: 'remember' }, { type: 'SAVE_SUCCEEDED' });
    expect(done).toMatchObject({ status: 'completed', index: 1 });
    expect(currentCard(done)).toBeNull();
  });

  it('ignores save results that arrive in any other state', () => {
    for (const status of ['ready', 'flipped', 'completed', 'loading'] as const) {
      const state = stateIn(status);
      expect(transition(state, { type: 'SAVE_SUCCEEDED' })).toBe(state);
      expect(transition(state, { type: 'SAVE_FAILED', message: 'x' })).toBe(state);
      expect(transition(state, { type: 'SAVE_CONFLICT', message: 'x' })).toBe(state);
    }
  });
});

describe('save failures', () => {
  it('keeps the same card and remembers the answer', () => {
    const failed = stateIn('error');
    expect(failed).toMatchObject({
      status: 'error',
      index: 0,
      pendingAction: 'remember',
      error: { kind: 'save', message: 'offline' },
      tally: { remember: 0, notRemember: 0, skipped: 0 },
    });
  });

  it('retries the identical answer', () => {
    const retrying = transition(stateIn('error'), { type: 'RETRY_SAVE' });
    expect(retrying).toMatchObject({ status: 'saving', pendingAction: 'remember', error: null, index: 0 });
  });

  it('can return to the flipped card without answering', () => {
    const back = transition(stateIn('error'), { type: 'CANCEL_SAVE' });
    expect(back).toMatchObject({ status: 'flipped', pendingAction: null, error: null, index: 0 });
  });

  it('cannot skip a card whose save merely failed', () => {
    const failed = stateIn('error');
    expect(transition(failed, { type: 'SKIP_CARD' })).toBe(failed);
  });
});

describe('conflicts', () => {
  const conflicted = () => transition(stateIn('saving'), { type: 'SAVE_CONFLICT', message: 'changed elsewhere' });

  it('stops on the card without advancing', () => {
    expect(conflicted()).toMatchObject({ status: 'error', index: 0, error: { kind: 'conflict' } });
  });

  it('cannot be retried or cancelled back into a stale card', () => {
    const state = conflicted();
    expect(transition(state, { type: 'RETRY_SAVE' })).toBe(state);
    expect(transition(state, { type: 'CANCEL_SAVE' })).toBe(state);
  });

  it('moves on only by an explicit skip, counted separately', () => {
    const skipped = transition(conflicted(), { type: 'SKIP_CARD' });
    expect(skipped).toMatchObject({ status: 'ready', index: 1, error: null, pendingAction: null });
    expect(skipped.tally).toEqual({ remember: 0, notRemember: 0, skipped: 1 });
  });
});
