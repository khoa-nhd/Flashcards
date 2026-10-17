/**
 * AI Chat: the conversation list and one conversation's thread. On a phone
 * they take turns on screen: the list until a conversation is opened, then the
 * thread with a way back. On a wider screen they sit side by side.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AiConversation, AiMessage, AiMode } from '../../shared/api.js';
import { useApp } from '../app-context.js';
import { AddWordActions } from '../components/AddWordActions.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { Markdown } from '../components/Markdown.js';
import { Spinner } from '../components/Spinner.js';
import { ThinkingIndicator } from '../components/ThinkingIndicator.js';
import { BUTTON_PRIMARY } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';
import { readChatStream } from '../lib/chat-stream.js';
import { buildHref, navigate, ROUTES, useLocation } from '../lib/router.js';

/** The server's default limit for one message. */
const MESSAGE_MAX_CHARS = 4000;

/** Message metadata as an object, however the server shaped it. */
const metadataOf = (metadata: unknown): Record<string, unknown> =>
  typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};

/** The word this reply was saved to, when the "Add Word" action was used on it. */
const savedIdOf = (message: AiMessage): string | null => {
  const id = metadataOf(message.metadata).vocabularyId;
  return typeof id === 'string' && id !== '' ? id : null;
};

const MODE_LABEL: Record<AiMode, string> = {
  general: 'General',
  vocabulary_expert: 'Vocabulary Expert',
};

const MODE_HINT: Record<AiMode, string> = {
  general: 'Ask anything: writing, translation, grammar, or just chat.',
  vocabulary_expert: 'Ask about an English word or phrase for its meaning, examples, collocations and common mistakes.',
};

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

const isMode = (value: string | null): value is AiMode => value === 'general' || value === 'vocabulary_expert';

interface ListError {
  message: string;
  /** The server has no AI settings, so nothing here can work until it does. */
  unavailable: boolean;
}

const listError = (error: unknown, fallback: string): ListError => ({
  message: messageOf(error, fallback),
  unavailable: error instanceof ApiError && error.code === 'ai_unavailable',
});

/** The opened conversation, tagged with the id it was loaded for so a late answer never lands on another. */
interface Thread {
  id: string;
  conversation: AiConversation | null;
  messages: AiMessage[];
  error: string | null;
}

export function ChatPage() {
  const { api } = useApp();
  const { query } = useLocation();
  const conversationId = query.get('conversation');
  const queryMode = query.get('mode');

  const [conversations, setConversations] = useState<AiConversation[] | null>(null);
  const [listProblem, setListProblem] = useState<ListError | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AiConversation | null>(null);
  const [deleting, setDeleting] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const composer = useRef<HTMLTextAreaElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);

  const loaded = thread !== null && thread.id === conversationId ? thread : null;
  const current = loaded?.conversation ?? null;
  // An open conversation decides the mode; otherwise the address does.
  const mode: AiMode = current?.mode ?? (isMode(queryMode) ? queryMode : 'general');

  const loadConversations = async () => {
    try {
      const response = await api.listConversations(50, 0);
      setConversations(response.conversations);
      setListProblem(null);
    } catch (error) {
      setListProblem(listError(error, 'Could not load your conversations.'));
    }
  };

  useEffect(() => {
    let active = true;
    api.listConversations(50, 0).then(
      (response) => {
        if (active) setConversations(response.conversations);
      },
      (error: unknown) => {
        if (active) setListProblem(listError(error, 'Could not load your conversations.'));
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (conversationId === null) return;
    let active = true;
    api.getConversation(conversationId, 200, 0).then(
      (response) => {
        if (active) setThread({ id: conversationId, conversation: response.conversation, messages: response.messages, error: null });
      },
      (error: unknown) => {
        if (active) setThread({ id: conversationId, conversation: null, messages: [], error: messageOf(error, 'Could not open this conversation.') });
      },
    );
    return () => {
      active = false;
    };
  }, [api, conversationId]);

  // Follow the reply as it arrives.
  const messageCount = loaded?.messages.length ?? 0;
  const lastLength = loaded?.messages.at(-1)?.content.length ?? 0;
  useEffect(() => {
    messagesEnd.current?.scrollIntoView?.({ block: 'end' });
  }, [messageCount, lastLength]);

  const open = (id: string | null, nextMode: AiMode = mode) => {
    setSendError(null);
    navigate(buildHref(ROUTES.chat, { conversation: id, mode: id === null ? nextMode : null }));
  };

  const createConversation = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const conversation = await api.createConversation(mode, 'New conversation');
      setConversations((list) => [conversation, ...(list ?? [])]);
      setListProblem(null);
      setThread({ id: conversation.id, conversation, messages: [], error: null });
      open(conversation.id);
    } catch (error) {
      setListProblem(listError(error, 'Could not start a conversation.'));
    } finally {
      setCreating(false);
    }
  };

  const deleteConversation = async () => {
    if (confirmDelete === null) return;
    setDeleting({ busy: true, error: null });
    try {
      await api.deleteConversation(confirmDelete.id);
      setConversations((list) => (list ?? []).filter((item) => item.id !== confirmDelete.id));
      if (conversationId === confirmDelete.id) open(null, confirmDelete.mode);
      setConfirmDelete(null);
      setDeleting({ busy: false, error: null });
    } catch (error) {
      setDeleting({ busy: false, error: messageOf(error, 'Could not delete this conversation.') });
    }
  };

  const updateMessages = (id: string, change: (messages: AiMessage[]) => AiMessage[]) =>
    setThread((latest) => (latest === null || latest.id !== id ? latest : { ...latest, messages: change(latest.messages) }));

  /** Once a reply's analysis is in the bank, the row keeps saying so across reloads. */
  const markSaved = (messageId: string, vocabularyId: string) => {
    if (conversationId === null) return;
    updateMessages(conversationId, (messages) =>
      messages.map((message) =>
        message.id === messageId ? { ...message, metadata: { ...metadataOf(message.metadata), vocabularyId } } : message,
      ),
    );
  };

  const send = async () => {
    const content = draft.trim();
    if (content === '' || sending || current === null) return;
    const id = current.id;
    const now = new Date().toISOString();
    const question: AiMessage = { id: crypto.randomUUID(), role: 'user', content, metadata: {}, createdAt: now };
    const answer: AiMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', metadata: {}, createdAt: now };
    setSending(true);
    setSendError(null);
    setDraft('');
    resizeComposer('');
    updateMessages(id, (messages) => [...messages, question, answer]);

    let text = '';
    let failure: string | null = null;
    try {
      const stream = await api.sendMessage(id, content);
      const end = await readChatStream(stream, (delta) => {
        text += delta;
        updateMessages(id, (messages) => messages.map((message) => (message.id === answer.id ? { ...message, content: text } : message)));
      });
      if (!end.ok) failure = end.message;
    } catch (error) {
      failure = messageOf(error, 'Could not send the message.');
    }

    if (failure !== null) {
      // Nothing of a failed exchange is kept, so the message goes back into the box to send again.
      updateMessages(id, (messages) => messages.filter((message) => message.id !== question.id && message.id !== answer.id));
      setDraft((latest) => (latest === '' ? content : latest));
      setSendError(failure);
    } else {
      // The first message names the conversation; the list shows the new name.
      void loadConversations();
    }
    setSending(false);
  };

  const resizeComposer = (value: string) => {
    const box = composer.current;
    if (box === null) return;
    box.style.height = 'auto';
    if (value !== '') box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const shown = (conversations ?? []).filter((conversation) => conversation.mode === mode);
  const threadOpen = conversationId !== null;

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label="Conversations"
        className={`${threadOpen ? 'hidden md:flex' : 'flex'} w-full min-w-0 shrink-0 flex-col border-line md:w-72 md:border-r`}
      >
        <div className="flex items-center gap-2 border-b border-line p-3">
          <label htmlFor="chat-mode" className="sr-only">
            Assistant
          </label>
          <select
            id="chat-mode"
            value={mode}
            onChange={(event) => open(null, event.target.value as AiMode)}
            className="h-10 min-w-0 flex-1 cursor-pointer rounded-xl border border-line bg-surface px-3 text-sm font-medium text-ink"
          >
            <option value="general">{MODE_LABEL.general}</option>
            <option value="vocabulary_expert">{MODE_LABEL.vocabulary_expert}</option>
          </select>
          <button
            type="button"
            onClick={() => void createConversation()}
            disabled={creating || listProblem?.unavailable === true}
            className={`${BUTTON_PRIMARY} shrink-0 px-3`}
          >
            {creating ? <Spinner /> : <Icon name="add" className="size-4" />}
            New
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {listProblem !== null ? (
            <div role="alert" className="m-1 rounded-xl border border-bad/30 bg-bad-soft p-3 text-sm text-bad-ink">
              <p className="font-semibold">{listProblem.unavailable ? 'AI chat is not set up yet' : 'Something went wrong'}</p>
              <p className="mt-1">{listProblem.message}</p>
              {listProblem.unavailable ? (
                <p className="mt-2 text-xs">
                  The server needs AI_PROVIDER, AI_MODEL and a key (AI_API_KEY) in its settings, for example in the
                  Vercel project’s environment variables, and then a new deployment.
                </p>
              ) : (
                <button type="button" onClick={() => void loadConversations()} className="mt-2 cursor-pointer font-semibold underline">
                  Try again
                </button>
              )}
            </div>
          ) : conversations === null ? (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
              <Spinner /> Loading conversations…
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted">No conversations yet. Press New to start one.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {shown.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => open(conversation.id)}
                    aria-current={conversation.id === conversationId ? 'true' : undefined}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition ${
                      conversation.id === conversationId ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-line/40'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{conversation.title || 'Untitled'}</span>
                    <span className="shrink-0 text-xs font-normal text-muted">{new Date(conversation.updatedAt).toLocaleDateString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section aria-label="Conversation" className={`${threadOpen ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-line px-2 md:px-4">
          {threadOpen && (
            <button
              type="button"
              onClick={() => open(null)}
              aria-label="Back to conversations"
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-line/40 md:hidden"
            >
              <Icon name="left" className="size-5" />
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
            {current === null ? (threadOpen ? '' : 'AI Chat') : (conversations?.find((item) => item.id === current.id)?.title ?? current.title)}
          </h2>
          {current !== null && (
            <>
              <span className="hidden shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent sm:inline">
                {MODE_LABEL[current.mode]}
              </span>
              <button
                type="button"
                onClick={() => {
                  setDeleting({ busy: false, error: null });
                  setConfirmDelete(current);
                }}
                aria-label="Delete conversation"
                className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-line/40 hover:text-bad"
              >
                <Icon name="trash" className="size-4" />
              </button>
            </>
          )}
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 md:px-6">
          {!threadOpen ? (
            <Intro mode={mode} />
          ) : loaded === null ? (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
              <Spinner /> Loading conversation…
            </p>
          ) : loaded.error !== null ? (
            <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
              {loaded.error}
            </p>
          ) : loaded.messages.length === 0 ? (
            <Intro mode={mode} />
          ) : (
            loaded.messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                pending={sending && message === loaded.messages.at(-1)}
                expert={mode === 'vocabulary_expert'}
                conversationId={loaded.id}
                onSaved={markSaved}
              />
            ))
          )}
          <div ref={messagesEnd} />
        </div>

        {current !== null && (
          <form onSubmit={onSubmit} className="shrink-0 border-t border-line p-3 md:px-6">
            {sendError !== null && (
              <p role="alert" className="mb-2 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
                {sendError}
              </p>
            )}
            <div className="flex items-end gap-2">
              <label htmlFor="chat-message" className="sr-only">
                Message
              </label>
              <textarea
                id="chat-message"
                ref={composer}
                value={draft}
                rows={1}
                maxLength={MESSAGE_MAX_CHARS}
                onChange={(event) => {
                  setDraft(event.target.value);
                  resizeComposer(event.target.value);
                }}
                onKeyDown={onKeyDown}
                placeholder={mode === 'vocabulary_expert' ? 'A word or phrase…' : 'Message…'}
                className="max-h-[200px] min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-base leading-snug text-ink placeholder:text-muted/70"
              />
              <button
                type="submit"
                disabled={sending || draft.trim() === ''}
                aria-label="Send message"
                className={`${BUTTON_PRIMARY} size-11 shrink-0 px-0`}
              >
                {sending ? <Spinner /> : <Icon name="right" className="size-5" />}
              </button>
            </div>
            <p className="mt-1.5 hidden text-xs text-muted keyboard:block">Enter to send · Shift+Enter for a new line</p>
          </form>
        )}
      </section>

      {confirmDelete !== null && (
        <ConfirmDialog
          title="Delete this conversation?"
          confirmLabel="Delete"
          tone="danger"
          busy={deleting.busy}
          error={deleting.error}
          onConfirm={() => void deleteConversation()}
          onCancel={() => setConfirmDelete(null)}
        >
          “{confirmDelete.title}” and all its messages will be deleted. This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}

function Intro({ mode }: { mode: AiMode }) {
  return (
    <div className="m-auto max-w-sm px-4 py-8 text-center">
      <Icon name="chat" className="mx-auto mb-3 size-10 text-muted/40" />
      <p className="font-serif text-lg font-semibold">{MODE_LABEL[mode]}</p>
      <p className="mt-1 text-sm text-muted">{MODE_HINT[mode]}</p>
    </div>
  );
}

function MessageBubble({
  message,
  pending,
  expert,
  conversationId,
  onSaved,
}: {
  message: AiMessage;
  pending: boolean;
  /** A Vocabulary Expert conversation: its replies can be added to the bank. */
  expert: boolean;
  conversationId: string;
  onSaved: (messageId: string, vocabularyId: string) => void;
}) {
  const mine = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Copying can be refused by the browser; the text is still there to select.
    }
  };

  const copyButton = (
    <button
      type="button"
      onClick={() => void copy()}
      className="cursor-pointer rounded-lg px-1.5 py-0.5 text-xs text-muted hover:bg-line/40 hover:text-ink"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-testid={`message-${message.role}`}>
      <div className={`flex min-w-0 max-w-[88%] flex-col gap-1 md:max-w-[75%] ${mine ? 'items-end' : 'items-start'}`}>
        <div
          className={`min-w-0 max-w-full rounded-2xl px-4 py-2.5 text-sm ${
            mine ? 'whitespace-pre-wrap wrap-anywhere rounded-br-md bg-accent text-white dark:text-paper' : 'rounded-bl-md border border-line bg-surface'
          }`}
        >
          {mine ? (
            message.content
          ) : (
            <>
              {pending && <ThinkingIndicator messageId={message.id} streaming={message.content !== ''} />}
              {message.content !== '' && <Markdown content={message.content} />}
            </>
          )}
        </div>
        {!mine && message.content !== '' && !pending && (
          expert ? (
            <AddWordActions
              message={message}
              conversationId={conversationId}
              savedVocabularyId={savedIdOf(message)}
              onSaved={onSaved}
            >
              {copyButton}
            </AddWordActions>
          ) : (
            copyButton
          )
        )}
      </div>
    </div>
  );
}
