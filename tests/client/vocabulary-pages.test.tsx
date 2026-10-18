// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'react-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VocabularyEntry, VocabularyListResponse } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore, type Settings } from '../../src/lib/settings.js';
import { createFakeApi, entry } from '../helpers/fake-api.js';
import { TODAY, deferred, pageId } from '../helpers/fixtures.js';

const WORDS = [
  entry(1, { word: 'serendipity', meaning: 'sự tình cờ', mastery: 2, reviewStatus: 'overdue', reviewDate: '2026-10-01', dateAdded: '2026-09-20' }),
  entry(2, { word: 'candid', meaning: 'thẳng thắn', definition: null, example: null, mastery: 10, reviewStatus: 'mastered', reviewable: false, dateAdded: '2026-08-01' }),
  entry(3, { word: 'alleviate', meaning: 'làm dịu', mastery: 5, reviewStatus: 'due_today', dateAdded: TODAY }),
];

interface Options {
  entries?: VocabularyEntry[];
  list?: Partial<VocabularyListResponse>;
  settings?: Partial<Settings>;
}

async function open(path: string, { entries = WORDS, list, settings }: Options = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries, list });
  const store = createSettingsStore(null);
  if (settings) store.update(settings);
  const view = render(<App api={fake.api} settings={store} />);
  await waitFor(() => expect(fake.api.fetchVocabulary).toHaveBeenCalled());
  await screen.findAllByRole('heading');
  return { ...fake, user: userEvent.setup(), ...view };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const wordField = () => screen.getByLabelText(/^Word/);
const addButton = () => screen.getByRole('button', { name: /Add word|Saving/ });

describe('Add vocabulary', () => {
  it('shows a new word at once and confirms it when the server has saved it', async () => {
    const { api, user } = await open('/add');
    const pending = deferred<VocabularyEntry>();
    api.createEntry.mockReturnValueOnce(pending.promise);

    await user.type(await screen.findByLabelText(/^Word/), 'luminous');
    await user.type(screen.getByLabelText('Vietnamese meaning'), 'sáng chói');
    await user.type(screen.getByLabelText('Definition'), 'full of light');
    await user.click(addButton());

    expect(api.createEntry).toHaveBeenCalledTimes(1);
    expect(api.createEntry.mock.calls[0]?.[0]).toMatchObject({
      word: 'luminous',
      meaning: 'sáng chói',
      definition: 'full of light',
      example: '',
      dateAdded: TODAY,
      mastery: 1,
      reviewDate: null,
    });
    expect(api.createEntry.mock.calls[0]?.[0].requestId).toMatch(/^[0-9a-f-]{36}$/);

    // The word is already on screen and the form is ready again, without waiting for the database.
    expect(screen.getByText(/The form is ready for the next word/)).toHaveTextContent('luminous');
    expect(screen.queryByText(/was added/)).not.toBeInTheDocument();
    expect(wordField()).toHaveValue('');
    expect(addButton()).toBeEnabled();

    await act(async () => pending.resolve(entry(50, { word: 'luminous', meaning: 'sáng chói', dateAdded: TODAY })));
    expect(await screen.findByText(/was added/)).toHaveTextContent('luminous was added to your vocabulary.');
    await waitFor(() => expect(screen.queryAllByText(/Saving/)).toHaveLength(0));
    // Ready for the next word, with the cursor back where typing starts.
    expect(wordField()).toHaveValue('');
    expect(screen.getByLabelText('Vietnamese meaning')).toHaveValue('');
    await waitFor(() => expect(wordField()).toHaveFocus());
  });

  it('shows the starting values a new word will get', async () => {
    await open('/add');
    expect(await screen.findByRole('button', { name: /Starting review settings/ })).toHaveTextContent(
      'Mastery 1 · no review date (due right away)',
    );
    expect(screen.getByLabelText('Date added')).toHaveValue(TODAY);
  });

  it('uses the configured defaults, whatever they are', async () => {
    const { api, user } = await open('/add', {
      list: { defaults: { mastery: 0, reviewDate: 'today' } },
    });
    await user.type(await screen.findByLabelText(/^Word/), 'zeal');
    await user.click(addButton());
    expect(api.createEntry.mock.calls[0]?.[0]).toMatchObject({ mastery: 0, reviewDate: TODAY });
  });

  it('requires a word and says so beside the field', async () => {
    const { api, user } = await open('/add');
    await user.click(await screen.findByRole('button', { name: 'Add word' }));
    expect(screen.getByText('Enter the word you want to add.')).toBeInTheDocument();
    expect(wordField()).toHaveAttribute('aria-invalid', 'true');
    await user.type(wordField(), '   ');
    await user.click(addButton());
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('rejects an invalid mastery or date before anything is sent', async () => {
    const { api, user } = await open('/add');
    await user.type(await screen.findByLabelText(/^Word/), 'zeal');
    await user.click(screen.getByRole('button', { name: /Starting review settings/ }));
    await user.clear(screen.getByLabelText('Mastery'));
    await user.type(screen.getByLabelText('Mastery'), '11');
    await user.click(addButton());
    expect(screen.getByText('Mastery must be a whole number from 0 to 10.')).toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Mastery'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Date added'), { target: { value: '' } });
    await user.click(addButton());
    expect(screen.getByText('Choose the date the word was added.')).toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('warns about a word that already exists, ignoring case and spacing', async () => {
    const { api, user } = await open('/add');
    await user.type(await screen.findByLabelText(/^Word/), '  SerenDipity ');
    expect(screen.getByText(/Already in your vocabulary/)).toHaveTextContent('serendipity');

    await user.click(addButton());
    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('This word may already be in your vocabulary');
    expect(within(warning).getByText('sự tình cờ')).toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('lets the user cancel a duplicate or create it on purpose', async () => {
    const { api, user } = await open('/add');
    await user.type(await screen.findByLabelText(/^Word/), 'candid');
    await user.click(addButton());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(wordField()).toHaveValue('candid');

    await user.click(addButton());
    await user.click(screen.getByRole('button', { name: 'Add it anyway' }));
    expect(api.createEntry).toHaveBeenCalledTimes(1);
    expect(api.createEntry.mock.calls[0]?.[0]).toMatchObject({ word: 'candid', allowDuplicate: true });
  });

  it('shows the server’s duplicate warning for a word this browser had not loaded', async () => {
    const { api, user } = await open('/add');
    api.createEntry.mockRejectedValueOnce(
      new ApiError('duplicate', '"zeal" is already in your vocabulary.', 409, [entry(77, { word: 'zeal', meaning: 'nhiệt huyết' })]),
    );
    await user.type(await screen.findByLabelText(/^Word/), 'zeal');
    await user.click(addButton());
    // The word was shown at once, then taken back out when the server refused it as a duplicate.
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('zeal');
    expect(warning).toHaveTextContent('nhiệt huyết');
    expect(screen.queryByText(/was added/)).not.toBeInTheDocument();

    await user.click(within(warning).getByRole('button', { name: 'Add it anyway' }));
    expect(api.createEntry).toHaveBeenLastCalledWith(expect.objectContaining({ word: 'zeal', allowDuplicate: true }));
  });

  it('keeps what was typed when saving fails and can send it again', async () => {
    const { api, user } = await open('/add');
    api.createEntry.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));
    await user.type(await screen.findByLabelText(/^Word/), 'zeal');
    await user.type(screen.getByLabelText('Definition'), 'great energy');
    await user.click(addButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The database refused this change.');
    expect(alert).toHaveTextContent('zeal');
    expect(screen.queryByText(/was added/)).not.toBeInTheDocument();

    // Nothing has to be typed again: the same submission is sent once more, under the same request id.
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/was added/)).toBeInTheDocument();
    expect(api.createEntry.mock.calls[1]?.[0].requestId).toBe(api.createEntry.mock.calls[0]?.[0].requestId);
  });

  it('returns a failed word to the form when the user chooses to edit it', async () => {
    const { api, user } = await open('/add');
    api.createEntry.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));
    await user.type(await screen.findByLabelText(/^Word/), 'zeal');
    await user.type(screen.getByLabelText('Definition'), 'great energy');
    await user.click(addButton());

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Edit' }));
    expect(wordField()).toHaveValue('zeal');
    expect(screen.getByLabelText('Definition')).toHaveValue('great energy');
  });

  it('does not freeze the form while a save is still in flight', async () => {
    const { api, user } = await open('/add');
    const pending = deferred<VocabularyEntry>();
    api.createEntry.mockReturnValueOnce(pending.promise);

    await user.type(await screen.findByLabelText(/^Word/), 'alpha{Enter}');
    // The next word can be typed and sent while the first is still saving.
    await user.type(wordField(), 'beta{Enter}');
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(1));
    // Both submissions are on screen, and the second takes its turn behind the
    // first instead of failing or being dropped.
    expect(screen.getByText(/The form is ready for the next word/)).toHaveTextContent('alpha, beta');
    expect(api.createEntry.mock.calls[0]?.[0].word).toBe('alpha');

    await act(async () => pending.resolve(entry(60, { word: 'alpha' })));
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(2));
    expect(api.createEntry.mock.calls[1]?.[0].word).toBe('beta');
    await waitFor(() => expect(screen.queryAllByText(/Saving/)).toHaveLength(0));
  });

  it('keeps several words added in quick succession, each saved once', async () => {
    const { api, user } = await open('/add');
    await user.type(await screen.findByLabelText(/^Word/), 'alpha{Enter}');
    await user.type(wordField(), 'beta{Enter}');
    await user.type(wordField(), 'gamma{Enter}');
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(3));
    expect(api.createEntry.mock.calls.map((call) => call[0].word)).toEqual(['alpha', 'beta', 'gamma']);
    // Each submission got its own request id, so none is mistaken for another.
    const ids = api.createEntry.mock.calls.map((call) => call[0].requestId);
    expect(new Set(ids).size).toBe(3);

    await waitFor(() => expect(screen.queryByText(/Saving/)).not.toBeInTheDocument());
    await user.click(within(screen.getAllByRole('navigation', { name: 'Main' })[0]!).getByRole('link', { name: /Vocabulary bank/ }));
    await screen.findByRole('table');
    expect(rowWords()).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
    expect(api.fetchVocabulary).toHaveBeenCalledTimes(1);
  });

  it('sends one request however fast the button is pressed', async () => {
    const { api, user } = await open('/add');
    const pending = deferred<VocabularyEntry>();
    api.createEntry.mockReturnValueOnce(pending.promise);
    await user.type(await screen.findByLabelText(/^Word/), 'zeal');
    const form = screen.getByRole('form', { name: 'Add vocabulary' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(1));
    expect(api.createEntry.mock.calls[0]?.[0].word).toBe('zeal');
    await act(async () => pending.resolve(entry(51, { word: 'zeal' })));
  });

  it('uses a fresh request id for each new word', async () => {
    const { api, user } = await open('/add');
    await user.type(await screen.findByLabelText(/^Word/), 'zeal{Enter}');
    await screen.findByText(/was added/);
    await user.type(wordField(), 'verve{Enter}');
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(2));
    expect(api.createEntry.mock.calls[1]?.[0].requestId).not.toBe(api.createEntry.mock.calls[0]?.[0].requestId);
  });

  it('quick add saves with Enter and sends only the word and meaning', async () => {
    const { api, user } = await open('/add');
    await user.click(await screen.findByLabelText('Quick add'));
    expect(screen.queryByLabelText('Definition')).not.toBeInTheDocument();
    await user.type(wordField(), 'zeal');
    await user.type(screen.getByLabelText('Vietnamese meaning'), 'nhiệt huyết{Enter}');
    expect(api.createEntry).toHaveBeenCalledTimes(1);
    const sent = api.createEntry.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ word: 'zeal', meaning: 'nhiệt huyết', mastery: 1, dateAdded: TODAY });
    expect(sent?.definition).toBeUndefined();
    expect(sent?.example).toBeUndefined();
  });

  it('makes the new word appear in the bank and dashboard without reloading', async () => {
    const { api, user } = await open('/add');
    await user.type(await screen.findByLabelText(/^Word/), 'luminous{Enter}');
    await screen.findByText(/was added/);

    await user.click(within(screen.getAllByRole('navigation', { name: 'Main' })[0]!).getByRole('link', { name: /Vocabulary bank/ }));
    expect(await screen.findByRole('button', { name: 'luminous' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('of 4 words');
    expect(api.fetchVocabulary).toHaveBeenCalledTimes(1);
  });

  it('cannot add while saving is switched off', async () => {
    const { api, user } = await open('/add', { list: { writesEnabled: false } });
    expect(await screen.findByText(/Saving is switched off/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add word' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Add vocabulary' }));
    await user.keyboard('{Enter}');
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('clears the form on request', async () => {
    const { user } = await open('/add');
    await user.type(await screen.findByLabelText(/^Word/), 'zeal');
    await user.type(screen.getByLabelText('Definition'), 'energy');
    await user.click(screen.getByRole('button', { name: 'Clear form' }));
    expect(wordField()).toHaveValue('');
    expect(screen.getByLabelText('Definition')).toHaveValue('');
    expect(screen.getByLabelText('Date added')).toHaveValue(TODAY);
  });
});

const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);
const rowWords = () => rows().map((row) => within(row).getAllByRole('button')[0]?.textContent);

describe('Vocabulary bank', () => {
  it('lists every word with its stored values', async () => {
    await open('/bank');
    await screen.findByRole('table');
    // Default order: most recently added first.
    expect(rowWords()).toEqual(['alleviate', 'serendipity', 'candid']);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1–3 of 3 words');
    const candid = rows()[2]!;
    expect(within(candid).getByText('thẳng thắn')).toBeInTheDocument();
    expect(within(candid).getByText('Mastered')).toBeInTheDocument();
    expect(within(candid).getByText(/Missing definition, Missing example/)).toBeInTheDocument();
  });

  it('searches as you type and says when nothing matches', async () => {
    const { user } = await open('/bank');
    const search = await screen.findByRole('searchbox');
    await user.type(search, '  SEREN ');
    expect(rowWords()).toEqual(['serendipity']);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1–1 of 1 word (filtered from 3)');

    await user.clear(search);
    await user.type(search, 'làm dịu');
    expect(rowWords()).toEqual(['alleviate']);

    await user.clear(search);
    await user.type(search, 'xylophone');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No words match these filters')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(rowWords()).toHaveLength(3);
    expect(search).toHaveValue('');
  });

  it('filters by review status, mastery and preset, and clears them', async () => {
    const { user } = await open('/bank');
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Review status'), 'mastered');
    expect(rowWords()).toEqual(['candid']);
    expect(window.location.search).toBe('?status=mastered');

    await user.selectOptions(screen.getByLabelText('Review status'), '');
    await user.selectOptions(screen.getByLabelText('Mastery'), '5');
    expect(rowWords()).toEqual(['alleviate']);

    await user.click(screen.getByRole('button', { name: 'Overdue' }));
    expect(rowWords()).toEqual(['serendipity']);
    expect(screen.getByRole('button', { name: 'Overdue' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Mastery')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(rowWords()).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens with the filters given in the address', async () => {
    await open(`/bank?from=${TODAY}&to=${TODAY}`);
    await screen.findByRole('table');
    expect(rowWords()).toEqual(['alleviate']);
    expect(screen.getByLabelText('Added from')).toHaveValue(TODAY);
  });

  it('sorts by a column and shows which way', async () => {
    const { user } = await open('/bank');
    await screen.findByRole('table');
    const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });
    expect(header('Date added')).toHaveAttribute('aria-sort', 'descending');

    await user.click(within(header('Word')).getByRole('button'));
    expect(rowWords()).toEqual(['alleviate', 'candid', 'serendipity']);
    expect(header('Word')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Date added')).toHaveAttribute('aria-sort', 'none');

    await user.click(within(header('Word')).getByRole('button'));
    expect(rowWords()).toEqual(['serendipity', 'candid', 'alleviate']);
    expect(header('Word')).toHaveAttribute('aria-sort', 'descending');

    await user.click(within(header('^Mastery$')).getByRole('button'));
    // A weakness sort starts from the weakest: mastery lowest first.
    expect(rowWords()).toEqual(['serendipity', 'alleviate', 'candid']);
    expect(header('^Mastery$')).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByLabelText('Sort by')).toHaveValue('mastery');

    // Choosing a sort from the select uses the same rule, whatever the direction was.
    await user.click(screen.getByRole('button', { name: /Sort direction/ }));
    expect(rowWords()).toEqual(['candid', 'alleviate', 'serendipity']);
    await user.selectOptions(screen.getByLabelText('Sort by'), 'reviewDate');
    expect(rowWords()).toEqual(['serendipity', 'alleviate', 'candid']);
  });

  it('pages through a long list', async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      entry(index + 1, { word: `word-${String(index + 1).padStart(2, '0')}` }),
    );
    const { user } = await open('/bank?sort=word&dir=asc', { entries: many, settings: { bankPageSize: 25 } });
    await screen.findByRole('table');
    expect(rows()).toHaveLength(25);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1–25 of 30 words');
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(rows()).toHaveLength(5);
    expect(rowWords()[0]).toBe('word-26');
    expect(screen.getByRole('status')).toHaveTextContent('Showing 26–30 of 30 words');
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();

    // Changing a filter starts again from the first page.
    await user.type(screen.getByRole('searchbox'), 'word-0');
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1–9 of 9 words');
  });

  it('offers a compact list view as well', async () => {
    const { user } = await open('/bank');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Compact list view' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /serendipity/ })).toBeInTheDocument();
  });

  it('shows an empty state for an empty vocabulary', async () => {
    await open('/bank', { entries: [] });
    expect(await screen.findByText('Your vocabulary is empty')).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Add vocabulary' })).toHaveAttribute('href', '/add');
  });

  it('shows why loading failed and lets the user retry', async () => {
    window.history.replaceState(null, '', '/bank');
    const { api } = createFakeApi({ entries: WORDS });
    api.fetchVocabulary.mockRejectedValueOnce(new ApiError('setup_incomplete', 'No property named "Word".', 503));
    render(<App api={api} settings={createSettingsStore(null)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No property named "Word".');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});

describe('Word details', () => {
  const openWord = async (options: Options = {}) => {
    const context = await open('/bank', options);
    await context.user.click(await screen.findByRole('button', { name: 'serendipity' }));
    const panel = await screen.findByRole('dialog');
    return { ...context, panel };
  };

  it('opens a panel with everything stored about the word', async () => {
    const { api, panel } = await openWord();
    expect(within(panel).getByRole('heading', { name: 'serendipity' })).toBeInTheDocument();
    expect(within(panel).getByText('sự tình cờ')).toBeInTheDocument();
    expect(within(panel).getByText('definition of word-1')).toBeInTheDocument();
    expect(within(panel).getByText('example for word-1')).toBeInTheDocument();
    expect(within(panel).getByText('Overdue')).toBeInTheDocument();
    expect(within(panel).getByText('Sep 20, 2026')).toBeInTheDocument();
    // Nothing links out of the app: the word lives here. Any link in the panel stays inside it.
    for (const link of within(panel).queryAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/^\/(?!\/)/);
    }
    // The latest values are fetched when the panel opens.
    expect(api.fetchEntry).toHaveBeenCalledWith(pageId(1));
    expect(window.location.search).toContain(`word=${pageId(1)}`);
  });

  it('says "Not set" for an empty field instead of inventing a value', async () => {
    const { user } = await open('/bank');
    await user.click(await screen.findByRole('button', { name: 'candid' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getAllByText('Not set')).toHaveLength(2);
    expect(within(panel).getByText(/Missing definition\. Missing example\./)).toBeInTheDocument();
  });

  it('closes with the close button and with Escape', async () => {
    const { user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'serendipity' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('saves only the fields that were changed', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    const definition = within(panel).getByLabelText('Definition');
    await user.clear(definition);
    await user.type(definition, 'a happy accident');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));

    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(pageId(1), { definition: 'a happy accident' });
    expect(await within(panel).findByText('a happy accident')).toBeInTheDocument();
    expect(within(panel).queryByLabelText('Definition')).not.toBeInTheDocument();
    expect(screen.getByText('Saved “serendipity”.')).toBeInTheDocument();
  });

  it('shows an edit at once without waiting for the database', async () => {
    const { api, user, panel } = await openWord();
    const pending = deferred<VocabularyEntry>();
    api.updateEntry.mockReturnValueOnce(pending.promise);
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    const definition = within(panel).getByLabelText('Definition');
    await user.clear(definition);
    await user.type(definition, 'a happy accident');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));

    // The editor is closed and the new value is on screen while the request is still open.
    expect(api.updateEntry).toHaveBeenCalledTimes(1);
    expect(within(panel).queryByLabelText('Definition')).not.toBeInTheDocument();
    expect(within(panel).getByText('a happy accident')).toBeInTheDocument();

    await act(async () => pending.resolve(entry(1, { definition: 'a happy accident' })));
    expect(within(panel).getByText('a happy accident')).toBeInTheDocument();
  });

  it('puts an edit back when the database refuses it', async () => {
    const { api, user, panel } = await openWord();
    api.updateEntry.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    const meaning = within(panel).getByLabelText('Vietnamese meaning');
    await user.clear(meaning);
    await user.type(meaning, 'mới');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'The database refused this change. Your changes are still here.',
    );
    // The typed draft is kept for another try; cancelling shows the stored value again.
    expect(within(panel).getByLabelText('Vietnamese meaning')).toHaveValue('mới');
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(within(panel).getByText('sự tình cờ')).toBeInTheDocument();
  });

  it('stays in the edit form when Edit is pressed, in the order a browser handles the click', async () => {
    const { api, panel } = await openWord();
    const edit = within(panel).getByRole('button', { name: /Edit/ });

    // A browser lets React redraw between running the click's handlers and acting on the click
    // itself. The test helpers hide that gap, so it is put back here: React is flushed from a
    // listener that runs after its own, and only then does the click take effect. If Edit were
    // redrawn in place as the submit button, this same click would submit the form, find nothing
    // changed, and close the editor the moment it opened.
    const redraw = () => flushSync(() => {});
    document.addEventListener('click', redraw);
    try {
      edit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener('click', redraw);
    }

    const save = await within(panel).findByRole('button', { name: 'Save changes' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(save).toBeInTheDocument();
    expect(panel.querySelector('#edit-word')).toHaveValue('serendipity');
    // The button that was pressed is gone, not turned into the one that saves.
    expect(edit).not.toBeInTheDocument();
    expect(save).not.toBe(edit);
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('never sends mastery or the review date unless the schedule section was opened', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    await user.type(within(panel).getByLabelText('Example sentences'), ' More.');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(api.updateEntry.mock.calls[0]?.[1]).toEqual({ example: 'example for word-1 More.' });
    expect(api.updateEntry.mock.calls[0]?.[1]).not.toHaveProperty('schedule');
  });

  it('changes the schedule only through its own explicit section', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    expect(within(panel).queryByLabelText('Mastery')).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /Review schedule/ }));
    fireEvent.change(within(panel).getByLabelText('Mastery'), { target: { value: '12' } });
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(within(panel).getByText('Mastery must be a whole number from 0 to 10.')).toBeInTheDocument();
    expect(api.updateEntry).not.toHaveBeenCalled();

    fireEvent.change(within(panel).getByLabelText('Mastery'), { target: { value: '4' } });
    fireEvent.change(within(panel).getByLabelText('Review date'), { target: { value: '' } });
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(pageId(1), { schedule: { mastery: 4, reviewDate: null } });
  });

  it('says whether the schedule will change, and sends none while its section is open but untouched', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    const section = () => within(panel).getByRole('button', { name: /Review schedule/ });
    expect(section()).toHaveTextContent('Not changed unless opened');

    await user.click(section());
    expect(section()).toHaveTextContent('Nothing changed yet');
    await user.type(within(panel).getByLabelText('Example sentences'), ' More.');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(pageId(1), { example: 'example for word-1 More.' });
  });

  it('keeps a schedule edit when its section is closed again, and says so before saving', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    const section = () => within(panel).getByRole('button', { name: /Review schedule/ });
    await user.click(section());
    fireEvent.change(within(panel).getByLabelText('Mastery'), { target: { value: '6' } });
    expect(section()).toHaveTextContent('Changed: will be saved');

    // Closing the section hides the fields. It must not quietly drop what was typed in them.
    await user.click(section());
    expect(within(panel).queryByLabelText('Mastery')).not.toBeInTheDocument();
    expect(section()).toHaveTextContent('Changed: will be saved');

    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(pageId(1), { schedule: { mastery: 6, reviewDate: '2026-10-01' } });
  });

  it('opens the section again to show a mistake made in it, instead of doing nothing', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    const section = () => within(panel).getByRole('button', { name: /Review schedule/ });
    await user.click(section());
    fireEvent.change(within(panel).getByLabelText('Mastery'), { target: { value: '12' } });
    await user.click(section());
    expect(section()).toHaveAttribute('aria-expanded', 'false');

    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(section()).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getByText('Mastery must be a whole number from 0 to 10.')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Mastery')).toHaveValue(12);
  });

  it('lets the text of a word be edited even when its stored mastery is unusable', async () => {
    // Nothing in the schedule section was touched, so nothing in it is checked or sent.
    const broken = entry(1, { word: 'serendipity', meaning: 'sự tình cờ', mastery: null, reviewStatus: 'invalid', reviewable: false });
    const { api, user, panel } = await openWord({ entries: [broken] });
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    await user.type(within(panel).getByLabelText('Example sentences'), ' More.');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(api.updateEntry).toHaveBeenCalledExactlyOnceWith(pageId(1), { example: 'example for word-1 More.' });
  });

  it('keeps what was typed when saving fails', async () => {
    const { api, user, panel } = await openWord();
    api.updateEntry.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    const meaning = within(panel).getByLabelText('Vietnamese meaning');
    await user.clear(meaning);
    await user.type(meaning, 'may mắn bất ngờ');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent('The database refused this change. Your changes are still here.');
    expect(within(panel).getByLabelText('Vietnamese meaning')).toHaveValue('may mắn bất ngờ');
    // Escape must not throw the draft away either.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // The refused attempt does not stand in the way of saving again.
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(await within(panel).findByText('may mắn bất ngờ')).toBeInTheDocument();
  });

  it('validates an edit before sending it', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    await user.clear(within(panel).getByLabelText(/^Word/));
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(within(panel).getByText('Enter a word.')).toBeInTheDocument();
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('warns when a rename collides with another word', async () => {
    const { api, user, panel } = await openWord();
    api.updateEntry.mockRejectedValueOnce(new ApiError('duplicate', '"candid" is already in your vocabulary.', 409, [WORDS[1]!]));
    await user.click(within(panel).getByRole('button', { name: /Edit/ }));
    await user.clear(within(panel).getByLabelText(/^Word/));
    await user.type(within(panel).getByLabelText(/^Word/), 'candid');
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Another word is already spelled this way');
    await user.click(within(panel).getByRole('button', { name: 'Save anyway' }));
    expect(api.updateEntry).toHaveBeenLastCalledWith(pageId(1), { word: 'candid', allowDuplicate: true });
  });

  it('asks before deleting, naming the word, and deletes nothing on cancel', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Delete/ }));
    const confirm = screen.getByRole('heading', { name: 'Delete “serendipity”?' }).closest('dialog')!;
    expect(confirm).toHaveTextContent('will be moved to the trash');
    expect(confirm).toHaveTextContent('mastery of 2');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(api.deleteEntry).not.toHaveBeenCalled();
    expect(rowWords()).toContain('serendipity');
  });

  it('moves the word to the trash on confirmation and can undo it', async () => {
    const { api, user, panel } = await openWord();
    await user.click(within(panel).getByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Move to trash' }));

    await waitFor(() => expect(rowWords()).toEqual(['alleviate', 'candid']));
    await waitFor(() => expect(api.deleteEntry).toHaveBeenCalledExactlyOnceWith(pageId(1)));
    expect(screen.queryByRole('heading', { name: 'serendipity' })).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(rowWords()).toContain('serendipity'));
    expect(api.restoreEntry).toHaveBeenCalledExactlyOnceWith(pageId(1));
  });

  it('keeps the word when deleting fails, and says why', async () => {
    const { api, user, panel } = await openWord();
    api.deleteEntry.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));
    await user.click(within(panel).getByRole('button', { name: /Delete/ }));
    await user.click(screen.getByRole('button', { name: 'Move to trash' }));
    expect(await screen.findByText(/The database refused this change/)).toBeInTheDocument();
    await waitFor(() => expect(rowWords()).toContain('serendipity'));
  });

  it('is read-only while saving is switched off', async () => {
    const { panel } = await openWord({ list: { writesEnabled: false } });
    expect(within(panel).getByRole('button', { name: /Edit/ })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: /Delete/ })).toBeDisabled();
  });
});
