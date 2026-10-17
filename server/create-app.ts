import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ZodType } from 'zod';
import {
  REVIEW_FOCUSES,
  aiMessageSavedRequestSchema,
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
  reviewQueueSelectionRequestSchema,
  reviewUndoRequestSchema,
  schedulerChoiceRequestSchema,
  updateEntryRequestSchema,
  updateExampleRequestSchema,
  updateSettingsRequestSchema,
  type AccountSettings,
  type ApiErrorBody,
  type AppConfigResponse,
  type VocabularyEntry,
} from '../shared/api.js';
import { bearerToken, type AccountGateway, type AccountSession } from './accounts.js';
import type { AnalyticsService } from './analytics-service.js';
import type { AppConfig } from './env.js';
import { HttpError } from './errors.js';
import type { ExportService } from './export-service.js';
import type { LibraryService } from './library-service.js';
import type { ReviewService } from './review-service.js';
import { DatabaseError } from './supabase/supabase-database.js';
import type { VocabularyService } from './vocabulary-service.js';
import { type AiService } from './ai-service-impl.js';
import { AiError, AiErrorCode } from './ai-service.js';
import { AI_MODES } from './ai-service.js';

export interface AppDependencies {
  config: AppConfig;
  /** `null` when configuration problems prevent building the service, or when each account has its own. */
  service: ReviewService | null;
  /** Whole-record operations; `null` under the same conditions as `service`. */
  vocabulary?: VocabularyService | null;
  /** AI chat service; `null` under the same conditions as `service`. */
  ai?: AiService | null;
  /** Present when the app has accounts: every request then gets services of its own. */
  accounts?: AccountGateway | null;
  /** Review activity and weak words; `null` under the same conditions as `service`. */
  analytics?: AnalyticsService | null;
  /** Collections, further examples and relationships; `null` under the same conditions as `service`. */
  library?: LibraryService | null;
  /** The account's own export; `null` under the same conditions as `service`. */
  exporter?: ExportService | null;
}

/** What the current request may use. With accounts, all of it belongs to one signed-in user. */
interface Scope {
  review: ReviewService | null;
  vocabulary: VocabularyService | null;
  analytics: AnalyticsService | null;
  library: LibraryService | null;
  exporter: ExportService | null;
  session: AccountSession | null;
  ai: AiService | null;
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
    case 'unavailable':
      return new HttpError(503, 'database_unavailable', `${error.message} Nothing was changed; try again shortly.`);
  }
}

/** The status an AI failure is reported with: its own where it is a real HTTP error status. */
function aiStatus(error: AiError): number {
  if (error.code === AiErrorCode.CONFIG_MISSING) return 503;
  return Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
}

/** A conversation's name, taken from its first message. */
function titleFrom(message: string): string {
  const line = message.trim().split('\n')[0]?.trim() ?? '';
  const title = line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
  return title === '' ? 'New conversation' : title;
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

export function createApp({
  config,
  service,
  vocabulary = null,
  accounts = null,
  analytics = null,
  library = null,
  exporter = null,
}: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Everyone signs in to their own account, except with the built-in sample words, which belong to nobody.
  const usesAccounts = config.mode === 'supabase';

  const notConfigured = () =>
    new HttpError(503, 'setup_incomplete', `The server is not configured yet. ${config.issues.join(' ')}`);

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

  const requireAi = (c: Context<AppEnv>): AiService => {
    const scoped = c.get('scope').ai;
    if (scoped === null) throw new HttpError(503, 'ai_unavailable', 'AI chat is not configured on this server.');
    return scoped;
  };

  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    if (error instanceof AiError) {
      const headers = error.retryAfter === undefined ? undefined : { 'Retry-After': String(error.retryAfter) };
      return errorResponse(c, new HttpError(aiStatus(error), error.code, error.message, { headers }));
    }
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

  app.use(
    '/api/*',
    bodyLimit({
      // Three free-text fields of up to 6,000 characters each, in UTF-8.
      maxSize: 96 * 1024,
      onError: () => {
        throw new HttpError(413, 'payload_too_large', 'The request body is too large.');
      },
    }),
  );

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
        exporter: session.exporter,
        ai: session.ai,
        session,
      });
      return next();
    }
    c.set('scope', { review: service, vocabulary, analytics, library, exporter, ai: null, session: null });
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

  const idParam = (c: Context, name: string, what: string): string => {
    const parsed = pageIdSchema.safeParse(c.req.param(name));
    if (!parsed.success) throw new HttpError(400, 'invalid_request', `That is not a valid ${what} id.`);
    return parsed.data;
  };

  app.get('/api/review-queue', async (c) => {
    const raw = c.req.query('focus');
    if (raw === undefined) return c.json(await requireService(c).getQueue());
    const parsed = reviewFocusSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', `Unknown focus. Use one of: ${REVIEW_FOCUSES.join(', ')}.`);
    }
    // The one narrowing the server can work out for itself: the weak words, weakest first,
    // whether or not they are due. Each carries its recovery, so the session can show it.
    const { words } = await requireAnalytics(c).weakWords();
    const recovery = new Map(
      words.flatMap((word) => (word.recovery === undefined ? [] : [[word.id, word.recovery]])),
    );
    return c.json(
      await requireService(c).getQueue({ kind: 'weak', ids: words.map((word) => word.id), recovery }),
    );
  });

  // The reviewer's own picked words, in the order they were ticked. Sent as a body rather than
  // in the address, because the list may be as long as the bank.
  app.post('/api/review-queue', async (c) => {
    const { ids } = await parseBody(c, reviewQueueSelectionRequestSchema);
    return c.json(await requireService(c).getQueue({ kind: 'selection', ids }));
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
        countReviewsTowardMastery: session.countReviewsTowardMastery,
      };
    }
    if (config.timeZone === null) throw notConfigured();
    return {
      timeZone: config.timeZone,
      timeZoneEditable: false,
      email: null,
      database: null,
      fsrsRetention: null,
      // Nothing keeps a choice without an account, so a review counts by default.
      countReviewsTowardMastery: true,
    };
  };

  app.get('/api/settings', (c) => c.json(settingsOf(c)));

  app.put('/api/settings', async (c) => {
    const { session } = c.get('scope');
    if (session === null) {
      throw new HttpError(409, 'not_editable', 'The sample data has no account to keep settings in.');
    }
    const { timeZone, fsrsRetention, countReviewsTowardMastery } = await parseBody(c, updateSettingsRequestSchema);
    const body: AccountSettings = {
      timeZone: timeZone === undefined ? session.timeZone : await session.saveTimeZone(timeZone),
      timeZoneEditable: true,
      email: session.account.email,
      database: session.database,
      fsrsRetention: fsrsRetention === undefined ? session.fsrsRetention : await session.saveFsrsRetention(fsrsRetention),
      countReviewsTowardMastery:
        countReviewsTowardMastery === undefined
          ? session.countReviewsTowardMastery
          : await session.saveCountReviewsTowardMastery(countReviewsTowardMastery),
    };
    return c.json(body);
  });

  // ---- Vocabulary bank. Every write goes through VocabularyService's allow-list. ----

  const entryId = (c: Context): string => {
    const parsed = pageIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) throw new HttpError(400, 'invalid_request', 'That is not a valid word id.');
    return parsed.data;
  };

  app.get('/api/vocabulary', async (c) => c.json(await requireVocabulary(c).list()));

  // A word's practice mastery per study mode: a count of recorded practice answers. Reads only.
  app.get('/api/vocabulary/:id/practice-mastery', async (c) => c.json(await requireService(c).practiceMastery(entryId(c))));

  // Practice history for True Mastery: detailed answers with correctness, timestamps, mode, grading, session.
  app.get('/api/practice-history', async (c) => {
    const since = c.req.query('since') ?? null;
    const answers = await requireService(c).practiceHistory(since);
    return c.json({ available: answers.length > 0, answers });
  });

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

  // ---- AI Chat routes (require schema version 10) ----

  const aiModeSchema = z.enum(AI_MODES);
  const aiMessageSchema = z.strictObject({
    content: z.string().min(1).max(32000),
  });
  const aiConversationCreateSchema = z.strictObject({
    mode: aiModeSchema,
    title: z.string().max(200).optional(),
  });
  const aiConversationUpdateSchema = z.strictObject({
    title: z.string().max(200),
  });

  // List conversations
  app.get('/api/ai/conversations', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, 'invalid_request', 'limit must be an integer between 1 and 100.');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new HttpError(400, 'invalid_request', 'offset must be a non-negative integer.');
    }
    return c.json({ conversations: await requireAi(c).listConversations(limit, offset) });
  });

  // Create conversation
  app.post('/api/ai/conversations', async (c) => {
    const { mode, title } = await parseBody(c, aiConversationCreateSchema);
    return c.json({ conversation: await requireAi(c).createConversation(mode, title) }, 201);
  });

  // Get conversation with messages
  app.get('/api/ai/conversations/:id', async (c) => {
    const conversationId = idParam(c, 'id', 'conversation');
    const limit = Number(c.req.query('limit') ?? '200');
    const offset = Number(c.req.query('offset') ?? '0');
    const conversation = await requireAi(c).getConversation(conversationId);
    if (!conversation) throw new HttpError(404, 'not_found', 'Conversation not found.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
      throw new HttpError(400, 'invalid_request', 'limit must be 1 to 500 and offset 0 or more.');
    }
    const messages = await requireAi(c).listMessageRecords(conversationId, limit, offset);
    return c.json({ conversation, messages });
  });

  // Update conversation title
  app.patch('/api/ai/conversations/:id', async (c) => {
    const conversationId = idParam(c, 'id', 'conversation');
    const { title } = await parseBody(c, aiConversationUpdateSchema);
    const updated = await requireAi(c).updateConversationTitle(conversationId, title);
    if (!updated) throw new HttpError(404, 'not_found', 'Conversation not found.');
    return c.json({ success: true });
  });

  // Delete conversation
  app.delete('/api/ai/conversations/:id', async (c) => {
    const conversationId = idParam(c, 'id', 'conversation');
    const deleted = await requireAi(c).deleteConversation(conversationId);
    if (!deleted) throw new HttpError(404, 'not_found', 'Conversation not found.');
    return c.json({ success: true });
  });

  // Send message (streaming)
  app.post('/api/ai/conversations/:id/messages', async (c) => {
    const conversationId = idParam(c, 'id', 'conversation');
    const { content } = await parseBody(c, aiMessageSchema);

    const ai = requireAi(c);
    const conversation = await ai.getConversation(conversationId);
    if (!conversation) throw new HttpError(404, 'not_found', 'Conversation not found.');

    if (content.trim().length > ai.config.maxInputChars) {
      throw new HttpError(400, 'message_too_long', `Messages can be at most ${ai.config.maxInputChars} characters.`);
    }

    const history = await ai.listMessages(conversationId);
    const context = ai.buildContext(conversationId, conversation.mode, history, content.trim());

    // Refused before anything is streamed, so the reason arrives as an ordinary error response.
    const limits = await ai.checkRateLimits(conversation.mode);
    ai.enforceRateLimits(limits);

    // A new conversation is named after its first message.
    if (history.length === 0 && conversation.title === 'New conversation') {
      await ai.updateConversationTitle(conversationId, titleFrom(content));
    }

    // Server-sent events, one JSON object each, in the shape the page reads (AiStreamChunk in shared/api.ts):
    // `delta` pieces of the reply, then `done`, or `error` if it could not be finished.
    const encoder = new TextEncoder();
    const event = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    const generator = ai.generateResponse(conversationId, context, c.req.raw.signal);
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let usage: unknown = null;
        let finishReason: string | null = null;
        try {
          for await (const chunk of generator) {
            if (chunk.delta !== '') controller.enqueue(event({ type: 'delta', delta: chunk.delta }));
            if (chunk.usage !== null) usage = chunk.usage;
            if (chunk.finishReason !== null) finishReason = chunk.finishReason;
          }
          controller.enqueue(event({ type: 'done', usage, finishReason }));
        } catch (error) {
          if (error instanceof AiError) {
            controller.enqueue(event({ type: 'error', code: error.code, message: error.message }));
          } else {
            // Unknown failures may carry internals: the log gets the kind, the reader a plain sentence.
            const kind = error instanceof DatabaseError ? `database ${error.failure}` : error instanceof Error ? error.name : 'non-error';
            console.error(`AI reply failed: ${kind}`);
            controller.enqueue(event({ type: 'error', code: 'internal_error', message: 'The reply could not be finished. Try again.' }));
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  // Marks a Vocabulary Expert reply as saved to one of the caller's words, so
  // the "Added" state survives a reload. Best effort: a database older than
  // version 12 has nowhere to keep the link and answers `saved: false`.
  app.post('/api/ai/conversations/:id/messages/:messageId/saved', async (c) => {
    const conversationId = idParam(c, 'id', 'conversation');
    const messageId = idParam(c, 'messageId', 'message');
    const { vocabularyId } = await parseBody(c, aiMessageSavedRequestSchema);

    const ai = requireAi(c);
    const conversation = await ai.getConversation(conversationId);
    if (!conversation) throw new HttpError(404, 'not_found', 'Conversation not found.');
    if (conversation.mode !== 'vocabulary_expert') {
      throw new HttpError(400, 'invalid_request', 'Only Vocabulary Expert replies can be added to the vocabulary.');
    }

    const saved = await ai.markMessageSaved(conversationId, messageId, vocabularyId);
    return c.json({ saved });
  });

  // Save vocabulary from Vocabulary Expert response
  const aiVocabularySaveSchema = z.strictObject({
    conversationId: z.string().uuid(),
    analysis: z.object({
      word: z.string(),
      definition: z.string(),
      pronunciation: z.string().nullable().optional(),
      partOfSpeech: z.string().nullable().optional(),
      cefrLevel: z.string().nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
      englishDefinition: z.string().nullable().optional(),
      vietnameseMeaning: z.string().nullable().optional(),
      senses: z.array(
        z
          .object({
            partOfSpeech: z.string().nullable().optional(),
            englishDefinition: z.string().nullable().optional(),
            vietnameseMeaning: z.string().nullable().optional(),
            examples: z.array(z.unknown()).optional(),
          })
          .passthrough(),
      ).optional(),
      examples: z.array(z.object({
        english: z.string(),
        vietnamese: z.string(),
      })).optional(),
      wordFamily: z.array(z.object({
        word: z.string(),
        partOfSpeech: z.string().nullable().optional(),
        definition: z.string().nullable().optional(),
      })).optional(),
      collocations: z.array(z.object({
        expression: z.string(),
        meaning: z.string(),
        example: z.string().nullable().optional(),
      })).optional(),
      synonyms: z.array(z.object({
        word: z.string(),
        nuance: z.string().nullable().optional(),
      })).optional(),
      antonyms: z.array(z.object({
        word: z.string(),
        nuance: z.string().nullable().optional(),
      })).optional(),
      usageNotes: z.string().nullable().optional(),
      commonMistakes: z.string().nullable().optional(),
      revisionSummary: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
    }).passthrough(),
  });

  app.post('/api/ai/conversations/:id/vocabulary-save', async (c) => {
    const conversationId = idParam(c, 'id', 'conversation');
    const { analysis } = await parseBody(c, aiVocabularySaveSchema);

    const ai = requireAi(c);
    const vocabulary = requireVocabulary(c);
    const conversation = await ai.getConversation(conversationId);
    if (!conversation) throw new HttpError(404, 'not_found', 'Conversation not found.');
    if (conversation.mode !== 'vocabulary_expert') {
      throw new HttpError(400, 'invalid_request', 'Vocabulary save only available in Vocabulary Expert mode.');
    }

    // The analysis always carries `definition`; `englishDefinition` is the same
    // value under its longer name. Falling back means the word keeps its
    // definition whichever name the caller used.
    const definition = analysis.englishDefinition ?? analysis.definition ?? null;
    const example = analysis.examples?.[0]?.english ?? null;

    // Check if word already exists
    const existing = await vocabulary.findEntriesByWord(analysis.word);
    let vocabularyEntry: VocabularyEntry;
    const found = existing[0];
    if (found) {
      // Word exists, update it with new analysis. Omitted fields are left as they are.
      vocabularyEntry = await vocabulary.update(found.id, {
        meaning: analysis.vietnameseMeaning ?? undefined,
        definition: definition ?? undefined,
        example: example ?? undefined,
      });
    } else {
      // Create new vocabulary entry
      const result = await vocabulary.create({
        word: analysis.word,
        meaning: analysis.vietnameseMeaning ?? undefined,
        definition: definition ?? undefined,
        example: example ?? undefined,
        requestId: crypto.randomUUID(),
      });
      vocabularyEntry = result.entry;
    }

    // Save the full analysis
    const senses = analysis.senses
      ? analysis.senses.map(s => ({
          partOfSpeech: s.partOfSpeech,
          englishDefinition: s.englishDefinition,
          vietnameseMeaning: s.vietnameseMeaning,
          examples: s.examples,
        }))
      : [];

    const examples = analysis.examples
      ? analysis.examples.map(e => ({
          english: e.english,
          vietnamese: e.vietnamese,
        }))
      : [];

    const wordFamily = analysis.wordFamily
      ? analysis.wordFamily.map(w => ({
          word: w.word,
          partOfSpeech: w.partOfSpeech,
          definition: w.definition,
        }))
      : [];

    const collocations = analysis.collocations
      ? analysis.collocations.map(c => ({
          expression: c.expression,
          meaning: c.meaning,
          example: c.example,
        }))
      : [];

    const synonyms = analysis.synonyms
      ? analysis.synonyms.map(s => ({
          word: s.word,
          nuance: s.nuance,
        }))
      : [];

    const antonyms = analysis.antonyms
      ? analysis.antonyms.map(a => ({
          word: a.word,
          nuance: a.nuance,
        }))
      : [];

    await ai.upsertVocabularyAnalysis({
      vocabularyId: vocabularyEntry.id,
      pronunciation: analysis.pronunciation ?? null,
      partOfSpeech: analysis.partOfSpeech ?? null,
      cefrLevel: analysis.cefrLevel ?? null,
      confidence: analysis.confidence ?? null,
      englishDefinition: analysis.englishDefinition ?? null,
      vietnameseMeaning: analysis.vietnameseMeaning ?? null,
      senses,
      examples,
      wordFamily,
      collocations,
      synonyms,
      antonyms,
      usageNotes: analysis.usageNotes ?? null,
      commonMistakes: analysis.commonMistakes ?? null,
      revisionSummary: analysis.revisionSummary ?? null,
      model: analysis.model ?? 'vocabulary_expert',
    });

    return c.json({ vocabulary: vocabularyEntry }, 201);
  });

  return app;
}
