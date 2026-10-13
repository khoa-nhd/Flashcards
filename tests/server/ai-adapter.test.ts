/**
 * The language-model adapter: every way a call can fail has its own name, a
 * reply is only ever handed on after it matches the schema asked for, and no
 * test here touches the network — the fetch is a stand-in.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiError, createAiAdapter, type AiConfig, type AiFailure } from '../../server/ai/adapter.js';
import { createTokenBucket } from '../../server/ai/rate-limit.js';

const CONFIG: AiConfig = { baseUrl: 'https://example.test/v1/', apiKey: 'test-key', model: 'test-model', timeoutMs: 5000 };

/** A chat reply whose content is the given text. */
const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const answer = { example: 'He was candid.', meaning: 'thẳng thắn' };
const schema = z.object({ example: z.string(), meaning: z.string() });
const call = { system: 'system', prompt: 'user' };

const failureOf = (promise: Promise<unknown>): Promise<AiFailure> =>
  promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AiError);
      return (error as AiError).failure;
    },
  );

describe('asking the model', () => {
  it('hands back the answer, once it matches the schema', async () => {
    const adapter = createAiAdapter(CONFIG, async () => reply(JSON.stringify(answer)));
    await expect(adapter.ask(call, schema)).resolves.toEqual(answer);
  });

  it('reads an answer wrapped in a fenced code block', async () => {
    const adapter = createAiAdapter(CONFIG, async () => reply('```json\n' + JSON.stringify(answer) + '\n```'));
    await expect(adapter.ask(call, schema)).resolves.toEqual(answer);
  });

  it('sends the prompts as a system and a user message, and names the model', async () => {
    let sent: RequestInit | undefined;
    const adapter = createAiAdapter(CONFIG, async (_url, init) => {
      sent = init;
      return reply(JSON.stringify(answer));
    });
    await adapter.ask({ system: 'You are a dictionary.', prompt: 'candid' }, schema);
    const body = JSON.parse(String(sent?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a dictionary.' },
      { role: 'user', content: 'candid' },
    ]);
    expect(String((sent?.headers as Record<string, string>).authorization)).toBe('Bearer test-key');
  });

  it('names each failure the way it happened', async () => {
    await expect(failureOf(createAiAdapter(null, async () => reply('{}')).ask(call, schema))).resolves.toBe('not_configured');
    await expect(failureOf(createAiAdapter(CONFIG, async () => reply('{}', 429)).ask(call, schema))).resolves.toBe('rate_limited');
    await expect(failureOf(createAiAdapter(CONFIG, async () => reply('{}', 500)).ask(call, schema))).resolves.toBe('unavailable');
    await expect(
      failureOf(
        createAiAdapter(CONFIG, async () => {
          throw new TypeError('fetch failed');
        }).ask(call, schema),
      ),
    ).resolves.toBe('unavailable');
    await expect(
      failureOf(
        createAiAdapter(CONFIG, async () => {
          throw new DOMException('The operation timed out', 'TimeoutError');
        }).ask(call, schema),
      ),
    ).resolves.toBe('timeout');
    await expect(failureOf(createAiAdapter(CONFIG, async () => reply('not json')).ask(call, schema))).resolves.toBe(
      'invalid_output',
    );
    await expect(
      failureOf(createAiAdapter(CONFIG, async () => reply(JSON.stringify({ example: 1, meaning: null }))).ask(call, schema)),
    ).resolves.toBe('invalid_output');
  });
});

describe('the per-account limit', () => {
  it('allows up to the capacity, then refuses until time earns a token back', () => {
    const limit = createTokenBucket({ capacity: 2, refillMs: 60_000 });
    const at = 1_000_000;
    expect(limit.allow('alice', at)).toBe(true);
    expect(limit.allow('alice', at)).toBe(true);
    expect(limit.allow('alice', at)).toBe(false);
    // Bob has his own bucket.
    expect(limit.allow('bob', at)).toBe(true);
    // A minute later one of Alice's tokens is back: one call, then none again.
    expect(limit.allow('alice', at + 60_000)).toBe(true);
    expect(limit.allow('alice', at + 60_000)).toBe(false);
  });
});
