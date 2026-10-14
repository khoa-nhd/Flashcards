// @vitest-environment jsdom
/**
 * The word family panel: the timeline of what is already linked, the AI's
 * draft the reader reviews before anything is created or pointed at a root,
 * and the example sentences suggested with the word's saved collocations.
 * Every write stays an ordinary one — createEntry, updateEntry({ rootId }),
 * addExample — so nothing here can touch a word's content or its schedule.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VocabularyEntry } from '../../shared/api.js';
import { NO_CAPABILITIES } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry } from '../helpers/fake-api.js';
import { pageId } from '../helpers/fixtures.js';

/** The family capability is on, as in a store whose migration has reached version 11. */
const withRoots = { capabilities: { ...NO_CAPABILITIES, roots: true } };

const DECIDE = entry(1, { word: 'decide', meaning: 'quyết định', rootId: null });
const DECISION = entry(2, { word: 'decision', meaning: 'sự quyết định', rootId: pageId(1) });
const DECISIVE = entry(3, { word: 'decisive', meaning: 'quyết đoán', rootId: pageId(2) });

async function openWordPanel(
  options: { entries: VocabularyEntry[]; focus?: string; list?: Record<string, unknown>; library?: Record<string, unknown> } = {
    entries: [DECIDE, DECISION, DECISIVE],
  },
) {
  window.history.replaceState(null, '', '/bank');
  const fake = createFakeApi({
    entries: options.entries,
    list: options.list ?? withRoots,
    library: options.library,
  });
  render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await waitFor(() => expect(fake.api.fetchVocabulary).toHaveBeenCalled());
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: options.focus ?? DECISION.word }));
  const panel = await screen.findByRole('dialog');
  return { ...fake, user, panel };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the family timeline', () => {
  it('shows the root above the word and its members below, and opens each one', async () => {
    const { user, panel } = await openWordPanel();
    expect(within(panel).getByRole('heading', { name: 'Word family' })).toBeInTheDocument();
    // Root → the word on screen → its member, each of the others a button.
    await user.click(within(panel).getByRole('button', { name: 'decide' }));
    expect(window.location.search).toContain(pageId(1));
  });

  it('starts a builder for a word with no family yet, with no timeline', async () => {
    const alone = await openWordPanel({ entries: [DECIDE], focus: 'decide' });
    expect(within(alone.panel).queryByRole('heading', { name: 'Word family' })).not.toBeInTheDocument();
    expect(within(alone.panel).getByRole('button', { name: 'Build the word family (AI)' })).toBeInTheDocument();
  });

  it('stays away entirely on a store whose migration predates the column', async () => {
    const oldStore = await openWordPanel({ entries: [DECISION], list: {} });
    expect(within(oldStore.panel).queryByRole('heading', { name: 'Word family' })).not.toBeInTheDocument();
    expect(within(oldStore.panel).queryByRole('button', { name: 'Build the word family (AI)' })).not.toBeInTheDocument();
  });
});

describe('building the family', () => {
  it('reviews the draft, keeps the unticked member out, and points the rest at the root', async () => {
    const { api, user, panel } = await openWordPanel({ entries: [DECISION] });
    api.wordFamily.mockResolvedValueOnce({
      family: [
        { word: 'decide', gloss: 'quyết định', root: true },
        { word: 'decision', gloss: 'sự quyết định', root: false },
        { word: 'decisive', gloss: 'quyết đoán', root: false },
      ],
    });

    await user.click(within(panel).getByRole('button', { name: 'Build the word family (AI)' }));
    // Three rows, all ticked; the root's tick is fixed; only the word on screen is already in the bank.
    expect(await within(panel).findByRole('checkbox', { name: 'Keep decide in the family' })).toBeChecked();
    expect(within(panel).getByRole('checkbox', { name: 'Keep decision in the family' })).toBeChecked();
    expect(within(panel).getByText('in your bank')).toBeInTheDocument();
    expect(within(panel).getAllByText('new')).toHaveLength(2);

    await user.click(within(panel).getByRole('checkbox', { name: 'Keep decisive in the family' }));
    await user.click(within(panel).getByRole('button', { name: 'Save the family' }));

    // The missing root is created; the unticked member never is.
    expect(api.createEntry).toHaveBeenCalledTimes(1);
    expect(api.createEntry.mock.calls[0]?.[0]).toMatchObject({ word: 'decide', meaning: 'quyết định' });
    const created = await api.createEntry.mock.results[0]!.value;
    // The new root is a root of its own from its birth; the word on screen points at it.
    expect(api.updateEntry).toHaveBeenCalledTimes(1);
    expect(api.updateEntry).toHaveBeenCalledWith(pageId(2), { rootId: created.id });
    expect(await within(panel).findByRole('status')).toHaveTextContent('1 added, 1 linked.');
  });

  it('discards the draft without writing anything', async () => {
    const { api, user, panel } = await openWordPanel({ entries: [DECISION] });
    api.wordFamily.mockResolvedValueOnce({ family: [{ word: 'decision', gloss: null, root: true }] });
    await user.click(within(panel).getByRole('button', { name: 'Build the word family (AI)' }));
    await user.click(await within(panel).findByRole('button', { name: 'Discard' }));
    expect(within(panel).queryByRole('button', { name: 'Save the family' })).not.toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();
    expect(api.updateEntry).not.toHaveBeenCalled();
  });
});

describe('example sentences suggested for the word', () => {
  it('carries the saved collocations and saves the checked sentences as examples', async () => {
    const { api, user, panel } = await openWordPanel({
      entries: [DECISION, entry(4, { word: 'make a decision' })],
      library: { relations: [{ id: 'rel-1', kind: 'collocation', a: pageId(2), b: pageId(4) }] },
    });
    api.suggestExamples.mockResolvedValueOnce({
      examples: [
        { sentence: 'She made the final decision.', uses: 'make a decision' },
        { sentence: 'A decision was reached.', uses: null },
      ],
    });

    // Before the request, the reader is told what the sentences will show.
    expect(within(panel).getByText(/will show these in use: make a decision/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Suggest example sentences (AI)' }));
    expect(api.suggestExamples).toHaveBeenCalledWith(
      expect.objectContaining({ word: 'decision', collocations: ['make a decision'] }),
    );

    // Two drafts, the first naming the collocation it uses.
    expect(await within(panel).findAllByRole('checkbox', { name: /^Save the suggested sentence/ })).toHaveLength(2);
    expect(within(panel).getByText('Uses: make a decision')).toBeInTheDocument();

    // Untick one, edit the other, save: only the checked one reaches the ordinary path.
    await user.click(within(panel).getAllByRole('checkbox', { name: /^Save the suggested sentence/ })[1]!);
    const fields = within(panel).getAllByLabelText('Suggested example sentence');
    await user.clear(fields[0]!);
    await user.type(fields[0]!, 'Her decision was final.');
    await user.click(within(panel).getByRole('button', { name: 'Save the checked sentences' }));

    expect(api.addExample).toHaveBeenCalledTimes(1);
    expect(api.addExample).toHaveBeenCalledWith(pageId(2), { sentence: 'Her decision was final.', source: 'AI suggestion' });
    expect(await within(panel).findByRole('status')).toHaveTextContent('1 sentence saved.');
  });
});
