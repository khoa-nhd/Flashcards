import type { ZodType } from 'zod';
import {
  accountSettingsSchema,
  analyticsResponseSchema,
  apiErrorSchema,
  appConfigResponseSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  reviewUndoResponseSchema,
  schedulerReportSchema,
  sessionSummarySchema,
  trashResponseSchema,
  vocabularyListResponseSchema,
  weakWordsResponseSchema,
  type AccountSettings,
  type AnalyticsResponse,
  type AppConfigResponse,
  type CreateEntryInput,
  type QueueResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type ReviewUndoRequest,
  type ReviewUndoResponse,
  type SchedulerReport,
  type SessionSummary,
  type UpdateEntryInput,
  type VocabularyEntry,
  type VocabularyListResponse,
  type WeakWordsResponse,
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
  /** The due cards. With a focus, only the due cards that match it. */
  fetchQueue(options?: { focus?: 'weak' | null }): Promise<QueueResponse>;
  submitAction(request: ReviewActionRequest): Promise<ReviewActionResponse>;
  /** Takes back one saved answer. */
  undoAction(request: ReviewUndoRequest): Promise<ReviewUndoResponse>;
  /** What a session saved, as the server has it. */
  fetchSessionSummary(sessionId: string): Promise<SessionSummary>;
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
  saveSettings(input: { timeZone?: string; fsrsRetention?: number }): Promise<AccountSettings>;
  /** The schedule in force beside FSRS, which is only calculated for comparison. */
  fetchScheduler(): Promise<SchedulerReport>;
}

export interface AnalyticsApi {
  /** Review activity from saved answers. */
  fetchAnalytics(): Promise<AnalyticsResponse>;
  /** Words that need attention, weakest first, each with its reasons. */
  fetchWeakWords(): Promise<WeakWordsResponse>;
}

export type AppApi = ReviewApi & VocabularyApi & AccountApi & AnalyticsApi;

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
    fetchQueue: (options) =>
      call(options?.focus == null ? '/api/review-queue' : '/api/review-queue?focus=' + options.focus, queueResponseSchema, {
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

    undoAction: (body) =>
      call('/api/review-undo', reviewUndoResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        // Pressing Undo again repeats the same request, which the server applies at most once.
        timeoutMessage: 'No confirmation arrived in time, so the answer may or may not have been undone. Try Undo again.',
      }),

    fetchSessionSummary: (sessionId) =>
      call(`/api/sessions/${sessionId}/summary`, sessionSummarySchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.quickMs,
        timeoutMessage: 'Loading the session summary took too long.',
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

    fetchAnalytics: () =>
      call('/api/analytics', analyticsResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading your review activity took too long.',
      }),

    fetchWeakWords: () =>
      call('/api/weak-words', weakWordsResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading your weak words took too long.',
      }),

    fetchScheduler: () =>
      call('/api/scheduler', schedulerReportSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading the schedule comparison took too long.',
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
