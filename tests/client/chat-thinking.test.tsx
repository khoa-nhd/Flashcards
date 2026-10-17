// @vitest-environment jsdom
/**
 * The thinking indicator inside the chat page: the stable label for screen
 * readers while the reply is pending, the one-line row above the reply while
 * it streams, and both gone the moment the reply lands.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AiMessage } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi } from '../helpers/fake-api.js';
import { pageId } from '../helpers/fixtures.js';

const AT = '2026-10-16T03:00:00.000Z';

async function openChat() {
  const fake = createFakeApi({ entries: [] });
  const conversation = { id: pageId(950), mode: 'general' as const, title: 'New conversation', createdAt: AT, updatedAt: AT };
  fake.chats.set(conversation.id, { conversation, messages: [] as AiMessage[] });
  window.history.replaceState(null, '', `/chat?conversation=${conversation.id}`);
  const view = render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, conversation, user: userEvent.setup(), ...view };
}

const delta = (text: string) => `data: ${JSON.stringify({ type: 'delta', delta: text })}\n\n`;
const done = `data: ${JSON.stringify({ type: 'done', usage: null, finishReason: 'stop' })}\n\n`;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the thinking indicator', () => {
  it('labels the wait for screen readers, then clears when the reply lands', async () => {
    const { user, api } = await openChat();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    api.sendMessage.mockImplementationOnce(
      async () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await gate;
            controller.enqueue(new TextEncoder().encode(delta('Done and dusted.') + done));
            controller.close();
          },
        }),
    );

    await user.type(screen.getByLabelText('Message'), 'hello{Enter}');

    const indicator = await screen.findByTestId('thinking-indicator');
    expect(indicator).toHaveAttribute('data-phase', 'waiting');
    within(indicator).getByText('Assistant is thinking');
    const line = within(indicator).getByTestId('thinking-line');
    expect(line.textContent?.trim().length).toBeGreaterThan(0);
    expect(line.closest('[aria-hidden="true"]')).not.toBeNull();

    await act(async () => release());

    await waitFor(() => expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument());
    expect(await screen.findByText(/Done and dusted/)).toBeInTheDocument();
  });

  it('shrinks to a one-line row above the reply while it streams', async () => {
    const { user, api } = await openChat();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    api.sendMessage.mockImplementationOnce(
      async () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(delta('Partial reply ')));
            await gate;
            controller.enqueue(new TextEncoder().encode(delta('finished.') + done));
            controller.close();
          },
        }),
    );

    await user.type(screen.getByLabelText('Message'), 'hello{Enter}');

    const partial = await screen.findByText(/Partial reply/);
    const indicator = screen.getByTestId('thinking-indicator');
    expect(indicator).toHaveAttribute('data-phase', 'streaming');
    expect(indicator.className).toContain('h-6');
    expect(within(indicator).getByTestId('thinking-line').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(indicator.compareDocumentPosition(partial) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => release());

    await waitFor(() => expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument());
    expect(await screen.findByText(/finished/)).toBeInTheDocument();
  });
});
