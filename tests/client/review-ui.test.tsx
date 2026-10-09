// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { QueueResponse, ReviewActionResponse, ReviewCard } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { Flashcard } from '../../src/components/Flashcard.js';
import { ApiError, type ReviewApi } from '../../src/lib/api-client.js';
import { TODAY, card, deferred, queueResponse, type Deferred } from '../helpers/fixtures.js';

const applied: ReviewActionResponse = { outcome: 'applied', state: null };

async function renderApp(cards: ReviewCard[] = [card(1), card(2), card(3)], meta: Partial<QueueResponse> = {}) {
  const saves: Array<Deferred<ReviewActionResponse>> = [];
  const api = {
    fetchQueue: vi.fn(async () => queueResponse(cards, meta)),
    submitAction: vi.fn(() => {
      const pending = deferred<ReviewActionResponse>();
      saves.push(pending);
      return pending.promise;
    }),
    login: vi.fn(async () => undefined),
  } satisfies ReviewApi;
  const view = render(<App api={api} />);
  if (cards.length > 0) await screen.findByTestId('flashcard');
  return { api, saves, ...view };
}

const flashcard = () => screen.getByTestId('flashcard');
const isFlipped = () => flashcard().dataset.flipped === 'true';
const showsCard = (position: number, word: string) =>
  screen.getByText(new RegExp(`Card ${position} of \\d+: ${word}\\.`));
const answerButton = (name: 'Remember' | 'Not remember') => screen.getByRole('button', { name });

/** A key press that lands on the page itself, as when nothing is focused. */
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, code: key === ' ' ? 'Space' : key, ...init });

const touch = { pointerId: 1, pointerType: 'touch', isPrimary: true };

/** Drags a finger across the card. Movement is delivered in steps, as a real swipe is. */
function swipe(dx: number, dy = 0, pointer: PointerEventInit = touch) {
  const element = flashcard();
  const start = { clientX: 200, clientY: 300 };
  fireEvent.pointerDown(element, { ...pointer, ...start });
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    fireEvent.pointerMove(element, {
      ...pointer,
      clientX: start.clientX + dx * fraction,
      clientY: start.clientY + dy * fraction,
    });
  }
  fireEvent.pointerUp(element, { ...pointer, clientX: start.clientX + dx, clientY: start.clientY + dy });
}

async function settle(save: Deferred<ReviewActionResponse> | undefined, result = applied) {
  await act(async () => {
    save?.resolve(result);
  });
}

async function fail(save: Deferred<ReviewActionResponse> | undefined, error: unknown) {
  await act(async () => {
    save?.reject(error);
  });
}

describe('the card front', () => {
  it('shows the word and metadata but not the answer', async () => {
    await renderApp();
    expect(screen.getByRole('heading', { name: 'word-1' })).toBeInTheDocument();
    expect(screen.getByText('noun')).toBeInTheDocument();
    expect(screen.getByText('Mastery 3')).toBeInTheDocument();
    expect(screen.getByText('Due today')).toBeInTheDocument();
    expect(isFlipped()).toBe(false);
    // The answer is not merely hidden; it is not in the document at all.
    expect(screen.queryByText('definition of word-1')).not.toBeInTheDocument();
  });

  it('shows progress and how many cards remain', async () => {
    await renderApp();
    expect(screen.getByLabelText('Card 1 of 3')).toHaveTextContent('1 / 3');
    expect(screen.getByText('3 left')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('keeps the answer buttons inert until the card is flipped', async () => {
    const { api } = await renderApp();
    expect(answerButton('Remember')).toHaveAttribute('aria-disabled', 'true');
    expect(answerButton('Not remember')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(answerButton('Remember'));
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Flip the card before answering.');
  });

  it('tells the reviewer which keys to use', async () => {
    await renderApp();
    expect(screen.getByRole('note', { name: 'Keyboard shortcuts' })).toHaveTextContent(
      'Space flip← not remember→ remember',
    );
    expect(answerButton('Remember')).toHaveAttribute('aria-keyshortcuts', 'ArrowRight');
    expect(answerButton('Not remember')).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft');
    expect(screen.getByRole('button', { name: 'Flip card to show the answer' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Space',
    );
  });
});

describe('flipping', () => {
  it('Space flips the card and reveals the answer', async () => {
    await renderApp();
    press(' ');
    expect(isFlipped()).toBe(true);
    expect(screen.getByText('definition of word-1')).toBeInTheDocument();
    expect(answerButton('Remember')).toHaveAttribute('aria-disabled', 'false');
  });

  it('Space flips back again', async () => {
    await renderApp();
    press(' ');
    press(' ');
    expect(isFlipped()).toBe(false);
  });

  it('Space does not scroll the page', async () => {
    await renderApp();
    // fireEvent returns false when the handler called preventDefault().
    expect(press(' ')).toBe(false);
  });

  it('a held Space key flips once, not repeatedly', async () => {
    await renderApp();
    press(' ');
    expect(press(' ', { repeat: true })).toBe(false);
    press(' ', { repeat: true });
    expect(isFlipped()).toBe(true);
  });

  it('Space on the focused flip control flips exactly once', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(screen.getByRole('button', { name: 'Flip card to show the answer' })).toHaveFocus();
    await user.keyboard(' ');
    expect(isFlipped()).toBe(true);
    await user.keyboard(' ');
    expect(isFlipped()).toBe(false);
  });

  it('tapping the card flips it', async () => {
    await renderApp();
    fireEvent.click(flashcard());
    expect(isFlipped()).toBe(true);
    fireEvent.click(flashcard());
    expect(isFlipped()).toBe(false);
  });

  it('withholds definition and example on a high-mastery card', async () => {
    await renderApp([card(1, { mastery: 6, back: [], detailsHidden: true })]);
    press(' ');
    expect(screen.getByText(/hidden at this mastery level/)).toBeInTheDocument();
    expect(screen.queryByText('Definition')).not.toBeInTheDocument();
  });

  it('copes with a card that has no definition or example at all', async () => {
    await renderApp([card(1, { front: [], back: [] })]);
    press(' ');
    expect(screen.getByText('No definition or example is recorded for this word.')).toBeInTheDocument();
  });
});

describe('answering with the keyboard', () => {
  it('ArrowLeft and ArrowRight do nothing before the card is flipped', async () => {
    const { api } = await renderApp();
    press('ArrowRight');
    press('ArrowLeft');
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(isFlipped()).toBe(false);
    showsCard(1, 'word-1');
    expect(screen.getByRole('status')).toHaveTextContent('Flip the card before answering.');
  });

  it('ArrowRight selects Remember once the card is flipped', async () => {
    const { api } = await renderApp();
    press(' ');
    press('ArrowRight');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(api.submitAction).toHaveBeenCalledWith({
      pageId: card(1).id,
      action: 'remember',
      expected: { mastery: 3, nextReview: TODAY },
    });
  });

  it('ArrowLeft selects Not Remember once the card is flipped', async () => {
    const { api } = await renderApp();
    press(' ');
    press('ArrowLeft');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(api.submitAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'not_remember' }));
  });

  it('arrow keys still answer while the flip control has focus', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    expect(api.submitAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'remember' }));
  });

  it('a repeated or held key submits the answer only once', async () => {
    const { api } = await renderApp();
    press(' ');
    press('ArrowRight');
    press('ArrowRight');
    press('ArrowRight', { repeat: true });
    press('ArrowLeft');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
  });

  it('a key held down from the previous card does not answer the next one', async () => {
    const { api, saves } = await renderApp();
    press(' ');
    press('ArrowRight');
    await settle(saves[0]);
    showsCard(2, 'word-2');
    press(' ');
    press('ArrowRight', { repeat: true });
    expect(api.submitAction).toHaveBeenCalledTimes(1);
  });

  it('ignores shortcuts combined with a modifier key', async () => {
    const { api } = await renderApp();
    press(' ');
    press('ArrowRight', { ctrlKey: true });
    press('ArrowLeft', { metaKey: true });
    press('ArrowRight', { altKey: true });
    expect(api.submitAction).not.toHaveBeenCalled();
  });

  it('does not interfere with typing in a field', async () => {
    const { api } = await renderApp();
    press(' ');
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    // Not handled, and not prevented: the character reaches the field.
    expect(fireEvent.keyDown(input, { key: ' ', code: 'Space' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'ArrowLeft' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'ArrowRight' })).toBe(true);
    expect(isFlipped()).toBe(true);
    expect(api.submitAction).not.toHaveBeenCalled();
    input.remove();
  });

  it('leaves Space to another button that has focus', async () => {
    await renderApp();
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(fireEvent.keyDown(refresh, { key: ' ', code: 'Space' })).toBe(true);
    expect(isFlipped()).toBe(false);
  });

  it('attaches one key listener and removes it on unmount', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const keydownCalls = (spy: typeof added | typeof removed) =>
      spy.mock.calls.filter(([type]) => type === 'keydown').length;

    const { api, saves, unmount } = await renderApp();
    // Several re-renders and a card change must not stack up listeners.
    press(' ');
    press('ArrowRight');
    await settle(saves[0]);
    press(' ');
    expect(keydownCalls(added)).toBe(1);
    expect(keydownCalls(removed)).toBe(0);

    unmount();
    expect(keydownCalls(removed)).toBe(1);
    expect(press('ArrowRight')).toBe(true);
    expect(api.submitAction).toHaveBeenCalledTimes(1);
  });
});

describe('answering by swiping', () => {
  it('swipe right selects Remember', async () => {
    const { api } = await renderApp();
    press(' ');
    swipe(140);
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(api.submitAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'remember' }));
  });

  it('swipe left selects Not Remember', async () => {
    const { api } = await renderApp();
    press(' ');
    swipe(-140);
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(api.submitAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'not_remember' }));
  });

  it('a small movement does not answer', async () => {
    const { api } = await renderApp();
    press(' ');
    swipe(40);
    swipe(-60);
    swipe(6, 4);
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(isFlipped()).toBe(true);
  });

  it('a vertical scroll gesture does not answer, however far it travels', async () => {
    const { api } = await renderApp();
    press(' ');
    swipe(30, 300);
    swipe(120, -200);
    expect(api.submitAction).not.toHaveBeenCalled();
  });

  it('does not answer before the card is flipped, and says why', async () => {
    const { api } = await renderApp();
    swipe(200);
    swipe(-200);
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(isFlipped()).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('Flip the card before answering.');
  });

  it('does not mistake the click that ends a drag for a tap', async () => {
    await renderApp();
    press(' ');
    swipe(40);
    // Browsers may fire a click when the finger lifts; it must not flip the card back.
    fireEvent.click(flashcard());
    expect(isFlipped()).toBe(true);
  });

  it('still accepts a real tap immediately after a drag', async () => {
    await renderApp();
    swipe(200); // refused: the card is not flipped yet
    const element = flashcard();
    fireEvent.pointerDown(element, { ...touch, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(element, { ...touch, clientX: 201, clientY: 300 });
    fireEvent.click(element);
    expect(isFlipped()).toBe(true);
  });

  it('shows which answer a drag will give before it is released', async () => {
    await renderApp();
    press(' ');
    const element = flashcard();
    fireEvent.pointerDown(element, { ...touch, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(element, { ...touch, clientX: 240, clientY: 300 });
    fireEvent.pointerMove(element, { ...touch, clientX: 330, clientY: 302 });
    // The visible label, not just a colour or movement.
    expect(screen.getByTestId('swipe-feedback')).toHaveTextContent('Remember');
    expect(element.style.transform).toContain('translateX(130px)');
    fireEvent.pointerCancel(element, touch);
    expect(screen.getByTestId('swipe-feedback')).toBeEmptyDOMElement();
    expect(element.style.transform).toBe('');
  });

  it('ignores a second finger and a mouse drag', async () => {
    const { api } = await renderApp();
    press(' ');
    swipe(200, 0, { pointerId: 2, pointerType: 'touch', isPrimary: false });
    swipe(200, 0, { pointerId: 3, pointerType: 'mouse', isPrimary: true });
    expect(api.submitAction).not.toHaveBeenCalled();
  });

  it('cannot answer twice with a swipe and a key together', async () => {
    const { api } = await renderApp();
    press(' ');
    swipe(140);
    press('ArrowLeft');
    swipe(-140);
    expect(api.submitAction).toHaveBeenCalledTimes(1);
  });

  it('uses the configured swipe threshold', () => {
    const onGrade = vi.fn();
    const props = {
      card: card(1),
      today: TODAY,
      flipped: true,
      canGrade: true,
      locked: false,
      pendingAction: null,
      onFlip: vi.fn(),
      onGrade,
      onBlockedGrade: vi.fn(),
    };
    const { rerender } = render(<Flashcard {...props} swipeThresholdPx={200} />);
    swipe(150);
    expect(onGrade).not.toHaveBeenCalled();
    rerender(<Flashcard {...props} swipeThresholdPx={100} />);
    swipe(150);
    expect(onGrade).toHaveBeenCalledExactlyOnceWith('remember');
  });
});

describe('saving', () => {
  it('shows the next card only after the save is confirmed', async () => {
    const { saves } = await renderApp();
    press(' ');
    press('ArrowRight');

    // Still on the first card, visibly saving.
    showsCard(1, 'word-1');
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    expect(screen.queryByText(/Card 2 of 3/)).not.toBeInTheDocument();

    await settle(saves[0]);
    showsCard(2, 'word-2');
    expect(screen.getByLabelText('Card 2 of 3')).toHaveTextContent('2 / 3');
    expect(screen.getByText('2 left')).toBeInTheDocument();
  });

  it('resets the next card to its front', async () => {
    const { saves } = await renderApp();
    press(' ');
    press('ArrowRight');
    await settle(saves[0]);
    expect(isFlipped()).toBe(false);
    expect(screen.queryByText('definition of word-2')).not.toBeInTheDocument();
    expect(answerButton('Remember')).toHaveAttribute('aria-disabled', 'true');
    // Focus returns to the card so the next Space press flips it.
    expect(screen.getByRole('button', { name: 'Flip card to show the answer' })).toHaveFocus();
  });

  it('cannot be flipped or answered again while saving', async () => {
    const { api } = await renderApp();
    press(' ');
    const remember = answerButton('Remember');
    const notRemember = answerButton('Not remember');
    fireEvent.click(remember);
    fireEvent.click(remember); // a double click
    fireEvent.click(notRemember);
    fireEvent.click(flashcard());
    press(' ');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(isFlipped()).toBe(true);
    expect(remember).toHaveAttribute('aria-busy', 'true');
    expect(notRemember).toHaveAttribute('aria-disabled', 'true');
  });

  it('answers with the on-screen buttons too', async () => {
    const { api, saves } = await renderApp();
    press(' ');
    fireEvent.click(answerButton('Not remember'));
    expect(api.submitAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'not_remember' }));
    await settle(saves[0]);
    showsCard(2, 'word-2');
  });

  it('shows the completion screen when the queue is exhausted', async () => {
    const { saves } = await renderApp([card(1), card(2)]);
    press(' ');
    press('ArrowRight');
    await settle(saves[0]);
    press(' ');
    press('ArrowLeft');
    await settle(saves[1]);

    expect(screen.getByRole('heading', { name: 'Review complete' })).toBeInTheDocument();
    expect(screen.getByText('You went through 2 cards.')).toBeInTheDocument();
    expect(screen.getByText('Remembered').previousSibling).toHaveTextContent('1');
    expect(screen.getByText('Not remembered').previousSibling).toHaveTextContent('1');
    expect(screen.queryByTestId('flashcard')).not.toBeInTheDocument();
  });

  it('says so when nothing is due', async () => {
    await renderApp([]);
    expect(await screen.findByRole('heading', { name: 'Nothing is due right now' })).toBeInTheDocument();
  });
});

describe('when saving fails', () => {
  it('stays on the card and explains what happened', async () => {
    const { saves } = await renderApp();
    press(' ');
    press('ArrowRight');
    await fail(saves[0], new ApiError('network', 'Could not reach the server. Check your connection.'));

    expect(screen.getByRole('alert')).toHaveTextContent('Your answer was not confirmed');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server. Check your connection.');
    showsCard(1, 'word-1');
    expect(screen.getByLabelText('Card 1 of 3')).toHaveTextContent('1 / 3');
    expect(isFlipped()).toBe(true);
  });

  it('ignores answer shortcuts until the failure is dealt with', async () => {
    const { api, saves } = await renderApp();
    press(' ');
    press('ArrowRight');
    await fail(saves[0], new ApiError('network', 'offline'));
    press('ArrowRight');
    press('ArrowLeft');
    swipe(200);
    press(' ');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(isFlipped()).toBe(true);
  });

  it('retries the same answer and advances once it is confirmed', async () => {
    const { api, saves } = await renderApp();
    press(' ');
    press('ArrowRight');
    await fail(saves[0], new ApiError('timeout', 'No confirmation arrived in time.'));

    const retry = screen.getByRole('button', { name: 'Retry “Remember”' });
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(api.submitAction).toHaveBeenCalledTimes(2);
    expect(api.submitAction.mock.calls[1]).toEqual(api.submitAction.mock.calls[0]);
    showsCard(1, 'word-1');

    await settle(saves[1], { outcome: 'already_applied', state: { mastery: 4, nextReview: '2026-10-13' } });
    showsCard(2, 'word-2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('can return to the card to choose again', async () => {
    const { api, saves } = await renderApp();
    press(' ');
    press('ArrowRight');
    await fail(saves[0], new ApiError('network', 'offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Back to card' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    press('ArrowLeft');
    expect(api.submitAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'not_remember' }));
  });

  it('does not offer a retry for a card that changed in Notion', async () => {
    const { api, saves } = await renderApp();
    press(' ');
    press('ArrowRight');
    await fail(saves[0], new ApiError('conflict', 'This card was changed in Notion after it was loaded.', 409));

    expect(screen.getByRole('alert')).toHaveTextContent('This card changed in Notion');
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip this card' }));
    showsCard(2, 'word-2');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
  });
});

describe('the session as a whole', () => {
  it('refresh reloads the queue without writing anything', async () => {
    const { api } = await renderApp();
    press(' ');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.fetchQueue).toHaveBeenCalledTimes(2));
    await screen.findByTestId('flashcard');
    expect(isFlipped()).toBe(false);
    expect(api.submitAction).not.toHaveBeenCalled();
  });

  it('marks sample data and read-only previews clearly', async () => {
    const mock = await renderApp([card(1)], { mode: 'mock' });
    expect(screen.getByText('Sample data')).toBeInTheDocument();
    mock.unmount();
    await renderApp([card(1)], { mode: 'notion', writesEnabled: false });
    expect(screen.getByText('Preview · not saving')).toBeInTheDocument();
  });

  it('lists records that were left out of the queue', async () => {
    await renderApp([card(1)], { skipped: [{ id: 'x', word: 'orphan', reason: 'Mastery is empty.' }] });
    expect(screen.getByText('1 record was left out of this queue')).toBeInTheDocument();
    expect(screen.getByText('orphan')).toBeInTheDocument();
  });

  it('shows a load failure with a way to try again', async () => {
    const api = {
      fetchQueue: vi
        .fn<ReviewApi['fetchQueue']>()
        .mockRejectedValueOnce(new ApiError('setup_incomplete', 'No property named "Mastery".', 503))
        .mockResolvedValue(queueResponse([card(1)])),
      submitAction: vi.fn<ReviewApi['submitAction']>(),
      login: vi.fn<ReviewApi['login']>(),
    };
    render(<App api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No property named "Mastery".');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('flashcard')).toBeInTheDocument();
  });

  it('asks for the access password when the server requires one', async () => {
    const user = userEvent.setup();
    const api = {
      fetchQueue: vi
        .fn<ReviewApi['fetchQueue']>()
        .mockRejectedValueOnce(new ApiError('unauthorized', 'Enter the access password to continue.', 401))
        .mockResolvedValue(queueResponse([card(1)])),
      submitAction: vi.fn<ReviewApi['submitAction']>(),
      login: vi
        .fn<ReviewApi['login']>()
        .mockRejectedValueOnce(new ApiError('invalid_password', 'That password is not correct.', 401))
        .mockResolvedValue(undefined),
    };
    render(<App api={api} />);

    const field = await screen.findByLabelText('Access password');
    // Spaces and arrow keys are ordinary typing here.
    await user.type(field, 'a b{ArrowLeft}{ArrowRight}');
    expect(field).toHaveValue('a b');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct.');

    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByTestId('flashcard')).toBeInTheDocument();
    expect(api.login).toHaveBeenCalledTimes(2);
    expect(api.login).toHaveBeenLastCalledWith('a b');
  });
});
