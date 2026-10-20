import { z, type ZodType } from 'zod';
import {
  accountSettingsSchema,
  analyticsResponseSchema,
  apiErrorSchema,
  addSenseResponseSchema,
  collectionSchema,
  dayPlanSchema,
  deletedResponseSchema,
  extraExampleSchema,
  importResponseSchema,
  libraryResponseSchema,
  practiceResponseSchema,
  relationSchema,
  appConfigResponseSchema,
  entryResponseSchema,
  queueResponseSchema,
  reviewActionResponseSchema,
  reviewDaysResponseSchema,
  reviewUndoResponseSchema,
  schedulerReportSchema,
  senseSchema,
  sessionSummarySchema,
  simulationResponseSchema,
  trashResponseSchema,
  vocabularyListResponseSchema,
  weakWordsResponseSchema,
  type AccountSettings,
  type AnalyticsResponse,
  type AddSenseRequest,
  type DayPlanResponse,
  type ImportResponse,
  type LibraryResponse,
  type PracticeRequest,
  type PracticeResponse,
  type ReorderSensesRequest,
  type ReviewFocus,
  type AppConfigResponse,
  type ArchiveSenseRequest,
  type CreateEntryInput,
  type QueueResponse,
  type RestoreSenseRequest,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type ReviewDaysResponse,
  type ReviewUndoRequest,
  type ReviewUndoResponse,
  type SchedulerReport,
  type Sense,
  type SessionSummary,
  type SimulationResponse,
  type UpdateEntryInput,
  type UpdateSenseRequest,
  type VocabularyEntry,
  type VocabularyListResponse,
  type WeakWordsResponse,
} from '../../shared/api.js';
import type { IsoDate } from '../../shared/dates.js';
import {
  expandMapResponseSchema,
  mapDeletedResponseSchema,
  mapEdgeResponseSchema,
  mapNodeResponseSchema,
  mapResponseSchema,
  mapsListResponseSchema,
  mapSummaryResponseSchema,
  personalMapResponseSchema,
  saveCandidateResponseSchema,
  type AddMapEdgeRequest,
  type AddMapNodeRequest,
  type CreateMapRequest,
  type ExpandMapRequest,
  type GenerateMapRequest,
  type PersonalMapResponse,
  type SaveCandidateRequest,
  type SaveMapLayoutRequest,
  type UpdateMapEdgeRequest,
  type UpdateMapNodeRequest,
  type UpdateMapRequest,
  type VocabMapDocument,
  type VocabMapEdge,
  type VocabMapNode,
  type VocabMapSummary,
} from '../../shared/vocab-map.js';
import {
  aiDiscoveryDraftSchema,
  aiExtractResponseSchema,
  aiWordFamilyResponseSchema,
  aiExamplesResponseSchema,
  aiExamPlanResponseSchema,
  type AiDiscoveryDraft,
  type AiDiscoveryRequest,
  type AiExtractRequest,
  type AiExtractResponse,
  type AiWordFamilyRequest,
  type AiWordFamilyResponse,
  type AiExamplesRequest,
  type AiExamplesResponse,
  type AiExamPlanRequest,
  type AiExamPlanResponse,
} from '../../shared/ai.js';
import {
  discoveryContextResponseSchema,
  discoveryListResponseSchema,
  discoveryMarkResponseSchema,
  discoveryMarksResponseSchema,
  discoverySaveResponseSchema,
  discoverySourceResponseSchema,
  discoverySourceSummaryResponseSchema,
  fetchUrlResponseSchema,
  type CreateDiscoverySourceRequest,
  type DiscoveryMark,
  type DiscoveryMarkView,
  type DiscoverySource,
  type DiscoverySourceDocument,
  type FetchUrlResponse,
  type MarkSelectionRequest,
  type SaveMarkRequest,
  type SaveSelectionRequest,
  type UpdateDiscoverySourceRequest,
} from '../../shared/discovery.js';
import { EXPORT_FORMAT, type AccountExport } from '../../shared/export-format.js';
import type { ImportItem } from '../../shared/import.js';
import type { Collection, ExtraExample, Relation, RelationKind } from '../../shared/library.js';
import type { SchedulerId } from '../../shared/scheduler/active.js';
import type { DailyGoal } from '../../shared/session-planner.js';
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
  fetchQueue(options?: { focus?: ReviewFocus | null; collection?: string | null }): Promise<QueueResponse>;
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
  /** List every sense of a vocabulary entry, archived ones included. */
  listSenses(vocabularyId: string): Promise<Sense[]>;
  /** One sense of a word. */
  getSense(vocabularyId: string, senseId: string): Promise<Sense>;
  /** Add a new sense to a vocabulary entry. A repeated request id lands on the same sense. */
  addSense(vocabularyId: string, input: AddSenseRequest): Promise<Sense>;
  /** Update an existing sense. */
  updateEntrySense(senseId: string, input: UpdateSenseRequest): Promise<Sense>;
  /** Reorder senses. */
  reorderSenses(vocabularyId: string, input: ReorderSensesRequest): Promise<void>;
  /** Archive (soft-delete) a sense. */
  archiveSense(senseId: string, input: ArchiveSenseRequest): Promise<void>;
  /** Restore an archived sense. */
  restoreSense(senseId: string, input: RestoreSenseRequest): Promise<void>;
}

export interface AccountApi {
  fetchSettings(): Promise<AccountSettings>;
  saveSettings(input: { timeZone?: string; fsrsRetention?: number }): Promise<AccountSettings>;
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

/**
 * Vocabulary Maps: the learner's own diagrams. None of these calls changes a
 * word's content or schedule; saving a map saves no vocabulary, and the one
 * call that turns a suggestion into a word says so in its name.
 */
export interface VocabularyMapsApi {
  fetchMaps(): Promise<VocabMapSummary[]>;
  createMap(request: CreateMapRequest): Promise<VocabMapSummary>;
  fetchMap(id: string): Promise<VocabMapDocument>;
  updateMap(id: string, request: UpdateMapRequest): Promise<VocabMapSummary>;
  /** Removes the map, its nodes and its edges. The words it referenced stay. */
  deleteMap(id: string): Promise<void>;
  addNode(mapId: string, request: AddMapNodeRequest): Promise<VocabMapNode>;
  updateNode(mapId: string, nodeId: string, request: UpdateMapNodeRequest): Promise<VocabMapNode>;
  /** Removes the node and every edge touching it. A saved node's word stays. */
  removeNode(mapId: string, nodeId: string): Promise<void>;
  /** The one call that can create vocabulary: a suggestion saved on purpose, as one word. */
  saveCandidate(mapId: string, nodeId: string, request: SaveCandidateRequest): Promise<{ node: VocabMapNode; entryId: string }>;
  addEdge(mapId: string, request: AddMapEdgeRequest): Promise<VocabMapEdge>;
  updateEdge(mapId: string, edgeId: string, request: UpdateMapEdgeRequest): Promise<VocabMapEdge>;
  removeEdge(mapId: string, edgeId: string): Promise<void>;
  /** Where the learner has left the nodes. */
  saveLayout(mapId: string, request: SaveMapLayoutRequest): Promise<VocabMapSummary>;
  /** An AI draft map: seed words saved by their ids, every other label a candidate. */
  generateMap(request: GenerateMapRequest): Promise<VocabMapDocument>;
  /** An AI expansion; only with `apply` are the suggestions stored, and then as candidates. */
  expandMap(mapId: string, request: ExpandMapRequest): Promise<{ suggestions: { nodes: Array<{ label: string; note: string; group: string | null }>; edges: Array<{ fromLabel: string; toLabel: string; kind: VocabMapEdge['kind']; pattern: string; note: string }> }; applied: boolean }>;
  /** The personal map: the account's words and saved connections, drawn live from the library. */
  fetchPersonalMap(): Promise<PersonalMapResponse>;
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
}

export interface AiApi {
  /**
   * What a picked word means in the sentence it sits in. The sentence comes
   * from the reader's own text and is taken by the server; only the two
   * suggested fields are a model's draft, for the reader to check before
   * anything is saved. Any failure arrives as an ApiError and the reader
   * simply enters the word by hand — nothing here is required.
   */
  extractSense(request: AiExtractRequest): Promise<AiExtractResponse>;

  /**
   * The words formed from one root, as a draft the reader reviews. Saving any
   * of it is ordinary writes afterwards - creating the words, pointing their
   * links - so a failure here only means the family is built by hand.
   */
  wordFamily(request: AiWordFamilyRequest): Promise<AiWordFamilyResponse>;

  /**
   * Example sentences for a word being added, as drafts with the collocations
   * the reader has saved. Each sentence is saved through the ordinary
   * examples path after it has been read; nothing is stored by asking.
   */
  suggestExamples(request: AiExamplesRequest): Promise<AiExamplesResponse>;

  /**
   * A suggested structure for an exam: sections, counts, clocks and one line
   * of reason. A draft for the builder — "Use this plan" fills the section
   * form, the reader can edit every row, and starting the exam stays their
   * press. A failure only means the sections are chosen by hand.
   */
  examPlan(request: AiExamPlanRequest): Promise<AiExamPlanResponse>;
}

export interface DiscoveryApi {
  /** Every source the learner has brought in, newest first, with its waiting and saved counts. */
  listSources(): Promise<DiscoverySource[]>;

  /** One new source — pasted, imported, generated-then-accepted, or a standing capture home. */
  createSource(request: CreateDiscoverySourceRequest): Promise<DiscoverySource>;

  /** A source with its content and every mark on it. */
  fetchSource(id: string): Promise<DiscoverySourceDocument>;

  /** A title edit (checked against `ifMatch`) or a reading/listening position. */
  updateSource(id: string, request: UpdateDiscoverySourceRequest): Promise<DiscoverySource>;

  /** Takes the source and its marks; every word they became stays. */
  deleteSource(id: string): Promise<void>;

  /** Every selection still waiting for later, with where each one came from. */
  listMarks(): Promise<DiscoveryMarkView[]>;

  /** Mark for Later: the selection kept as text, referencing no vocabulary at all. */
  markSelection(sourceId: string, request: MarkSelectionRequest): Promise<DiscoveryMark>;

  /** Dismiss a waiting selection. A saved one is refused by the server as a conflict. */
  dismissMark(markId: string): Promise<void>;

  /**
   * Save Now: the word through the ordinary creation path, with the selection's
   * context kept beside it. A duplicate answers ApiError `duplicates`, like Add.
   */
  saveSelection(request: SaveSelectionRequest): Promise<{ entry: VocabularyEntry; mark: DiscoveryMark }>;

  /** Processing a marked item later: the mark's own selection becomes the word. */
  saveMark(markId: string, request: SaveMarkRequest): Promise<{ entry: VocabularyEntry; mark: DiscoveryMark }>;

  /** Where a saved word was found — the link back from the Word Profile. */
  findWordContext(vocabularyId: string): Promise<{ source: DiscoverySource; mark: DiscoveryMark }>;

  /** A draft reading from a topic, a collection or a few words. Stored nowhere until accepted. */
  generateDraft(request: AiDiscoveryRequest): Promise<{ draft: AiDiscoveryDraft }>;

  /** Brings a page back as plain text for the preview. Nothing is stored by asking. */
  fetchUrl(url: string): Promise<FetchUrlResponse>;
}

export type AppApi = ReviewApi &
  VocabularyApi &
  AccountApi &
  AnalyticsApi &
  PracticeApi &
  LibraryApi &
  VocabularyMapsApi &
  DiscoveryApi &
  TransferApi &
  AiApi;

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

/** The queue's address: everything due, one of the narrower selections, or one collection. */
function queuePath(options?: { focus?: ReviewFocus | null; collection?: string | null }): string {
  if (options?.collection != null) return '/api/review-queue?collection=' + encodeURIComponent(options.collection);
  return options?.focus == null ? '/api/review-queue' : '/api/review-queue?focus=' + options.focus;
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
    fetchQueue: (options) =>
      call(queuePath(options), queueResponseSchema, {
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

    // Sense operations (schema version 13)
    listSenses: (vocabularyId) =>
      call(`/api/vocabulary/${vocabularyId}/senses`, z.object({ senses: z.array(senseSchema) }), {
        method: 'GET',
        timeoutMs: TIMEOUTS.quickMs,
        timeoutMessage: 'Loading senses took too long.',
      }).then((response) => response.senses),

    getSense: (vocabularyId, senseId) =>
      call(`/api/vocabulary/${vocabularyId}/senses/${senseId}`, z.object({ sense: senseSchema }), {
        method: 'GET',
        timeoutMs: TIMEOUTS.quickMs,
        timeoutMessage: 'Loading the sense took too long.',
      }).then((response) => response.sense),

    addSense: (vocabularyId, input) =>
      call(`/api/vocabulary/${vocabularyId}/senses`, addSenseResponseSchema, {
        method: 'POST',
        body: input,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((response) => response.sense),

    updateEntrySense: (senseId, input) =>
      call(`/api/vocabulary/${senseId}`, z.object({ sense: senseSchema }), {
        method: 'PATCH',
        body: input,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((response) => response.sense),

    reorderSenses: (vocabularyId, input) =>
      call(`/api/vocabulary/${vocabularyId}/senses/order`, z.void(), {
        method: 'PATCH',
        body: input,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),

    archiveSense: (senseId, input) =>
      call(`/api/vocabulary/${senseId}/archive`, z.void(), {
        method: 'POST',
        body: input,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),

    restoreSense: (senseId, input) =>
      call(`/api/vocabulary/${senseId}/restore`, z.void(), {
        method: 'POST',
        body: input,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),

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

    fetchMaps: () =>
      call('/api/maps', mapsListResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading your maps took too long.',
      }).then((reply) => reply.maps),

    createMap: (body) =>
      call('/api/maps', mapSummaryResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.map),

    fetchMap: (id) =>
      call(`/api/maps/${id}`, mapResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading that map took too long.',
      }).then((reply) => reply.map),

    updateMap: (id, body) =>
      call(`/api/maps/${id}`, mapSummaryResponseSchema, {
        method: 'PATCH',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.map),

    deleteMap: (id) => change(`/api/maps/${id}`, 'DELETE', undefined, mapDeletedResponseSchema).then(() => undefined),

    addNode: (mapId, body) =>
      call(`/api/maps/${mapId}/nodes`, mapNodeResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.node),

    updateNode: (mapId, nodeId, body) =>
      call(`/api/maps/${mapId}/nodes/${nodeId}`, mapNodeResponseSchema, {
        method: 'PATCH',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.node),

    removeNode: (mapId, nodeId) =>
      change(`/api/maps/${mapId}/nodes/${nodeId}`, 'DELETE', undefined, mapDeletedResponseSchema).then(() => undefined),

    saveCandidate: (mapId, nodeId, body) =>
      call(`/api/maps/${mapId}/nodes/${nodeId}/save`, saveCandidateResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Saving that word took too long. Nothing was changed.',
      }),

    addEdge: (mapId, body) =>
      call(`/api/maps/${mapId}/edges`, mapEdgeResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.edge),

    updateEdge: (mapId, edgeId, body) =>
      call(`/api/maps/${mapId}/edges/${edgeId}`, mapEdgeResponseSchema, {
        method: 'PATCH',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.edge),

    removeEdge: (mapId, edgeId) =>
      change(`/api/maps/${mapId}/edges/${edgeId}`, 'DELETE', undefined, mapDeletedResponseSchema).then(() => undefined),

    saveLayout: (mapId, body) =>
      call(`/api/maps/${mapId}/layout`, mapSummaryResponseSchema, {
        method: 'PUT',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.map),

    generateMap: (body) =>
      call('/api/maps/generate', mapResponseSchema, {
        method: 'POST',
        body,
        // The server asks the model within this budget; waiting longer only
        // delays falling back to building the map by hand.
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'The AI suggestion took too long. Build the map by hand.',
      }).then((reply) => reply.map),

    expandMap: (mapId, body) =>
      call(`/api/maps/${mapId}/expand`, expandMapResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'The AI suggestion took too long. Add the words by hand.',
      }),

    fetchPersonalMap: () =>
      call('/api/maps/personal', personalMapResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Drawing your vocabulary at a glance took too long.',
      }),

    submitPractice: (body) =>
      call('/api/practice', practiceResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Checking that answer took too long.',
      }),

    // ---- Discovery & Input: sources, selections, and the one explicit save ----
    listSources: () =>
      call('/api/discovery', discoveryListResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading your sources took too long.',
      }).then((reply) => reply.sources),

    createSource: (body) =>
      call('/api/discovery', discoverySourceSummaryResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.source),

    fetchSource: (id) =>
      call(`/api/discovery/${id}`, discoverySourceResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading that source took too long.',
      }).then((reply) => reply.source),

    updateSource: (id, body) =>
      call(`/api/discovery/${id}`, discoverySourceSummaryResponseSchema, {
        method: 'PATCH',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }).then((reply) => reply.source),

    deleteSource: (id) =>
      call<void>(`/api/discovery/${id}`, null, {
        method: 'DELETE',
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),

    listMarks: () =>
      call('/api/discovery/marks', discoveryMarksResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.queueMs,
        timeoutMessage: 'Loading your marked words took too long.',
      }).then((reply) => reply.marks),

    markSelection: (sourceId, body) =>
      call(`/api/discovery/${sourceId}/marks`, discoveryMarkResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Marking that selection took too long. It was not kept.',
      }).then((reply) => reply.mark),

    dismissMark: (markId) =>
      call<void>(`/api/discovery/marks/${markId}`, null, {
        method: 'DELETE',
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: SAVE_TIMEOUT_MESSAGE,
      }),

    saveSelection: (body) =>
      call('/api/discovery/save', discoverySaveResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        // The server checks before writing, so pressing Save again is safe.
        timeoutMessage: 'Saving that word took too long. Nothing was changed — press Save again.',
      }),

    saveMark: (markId, body) =>
      call(`/api/discovery/marks/${markId}/save`, discoverySaveResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'Saving that word took too long. Nothing was changed — press Save again.',
      }),

    findWordContext: (vocabularyId) =>
      call(`/api/discovery/context?vocabularyId=${encodeURIComponent(vocabularyId)}`, discoveryContextResponseSchema, {
        method: 'GET',
        timeoutMs: TIMEOUTS.quickMs,
        timeoutMessage: 'Looking up where that word was found took too long.',
      }),

    generateDraft: (body) =>
      call('/api/discovery/generate', z.object({ draft: aiDiscoveryDraftSchema }), {
        method: 'POST',
        body,
        // The server gives the model its own budget; waiting past it only
        // delays the honest fallback of writing the reading by hand.
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'The draft took too long to write. Write the reading by hand.',
      }),

    fetchUrl: (url) =>
      call('/api/discovery/fetch-url', fetchUrlResponseSchema, {
        method: 'POST',
        body: { url },
        // Longer than the server's own 5-second deadline, so the server
        // answers first whenever it can.
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'That address did not answer in time. Paste the text instead.',
      }),

    extractSense: (body) =>
      call('/api/ai/extract', aiExtractResponseSchema, {
        method: 'POST',
        body,
        // The server gives the model less than this; waiting longer than its own
        // budget only delays the fallback of entering the word by hand.
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'The AI suggestion took too long. Enter the word by hand.',
      }),

    wordFamily: (body) =>
      call('/api/ai/word-family', aiWordFamilyResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'The AI suggestion took too long. Build the family by hand.',
      }),

    suggestExamples: (body) =>
      call('/api/ai/examples', aiExamplesResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'The AI suggestion took too long. Write the examples by hand.',
      }),

    examPlan: (body) =>
      call('/api/ai/exam-plan', aiExamPlanResponseSchema, {
        method: 'POST',
        body,
        timeoutMs: TIMEOUTS.actionMs,
        timeoutMessage: 'The AI suggestion took too long. Build the sections by hand.',
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
  };
}

/** The API for the built-in sample words, which need no account. */
export const appApi: AppApi = createAppApi();
