// @vitest-environment jsdom
/**
 * Smart Reader through the add page: pick a word in a pasted reading, get a
 * draft built from the reader's own sentence, hand it to the ordinary form —
 * and every failure lands back on "fill it in by hand". Nothing here saves
 * anything: the draft is checked and edited like anything typed by hand.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi } from '../helpers/fake-api.js';

const PASSAGE = 'The board gave a candid account of the loss. Everyone stayed calm.';

async function open(path = '/add') {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi();
  const store = createSettingsStore(null);
  const view = render(<App api={fake.api} settings={store} />);
  await waitFor(() => expect(fake.api.fetchVocabulary).toHaveBeenCalled());
  await screen.findAllByRole('heading');
  return { ...fake, user: userEvent.setup(), ...view };
}

/** Type the passage, then select `word` in it the way a reader would. */
async function pick(user: ReturnType<typeof userEvent.setup>, word: string) {
  const field = (await screen.findByLabelText('Your reading')) as HTMLTextAreaElement;
  await user.type(field, PASSAGE);
  const from = PASSAGE.indexOf(word);
  field.setSelectionRange(from, from + word.length);
  fireEvent.mouseUp(field);
  expect(screen.getByText(/Selected:/)).toHaveTextContent(`Selected: ${word}`);
  await user.click(screen.getByRole('button', { name: 'Suggest for this word' }));
}

const readerTab = () => screen.getByRole('button', { name: 'Smart Reader' });
const manualTab = () => screen.getByRole('button', { name: 'By hand' });

beforeEach(() => {
  window.history.replaceState(null, '', '/add');
});

describe('Smart Reader', () => {
  it('builds a draft from the reader’s own sentence and fills the ordinary form with it', async () => {
    const { api, user } = await open();
    await user.click(readerTab());

    await pick(user, 'candid');
    expect(await screen.findByText('Suggested card — check it before saving')).toBeInTheDocument();
    // The sentence is the reader's own wording, from their text.
    expect(api.extractSense).toHaveBeenCalledWith({ text: PASSAGE, word: 'candid' });
    expect(screen.getByText('The board gave a candid account of the loss.')).toBeInTheDocument();
    expect(screen.getByText('definition of candid')).toBeInTheDocument();
    expect(screen.getByText('nghĩa của candid')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Use in the form/ }));
    // Back on the form, filled in and editable like anything typed by hand.
    expect(screen.getByLabelText(/^Word/)).toHaveValue('candid');
    expect(screen.getByLabelText('Vietnamese meaning')).toHaveValue('nghĩa của candid');
    expect(screen.getByLabelText('Definition')).toHaveValue('definition of candid');
    expect(screen.getByLabelText('Example sentences')).toHaveValue('The board gave a candid account of the loss.');
    // Nothing was saved by itself: the save button is still ahead.
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('says the word was not in the text, and asks for the reader’s own fix', async () => {
    const { api, user } = await open();
    api.extractSense.mockRejectedValueOnce(new ApiError('invalid_request', 'That word was not found in the text.', 400));
    await user.click(readerTab());

    const field = await screen.findByLabelText('Your reading');
    await user.type(field, PASSAGE);
    const from = PASSAGE.indexOf('candid');
    (field as HTMLTextAreaElement).setSelectionRange(from, from + 6);
    fireEvent.mouseUp(field);
    await user.click(screen.getByRole('button', { name: 'Suggest for this word' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That word was not found in the text.');
    // Still on the reader: the passage is there to be corrected.
    expect(screen.getByLabelText('Your reading')).toBeInTheDocument();
  });

  it('falls back to entering the word by hand when the server cannot help', async () => {
    const { api, user } = await open();
    api.extractSense.mockRejectedValueOnce(new ApiError('rate_limited', 'Too many AI requests just now.', 429));
    await user.click(readerTab());

    const field = await screen.findByLabelText('Your reading');
    await user.type(field, PASSAGE);
    const from = PASSAGE.indexOf('candid');
    (field as HTMLTextAreaElement).setSelectionRange(from, from + 6);
    fireEvent.mouseUp(field);
    await user.click(screen.getByRole('button', { name: 'Suggest for this word' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many AI requests just now. Fill the card in by hand.');
    // The form is still one click away, unchanged and working.
    await user.click(manualTab());
    expect(screen.getByLabelText(/^Word/)).toBeInTheDocument();
  });

  it('stops offering suggestions once the server has said it has none', async () => {
    const { api, user } = await open();
    api.extractSense.mockRejectedValueOnce(new ApiError('not_supported', 'AI assistance is not configured on this server.', 409));
    await user.click(readerTab());

    const field = await screen.findByLabelText('Your reading');
    await user.type(field, PASSAGE);
    const from = PASSAGE.indexOf('candid');
    (field as HTMLTextAreaElement).setSelectionRange(from, from + 6);
    fireEvent.mouseUp(field);
    await user.click(screen.getByRole('button', { name: 'Suggest for this word' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no AI assistance/i);
    expect(screen.getByText(/fill the card in by hand/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest for this word' })).toBeDisabled();
  });

  it('waits for a word to be selected before asking anything', async () => {
    const { api, user } = await open();
    await user.click(readerTab());
    const suggest = screen.getByRole('button', { name: 'Suggest for this word' });
    expect(suggest).toBeDisabled();
    await user.type(await screen.findByLabelText('Your reading'), PASSAGE);
    expect(suggest).toBeDisabled();
    expect(api.extractSense).not.toHaveBeenCalled();
  });
});

