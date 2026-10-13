/**
 * The one place a language model is asked anything. A system prompt, a user
 * prompt and a schema go in; a value that satisfies the schema comes out.
 * Nothing here knows which feature asked, and no key ever leaves this server:
 * the browser sends text and receives the parsed answer, nothing else.
 *
 * The model is spoken to through its OpenAI-compatible chat endpoint, so the
 * provider is a setting (AI_BASE_URL, AI_MODEL, AI_API_KEY), not a choice
 * baked into any feature. Every way a call can fail is named in `AiFailure`,
 * so the features can fall back to doing the work by hand.
 */
import { z } from 'zod';

/** Why a call did not produce an answer. Each one means "carry on without the model". */
export type AiFailure = 'not_configured' | 'timeout' | 'rate_limited' | 'invalid_output' | 'unavailable';

export class AiError extends Error {
  constructor(
    readonly failure: AiFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface AiConfig {
  /** The provider's OpenAI-compatible endpoint, ending in "/". */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** How long to wait before giving up. Ours to time out, not the platform's. */
  timeoutMs: number;
}

export interface AiCall {
  system: string;
  prompt: string;
  /** A firm ceiling on the reply, so a runaway answer cannot spend the budget. */
  maxOutputTokens?: number;
}

/** Injectable so tests never reach the network. */
export type FetchJson = (url: string, init: RequestInit) => Promise<Response>;

export interface AiAdapter {
  ask<T>(call: AiCall, schema: z.ZodType<T>): Promise<T>;
}

/** The JSON object a chat reply must carry, as a plain record. */
const replyBody = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

/** A reply sometimes arrives wrapped in a fenced code block even when JSON was asked for. */
function unwrapped(content: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content.trim());
  return (fenced?.[1] ?? content).trim();
}

export function createAiAdapter(config: AiConfig | null, fetchJson: FetchJson = (url, init) => fetch(url, init)): AiAdapter {
  return {
    async ask<T>(call: AiCall, schema: z.ZodType<T>): Promise<T> {
      if (config === null) {
        throw new AiError('not_configured', 'No language model is configured: AI_API_KEY is not set.');
      }

      let response: Response;
      try {
        response = await fetchJson(`${config.baseUrl}chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            ...(call.maxOutputTokens === undefined ? {} : { max_tokens: call.maxOutputTokens }),
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: call.system },
              { role: 'user', content: call.prompt },
            ],
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw timedOut
          ? new AiError('timeout', `The language model did not answer within ${config.timeoutMs}ms.`)
          : new AiError('unavailable', `The language model could not be reached: ${String(error)}`);
      }

      if (response.status === 429) {
        throw new AiError('rate_limited', 'The language model is rate-limiting this account. Try again shortly.');
      }
      if (!response.ok) throw new AiError('unavailable', `The language model answered with status ${response.status}.`);

      let body: unknown;
      try {
        body = replyBody.parse(await response.json());
      } catch {
        throw new AiError('invalid_output', 'The language model reply was not the expected JSON envelope.');
      }

      const content = (body as z.infer<typeof replyBody>).choices[0]!.message.content;
      let decoded: unknown;
      try {
        decoded = JSON.parse(unwrapped(content));
      } catch {
        throw new AiError('invalid_output', 'The language model reply was not valid JSON.');
      }
      const checked = schema.safeParse(decoded);
      if (!checked.success) {
        throw new AiError('invalid_output', `The language model reply did not match the shape asked for: ${checked.error.message}`);
      }
      return checked.data;
    },
  };
}
