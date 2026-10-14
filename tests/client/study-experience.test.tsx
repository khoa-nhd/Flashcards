// @vitest-environment jsdom
/**
 * Phase 4 in the browser: narrowing a review, the daily goal, confidence
 * ratings and keyboard shortcuts. None of them may change what is due or what
 * an answer does, so several tests here are about what does NOT happen.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES, type QueueResponse, type ReviewActionResponse } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { goalMessage } from '../../src/components/GoalStatus.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSessionController } from '../../src/lib/session-controller.js';
import { initialSessionState, transition, type SessionState } from '../../src/lib/session-machine.js';
import { createSettingsStore, type Settings } from '../../src/lib/settings.js';
import {
  analyticsResponse,
  createFakeApi,
  dayPlan,
  entry,
  periodStats,
  type FakeApiOptions,
} from '../helpers/fake-api.js';
import { card, queueResponse } from '../helpers/fixtures.js';

const applied: ReviewActionResponse = { outcome: 'applied', state: null };
const RATED = { capabilities: { ...NO_CAPABILITIES, sessions: true, undo: true, confidence: true, goals: true } };

interface Options extends FakeApiOptions {
  settings?: Partial<Settings>;
}

async function open(path: string, { settings = {}, ...options }: Options = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: [entry(1), entry(2)], ...options });
  const store = createSettingsStore(null);
  store.update(settings);
  const view = render(<App api={fake.api} settings={store} />);
  await screen.findAllByRole('navigation');
  return { ...fake, store, user: userEvent.setup(), ...view };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, code: key === ' ' ? 'Space' : key, ...init });
const isFlipped = () => screen.getByTestId('flashcard').dataset.flipped === 'true';
const lastRequest = (api: ReturnType<typeof createFakeApi>['api']) => api.submitAction.mock.calls.at(-1)?.[0];

describe('choosing what to review', () => {
  const chooser = () => screen.getByLabelText('Cards to review') as HTMLSelectElement;

  it('offers every selection, starting on everything due', async () => {
    await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    expect(chooser().value).toBe('');
    expect(within(chooser()).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Everything due',
      'Weakest words',
      'Overdue only',
      'Due today only',
      'Recently added',
    ]);
  });

  it('loads the chosen selection as a new session and says what is shown', async () => {
    const { api, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    await user.selectOptions(chooser(), 'overdue');

    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: 'overdue' }));
    expect(window.location.pathname + window.location.search).toBe('/review?focus=overdue');
    expect(await screen.findByText(/Overdue words only\./)).toBeInTheDocument();
    expect(chooser().value).toBe('overdue');
  });

  it('hands the keyboard back to the card after a choice, so an arrow key answers instead of changing it', async () => {
    const { api, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    await user.selectOptions(chooser(), 'recent');
    await screen.findByText(/Words added in the last 7 days only/);
    expect(document.activeElement).not.toBe(chooser());

    press(' ');
    press('ArrowRight');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(chooser().value).toBe('recent');
  });

  it('goes back to everything due', async () => {
    const { api, user } = await open('/review?focus=due_today', { cards: [card(1)] });
    await screen.findByText(/Words due today only\./);
    await user.selectOptions(chooser(), '');
    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null }));
    expect(window.location.search).toBe('');
    await waitFor(() => expect(screen.queryByText(/Words due today only\./)).not.toBeInTheDocument());
  });

  it.each([
    ['overdue', 'Nothing is overdue'],
    ['due_today', 'Nothing is dated today'],
    ['recent', 'No recent words are due'],
    ['weak', 'No weak words are due'],
  ])('says what an empty "%s" selection means, without claiming nothing at all is due', async (focus, title) => {
    await open(`/review?focus=${focus}`, { cards: [] });
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Nothing is due right now' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review everything due' })).toHaveAttribute('href', '/review');
  });

  it('treats an unknown selection in the address as everything due', async () => {
    const { api } = await open('/review?focus=everything-and-more', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null });
    expect(chooser().value).toBe('');
  });

  it('cannot be changed while an answer is being saved', async () => {
    await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    expect(chooser()).toBeDisabled();
  });
});

describe('the shortcut list', () => {
  const dialog = () => screen.queryByRole('dialog', { name: 'Keyboard shortcuts' });

  it('opens with ? and lists the keys as they are set up', async () => {
    await open('/review', { cards: [card(1)], queue: RATED });
    await screen.findByTestId('flashcard');
    expect(dialog()).not.toBeInTheDocument();
    press('?', { shiftKey: true });

    const list = within(dialog()!);
    expect(list.getByRole('row', { name: /Space/ })).toHaveTextContent('Show the answer');
    expect(list.getByRole('row', { name: /→/ })).toHaveTextContent('Remember');
    expect(list.getByRole('row', { name: /←/ })).toHaveTextContent('Not remember');
    expect(list.getByRole('row', { name: /^U/ })).toHaveTextContent('Undo the last answer');
    expect(list.getByRole('row', { name: /Esc/ })).toHaveTextContent('Close');
    // Confidence is not being asked for, so its keys are not listed.
    expect(list.queryByText(/how sure you are/)).not.toBeInTheDocument();
  });

  it('shows the extra answer keys and the confidence keys when they are in use', async () => {
    await open('/review', { cards: [card(1)], queue: RATED, settings: { answerKeys: 'fj', askConfidence: true } });
    await screen.findByTestId('flashcard');
    press('?', { shiftKey: true });
    const list = within(dialog()!);
    expect(list.getByRole('row', { name: /→/ })).toHaveTextContent('→J');
    expect(list.getByRole('row', { name: /←/ })).toHaveTextContent('←F');
    expect(list.getByRole('row', { name: /^1/ })).toHaveTextContent('how sure you are');
  });

  it('leaves out Undo where an answer cannot be taken back', async () => {
    await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    press('?', { shiftKey: true });
    expect(within(dialog()!).queryByText('Undo the last answer')).not.toBeInTheDocument();
  });

  it('keeps every review key away from the card while it is open', async () => {
    const { api } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    press(' ');
    expect(isFlipped()).toBe(true);
    press('?', { shiftKey: true });

    press('ArrowRight');
    press('ArrowLeft');
    press(' ');
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(isFlipped()).toBe(true);
  });

  it('closes with its button and with Escape, and the keys work again', async () => {
    const { api, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    press('?', { shiftKey: true });
    await user.click(within(dialog()!).getByRole('button', { name: 'Close' }));
    expect(dialog()).not.toBeInTheDocument();

    press('?', { shiftKey: true });
    fireEvent(dialog()!, new Event('cancel', { cancelable: true }));
    expect(dialog()).not.toBeInTheDocument();

    press(' ');
    press('ArrowRight');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
  });

  it('can also be opened with a button', async () => {
    const { user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(dialog()).toBeInTheDocument();
  });

  it('is not opened by ? typed into a field', async () => {
    const { user } = await open('/bank');
    const search = await screen.findByRole('searchbox');
    await user.type(search, 'what?');
    expect(dialog()).not.toBeInTheDocument();
  });
});

describe('extra answer keys', () => {
  it('do nothing unless switched on', async () => {
    const { api } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    press(' ');
    for (const key of ['j', 'k', 'f', '1', '2']) press(key);
    expect(api.submitAction).not.toHaveBeenCalled();
  });

  it('answer like the arrows, in either case, once chosen', async () => {
    const { api, saves } = await open('/review', { cards: [card(1), card(2), card(3)], settings: { answerKeys: 'jk' } });
    await screen.findByTestId('flashcard');
    press(' ');
    press('K');
    expect(lastRequest(api)).toMatchObject({ pageId: card(1).id, action: 'remember' });
    await act(async () => saves[0]?.resolve(applied));

    press(' ');
    press('j');
    expect(lastRequest(api)).toMatchObject({ pageId: card(2).id, action: 'not_remember' });
    // The arrows still work as well.
    expect(screen.getByRole('note', { name: 'Keyboard shortcuts' })).toHaveTextContent('←');
  });

  it('are held to the same rule as every answer: the card must be showing its answer', async () => {
    const { api } = await open('/review', { cards: [card(1)], settings: { answerKeys: 'jk' } });
    await screen.findByTestId('flashcard');
    press('k');
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(screen.getByText('Flip the card before answering.')).toBeInTheDocument();
  });

  it('are counted once when the key is held down', async () => {
    const { api } = await open('/review', { cards: [card(1), card(2)], settings: { answerKeys: 'numbers' } });
    await screen.findByTestId('flashcard');
    press(' ');
    press('2');
    press('2', { repeat: true });
    press('2', { repeat: true });
    expect(api.submitAction).toHaveBeenCalledTimes(1);
  });
});

describe('rating confidence before the answer', () => {
  const prompt = () => screen.queryByRole('group', { name: 'How sure are you that you know it?' });
  const asking = { queue: RATED, settings: { askConfidence: true } };

  it('is not asked unless switched on', async () => {
    await open('/review', { cards: [card(1)], queue: RATED });
    await screen.findByTestId('flashcard');
    expect(prompt()).not.toBeInTheDocument();
  });

  it('is not asked where the rating would not be stored', async () => {
    await open('/review', { cards: [card(1)], settings: { askConfidence: true } });
    await screen.findByTestId('flashcard');
    expect(prompt()).not.toBeInTheDocument();
  });

  it('is not asked in a preview that saves nothing', async () => {
    await open('/review', { cards: [card(1)], queue: { ...RATED, writesEnabled: false }, settings: { askConfidence: true } });
    await screen.findByTestId('flashcard');
    expect(prompt()).not.toBeInTheDocument();
  });

  it('shows the answer when a level is chosen, and sends that level with the answer', async () => {
    const { api, user } = await open('/review', { cards: [card(1), card(2)], ...asking });
    await screen.findByTestId('flashcard');
    expect(isFlipped()).toBe(false);
    await user.click(within(prompt()!).getByRole('button', { name: /High confidence/ }));

    expect(isFlipped()).toBe(true);
    expect(prompt()).not.toBeInTheDocument();
    press('ArrowLeft');
    // Sure, and wrong: both facts are sent, and neither changes the other.
    expect(lastRequest(api)).toMatchObject({ pageId: card(1).id, action: 'not_remember', confidence: 3 });
  });

  it('takes the keys 1, 2 and 3', async () => {
    const { api } = await open('/review', { cards: [card(1), card(2)], ...asking });
    await screen.findByTestId('flashcard');
    press('2');
    expect(isFlipped()).toBe(true);
    press('ArrowRight');
    expect(lastRequest(api)).toMatchObject({ action: 'remember', confidence: 2 });
  });

  it('can be skipped by flipping the card, and then nothing is sent for it', async () => {
    const { api } = await open('/review', { cards: [card(1), card(2)], ...asking });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    expect(lastRequest(api)).not.toHaveProperty('confidence');
  });

  it('cannot be given once the answer has been seen', async () => {
    const { api } = await open('/review', { cards: [card(1), card(2)], ...asking });
    await screen.findByTestId('flashcard');
    press(' ');
    press(' ');
    // Back on the front, but the answer has been on screen: a rating now would be hindsight.
    expect(isFlipped()).toBe(false);
    expect(prompt()).not.toBeInTheDocument();
    press('3');
    expect(isFlipped()).toBe(false);
    press(' ');
    press('ArrowRight');
    expect(lastRequest(api)).not.toHaveProperty('confidence');
  });

  it('is asked afresh for the next card', async () => {
    const { api, saves } = await open('/review', { cards: [card(1), card(2)], ...asking });
    await screen.findByTestId('flashcard');
    press('3');
    press('ArrowRight');
    await act(async () => saves[0]?.resolve(applied));

    expect(prompt()).toBeInTheDocument();
    press(' ');
    press('ArrowRight');
    expect(lastRequest(api)).toMatchObject({ pageId: card(2).id });
    expect(lastRequest(api)).not.toHaveProperty('confidence');
  });

  it('repeats the same rating when a failed save is retried', async () => {
    const { api, saves, user } = await open('/review', { cards: [card(1), card(2)], ...asking });
    await screen.findByTestId('flashcard');
    press('1');
    press('ArrowRight');
    await act(async () => saves[0]?.reject(new ApiError('network', 'Could not reach the server.')));
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(api.submitAction).toHaveBeenCalledTimes(2);
    const [first, second] = api.submitAction.mock.calls.map(([request]) => request);
    expect(second).toEqual(first);
    expect(second).toMatchObject({ confidence: 1 });
  });

  it('is not asked again for a card brought back by Undo', async () => {
    const { saves } = await open('/review', { cards: [card(1), card(2)], ...asking });
    await screen.findByTestId('flashcard');
    press('3');
    press('ArrowRight');
    await act(async () => saves[0]?.resolve(applied));
    await act(async () => {
      press('u');
    });
    expect(await screen.findByText(/Card 1 of 2: word-1\./)).toBeInTheDocument();
    expect(prompt()).not.toBeInTheDocument();
  });

  it('gives the number keys to the rating first when they are also answer keys', async () => {
    const { api } = await open('/review', {
      cards: [card(1), card(2)],
      queue: RATED,
      settings: { askConfidence: true, answerKeys: 'numbers' },
    });
    await screen.findByTestId('flashcard');
    press('1');
    // That was the rating, which showed the answer; it was not "Not remember".
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(isFlipped()).toBe(true);
    press('2');
    expect(lastRequest(api)).toMatchObject({ action: 'remember', confidence: 1 });
  });
});

/** Everything a loaded queue says apart from its cards. */
function metaOf(queue: QueueResponse) {
  const { cards, ...meta } = queue;
  void cards;
  return meta;
}

describe('the session rules for confidence', () => {
  const ready = (overrides: Partial<SessionState> = {}): SessionState => ({
    ...initialSessionState,
    status: 'ready',
    cards: [card(1), card(2)],
    meta: metaOf(queueResponse([], RATED)),
    ...overrides,
  });

  it('accept a rating only on a card whose answer has not been shown', () => {
    const rated = transition(ready(), { type: 'RATE_CONFIDENCE', level: 2 });
    expect(rated).toMatchObject({ status: 'flipped', confidence: 2, revealed: true });

    const seen = ready({ revealed: true });
    expect(transition(seen, { type: 'RATE_CONFIDENCE', level: 2 })).toBe(seen);
    const flipped = ready({ status: 'flipped', revealed: true });
    expect(transition(flipped, { type: 'RATE_CONFIDENCE', level: 3 })).toBe(flipped);
  });

  it('never let a rating stand in for an answer', () => {
    const rated = transition(ready(), { type: 'RATE_CONFIDENCE', level: 3 });
    expect(rated.saving).toBeNull();
    expect(rated.tally).toEqual({ remember: 0, notRemember: 0, skipped: 0 });
  });

  it('clear the rating when the card changes', () => {
    let state = transition(ready(), { type: 'RATE_CONFIDENCE', level: 3 });
    state = transition(state, { type: 'GRADE', action: 'remember', requestId: 'r1', durationMs: 100 });
    // The rating travels with the answer; it is no longer the card's own.
    expect(state.saving).toMatchObject({ confidence: 3 });
    expect(state.confidence).toBeNull();
    state = transition(state, { type: 'SAVE_SETTLED', requestId: 'r1', undoable: true });
    expect(state).toMatchObject({ index: 1, confidence: null, revealed: false });
  });

  it('refuse a rating the store would not keep', async () => {
    const api = {
      fetchQueue: async () => queueResponse([card(1)]),
      submitAction: async () => applied,
      undoAction: async () => ({ outcome: 'undone' as const, pageId: card(1).id, state: { mastery: 3, nextReview: null } }),
    };
    const session = createSessionController(api);
    await session.load();
    expect(session.rateConfidence(3)).toBe(false);
    expect(session.getState()).toMatchObject({ status: 'ready', confidence: null, revealed: false });
  });
});

describe('the daily goal in Settings', () => {
  const section = async () => (await screen.findByRole('heading', { name: 'Daily goal' })).closest('section')!;

  it('starts from what is stored', async () => {
    await open('/settings', { plan: { goal: { reviews: 20, minutes: null } } });
    const form = within(await section());
    expect(await form.findByLabelText('Reviews per day')).toHaveValue('20');
    expect(form.getByLabelText('Minutes per day')).toHaveValue('');
  });

  it('saves both parts as numbers and confirms', async () => {
    const { api, user } = await open('/settings');
    const form = within(await section());
    await user.type(await form.findByLabelText('Reviews per day'), '25');
    await user.click(form.getByRole('button', { name: '20 min' }));
    expect(form.getByRole('button', { name: '20 min' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(form.getByRole('button', { name: 'Save goal' }));

    await waitFor(() => expect(api.saveGoal).toHaveBeenCalledWith({ reviews: 25, minutes: 20 }));
    expect(await screen.findByText('Daily goal saved.')).toBeInTheDocument();
  });

  it('treats an empty box as no goal of that kind', async () => {
    const { api, user } = await open('/settings', { plan: { goal: { reviews: 20, minutes: 10 } } });
    const form = within(await section());
    await user.clear(await form.findByLabelText('Reviews per day'));
    await user.click(form.getByRole('button', { name: 'Save goal' }));
    await waitFor(() => expect(api.saveGoal).toHaveBeenCalledWith({ reviews: null, minutes: 10 }));
  });

  it.each([
    ['text', 'many'],
    ['a fraction', '2.5'],
    ['zero', '0'],
    ['more than the limit', '5000'],
    ['a negative number', '-3'],
  ])('refuses %s and sends nothing', async (_name, value) => {
    const { api, user } = await open('/settings');
    const form = within(await section());
    await user.type(await form.findByLabelText('Reviews per day'), value);
    await user.click(form.getByRole('button', { name: 'Save goal' }));
    expect(await form.findByRole('alert')).toBeInTheDocument();
    expect(api.saveGoal).not.toHaveBeenCalled();
  });

  it('can be cleared in one step', async () => {
    const { api, user } = await open('/settings', { plan: { goal: { reviews: 20, minutes: 10 } } });
    const form = within(await section());
    await user.click(await form.findByRole('button', { name: 'Clear goal' }));
    await waitFor(() => expect(api.saveGoal).toHaveBeenCalledWith({ reviews: null, minutes: null }));
    expect(await screen.findByText('Daily goal cleared.')).toBeInTheDocument();
    expect(form.getByLabelText('Reviews per day')).toHaveValue('');
    expect(form.queryByRole('button', { name: 'Clear goal' })).not.toBeInTheDocument();
  });

  it('reports a failed save and keeps what was typed', async () => {
    const { api, user } = await open('/settings');
    api.saveGoal.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    const form = within(await section());
    await user.type(await form.findByLabelText('Reviews per day'), '30');
    await user.click(form.getByRole('button', { name: 'Save goal' }));
    expect(await form.findByRole('alert')).toHaveTextContent('Could not reach the server.');
    expect(form.getByLabelText('Reviews per day')).toHaveValue('30');
  });

  it('says so where the database cannot keep one yet', async () => {
    await open('/settings', { plan: { available: false } });
    const form = within(await section());
    expect(await form.findByText(/once the database has its latest update/)).toBeInTheDocument();
    expect(form.queryByLabelText('Reviews per day')).not.toBeInTheDocument();
  });

  it('states that a goal never hides or postpones a word', async () => {
    await open('/settings');
    expect(await section()).toHaveTextContent('It never hides or postpones a word');
  });
});

describe('review preferences in Settings', () => {
  it('are kept in the browser, and switch the review behaviour on', async () => {
    const { store, user } = await open('/settings');
    await user.click(await screen.findByLabelText(/Ask how sure I am before showing the answer/));
    await user.selectOptions(screen.getByLabelText('Extra answer keys'), 'fj');
    expect(store.getState()).toMatchObject({ askConfidence: true, answerKeys: 'fj' });
  });

  it('start switched off', async () => {
    const { store } = await open('/settings');
    expect(await screen.findByLabelText(/Ask how sure I am/)).not.toBeChecked();
    expect(screen.getByLabelText('Extra answer keys')).toHaveValue('none');
    expect(store.getState()).toMatchObject({ askConfidence: false, answerKeys: 'none' });
  });
});

describe('the daily goal on the Dashboard', () => {
  const goalRegion = () => screen.findByRole('region', { name: 'Daily goal' });

  it('shows progress on each part and what is left', async () => {
    await open('/', {
      plan: {
        goal: { reviews: 20, minutes: 10 },
        done: { reviews: 5, durationMs: 4 * 60_000 },
        due: { total: 30, overdue: 3 },
        averageMs: 30_000,
      },
    });
    const region = await goalRegion();
    const reviews = within(region).getByRole('progressbar', { name: 'Reviews towards today’s goal' });
    expect(reviews).toHaveAttribute('aria-valuenow', '5');
    expect(reviews).toHaveAttribute('aria-valuemax', '20');
    expect(reviews).toHaveAttribute('aria-valuetext', '5 of 20 reviews');
    expect(within(region).getByRole('progressbar', { name: 'Time towards today’s goal' })).toHaveAttribute(
      'aria-valuetext',
      '4 min 00 s of 10 min',
    );
    // 15 reviews to go, 12 cards for the time: the further one. 30 are due, so 15 lie beyond the goal.
    expect(region).toHaveTextContent(
      'About 15 more answers to reach it. 30 words are due, about 15 min 00 s: more than the goal asks for. The rest stay due.',
    );
  });

  it('says a reached goal is reached, and that what is left stays in the queue', async () => {
    await open('/', {
      plan: { goal: { reviews: 5, minutes: null }, done: { reviews: 6, durationMs: 0 }, due: { total: 4, overdue: 0 } },
    });
    const region = await goalRegion();
    expect(region).toHaveTextContent('Reached');
    expect(region).toHaveTextContent('Reached today. 4 words are still due; they stay in the queue.');
    expect(within(region).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '5');
  });

  it('points to Settings when no goal is set', async () => {
    await open('/');
    const region = await goalRegion();
    expect(region).toHaveTextContent('No daily goal is set.');
    expect(within(region).getByRole('link', { name: 'Set one in Settings' })).toHaveAttribute('href', '/settings');
  });

  it('is left out where a goal cannot be kept', async () => {
    await open('/', { plan: { available: false } });
    await screen.findByText('Ready to review');
    expect(screen.queryByRole('region', { name: 'Daily goal' })).not.toBeInTheDocument();
  });

  it('leaves the count of words ready to review exactly as it was', async () => {
    await open('/', {
      plan: { goal: { reviews: 1, minutes: null }, done: { reviews: 9, durationMs: 0 }, due: { total: 2, overdue: 0 } },
    });
    await goalRegion();
    const ready = screen.getByText('Ready to review').closest('section')!;
    expect(within(ready).getByText('2')).toBeInTheDocument();
    expect(within(ready).getByRole('link', { name: /Start review/ })).toHaveAttribute('href', '/review');
  });
});

describe('what the goal message says', () => {
  const message = (figures: Parameters<typeof dayPlan>[0]) => goalMessage(dayPlan(figures));

  it('gives an exact count for a goal in reviews', () => {
    expect(message({ goal: { reviews: 20, minutes: null }, done: { reviews: 5, durationMs: 0 }, due: { total: 8, overdue: 0 } })).toBe(
      '15 more answers to reach it. 8 words are due.',
    );
  });

  it('gives time, not a made-up count, when the pace is unknown', () => {
    expect(
      message({ goal: { reviews: null, minutes: 10 }, done: { reviews: 1, durationMs: 60_000 }, due: { total: 3, overdue: 0 } }),
    ).toBe('9 min 00 s of review time to go. 3 words are due.');
  });

  it('handles one word, and nothing due', () => {
    expect(message({ goal: { reviews: 2, minutes: null }, done: { reviews: 1, durationMs: 0 }, due: { total: 1, overdue: 0 } })).toBe(
      '1 more answer to reach it. 1 word is due.',
    );
    expect(message({ goal: { reviews: 2, minutes: null }, done: { reviews: 1, durationMs: 0 } })).toBe(
      '1 more answer to reach it. Nothing is due right now.',
    );
    expect(message({ goal: { reviews: 2, minutes: null }, done: { reviews: 2, durationMs: 0 } })).toBe(
      'Reached today. Nothing else is due.',
    );
    expect(message({ goal: { reviews: 1, minutes: null }, done: { reviews: 1, durationMs: 0 }, due: { total: 1, overdue: 0 } })).toBe(
      'Reached today. 1 word is still due; it stays in the queue.',
    );
  });
});

describe('the goal at the end of a session', () => {
  it('is shown from the saved figures', async () => {
    const { saves } = await open('/review', {
      cards: [card(1)],
      queue: RATED,
      plan: { goal: { reviews: 3, minutes: null }, done: { reviews: 3, durationMs: 0 } },
    });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await act(async () => saves[0]?.resolve(applied));
    const goal = await screen.findByRole('group', { name: 'Daily goal' });
    expect(goal).toHaveTextContent('3 of 3 reviews');
    expect(goal).toHaveTextContent('Reached today.');
  });

  it('is left out where no goal is set, and where goals cannot be kept', async () => {
    const { api, saves } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await act(async () => saves[0]?.resolve(applied));
    expect(screen.getByRole('heading', { name: 'Review complete' })).toBeInTheDocument();
    expect(api.fetchPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Daily goal' })).not.toBeInTheDocument();
  });
});

describe('calibration in Insights', () => {
  const reviewed = {
    firstReviewOn: '2026-10-01',
    periods: { today: periodStats({ reviews: 1 }), week: periodStats({ reviews: 1 }), month: periodStats({ reviews: 1 }) },
  };

  it('tabulates how answers went at each level, with the two mismatches counted', async () => {
    await open('/insights', {
      analytics: {
        ...reviewed,
        calibration: {
          available: true,
          levels: [
            { confidence: 1, reviews: 4, remembered: 3, accuracy: null },
            { confidence: 2, reviews: 0, remembered: 0, accuracy: null },
            { confidence: 3, reviews: 10, remembered: 7, accuracy: 0.7 },
          ],
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'How sure you were, last 30 days' });
    const cells = (name: RegExp) =>
      within(within(table).getByRole('row', { name })).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells(/^Low/)).toEqual(['4', '3', 'Not enough data']);
    expect(cells(/^Medium/)).toEqual(['0', '0', '—']);
    expect(cells(/^High/)).toEqual(['10', '7', '70%']);
    const region = screen.getByRole('region', { name: 'Review activity' });
    expect(region).toHaveTextContent('Sure but not remembered: 3 of 10 high-confidence answers.');
    expect(region).toHaveTextContent('Unsure but remembered: 3 of 4 low-confidence answers.');
  });

  it('says how to start collecting ratings when there are none', async () => {
    await open('/insights', {
      analytics: { ...reviewed, calibration: analyticsResponse({ calibration: { available: true, levels: [] } }).calibration },
    });
    expect(await screen.findByText(/No confidence ratings in the last 30 days/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'How sure you were, last 30 days' })).not.toBeInTheDocument();
  });

  it('is left out where ratings are not kept', async () => {
    await open('/insights', { analytics: reviewed });
    await screen.findByText('Reviews per day, last 30 days');
    expect(screen.queryByText(/confidence ratings/)).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'How sure you were, last 30 days' })).not.toBeInTheDocument();
  });
});
