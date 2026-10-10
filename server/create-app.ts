import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import {
  createEntryRequestSchema,
  pageIdSchema,
  reviewActionRequestSchema,
  updateEntryRequestSchema,
  updateSettingsRequestSchema,
  type AccountSettings,
  type ApiErrorBody,
  type AppConfigResponse,
} from '../shared/api.js';
import { bearerToken, type AccountGateway, type AccountSession } from './accounts.js';
import type { AppConfig } from './env.js';
import { HttpError } from './errors.js';
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
}

/** What the current request may use. With accounts, all of it belongs to one signed-in user. */
interface Scope {
  review: ReviewService | null;
  vocabulary: VocabularyService | null;
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

export function createApp({ config, service, vocabulary = null, accounts = null }: AppDependencies): Hono<AppEnv> {
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
      c.set('scope', { review: session.review, vocabulary: session.vocabulary, session });
      return next();
    }
    c.set('scope', { review: service, vocabulary, session: null });
    await next();
  });

  app.get('/api/review-queue', async (c) => c.json(await requireService(c).getQueue()));

  app.post('/api/review-action', async (c) => {
    const request = await parseBody(c, reviewActionRequestSchema);
    return c.json(await requireService(c).submitAction(request));
  });

  // ---- Account settings ----

  const settingsOf = (c: Context<AppEnv>): AccountSettings => {
    const { session } = c.get('scope');
    if (session !== null) {
      return { timeZone: session.timeZone, timeZoneEditable: true, email: session.account.email };
    }
    if (config.timeZone === null) throw notConfigured();
    return { timeZone: config.timeZone, timeZoneEditable: false, email: null };
  };

  app.get('/api/settings', (c) => c.json(settingsOf(c)));

  app.put('/api/settings', async (c) => {
    const { session } = c.get('scope');
    if (session === null) {
      throw new HttpError(409, 'not_editable', 'The sample data uses the time zone of the computer it runs on.');
    }
    const { timeZone } = await parseBody(c, updateSettingsRequestSchema);
    const saved = await session.saveTimeZone(timeZone);
    const body: AccountSettings = { timeZone: saved, timeZoneEditable: true, email: session.account.email };
    return c.json(body);
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
