import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ZodType } from 'zod';
import {
  REVIEW_FOCUSES,
  collectionNameRequestSchema,
  createEntryRequestSchema,
  createExampleRequestSchema,
  createRelationRequestSchema,
  dailyGoalSchema,
  importRequestSchema,
  isoDateSchema,
  membershipRequestSchema,
  normalizeId,
  pageIdSchema,
  practiceRequestSchema,
  reviewActionRequestSchema,
  reviewFocusSchema,
  reviewUndoRequestSchema,
  schedulerChoiceRequestSchema,
  updateEntryRequestSchema,
  updateExampleRequestSchema,
  updateSettingsRequestSchema,
  addSenseRequestSchema,
  updateSenseRequestSchema,
  reorderSensesRequestSchema,
  archiveSenseRequestSchema,
  restoreSenseRequestSchema,
  type AccountSettings,
  type ApiErrorBody,
  type AppConfigResponse,
} from '../shared/api.js';
import {
  addMapEdgeRequestSchema,
  addMapNodeRequestSchema,
  createMapRequestSchema,
  expandMapRequestSchema,
  generateMapRequestSchema,
  saveCandidateRequestSchema,
  saveMapLayoutRequestSchema,
  updateMapEdgeRequestSchema,
  updateMapNodeRequestSchema,
  updateMapRequestSchema,
} from '../shared/vocab-map.js';
import {
  createDiscoverySourceRequestSchema,
  fetchUrlRequestSchema,
  markSelectionRequestSchema,
  saveMarkRequestSchema,
  saveSelectionRequestSchema,
  updateDiscoverySourceRequestSchema,
} from '../shared/discovery.js';
import { aiDiscoveryRequestSchema } from '../shared/ai.js';
import { bearerToken, type AccountGateway, type AccountSession } from './accounts.js';
import { createAiAdapter, AiError } from './ai/adapter.js';
import { createTokenBucket } from './ai/rate-limit.js';
import { AI_RATE, SmartReader, aiErrorToHttp } from './ai/smart-reader.js';
import { WORD_FAMILY_RATE, WordFamily } from './ai/word-family.js';
import { EXAMPLES_RATE, Examples } from './ai/examples.js';
import { EXAM_PLAN_RATE, ExamPlan } from './ai/exam-plan.js';
import { MAPS_AI_RATE, MapBuilder } from './ai/map-builder.js';
import { DISCOVERY_AI_RATE, DiscoveryWriter } from './ai/discovery-writer.js';
import type { AnalyticsService } from './analytics-service.js';
import { aiExtractRequestSchema, aiWordFamilyRequestSchema, aiExamplesRequestSchema, aiExamPlanRequestSchema, type AiMapDraft } from '../shared/ai.js';
import type { DiscoveryService } from './discovery-service.js';
import { createWebImporter, WebImportError, type WebImporter } from './web-importer.js';
import type { AppConfig } from './env.js';
import { HttpError } from './errors.js';
import type { ExportService } from './export-service.js';
import type { LibraryService } from './library-service.js';
import type { ReviewService } from './review-service.js';
import { DatabaseError } from './supabase/supabase-database.js';
import type { VocabMapsService } from './vocab-maps-service.js';
import type { VocabularyService } from './vocabulary-service.js';

export interface AppDependencies {
  config: AppConfig;
  /** `null` when configuration problems prevent building the service, or when each account has its own. */
  service: ReviewService | null;
  /** Whole-record operations; `null` under the same conditions as `service`. */
  vocabulary?: VocabularyService | null;
  /** Present when the app has accounts: every request then gets services of its own. */
  accounts?: AccountGateway | null;
  /** Review activity and weak words; `null` under the same conditions as `service`. */
  analytics?: AnalyticsService | null;
  /** Collections, further examples and relationships; `null` under the same conditions as `service`. */
  library?: LibraryService | null;
  /** Vocabulary maps; `null` under the same conditions as `service`, or where the database has no room for them. */
  maps?: VocabMapsService | null;
  /** Discovery sources and selections; `null` under the same conditions as `service`, or where the database has no room for them. */
  discovery?: DiscoveryService | null;
  /** The account's own export; `null` under the same conditions as `service`. */
  exporter?: ExportService | null;
  /** How this server fetches a web page for import; a stub in tests, the guarded one in production. */
  webImporter?: WebImporter | null;
}

/** What the current request may use. With accounts, all of it belongs to one signed-in user. */
interface Scope {
  review: ReviewService | null;
  vocabulary: VocabularyService | null;
  analytics: AnalyticsService | null;
  library: LibraryService | null;
  maps: VocabMapsService | null;
  discovery: DiscoveryService | null;
  exporter: ExportService | null;
  session: AccountSession | null;
}

type AppEnv = { Variables: { scope: Scope } };

function errorResponse(c: Context, error: HttpError) {
  const body: ApiErrorBody & Record<string, unknown> = {
    error: { code: error.code, message: error.message },
    ...error.options.body,
  };
  for (const [name, value] of Object.entries(error.options.headers ?? {})) c.header(name, value);
  return c.json(body, error.status as ContentfulStatusCode);
}

/** A database failure as the browser should hear about it. Nothing is hidden, and nothing internal is shown. */
function databaseErrorToHttp(error: DatabaseError): HttpError {
  switch (error.failure) {
    case 'unauthorized':
      return new HttpError(401, 'unauthorized', error.message);
    case 'forbidden':
      return new HttpError(403, 'forbidden', error.message);
    case 'schema_missing':
      return new HttpError(503, 'setup_incomplete', error.message);
    case 'invalid':
      return new HttpError(400, 'invalid_request', error.message);
    case 'conflict':
      return new HttpError(409, 'conflict', error.message);
    case 'unavailable':
      return new HttpError(503, 'database_unavailable', `${error.message} Nothing was changed; try again shortly.`);
  }
}

/** A refused web fetch as the browser should hear about it: the reason, without any internals. */
function webErrorToHttp(error: WebImportError): HttpError {
  switch (error.failure) {
    case 'invalid_url':
    case 'empty':
      return new HttpError(400, 'invalid_request', error.message);
    case 'blocked':
      return new HttpError(403, 'url_blocked', error.message);
    case 'too_large':
      return new HttpError(413, 'content_too_large', error.message);
    case 'unsupported_type':
      return new HttpError(415, 'unsupported_media_type', error.message);
    case 'timeout':
      return new HttpError(504, 'upstream_timeout', error.message);
    case 'unreachable':
      return new HttpError(502, 'upstream_unreachable', error.message);
  }
}

async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new HttpError(400, 'invalid_request', `Invalid request. ${detail}`);
  }
  return parsed.data;
}

/** A model's failure — down, slow, rate-limiting, rambling — is told apart from a server's before it reaches the client. */
async function withAiErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AiError) {
      const http = aiErrorToHttp(error);
      throw new HttpError(http.status, http.code, http.message);
    }
    throw error;
  }
}

export function createApp({
  config,
  service,
  vocabulary = null,
  accounts = null,
  analytics = null,
  library = null,
  maps = null,
  discovery = null,
  exporter = null,
  webImporter = null,
}: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Everyone signs in to their own account, except with the built-in sample words, which belong to nobody.
  const usesAccounts = config.mode === 'supabase';

  const notConfigured = () =>
    new HttpError(503, 'setup_incomplete', `The server is not configured yet. ${config.issues.join(' ')}`);

  // The language model for the AI features, if this server has one. Built
  // once for the app; without a key the adapter answers "not configured" and
  // the features fall back to being done by hand.
  const aiAdapter = createAiAdapter(config.ai);
  const reader = new SmartReader({ adapter: aiAdapter, limiter: createTokenBucket(AI_RATE) });
  const familyBuilder = new WordFamily({ adapter: aiAdapter, limiter: createTokenBucket(WORD_FAMILY_RATE) });
  const exampleSuggester = new Examples({ adapter: aiAdapter, limiter: createTokenBucket(EXAMPLES_RATE) });
  const examPlanner = new ExamPlan({ adapter: aiAdapter, limiter: createTokenBucket(EXAM_PLAN_RATE) });
  const mapBuilder = new MapBuilder({ adapter: aiAdapter, limiter: createTokenBucket(MAPS_AI_RATE) });
  const discoveryWriter = new DiscoveryWriter({ adapter: aiAdapter, limiter: createTokenBucket(DISCOVERY_AI_RATE) });
  // The one outbound fetch this server makes, with its guards. Tests pass a stub instead.
  const pageFetcher: WebImporter = webImporter ?? createWebImporter();

  const requireService = (c: Context<AppEnv>): ReviewService => {
    const { review } = c.get('scope');
    if (review === null) throw notConfigured();
    return review;
  };

  const requireVocabulary = (c: Context<AppEnv>): VocabularyService => {
    const scoped = c.get('scope').vocabulary;
    if (scoped === null) throw notConfigured();
    return scoped;
  };

  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    if (error instanceof DatabaseError) {
      // The code says what went wrong without quoting any stored value.
      if (error.failure !== 'unauthorized') {
        console.error(`Database error: ${error.failure}${error.code === null ? '' : ` (${error.code})`}`);
      }
      return errorResponse(c, databaseErrorToHttp(error));
    }
    // Unknown failures may carry internals, so only their message reaches the log and none of it the client.
    console.error('Unhandled error:', error instanceof Error ? error.message : 'non-error thrown');
    return errorResponse(c, new HttpError(500, 'internal_error', 'Something went wrong on the server.'));
  });

  app.notFound((c) => errorResponse(c, new HttpError(404, 'not_found', 'No such endpoint.')));

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // Requests carry a token rather than a cookie, so another site cannot make one on a
  // visitor's behalf. Cross-site writes are refused outright all the same.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin) {
        const hosts = [c.req.header('host'), c.req.header('x-forwarded-host')];
        const originHost = URL.canParse(origin) ? new URL(origin).host : null;
        if (originHost === null || !hosts.includes(originHost)) {
          throw new HttpError(403, 'forbidden_origin', 'Cross-site requests are not allowed.');
        }
      }
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    // Three free-text fields of up to 6,000 characters each, in UTF-8 — except
    // discovery, which stores a source's content in the request itself, so its
    // cap matches the source cap (120,000 characters, worst case UTF-8) plus
    // room for the envelope. Everything else stays exactly as it was.
    const path = c.req.path;
    const maxSize = path === '/api/discovery' || path.startsWith('/api/discovery/') ? 400 * 1024 : 96 * 1024;
    return bodyLimit({
      maxSize,
      onError: () => {
        throw new HttpError(413, 'payload_too_large', 'The request body is too large.');
      },
    })(c, next);
  });

  // ---- Public routes. Keep these free of anything worth protecting. ----

  app.get('/api/health', (c) =>
    c.json({
      ok: config.issues.length === 0,
      mode: config.mode,
      access: usesAccounts ? 'account' : 'open',
      writesRequested: config.writesRequested,
      issues: config.issues,
    }),
  );

  // Tells the browser how to sign in. The address and key are the ones meant for browsers.
  app.get('/api/config', (c) => {
    const body: AppConfigResponse = {
      mode: config.mode,
      auth: usesAccounts ? 'account' : 'none',
      supabase: usesAccounts ? config.supabase : null,
    };
    return c.json(body);
  });

  // ---- Everything registered below this guard requires access. ----

  app.use('/api/*', async (c, next) => {
    if (usesAccounts) {
      // No account backend means the configuration is incomplete. There is no other data path to fall back to.
      if (accounts === null) throw notConfigured();
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
      const session = await accounts.open(token, { timeZone: c.req.header('x-time-zone')?.trim() || null });
      if (session === null) throw new HttpError(401, 'unauthorized', 'Your session has expired. Sign in again.');
      c.set('scope', {
        review: session.review,
        vocabulary: session.vocabulary,
        analytics: session.analytics,
        library: session.library,
        maps: session.maps,
        discovery: session.discovery,
        exporter: session.exporter,
        session,
      });
      return next();
    }
    c.set('scope', { review: service, vocabulary, analytics, library, maps, discovery, exporter, session: null });
    await next();
  });

  const requireAnalytics = (c: Context<AppEnv>): AnalyticsService => {
    const scoped = c.get('scope').analytics;
    if (scoped === null) throw notConfigured();
    return scoped;
  };

  const requireLibrary = (c: Context<AppEnv>): LibraryService => {
    const scoped = c.get('scope').library;
    if (scoped === null) throw notConfigured();
    return scoped;
  };

  const requireMaps = (c: Context<AppEnv>): VocabMapsService => {
    const scoped = c.get('scope').maps;
    // Absent where the database has no room for maps yet (schema version 18);
    // the settings panel already reports how far behind it is.
    if (scoped === null) throw new HttpError(503, 'setup_incomplete', 'Vocabulary maps need the newest database update.');
    return scoped;
  };

  const requireDiscovery = (c: Context<AppEnv>): DiscoveryService => {
    const scoped = c.get('scope').discovery;
    // Absent where the database has no room for discovery content yet
    // (schema version 19); the settings panel reports how far behind it is.
    if (scoped === null) throw new HttpError(503, 'setup_incomplete', 'Discovery needs the newest database update.');
    return scoped;
  };

  const idParam = (c: Context, name: string, what: string): string => {
    const parsed = pageIdSchema.safeParse(c.req.param(name));
    if (!parsed.success) throw new HttpError(400, 'invalid_request', `That is not a valid ${what} id.`);
    return parsed.data;
  };

  app.get('/api/review-queue', async (c) => {
    const raw = c.req.query('focus');
    const collectionId = c.req.query('collection');
    if (collectionId !== undefined) {
      if (raw !== undefined) throw new HttpError(400, 'invalid_request', 'Choose a focus or a collection, not both.');
      if (!pageIdSchema.safeParse(collectionId).success) {
        throw new HttpError(400, 'invalid_request', 'That is not a valid collection id.');
      }
      // The due words of the caller's own collection: narrowed like every other selection, never widened.
      const collection = await requireLibrary(c).collection(collectionId);
      return c.json(
        await requireService(c).getQueue({
          kind: 'collection',
          ids: collection.wordIds,
          collection: { id: collection.id, name: collection.name },
        }),
      );
    }
    if (raw === undefined) return c.json(await requireService(c).getQueue());
    const parsed = reviewFocusSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Unknown focus. Use one of: ${REVIEW_FOCUSES.join(', ')}.`);
    }
    // Every focus selects among the words already due: a focused review never reviews a word early.
    const focus = parsed.data;
    if (focus === 'weak') {
      const { words } = await requireAnalytics(c).weakWords();
      return c.json(await requireService(c).getQueue({ kind: 'weak', ids: words.map((word) => word.id) }));
    }
    if (focus === 'recent') {
      return c.json(await requireService(c).getQueue({ kind: 'recent', ids: await requireAnalytics(c).recentlyAddedIds() }));
    }
    return c.json(await requireService(c).getQueue({ kind: focus }));
  });

  // Today's reviewing against the daily goal. The goal never changes what is due.
  app.get('/api/plan', async (c) => c.json(await requireAnalytics(c).dayPlan()));

  app.put('/api/goal', async (c) => {
    const goal = await parseBody(c, dailyGoalSchema);
    return c.json(await requireAnalytics(c).saveGoal(goal));
  });

  // Review activity and weak words, from saved answers. Reads only.
  app.get('/api/analytics', async (c) => c.json(await requireAnalytics(c).reviewAnalytics()));
  app.get('/api/weak-words', async (c) => c.json(await requireAnalytics(c).weakWords()));

  // Saved reviews per day in a range of the reviewer's days, for the calendar. Reads only.
  app.get('/api/review-days', async (c) => {
    const range = z.object({ from: isoDateSchema, to: isoDateSchema }).safeParse({
      from: c.req.query('from'),
      to: c.req.query('to'),
    });
    if (!range.success) {
      throw new HttpError(400, 'invalid_request', 'Give the range as from and to, each a YYYY-MM-DD date.');
    }
    return c.json(await requireAnalytics(c).reviewDays(range.data.from, range.data.to));
  });

  app.post('/api/review-action', async (c) => {
    const request = await parseBody(c, reviewActionRequestSchema);
    return c.json(await requireService(c).submitAction(request));
  });

  // Practice in another study mode: judged and recorded, never moving a word's schedule.
  app.post('/api/practice', async (c) => {
    const request = await parseBody(c, practiceRequestSchema);
    return c.json(await requireService(c).submitPractice(request));
  });

  app.post('/api/review-undo', async (c) => {
    const request = await parseBody(c, reviewUndoRequestSchema);
    return c.json(await requireService(c).undo(request));
  });

  app.get('/api/sessions/:id/summary', async (c) => {
    const parsed = pageIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) throw new HttpError(400, 'invalid_request', 'That is not a valid session id.');
    return c.json(await requireService(c).sessionSummary(normalizeId(parsed.data)));
  });

  // The two schedules side by side, and which is in charge. Reads only; never changes a due date.
  app.get('/api/scheduler', async (c) => c.json(await requireService(c).schedulerReport()));

  // Puts one schedule in charge. Both are kept up to date by every answer, so nothing is converted.
  app.put('/api/scheduler', async (c) => {
    const { scheduler } = await parseBody(c, schedulerChoiceRequestSchema);
    return c.json(await requireService(c).chooseScheduler(scheduler));
  });

  // A what-if comparison at a target retention, from saved answers. Reads only; stores nothing.
  app.get('/api/simulation', async (c) => {
    const raw = c.req.query('retention');
    const retention = raw === undefined || raw === '' ? undefined : Number(raw);
    if (retention !== undefined && !Number.isFinite(retention)) {
      throw new HttpError(400, 'invalid_request', 'The target retention must be a number, such as 0.9.');
    }
    return c.json(await requireService(c).simulation(retention));
  });

  // ---- Collections, further examples, relationships. None of these touch a word's content or schedule. ----

  app.get('/api/library', async (c) => c.json(await requireLibrary(c).load()));

  app.post('/api/collections', async (c) => {
    const { name } = await parseBody(c, collectionNameRequestSchema);
    return c.json({ collection: await requireLibrary(c).createCollection(name) }, 201);
  });

  app.patch('/api/collections/:id', async (c) => {
    const id = idParam(c, 'id', 'collection');
    const { name } = await parseBody(c, collectionNameRequestSchema);
    return c.json({ collection: await requireLibrary(c).renameCollection(id, name) });
  });

  // Removes the collection and its memberships only. No word is deleted.
  app.delete('/api/collections/:id', async (c) => c.json(await requireLibrary(c).deleteCollection(idParam(c, 'id', 'collection'))));

  app.put('/api/collections/:id/words/:wordId', async (c) => {
    const id = idParam(c, 'id', 'collection');
    const wordId = idParam(c, 'wordId', 'word');
    const { member } = await parseBody(c, membershipRequestSchema);
    return c.json({ collection: await requireLibrary(c).setMembership(id, wordId, member) });
  });

  app.post('/api/vocabulary/:id/examples', async (c) => {
    const wordId = idParam(c, 'id', 'word');
    const input = await parseBody(c, createExampleRequestSchema);
    return c.json({ example: await requireLibrary(c).addExample(wordId, input) }, 201);
  });

  app.patch('/api/examples/:id', async (c) => {
    const id = idParam(c, 'id', 'example');
    const input = await parseBody(c, updateExampleRequestSchema);
    return c.json({ example: await requireLibrary(c).updateExample(id, input) });
  });

  app.delete('/api/examples/:id', async (c) => c.json(await requireLibrary(c).deleteExample(idParam(c, 'id', 'example'))));

  app.post('/api/relations', async (c) => {
    const { fromId, toId, kind } = await parseBody(c, createRelationRequestSchema);
    return c.json({ relation: await requireLibrary(c).addRelation(fromId, toId, kind) }, 201);
  });

  app.delete('/api/relations/:id', async (c) => c.json(await requireLibrary(c).deleteRelation(idParam(c, 'id', 'link'))));

  // ---- Vocabulary maps: the learner's own diagrams. Reading, drawing and
  // saving a map never touches a word's content, schedule or review history;
  // the one call that can create vocabulary is a candidate saved on purpose. ----

  app.get('/api/maps', async (c) => c.json(await requireMaps(c).list()));

  app.post('/api/maps', async (c) => {
    const request = await parseBody(c, createMapRequestSchema);
    return c.json(await requireMaps(c).create(request), 201);
  });

  // Registered before the parameterised routes: this is a view, not a map id.
  app.get('/api/maps/personal', async (c) => c.json(await requireMaps(c).personal()));

  app.post('/api/maps/generate', async (c) => {
    if (!config.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    const request = await parseBody(c, generateMapRequestSchema);
    const accountKey = c.get('scope').session?.account.id ?? 'sample';
    const maps = requireMaps(c);
    const seeds = await maps.seedsFor(request);
    // The model drafts; the service decides what of it may be stored. Seed
    // words land saved by their own ids, every other label stays a candidate.
    const draft = await withAiErrors(() =>
      mapBuilder.generate(accountKey, {
        type: request.type,
        topic: request.topic,
        seeds: seeds.words.map((word) => ({ word: word.word })),
      }),
    );
    return c.json(await maps.createFromDraft(request, draft, seeds), 201);
  });

  app.get('/api/maps/:id', async (c) => c.json(await requireMaps(c).get(idParam(c, 'id', 'map'))));

  app.patch('/api/maps/:id', async (c) => {
    const id = idParam(c, 'id', 'map');
    const request = await parseBody(c, updateMapRequestSchema);
    return c.json(await requireMaps(c).update(id, request));
  });

  // Removes the map, its nodes and its edges. Every word it referenced stays.
  app.delete('/api/maps/:id', async (c) => c.json(await requireMaps(c).remove(idParam(c, 'id', 'map'))));

  app.post('/api/maps/:id/nodes', async (c) => {
    const id = idParam(c, 'id', 'map');
    const request = await parseBody(c, addMapNodeRequestSchema);
    return c.json(await requireMaps(c).addNode(id, request), 201);
  });

  app.patch('/api/maps/:id/nodes/:nodeId', async (c) => {
    const mapId = idParam(c, 'id', 'map');
    const nodeId = idParam(c, 'nodeId', 'node');
    const request = await parseBody(c, updateMapNodeRequestSchema);
    return c.json(await requireMaps(c).patchNode(mapId, nodeId, request));
  });

  // Takes the node's edges with it. The word a saved node points at stays.
  app.delete('/api/maps/:id/nodes/:nodeId', async (c) =>
    c.json(await requireMaps(c).removeNode(idParam(c, 'id', 'map'), idParam(c, 'nodeId', 'node'))),
  );

  // The one call that turns a suggestion into real vocabulary — on this
  // explicit request only, through the ordinary word path and its rules.
  app.post('/api/maps/:id/nodes/:nodeId/save', async (c) => {
    const mapId = idParam(c, 'id', 'map');
    const nodeId = idParam(c, 'nodeId', 'node');
    const request = await parseBody(c, saveCandidateRequestSchema);
    return c.json(await requireMaps(c).saveCandidate(mapId, nodeId, request), 201);
  });

  app.post('/api/maps/:id/edges', async (c) => {
    const id = idParam(c, 'id', 'map');
    const request = await parseBody(c, addMapEdgeRequestSchema);
    return c.json(await requireMaps(c).addEdge(id, request), 201);
  });

  app.patch('/api/maps/:id/edges/:edgeId', async (c) => {
    const mapId = idParam(c, 'id', 'map');
    const edgeId = idParam(c, 'edgeId', 'relationship');
    const request = await parseBody(c, updateMapEdgeRequestSchema);
    return c.json(await requireMaps(c).patchEdge(mapId, edgeId, request));
  });

  app.delete('/api/maps/:id/edges/:edgeId', async (c) =>
    c.json(await requireMaps(c).removeEdge(idParam(c, 'id', 'map'), idParam(c, 'edgeId', 'relationship'))),
  );

  app.put('/api/maps/:id/layout', async (c) => {
    const id = idParam(c, 'id', 'map');
    const request = await parseBody(c, saveMapLayoutRequestSchema);
    return c.json(await requireMaps(c).saveLayout(id, request));
  });

  app.post('/api/maps/:id/expand', async (c) => {
    const request = await parseBody(c, expandMapRequestSchema);
    if (!config.writesRequested && request.apply === true) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    const accountKey = c.get('scope').session?.account.id ?? 'sample';
    const maps = requireMaps(c);
    const { map } = await maps.get(idParam(c, 'id', 'map'));
    const type = map.type;
    if (type === 'personal') {
      // The personal map is drawn from the library on every read; there is
      // nothing of its own to expand.
      throw new HttpError(400, 'invalid_request', 'The personal map is drawn live from your library and cannot be expanded.');
    }
    // Only with `apply` are the suggestions stored — as candidate nodes,
    // which are map data, not vocabulary. Without it they are just proposed.
    const draft: AiMapDraft = await withAiErrors(() =>
      mapBuilder.expand(accountKey, {
        type,
        title: map.title,
        nodes: map.nodes.map((node) => ({
          label: node.kind === 'candidate' ? node.label ?? '' : node.word?.word ?? '',
          kind: node.kind,
          group: node.group,
        })),
        edges: map.edges.map((edge) => ({ kind: edge.kind })),
      }),
    );
    const suggestions = await maps.validateSuggestions(map, draft);
    const applied = request.apply === true;
    // Applying twice is harmless without any bookkeeping: the same suggestion
    // is recognised by its label and reused rather than added again.
    if (applied) await maps.applySuggestions(map.id, suggestions);
    return c.json({ suggestions, applied });
  });

  // ---- Discovery & Input: sources, selections, and the one explicit save ----
  //
  // Reading, listening, importing, generating and marking write only
  // discovery rows. The only calls that can create vocabulary are the two
  // saves below, each on an explicit press, through the ordinary word path.
  // Nothing here touches a schedule, mastery, review history or practice.

  app.get('/api/discovery', async (c) => c.json(await requireDiscovery(c).list()));

  app.post('/api/discovery', async (c) => {
    const request = await parseBody(c, createDiscoverySourceRequestSchema);
    return c.json(await requireDiscovery(c).create(request), 201);
  });

  // Views across sources — registered before the parameterised routes below.
  app.get('/api/discovery/marks', async (c) => c.json(await requireDiscovery(c).marks()));

  // Where a saved word was found: the link back from the Word Profile.
  app.get('/api/discovery/context', async (c) => {
    const parsed = pageIdSchema.safeParse(c.req.query('vocabularyId'));
    if (!parsed.success) throw new HttpError(400, 'invalid_request', 'Give the id of a word to look up.');
    return c.json(await requireDiscovery(c).contextFor(parsed.data));
  });

  // Save Now: one word, created by the same request the Add form uses, with
  // the selection's context kept beside it.
  app.post('/api/discovery/save', async (c) => {
    const request = await parseBody(c, saveSelectionRequestSchema);
    return c.json(await requireDiscovery(c).saveSelection(request), 201);
  });

  // The draft reading: shown and validated, stored only when the learner
  // accepts it as an ordinary source creation.
  app.post('/api/discovery/generate', async (c) => {
    if (!config.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    const request = await parseBody(c, aiDiscoveryRequestSchema);
    const accountKey = c.get('scope').session?.account.id ?? 'sample';
    const discovery = requireDiscovery(c);
    const seeds = await discovery.seedsFor(request);
    const draft = await withAiErrors(() =>
      discoveryWriter.draft(accountKey, {
        seeds,
        objective: request.objective,
        length: request.length,
      }),
    );
    return c.json({ draft: await discovery.checkDraft(draft) });
  });

  // Brings a page back as plain text for the preview. Nothing is stored —
  // opening it as a source is the learner's next, separate press.
  app.post('/api/discovery/fetch-url', async (c) => {
    const request = await parseBody(c, fetchUrlRequestSchema);
    try {
      return c.json(await pageFetcher.fetch(request.url));
    } catch (error) {
      if (error instanceof WebImportError) throw webErrorToHttp(error);
      throw error;
    }
  });

  app.get('/api/discovery/:id', async (c) => c.json(await requireDiscovery(c).get(idParam(c, 'id', 'source'))));

  app.patch('/api/discovery/:id', async (c) => {
    const id = idParam(c, 'id', 'source');
    const request = await parseBody(c, updateDiscoverySourceRequestSchema);
    return c.json(await requireDiscovery(c).update(id, request));
  });

  // Removes the source and its marks. Every word those marks became stays.
  app.delete('/api/discovery/:id', async (c) => c.json(await requireDiscovery(c).remove(idParam(c, 'id', 'source'))));

  // Mark for Later: a selection kept, referencing nothing in the library.
  app.post('/api/discovery/:id/marks', async (c) => {
    const id = idParam(c, 'id', 'source');
    const request = await parseBody(c, markSelectionRequestSchema);
    if (request.sourceId !== id) throw new HttpError(400, 'invalid_request', 'That selection does not belong to this source.');
    return c.json(await requireDiscovery(c).mark(request), 201);
  });

  // Processing a marked item later — the explicit save that gives it its word.
  app.post('/api/discovery/marks/:markId/save', async (c) => {
    const markId = idParam(c, 'markId', 'selection');
    const request = await parseBody(c, saveMarkRequestSchema);
    return c.json(await requireDiscovery(c).saveMark(markId, request), 201);
  });

  // Dismiss: the waiting selection is taken out. A saved one keeps its context.
  app.delete('/api/discovery/marks/:markId', async (c) =>
    c.json(await requireDiscovery(c).dismiss(idParam(c, 'markId', 'selection'))),
  );

  // ---- Account settings ----

  const settingsOf = (c: Context<AppEnv>): AccountSettings => {
    const { session } = c.get('scope');
    if (session !== null) {
      return {
        timeZone: session.timeZone,
        timeZoneEditable: true,
        email: session.account.email,
        database: session.database,
        fsrsRetention: session.fsrsRetention,
      };
    }
    if (config.timeZone === null) throw notConfigured();
    return { timeZone: config.timeZone, timeZoneEditable: false, email: null, database: null, fsrsRetention: null };
  };

  app.get('/api/settings', (c) => c.json(settingsOf(c)));

  app.put('/api/settings', async (c) => {
    // Time zone and retention are stored account settings, so they obey the
    // same saving switch as every other write (REVIEW_WRITES_ENABLED).
    if (!config.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    const { session } = c.get('scope');
    if (session === null) {
      throw new HttpError(409, 'not_editable', 'The sample data has no account to keep settings in.');
    }
    const { timeZone, fsrsRetention } = await parseBody(c, updateSettingsRequestSchema);
    const body: AccountSettings = {
      timeZone: timeZone === undefined ? session.timeZone : await session.saveTimeZone(timeZone),
      timeZoneEditable: true,
      email: session.account.email,
      database: session.database,
      fsrsRetention: fsrsRetention === undefined ? session.fsrsRetention : await session.saveFsrsRetention(fsrsRetention),
    };
    return c.json(body);
  });

  // ---- Smart Reader: the sentence a picked word sits in, and what it means there ----

  app.post('/api/ai/extract', async (c) => {
    // Asking the model costs quota, and its answer is only ever a draft for a
    // word the reader then saves — so a frozen account is refused here too.
    if (!config.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    const request = await parseBody(c, aiExtractRequestSchema);
    // One limit per account; the sample words belong to nobody, so they share one.
    const accountKey = c.get('scope').session?.account.id ?? 'sample';
    try {
      return c.json(await reader.extract(accountKey, request));
    } catch (error) {
      if (error instanceof AiError) {
        const http = aiErrorToHttp(error);
        throw new HttpError(http.status, http.code, http.message);
      }
      throw error;
    }
  });

  // ---- Word families: which words were formed from one root ----

  app.post('/api/ai/word-family', async (c) => {
    // The family is only ever a draft the reader reviews, but asking for one
    // costs quota, so a frozen account is refused here too.
    if (!config.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    const request = await parseBody(c, aiWordFamilyRequestSchema);
    const accountKey = c.get('scope').session?.account.id ?? 'sample';
    try {
      return c.json(await familyBuilder.suggest(accountKey, request));
    } catch (error) {
      if (error instanceof AiError) {
        const http = aiErrorToHttp(error);
        throw new HttpError(http.status, http.code, http.message);
      }
      throw error;
    }
  });

  // ---- Example sentences for a word being added ----

  app.post('/api/ai/examples', async (c) => {
    // Asked for like any other AI feature, and reviewed sentence by sentence
    // before anything is saved; a frozen account is refused here too.
    if (!config.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    const request = await parseBody(c, aiExamplesRequestSchema);
    const accountKey = c.get('scope').session?.account.id ?? 'sample';
    try {
      return c.json(await exampleSuggester.suggest(accountKey, request));
    } catch (error) {
      if (error instanceof AiError) {
        const http = aiErrorToHttp(error);
        throw new HttpError(http.status, http.code, http.message);
      }
      throw error;
    }
  });

  // ---- A suggested structure for an exam ----

  app.post('/api/ai/exam-plan', async (c) => {
    // The plan is only ever a draft the reader accepts in the builder, but
    // drawing it up costs quota, so a frozen account is refused here too.
    if (!config.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
    const request = await parseBody(c, aiExamPlanRequestSchema);
    const accountKey = c.get('scope').session?.account.id ?? 'sample';
    // The words are resolved behind row-level security: ids the caller does
    // not own simply are not found, and only this resolved set ever leaves.
    const { entries } = await requireVocabulary(c).list();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const words = request.words.flatMap((id) => byId.get(id) ?? []);
    if (words.length === 0) {
      throw new HttpError(400, 'invalid_request', 'None of those words are in your vocabulary.');
    }
    try {
      return c.json(await examPlanner.suggest(accountKey, words));
    } catch (error) {
      if (error instanceof AiError) {
        const http = aiErrorToHttp(error);
        throw new HttpError(http.status, http.code, http.message);
      }
      throw error;
    }
  });

  // ---- Vocabulary bank. Every write goes through VocabularyService's allow-list. ----

  const entryId = (c: Context): string => {
    const parsed = pageIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) throw new HttpError(400, 'invalid_request', 'That is not a valid word id.');
    return parsed.data;
  };

  app.get('/api/vocabulary', async (c) => c.json(await requireVocabulary(c).list()));

  app.get('/api/trash', async (c) => c.json({ entries: await requireVocabulary(c).listTrashed() }));

  app.get('/api/vocabulary/:id', async (c) => c.json({ entry: await requireVocabulary(c).get(entryId(c)) }));

  app.post('/api/vocabulary', async (c) => {
    const request = await parseBody(c, createEntryRequestSchema);
    const { entry, created } = await requireVocabulary(c).create(request);
    return c.json({ entry }, created ? 201 : 200);
  });

  // A batch of new words, each created exactly as the Add form would create it.
  app.post('/api/vocabulary/import', async (c) => {
    const { items } = await parseBody(c, importRequestSchema);
    return c.json(await requireVocabulary(c).importBatch(items));
  });

  // Everything the caller can read about their own account, in one document. Reads only.
  app.get('/api/export', async (c) => {
    const scoped = c.get('scope').exporter;
    if (scoped === null) throw notConfigured();
    return c.json(await scoped.exportAccount());
  });

  app.patch('/api/vocabulary/:id', async (c) => {
    const id = entryId(c);
    const request = await parseBody(c, updateEntryRequestSchema);
    return c.json({ entry: await requireVocabulary(c).update(id, request) });
  });

  app.delete('/api/vocabulary/:id', async (c) => c.json(await requireVocabulary(c).trash(entryId(c))));

  app.post('/api/vocabulary/:id/restore', async (c) =>
    c.json({ entry: await requireVocabulary(c).restore(entryId(c)) }),
  );

  // ---- Senses (schema version 13) ----
  app.get('/api/vocabulary/:id/senses', async (c) =>
    c.json({ senses: await requireVocabulary(c).listSenses(entryId(c)) }),
  );

  // Registered before the by-sense-id route: "order" is a word of its own.
  app.patch('/api/vocabulary/:id/senses/order', async (c) => {
    const request = await parseBody(c, reorderSensesRequestSchema);
    await requireVocabulary(c).reorderSenses(entryId(c), request);
    return c.json({ ok: true });
  });

  app.get('/api/vocabulary/:id/senses/:senseId', async (c) =>
    c.json({ sense: await requireVocabulary(c).getSense(c.req.param('senseId')) }),
  );

  app.post('/api/vocabulary/:id/senses', async (c) => {
    const request = await parseBody(c, addSenseRequestSchema);
    const result = await requireVocabulary(c).addSense(entryId(c), request);
    return c.json(result, result.created ? 201 : 200);
  });

  app.patch('/api/vocabulary/:id/senses/:senseId', async (c) => {
    const request = await parseBody(c, updateSenseRequestSchema);
    return c.json({ sense: await requireVocabulary(c).updateSense(c.req.param('senseId'), request) });
  });

  app.post('/api/vocabulary/:id/senses/:senseId/archive', async (c) => {
    const request = await parseBody(c, archiveSenseRequestSchema);
    await requireVocabulary(c).archiveSense(c.req.param('senseId'), request);
    return c.json({ ok: true });
  });

  app.post('/api/vocabulary/:id/senses/:senseId/restore', async (c) => {
    const request = await parseBody(c, restoreSenseRequestSchema);
    await requireVocabulary(c).restoreSense(c.req.param('senseId'), request);
    return c.json({ ok: true });
  });

  return app;
}
