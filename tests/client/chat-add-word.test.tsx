// @vitest-environment jsdom
/**
 * Adding a word straight from a Vocabulary Expert reply: the button under the
 * reply, the dialog it opens, and what the row says afterwards — saving, added,
 * a word already in the bank, or a failure with a way back. The word goes
 * through the same store the Add page uses, so what is checked here is really
 * what would be sent.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AiMessage, VocabularyEntry } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry } from '../helpers/fake-api.js';
import { TODAY, deferred, pageId } from '../helpers/fixtures.js';

const ANALYSIS = `**proliferation** · noun · /prəˌlɪfəˈreɪʃn/ · C2
- **Meaning (Vietnamese):** sự gia tăng nhanh chóng
- **Definition:** a rapid increase
- **Examples:**
  1. The proliferation of fake news worries educators. — Sự lan truyền của tin giả khiến các nhà giáo dục lo lắng.`;

/** A reply the model left half-finished. */
const PARTIAL = `**proliferation** · noun
- **Meaning (Vietnamese):** sự gia tăng nhanh chóng`;

const AT = '2026-10-16T03:00:00.000Z';

async function openChat(options: { mode?: 'general' | 'vocabulary_expert'; content?: string; entries?: VocabularyEntry[] } = {}) {
  const mode = options.mode ?? 'vocabulary_expert';
  const fake = createFakeApi({ entries: options.entries ?? [] });
  const conversation = { id: pageId(900), mode, title: 'proliferation', createdAt: AT, updatedAt: AT };
  const messages: AiMessage[] = [
    { id: pageId(901), role: 'user', content: 'Tell me about proliferation', metadata: {}, createdAt: AT },
    { id: pageId(902), role: 'assistant', content: options.content ?? ANALYSIS, metadata: {}, createdAt: AT },
  ];
  fake.chats.set(conversation.id, { conversation, messages });
  window.history.replaceState(null, '', `/chat?conversation=${conversation.id}`);
  const view = render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, conversation, messages, user: userEvent.setup(), ...view };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const thread = () => screen.getByRole('region', { name: 'Conversation' });
const addWord = () => within(thread()).getByRole('button', { name: 'Add Word' });

/** Opens the dialog and waits for the vocabulary behind it to be ready. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(addWord());
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByLabelText(/^Word/);
  return dialog;
}

/** The reply sent back the word already exists, as the server's refusal reads. */
const duplicateRefusal = (existing: VocabularyEntry) =>
  new ApiError('duplicate', '“proliferation” is already in your vocabulary.', 409, [existing]);

describe('the Add Word action', () => {
  it('sits, bold, under a finished Vocabulary Expert reply', async () => {
    await openChat();
    const button = await within(thread()).findByRole('button', { name: 'Add Word' });
    expect(button.className).toContain('font-bold');
    expect(button.className).toContain('bg-accent');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('is not offered in general chat', async () => {
    await openChat({ mode: 'general' });
    expect(await within(thread()).findByTestId('message-assistant')).toBeInTheDocument();
    expect(within(thread()).queryByRole('button', { name: 'Add Word' })).not.toBeInTheDocument();
  });

  it('is not offered while a reply is still arriving', async () => {
    const { user, api } = await openChat();
    await within(thread()).findByRole('button', { name: 'Add Word' });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    api.sendMessage.mockImplementationOnce(
      async () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await gate;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'delta', delta: ANALYSIS })}\n\n` +
                  `data: ${JSON.stringify({ type: 'done', usage: null, finishReason: 'stop' })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
    );
    await user.type(within(thread()).getByLabelText('Message'), 'and proliferation?{Enter}');

    await screen.findByText('Assistant is thinking');
    const arriving = within(thread()).getAllByTestId('message-assistant').at(-1)!;
    expect(within(arriving).queryByRole('button', { name: 'Add Word' })).not.toBeInTheDocument();

    await act(async () => release());
    await waitFor(() => expect(within(arriving).getByRole('button', { name: 'Add Word' })).toBeInTheDocument());
  });
});

describe('the Add Word dialog', () => {
  it('opens with the four fields read out of the reply', async () => {
    const { user } = await openChat();
    const dialog = await openDialog(user);
    expect(within(dialog).getByLabelText(/^Word/)).toHaveValue('proliferation');
    expect(within(dialog).getByLabelText('Vietnamese meaning')).toHaveValue('sự gia tăng nhanh chóng');
    expect(within(dialog).getByLabelText('Definition')).toHaveValue('a rapid increase');
    // Examples from the reply appear as checkboxes, not a single labeled field.
    expect(within(dialog).getByText('Simple')).toBeInTheDocument();
  });

  it('says what the reply did not carry, and still needs a word', async () => {
    const { user, api } = await openChat({ content: PARTIAL });
    const dialog = await openDialog(user);
    expect(dialog).toHaveTextContent('Could not find the English definition and an example sentence in this reply');
    expect(within(dialog).getByLabelText('Definition')).toHaveValue('');
    expect(within(dialog).getByLabelText('Example sentences')).toHaveValue('');

    // The missing fields are blank but allowed; the word is not.
    await user.clear(within(dialog).getByLabelText(/^Word/));
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));
    expect(await within(dialog).findByText('Enter the word you want to add.')).toBeInTheDocument();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('closes on submit, and saves exactly the four fields', async () => {
    const { user, api, conversation } = await openChat();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(1));
    const sent = api.createEntry.mock.calls[0]![0];
    expect(sent).toMatchObject({
      word: 'proliferation',
      meaning: 'sự gia tăng nhanh chóng',
      definition: 'a rapid increase',
      example: 'The proliferation of fake news worries educators.',
      dateAdded: TODAY,
      mastery: 1,
      reviewDate: null,
    });
    // Nothing else from the analysis travels — no IPA, collocations or translations.
    expect(Object.keys(sent).sort()).toEqual([
      'dateAdded',
      'definition',
      'example',
      'mastery',
      'meaning',
      'requestId',
      'reviewDate',
      'word',
    ]);

    expect(await within(thread()).findByText('Added')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.markMessageSaved).toHaveBeenCalledWith(conversation.id, pageId(902), expect.any(String)),
    );
  });

  it('still says Added after the conversation is reopened', async () => {
    const { user, api, unmount } = await openChat();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));
    await waitFor(() => expect(api.markMessageSaved).toHaveBeenCalled());

    unmount();
    render(<App api={api} settings={createSettingsStore(null)} />);
    await screen.findAllByRole('navigation');
    expect(await within(thread()).findByText('Added')).toBeInTheDocument();
    expect(within(thread()).queryByRole('button', { name: 'Add Word' })).not.toBeInTheDocument();
  });
});

describe('a word already in the bank', () => {
  it('warns instead of overwriting, and offers no "Add it anyway"', async () => {
    const existing = entry(520, { word: 'proliferation', meaning: 'cũ', dateAdded: TODAY });
    const { user, api } = await openChat({ entries: [existing] });
    api.createEntry.mockRejectedValueOnce(duplicateRefusal(existing));

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));

    const panel = await within(thread()).findByRole('alert');
    expect(panel).toHaveTextContent('is already in your vocabulary');
    expect(within(panel).getByRole('button', { name: 'Update with new information' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Open entry' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Add it anyway/i })).not.toBeInTheDocument();
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('updates only the meaning, definition and example when asked', async () => {
    const existing = entry(520, { word: 'proliferation', meaning: 'cũ', dateAdded: TODAY });
    const { user, api } = await openChat({ entries: [existing] });
    api.createEntry.mockRejectedValueOnce(duplicateRefusal(existing));

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));
    await user.click(within(await within(thread()).findByRole('alert')).getByRole('button', { name: 'Update with new information' }));

    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledTimes(1));
    const [id, patch] = api.updateEntry.mock.calls[0]!;
    expect(id).toBe(existing.id);
    expect(patch).toEqual({
      meaning: 'sự gia tăng nhanh chóng',
      definition: 'a rapid increase',
      example: 'The proliferation of fake news worries educators.',
    });
    expect(await within(thread()).findByText('Added')).toBeInTheDocument();
    await waitFor(() => expect(api.markMessageSaved).toHaveBeenCalledWith(expect.any(String), pageId(902), existing.id));
  });

  it('adds nothing at all when the warning is cancelled', async () => {
    const existing = entry(520, { word: 'proliferation', meaning: 'cũ', dateAdded: TODAY });
    const { user, api } = await openChat({ entries: [existing] });
    api.createEntry.mockRejectedValueOnce(duplicateRefusal(existing));

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));
    const panel = await within(thread()).findByRole('alert');
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(within(thread()).queryByRole('alert')).not.toBeInTheDocument());
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.markMessageSaved).not.toHaveBeenCalled();
    expect(await within(thread()).findByRole('button', { name: 'Add Word' })).toBeInTheDocument();
    expect(api.createEntry).toHaveBeenCalledTimes(1);
  });
});

describe('a save that fails', () => {
  const refusal = () => new ApiError('server_error', 'The database refused the change.', 400);

  it('says so, and retries without typing it all back', async () => {
    const { user, api } = await openChat();
    api.createEntry.mockRejectedValueOnce(refusal());

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));

    const panel = await within(thread()).findByRole('alert');
    expect(panel).toHaveTextContent('could not be saved. The database refused the change.');
    await user.click(within(panel).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(2));
    expect(await within(thread()).findByText('Added')).toBeInTheDocument();
  });

  it('reopens with everything that was typed, when Edit is chosen', async () => {
    const { user, api } = await openChat();
    api.createEntry.mockRejectedValueOnce(refusal());

    const dialog = await openDialog(user);
    await user.clear(within(dialog).getByLabelText('Definition'));
    await user.type(within(dialog).getByLabelText('Definition'), 'a fast increase');
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));
    await user.click(within(await within(thread()).findByRole('alert')).getByRole('button', { name: 'Edit' }));

    const reopened = await screen.findByRole('dialog');
    expect(within(reopened).getByLabelText(/^Word/)).toHaveValue('proliferation');
    expect(within(reopened).getByLabelText('Definition')).toHaveValue('a fast increase');
  });

  it('clears away when Discard is chosen', async () => {
    const { user, api } = await openChat();
    api.createEntry.mockRejectedValueOnce(refusal());

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));
    const panel = await within(thread()).findByRole('alert');
    await user.click(within(panel).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(within(thread()).queryByRole('alert')).not.toBeInTheDocument());
    expect(within(thread()).getByRole('button', { name: 'Add Word' })).toBeInTheDocument();
    expect(api.createEntry).toHaveBeenCalledTimes(1);
  });
});

describe('while the word is being saved', () => {
  it('shows Saving instead of the button, so a second click cannot add another', async () => {
    const { user, api } = await openChat();
    const pending = deferred<VocabularyEntry>();
    api.createEntry.mockReturnValueOnce(pending.promise);

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));

    expect(await within(thread()).findByText('Saving…')).toBeInTheDocument();
    expect(within(thread()).queryByRole('button', { name: 'Add Word' })).not.toBeInTheDocument();
    expect(api.createEntry).toHaveBeenCalledTimes(1);

    await act(async () =>
      pending.resolve(entry(521, { word: 'proliferation', meaning: 'sự gia tăng nhanh chóng', dateAdded: TODAY })),
    );
    expect(await within(thread()).findByText('Added')).toBeInTheDocument();
    expect(within(thread()).getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(api.createEntry).toHaveBeenCalledTimes(1);
  });

  it('keeps the row added even when the server cannot record that it was', async () => {
    const { user, api } = await openChat();
    api.markMessageSaved.mockRejectedValueOnce(new ApiError('unavailable', 'Not now.', 503));

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add to vocabulary' }));

    expect(await within(thread()).findByText('Added')).toBeInTheDocument();
    expect(api.createEntry).toHaveBeenCalledTimes(1);
  });
});
