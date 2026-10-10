/**
 * The HTTP API in Supabase mode, with the hosted pieces replaced by local
 * ones: tokens are looked up in a table instead of verified by Supabase Auth,
 * and queries go to the in-process PostgreSQL. Row Level Security, the
 * database functions and all application code are the real thing.
 */
import { cardFields, newWordDefaults, reviewRules } from '../../config/review.config.js';
import { createApp } from '../../server/create-app.js';
import { loadConfig } from '../../server/env.js';
import { createSupabaseAccounts, type TokenVerifier } from '../../server/supabase/supabase-accounts.js';
import type { VocabularyDatabase } from '../../server/supabase/supabase-database.js';
import { NOW } from './fixtures.js';
import { createPgVocabularyDatabase } from './pg-vocabulary-database.js';
import type { TestDatabase } from './test-database.js';

export const SUPABASE_ENV = {
  DATA_MODE: 'supabase',
  SUPABASE_URL: 'https://project-ref.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_test_key',
};

export interface TestUser {
  id: string;
  email: string;
  /** Stands in for the access token Supabase Auth would issue. */
  token: string;
}

export async function createTestUser(db: TestDatabase, name: string): Promise<TestUser> {
  const email = `${name}@example.com`;
  return { id: await db.createUser(email), email, token: `${name}.session.token` };
}

export interface SupabaseAppOptions {
  env?: Record<string, string>;
  now?: () => Date;
  verifier?: TokenVerifier;
  /** Lets a test make the database misbehave. */
  wrap?: (database: VocabularyDatabase) => VocabularyDatabase;
}

export function createSupabaseTestApp(db: TestDatabase, users: TestUser[], options: SupabaseAppOptions = {}) {
  const config = loadConfig({ ...SUPABASE_ENV, ...options.env });
  if (config.supabase === null) throw new Error(`Test configuration is incomplete: ${config.issues.join(' ')}`);
  const byToken = new Map(users.map((user) => [user.token, user]));
  const now = options.now ?? (() => NOW);

  const accounts = createSupabaseAccounts({
    url: config.supabase.url,
    publicKey: config.supabase.publicKey,
    // The owner's real rules and card layout: this is the behaviour being preserved.
    rules: reviewRules,
    cardFields,
    defaults: newWordDefaults,
    defaultTimeZone: config.timeZone,
    writesRequested: config.writesRequested,
    verifier: options.verifier ?? {
      async verify(token) {
        const user = byToken.get(token);
        return user === undefined ? null : { id: user.id, email: user.email };
      },
    },
    connect(token) {
      const user = byToken.get(token);
      if (user === undefined) throw new Error('No such test user.');
      const database = createPgVocabularyDatabase(db, user.id);
      return options.wrap ? options.wrap(database) : database;
    },
    now,
  });

  return createApp({ config, service: null, accounts });
}

export type TestApp = ReturnType<typeof createSupabaseTestApp>;

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** The device's time zone, as the browser reports it. */
  zone?: string | null;
  headers?: Record<string, string>;
}

/** One request, made as `user` (or as nobody when `null`). */
export function call(app: TestApp, user: TestUser | null, path: string, options: CallOptions = {}) {
  const zone = options.zone === undefined ? 'Asia/Ho_Chi_Minh' : options.zone;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(user === null ? {} : { Authorization: `Bearer ${user.token}` }),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(zone === null ? {} : { 'X-Time-Zone': zone }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

let counter = 0;

/** A fresh, valid request id for each call. */
export const newId = () => `aaaaaaaa-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
