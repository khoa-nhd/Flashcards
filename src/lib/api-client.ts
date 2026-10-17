import { z, type ZodType } from 'zod';
import {
  accountSettingsSchema,
  aiConversationListResponseSchema,
  aiConversationSchema,
  aiMessageSavedResponseSchema,
  aiMessageSchema,
  analyticsResponseSchema,
  apiErrorSchema,
  collectionSchema,
  dayPlanSchema,
  deletedResponseSchema,
  extraExampleSchema,
  importResponseSchema,
  libraryResponseSchema,
  practiceHistoryResponseSchema,
  practiceMasteryResponseSchema,
  practiceResponseSchema,
  relationSchema,
  appConfigResponseSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  reviewDaysResponseSchema,
  reviewUndoResponseSchema,
  schedulerReportSchema,
  sessionSummarySchema,
  simulationResponseSchema,
  trashResponseSchema,
  vocabularyListResponseSchema,
  weakWordsResponseSchema,
  type AccountSettings,
  type AnalyticsResponse,
  type AiConversation,
  type AiConversationListResponse,
  type AiMessage,
  type AiMessageSavedResponse,
  type DayPlanResponse,
  type ImportResponse,
  type LibraryResponse,
  type PracticeHistoryResponse,
  type PracticeMasteryResponse,
  type PracticeRequest,
  type PracticeResponse,
  type AppConfigResponse,
  type CreateEntryInput,
  type QueueResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type ReviewDaysResponse,
  type ReviewUndoRequest,
  type ReviewUndoResponse,
  type SchedulerReport,
  type SessionSummary,
  type SimulationResponse,
  type UpdateEntryInput,
  type VocabularyEntry,
  type VocabularyListResponse,
  type WeakWordsResponse,
} from '../../shared/api.js';
import type { IsoDate } from '../../shared/dates.js';
import { EXPORT_FORMAT, type AccountExport } from '../../shared/export-format.js';
import type { ImportItem } from '../../shared/import.js';
import type { Collection, ExtraExample, Relation, RelationKind } from '../../shared/library.js';
import type { SchedulerId } from '../../shared/scheduler/active.js';
import type { DailyGoal } from '../../shared/session-planner.js';
import { ALL_SCOPE, type ReviewScope } from './review-scope.js';
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
  /** The due cards, or the narrowing asked for. The reviewer's own picks travel in the body. */
  fetchQueue(options?: { scope?: ReviewScope }): Promise<QueueResponse>;
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
  saveSettings(input: { timeZone?: string; fsrsRetention?: number; countReviewsTowardMastery?: boolean }): Promise<AccountSettings>;
  /** The two schedules side by side, and which of them is in charge. */
  fetchScheduler(): Promise<SchedulerReport>;
  /** Puts one schedule in charge of what is due, and returns the report as it now stands. */
  chooseScheduler(scheduler: SchedulerId): Promise<SchedulerReport>;
  /** A what-if comparison at a target retention (the account's own when none is given). Stores nothing. */
  fetchSimulation(retention?: number): Promise<SimulationResponse>;
}

export interface AnalyticsApi {
  /** Review activity from saved answers. */
  fetchAnalytics(): Promise<AnalyticsResponse>;
  /** Words that need attention, weakest first, each with its reasons. */
  fetchWeakWords(): Promise<WeakWordsResponse>;
  /** Today's reviewing set against the daily goal. */
  fetchPlan(): Promise<DayPlanResponse>;
  /** Stores the goal and returns the plan as it now stands. An empty part means no goal of that kind. */
  saveGoal(goal: DailyGoal): Promise<DayPlanResponse>;
  /** Saved reviews on each day of a range of the reviewer's days. Days without any are absent. */
  fetchReviewDays(from: IsoDate, to: IsoDate): Promise<ReviewDaysResponse>;
}

/** Collections, further examples and relationships. None of these calls can change a word or its schedule. */
export interface LibraryApi {
  fetchLibrary(): Promise<LibraryResponse>;
  createCollection(name: string): Promise<Collection>;
  renameCollection(id: string, name: string): Promise<Collection>;
  /** Removes the collection and its memberships. The words stay. */
  deleteCollection(id: string): Promise<void>;
  setMembership(collectionId: string, wordId: string, member: boolean): Promise<Collection>;
  addExample(wordId: string, input: { sentence: string; source?: string | null; preferred?: boolean }): Promise<ExtraExample>;
  updateExample(id: string, input: { sentence?: string; source?: string | null; preferred?: boolean }): Promise<ExtraExample>;
  deleteExample(id: string): Promise<void>;
  addRelation(fromId: string, toId: string, kind: RelationKind): Promise<Relation>;
  deleteRelation(id: string): Promise<void>;
}

export interface TransferApi {
  /**
   * Imports one request's worth of rows as new words. Each row carries its own
   * request id, so sending the same rows again never imports one twice.
   */
  importWords(items: readonly ImportItem[]): Promise<ImportResponse>;
  /** Everything the account can read about itself, in the documented export format. Reads only. */
  fetchExport(): Promise<AccountExport>;
}

export interface PracticeApi {
  /**
   * Sends one practice answer to be judged and recorded. The reply is the
   * verdict; nothing about a word's schedule can change through this call.
   */
  submitPractice(request: PracticeRequest): Promise<PracticeResponse>;
  /** One word's practice mastery in every study mode. Read-only. */
  fetchPracticeMastery(id: string): Promise<PracticeMasteryResponse>;
  /** Practice history for True Mastery: detailed answers with correctness, timestamps, mode, grading, session. */
  fetchPracticeHistory(since: string | null): Promise<PracticeHistoryResponse>;
}

export interface AiApi {
  /** Lists the user's conversations with pagination. */
  listConversations(limit?: number, offset?: number): Promise<AiConversationListResponse>;
  /** Creates a new conversation. */
  createConversation(mode: 'general' | 'vocabulary_expert', title?: string): Promise<AiConversation>;
  /** Gets a conversation with its messages. */
  getConversation(id: string, limit?: number, offset?: number): Promise<{ conversation: AiConversation; messages: AiMessage[] }>;
  /** Updates a conversation title. */
  updateConversation(id: string, title: string): Promise<void>;
  /** Deletes a conversation. */
  deleteConversation(id: string): Promise<void>;
  /** Sends a message and returns a readable stream of SSE chunks. */
  sendMessage(id: string, content: string): Promise<ReadableStream<Uint8Array>>;
  /**
   * Marks a Vocabulary Expert reply as saved to one word, so the "Added" state
   * survives a reload. Best effort: `saved: false` where the database is older
   * than version 12 and has nowhere to keep the link.
   */
  markMessageSaved(conversationId: string, messageId: string, vocabularyId: string): Promise<AiMessageSavedResponse>;
}

export type { AiConversation, AiMessage, AiStreamChunk, AiConversationListResponse, AiMessageListResponse } from '../../shared/api.js';

export type AppApi = ReviewApi & VocabularyApi & AccountApi & AnalyticsApi & PracticeApi & LibraryApi & TransferApi & AiApi;

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

/**
 * A POST answered with a stream of server-sent events. A refusal before the
 * stream starts arrives as an ordinary JSON error. The timeout covers reaching
 * the server, not the length of the reply, which may take longer to stream.
 */
async function openStream(path: string, body: unknown, timeoutMs: number, auth: ApiAuth | null): Promise<ReadableStream<Uint8Array>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const send = (token: string | null) =>
    fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  const signedOut = () => {
    auth?.onRejected();
    return new ApiError('unauthorized', SIGNED_OUT_MESSAGE, 401);
  };

  let response: Response;
  try {
    let token = auth === null ? null : await auth.token();
    if (auth !== null && token === null) throw signedOut();
    response = await send(token);
    // Refused before anything was done, so asking again with a renewed token cannot send the message twice.
    if (auth !== null && response.status === 401) {
      token = await auth.token({ forceRefresh: true });
      if (token === null) throw signedOut();
      response = await send(token);
      if (response.status === 401) throw signedOut();
    }
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    if (controller.signal.aborted) throw new ApiError('timeout', 'The server did not answer in time. Try again.');
    throw new ApiError('network', 'Could not reach the server. Check your connection.');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const error = apiErrorSchema.safeParse(await response.json().catch(() => null));
    throw new ApiError(
      error.success ? error.data.error.code : 'http_error',
      error.success ? error.data.error.message : `The server responded with an error (${response.status}).`,
      response.status,
    );
  }
  if (response.body === null) throw new ApiError('invalid_response', 'The server sent an empty reply.', response.status);
  return response.body;
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

/** The queue's address for the one narrowing the server can work out for itself. */
function queuePath(scope: ReviewScope): string {
  return scope.kind === 'weak' ? '/api/review-queue?focus=weak' : '/api/review-queue';
}

/** Enough to know the reply is an export of the kind this app writes; the rest is passed through untouched. */
const exportEnvelope = z.looseObject({ format: z.literal(EXPORT_FORMAT), version: z.number().int() });

const collectionReply = z.object({ collection: collectionSchema });
const exampleReply = z.object({ example: extraExampleSchema });
const relationReply = z.object({ relation: relationSchema });

/** `auth` is given where the app has accounts; every request is then made as the signed-in user. */
export function createAppApi(auth: ApiAuth | null = null): AppApi {
  const call = <T>(path: string, schema: ZodType<T> | null, init: CallOptions) => request(path, schema, init, auth);

  const entry = (path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown, timeoutMessage = SAVE_TIMEOUT_MESSAGE) =>
    call(path, entryResponseSchema, { method, body, timeoutMs: TIMEOUTS.actionMs, timeoutMessage }).then(
      (response) => response.entry,
    );

  /** One change to the library, confirmed by the record the server sends back. */
  const change = <T>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body: unknown, schema: ZodType<T>) =>
    call(path, schema, { method, body, timeoutMs: TIMEOUTS.actionMs, timeoutMessage: SAVE_TIMEOUT_MESSAGE });

  return {
    fetchQueue: (options) => {
      const scope = options?.scope ?? ALL_SCOPE;
      const timeouts = {
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading the review queue took too long.',
      } as const;
      // Picked words are sent as a body: the list may be as long as the bank.
      if (scope.kind === 'selection') {
        return call('/api/review-queue', queueResponseSchema, {
          method: 'POST',
          body: { ids: [...scope.ids] },
          ...timeouts,
        });
      }
      return call(queuePath(scope), queueResponseSchema, { method: 'GET', ...timeouts });
    },

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

    fetchReviewDays: (from, to) =>
      call(`/api/review-days?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, reviewDaysResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading the reviews for this month took too long.',
      }),

    importWords: (items) =>
      call('/api/vocabulary/import', importResponseSchema, {
        method: 'POST',
        body: { items },
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Importing took too long. Nothing is imported twice if you try again.',
      }),

    fetchExport: () =>
      call('/api/export', exportEnvelope, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Preparing the export took too long.',
      }).then((data) => data as unknown as AccountExport),

    fetchLibrary: () =>
      call('/api/library', libraryResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading your collections took too long.',
      }),

    createCollection: (name) => change('/api/collections', 'POST', { name }, collectionReply).then((reply) => reply.collection),
    renameCollection: (id, name) =>
      change(`/api/collections/${id}`, 'PATCH', { name }, collectionReply).then((reply) => reply.collection),
    deleteCollection: (id) => change(`/api/collections/${id}`, 'DELETE', undefined, deletedResponseSchema).then(() => undefined),
    setMembership: (collectionId, wordId, member) =>
      change(`/api/collections/${collectionId}/words/${wordId}`, 'PUT', { member }, collectionReply).then(
        (reply) => reply.collection,
      ),

    addExample: (wordId, input) =>
      change(`/api/vocabulary/${wordId}/examples`, 'POST', input, exampleReply).then((reply) => reply.example),
    updateExample: (id, input) => change(`/api/examples/${id}`, 'PATCH', input, exampleReply).then((reply) => reply.example),
    deleteExample: (id) => change(`/api/examples/${id}`, 'DELETE', undefined, deletedResponseSchema).then(() => undefined),

    addRelation: (fromId, toId, kind) =>
      change('/api/relations', 'POST', { fromId, toId, kind }, relationReply).then((reply) => reply.relation),
    deleteRelation: (id) => change(`/api/relations/${id}`, 'DELETE', undefined, deletedResponseSchema).then(() => undefined),

    submitPractice: (body) =>
      call('/api/practice', practiceResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Checking that answer took too long.',
      }),

    fetchPracticeMastery: (id) =>
      call(`/api/vocabulary/${encodeURIComponent(id)}/practice-mastery`, practiceMasteryResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: "Loading this word's practice mastery took too long.",
      }),

    fetchPracticeHistory: (since) =>
      call(`/api/practice-history${since ? `?since=${encodeURIComponent(since)}` : ''}`, practiceHistoryResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading practice history took too long.',
      }),

    fetchPlan: () =>
      call('/api/plan', dayPlanSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading your daily goal took too long.',
      }),

    saveGoal: (goal) =>
      call('/api/goal', dayPlanSchema, {
        method: 'PUT',
        body: goal,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Saving the goal took too long.',
      }),

    fetchScheduler: () =>
      call('/api/scheduler', schedulerReportSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading the schedule comparison took too long.',
      }),

    chooseScheduler: (scheduler) =>
      call('/api/scheduler', schedulerReportSchema, {
        method: 'PUT',
        body: { scheduler },
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),

    fetchSimulation: (retention) =>
      call(
        retention === undefined ? '/api/simulation' : `/api/simulation?retention=${encodeURIComponent(String(retention))}`,
        simulationResponseSchema,
        {
          method: 'GET',
          timeoutMs: TIMEOUTS.queueMs,
          timeoutMessage: 'Working out the comparison took too long.',
        },
      ),

    saveSettings: (body) =>
      call('/api/settings', accountSettingsSchema, {
        method: 'PUT',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),

    // AI Chat
    listConversations: (limit, offset) =>
      call(
        `/api/ai/conversations?${new URLSearchParams({ limit: String(limit ?? 50), offset: String(offset ?? 0) })}`,
        aiConversationListResponseSchema,
        {
          method: 'GET',
          timeoutMs: TIMEOUTS.queueMs,
          timeoutMessage: 'Loading conversations took too long.',
        },
      ),

    createConversation: (mode, title) =>
      call('/api/ai/conversations', z.object({ conversation: aiConversationSchema }), {
        method: 'POST',
        body: { mode, title },
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Creating conversation took too long.',
      }).then((response) => response.conversation),

    getConversation: (id, limit, offset) =>
      call(
        `/api/ai/conversations/${encodeURIComponent(id)}?${new URLSearchParams({ limit: String(limit ?? 200), offset: String(offset ?? 0) })}`,
        z.object({ conversation: aiConversationSchema, messages: z.array(aiMessageSchema) }),
        {
          method: 'GET',
          timeoutMs: TIMEOUTS.queueMs,
          timeoutMessage: 'Loading conversation took too long.',
        },
      ).then((r) => ({ conversation: r.conversation, messages: r.messages })),

    updateConversation: (id, title) =>
      call(`/api/ai/conversations/${encodeURIComponent(id)}`, null, {
        method: 'PATCH',
        body: { title },
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Updating conversation took too long.',
      }),

    deleteConversation: (id) =>
      call(`/api/ai/conversations/${encodeURIComponent(id)}`, null, {
        method: 'DELETE',
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Deleting conversation took too long.',
      }),

    sendMessage: (id, content) =>
      openStream(`/api/ai/conversations/${encodeURIComponent(id)}/messages`, { content }, TIMEOUTS.queueMs, auth),

    markMessageSaved: (conversationId, messageId, vocabularyId) =>
      call(
        `/api/ai/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/saved`,
        aiMessageSavedResponseSchema,
        {
          method: 'POST',
          body: { vocabularyId },
          timeoutMs: TIMEOUTS.actionMs,
          timeoutMessage: 'Recording the added word took too long.',
        },
      ),
  };
}

/** The API for the built-in sample words, which need no account. */
export const appApi: AppApi = createAppApi();
