// @vitest-environment jsdom
/**
 * The connection diagram in a word's detail, drawn as a mind map: one labelled
 * branch per reason (relation kind or collection) with the connected words
 * hanging off it, from the links and collections the account already keeps.
 * Nothing is inferred, and opening a word in the map opens it exactly as the
 * bank does.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Collection, Relation } from '../../shared/library.js';
import { App } from '../../src/App.js';
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

/** The diagram, as it appears under the other sections of the open word's detail. */
const diagram = async () =>
  (await within(await screen.findByRole('dialog')).findByRole('heading', { name: 'Connections' })).closest('section')!;

describe('the connection diagram', () => {
  it('draws one branch per reason, with a word that fits several under the first', async () => {
    await open(`/bank?word=${pageId(1)}`, {
      library: {
        relations: [relation(1, pageId(1), pageId(2), 'synonym')],
        collections: [collection(1, 'Exam', [pageId(1), pageId(2)]), collection(2, 'Books', [pageId(1), pageId(4)])],
      },
    });
    const section = await diagram();
    expect(within(section).getAllByRole('button').map((node) => node.getAttribute('aria-label'))).toEqual(['affect', 'large']);

    // "large" is a synonym and a collection-mate: one leaf on the Synonym branch, both reasons in the summary.
    expect(within(section).getAllByRole('button', { name: 'large' })).toHaveLength(1);
    expect(within(section).getByText('Synonym')).toBeInTheDocument();
    expect(within(section).getByText('Books')).toBeInTheDocument();
    // The same connections, in words, for a screen reader.
    expect(section).toHaveTextContent('Connections for big: affect (Books); large (Synonym, Exam).');
    // The word at the centre is the one already open.
    expect(within(section).getByText('big')).toBeInTheDocument();
  });

  it('says so in one line instead of drawing an empty circle', async () => {
    await open(`/bank?word=${pageId(1)}`);
    const section = await diagram();
    expect(section).toHaveTextContent("No connections yet — link words from this word's detail.");
    expect(section.querySelector('svg')).toBeNull();
    expect(within(section).queryAllByRole('button')).toHaveLength(0);
  });

  it('caps the map at thirty words and says how many are left out', async () => {
    const many = Array.from({ length: 33 }, (_, index) => entry(index + 1));
    await open(`/bank?word=${pageId(1)}`, {
      entries: many,
      library: { collections: [collection(1, 'Everything', many.map((item) => item.id))] },
    });
    const section = await diagram();
    expect(within(section).getAllByRole('button')).toHaveLength(30);
    expect(within(section).getByText('+2 more not shown.')).toBeInTheDocument();
    // The branch keeps its label even at this density — that is what makes it a map.
    expect(within(section).getByText('Everything')).toBeInTheDocument();
  });

  it('opens a connected word the same way the bank does', async () => {
    const { user } = await open(`/bank?word=${pageId(1)}`, {
      library: { relations: [relation(1, pageId(1), pageId(2))] },
    });
    const section = await diagram();
    await user.click(within(section).getByRole('button', { name: 'large' }));

    await waitFor(() => expect(new URLSearchParams(window.location.search).get('word')).toBe(pageId(2)));
    expect(window.history.state).toMatchObject({ wordPanel: true });
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByRole('heading', { name: 'large' })).toBeInTheDocument();
    // Seen from the other word, the link back is in the diagram too.
    expect(await within(await diagram()).findByRole('button', { name: 'big' })).toBeInTheDocument();
  });
});
