import type { ZodType } from 'zod';
import {
  accountSettingsSchema,
  apiErrorSchema,
  appConfigResponseSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  trashResponseSchema,
  vocabularyListResponseSchema,
  type AccountSettings,
  type AppConfigResponse,
  type CreateEntryInput,
  type QueueResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type UpdateEntryInput,
  type VocabularyEntry,
  type VocabularyListResponse,
} from '../../shared/api.js';
import { TIMEOUTS } from '../config.js';

/** Any failed request, reduced to a stable `code` and a message fit for the reviewer. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | null = null,
    /** Existing words, when a create or rename was refused as a duplicate. */
    public readonly duplicates: VocabularyEntry[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ReviewApi {
  fetchQueue(): Promise<QueueResponse>;
  submitAction(request: ReviewActionRequest): Promise<ReviewActionResponse>;
}

export interface VocabularyApi {
  fetchVocabulary(): Promise<VocabularyListResponse>;
  fetchEntry(id: string): Promise<VocabularyEntry>;
  createEntry(input: CreateEntryInput): Promise<VocabularyEntry>;
  updateEntry(id: string, input: UpdateEntryInput): Promise<VocabularyEntry>;
  /** Moves the word to the trash, from which it can be restored. */
  deleteEntry(id: string): Promise<void>;
  restoreEntry(id: string): Promise<VocabularyEntry>;
  /** Deleted words that can still be restored. */
  fetchTrash(): Promise<VocabularyEntry[]>;
}

export interface AccountApi {
  fetchSettings(): Promise<AccountSettings>;
  saveSettings(input: { timeZone: string }): Promise<AccountSettings>;
}

export type AppApi = ReviewApi & VocabularyApi & AccountApi;

/** How requests prove who is asking, where the app has accounts. */
export interface ApiAuth {
  /** A current access token, or `null` when nobody is signed in. */
  token(options?: { forceRefresh?: boolean }): Promise<string | null>;
  /** The server refused a freshly renewed token: the session is over. */
  onRejected(): void;
}

interface CallOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMs: number;
  timeoutMessage: string;
}

const SIGNED_OUT_MESSAGE = 'Your session has ended. Sign in again to continue.';

function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

async function request<T>(path: string, schema: ZodType<T> | null, init: CallOptions, auth: ApiAuth | null): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);

  const send = async (token: string | null) => {
    const zone = token === null ? null : deviceTimeZone();
    const response = await fetch(path, {
      method: init.method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        // Only gives a brand-new account its starting time zone; a stored one always wins.
        ...(zone === null ? {} : { 'X-Time-Zone': zone }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { response, body: (await response.json().catch(() => null)) as unknown };
  };

  const signedOut = () => {
    auth?.onRejected();
    return new ApiError('unauthorized', SIGNED_OUT_MESSAGE, 401);
  };

  try {
    let response: Response;
    let body: unknown = null;
    try {
      let token = auth === null ? null : await auth.token();
      if (auth !== null && token === null) throw signedOut();
      ({ response, body } = await send(token));

      // A refused token is renewed once and the request repeated. Nothing was
      // processed the first time, so repeating it cannot apply a change twice.
      if (auth !== null && response.status === 401) {
        token = await auth.token({ forceRefresh: true });
        if (token === null) throw signedOut();
        ({ response, body } = await send(token));
        if (response.status === 401) throw signedOut();
      }
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      if (controller.signal.aborted) throw new ApiError('timeout', init.timeoutMessage);
      throw new ApiError('network', 'Could not reach the server. Check your connection.');
    }

    if (!response.ok) {
      const error = apiErrorSchema.safeParse(body);
      throw new ApiError(
        error.success ? error.data.error.code : 'http_error',
        error.success ? error.data.error.message : `The server responded with an error (${response.status}).`,
        response.status,
        error.success ? (error.data.duplicates ?? []) : [],
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

const SAVE_TIMEOUT_MESSAGE =
  'No confirmation arrived in time, so this change may or may not be saved. Check the word before trying again.';

/** How the app should let people in. Public: asked before anyone is signed in. */
export function fetchAppConfig(): Promise<AppConfigResponse> {
  return request(
    '/api/config',
    appConfigResponseSchema,
    { method: 'GET', timeoutMs: TIMEOUTS.quickMs, timeoutMessage: 'Starting the app took too long.' },
    null,
  );
}

/** `auth` is given where the app has accounts; every request is then made as the signed-in user. */
export function createAppApi(auth: ApiAuth | null = null): AppApi {
  const call = <T>(path: string, schema: ZodType<T> | null, init: CallOptions) => request(path, schema, init, auth);

  const entry = (path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown, timeoutMessage = SAVE_TIMEOUT_MESSAGE) =>
    call(path, entryResponseSchema, { method, body, timeoutMs: TIMEOUTS.actionMs, timeoutMessage }).then(
      (response) => response.entry,
    );

  return {
    fetchQueue: () =>
      call('/api/review-queue', queueResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading the review queue took too long.',
      }),

    submitAction: (body) =>
      call('/api/review-action', reviewActionResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        // The answer may have landed. Retrying is safe: the server checks before writing again.
        timeoutMessage:
          'No confirmation arrived in time, so this answer may or may not be saved. Retry checks first and never applies it twice.',
      }),

    fetchVocabulary: () =>
      call('/api/vocabulary', vocabularyListResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading your vocabulary took too long.',
      }),

    fetchEntry: (id) => entry(`/api/vocabulary/${id}`, 'GET', undefined, 'Loading the word took too long.'),

    // Sending the same request again is safe: its request id makes the server return the first result.
    createEntry: (input) => entry('/api/vocabulary', 'POST', input),

    updateEntry: (id, input) => entry(`/api/vocabulary/${id}`, 'PATCH', input),

    deleteEntry: (id) =>
      call<void>(`/api/vocabulary/${id}`, null, {
        method: 'DELETE',
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),

    restoreEntry: (id) => entry(`/api/vocabulary/${id}/restore`, 'POST'),

    fetchTrash: () =>
      call('/api/trash', trashResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading deleted words took too long.',
      }).then((response) => response.entries),

    fetchSettings: () =>
      call('/api/settings', accountSettingsSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.quickMs,
        timeoutMessage: 'Loading your settings took too long.',
      }),

    saveSettings: (body) =>
      call('/api/settings', accountSettingsSchema, {
        method: 'PUT',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),
  };
}

/** The API for the built-in sample words, which need no account. */
export const appApi: AppApi = createAppApi();
