/**
 * AI Chat through the real routes, account sessions, schema and Row Level
 * Security. Only the AI provider is replaced: \`fetch\` answers as an
 * OpenAI-compatible endpoint would, so nothing leaves the machine.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiConversationSchema, aiMessageSchema, apiErrorSchema } from '../../shared/api.js';
import { call, createSupabaseTestApp, createTestUser, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const AI_ENV = {
  AI_PROVIDER: 'openai',
  AI_MODEL: 'test-model',
  AI_API_KEY: 'test-key-not-real',
  AI_BASE_URL: 'https://ai.example.test/v1/',
};

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;
let app: TestApp;
let provider: ReturnType<typeof vi.fn>;

/** An OpenAI-style streamed reply, cut into pieces mid-line. */
function streamedReply(pieces: string[]): Response {
  const body =
    pieces.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join('') +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(body);
  const half = Math.floor(bytes.length / 2);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, half));
        controller.enqueue(bytes.slice(half));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

/** The events a reply was sent as. */
async function eventsOf(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

async function newConversation(user: TestUser, mode = 'general') {
  const response = await call(app, user, '/api/ai/conversations', { method: 'POST', body: { mode, title: 'New conversation' } });
  expect(response.status).toBe(201);
  return aiConversationSchema.parse(((await response.json()) as { conversation: unknown }).conversation);
}

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  for (const [name, value] of Object.entries(AI_ENV)) vi.stubEnv(name, value);
  provider = vi.fn(async () => streamedReply(['Hel', 'lo ', '**there**']));
  vi.stubGlobal('fetch', provider);
  await db.admin('delete from auth.users');
  alice = await createTestUser(db, 'alice');
  bob = await createTestUser(db, 'bob');
  app = createSupabaseTestApp(db, [alice, bob]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Collects the provider-failure lines the server logs, keeping them out of the test output. */
function captureServerErrors() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return {
    providerFailures: () =>
      spy.mock.calls.map(([first]) => String(first)).filter((line) => line.startsWith('AI provider failure')),
    all: () => spy.mock.calls.map(([first]) => String(first)),
  };
}

describe('AI chat API', () => {
  it('lists, creates and opens conversations in the shapes the page reads', async () => {
    const created = await newConversation(alice);
    expect(created.mode).toBe('general');

    const list = await call(app, alice, '/api/ai/conversations?limit=50&offset=0');
    expect(list.status).toBe(200);
    const { conversations } = (await list.json()) as { conversations: unknown[] };
    expect(conversations.map((item) => aiConversationSchema.parse(item).id)).toEqual([created.id]);

    const opened = await call(app, alice, `/api/ai/conversations/${created.id}?limit=200&offset=0`);
    expect(opened.status).toBe(200);
    const body = (await opened.json()) as { conversation: unknown; messages: unknown[] };
    expect(aiConversationSchema.parse(body.conversation).id).toBe(created.id);
    expect(body.messages).toEqual([]);
  });

  it('streams the reply as typed events, keeps the exchange, and names the conversation', async () => {
    const { id } = await newConversation(alice);
    const response = await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Say hello' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = await eventsOf(response);
    expect(events.filter((event) => event.type === 'delta').map((event) => event.delta).join('')).toBe('Hello **there**');
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' });

    // The provider got the conversation, at the address without a doubled slash, with the key in a header only.
    const [url, init] = provider.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ai.example.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key-not-real');
    const sent = JSON.parse(String(init.body)) as { model: string; stream: boolean; messages: Array<{ role: string; content: string }> };
    expect(sent.model).toBe('test-model');
    expect(sent.stream).toBe(true);
    expect(sent.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(Object.keys(sent.messages[1]!).sort()).toEqual(['content', 'role']);

    const opened = (await (await call(app, alice, `/api/ai/conversations/${id}`)).json()) as {
      conversation: { title: string };
      messages: unknown[];
    };
    const messages = opened.messages.map((message) => aiMessageSchema.parse(message));
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello **there**'],
    ]);
    expect(opened.conversation.title).toBe('Say hello');
  });

  it('sends the earlier messages with the next one', async () => {
    const { id } = await newConversation(alice);
    await eventsOf(await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'First' } }));
    await eventsOf(await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Second' } }));
    const sent = JSON.parse(String((provider.mock.calls[1] as [string, RequestInit])[1].body)) as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages.map((message) => `${message.role}:${message.content}`).slice(1)).toEqual([
      'user:First',
      'assistant:Hello **there**',
      'user:Second',
    ]);
  });

  it('reports a provider failure as an error event and keeps nothing of that exchange', async () => {
    provider.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    const { id } = await newConversation(alice);
    const events = await eventsOf(await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Hi' } }));
    expect(events).toEqual([{ type: 'error', code: 'provider_error', message: expect.stringContaining('refused the key') }]);
    // The key itself is never repeated back.
    expect(JSON.stringify(events)).not.toContain('test-key-not-real');

    const opened = (await (await call(app, alice, `/api/ai/conversations/${id}`)).json()) as { messages: unknown[] };
    expect(opened.messages).toEqual([]);
  });

  it('names a retired model (404) as a model-or-address problem, without retrying it', async () => {
    const logged = captureServerErrors();
    // What Google answers for a model that has been retired, word for word.
    provider.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 404,
            message:
              'This model models/gemini-2.5-flash is no longer available. Please update your code to use a newer model for the latest features and improvements.',
            status: 'NOT_FOUND',
          },
        }),
        { status: 404 },
      ),
    );
    const { id } = await newConversation(alice);
    const events = await eventsOf(await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Hi' } }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'provider_not_found' });
    const message = String(events[0]?.message);
    // It says where to look without pretending to know which is wrong...
    expect(message).toContain('AI_MODEL');
    expect(message).toContain('AI_BASE_URL');
    expect(message).toContain('404');
    // ...and keeps the provider's own words.
    expect(message).toContain('no longer available');

    // A permanent failure is never retried automatically.
    expect(provider).toHaveBeenCalledTimes(1);

    // The failed exchange is not kept, so sending again does not duplicate it.
    const opened = (await (await call(app, alice, `/api/ai/conversations/${id}`)).json()) as { messages: unknown[] };
    expect(opened.messages).toEqual([]);

    // The log says what failed, where, and never the key.
    const line = logged.providerFailures()[0] ?? '';
    expect(line).toContain('provider=openai');
    expect(line).toContain('model=test-model');
    expect(line).toContain('status=404');
    expect(line).toContain('/v1/chat/completions');
    expect(line).not.toContain('test-key-not-real');
  });

  it('tells a rejected request (400) apart from a missing model (404)', async () => {
    const logged = captureServerErrors();
    provider.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 400 }));
    const { id } = await newConversation(alice);
    const events = await eventsOf(await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Hi' } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'provider_bad_request' });
    expect(String(events[0]?.message)).toContain('HTTP 400');
    expect(logged.providerFailures()[0]).toContain('status=400');
  });

  it('reports rate limiting (429) with its own guidance', async () => {
    provider.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429 }));
    const { id } = await newConversation(alice);
    const events = await eventsOf(await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Hi' } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'provider_unavailable' });
    expect(String(events[0]?.message)).toContain('quota');
  });

  it('reports the provider’s own trouble (5xx) separately from a timeout', async () => {
    const logged = captureServerErrors();
    provider.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'internal error' } }), { status: 503 }));
    const { id } = await newConversation(alice);
    const events = await eventsOf(await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Hi' } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'provider_error' });
    expect(String(events[0]?.message)).toContain('server problem');
    expect(String(events[0]?.message)).toContain('503');
    expect(logged.providerFailures()[0]).toContain('status=503');
  });

  it('says the provider could not be reached rather than failing silently', async () => {
    provider.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const { id } = await newConversation(alice);
    const events = await eventsOf(await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Hi' } }));
    expect(events).toEqual([{ type: 'error', code: 'provider_unavailable', message: 'Could not reach the AI provider.' }]);
  });

  it('refuses a message longer than the server allows, before calling the provider', async () => {
    const { id } = await newConversation(alice);
    const response = await call(app, alice, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'x'.repeat(4001) } });
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('message_too_long');
    expect(provider).not.toHaveBeenCalled();
  });

  it('never shows or answers in another account’s conversation', async () => {
    const { id } = await newConversation(alice);
    expect((await call(app, bob, `/api/ai/conversations/${id}`)).status).toBe(404);
    const send = await call(app, bob, `/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content: 'Hi' } });
    expect(send.status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
    const list = (await (await call(app, bob, '/api/ai/conversations?limit=50&offset=0')).json()) as { conversations: unknown[] };
    expect(list.conversations).toEqual([]);
  });

  it('says AI chat is not set up when the server has no AI settings', async () => {
    vi.unstubAllEnvs();
    for (const name of ['AI_PROVIDER', 'AI_MODEL', 'AI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_BASE_URL']) vi.stubEnv(name, '');
    app = createSupabaseTestApp(db, [alice, bob]);
    const response = await call(app, alice, '/api/ai/conversations?limit=50&offset=0');
    expect(response.status).toBe(503);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('ai_unavailable');
  });
});
