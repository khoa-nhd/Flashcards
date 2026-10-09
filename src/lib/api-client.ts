import type { ZodType } from 'zod';
import {
  apiErrorSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  type QueueResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
} from '../../shared/api.js';
import { TIMEOUTS } from '../config.js';

/** Any failed request, reduced to a stable `code` and a message fit for the reviewer. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ReviewApi {
  fetchQueue(): Promise<QueueResponse>;
  submitAction(request: ReviewActionRequest): Promise<ReviewActionResponse>;
  login(password: string): Promise<void>;
}

async function request<T>(
  path: string,
  schema: ZodType<T> | null,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number; timeoutMessage: string },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);

  try {
    let response: Response;
    let body: unknown = null;
    try {
      response = await fetch(path, {
        method: init.method,
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      body = await response.json().catch(() => null);
    } catch {
      if (controller.signal.aborted) throw new ApiError('timeout', init.timeoutMessage);
      throw new ApiError('network', 'Could not reach the server. Check your connection.');
    }

    if (!response.ok) {
      const error = apiErrorSchema.safeParse(body);
      throw new ApiError(
        error.success ? error.data.error.code : 'http_error',
        error.success ? error.data.error.message : `The server responded with an error (${response.status}).`,
        response.status,
      );
    }

    if (schema === null) return undefined as T;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError('invalid_response', 'The server sent a response this app does not understand.', response.status);
    }
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}

export const reviewApi: ReviewApi = {
  fetchQueue: () =>
    request('/api/review-queue', queueResponseSchema, {
      method: 'GET',
      timeoutMs: TIMEOUTS.queueMs,
      timeoutMessage: 'Loading the review queue took too long.',
    }),

  submitAction: (body) =>
    request('/api/review-action', reviewActionResponseSchema, {
      method: 'POST',
      body,
      timeoutMs: TIMEOUTS.actionMs,
      // The answer may have landed. Retrying is safe: the server checks before writing again.
      timeoutMessage:
        'No confirmation arrived in time, so this answer may or may not be saved. Retry checks first and never applies it twice.',
    }),

  login: (password) =>
    request<void>('/api/login', null, {
      method: 'POST',
      body: { password },
      timeoutMs: TIMEOUTS.loginMs,
      timeoutMessage: 'Signing in took too long.',
    }),
};
