// @vitest-environment jsdom
/**
 * The screens built on saved review history: the dashboard's activity card,
 * the Insights section, the Weak words page and the review narrowed to them.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AnalyticsResponse, ReviewCard, WeakWordView, WeakWordsResponse } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, periodStats, weakWord, type FakeApiOptions } from '../helpers/fake-api.js';
import { TODAY, card } from '../helpers/fixtures.js';

interface Options {
  cards?: ReviewCard[];
  analytics?: Partial<AnalyticsResponse>;
  weakWords?: Partial<WeakWordsResponse>;
}

const ENTRIES = [entry(1), entry(2)];

function start(path: string, options: FakeApiOptions) {
  window.history.replaceState(null, '', path);
  return createFakeApi({ entries: ENTRIES, ...options });
}

async function open(path: string, options: Options = {}) {
  const fake = start(path, options);
  const view = render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup(), ...view };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const nav = () => within(screen.getAllByRole('navigation', { name: 'Main' })[0]!);
const activity = () => screen.findByRole('region', { name: 'Review activity' });
const unreachable = () => new ApiError('network', 'Could not reach the server.');

// TODAY is Friday 9 October 2026.
const ACTIVE: Partial<AnalyticsResponse> = {
  firstReviewOn: '2026-10-01',
  streak: { current: 3, longest: 6 },
  periods: {
    today: periodStats({
      reviews: 4,
      remembered: 3,
      notRemembered: 1,
      durationMs: 65_000,
      timedReviews: 4,
      averageMs: 16_250,
      activeDays: 1,
    }),
    week: periodStats({
      from: '2026-10-03',
      reviews: 20,
      remembered: 15,
      notRemembered: 5,
      accuracy: 0.75,
      repeatReviews: 12,
      retention: 0.5,
      durationMs: 300_000,
      timedReviews: 20,
      averageMs: 15_000,
      activeDays: 3,
    }),
    month: periodStats({
      from: '2026-09-10',
      reviews: 40,
      remembered: 30,
      notRemembered: 10,
      accuracy: 0.75,
      repeatReviews: 3,
      retention: null,
      durationMs: 600_000,
      timedReviews: 40,
      averageMs: 15_000,
      activeDays: 6,
    }),
  },
  days: [
    { date: '2026-10-08', reviews: 16, remembered: 12, notRemembered: 4, durationMs: 235_000 },
    { date: TODAY, reviews: 4, remembered: 3, notRemembered: 1, durationMs: 65_000 },
  ],
  byMode: [{ mode: 'flashcard', reviews: 40, remembered: 30, accuracy: 0.75 }],
};

describe('review activity on the dashboard', () => {
  it('shows today’s reviews, accuracy, streak and time from saved answers', async () => {
    await open('/', { analytics: ACTIVE });
    const section = await activity();
    await within(section).findByText('Reviews today');
    const tile = (label: string) => within(section).getByText(label).closest('div.block') as HTMLElement;

    expect(tile('Reviews today')).toHaveTextContent('4');
    expect(tile('Reviews today')).toHaveTextContent('3 remembered');
    expect(tile('Accuracy, last 7 days')).toHaveTextContent('75%');
    expect(tile('Accuracy, last 7 days')).toHaveTextContent('15 of 20 answers remembered');
    expect(tile('Streak')).toHaveTextContent('3 days');
    expect(tile('Streak')).toHaveTextContent('Longest in 90 days: 6 days');
    expect(tile('Time on cards today')).toHaveTextContent('1 min 05 s');
    expect(tile('Time on cards today')).toHaveTextContent('16 s per card');
  });

  it('gives no percentage on too few answers, and says how many are needed', async () => {
    await open('/', {
      analytics: {
        ...ACTIVE,
        periods: { ...ACTIVE.periods!, week: periodStats({ reviews: 3, remembered: 3, accuracy: null }) },
      },
    });
    const section = await activity();
    const tile = (await within(section).findByText('Accuracy, last 7 days')).closest('div.block') as HTMLElement;
    expect(tile).toHaveTextContent('Not enough data: 3 of 5 answers needed');
    expect(tile).not.toHaveTextContent('%');
  });

  it('reminds that a streak needs a review today, without calling it broken', async () => {
    await open('/', {
      analytics: { ...ACTIVE, periods: { ...ACTIVE.periods!, today: periodStats() }, streak: { current: 2, longest: 6 } },
    });
    const section = await activity();
    const streak = (await within(section).findByText('Streak')).closest('div.block') as HTMLElement;
    expect(streak).toHaveTextContent('2 days');
    expect(streak).toHaveTextContent('Review today to keep it going');
    const time = within(section).getByText('Time on cards today').closest('div.block') as HTMLElement;
    expect(time).toHaveTextContent('No timed answers today');
  });

  it('says there is nothing yet instead of a row of zeros', async () => {
    await open('/');
    const section = await activity();
    expect(await within(section).findByText(/No saved reviews in the last 90 days/)).toBeInTheDocument();
    expect(within(section).queryByText('Reviews today')).not.toBeInTheDocument();
  });

  it('says when the database cannot report activity yet, and estimates nothing', async () => {
    await open('/', { analytics: { available: false } });
    const section = await activity();
    expect(await within(section).findByText(/once the database has its latest update/)).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'See Settings' })).toHaveAttribute('href', '/settings');
    expect(within(section).queryByText('Reviews today')).not.toBeInTheDocument();
  });

  it('reports a failure in place and loads on Try again, leaving the rest of the dashboard usable', async () => {
    const { api } = start('/', { analytics: ACTIVE });
    api.fetchAnalytics.mockRejectedValueOnce(unreachable());
    render(<App api={api} settings={createSettingsStore(null)} />);
    const section = await activity();
    expect(await within(section).findByRole('alert')).toHaveTextContent('Could not reach the server.');
    expect(screen.getByText('Ready to review')).toBeInTheDocument();

    await userEvent.setup().click(within(section).getByRole('button', { name: 'Try again' }));
    expect(await within(section).findByText('Reviews today')).toBeInTheDocument();
  });

  it('re-reads the activity when the dashboard is refreshed', async () => {
    const { api, user } = await open('/', { analytics: ACTIVE });
    await within(await activity()).findByText('Reviews today');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.fetchAnalytics).toHaveBeenCalledTimes(2));
  });

  it('links to the weak words and to the longer account', async () => {
    await open('/');
    const section = await activity();
    expect(within(section).getByRole('link', { name: 'Weak words' })).toHaveAttribute('href', '/weak');
    expect(within(section).getByRole('link', { name: 'More in Insights' })).toHaveAttribute('href', '/insights');
  });
});

describe('review activity in Insights', () => {
  it('charts reviews per day and gives each period its own figures', async () => {
    await open('/insights', { analytics: ACTIVE });
    const section = await activity();
    const chart = (await within(section).findByText('Reviews per day, last 30 days')).closest('figure')!;
    expect(within(chart).getByRole('button', { name: 'Oct 9, 2026: 4 reviews' })).toBeInTheDocument();
    expect(within(chart).getByRole('button', { name: 'Oct 8, 2026: 16 reviews' })).toBeInTheDocument();

    const table = within(section).getByRole('table', { name: 'Review figures by period' });
    const cells = (name: RegExp) =>
      within(within(table).getByRole('row', { name })).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells(/^Today/)).toEqual(['4', '3', 'Not enough data', 'Not enough data', '1 min 05 s', '1']);
    expect(cells(/^Last 7 days/)).toEqual(['20', '15', '75%', '50%', '5 min 00 s', '3']);
    // Too few repeat reviews in the month to give a retention figure, though accuracy has enough answers.
    expect(cells(/^Last 30 days/)).toEqual(['40', '30', '75%', 'Not enough data', '10 min 00 s', '6']);

    expect(section).toHaveTextContent('Streak: 3 days · longest in the last 90 days: 6 days');
    expect(section).toHaveTextContent('It is what happened, not a prediction.');
  });

  it('keeps study modes apart once there is more than one', async () => {
    await open('/insights', { analytics: ACTIVE });
    const single = await activity();
    await within(single).findByText('Reviews per day, last 30 days');
    expect(within(single).queryByRole('table', { name: 'By study mode, last 30 days' })).not.toBeInTheDocument();
  });

  it('shows each study mode with its own accuracy', async () => {
    await open('/insights', {
      analytics: {
        ...ACTIVE,
        byMode: [
          { mode: 'flashcard', reviews: 36, remembered: 28, accuracy: 0.7778 },
          { mode: 'typing', reviews: 4, remembered: 2, accuracy: null },
        ],
      },
    });
    const section = await activity();
    const table = await within(section).findByRole('table', { name: 'By study mode, last 30 days' });
    expect(within(table).getByRole('row', { name: /^Flashcards/ })).toHaveTextContent('3678%');
    expect(within(table).getByRole('row', { name: /^Typing/ })).toHaveTextContent('4Not enough data');
  });

  it('shows no chart of zeros when nothing was reviewed', async () => {
    await open('/insights');
    const section = await activity();
    expect(await within(section).findByText(/No saved reviews in the last 90 days/)).toBeInTheDocument();
    expect(within(section).queryByText('Reviews per day, last 30 days')).not.toBeInTheDocument();
    // The rest of the page does not depend on it.
    expect(screen.getByText('Words added per week, last 12 weeks')).toBeInTheDocument();
  });
});

const EPHEMERAL = weakWord(1, {
  word: 'ephemeral',
  mastery: 6,
  score: 13,
  severity: 'high',
  reasons: [
    { code: 'repeated_failures', points: 6, detail: 'Forgotten on 3 separate days.' },
    { code: 'recent_failures', points: 4, detail: 'Not remembered 2 times in the last 30 days.' },
    { code: 'slipped_after_progress', points: 3, detail: 'At mastery 6, but not remembered at the latest review.' },
  ],
  recent: { reviews: 5, remembered: 3 },
  action: 'Review it now, and add an example that makes it stick.',
});
const LUCID = weakWord(2, {
  word: 'lucid',
  score: 1,
  severity: 'low',
  reasons: [{ code: 'incomplete', points: 1, detail: 'Missing example.' }],
  recent: null,
  action: 'Fill in what is missing so the card can be reviewed properly.',
  reviewable: false,
});
const WEAK: WeakWordView[] = [EPHEMERAL, LUCID];
const item = (word: string) => screen.getByRole('button', { name: word }).closest('li') as HTMLElement;

describe('Weak words', () => {
  it('has its own page in the navigation', async () => {
    await open('/weak', { weakWords: { words: WEAK } });
    expect(nav().getByRole('link', { name: /^Weak words/ })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Weak words · Vocabulary');
  });

  it('lists each word with its priority, every reason, how it has gone and what to do', async () => {
    await open('/weak', { weakWords: { words: WEAK } });
    await screen.findByRole('button', { name: 'ephemeral' });

    const first = item('ephemeral');
    expect(first).toHaveTextContent('High priority');
    expect(first).toHaveTextContent('6 of 10 mastery');
    expect(first).toHaveTextContent('Due now');
    expect(first).toHaveTextContent('Forgotten on 3 separate days.');
    expect(first).toHaveTextContent(
      'Also: Not remembered 2 times in the last 30 days. At mastery 6, but not remembered at the latest review.',
    );
    expect(first).toHaveTextContent('Remembered 3 of 5 reviews in the last 30 days.');
    expect(first).toHaveTextContent('Suggested: Review it now, and add an example that makes it stick.');

    const second = item('lucid');
    expect(second).toHaveTextContent('Low priority');
    expect(second).toHaveTextContent('Missing example.');
    expect(second).toHaveTextContent('No saved reviews yet.');
    expect(second).not.toHaveTextContent('Due now');
    expect(second).not.toHaveTextContent('Also:');
  });

  it('keeps the order it was given: weakest first', async () => {
    await open('/weak', { weakWords: { words: WEAK } });
    await screen.findByRole('button', { name: 'ephemeral' });
    const list = item('ephemeral').parentElement!;
    expect(within(list).getAllByRole('button').map((button) => button.textContent)).toEqual(['ephemeral', 'lucid']);
  });

  it('narrows the list to one priority', async () => {
    const { user } = await open('/weak', { weakWords: { words: WEAK } });
    await screen.findByRole('button', { name: 'ephemeral' });
    const filter = within(screen.getByRole('group', { name: 'Show priority' }));
    expect(filter.getByRole('button', { name: 'All (2)' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(filter.getByRole('button', { name: 'Low (1)' }));
    expect(screen.queryByRole('button', { name: 'ephemeral' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'lucid' })).toBeInTheDocument();

    await user.click(filter.getByRole('button', { name: 'Medium (0)' }));
    expect(screen.getByText('No words at this priority.')).toBeInTheDocument();

    await user.click(filter.getByRole('button', { name: 'All (2)' }));
    expect(screen.getByRole('button', { name: 'ephemeral' })).toBeInTheDocument();
  });

  it('opens a word’s details from the list', async () => {
    const { api, user } = await open('/weak', { weakWords: { words: WEAK } });
    await user.click(await screen.findByRole('button', { name: 'ephemeral' }));
    expect(new URLSearchParams(window.location.search).get('word')).toBe(EPHEMERAL.id);
    await waitFor(() => expect(api.fetchEntry).toHaveBeenCalledWith(EPHEMERAL.id));
  });

  it('says how many are due, and that a focused review brings nothing forward', async () => {
    await open('/weak', { weakWords: { words: WEAK } });
    await screen.findByRole('button', { name: 'ephemeral' });
    expect(screen.getByText(/1 is due for review now\./)).toHaveTextContent('never brings a word forward');
    expect(screen.getByRole('link', { name: /Review my weakest words/ })).toHaveAttribute('href', '/review?focus=weak');
  });

  it('offers no focused review when none of the words is due', async () => {
    await open('/weak', { weakWords: { words: [LUCID] } });
    await screen.findByRole('button', { name: 'lucid' });
    expect(screen.getByText(/None of these is due for review right now\./)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Review my weakest words/ })).not.toBeInTheDocument();
  });

  it('says so when no word stands out', async () => {
    await open('/weak');
    expect(await screen.findByRole('heading', { name: 'Nothing stands out' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Show priority' })).not.toBeInTheDocument();
  });

  it('says what it cannot see where no review history is kept', async () => {
    await open('/weak', { weakWords: { historyAvailable: false, words: [LUCID] } });
    await screen.findByRole('button', { name: 'lucid' });
    expect(screen.getByText(/Review history is not available until the database has its latest update/)).toBeInTheDocument();
  });

  it('says when the list is cut short', async () => {
    await open('/weak', { weakWords: { words: WEAK, total: 250 } });
    await screen.findByRole('button', { name: 'ephemeral' });
    expect(screen.getByText(/Showing the 2 weakest of 250 words\./)).toBeInTheDocument();
  });

  it('reports a failure and loads on Try again', async () => {
    const { api } = start('/weak', { weakWords: { words: WEAK } });
    api.fetchWeakWords.mockRejectedValueOnce(unreachable());
    render(<App api={api} settings={createSettingsStore(null)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'ephemeral' })).toBeInTheDocument();
  });

  it('re-reads the list on Refresh', async () => {
    const { api, user } = await open('/weak', { weakWords: { words: WEAK } });
    await screen.findByRole('button', { name: 'ephemeral' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.fetchWeakWords).toHaveBeenCalledTimes(2));
  });
});

describe('reviewing only the weakest words', () => {
  const press = (key: string) => fireEvent.keyDown(document.body, { key, code: key === ' ' ? 'Space' : key });
  const banner = () => screen.queryByText(/Weakest words only, from those due now\./);

  it('starts from the Weak words page', async () => {
    const { api, user } = await open('/weak', { weakWords: { words: WEAK }, cards: [card(1)] });
    await user.click(await screen.findByRole('link', { name: /Review my weakest words/ }));
    expect(await screen.findByTestId('flashcard')).toBeInTheDocument();
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: 'weak' });
    expect(banner()).toBeInTheDocument();
  });

  it('opens directly from its address', async () => {
    const { api } = await open('/review?focus=weak', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: 'weak' });
    expect(banner()).toBeInTheDocument();
  });

  it('is not announced on an ordinary review', async () => {
    const { api } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null });
    expect(banner()).not.toBeInTheDocument();
  });

  it('saves answers exactly as an ordinary review does', async () => {
    const { api, saves } = await open('/review?focus=weak', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowLeft');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(api.submitAction.mock.calls[0]?.[0]).toMatchObject({ pageId: card(1).id, action: 'not_remember' });
    await act(async () => saves[0]?.resolve({ outcome: 'applied', state: null }));
    expect(screen.getByText(/Card 2 of 2: word-2\./)).toBeInTheDocument();
  });

  it('switches to everything due as a new session', async () => {
    const { api, user } = await open('/review?focus=weak', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    await user.click(screen.getByRole('link', { name: 'Review everything due' }));
    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null }));
    expect(api.fetchQueue).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(banner()).not.toBeInTheDocument());
    expect(window.location.search).toBe('');
  });

  it('keeps its place when left and reopened the same way', async () => {
    const { api, saves, user } = await open('/review?focus=weak', {
      weakWords: { words: WEAK },
      cards: [card(1), card(2)],
    });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await act(async () => saves[0]?.resolve({ outcome: 'applied', state: null }));

    await user.click(nav().getByRole('link', { name: /^Weak words/ }));
    await user.click(await screen.findByRole('link', { name: /Review my weakest words/ }));
    expect(await screen.findByText(/Card 2 of 2: word-2\./)).toBeInTheDocument();
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed answer waiting for its retry rather than dropping it for another selection', async () => {
    const { api, saves, user } = await open('/review?focus=weak', { cards: [card(1), card(2)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await act(async () => saves[0]?.reject(unreachable()));
    expect(screen.getByText(/was not saved/)).toBeInTheDocument();

    await user.click(nav().getByRole('link', { name: /^Review/ }));
    expect(screen.getByText(/was not saved/)).toBeInTheDocument();
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);
  });

  it('explains an empty selection without claiming that nothing at all is due', async () => {
    await open('/review?focus=weak', { cards: [] });
    expect(await screen.findByRole('heading', { name: 'No weak words are due' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Nothing is due right now' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review everything due' })).toHaveAttribute('href', '/review');
  });

  it('says what was reviewed when it finishes', async () => {
    const { saves } = await open('/review?focus=weak', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await act(async () => saves[0]?.resolve({ outcome: 'applied', state: null }));
    expect(screen.getByRole('heading', { name: 'Review complete' })).toBeInTheDocument();
    expect(screen.getByText(/They were your weakest words among those due\./)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Review everything due' })).toHaveLength(1);
  });
});
