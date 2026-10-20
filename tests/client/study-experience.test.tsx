// @vitest-environment jsdom
/**
 * Phase 4 in the browser: narrowing a review, the daily goal, answer keys
 * and keyboard shortcuts. None of them may change what is due or what
 * an answer does, so several tests here are about what does NOT happen.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES, type QueueResponse, type ReviewActionResponse } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { goalMessage } from '../../src/components/GoalStatus.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createMemoryStore } from '../../src/lib/offline/storage.js';
import { createSyncEngine } from '../../src/lib/offline/sync-engine.js';
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

type Saves = ReturnType<typeof createFakeApi>['saves'];

/** Waits for the outbox to send the answer at `at`, then settles it as saved. */
async function save(saves: Saves, at = 0, result = applied) {
  await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(at + 1));
  await act(async () => saves[at]?.resolve(result));
}

describe('choosing what to review', () => {
  const chooser = () => screen.getByLabelText('Cards to review') as HTMLSelectElement;

  it('offers exactly three choices, starting on everything due', async () => {
    await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    expect(chooser().value).toBe('');
    expect(within(chooser()).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Everything due',
      'Weakest words',
      'Select words',
    ]);
  });

  it('loads the weakest words as a new session and says what is shown', async () => {
    const { api, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    await user.selectOptions(chooser(), 'weak');

    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'weak' } }));
    expect(window.location.pathname + window.location.search).toBe('/review?focus=weak');
    expect(await screen.findByText(/Weakest words only, whether or not they are due\./)).toBeInTheDocument();
    expect(chooser().value).toBe('weak');
  });

  it('opens the picker for "Select words" instead of loading a queue', async () => {
    const { api, user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    await user.selectOptions(chooser(), 'select');

    expect(await screen.findByRole('heading', { name: 'Select words' })).toBeInTheDocument();
    expect(window.location.search).toBe('?focus=select');
    // Nothing is loaded until the words have been ticked.
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);
  });

  it('hands the keyboard back to the card after a choice, so an arrow key answers instead of changing it', async () => {
    const { api, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    await user.selectOptions(chooser(), 'weak');
    await screen.findByText(/Weakest words only/);
    expect(document.activeElement).not.toBe(chooser());

    press(' ');
    press('ArrowRight');
    await waitFor(() => expect(api.submitAction).toHaveBeenCalledTimes(1));
    expect(chooser().value).toBe('weak');
  });

  it('goes back to everything due', async () => {
    const { api, user } = await open('/review?focus=weak', { cards: [card(1)] });
    await screen.findByText(/Weakest words only/);
    await user.selectOptions(chooser(), '');
    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'all' } }));
    expect(window.location.search).toBe('');
    await waitFor(() => expect(screen.queryByText(/Weakest words only/)).not.toBeInTheDocument());
  });

  it('says what an empty weakest-words review means, without claiming nothing at all is due', async () => {
    await open('/review?focus=weak', { cards: [] });
    expect(await screen.findByRole('heading', { name: 'No weak words' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Nothing is due right now' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review everything due' })).toHaveAttribute('href', '/review');
  });

  it('treats an address it does not know as everything due', async () => {
    const { api } = await open('/review?focus=everything-and-more', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'all' } });
    expect(chooser().value).toBe('');
  });

  it('stays usable while an answer is still on its way, and the answer is not lost', async () => {
    const { api, saves, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await waitFor(() => expect(api.submitAction).toHaveBeenCalledTimes(1));

    // The answer waits in the outbox; the choice is never held hostage by it.
    expect(chooser()).not.toBeDisabled();
    await user.selectOptions(chooser(), 'weak');
    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'weak' } }));
    expect(saves).toHaveLength(1);
  });
});

describe('counting towards mastery', () => {
  const headerSwitch = () => screen.getByLabelText('Count toward mastery') as HTMLInputElement;
  const note = () => screen.queryByText(/Not counting toward mastery/);
  const settingsSwitch = () => screen.getByLabelText(/Count reviews toward mastery/) as HTMLInputElement;
  /** The sidebar item, wherever else a link of the same name may be drawn. */
  const navLink = (name: string) => screen.getAllByRole('link', { name })[0]!;

  /** Flips the card and answers Remember, waiting for the answer to leave. */
  const answerOne = async (api: ReturnType<typeof createFakeApi>['api'], times: number) => {
    press(' ');
    await waitFor(() => expect(isFlipped()).toBe(true));
    press('ArrowRight');
    await waitFor(() => expect(api.submitAction).toHaveBeenCalledTimes(times));
  };

  it('counts by default, and says nothing about mastery', async () => {
    const { api } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    expect(headerSwitch()).toBeChecked();
    expect(note()).not.toBeInTheDocument();

    await answerOne(api, 1);
    expect(lastRequest(api)).toMatchObject({ countsTowardMastery: true });
  });

  it('turns counting off for the answers that follow, and says so', async () => {
    const { api, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    await user.click(headerSwitch());
    expect(note()).toBeInTheDocument();

    await answerOne(api, 1);
    expect(lastRequest(api)).toMatchObject({ countsTowardMastery: false });
  });

  it('applies a change from the next card, never to an answer already given', async () => {
    const { api, saves, user } = await open('/review', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    await answerOne(api, 1);
    expect(lastRequest(api)).toMatchObject({ countsTowardMastery: true });

    // The first answer settles, so the outbox is free to send the next one.
    await save(saves, 0);
    await user.click(headerSwitch());
    await answerOne(api, 2);
    expect(lastRequest(api)).toMatchObject({ countsTowardMastery: false });
    // The answer already given keeps the choice it was given under.
    expect(api.submitAction.mock.calls[0]?.[0]).toMatchObject({ countsTowardMastery: true });
  });

  it('arrives switched off for the weakest words, and the reviewer can switch it back on', async () => {
    const { api, saves, user } = await open('/review?focus=weak', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    expect(headerSwitch()).not.toBeChecked();
    expect(note()).toBeInTheDocument();

    await answerOne(api, 1);
    expect(lastRequest(api)).toMatchObject({ countsTowardMastery: false });

    await save(saves, 0);
    await user.click(headerSwitch());
    await answerOne(api, 2);
    expect(lastRequest(api)).toMatchObject({ countsTowardMastery: true });
  });

  it('starts from the choice the account already holds', async () => {
    await open('/review', { cards: [card(1)], account: { countReviewsTowardMastery: false } });
    await screen.findByTestId('flashcard');
    await waitFor(() => expect(headerSwitch()).not.toBeChecked());
    expect(note()).toBeInTheDocument();
  });

  it('is one switch wherever it is flipped, Settings included', async () => {
    const { user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    await user.click(headerSwitch());

    await user.click(navLink('Settings'));
    expect(await screen.findByLabelText(/Count reviews toward mastery/)).not.toBeChecked();

    // And back the other way: the Review tab reads the same choice.
    await user.click(settingsSwitch());
    await user.click(navLink('Review'));
    await screen.findByTestId('flashcard');
    expect(headerSwitch()).toBeChecked();
  });

  it('says a chosen review counts again once the switch is back on', async () => {
    const { api, user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    await user.click(headerSwitch());
    expect(note()).toBeInTheDocument();
    await user.click(headerSwitch());
    expect(note()).not.toBeInTheDocument();
    await answerOne(api, 1);
    expect(lastRequest(api)).toMatchObject({ countsTowardMastery: true });
  });

  it('says at the end that the answers left their words as they were', async () => {
    const { api, user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    await user.click(headerSwitch());
    await answerOne(api, 1);

    expect(await screen.findByRole('heading', { name: /words?, done\./ })).toBeInTheDocument();
    expect(screen.getByText(/Counting towards mastery was off/)).toBeInTheDocument();
  });

  it('says nothing of the kind when every answer counted', async () => {
    const { api } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    await answerOne(api, 1);

    expect(await screen.findByRole('heading', { name: /words?, done\./ })).toBeInTheDocument();
    expect(screen.queryByText(/Counting towards mastery was off/)).not.toBeInTheDocument();
  });
});

describe('picking the words yourself', () => {
  const picker = () => screen.findByRole('heading', { name: 'Select words' });
  const row = (word: string) => screen.getByRole('checkbox', { name: new RegExp(`^${word}`) });
  /** The ticked list, in the order the words will be reviewed in. */
  const ticked = () =>
    Array.from(
      screen
        .getByText('Reviewing in this order. Ticking a word again moves it to the end.')
        .parentElement!.querySelectorAll('ol li'),
    ).map((item) => item.textContent ?? '');

  it('is the order the words were ticked in, and taking one out and back puts it last', async () => {
    const { user } = await open('/review?focus=select', {
      cards: [card(1)],
      entries: [entry(1), entry(2), entry(3)],
    });
    await picker();

    await user.click(row('word-1'));
    await user.click(row('word-2'));
    expect(ticked()).toHaveLength(2);
    expect(ticked()[0]).toContain('word-1');

    // Out of the selection, then back: the reviewer's newest tick is last.
    await user.click(row('word-1'));
    await user.click(row('word-1'));
    expect(ticked()[0]).toContain('word-2');
    expect(ticked()[1]).toContain('word-1');
    expect(screen.getByRole('button', { name: 'Review 2 words' })).toBeEnabled();
  });

  it('narrows the list with the same search as the bank, and can take a word out again', async () => {
    const { user } = await open('/review?focus=select', { entries: [entry(1), entry(2)] });
    await picker();
    await user.click(row('word-1'));
    // The ticked row itself takes the word back out.
    await user.click(screen.getByTitle('Take this word out of the selection'));
    expect(screen.getByRole('button', { name: 'Pick at least one word' })).toBeDisabled();

    await user.type(screen.getByLabelText('Search your vocabulary'), 'word-2');
    expect(screen.queryByRole('checkbox', { name: /^word-1/ })).not.toBeInTheDocument();
    expect(row('word-2')).toBeInTheDocument();
  });

  it('leaves mastered words out, and says how many', async () => {
    await open('/review?focus=select', {
      entries: [entry(1), entry(2, { mastery: 10, reviewStatus: 'mastered' })],
    });
    await picker();
    expect(screen.queryByRole('checkbox', { name: /^word-2/ })).not.toBeInTheDocument();
    expect(screen.getByText(/1 mastered word is not listed/)).toBeInTheDocument();
  });

  it('brings the running sitting’s own words back when the reviewer changes them', async () => {
    const { user } = await open('/review?focus=select', { cards: [card(1)], entries: [entry(1)] });
    await picker();
    await user.click(row('word-1'));
    await user.click(screen.getByRole('button', { name: 'Review 1 word' }));
    await screen.findByTestId('flashcard');

    await user.click(screen.getByRole('button', { name: 'Change words' }));
    await picker();
    expect(ticked()[0]).toContain('word-1');
  });

  it('leaves the picking for everything due when it is cancelled', async () => {
    const { api, user } = await open('/review?focus=select', { cards: [card(1)] });
    await picker();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ scope: { kind: 'all' } }));
    expect(window.location.search).toBe('');
    expect(await screen.findByTestId('flashcard')).toBeInTheDocument();
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

  it('shows the extra answer keys when they are in use', async () => {
    await open('/review', { cards: [card(1)], queue: RATED, settings: { answerKeys: 'fj' } });
    await screen.findByTestId('flashcard');
    press('?', { shiftKey: true });
    const list = within(dialog()!);
    expect(list.getByRole('row', { name: /→/ })).toHaveTextContent('→J');
    expect(list.getByRole('row', { name: /←/ })).toHaveTextContent('←F');
    expect(list.queryByText(/how sure you are/)).not.toBeInTheDocument();
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
    await waitFor(() => expect(api.submitAction).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(lastRequest(api)).toMatchObject({ pageId: card(1).id, action: 'remember' }));
    await save(saves, 0);

    press(' ');
    press('j');
    await waitFor(() => expect(lastRequest(api)).toMatchObject({ pageId: card(2).id, action: 'not_remember' }));
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
    await waitFor(() => expect(api.submitAction).toHaveBeenCalledTimes(1));
    expect(api.submitAction).toHaveBeenCalledTimes(1);
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
    expect(rated.pending).toEqual([]);
    expect(rated.tally).toEqual({ remember: 0, notRemember: 0, skipped: 0 });
  });

  it('clear the rating when the card changes', () => {
    let state = transition(ready(), { type: 'RATE_CONFIDENCE', level: 3 });
    state = transition(state, { type: 'GRADE', action: 'remember', requestId: 'r1', durationMs: 100 });
    // The rating travels with the answer; it is no longer the card's own.
    expect(state.pending[0]).toMatchObject({ confidence: 3 });
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
    const store = createMemoryStore();
    const engine = createSyncEngine({
      accountId: 'test',
      store,
      sender: async () => applied,
      backoffMs: { base: 10, max: 20 },
    });
    const session = createSessionController({
      api,
      engine,
      store,
      accountId: 'test',
      countsTowardMastery: () => true,
    });
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
    await user.selectOptions(screen.getByLabelText('Extra answer keys'), 'fj');
    expect(store.getState()).toMatchObject({ answerKeys: 'fj' });
  });

  it('start switched off', async () => {
    const { store } = await open('/settings');
    expect(screen.getByLabelText('Extra answer keys')).toHaveValue('none');
    expect(store.getState()).toMatchObject({ answerKeys: 'none' });
  });

  it('count reviews towards mastery until told otherwise', async () => {
    const { user } = await open('/settings');
    const counting = await screen.findByLabelText(/Count reviews toward mastery/);
    expect(counting).toBeChecked();
    await user.click(counting);
    expect(counting).not.toBeChecked();
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
    await screen.findByRole('region', { name: 'Ready to review' });
    expect(screen.queryByRole('region', { name: 'Daily goal' })).not.toBeInTheDocument();
  });

  it('leaves the count of words ready to review exactly as it was', async () => {
    await open('/', {
      plan: { goal: { reviews: 1, minutes: null }, done: { reviews: 9, durationMs: 0 }, due: { total: 2, overdue: 0 } },
    });
    await goalRegion();
    const ready = screen.getByRole('region', { name: 'Ready to review' });
    expect(within(ready).getByRole('heading', { name: '2 words ready to review.' })).toBeInTheDocument();
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
    await save(saves, 0);
    const goal = await screen.findByRole('group', { name: 'Daily goal' });
    expect(goal).toHaveTextContent('3 of 3 reviews');
    expect(goal).toHaveTextContent('Reached today.');
  });

  it('is left out where no goal is set, and where goals cannot be kept', async () => {
    const { api, saves } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await save(saves, 0);
    expect(screen.getByRole('heading', { name: /words?, done\./ })).toBeInTheDocument();
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
