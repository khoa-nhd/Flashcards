// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReviewActionResponse, ReviewCard, VocabularyEntry, VocabularyListResponse } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, weakWord, weakWordsResponse } from '../helpers/fake-api.js';
import { TODAY, card, type Deferred } from '../helpers/fixtures.js';

// TODAY is Friday 9 October 2026; its week runs Monday 5 to Sunday 11.
const WORDS: VocabularyEntry[] = [
  entry(1, { word: 'mastered-a', mastery: 10, reviewStatus: 'mastered', reviewable: false, dateAdded: '2026-08-01' }),
  entry(2, { word: 'mastered-b', mastery: 10, reviewStatus: 'mastered', reviewable: false, dateAdded: '2026-08-01' }),
  entry(3, { word: 'due-a', mastery: 1, reviewStatus: 'due_today', dateAdded: TODAY }),
  entry(4, { word: 'due-b', mastery: 2, reviewStatus: 'due_today', dateAdded: '2026-10-05' }),
  entry(5, { word: 'late-a', mastery: 3, reviewStatus: 'overdue', reviewDate: '2026-10-01', dateAdded: '2026-10-04' }),
  entry(6, { word: 'later-a', mastery: 4, reviewStatus: 'upcoming', reviewable: false, reviewDate: '2026-10-20', dateAdded: TODAY }),
  entry(7, { word: 'later-b', mastery: 5, reviewStatus: 'upcoming', reviewable: false, reviewDate: '2026-10-21', dateAdded: null }),
];

interface Options {
  entries?: VocabularyEntry[];
  list?: Partial<VocabularyListResponse>;
  cards?: ReviewCard[];
}

async function open(path: string, { entries = WORDS, list, cards = [] }: Options = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries, list, cards });
  const view = render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup(), ...view };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

/** The desktop navigation; the phone one mirrors it and is hidden by CSS. */
const nav = () => within(screen.getAllByRole('navigation', { name: 'Main' })[0]!);
const tile = (label: string) => {
  const element = screen.getByText(label, { selector: 'section[aria-label="Summary"] span' });
  return element.closest('a, div.block') as HTMLElement;
};
const tileValue = (label: string) => within(tile(label)).getByText(/^\d+$/).textContent;

describe('navigation', () => {
  it('offers every page and marks the current one', async () => {
    await open('/');
    for (const name of ['Dashboard', 'Review', 'Add vocabulary', 'Vocabulary bank', 'Calendar', 'Insights', 'Settings']) {
      expect(nav().getByRole('link', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(nav().getByRole('link', { name: /^Dashboard/ })).toHaveAttribute('aria-current', 'page');
    expect(nav().getByRole('link', { name: /^Calendar/ })).not.toHaveAttribute('aria-current');
  });

  it('opens a page directly from its address', async () => {
    await open('/calendar');
    expect(await within(screen.getByRole('main')).findByRole('heading', { name: 'Calendar', level: 1 })).toBeInTheDocument();
    expect(nav().getByRole('link', { name: /^Calendar/ })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Calendar · Vocabulary');
  });

  it('switches pages in place and supports back and forward', async () => {
    const { user } = await open('/');
    await user.click(nav().getByRole('link', { name: /^Vocabulary bank/ }));
    expect(window.location.pathname).toBe('/bank');
    expect(await screen.findByRole('table')).toBeInTheDocument();

    await user.click(nav().getByRole('link', { name: /^Insights/ }));
    expect(window.location.pathname).toBe('/insights');

    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe('/bank'));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe('/insights'));
    expect(await within(screen.getByRole('main')).findByRole('heading', { name: 'Insights', level: 1 })).toBeInTheDocument();
  });

  it('loads the vocabulary once, however many tabs are visited', async () => {
    const { api, user } = await open('/');
    await screen.findByRole('region', { name: 'Ready to review' });
    for (const name of ['Vocabulary bank', 'Calendar', 'Insights', 'Settings', 'Add vocabulary', 'Dashboard']) {
      await user.click(nav().getByRole('link', { name: new RegExp(`^${name}`) }));
    }
    await screen.findByRole('region', { name: 'Ready to review' });
    expect(api.fetchVocabulary).toHaveBeenCalledTimes(1);
  });

  it('shows how many words are ready to review beside the Review tab', async () => {
    await open('/');
    await screen.findByRole('region', { name: 'Ready to review' });
    expect(nav().getByRole('link', { name: /^Review/ })).toHaveTextContent('3 ready to review');
  });

  it('says so for an address that does not exist', async () => {
    await open('/nowhere');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toHaveAttribute('href', '/');
  });

  it('scrolls in the main area, which contains its positioned descendants', async () => {
    // The app shell keeps its own scroll container, not the document. `relative`
    // is what makes that container the containing block for absolutely positioned
    // children such as the `.sr-only` text; without it they resolve against the
    // viewport, escape the container's clipping, and add phantom document height
    // (a second scrollbar that drags the fixed shell with it).
    await open('/');
    const main = screen.getByRole('main');
    expect(main).toHaveClass('overflow-y-auto');
    expect(main).toHaveClass('relative');
  });

  it('reports a refused request as a failure; there is no shared password to ask for', async () => {
    window.history.replaceState(null, '', '/bank');
    const { api } = createFakeApi({ entries: WORDS });
    api.fetchVocabulary.mockRejectedValueOnce(new ApiError('unauthorized', 'Sign in to continue.', 401));
    render(<App api={api} settings={createSettingsStore(null)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in to continue.');
    expect(screen.queryByLabelText('Access password')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});

describe('review within the app', () => {
  const press = (key: string) => fireEvent.keyDown(document.body, { key, code: key === ' ' ? 'Space' : key });
  /** Answers are sent in the background; the outbox has to have made the request before it can be settled. */
  const settle = async (saves: Array<Deferred<ReviewActionResponse>>, at = 0) => {
    await waitFor(() => expect(saves.length).toBeGreaterThan(at));
    await act(async () => {
      saves[at]?.resolve({ outcome: 'applied', state: null });
    });
  };

  it('keeps a session going when leaving the Review tab and returning', async () => {
    const { api, saves, user } = await open('/review', { cards: [card(1), card(2), card(3)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await settle(saves);
    expect(screen.getByText(/Card 2 of 3: word-2\./)).toBeInTheDocument();

    await user.click(nav().getByRole('link', { name: /^Dashboard/ }));
    await screen.findByRole('region', { name: 'Ready to review' });
    await user.click(nav().getByRole('link', { name: /^Review/ }));

    // Same session, same place: the first card does not come back.
    expect(await screen.findByText(/Card 2 of 3: word-2\./)).toBeInTheDocument();
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);
  });

  it('review shortcuts do nothing on other pages', async () => {
    const { api, user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    press(' ');
    await user.click(nav().getByRole('link', { name: /^Dashboard/ }));
    await screen.findByRole('region', { name: 'Ready to review' });
    press('ArrowRight');
    press('ArrowLeft');
    expect(api.submitAction).not.toHaveBeenCalled();
  });

  it('re-reads the vocabulary after an answer was saved, so the numbers are current', async () => {
    const { api, saves, user } = await open('/', { cards: [card(1)] });
    await screen.findByRole('region', { name: 'Ready to review' });
    expect(api.fetchVocabulary).toHaveBeenCalledTimes(1);

    await user.click(nav().getByRole('link', { name: /^Review/ }));
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowRight');
    await settle(saves);

    await user.click(nav().getByRole('link', { name: /^Dashboard/ }));
    await waitFor(() => expect(api.fetchVocabulary).toHaveBeenCalledTimes(2));
  });

  it('checks for more cards when returning to a finished session', async () => {
    const { api, saves, user } = await open('/review', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    press(' ');
    press('ArrowLeft');
    await settle(saves);
    expect(screen.getByRole('heading', { name: /words?, done\./ })).toBeInTheDocument();

    await user.click(nav().getByRole('link', { name: /^Dashboard/ }));
    await user.click(nav().getByRole('link', { name: /^Review/ }));
    await waitFor(() => expect(api.fetchQueue).toHaveBeenCalledTimes(2));
  });
});

describe('Dashboard', () => {
  it('shows each metric from the real records', async () => {
    await open('/');
    await screen.findByRole('region', { name: 'Ready to review' });
    expect(tileValue('Total vocabulary')).toBe('7');
    expect(tileValue('Mastered')).toBe('2');
    expect(tileValue('Learning')).toBe('5');
    expect(tileValue('Due today')).toBe('2');
    expect(tileValue('Overdue')).toBe('1');
    expect(tileValue('Upcoming')).toBe('2');
    expect(tileValue('Added today')).toBe('2');
    // 4, 5 and 9 October: the 4th is a Sunday, in the previous week.
    expect(tileValue('Added this week')).toBe('3');
  });

  it('never counts a word in two review states', async () => {
    await open('/');
    await screen.findByRole('region', { name: 'Ready to review' });
    const sum = ['Due today', 'Overdue', 'Upcoming'].reduce((total, label) => total + Number(tileValue(label)), 0);
    expect(sum).toBe(Number(tileValue('Learning')));
    expect(Number(tileValue('Mastered')) + Number(tileValue('Learning'))).toBe(Number(tileValue('Total vocabulary')));
  });

  it('leads with what is ready to review and how to start', async () => {
    await open('/');
    const ready = await screen.findByRole('region', { name: 'Ready to review' });
    expect(within(ready).getByRole('heading', { name: '3 words ready to review.' })).toBeInTheDocument();
    expect(ready).toHaveTextContent('1 overdue, 2 due today.');
    expect(within(ready).getByRole('link', { name: /Start review/ })).toHaveAttribute('href', '/review');
    expect(within(ready).getByRole('link', { name: /Add vocabulary/ })).toHaveAttribute('href', '/add');
  });

  it('shows progress towards mastering the vocabulary', async () => {
    await open('/');
    const bar = await screen.findByRole('progressbar', { name: 'Mastered words' });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '7');
    expect(screen.getByText(/of 7 mastered \(29%\)/)).toBeInTheDocument();
  });

  it('charts the mastery distribution with the same numbers as a table', async () => {
    const { user } = await open('/');
    const chart = (await screen.findByText('Words at each mastery level')).closest('figure')!;
    expect(within(chart).getByRole('button', { name: 'Mastery 10: 2 words' })).toBeInTheDocument();
    expect(within(chart).getByRole('button', { name: 'Mastery 1: 1 word' })).toBeInTheDocument();
    expect(within(chart).getByRole('button', { name: 'Mastery 0: 0 words' })).toBeInTheDocument();

    await user.click(within(chart).getByRole('button', { name: 'Show table' }));
    const table = within(chart).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(12);
    expect(within(table).getByRole('row', { name: /Mastery 10/ })).toHaveTextContent('2');
  });

  it('shows a value for a bar on keyboard focus, not only on hover', async () => {
    await open('/');
    const chart = (await screen.findByText('Words at each mastery level')).closest('figure')!;
    const bar = within(chart).getByRole('button', { name: 'Mastery 10: 2 words' });
    act(() => bar.focus());
    expect(within(chart).getByText('2 words')).toBeInTheDocument();
    act(() => bar.blur());
    expect(within(chart).queryByText('2 words')).not.toBeInTheDocument();
  });

  it('lists the most recently added words and links to the bank', async () => {
    await open('/');
    const recent = (await screen.findByRole('heading', { name: 'Recently added' })).closest('section')!;
    const words = within(recent).getAllByRole('button').map((button) => within(button).getAllByText(/-/)[0]?.textContent);
    // By Date Added, newest first; the undated word is left out.
    expect(words).toEqual(['due-a', 'later-a', 'due-b', 'late-a', 'mastered-a', 'mastered-b']);
    expect(within(recent).queryByText('later-b')).not.toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'Open vocabulary bank' })).toHaveAttribute('href', '/bank');
  });

  it('says plainly when words lack a Date Added', async () => {
    await open('/');
    expect(await screen.findByText(/1 word has no Date\s+Added/)).toBeInTheDocument();
  });

  it('links each quick action to a working, filtered destination', async () => {
    const { user } = await open('/');
    await screen.findByRole('region', { name: 'Ready to review' });
    expect(screen.getByRole('link', { name: 'View due today' })).toHaveAttribute('href', '/bank?status=due_today');
    expect(screen.getByRole('link', { name: 'Browse mastered' })).toHaveAttribute('href', '/bank?status=mastered');

    await user.click(screen.getByRole('link', { name: 'View overdue' }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(within(table).getByRole('button', { name: 'late-a' })).toBeInTheDocument();
  });

  it('handles an empty vocabulary without inventing numbers', async () => {
    await open('/', { entries: [] });
    await screen.findByRole('region', { name: 'Ready to review' });
    expect(tileValue('Total vocabulary')).toBe('0');
    expect(screen.getByText(/of 0 mastered/)).toBeInTheDocument();
    expect(screen.getByText('No words have a Date Added yet.')).toBeInTheDocument();
  });

  it('refreshes on request', async () => {
    const { api, user } = await open('/');
    await screen.findByRole('region', { name: 'Ready to review' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.fetchVocabulary).toHaveBeenCalledTimes(2));
  });
});

describe('Calendar', () => {
  const day = (label: RegExp) => screen.getByRole('button', { name: label });

  it('shows the current month with a count on each day that has additions', async () => {
    await open('/calendar');
    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
    ]);
    expect(day(/^Oct 9, 2026: 2 words added \(today\)$/)).toHaveAttribute('data-level', '2');
    expect(day(/^Oct 5, 2026: 1 word added$/)).toHaveAttribute('data-level', '1');
    expect(day(/^Oct 6, 2026: no words added$/)).toHaveAttribute('data-level', '0');
    expect(screen.getByText('4 words added this month.')).toBeInTheDocument();
  });

  it('lists the words added on a selected day', async () => {
    const { user } = await open('/calendar');
    await user.click(await screen.findByRole('button', { name: /^Oct 9, 2026/ }));
    expect(window.location.search).toBe('?month=2026-10&date=2026-10-09');
    const panel = screen.getByRole('heading', { name: 'Oct 9, 2026' }).closest('section')!;
    expect(panel).toHaveTextContent('2 words added.');
    expect(within(panel).getByRole('button', { name: /due-a/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /later-a/ })).toBeInTheDocument();
    expect(day(/^Oct 9, 2026/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows an empty state for a day with no additions', async () => {
    const { user } = await open('/calendar');
    await user.click(await screen.findByRole('button', { name: /^Oct 6, 2026/ }));
    expect(screen.getByText('No words were added on this day.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open these in the bank' })).not.toBeInTheDocument();
  });

  it('opens a word from the selected day and the matching bank results', async () => {
    const { user } = await open('/calendar?month=2026-10&date=2026-10-09');
    await user.click(await screen.findByRole('button', { name: /due-a/ }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('due-a');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('link', { name: 'Open these in the bank' }));
    expect(window.location.pathname + window.location.search).toBe(`/bank?from=${TODAY}&to=${TODAY}`);
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2);
  });

  it('moves between months and back to today', async () => {
    const { user } = await open('/calendar');
    await screen.findByRole('heading', { name: 'October 2026' });
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'August 2026' })).toBeInTheDocument();
    expect(day(/^Aug 1, 2026: 2 words added$/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    expect(day(/^Oct 9, 2026/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('crosses a year boundary', async () => {
    const { user } = await open('/calendar?month=2026-12');
    await screen.findByRole('heading', { name: 'December 2026' });
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeInTheDocument();
  });

  it('gives February 29 days in a leap year', async () => {
    await open('/calendar?month=2028-02');
    await screen.findByRole('heading', { name: 'February 2028' });
    expect(day(/^Feb 29, 2028/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Feb 30/ })).not.toBeInTheDocument();
  });

  it('puts a word on the day stored, not a day shifted by time zones', async () => {
    await open('/calendar?month=2026-10', {
      entries: [entry(1, { word: 'edge', dateAdded: '2026-10-01' }), entry(2, { word: 'end', dateAdded: '2026-10-31' })],
    });
    await screen.findByRole('heading', { name: 'October 2026' });
    expect(day(/^Oct 1, 2026: 1 word added$/)).toBeInTheDocument();
    expect(day(/^Oct 31, 2026: 1 word added$/)).toBeInTheDocument();
    expect(day(/^Sep 30, 2026: no words added$/)).toBeInTheDocument();
  });

  it('reports words without a Date Added instead of placing them somewhere', async () => {
    await open('/calendar');
    expect(await screen.findByText(/1 word has no Date Added and\s+is not placed on the calendar\./)).toBeInTheDocument();
  });

  it('ignores a malformed month or date in the address', async () => {
    await open('/calendar?month=2026-13&date=never');
    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    expect(screen.getByText('Select a date to see the words added on it.')).toBeInTheDocument();
  });
});

describe('Insights and settings', () => {
  it('shows additions by day, week and month from the same records', async () => {
    const { user } = await open('/insights');
    const weekly = (await screen.findByText('Words added per week, last 12 weeks')).closest('figure')!;
    expect(within(weekly).getByRole('button', { name: /Oct 5 – Oct 11, 2026: 3 words/ })).toBeInTheDocument();
    expect(within(weekly).getByRole('button', { name: /Sep 28 – Oct 4, 2026: 1 word$/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Month' }));
    const monthly = screen.getByText('Words added per month, last 12 months').closest('figure')!;
    expect(within(monthly).getByRole('button', { name: 'October 2026: 4 words' })).toBeInTheDocument();
    expect(within(monthly).getByRole('button', { name: 'August 2026: 2 words' })).toBeInTheDocument();
    expect(within(monthly).getByRole('button', { name: 'September 2026: 0 words' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Day' }));
    expect(screen.getByText('Words added per day, last 30 days')).toBeInTheDocument();
  });

  it('shows the share mastered and the busiest days', async () => {
    await open('/insights');
    const share = (await screen.findByRole('heading', { name: 'Mastered and still learning' })).closest('section')!;
    expect(within(share).getByRole('row', { name: /Mastered/ })).toHaveTextContent('229%');
    expect(within(share).getByRole('row', { name: /Learning/ })).toHaveTextContent('571%');
    expect(within(share).getByRole('row', { name: /Total/ })).toHaveTextContent('7100%');

    const busiest = screen.getByRole('heading', { name: 'Days with the most additions' }).closest('section')!;
    const first = within(busiest).getAllByRole('listitem')[0]!;
    expect(first).toHaveTextContent('Oct 9, 2026');
    expect(first).toHaveTextContent('2 words');
  });

  it('lets preferences change the bank and remembers nothing sensitive', async () => {
    const { user } = await open('/settings');
    await screen.findByRole('heading', { name: 'Connection' });
    await user.selectOptions(screen.getByLabelText('Default view'), 'list');
    await user.selectOptions(screen.getByLabelText('Default sort'), 'word');
    await user.selectOptions(screen.getByLabelText('Default direction'), 'asc');
    await user.click(screen.getByLabelText(/Reduce motion/));
    expect(document.documentElement.dataset.reduceMotion).toBe('true');

    await user.click(nav().getByRole('link', { name: /^Vocabulary bank/ }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const first = within(screen.getByRole('main')).getAllByRole('listitem')[0]!;
    expect(first).toHaveTextContent('due-a');
  });

});

describe('weak words page', () => {
  it('shows how far each word is from leaving the list again', async () => {
    window.history.replaceState(null, '', '/weak');
    const fake = createFakeApi({
      weakWords: weakWordsResponse({
        words: [weakWord(1, { recovery: { points: 2, threshold: 3, recovered: false, lastRememberedOn: TODAY } })],
      }),
    });
    render(<App api={fake.api} settings={createSettingsStore(null)} />);
    expect(await screen.findByText('Recovery 2 of 3')).toBeInTheDocument();
  });
});

describe('settings page', () => {
  it('reports the connection honestly', async () => {
    await open('/settings', { list: { writesEnabled: false } });
    const connection = (await screen.findByRole('heading', { name: 'Connection' })).closest('section')!;
    expect(connection).toHaveTextContent('Your account (Supabase)');
    expect(connection).toHaveTextContent('Off: read-only');
    expect(connection).toHaveTextContent(`${TODAY} (Asia/Ho_Chi_Minh)`);
    expect(connection).toHaveTextContent('Mastery 1, no review date');
  });
});
