// @vitest-environment jsdom
/**
 * The vocabulary maps page as the learner meets it: the list with its two
 * ways in (drawn by hand, drafted by the model), one map opened with its
 * drawing and its list twin, a suggestion kept visibly apart from a word
 * until the one press that saves it, the AI preview that adds nothing until
 * it is added on purpose, every map type reading its own way — a collocation
 * as a table, a scenario as an order, a word family as a rooted tree — and a
 * read-only store that can be looked at but not touched. Nothing here can
 * reach a review queue: the map routes never ask for one.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAP_EDGE_KINDS_BY_TYPE,
  MAP_EDGE_LABELS,
  VOCAB_MAP_TYPE_LABELS,
  type CreatableMapType,
  type VocabMapDocument,
  type VocabMapEdge,
  type VocabMapNode,
} from '../../shared/vocab-map.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';
import { pageId } from '../helpers/fixtures.js';

const WORDS = [
  entry(1, { word: 'candid', meaning: 'thẳng thắn' }),
  entry(2, { word: 'frank', meaning: 'chân thật' }),
  entry(3, { word: 'decide', meaning: 'quyết định' }),
  entry(4, { word: 'decision', meaning: 'sự lựa chọn' }),
  entry(5, { word: 'lone', meaning: 'cô đơn' }),
];

const STAMP = '2026-10-01T00:00:00.000Z';

const savedNode = (id: string, vocabularyId: string, extra: Partial<VocabMapNode> = {}): VocabMapNode => ({
  id,
  kind: 'saved',
  vocabularyId,
  senseId: null,
  label: null,
  note: '',
  group: null,
  step: null,
  x: null,
  y: null,
  word: null,
  sense: null,
  ...extra,
});

const candidateNode = (id: string, label: string, extra: Partial<VocabMapNode> = {}): VocabMapNode => ({
  id,
  kind: 'candidate',
  vocabularyId: null,
  senseId: null,
  label,
  note: '',
  group: null,
  step: null,
  x: null,
  y: null,
  word: null,
  sense: null,
  ...extra,
});

const edgeOf = (
  id: string,
  fromNodeId: string,
  toNodeId: string,
  kind: VocabMapEdge['kind'],
  extra: Partial<VocabMapEdge> = {},
): VocabMapEdge => ({ id, fromNodeId, toNodeId, kind, pattern: '', note: '', ...extra });

function makeDoc(fields: Partial<VocabMapDocument> & { type: VocabMapDocument['type'] }): VocabMapDocument {
  const nodes = fields.nodes ?? [];
  const edges = fields.edges ?? [];
  return {
    id: pageId(801),
    title: 'A map',
    description: '',
    revision: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...fields,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
  };
}

/** The semantic map most tests open: one saved word, one suggestion, one link. */
const SEMANTIC = makeDoc({
  id: pageId(801),
  type: 'semantic',
  title: 'Meanings of candid',
  nodes: [savedNode('n1', pageId(1)), candidateNode('n2', 'forthright')],
  edges: [edgeOf('e1', 'n1', 'n2', 'synonym')],
});

async function open(path: string, options: FakeApiOptions = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: WORDS, ...options });
  const view = render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup(), ...view };
}

/** The page's own area: the shell's top bar carries a heading of its own outside it. */
const main = () => within(screen.getByRole('main'));

/** The list-of-everything section, re-queried after any reload. */
const everythingList = () =>
  screen.getByRole('heading', { name: 'Everything on this map' }).closest('section') as HTMLElement;

/** The experience panel under its "How this map reads" heading. */
const experience = (type: CreatableMapType) =>
  screen
    .getByRole('heading', { name: `How this map reads: ${VOCAB_MAP_TYPE_LABELS[type].toLowerCase()}` })
    .closest('div') as HTMLElement;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the list and the two ways to start', () => {
  it('invites the first map with its eight experiences and offers a start for each of the seven kinds', async () => {
    const { user } = await open('/maps', { maps: [] });
    expect(main().getByRole('heading', { name: 'Vocabulary maps' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Draw your first map' })).toBeInTheDocument();
    expect(screen.getByText(/see everything you already have in the personal map/)).toBeInTheDocument();
    expect(screen.getByText(/stays a suggestion until you save it/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New map' }));
    expect(screen.getByRole('heading', { name: 'Start a new map' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(7);
    expect(screen.getByRole('radio', { name: /Word family/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Communicative function/ })).toBeInTheDocument();
    // The personal map is drawn live; it is not something one creates.
    expect(screen.queryByRole('radio', { name: /Personal knowledge/ })).not.toBeInTheDocument();
    // Nothing can be created before it is named.
    expect(screen.getByRole('button', { name: 'Create map' })).toBeDisabled();
  });

  it('lists every map with its kind and figures, and opens the one pressed', async () => {
    const PAIRS = makeDoc({ id: pageId(802), type: 'collocation', title: 'Everyday pairs' });
    const { user } = await open('/maps', { maps: [SEMANTIC, PAIRS] });

    const card = await screen.findByRole('button', { name: /Meanings of candid/ });
    expect(card).toHaveTextContent('Semantic relationships');
    expect(card).toHaveTextContent('2 items · 1 relationship');
    const other = screen.getByRole('button', { name: /Everyday pairs/ });
    expect(other).toHaveTextContent('Collocations');
    expect(other).toHaveTextContent('0 items · 0 relationships');

    await user.click(card);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('map')).toBe(SEMANTIC.id));
    expect(await screen.findByRole('heading', { name: 'Meanings of candid' })).toBeInTheDocument();
    expect(screen.getByText(/Semantic relationships — Synonyms, antonyms/)).toBeInTheDocument();
  });

  it('creates a hand-drawn map of the chosen kind and opens it', async () => {
    const { user, api } = await open('/maps', { maps: [] });
    await user.click(screen.getByRole('button', { name: 'New map' }));
    await user.click(screen.getByRole('radio', { name: /Collocations/ }));
    await user.type(screen.getByLabelText(/^Title/), 'Everyday pairs');
    await user.click(screen.getByRole('button', { name: 'Create map' }));

    await waitFor(() => expect(api.createMap).toHaveBeenCalledTimes(1));
    expect(api.createMap).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'collocation', title: 'Everyday pairs', requestId: expect.any(String) }),
    );
    expect(await screen.findByRole('heading', { name: 'Everyday pairs' })).toBeInTheDocument();
    expect(screen.getByText(/Collocations — Words that naturally go together/)).toBeInTheDocument();
  });

  it('drafts a map from a word: the seed is saved, the rest arrives as suggestions, no word is created', async () => {
    const { user, api, store } = await open('/maps', { maps: [] });
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    expect(screen.getByRole('heading', { name: 'Draft a map with AI' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /A word of mine/ }));
    await user.type(screen.getByLabelText('Search your vocabulary for the word to draft from'), 'candid');
    await user.click(screen.getByRole('button', { name: 'Draft from this' }));
    await user.selectOptions(screen.getByLabelText('What kind of map?'), 'semantic');
    const wordsBefore = store.length;
    await user.click(screen.getByRole('button', { name: 'Draft the map' }));

    await waitFor(() => expect(api.generateMap).toHaveBeenCalledTimes(1));
    expect(api.generateMap).toHaveBeenCalledWith({
      type: 'semantic',
      requestId: expect.any(String),
      vocabularyId: pageId(1),
    });
    // The seed names the map, the seed lands saved, the rest is a suggestion.
    expect(await screen.findByRole('heading', { name: 'candid' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: /Map drawing: 2 items/ })).toBeInTheDocument();
    const list = everythingList();
    expect(within(list).getByRole('button', { name: 'candid' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'suggested-word, suggestion' })).toBeInTheDocument();
    expect(within(list).getAllByText('saved word')).toHaveLength(1);
    // Drafting a map creates a map, never a word.
    expect(store).toHaveLength(wordsBefore);
  });

  it('says so plainly when the model cannot be asked', async () => {
    const { user, api } = await open('/maps', { maps: [] });
    api.generateMap.mockRejectedValueOnce(
      new ApiError('not_supported', 'AI map drafting is not switched on for this account.', 409),
    );
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await user.type(screen.getByLabelText('The topic'), 'polite refusals');
    await user.click(screen.getByRole('button', { name: 'Draft the map' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('AI map drafting is not switched on for this account.');
    // Nothing was made, and the reader is still where they were.
    expect(main().getByRole('heading', { name: 'Vocabulary maps' })).toBeInTheDocument();
    expect(api.generateMap).toHaveBeenCalledTimes(1);
  });
});

describe('a map opened: a word and a suggestion are never confused', () => {
  it('draws both kinds of item and repeats them in a list that says which is which', async () => {
    await open(`/maps?map=${SEMANTIC.id}`, { maps: [SEMANTIC] });
    const canvas = await screen.findByRole('group', { name: /Map drawing: 2 items/ });
    expect(
      within(canvas)
        .getAllByRole('button')
        .map((node) => node.getAttribute('aria-label')),
    ).toEqual(['candid', 'forthright (suggestion, not a saved word)']);

    const list = everythingList();
    expect(within(list).getByRole('button', { name: 'candid' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'forthright, suggestion' })).toBeInTheDocument();
    expect(list).toHaveTextContent('saved word');
    expect(list).toHaveTextContent('suggestion');
  });

  it('explains the line, then saves a suggestion with the one press that creates a word, keeping its links', async () => {
    const { user, api, store } = await open(`/maps?map=${SEMANTIC.id}`, { maps: [SEMANTIC] });
    await screen.findByRole('group', { name: /Map drawing: 2 items/ });
    const wordsBefore = store.length;

    await user.click(within(everythingList()).getByRole('button', { name: 'forthright, suggestion' }));
    expect(screen.getByText(/is a suggestion on this map, not a word/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save as a word' }));
    await waitFor(() =>
      expect(api.saveCandidate).toHaveBeenCalledWith(SEMANTIC.id, 'n2', expect.objectContaining({ requestId: expect.any(String) })),
    );
    // Exactly one word, from the one button that does that; the list stops calling it a suggestion.
    await waitFor(() => expect(store).toHaveLength(wordsBefore + 1));
    await waitFor(() => expect(within(everythingList()).getAllByText('saved word')).toHaveLength(2));
    expect(within(everythingList()).queryByRole('button', { name: 'forthright, suggestion' })).not.toBeInTheDocument();
    // The relationship it was part of survives the promotion.
    expect(screen.getByRole('group', { name: /Map drawing: 2 items/ })).toBeInTheDocument();
    const relationships = screen.getByRole('heading', { name: 'Relationships' }).closest('div') as HTMLElement;
    expect(relationships).toHaveTextContent('Synonym of: candid → forthright');
  });

  it('places a word from the vocabulary on the map without creating anything', async () => {
    const { user, api, store } = await open(`/maps?map=${SEMANTIC.id}`, { maps: [SEMANTIC] });
    await screen.findByRole('group', { name: /Map drawing: 2 items/ });
    const wordsBefore = store.length;

    await user.type(screen.getByLabelText('Search your vocabulary to add to the map'), 'frank');
    const add = await screen.findByRole('button', { name: 'Add' });
    await user.click(add);

    await waitFor(() =>
      expect(api.addNode).toHaveBeenCalledWith(SEMANTIC.id, { kind: 'saved', vocabularyId: pageId(2) }),
    );
    await waitFor(() => expect(screen.getByRole('group', { name: /Map drawing: 3 items/ })).toBeInTheDocument());
    expect(store).toHaveLength(wordsBefore);
    expect(within(everythingList()).getByRole('button', { name: 'frank' })).toBeInTheDocument();
  });

  it('offers only its type’s kinds in the connect editor, and no pattern field for kinds that carry none', async () => {
    await open(`/maps?map=${SEMANTIC.id}`, { maps: [SEMANTIC] });
    await screen.findByRole('group', { name: /Map drawing/ });
    const form = screen.getByRole('heading', { name: 'Connect two items' }).closest('form') as HTMLElement;
    const [, relationship] = within(form).getAllByRole('combobox');
    expect(
      within(relationship as HTMLElement)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(MAP_EDGE_KINDS_BY_TYPE.semantic.map((kind) => MAP_EDGE_LABELS[kind]));
    expect(within(form).queryByText(/The combination/)).not.toBeInTheDocument();
    expect(within(form).getByText(/^A note/)).toBeInTheDocument();
  });

  it('asks a nuance map for the difference itself, and refuses none of its two kinds', async () => {
    const NUANCE = makeDoc({
      id: pageId(803),
      type: 'nuance',
      title: 'Candid vs frank',
      nodes: [savedNode('n1', pageId(1)), savedNode('n2', pageId(2))],
    });
    await open(`/maps?map=${NUANCE.id}`, { maps: [NUANCE] });
    await screen.findByRole('group', { name: /Map drawing/ });
    const form = screen.getByRole('heading', { name: 'Connect two items' }).closest('form') as HTMLElement;
    const [, relationship] = within(form).getAllByRole('combobox');
    expect(
      within(relationship as HTMLElement)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(MAP_EDGE_KINDS_BY_TYPE.nuance.map((kind) => MAP_EDGE_LABELS[kind]));
    // The difference is the point of a contrast, so it is asked for, not optional in spirit.
    expect(within(form).getByText(/^The difference/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Add relationship' })).toBeInTheDocument();
  });

  it('asks a collocation map for the combination each kind carries', async () => {
    const PAIRS = makeDoc({
      id: pageId(804),
      type: 'collocation',
      title: 'Combinations',
      nodes: [savedNode('n1', pageId(1)), savedNode('n2', pageId(2))],
    });
    await open(`/maps?map=${PAIRS.id}`, { maps: [PAIRS] });
    await screen.findByRole('group', { name: /Map drawing/ });
    const form = screen.getByRole('heading', { name: 'Connect two items' }).closest('form') as HTMLElement;
    expect(within(form).getByText(/The combination/)).toBeInTheDocument();
    const [, relationship] = within(form).getAllByRole('combobox');
    expect(
      within(relationship as HTMLElement)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(MAP_EDGE_KINDS_BY_TYPE.collocation.map((kind) => MAP_EDGE_LABELS[kind]));
  });
});

describe('every kind of map reads its own way', () => {
  it('semantic: meanings with the relationships that hold for them, then every word', async () => {
    const doc = makeDoc({
      id: pageId(805),
      type: 'semantic',
      title: 'One word, two meanings',
      nodes: [
        savedNode('n1', pageId(1), { senseId: 's1', sense: { id: 's1', meaning: 'thẳng thắn' } }),
        candidateNode('n2', 'forthright'),
      ],
      edges: [edgeOf('e1', 'n1', 'n2', 'synonym')],
    });
    await open(`/maps?map=${doc.id}`, { maps: [doc] });
    expect(await screen.findByRole('heading', { name: 'Meanings on this map' })).toBeInTheDocument();
    expect(screen.getByText(/holds for that meaning, not for every meaning/)).toBeInTheDocument();
    const panel = experience('semantic');
    expect(within(panel).getByText(/thẳng thắn/)).toBeInTheDocument();
    expect(panel).toHaveTextContent('Synonym of: candid → forthright');
    expect(within(panel).getByRole('heading', { name: 'Words on this map' })).toBeInTheDocument();
  });

  it('word family: the root with what was formed from it, and the words standing alone', async () => {
    const doc = makeDoc({
      id: pageId(806),
      type: 'word_family',
      title: 'The decide family',
      nodes: [savedNode('n1', pageId(3)), savedNode('n2', pageId(4)), savedNode('n3', pageId(5))],
      // decision → decide: the derived word at the start, the root at the end.
      edges: [edgeOf('e1', 'n2', 'n1', 'derivation')],
    });
    await open(`/maps?map=${doc.id}`, { maps: [doc] });
    const panel = await screen.findByText(/Every root below is a word other words were formed from/);
    const section = panel.closest('div') as HTMLElement;
    expect(section).toHaveTextContent('Root: decide');
    expect(section).toHaveTextContent('└─ Derived from: decision');
    expect(within(section).getByRole('heading', { name: 'On their own' })).toBeInTheDocument();
    expect(within(section).getByText('lone')).toBeInTheDocument();
    // The derived word is not presented as a root of anything.
    expect(within(section).queryByRole('heading', { name: 'Root: decision' })).not.toBeInTheDocument();
  });

  it('collocation: the combinations as a table with the combination itself', async () => {
    const doc = makeDoc({
      id: pageId(807),
      type: 'collocation',
      title: 'Natural pairs',
      nodes: [savedNode('n1', pageId(3)), savedNode('n2', pageId(4))],
      edges: [edgeOf('e1', 'n1', 'n2', 'verb_noun', { pattern: 'make a decision' })],
    });
    await open(`/maps?map=${doc.id}`, { maps: [doc] });
    const panel = experience('collocation');
    expect(panel).toHaveTextContent('Words that naturally go together');
    for (const column of ['Kind', 'Words', 'Combination', 'Note']) {
      expect(within(panel).getByRole('columnheader', { name: column })).toBeInTheDocument();
    }
    expect(within(panel).getByText('“make a decision”')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'decide' })).toBeInTheDocument();
  });

  it('thematic: topics as groups, their parts, and the links that cross them', async () => {
    const doc = makeDoc({
      id: pageId(808),
      type: 'thematic',
      title: 'Around the house',
      nodes: [
        savedNode('n1', pageId(3), { group: 'Daily routine' }),
        savedNode('n2', pageId(4), { group: 'Food' }),
      ],
      edges: [edgeOf('e1', 'n1', 'n2', 'subtopic')],
    });
    await open(`/maps?map=${doc.id}`, { maps: [doc] });
    const panel = experience('thematic');
    expect(panel).toHaveTextContent('Vocabulary grouped by topic');
    expect(within(panel).getByRole('heading', { name: 'Daily routine' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Food' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Topics and their parts' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Across topics' })).toBeInTheDocument();
  });

  it('nuance: two expressions side by side with the difference spelled between them', async () => {
    const doc = makeDoc({
      id: pageId(809),
      type: 'nuance',
      title: 'Candid and frank',
      nodes: [savedNode('n1', pageId(1)), savedNode('n2', pageId(2))],
      edges: [edgeOf('e1', 'n1', 'n2', 'contrast', { note: 'candid can sting; frank flatters itself as kind' })],
    });
    await open(`/maps?map=${doc.id}`, { maps: [doc] });
    const panel = experience('nuance');
    expect(panel).toHaveTextContent('Close expressions, side by side');
    expect(within(panel).getByText('differs in')).toBeInTheDocument();
    expect(within(panel).getByText('candid can sting; frank flatters itself as kind')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'candid' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'frank' })).toBeInTheDocument();
  });

  it('scenario: one situation in order, reorderable from the list, one kind of link', async () => {
    const doc = makeDoc({
      id: pageId(810),
      type: 'scenario',
      title: 'Ordering at a café',
      nodes: [candidateNode('s1', 'sit down', { step: 1 }), candidateNode('s2', 'order', { step: 2 })],
      edges: [edgeOf('e1', 's1', 's2', 'step')],
    });
    const { user, api } = await open(`/maps?map=${doc.id}`, { maps: [doc] });
    const panel = experience('scenario');
    expect(panel).toHaveTextContent('The situation in order, from the first step to the last');
    expect(within(panel).getByRole('heading', { name: 'The order of the steps' })).toBeInTheDocument();

    // One kind of link is accepted here: the step itself.
    const form = screen.getByRole('heading', { name: 'Connect two items' }).closest('form') as HTMLElement;
    const [, relationship] = within(form).getAllByRole('combobox');
    expect(
      within(relationship as HTMLElement)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Then']);

    // Reordering is a list action, not a drag: select a step, move it later.
    await user.click(within(everythingList()).getByRole('button', { name: 'sit down, suggestion' }));
    await user.click(screen.getByRole('button', { name: 'Move sit down later' }));
    await waitFor(() => expect(api.updateNode).toHaveBeenCalledWith(doc.id, 's1', { step: 2, ifMatch: 1 }));
  });

  it('communicative function: phrases by what the speaker is doing, with alternatives listed', async () => {
    const doc = makeDoc({
      id: pageId(811),
      type: 'function',
      title: 'Polite refusals',
      nodes: [
        savedNode('n1', pageId(1), { group: 'Refusing' }),
        savedNode('n2', pageId(2), { group: 'Refusing' }),
        savedNode('n3', pageId(5), { group: 'Excusing' }),
      ],
      edges: [edgeOf('e1', 'n1', 'n2', 'phrase_variant')],
    });
    await open(`/maps?map=${doc.id}`, { maps: [doc] });
    const panel = experience('function');
    expect(panel).toHaveTextContent('Phrases grouped by what the speaker wants to do');
    expect(within(panel).getByRole('heading', { name: 'Refusing' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Excusing' })).toBeInTheDocument();
    expect(within(panel).getByText(/also: frank/)).toBeInTheDocument();
  });

  it('personal: the library drawn live, with figures, and nothing here can edit it', async () => {
    const { user } = await open('/maps', {
      maps: [SEMANTIC],
      library: { collections: [{ id: pageId(901), name: 'Exam', wordIds: [pageId(1)] }] },
    });
    await user.click(await screen.findByRole('link', { name: 'Your vocabulary at a glance' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('personal'));

    expect(await screen.findByRole('heading', { name: 'Your vocabulary at a glance' })).toBeInTheDocument();
    expect(screen.getByText(/not a claim about what you have mastered/)).toBeInTheDocument();
    expect(screen.getByText('Words')).toBeInTheDocument();
    expect(screen.getByText('Relationships')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Saved relationships' })).toBeInTheDocument();
    // The personal map is drawn, not managed: no rename, delete or expansion.
    expect(screen.queryByRole('button', { name: 'Delete map' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand with AI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
  });
});

describe('the model proposes, the learner adds', () => {
  it('previews the expansion, adds nothing until pressed, and never makes a word', async () => {
    const { user, api, store } = await open(`/maps?map=${SEMANTIC.id}`, { maps: [SEMANTIC] });
    await screen.findByRole('group', { name: /Map drawing: 2 items/ });
    const wordsBefore = store.length;

    await user.click(screen.getByRole('button', { name: 'Expand with AI' }));
    await waitFor(() => expect(api.expandMap).toHaveBeenNthCalledWith(1, SEMANTIC.id, { apply: false }));
    const preview = await screen.findByRole('region', { name: 'AI suggestions preview' });
    expect(preview).toHaveTextContent('expanded-word');
    expect(preview).toHaveTextContent(/without “Save as a word”/);
    // A preview is not a change: the map still holds what it held.
    expect(screen.getByRole('group', { name: /Map drawing: 2 items/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add these to the map' }));
    await waitFor(() => expect(api.expandMap).toHaveBeenNthCalledWith(2, SEMANTIC.id, { apply: true, requestId: expect.any(String) }));
    await waitFor(() => expect(screen.getByRole('group', { name: /Map drawing: 3 items/ })).toBeInTheDocument());
    // The preview has done its work and closed; the arrival is a suggestion.
    expect(screen.queryByRole('region', { name: 'AI suggestions preview' })).not.toBeInTheDocument();
    expect(within(everythingList()).getByRole('button', { name: 'expanded-word, suggestion' })).toBeInTheDocument();
    expect(store).toHaveLength(wordsBefore);
  });
});

describe('housekeeping: rename, delete, and reading without writing', () => {
  it('renames a map and the new name is what the page carries', async () => {
    const { user, api } = await open(`/maps?map=${SEMANTIC.id}`, { maps: [SEMANTIC] });
    await screen.findByRole('group', { name: /Map drawing/ });

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const form = screen.getByRole('button', { name: 'Save' }).closest('form') as HTMLElement;
    const title = within(form).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Candid and its kin');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.updateMap).toHaveBeenCalledWith(SEMANTIC.id, {
        title: 'Candid and its kin',
        description: SEMANTIC.description,
        ifMatch: SEMANTIC.revision,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Candid and its kin' })).toBeInTheDocument();
  });

  it('deletes a map after saying every word stays, and the words indeed stay', async () => {
    const { user, api, store } = await open(`/maps?map=${SEMANTIC.id}`, { maps: [SEMANTIC] });
    await screen.findByRole('group', { name: /Map drawing/ });
    const wordsBefore = store.length;

    await user.click(screen.getByRole('button', { name: 'Delete map' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Every word on it stays in your vocabulary/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete map' }));

    await waitFor(() => expect(api.deleteMap).toHaveBeenCalledWith(SEMANTIC.id));
    expect(await screen.findByRole('heading', { name: 'Draw your first map' })).toBeInTheDocument();
    expect(store).toHaveLength(wordsBefore);
  });

  it('can be read when writing is off: no entry to create, nothing on the page that changes anything', async () => {
    const { user } = await open('/maps', { maps: [SEMANTIC], list: { writesEnabled: false } });
    expect(await screen.findByRole('button', { name: /Meanings of candid/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New map' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft with AI' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Meanings of candid/ }));
    expect(await screen.findByRole('group', { name: /Map drawing/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete map' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand with AI' })).not.toBeInTheDocument();
    expect(screen.getByText('Saving is switched off, so this map can be read but not changed.')).toBeInTheDocument();

    // A suggestion can be selected and read about, but not saved.
    await user.click(within(everythingList()).getByRole('button', { name: 'forthright, suggestion' }));
    expect(screen.queryByRole('button', { name: 'Save as a word' })).not.toBeInTheDocument();
  });

  it('touches no review machinery on the way through list, map and personal view', async () => {
    const { user, api } = await open('/maps', { maps: [SEMANTIC] });
    await user.click(await screen.findByRole('button', { name: /Meanings of candid/ }));
    await screen.findByRole('group', { name: /Map drawing/ });
    await user.click(screen.getByRole('button', { name: 'All maps' }));
    await main().findByRole('heading', { name: 'Vocabulary maps' });
    await user.click(screen.getByRole('link', { name: 'Your vocabulary at a glance' }));
    await screen.findByRole('heading', { name: 'Your vocabulary at a glance' });

    expect(api.fetchQueue).not.toHaveBeenCalled();
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(api.undoAction).not.toHaveBeenCalled();
  });
});
