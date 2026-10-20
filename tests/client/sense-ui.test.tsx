// @vitest-environment jsdom
/**
 * The sense editor in the word panel and the quick-add profile on the Add
 * page, against the in-memory API: what each button sends, and what comes
 * back onto the screen once the server has answered.
 *
 * The word form itself (legacy meaning/definition/example, schedule section,
 * validation, duplicate handling) is covered by vocabulary-pages.test.tsx.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Sense, VocabularyEntry } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry } from '../helpers/fake-api.js';
import { pageId } from '../helpers/fixtures.js';

const SENSES: Sense[] = [
  { id: 'sense-a', position: 0, meaning: 'nói dối', definition: 'to say what is not true', example: null, archived: false, version: 1 },
  { id: 'sense-b', position: 1, meaning: 'nằm', definition: null, example: null, archived: false, version: 2 },
  { id: 'sense-c', position: 2, meaning: 'nghỉ ngơi', definition: null, example: null, archived: true, version: 3 },
];

/** A fresh copy per test: the fake server mutates the senses it is given. */
const multiSenseWord = (): VocabularyEntry =>
  entry(1, {
    word: 'lie',
    meaning: 'nói dối',
    definition: 'to say what is not true',
    example: null,
    senses: SENSES.map((sense) => ({ ...sense })),
    sensesVersion: 7,
  });

const CANDID = entry(1, { word: 'candid', meaning: 'thẳng thắn' });

async function open(path: string, entries: VocabularyEntry[]) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries });
  const store = createSettingsStore(null);
  const view = render(<App api={fake.api} settings={store} />);
  await waitFor(() => expect(fake.api.fetchVocabulary).toHaveBeenCalled());
  return { ...fake, user: userEvent.setup(), ...view };
}

const openPanel = async () => {
  const opened = await open(`/bank?word=${pageId(1)}`, [multiSenseWord()]);
  const panel = await screen.findByRole('dialog');
  await waitFor(() => expect(opened.api.fetchEntry).toHaveBeenCalledWith(pageId(1)));
  return { ...opened, panel };
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the senses in the word panel', () => {
  it('lists the live senses and keeps the archived one behind its own summary', async () => {
    const { panel } = await openPanel();
    expect(await within(panel).findByRole('heading', { name: 'Senses (2)' })).toBeInTheDocument();
    expect(within(panel).getByText('Sense 1')).toBeInTheDocument();
    expect(within(panel).getByText('Sense 2')).toBeInTheDocument();
    expect(within(panel).getByText('Archived senses (1)')).toBeInTheDocument();
    // The first cannot move up, and the last cannot move down.
    expect(within(panel).getByRole('button', { name: 'Move sense 1 up' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Move sense 2 down' })).toBeDisabled();
  });

  it('adds a sense, and shows it once the server has', async () => {
    const { api, user, panel } = await openPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Add Sense' }));
    await user.type(within(panel).getByLabelText('Vietnamese meaning'), 'mới');
    await user.click(within(panel).getByRole('button', { name: 'Add Sense' }));

    expect(api.addSense).toHaveBeenCalledTimes(1);
    const [wordId, body] = api.addSense.mock.calls[0]!;
    expect(wordId).toBe(pageId(1));
    expect(body).toMatchObject({ meaning: 'mới', definition: null, example: null });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText('Added sense.')).toBeInTheDocument();
    expect(await within(panel).findByRole('heading', { name: 'Senses (3)' })).toBeInTheDocument();
    expect(within(panel).getByText('Sense 3')).toBeInTheDocument();
  });

  it('edits a sense against its version, and keeps the fields it was not given', async () => {
    const { api, user, panel } = await openPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Edit sense 1' }));
    const meaning = within(panel).getByLabelText('Vietnamese meaning');
    expect(meaning).toHaveValue('nói dối');

    await user.clear(meaning);
    await user.type(meaning, 'nói dối (sửa)');
    await user.click(within(panel).getByRole('button', { name: 'Update Sense' }));

    expect(api.updateEntrySense).toHaveBeenCalledWith('sense-a', {
      meaning: 'nói dối (sửa)',
      definition: 'to say what is not true',
      example: null,
      ifMatch: 1,
    });
    expect(await screen.findByText('Updated sense.')).toBeInTheDocument();
    expect(within(panel).getByText('nói dối (sửa)')).toBeInTheDocument();
  });

  it('says the sense changed elsewhere when an edit arrives too late, and writes nothing', async () => {
    const { api, user, panel } = await openPanel();
    api.updateEntrySense.mockRejectedValueOnce(
      new ApiError('conflict', 'This sense was modified by another request. Please reload and try again.', 409),
    );

    await user.click(await within(panel).findByRole('button', { name: 'Edit sense 1' }));
    await user.clear(within(panel).getByLabelText('Vietnamese meaning'));
    await user.type(within(panel).getByLabelText('Vietnamese meaning'), 'nói dối (sửa)');
    await user.click(within(panel).getByRole('button', { name: 'Update Sense' }));

    // A clear message, and the version the edit was made against.
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('This sense was modified elsewhere. Please reload and try again.');
    expect(api.updateEntrySense).toHaveBeenCalledTimes(1);
    expect(api.updateEntrySense).toHaveBeenCalledWith('sense-a', {
      meaning: 'nói dối (sửa)',
      definition: 'to say what is not true',
      example: null,
      ifMatch: 1,
    });
    // Nothing refreshed or replaced underneath: only the panel's own first read ran.
    expect(api.fetchEntry).toHaveBeenCalledTimes(1);

    // Closing the edit writes nothing: the editor is gone, the list is intact,
    // and the text that lost the race exists nowhere on screen.
    await user.click(within(panel).getByLabelText('Cancel'));
    expect(within(panel).queryByLabelText('Vietnamese meaning')).not.toBeInTheDocument();
    expect(within(panel).queryByText('nói dối (sửa)')).not.toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Senses (2)' })).toBeInTheDocument();
  });

  it('moves a sense down the order, swapping it with its neighbour', async () => {
    const { api, user, panel } = await openPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Move sense 1 down' }));

    expect(api.reorderSenses).toHaveBeenCalledWith(pageId(1), {
      senseIds: ['sense-b', 'sense-a'],
      ifMatch: 7,
    });
    expect(await screen.findByText('Senses reordered.')).toBeInTheDocument();
  });

  it('archives a sense without losing it', async () => {
    const { api, user, panel } = await openPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Archive sense 1' }));

    expect(api.archiveSense).toHaveBeenCalledWith('sense-a', { ifMatch: 1 });
    expect(await screen.findByText('Sense archived.')).toBeInTheDocument();
    expect(await within(panel).findByRole('heading', { name: 'Senses (1)' })).toBeInTheDocument();
    expect(within(panel).getByText('Archived senses (2)')).toBeInTheDocument();
  });

  it('restores an archived sense', async () => {
    const { api, user, panel } = await openPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Restore sense' }));

    expect(api.restoreSense).toHaveBeenCalledWith('sense-c', { ifMatch: 3 });
    expect(await screen.findByText('Sense restored.')).toBeInTheDocument();
    expect(await within(panel).findByRole('heading', { name: 'Senses (3)' })).toBeInTheDocument();
  });
});

describe('adding words: quick and full', () => {
  it('quick add sends only the word and the meaning', async () => {
    const { api, user } = await open('/add', [CANDID]);
    await user.click(await screen.findByLabelText('Quick add'));
    expect(screen.getByText('Quick add: word and meaning only. Press Enter to save.')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Word/), 'luminous');
    await user.type(screen.getByLabelText('Vietnamese meaning'), 'sáng chói');
    await user.click(screen.getByRole('button', { name: /Add word/ }));

    expect(api.createEntry).toHaveBeenCalledTimes(1);
    const input = api.createEntry.mock.calls[0]?.[0];
    expect(input).toMatchObject({ word: 'luminous', meaning: 'sáng chói' });
    expect(input?.definition).toBeUndefined();
    expect(input?.example).toBeUndefined();
  });

  it('a duplicate found in this browser can be added as a sense of the word already stored', async () => {
    const { api, user } = await open('/add', [CANDID]);
    await user.type(await screen.findByLabelText(/^Word/), 'candid');
    await user.type(screen.getByLabelText('Vietnamese meaning'), 'thẳng thắn, thật thà');
    await user.click(screen.getByRole('button', { name: /Add word/ }));

    const asSense = await screen.findByRole('button', { name: /Add as sense to/ });
    expect(asSense).toHaveTextContent('candid');
    await user.click(asSense);

    expect(api.addSense).toHaveBeenCalledWith(
      pageId(1),
      expect.objectContaining({ meaning: 'thẳng thắn, thật thà' }),
    );
    expect(await screen.findByText(/Added sense to/)).toBeInTheDocument();
  });

  it('a duplicate only the server knows about is also offered as a sense', async () => {
    const zealous = entry(1, { word: 'zealous', meaning: 'nhiệt huyết' });
    const { api, user } = await open('/add', [zealous]);
    api.createEntry.mockRejectedValueOnce(
      new ApiError('duplicate', '“zealous” is already in your vocabulary.', 409, [{ ...zealous }]),
    );
    await user.type(await screen.findByLabelText(/^Word/), 'zeal');
    await user.type(screen.getByLabelText('Vietnamese meaning'), 'sôi nổi');
    await user.click(screen.getByRole('button', { name: /Add word/ }));

    const asSense = await screen.findByRole('button', { name: /Add as sense to/ });
    expect(asSense).toHaveTextContent('zealous');
    await user.click(asSense);
    expect(api.addSense).toHaveBeenCalledWith(
      pageId(1),
      expect.objectContaining({ meaning: 'sôi nổi' }),
    );
    expect(await screen.findByText(/Added sense to/)).toBeInTheDocument();
  });
});
