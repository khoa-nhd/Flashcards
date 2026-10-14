// @vitest-environment jsdom
/**
 * The topic map page: the whole vocabulary drawn three ways — the collections
 * the reader grouped it into, the families words share through their root, and
 * the saved relations as a network — switched between on one page. The drawing
 * never carries information the words in it do not, every word opens its panel
 * the way the bank opens it, a store that cannot keep part of the data says so
 * instead of drawing it wrong, and past the cap the picture says how much it
 * left out (with the whole thing repeated in words, for a screen reader).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES, type VocabularyEntry } from '../../shared/api.js';
import type { Collection, Relation } from '../../shared/library.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';
import { pageId } from '../helpers/fixtures.js';

const WORDS = [entry(1, { word: 'big' }), entry(2, { word: 'large' }), entry(3, { word: 'tiny' }), entry(4, { word: 'affect' })];

const collection = (n: number, name: string, wordIds: string[] = []): Collection => ({ id: pageId(900 + n), name, wordIds });
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

/** Switches to a view; each drawing is the region its own label names. */
const switchTo = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole('button', { name: label }));
  return label;
};

describe('the collections drawing', () => {
  it('draws each collection as an island, with the words in no collection under one plain island', async () => {
    await open('/map', { library: { collections: [collection(1, 'Exam', [pageId(1), pageId(2)])] } });
    const region = await screen.findByRole('region', { name: 'Collections map' });

    expect(region).toHaveTextContent('1 collection · 2 words grouped · 2 words without a collection');
    expect(within(region).getByText('Exam')).toBeInTheDocument();
    expect(within(region).getByText('No collection')).toBeInTheDocument();
    expect(within(region).getAllByRole('button').map((word) => word.getAttribute('aria-label'))).toEqual([
      'big',
      'large',
      'affect',
      'tiny',
    ]);
    // The same picture, in words, for a screen reader.
    expect(region).toHaveTextContent('Collections map: Exam — big, large; No collection — affect, tiny.');
  });

  it('opens a word the way the bank opens it', async () => {
    const { user } = await open('/map', { library: { collections: [collection(1, 'Exam', [pageId(1), pageId(2)])] } });
    const region = await screen.findByRole('region', { name: 'Collections map' });

    await user.click(within(region).getAllByRole('button', { name: 'large' })[0]!);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('word')).toBe(pageId(2)));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'large' })).toBeInTheDocument());
  });

  it('caps an island at twelve words and says how many are left out', async () => {
    const many = Array.from({ length: 20 }, (_, index) => entry(index + 1, { word: `word${index + 1}` }));
    await open('/map', {
      entries: many,
      library: { collections: [collection(1, 'Everything', many.map((item) => item.id))] },
    });
    const region = await screen.findByRole('region', { name: 'Collections map' });

    expect(region).toHaveTextContent('20 words grouped');
    expect(within(region).getAllByRole('button')).toHaveLength(12);
    expect(region).toHaveTextContent('+8 more not shown.');
  });

  it('reports a failed load and loads on Try again', async () => {
    window.history.replaceState(null, '', '/map');
    const { api } = createFakeApi({ entries: WORDS, library: { collections: [collection(1, 'Exam', [pageId(1)])] } });
    api.fetchLibrary.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    render(<App api={api} settings={createSettingsStore(null)} />);
    await screen.findAllByRole('navigation');

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Collections map' })).toBeInTheDocument();
  });

  it('explains when the database cannot keep collections yet', async () => {
    await open('/map', { library: { available: false } });
    expect(await screen.findByText(/Collections and relations can be kept once the database has its latest update/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Collections map' })).not.toBeInTheDocument();
  });
});

describe('the relations drawing', () => {
  it('draws the linked words as a network and counts every kind of link', async () => {
    const { user } = await open('/map', {
      library: { relations: [relation(1, pageId(1), pageId(2), 'synonym'), relation(2, pageId(1), pageId(3), 'antonym')] },
    });
    await screen.findByRole('region', { name: 'Collections map' });
    await switchTo(user, 'Relations');
    const region = await screen.findByRole('region', { name: 'Relations map' });

    expect(screen.getByRole('button', { name: 'Relations' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Collections' })).toHaveAttribute('aria-pressed', 'false');
    expect(region).toHaveTextContent('2 relations across 3 words (1 synonym, 1 antonym)');
    expect(within(region).getAllByRole('button').map((word) => word.getAttribute('aria-label'))).toEqual([
      'big',
      'large',
      'tiny',
    ]);
    expect(region).toHaveTextContent('Relations map: big — large (Synonym); big — tiny (Antonym).');
  });

  it('says so in one line instead of drawing an empty network', async () => {
    const { user } = await open('/map');
    await screen.findByRole('region', { name: 'Collections map' });
    await switchTo(user, 'Relations');

    expect(screen.getByText("No related words yet — link words from a word's detail.")).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Relations map' })).not.toBeInTheDocument();
  });
});

describe('the word families drawing', () => {
  const FAMILY: VocabularyEntry[] = [
    entry(1, { word: 'decide', rootId: null }),
    entry(2, { word: 'decision', rootId: pageId(1) }),
    entry(3, { word: 'decisive', rootId: pageId(1) }),
    entry(4, { word: 'lone', rootId: null }),
  ];
  /** The family capability is on, as in a store whose migration has reached version 11. */
  const withRoots = { capabilities: { ...NO_CAPABILITIES, roots: true } };

  it('draws the family under its root and counts the words outside one', async () => {
    const { user } = await open('/map', { entries: FAMILY, list: withRoots });
    await screen.findByRole('region', { name: 'Collections map' });
    await switchTo(user, 'Word families');
    const region = await screen.findByRole('region', { name: 'Word families map' });

    expect(region).toHaveTextContent('1 family · 1 word not in a family');
    expect(within(region).getByText('2 words')).toBeInTheDocument();
    // The root opens from the island title, before its members inside.
    expect(within(region).getAllByRole('button').map((word) => word.getAttribute('aria-label'))).toEqual([
      'decide',
      'decision',
      'decisive',
    ]);
    expect(region).toHaveTextContent('Word families map: decide — decision, decisive.');
  });

  it('opens the root from the island title', async () => {
    const { user } = await open('/map', { entries: FAMILY, list: withRoots });
    await screen.findByRole('region', { name: 'Collections map' });
    await switchTo(user, 'Word families');
    const region = await screen.findByRole('region', { name: 'Word families map' });

    await user.click(within(region).getAllByRole('button', { name: 'decide' })[0]!);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('word')).toBe(pageId(1)));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'decide' })).toBeInTheDocument());
  });

  it('points at the word panel when no family has been built yet', async () => {
    const { user } = await open('/map', { list: withRoots });
    await screen.findByRole('region', { name: 'Collections map' });
    await switchTo(user, 'Word families');

    expect(screen.getByText(/No word families yet — open a word and build its family from its panel\./)).toBeInTheDocument();
  });

  it('says so plainly where the store cannot keep families yet', async () => {
    const { user } = await open('/map');
    await screen.findByRole('region', { name: 'Collections map' });
    await switchTo(user, 'Word families');

    expect(screen.getByText(/Word families can be kept once the database has its latest update\./)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Word families map' })).not.toBeInTheDocument();
  });
});

describe('the page', () => {
  it('has its place in the navigation, named in the tab', async () => {
    await open('/map');
    expect(
      within(screen.getAllByRole('navigation', { name: 'Main' })[0]!).getByRole('link', { name: /^Topic map/ }),
    ).toBeInTheDocument();
    expect(document.title).toBe('Topic map · Vocabulary');
  });

  it('says so when there are no words to map yet', async () => {
    await open('/map', { entries: [] });
    expect(screen.getByText('There are no words to map yet.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Which map to draw' })).not.toBeInTheDocument();
  });
});
