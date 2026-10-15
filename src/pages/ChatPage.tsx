/**
 * General AI Chat page: conversation list, message thread, and composer.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '../app-context.js';
import { Spinner } from '../components/Spinner.js';
import { Icon } from '../components/Icon.js';
import { ROUTES, navigate, useLocation, buildHref } from '../lib/router.js';
import type { AiConversation, AiMessage, AiStreamChunk } from '../lib/api-client.js';
import type { AiMode } from '../../shared/api.js';
import { Markdown } from '../components/Markdown.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';

const MESSAGE_MAX_CHARS = 32000;
const COMPOSER_MIN_HEIGHT = 56;
const COMPOSER_MAX_HEIGHT = 200;

export function ChatPage() {
  const { api } = useApp();
  const location = useLocation();
  const conversationId = location.query.get('conversation');
  const modeFromQuery = location.query.get('mode');
  const initialMode = (modeFromQuery === 'general' || modeFromQuery === 'vocabulary_expert') ? modeFromQuery : 'general';

  const [mode, setMode] = useState<AiMode>(initialMode);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [currentConversation, setCurrentConversation] = useState<AiConversation | null>(null);
  const [composerValue, setComposerValue] = useState('');
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userHasScrolledRef = useRef(false);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, []);

  // Load conversation when ID changes
  useEffect(() => {
    if (conversationId) {
      loadConversation(conversationId);
    } else {
      setCurrentConversation(null);
      setMessages([]);
    }
  }, [conversationId]);

  // Auto-scroll to bottom when new messages arrive (unless user scrolled up)
  useEffect(() => {
    if (!userHasScrolledRef.current && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isStreaming]);

  // Handle composer height
  const adjustComposerHeight = useCallback(() => {
    if (!composerRef.current) return;
    const textarea = composerRef.current;
    textarea.style.height = 'auto';
    const newHeight = Math.min(Math.max(textarea.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
    textarea.style.height = `${newHeight}px`;
    setComposerHeight(newHeight);
  }, []);

  // Track scroll position for auto-scroll behavior
  const handleMessagesScroll = useCallback(() => {
    if (!messagesContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    userHasScrolledRef.current = !isAtBottom;
  }, []);

  const loadConversations = async () => {
    try {
      const response = await api.listConversations(50, 0);
      setConversations(response.conversations.filter(c => c.mode === mode));
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  };

  const loadConversation = async (id: string) => {
    setIsLoading(true);
    setStreamError(null);
    try {
      const response = await api.getConversation(id, 200, 0);
      if (response.conversation.mode !== mode) {
        setCurrentConversation(null);
        setMessages([]);
        return;
      }
      setCurrentConversation(response.conversation);
      setMessages(response.messages);
      userHasScrolledRef.current = false;
    } catch (error) {
      console.error('Failed to load conversation:', error);
      setStreamError('Failed to load conversation');
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewConversation = async () => {
    const response = await api.createConversation(mode, 'New conversation');
    const newId = response.id;
    navigate(buildHref(ROUTES.chat, { conversation: newId, mode }));
    setConversations([response, ...conversations]);
  };

  const handleDeleteConversation = async (id: string, title: string) => {
    setConfirmDelete({ id, title });
  };

  const confirmDeleteConversation = async () => {
    if (!confirmDelete) return;
    await api.deleteConversation(confirmDelete.id);
    setConversations((prev) => prev.filter((c) => c.id !== confirmDelete.id));
    if (currentConversation?.id === confirmDelete.id) {
      navigate(ROUTES.chat);
    }
    setConfirmDelete(null);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!composerValue.trim() || isStreaming || !currentConversation) return;

    const content = composerValue.trim();
    setComposerValue('');
    adjustComposerHeight();

    // Optimistically add user message
    const tempUserMessage: AiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMessage]);
    userHasScrolledRef.current = false;

    setIsStreaming(true);
    setStreamError(null);

    const assistantMessageId = crypto.randomUUID();

    try {
      const stream = await api.sendMessage(currentConversation.id, content);
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      let assistantMetadata: Record<string, unknown> = {};

      // Optimistically add assistant message placeholder
      setMessages((prev) => [...prev, { id: assistantMessageId, role: 'assistant', content: '', metadata: {}, createdAt: new Date().toISOString() }]);
      userHasScrolledRef.current = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6)) as AiStreamChunk;
            if (data.type === 'delta') {
              assistantContent += data.delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessageId ? { ...m, content: assistantContent } : m
                )
              );
            } else if (data.type === 'done') {
              assistantMetadata = data.usage
                ? { usage: data.usage, finish_reason: data.finishReason }
                : {};
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessageId ? { ...m, metadata: assistantMetadata } : m
                )
              );
            } else if (data.type === 'error') {
              setStreamError(data.message);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      // Update conversation list with latest timestamp
      setConversations((prev) =>
        prev.map((c) =>
          c.id === currentConversation.id ? { ...c, updatedAt: new Date().toISOString() } : c
        )
      );
    } catch (error) {
      console.error('Stream error:', error);
      setStreamError('Failed to send message');
      // Remove the failed assistant message
      setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e as unknown as React.FormEvent);
    }
  };

  const handleComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value.slice(0, MESSAGE_MAX_CHARS);
    setComposerValue(value);
    adjustComposerHeight();
  };

  const copyMessage = async (content: string) => {
    await navigator.clipboard.writeText(content);
    // Could show a toast here
  };

  const handleRetry = () => {
    if (messages.length === 0) return;
    const lastAssistantIndex = messages.findLastIndex((m) => m.role === 'assistant');
    if (lastAssistantIndex === -1) return;
    // Remove the failed assistant message and re-send the last user message
    const lastUserMessage = messages.findLast((m) => m.role === 'user');
    if (!lastUserMessage) return;
    setMessages((prev) => prev.slice(0, lastAssistantIndex));
    setComposerValue(lastUserMessage.content);
    adjustComposerHeight();
    // Trigger send on next tick
    setTimeout(() => handleSend({ preventDefault: () => {} } as React.FormEvent), 0);
  };

  const handleSaveVocabulary = async (assistantMessageContent: string) => {
    if (!currentConversation) return;
    
    try {
      const stream = await api.sendMessage(currentConversation.id, `Save this vocabulary analysis: ${assistantMessageContent}`);
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      // We just need to confirm the save was successful
      let confirmed = false;
      while (!confirmed) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value, { stream: true }).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6)) as AiStreamChunk;
            if (data.type === 'done' || data.type === 'error') {
              // Save confirmed
              confirmed = true;
              break;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } catch (error) {
      console.error('Failed to save vocabulary:', error);
      // Could show an error toast here
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Mobile header */}
      <header className="md:hidden flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold tracking-tight">AI Chat</h1>
          <select
            value={mode}
            onChange={(e) => {
              const newMode = e.target.value as AiMode;
              setMode(newMode);
              navigate(buildHref(ROUTES.chat, { mode: newMode }));
            }}
            className="h-8 cursor-pointer rounded-full border border-line bg-surface px-3 text-sm font-medium text-muted"
          >
            <option value="general">General</option>
            <option value="vocabulary_expert">Vocabulary Expert</option>
          </select>
        </div>
        <button
          type="button"
          className="p-2 rounded-lg text-muted hover:bg-line/40"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        >
          <Icon name={sidebarOpen ? 'left' : 'list'} className="size-5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Conversation sidebar */}
        <aside
          className={`md:flex md:w-80 shrink-0 flex-col border-r border-line bg-surface/50 transition-transform duration-200 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          aria-label="Conversations"
        >
          <div className="flex items-center justify-between gap-2 p-3 border-b border-line">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-sm">Conversations</h2>
              <select
                value={mode}
                onChange={(e) => {
                  const newMode = e.target.value as AiMode;
                  setMode(newMode);
                  navigate(buildHref(ROUTES.chat, { mode: newMode }));
                }}
                className="h-8 cursor-pointer rounded-full border border-line bg-surface px-3 text-sm font-medium text-muted"
              >
                <option value="general">General</option>
                <option value="vocabulary_expert">Vocabulary Expert</option>
              </select>
            </div>
            <button
              type="button"
              onClick={handleNewConversation}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-3 text-sm font-medium text-white dark:text-paper"
            >
              <Icon name="add" className="size-4" />
              <span className="hidden sm:inline">New</span>
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto p-2">
            {conversations.length === 0 ? (
              <p className="text-center text-sm text-muted py-8">
                {mode === 'vocabulary_expert' ? 'No vocabulary conversations yet. Ask me about any word!' : 'No conversations yet'}
              </p>
            ) : (
              <ul className="flex flex-col gap-1" role="list">
                {conversations.map((conv) => (
                  <li key={conv.id}>
                    <button
                      type="button"
                      onClick={() => navigate(buildHref(ROUTES.chat, { conversation: conv.id }))}
                      className={`w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm font-medium text-left transition ${
                        currentConversation?.id === conv.id
                          ? 'bg-accent-soft text-accent'
                          : 'text-muted hover:bg-line/40 hover:text-ink'
                      }`}
                    >
                      <span className="truncate flex-1">{conv.title || 'Untitled'}</span>
                      <span className="text-xs text-muted whitespace-nowrap">
                        {new Date(conv.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
        </aside>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/50"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Main chat area */}
        <main className="flex min-w-0 flex-1 flex-col md:flex-row">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Conversation header */}
            <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2 shrink-0">
              <div className="flex min-w-0 items-center gap-2">
                <Icon name="chat" className="size-5 text-accent" />
                <h1 className="truncate text-base font-semibold tracking-tight">
                  {currentConversation?.title || 'Select a conversation'}
                </h1>
                {currentConversation && (
                  <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent capitalize">
                    {currentConversation.mode.replace('_', ' ')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {currentConversation && (
                  <button
                    type="button"
                    onClick={() => handleDeleteConversation(currentConversation.id, currentConversation.title)}
                    className="p-2 rounded-lg text-muted hover:bg-line/40 hover:text-bad"
                    aria-label="Delete conversation"
                  >
                    <Icon name="trash" className="size-4" />
                  </button>
                )}
              </div>
            </header>

            {/* Messages */}
            <div
              ref={messagesContainerRef}
              onScroll={handleMessagesScroll}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 gap-4"
            >
              {isLoading && (
                <div className="flex items-center justify-center gap-2 text-muted py-8">
                  <Spinner className="size-5" />
                  Loading conversation…
                </div>
              )}

              {messages.length === 0 && !isLoading && !isStreaming && (
                <div className="flex flex-1 items-center justify-center text-center px-6">
                  <div className="max-w-md">
                    <Icon name="chat" className="mx-auto size-12 text-muted/30 mb-4" />
                    <h2 className="font-serif text-xl font-semibold mb-2">Start a conversation</h2>
                    <p className="text-muted text-sm">
                      {mode === 'vocabulary_expert'
                        ? 'Ask me about any English word, phrase, or expression — I\'ll give you a detailed analysis with definitions, examples, collocations, and more.'
                        : 'Ask me anything — programming, math, writing, translation, or just chat.'}
                    </p>
                  </div>
                </div>
              )}

              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  mode={mode}
                  conversationId={conversationId}
                  onCopy={() => copyMessage(msg.content)}
                  onSaveVocabulary={handleSaveVocabulary}
                />
              ))}

              {isStreaming && messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' && (
                <div className="flex items-center gap-2 text-xs text-muted py-2">
                  <Spinner className="size-4" />
                  <span>Generating…</span>
                </div>
              )}

              {streamError && (
                <div className="flex items-center justify-center gap-2 text-sm text-bad-ink bg-bad-soft rounded-xl px-3 py-2">
                  <Icon name="warning" className="size-4 flex-shrink-0" />
                  <span>{streamError}</span>
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="ml-2 text-sm font-semibold text-bad-ink hover:underline"
                  >
                    Retry
                  </button>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <form onSubmit={handleSend} className="shrink-0 border-t border-line p-4">
              <div className="relative">
                <textarea
                  ref={composerRef}
                  value={composerValue}
                  onChange={handleComposerChange}
                  onKeyDown={handleKeyDown}
                  placeholder={isStreaming ? 'Waiting for response…' : mode === 'vocabulary_expert' ? 'Enter a word or phrase to analyze (Enter to send, Shift+Enter for new line)' : 'Message (Enter to send, Shift+Enter for new line)'}
                  disabled={isStreaming || !currentConversation}
                  rows={1}
                  className={`w-full resize-none rounded-2xl border border-line bg-surface px-4 py-3 text-base font-normal transition focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed ${composerHeight > COMPOSER_MIN_HEIGHT ? 'min-h-[100px]' : ''}`}
                  style={{ height: `${composerHeight}px` }}
                  aria-label="Message"
                />
                {!isStreaming && currentConversation && composerValue.trim() && (
                  <button
                    type="submit"
                    className="absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-white disabled:opacity-50"
                    aria-label="Send message"
                  >
                    <Icon name="right" className="size-4" />
                  </button>
                )}
              </div>
              <p className="mt-2 text-xs text-muted text-center">
                {composerValue.length} / {MESSAGE_MAX_CHARS}
              </p>
            </form>
          </div>
        </main>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          onCancel={() => setConfirmDelete(null)}
          onConfirm={confirmDeleteConversation}
          title="Delete conversation"
          children={`Are you sure you want to delete "${confirmDelete?.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          tone="danger"
        />
      )}
    </div>
  );
}

function MessageBubble({
  message,
  onCopy,
  mode,
  conversationId,
  onSaveVocabulary,
}: {
  message: AiMessage;
  onCopy: () => void;
  mode: AiMode;
  conversationId: string | null;
  onSaveVocabulary?: (content: string) => Promise<void>;
}) {
  const isUser = message.role === 'user';
  const isVocabularyExpert = mode === 'vocabulary_expert';
  const isLastAssistantMessage = !isUser;

  return (
    <div
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}
      data-testid={`message-${message.role}`}
    >
      {!isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name="chat" className="size-4" />
        </div>
      )}
      <div className={`flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
        <div
          className={`inline-block max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? 'bg-accent text-white dark:text-paper rounded-tr-sm'
              : 'bg-surface border border-line rounded-tl-sm'
          }`}
        >
          <Markdown content={message.content} />
        </div>
        <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted">
          {!isUser && (
            <>
              <button
                type="button"
                onClick={onCopy}
                className="p-1 rounded-lg hover:bg-line/40"
                aria-label="Copy response"
                title="Copy"
              >
                <Icon name="table" className="size-3.5" />
              </button>
              {isVocabularyExpert && isLastAssistantMessage && conversationId && onSaveVocabulary && (
                <button
                  type="button"
                  onClick={() => onSaveVocabulary(message.content)}
                  className="p-1 rounded-lg hover:bg-line/40"
                  aria-label="Save to Vocabulary Bank"
                  title="Save to Vocabulary Bank"
                >
                  <Icon name="bank" className="size-3.5" />
                </button>
              )}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            </>
          )}
        </div>
      </div>
      {isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white">
          <Icon name="check" className="size-4" />
        </div>
      )}
    </div>
  );
}

export { ROUTES, buildHref, navigate } from '../lib/router.js';