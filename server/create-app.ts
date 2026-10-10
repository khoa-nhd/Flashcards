import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import {
  createEntryRequestSchema,
  loginRequestSchema,
  pageIdSchema,
  reviewActionRequestSchema,
  updateEntryRequestSchema,
  type ApiErrorBody,
} from '../shared/api.js';
import {
  LoginThrottle,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  accessMode,
  issueSessionToken,
  passwordMatches,
  verifySessionToken,
} from './auth.js';
import type { AppConfig } from './env.js';
import { HttpError } from './errors.js';
import { NotionRequestError, notionErrorToHttp } from './notion/notion-errors.js';
import type { ReviewService } from './review-service.js';
import type { VocabularyService } from './vocabulary-service.js';

export interface AppDependencies {
  config: AppConfig;
  /** `null` when configuration problems prevent building the service. */
  service: ReviewService | null;
  /** Whole-record operations; `null` under the same conditions as `service`. */
  vocabulary?: VocabularyService | null;
  now?: () => Date;
}

function errorResponse(c: Context, error: HttpError) {
  const body: ApiErrorBody & Record<string, unknown> = {
    error: { code: error.code, message: error.message },
    ...error.options.body,
  };
  for (const [name, value] of Object.entries(error.options.headers ?? {})) c.header(name, value);
  return c.json(body, error.status as ContentfulStatusCode);
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

export function createApp({ config, service, vocabulary = null, now = () => new Date() }: AppDependencies): Hono {
  const app = new Hono();
  const access = accessMode(config);
  const throttle = new LoginThrottle();

  const notConfigured = () =>
    new HttpError(503, 'setup_incomplete', `The server is not configured yet. ${config.issues.join(' ')}`);

  const requireService = (): ReviewService => {
    if (service === null) throw notConfigured();
    return service;
  };

  const requireVocabulary = (): VocabularyService => {
    if (vocabulary === null) throw notConfigured();
    return vocabulary;
  };

  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    if (error instanceof NotionRequestError) return errorResponse(c, notionErrorToHttp(error));
    // Unknown failures may carry internals, so only their message reaches the log and none of it the client.
    console.error('Unhandled error:', error instanceof Error ? error.message : 'non-error thrown');
    return errorResponse(c, new HttpError(500, 'internal_error', 'Something went wrong on the server.'));
  });

  app.notFound((c) => errorResponse(c, new HttpError(404, 'not_found', 'No such endpoint.')));

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // The session cookie is SameSite=Strict; this also refuses cross-site writes outright.
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
      ok: config.issues.length === 0 && access !== 'locked',
      mode: config.mode,
      access,
      writesRequested: config.writesRequested,
      issues: [
        ...config.issues,
        ...(access === 'locked'
          ? ['No access control is configured. Set APP_ACCESS_PASSWORD (see README, "Keeping the app private").']
          : []),
      ],
    }),
  );

  app.post('/api/login', async (c) => {
    if (config.accessPassword === null) {
      throw new HttpError(400, 'login_not_enabled', 'This server does not use a password.');
    }
    const wait = throttle.retryAfterSeconds(now());
    if (wait > 0) {
      throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in a few minutes.', {
        headers: { 'Retry-After': String(wait) },
      });
    }
    const { password } = await parseBody(c, loginRequestSchema);
    if (!passwordMatches(password, config.accessPassword)) {
      throttle.recordFailure(now());
      throw new HttpError(401, 'invalid_password', 'That password is not correct.');
    }
    throttle.reset();
    setCookie(c, SESSION_COOKIE, issueSessionToken(config.accessPassword, now()), {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.json({ ok: true });
  });

  app.post('/api/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ---- Everything registered below this guard requires access. ----

  app.use('/api/*', async (c, next) => {
    if (access === 'locked') {
      throw new HttpError(
        503,
        'access_not_configured',
        'This deployment has no access control. Set APP_ACCESS_PASSWORD before using it.',
      );
    }
    if (config.accessPassword !== null) {
      if (!verifySessionToken(getCookie(c, SESSION_COOKIE), config.accessPassword, now())) {
        throw new HttpError(401, 'unauthorized', 'Enter the access password to continue.');
      }
    }
    await next();
  });

  app.get('/api/review-queue', async (c) => c.json(await requireService().getQueue()));

  app.post('/api/review-action', async (c) => {
    const request = await parseBody(c, reviewActionRequestSchema);
    return c.json(await requireService().submitAction(request));
  });

  // ---- Vocabulary bank. Every write goes through VocabularyService's allow-list. ----

  const entryId = (c: Context): string => {
    const parsed = pageIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) throw new HttpError(400, 'invalid_request', 'That is not a valid word id.');
    return parsed.data;
  };

  app.get('/api/vocabulary', async (c) => c.json(await requireVocabulary().list()));

  app.get('/api/vocabulary/:id', async (c) => c.json({ entry: await requireVocabulary().get(entryId(c)) }));

  app.post('/api/vocabulary', async (c) => {
    const request = await parseBody(c, createEntryRequestSchema);
    const { entry, created } = await requireVocabulary().create(request);
    return c.json({ entry }, created ? 201 : 200);
  });

  app.patch('/api/vocabulary/:id', async (c) => {
    const id = entryId(c);
    const request = await parseBody(c, updateEntryRequestSchema);
    return c.json({ entry: await requireVocabulary().update(id, request) });
  });

  app.delete('/api/vocabulary/:id', async (c) => c.json(await requireVocabulary().trash(entryId(c))));

  app.post('/api/vocabulary/:id/restore', async (c) =>
    c.json({ entry: await requireVocabulary().restore(entryId(c)) }),
  );

  return app;
}
