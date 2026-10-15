// @vitest-environment jsdom
/**
 * AI Chat as the reader uses it, against the fake API (whose reply repeats the
 * message and arrives cut mid-event), plus the pieces it is built from: the
 * stream reader and the Markdown renderer.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { Markdown } from '../../src/components/Markdown.js';
import { ApiError } from '../../src/lib/api-client.js';
import { readChatStream } from '../../src/lib/chat-stream.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi } from '../helpers/fake-api.js';

async function open(path = '/chat') {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi();
  render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup() };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const list = () => screen.getByRole('complementary', { name: 'Conversations' });
const thread = () => screen.getByRole('region', { name: 'Conversation' });

describe('AI chat page', () => {
  it('starts a conversation, streams the reply, and names it after the first message', async () => {
    const { user, api } = await open();
    expect(await within(list()).findByText('No conversations yet. Press New to start one.')).toBeInTheDocument();

    await user.click(within(list()).getByRole('button', { name: 'New' }));
    expect(api.createConversation).toHaveBeenCalledWith('general', 'New conversation');
    const box = await within(thread()).findByLabelText('Message');
    await user.type(box, 'good morning{Enter}');

    const reply = await within(thread()).findByText((_, element) => element?.tagName === 'P' && element.textContent === 'You said good morning.');
    // Markdown is drawn, not printed: the bold part is bold, and no tag shows as text.
    expect(within(reply).getByText('good morning').tagName).toBe('STRONG');
    expect(thread()).not.toHaveTextContent('<strong>');
    expect(within(thread()).getByTestId('message-user')).toHaveTextContent('good morning');
    expect(box).toHaveValue('');

    expect(await within(list()).findByRole('button', { name: /good morning/ })).toBeInTheDocument();
  });

  it('keeps a new line with Shift+Enter instead of sending', async () => {
    const { user, api } = await open();
    await user.click(await within(list()).findByRole('button', { name: 'New' }));
    const box = await within(thread()).findByLabelText('Message');
    await user.type(box, 'one{Shift>}{Enter}{/Shift}two');
    expect(box).toHaveValue('one\ntwo');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('shows why a message could not be sent and puts it back to try again', async () => {
    const { user, api } = await open();
    await user.click(await within(list()).findByRole('button', { name: 'New' }));
    api.sendMessage.mockRejectedValueOnce(new ApiError('rate_limited', 'Rate limit exceeded for minute. Try again in 30 seconds.', 429));
    const box = await within(thread()).findByLabelText('Message');
    await user.type(box, 'hello{Enter}');

    expect(await within(thread()).findByRole('alert')).toHaveTextContent('Try again in 30 seconds.');
    expect(box).toHaveValue('hello');
    expect(within(thread()).queryByTestId('message-user')).not.toBeInTheDocument();

    await user.click(within(thread()).getByRole('button', { name: 'Send message' }));
    expect(await within(thread()).findByTestId('message-assistant')).toHaveTextContent('You said hello.');
    expect(within(thread()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the reason a reply stopped part way', async () => {
    const { user, api } = await open();
    await user.click(await within(list()).findByRole('button', { name: 'New' }));
    api.sendMessage.mockResolvedValueOnce(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"delta","delta":"Half"}\n\ndata: {"type":"error","code":"provider_error","message":"The AI provider stopped answering part way through."}\n\n'));
          controller.close();
        },
      }),
    );
    await user.type(await within(thread()).findByLabelText('Message'), 'hi{Enter}');
    expect(await within(thread()).findByRole('alert')).toHaveTextContent('stopped answering part way through');
  });

  it('says plainly when AI chat is not set up on the server', async () => {
    window.history.replaceState(null, '', '/chat');
    const fake = createFakeApi();
    fake.api.listConversations.mockRejectedValue(new ApiError('ai_unavailable', 'AI chat is not configured on this server.', 503));
    render(<App api={fake.api} settings={createSettingsStore(null)} />);
    const alert = await within(await screen.findByRole('complementary', { name: 'Conversations' })).findByRole('alert');
    expect(alert).toHaveTextContent('AI chat is not set up yet');
    expect(alert).toHaveTextContent('AI_PROVIDER, AI_MODEL and a key');
    expect(within(list()).getByRole('button', { name: 'New' })).toBeDisabled();
  });

  it('opens a conversation from the list and goes back to it on a phone', async () => {
    const { user, api } = await open();
    await user.click(await within(list()).findByRole('button', { name: 'New' }));
    await user.type(await within(thread()).findByLabelText('Message'), 'first{Enter}');
    await within(thread()).findByTestId('message-assistant');

    await user.click(within(thread()).getByRole('button', { name: 'Back to conversations' }));
    expect(window.location.search).toBe('?mode=general');
    await user.click(await within(list()).findByRole('button', { name: /first/ }));
    await waitFor(() => expect(api.getConversation).toHaveBeenCalled());
    expect(await within(thread()).findByTestId('message-assistant')).toHaveTextContent('You said first.');
  });

  it('deletes a conversation after asking', async () => {
    const { user, api } = await open();
    await user.click(await within(list()).findByRole('button', { name: 'New' }));
    await user.click(await within(thread()).findByRole('button', { name: 'Delete conversation' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteConversation).toHaveBeenCalled());
    expect(await within(list()).findByText('No conversations yet. Press New to start one.')).toBeInTheDocument();
  });
});

describe('reading a streamed reply', () => {
  const streamOf = (...pieces: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    });

  it('joins events cut across network chunks', async () => {
    const parts: string[] = [];
    const end = await readChatStream(streamOf('data: {"type":"del', 'ta","delta":"Hel"}\n\ndata: {"type":"delta","delta":"lo"}\n', '\ndata: {"type":"done"}\n\n'), (text) => parts.push(text));
    expect(parts.join('')).toBe('Hello');
    expect(end).toEqual({ ok: true });
  });

  it('reports an error event with its message', async () => {
    const end = await readChatStream(streamOf('data: {"type":"error","code":"x","message":"No."}\n\n'), () => {});
    expect(end).toEqual({ ok: false, message: 'No.' });
  });

  it('treats a stream that stops without finishing as cut off', async () => {
    const end = await readChatStream(streamOf('data: {"type":"delta","delta":"Hel"}\n\n'), () => {});
    expect(end).toEqual({ ok: false, message: expect.stringContaining('cut off') });
  });
});

describe('Markdown in a reply', () => {
  it('draws bold, italic, code and http links, and prints any HTML as text', () => {
    render(<Markdown content={'**bold** and *soft* and `code` and [site](https://example.com) <img src=x onerror=alert(1)>'} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('soft').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: 'site' })).toHaveAttribute('href', 'https://example.com');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });

  it('makes no link of anything but http(s)', () => {
    render(<Markdown content="[click](javascript:alert(1))" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps blank lines inside a code block, and draws lists', () => {
    const { container } = render(<Markdown content={'```\nfirst\n\nsecond\n```\n\n- one\n- two\n\n1. a\n2. b'} />);
    expect(container.querySelector('pre')?.textContent).toBe('first\n\nsecond');
    expect([...container.querySelectorAll('ul li')].map((item) => item.textContent)).toEqual(['one', 'two']);
    expect([...container.querySelectorAll('ol li')].map((item) => item.textContent)).toEqual(['a', 'b']);
  });
});
