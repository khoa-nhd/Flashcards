// @vitest-environment jsdom
/**
 * Focus Mode in the browser: the Review and Practice pages can hide the app
 * chrome and show a countdown. It is only a view on the page — it never ends
 * a session, answers a card or intercepts a review key — so several tests
 * here are about what does NOT happen.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReviewActionResponse } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';
import { card } from '../helpers/fixtures.js';

const applied: ReviewActionResponse = { outcome: 'applied', state: null };

/** The same way of opening a page as the other client tests: copied, not shared. */
async function open(path: string, options: FakeApiOptions = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: [entry(1), entry(2)], ...options });
  const store = createSettingsStore(null);
  const view = render(<App api={fake.api} settings={store} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup(), ...view };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  // Some tests count with fake time; the rest of the suite wants the real clock back.
  vi.useRealTimers();
});

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, code: key === ' ' ? 'Space' : key, ...init });
const timer = () => screen.getByRole('group', { name: 'Focus timer' });
/** The sidebar and the bottom bar are the only navigation landmarks. */
const chrome = () => screen.queryAllByRole('navigation').length;

describe('the Focus switch on Review', () => {
  it('hides the navigation and shows the timer, and gives both back', async () => {
    const { user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    expect(chrome()).toBe(2);
    expect(screen.queryByRole('group', { name: 'Focus timer' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(chrome()).toBe(0);
    expect(within(timer()).getByText('15:00')).toBeInTheDocument();
    expect(within(timer()).getByRole('button', { name: '15 min' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(timer()).getByRole('button', { name: '20 min' })).toHaveAttribute('aria-pressed', 'false');
    // The review itself is exactly where it was.
    expect(screen.getByTestId('flashcard')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(chrome()).toBe(2);
    expect(screen.queryByRole('group', { name: 'Focus timer' })).not.toBeInTheDocument();
  });

  it('leaves every review key working while it is on', async () => {
    const { api, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    await user.click(screen.getByRole('button', { name: 'Focus' }));

    press(' ');
    expect(screen.getByTestId('flashcard').dataset.flipped).toBe('true');
    press('ArrowRight');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
  });

  it('counts down, and Pause holds the time until Resume', async () => {
    await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(within(timer()).getByText('15:00')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(within(timer()).getByText('14:57')).toBeInTheDocument();

    fireEvent.click(within(timer()).getByRole('button', { name: 'Pause' }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(within(timer()).getByText('14:57')).toBeInTheDocument();

    fireEvent.click(within(timer()).getByRole('button', { name: 'Resume' }));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(within(timer()).getByText('14:55')).toBeInTheDocument();
  });

  it('says the time is up when it reaches zero, and goes no further', async () => {
    await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));

    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000);
    });
    expect(within(timer()).getByRole('status')).toHaveTextContent('Time is up');
    expect(within(timer()).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    // The countdown is a reminder on screen only: the session is still going.
    expect(screen.getByTestId('flashcard')).toBeInTheDocument();
  });

  it('is left behind when the reviewer finishes and moves to another page', async () => {
    const { saves, user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(chrome()).toBe(0);

    press(' ');
    press('ArrowRight');
    await act(async () => saves[0]?.resolve(applied));
    await user.click(await screen.findByRole('link', { name: 'Finish' }));

    // Another page gets its chrome back; Focus belonged to the Review page alone.
    await waitFor(() => expect(chrome()).toBe(2));
    expect(screen.queryByRole('group', { name: 'Focus timer' })).not.toBeInTheDocument();
  });
});

describe('the Focus switch on Practice', () => {
  it('hides the same chrome and shows the timer, leaving the page itself untouched', async () => {
    const { user } = await open('/practice');
    expect(await screen.findByText('Start a practice session')).toBeInTheDocument();
    expect(chrome()).toBe(2);
    expect(screen.queryByRole('group', { name: 'Focus timer' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(chrome()).toBe(0);
    expect(within(timer()).getByText('15:00')).toBeInTheDocument();
    expect(screen.getByText('Start a practice session')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(chrome()).toBe(2);
    expect(screen.queryByRole('group', { name: 'Focus timer' })).not.toBeInTheDocument();
  });
});
