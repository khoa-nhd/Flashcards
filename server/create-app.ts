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
  type AccountSettings,
  type ApiErrorBody,
  type AppConfigResponse,
} from '../shared/api.js';
import { bearerToken, type AccountGateway, type AccountSession } from './accounts.js';
import { createAiAdapter, AiError } from './ai/adapter.js';
import { createTokenBucket } from './ai/rate-limit.js';
import { AI_RATE, SmartReader, aiErrorToHttp } from './ai/smart-reader.js';
import { WORD_FAMILY_RATE, WordFamily } from './ai/word-family.js';
import { EXAMPLES_RATE, Examples } from './ai/examples.js';
import { EXAM_PLAN_RATE, ExamPlan } from './ai/exam-plan.js';
import type { AnalyticsService } from './analytics-service.js';
import { aiExtractRequestSchema, aiWordFamilyRequestSchema, aiExamplesRequestSchema, aiExamPlanRequestSchema } from '../shared/ai.js';
import type { AppConfig } from './env.js';
import { HttpError } from './errors.js';
import type { ExportService } from './export-service.js';
import type { LibraryService } from './library-service.js';
import type { ReviewService } from './review-service.js';
import { DatabaseError } from './supabase/supabase-database.js';
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

  // The language model for the AI features, if this server has one. Built
  // once for the app; without a key the adapter answers "not configured" and
  // the features fall back to being done by hand.
  const aiAdapter = createAiAdapter(config.ai);
  const reader = new SmartReader({ adapter: aiAdapter, limiter: createTokenBucket(AI_RATE) });
  const familyBuilder = new WordFamily({ adapter: aiAdapter, limiter: createTokenBucket(WORD_FAMILY_RATE) });
  const exampleSuggester = new Examples({ adapter: aiAdapter, limiter: createTokenBucket(EXAMPLES_RATE) });
  const examPlanner = new ExamPlan({ adapter: aiAdapter, limiter: createTokenBucket(EXAM_PLAN_RATE) });

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
        session,
      });
      return next();
    }
    c.set('scope', { review: service, vocabulary, analytics, library, exporter, session: null });
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

  return app;
}
