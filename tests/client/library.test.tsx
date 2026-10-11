// @vitest-environment jsdom
/**
 * Collections, further examples and related words in the browser. The store
 * is given real helper rules by the test stand-in; what is checked here is
 * that the screens ask for the right thing, show what came back, and never
 * touch a word itself.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VocabularyEntry } from '../../shared/api.js';
import type { Collection, ExtraExample, Relation } from '../../shared/library.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createLibraryStore } from '../../src/lib/library-store.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';
import { card, pageId } from '../helpers/fixtures.js';

const WORDS: VocabularyEntry[] = [
  entry(1, { word: 'big', meaning: 'to', reviewable: true }),
  entry(2, { word: 'large', meaning: 'lớn', reviewable: true }),
  entry(3, { word: 'tiny', meaning: 'nhỏ xíu', reviewable: false, reviewStatus: 'upcoming', reviewDate: '2026-10-20' }),
  entry(4, { word: 'affect', meaning: 'ảnh hưởng', reviewable: false, reviewStatus: 'upcoming', reviewDate: '2026-10-21' }),
];

const collection = (n: number, name: string, wordIds: string[] = []): Collection => ({ id: pageId(900 + n), name, wordIds });
const example = (n: number, overrides: Partial<ExtraExample> = {}): ExtraExample => ({
  id: pageId(800 + n),
  vocabularyId: pageId(1),
  sentence: `Extra sentence ${n}.`,
  source: null,
  preferred: false,
  ...overrides,
});
const relation = (n: number, a: string, b: string, kind: Relation['kind'] = 'synonym'): Relation => ({
  id: pageId(700 + n),
  kind,
  a: a < b ? a : b,
  b: a < b ? b : a,
});

async function open(path: string, options: FakeApiOptions = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: WORDS, ...options });
  const view = render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup(), ...view };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const main = () => within(screen.getByRole('main'));
const EXAM = collection(1, 'Exam', [pageId(1), pageId(3)]);
const BOOKS = collection(2, 'Books', [pageId(2)]);

describe('the Collections page', () => {
  it('has its place in the navigation and lists collections by name with their counts', async () => {
    const { user } = await open('/', { library: { collections: [EXAM, BOOKS] } });
    await user.click(within(screen.getAllByRole('navigation', { name: 'Main' })[0]!).getByRole('link', { name: /^Collections/ }));
    expect(document.title).toBe('Collections · Vocabulary');
    const items = await main().findAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Books1 word · 1 due'),
      expect.stringContaining('Exam2 words · 1 due'),
    ]);
  });

  it('creates a collection and shows it at once', async () => {
    const { api, user } = await open('/collections');
    await user.type(await main().findByLabelText('New collection'), '  IELTS  ');
    await user.click(main().getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createCollection).toHaveBeenCalledWith('  IELTS  '));
    expect(await main().findByRole('link', { name: 'IELTS' })).toBeInTheDocument();
    expect(await screen.findByText('Collection “IELTS” created.')).toBeInTheDocument();
    expect(main().getByLabelText('New collection')).toHaveValue('');
  });

  it('says so when the name is already taken, and keeps what was typed', async () => {
    const { user } = await open('/collections', { library: { collections: [EXAM] } });
    await user.type(await main().findByLabelText('New collection'), 'exam');
    await user.click(main().getByRole('button', { name: 'Create' }));
    expect(await main().findByRole('alert')).toHaveTextContent('You already have a collection called “exam”.');
    expect(main().getByLabelText('New collection')).toHaveValue('exam');
    expect(main().getAllByRole('listitem')).toHaveLength(1);
  });

  it('renames a collection in place', async () => {
    const { api, user } = await open('/collections', { library: { collections: [EXAM] } });
    await user.click(await main().findByRole('button', { name: 'Rename Exam' }));
    const field = main().getByLabelText('New name for Exam');
    await user.clear(field);
    await user.type(field, 'IELTS{Enter}');
    await waitFor(() => expect(api.renameCollection).toHaveBeenCalledWith(EXAM.id, 'IELTS'));
    expect(await main().findByRole('link', { name: 'IELTS' })).toBeInTheDocument();
    expect(main().queryByRole('link', { name: 'Exam' })).not.toBeInTheDocument();
  });

  it('asks before deleting, and says the words stay', async () => {
    const { api, user } = await open('/collections', { library: { collections: [EXAM, BOOKS] } });
    await user.click(await main().findByRole('button', { name: 'Delete Exam' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Only the collection is removed.');
    expect(dialog).toHaveTextContent('The 2 words in it stay in your vocabulary, with their mastery and review dates unchanged.');
    expect(api.deleteCollection).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(main().getByRole('link', { name: 'Exam' })).toBeInTheDocument();
    expect(api.deleteCollection).not.toHaveBeenCalled();
  });

  it('deletes only the collection: no word is deleted, edited or re-read', async () => {
    const { api, user } = await open('/collections', { library: { collections: [EXAM, BOOKS] } });
    await user.click(await main().findByRole('button', { name: 'Delete Exam' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete collection' }));

    await waitFor(() => expect(api.deleteCollection).toHaveBeenCalledWith(EXAM.id));
    await waitFor(() => expect(main().queryByRole('link', { name: 'Exam' })).not.toBeInTheDocument());
    expect(main().getByRole('link', { name: 'Books' })).toBeInTheDocument();
    expect(api.deleteEntry).not.toHaveBeenCalled();
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(await screen.findByText('Collection “Exam” deleted. Its words are still in your vocabulary.')).toBeInTheDocument();
  });

  it('keeps the collection on screen when deleting fails, and says why', async () => {
    const { api, user } = await open('/collections', { library: { collections: [EXAM] } });
    api.deleteCollection.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    await user.click(await main().findByRole('button', { name: 'Delete Exam' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete collection' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Could not reach the server.');
    expect(main().getByRole('link', { name: 'Exam' })).toBeInTheDocument();
  });

  it('links each collection to its words in the bank, its due words in Review, and Practice', async () => {
    await open('/collections', { library: { collections: [EXAM] } });
    expect(await main().findByRole('link', { name: 'Exam' })).toHaveAttribute('href', `/bank?collection=${EXAM.id}`);
    expect(main().getByRole('link', { name: 'Review the due words' })).toHaveAttribute('href', `/review?collection=${EXAM.id}`);
    expect(main().getByRole('link', { name: 'Practise' })).toHaveAttribute('href', `/practice?collection=${EXAM.id}`);
  });

  it('offers no review for a collection with nothing due, and no practice for an empty one', async () => {
    await open('/collections', { library: { collections: [collection(3, 'Later', [pageId(3)]), collection(4, 'Empty')] } });
    await main().findByRole('link', { name: 'Later' });
    expect(main().queryByRole('link', { name: 'Review the due words' })).not.toBeInTheDocument();
    expect(main().getAllByRole('link', { name: 'Practise' })).toHaveLength(1);
  });

  it('says so when there are none, when they cannot be kept yet, and when loading fails', async () => {
    await open('/collections');
    expect(await main().findByRole('heading', { name: 'No collections yet' })).toBeInTheDocument();
  });

  it('explains when the database cannot keep collections yet', async () => {
    await open('/collections', { library: { available: false } });
    expect(await main().findByText(/Collections can be kept once the database has its latest update/)).toBeInTheDocument();
    expect(main().queryByLabelText('New collection')).not.toBeInTheDocument();
  });

  it('reports a failed load and loads on Try again', async () => {
    window.history.replaceState(null, '', '/collections');
    const { api } = createFakeApi({ entries: WORDS, library: { collections: [EXAM] } });
    api.fetchLibrary.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    render(<App api={api} settings={createSettingsStore(null)} />);
    expect(await main().findByRole('alert')).toHaveTextContent('Could not reach the server.');
    await userEvent.setup().click(main().getByRole('button', { name: 'Try again' }));
    expect(await main().findByRole('link', { name: 'Exam' })).toBeInTheDocument();
  });

  it('offers nothing that changes data while saving is switched off', async () => {
    await open('/collections', { library: { collections: [EXAM] }, list: { writesEnabled: false } });
    await main().findByRole('link', { name: 'Exam' });
    expect(main().queryByLabelText('New collection')).not.toBeInTheDocument();
    expect(main().queryByRole('button', { name: 'Delete Exam' })).not.toBeInTheDocument();
    expect(main().queryByRole('button', { name: 'Rename Exam' })).not.toBeInTheDocument();
  });
});

describe('a word’s collections', () => {
  const panel = () => screen.findByRole('dialog');
  const section = async (title: string) => (await within(await panel()).findByRole('heading', { name: title })).closest('section')!;

  it('shows which collections the word is in', async () => {
    await open(`/bank?word=${pageId(1)}`, { library: { collections: [EXAM, BOOKS] } });
    const collections = within(await section('Collections'));
    expect(collections.getByRole('checkbox', { name: 'Exam' })).toBeChecked();
    expect(collections.getByRole('checkbox', { name: 'Books' })).not.toBeChecked();
  });

  it('adds and removes the word by ticking, without touching the word', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`, { library: { collections: [EXAM, BOOKS] } });
    const collections = within(await section('Collections'));
    await user.click(collections.getByRole('checkbox', { name: 'Books' }));
    await waitFor(() => expect(api.setMembership).toHaveBeenCalledWith(BOOKS.id, pageId(1), true));
    await waitFor(() => expect(collections.getByRole('checkbox', { name: 'Books' })).toBeChecked());

    await user.click(collections.getByRole('checkbox', { name: 'Exam' }));
    await waitFor(() => expect(api.setMembership).toHaveBeenLastCalledWith(EXAM.id, pageId(1), false));
    await waitFor(() => expect(collections.getByRole('checkbox', { name: 'Exam' })).not.toBeChecked());
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('leaves the tick as it was when the change fails', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`, { library: { collections: [BOOKS] } });
    api.setMembership.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    const collections = within(await section('Collections'));
    await user.click(collections.getByRole('checkbox', { name: 'Books' }));
    expect(await collections.findByRole('alert')).toHaveTextContent('Could not reach the server.');
    expect(collections.getByRole('checkbox', { name: 'Books' })).not.toBeChecked();
  });

  it('points to the Collections page when there are none', async () => {
    await open(`/bank?word=${pageId(1)}`);
    expect(within(await section('Collections')).getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/collections');
  });

  it('is left out of the panel where the database cannot keep any of this', async () => {
    await open(`/bank?word=${pageId(1)}`, { library: { available: false } });
    const dialog = await panel();
    await within(dialog).findByText('to');
    await waitFor(() => expect(within(dialog).queryByText(/Loading collections/)).not.toBeInTheDocument());
    expect(within(dialog).queryByRole('heading', { name: 'Collections' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Related words' })).not.toBeInTheDocument();
  });
});

describe('a word’s further examples', () => {
  const section = async () =>
    (await within(await screen.findByRole('dialog')).findByRole('heading', { name: 'More examples' })).closest('section')!;

  it('lists them with their source, the preferred one first', async () => {
    await open(`/bank?word=${pageId(1)}`, {
      library: {
        examples: [
          example(1),
          example(2, { preferred: true, source: 'The Economist' }),
          example(3, { vocabularyId: pageId(2), sentence: 'Belongs to another word.' }),
        ],
      },
    });
    const items = within(await section()).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Extra sentence 2.');
    expect(items[0]).toHaveTextContent('Source: The Economist');
    expect(items[0]).toHaveTextContent('Preferred');
    expect(items[1]).toHaveTextContent('Extra sentence 1.');
  });

  it('adds one with an optional source, and clears the form', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`);
    const examples = within(await section());
    await user.type(examples.getByLabelText('Another example sentence'), 'A big day.');
    await user.type(examples.getByLabelText('Where it is from (optional)'), 'a novel');
    await user.click(examples.getByRole('button', { name: 'Add example' }));

    await waitFor(() => expect(api.addExample).toHaveBeenCalledWith(pageId(1), { sentence: 'A big day.', source: 'a novel' }));
    expect(await examples.findByText('A big day.')).toBeInTheDocument();
    expect(examples.getByText('Source: a novel')).toBeInTheDocument();
    expect(examples.getByLabelText('Another example sentence')).toHaveValue('');
    // The word's own example is not what was edited.
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('does not send an empty sentence', async () => {
    const { api } = await open(`/bank?word=${pageId(1)}`);
    const examples = within(await section());
    expect(examples.getByRole('button', { name: 'Add example' })).toBeDisabled();
    fireEvent.submit(examples.getByLabelText('Another example sentence').closest('form')!);
    expect(api.addExample).not.toHaveBeenCalled();
  });

  it('moves the preferred mark, so that only one example carries it', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`, {
      library: { examples: [example(1, { preferred: true }), example(2)] },
    });
    const examples = within(await section());
    await user.click(examples.getByRole('button', { name: 'Mark as preferred' }));
    await waitFor(() => expect(api.updateExample).toHaveBeenCalledWith(example(2).id, { preferred: true }));
    await waitFor(() => expect(examples.getAllByText('Preferred')).toHaveLength(1));
    expect(examples.getAllByRole('listitem')[0]).toHaveTextContent('Extra sentence 2.');
  });

  it('removes one', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`, { library: { examples: [example(1), example(2)] } });
    const examples = within(await section());
    await user.click(examples.getByRole('button', { name: /Remove the example “Extra sentence 1\.”/ }));
    await waitFor(() => expect(api.deleteExample).toHaveBeenCalledWith(example(1).id));
    await waitFor(() => expect(examples.queryByText('Extra sentence 1.')).not.toBeInTheDocument());
    expect(examples.getByText('Extra sentence 2.')).toBeInTheDocument();
  });

  it('says the flashcard keeps showing the word’s own example', async () => {
    await open(`/bank?word=${pageId(1)}`);
    expect(await section()).toHaveTextContent('The example above stays the one shown on the flashcard.');
  });
});

describe('a word’s related words', () => {
  const section = async () =>
    (await within(await screen.findByRole('dialog')).findByRole('heading', { name: 'Related words' })).closest('section')!;

  it('lists links by kind, from whichever end they were made', async () => {
    await open(`/bank?word=${pageId(1)}`, {
      library: {
        relations: [
          relation(1, pageId(1), pageId(2), 'synonym'),
          relation(2, pageId(3), pageId(1), 'antonym'),
          relation(3, pageId(2), pageId(4), 'related'),
        ],
      },
    });
    const items = within(await section()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Synonym:largeRemove', 'Antonym:tinyRemove']);
  });

  it('opens the related word’s own details when it is chosen', async () => {
    const { user } = await open(`/bank?word=${pageId(1)}`, {
      library: { relations: [relation(1, pageId(1), pageId(2))] },
    });
    await user.click(within(await section()).getByRole('button', { name: 'large' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('word')).toBe(pageId(2)));
    expect(await within(await screen.findByRole('dialog')).findByRole('heading', { name: 'large' })).toBeInTheDocument();
    // The same link, seen from the other word.
    expect(within(await section()).getByRole('button', { name: 'big' })).toBeInTheDocument();
  });

  it('links to a word already in the vocabulary, with a stated kind', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`);
    const relations = within(await section());
    await user.selectOptions(relations.getByLabelText('Kind of link'), 'antonym');
    await user.type(relations.getByLabelText('Word to link'), ' Tiny ');
    await user.click(relations.getByRole('button', { name: 'Link words' }));
    await waitFor(() => expect(api.addRelation).toHaveBeenCalledWith(pageId(1), pageId(3), 'antonym'));
    expect(await relations.findByRole('button', { name: 'tiny' })).toBeInTheDocument();
    expect(relations.getByLabelText('Word to link')).toHaveValue('');
  });

  it('will not link to a word that is not in the vocabulary, and creates nothing', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`);
    const relations = within(await section());
    await user.type(relations.getByLabelText('Word to link'), 'enormous');
    await user.click(relations.getByRole('button', { name: 'Link words' }));
    expect(await relations.findByRole('alert')).toHaveTextContent('“enormous” is not in your vocabulary. Add it first, then link it.');
    expect(api.addRelation).not.toHaveBeenCalled();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('cannot link a word to itself', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`);
    const relations = within(await section());
    await user.type(relations.getByLabelText('Word to link'), 'big');
    await user.click(relations.getByRole('button', { name: 'Link words' }));
    expect(await relations.findByRole('alert')).toBeInTheDocument();
    expect(api.addRelation).not.toHaveBeenCalled();
  });

  it('removes a link without touching either word', async () => {
    const { api, user } = await open(`/bank?word=${pageId(1)}`, {
      library: { relations: [relation(1, pageId(1), pageId(2))] },
    });
    const relations = within(await section());
    await user.click(relations.getByRole('button', { name: 'Remove the link to large' }));
    await waitFor(() => expect(api.deleteRelation).toHaveBeenCalledWith(relation(1, pageId(1), pageId(2)).id));
    await waitFor(() => expect(relations.queryByRole('button', { name: 'large' })).not.toBeInTheDocument());
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.deleteEntry).not.toHaveBeenCalled();
  });

  it('starts with none: the app links nothing on its own', async () => {
    await open(`/bank?word=${pageId(1)}`);
    expect(await section()).toHaveTextContent('None yet. Words are only ever linked by you.');
  });
});

describe('a collection as a filter', () => {
  it('narrows the vocabulary bank to its words', async () => {
    await open(`/bank?collection=${EXAM.id}`, { library: { collections: [EXAM, BOOKS] } });
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2));
    expect(within(table).getByRole('button', { name: 'big' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'tiny' })).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'large' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Collection')).toHaveValue(EXAM.id);
    expect(main().getByRole('status')).toHaveTextContent('(filtered from 4)');
  });

  it('can be chosen, combined with the other filters, and cleared', async () => {
    const { user } = await open('/bank', { library: { collections: [EXAM, BOOKS] } });
    await screen.findByRole('table');
    await user.selectOptions(await screen.findByLabelText('Collection'), EXAM.id);
    expect(window.location.search).toBe(`?collection=${EXAM.id}`);

    await user.type(screen.getByRole('searchbox'), 'tiny');
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row').slice(1)).toHaveLength(1));
    expect(new URLSearchParams(window.location.search).get('collection')).toBe(EXAM.id);

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(window.location.search).toBe('');
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row').slice(1)).toHaveLength(4));
  });

  it('is not offered when there are no collections', async () => {
    await open('/bank');
    await screen.findByRole('table');
    expect(screen.queryByLabelText('Collection')).not.toBeInTheDocument();
  });

  it('narrows a review to the collection’s due words and says so', async () => {
    const { api } = await open(`/review?collection=${EXAM.id}`, {
      cards: [card(1)],
      library: { collections: [EXAM] },
      queue: { collection: { id: EXAM.id, name: 'Exam' } },
    });
    await screen.findByTestId('flashcard');
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null, collection: EXAM.id });
    expect(screen.getByText(/Collection “Exam” only, from those due now\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Cards to review')).toHaveValue(`collection:${EXAM.id}`));
  });

  it('can be picked from the review chooser, and left for everything due', async () => {
    const { api, user } = await open('/review', { cards: [card(1)], library: { collections: [EXAM, BOOKS] } });
    await screen.findByTestId('flashcard');
    const chooser = screen.getByLabelText('Cards to review');
    await waitFor(() => expect(within(chooser).getByRole('option', { name: 'Books' })).toBeInTheDocument());
    await user.selectOptions(chooser, `collection:${BOOKS.id}`);
    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null, collection: BOOKS.id }));
    expect(window.location.search).toBe(`?collection=${BOOKS.id}`);

    await user.selectOptions(screen.getByLabelText('Cards to review'), '');
    await waitFor(() => expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null }));
    expect(window.location.search).toBe('');
  });

  it('explains an empty collection review without claiming nothing at all is due', async () => {
    await open(`/review?collection=${EXAM.id}`, { cards: [], queue: { collection: { id: EXAM.id, name: 'Exam' } } });
    expect(await screen.findByRole('heading', { name: 'Nothing in this collection is due' })).toBeInTheDocument();
    expect(screen.getByText(/None of the words in “Exam” is due for review right now\./)).toBeInTheDocument();
  });

  it('ignores a collection id in the address that is not an id', async () => {
    const { api } = await open('/review?collection=everything', { cards: [card(1)] });
    await screen.findByTestId('flashcard');
    expect(api.fetchQueue).toHaveBeenLastCalledWith({ focus: null });
  });

  it('supplies the words for a practice session, due or not', async () => {
    await open(`/practice?collection=${EXAM.id}&mode=typing`, { library: { collections: [EXAM, BOOKS] } });
    await main().findByRole('heading', { name: 'Start a practice session' });
    await waitFor(() => expect(main().getByLabelText('Which words')).toHaveValue(`collection:${EXAM.id}`));
    // "tiny" is not due, and is practised all the same.
    await waitFor(() => expect(main().getByText(/can be used for typing/)).toHaveTextContent('2 of 2 words'));
  });
});

describe('the library store', () => {
  const loaded = (overrides: Partial<{ collections: Collection[]; examples: ExtraExample[]; relations: Relation[] }> = {}) => ({
    available: true,
    collections: [],
    examples: [],
    relations: [],
    ...overrides,
  });

  it('loads once however many screens ask, and again only after a failure', async () => {
    let calls = 0;
    const store = createLibraryStore({
      fetchLibrary: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError('network', 'Could not reach the server.');
        return loaded({ collections: [EXAM] });
      },
    });
    store.ensureLoaded();
    store.ensureLoaded();
    await act(async () => {});
    expect(store.getState()).toMatchObject({ status: 'error', error: 'Could not reach the server.' });
    expect(calls).toBe(1);

    store.ensureLoaded();
    await act(async () => {});
    expect(store.getState()).toMatchObject({ status: 'ready', available: true, collections: [EXAM] });
    store.ensureLoaded();
    await act(async () => {});
    expect(calls).toBe(2);
  });

  it('keeps collections in name order as they are added and renamed', async () => {
    const store = createLibraryStore({ fetchLibrary: async () => loaded({ collections: [EXAM] }) });
    await store.reload();
    store.putCollection(BOOKS);
    expect(store.getState().collections.map((item) => item.name)).toEqual(['Books', 'Exam']);
    store.putCollection({ ...BOOKS, name: 'Zoology' });
    expect(store.getState().collections.map((item) => item.name)).toEqual(['Exam', 'Zoology']);
    store.removeCollection(EXAM.id);
    expect(store.getState().collections.map((item) => item.name)).toEqual(['Zoology']);
  });

  it('lets only one example of a word be preferred, as the server does', async () => {
    const other = example(3, { vocabularyId: pageId(2), preferred: true });
    const store = createLibraryStore({
      fetchLibrary: async () => loaded({ examples: [example(1, { preferred: true }), example(2), other] }),
    });
    await store.reload();
    store.putExample({ ...example(2), preferred: true });
    const preferred = store.getState().examples.filter((item) => item.preferred).map((item) => item.id);
    expect(preferred.sort()).toEqual([example(2).id, other.id].sort());
  });

  it('adds and removes links without duplicating one it already holds', async () => {
    const link = relation(1, pageId(1), pageId(2));
    const store = createLibraryStore({ fetchLibrary: async () => loaded({ relations: [link] }) });
    await store.reload();
    store.putRelation(link);
    expect(store.getState().relations).toEqual([link]);
    store.removeRelation(link.id);
    expect(store.getState().relations).toEqual([]);
  });
});
