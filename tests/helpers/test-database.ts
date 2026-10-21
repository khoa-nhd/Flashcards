/**
 * A real PostgreSQL (compiled to WebAssembly, running in this process) with
 * the project's migrations applied, for testing the schema, the Row Level
 * Security policies and the database functions exactly as written.
 *
 * Only the parts of a hosted Supabase project that the migrations rely on are
 * stubbed: the `anon` / `authenticated` roles, the `auth.users` table and
 * `auth.uid()`, which reads the signed-in user from the request's JWT claims
 * the same way the hosted platform does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';

const PLATFORM_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique not null
  );
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
  $$;

  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant usage on schema public to anon, authenticated;

  -- A hosted project grants everything on new objects by default; the
  -- migrations must hold up against that, so the stub does the same.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

export function readMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

/**
 * How many migration files come before version 15, where FSRS becomes the only
 * schedule. Tests of the mastery schedule run on a database stopped there:
 * until the owner runs version 15, that is what production has.
 */
export const MASTERY_ERA_MIGRATIONS = readMigrations().findIndex((migration) => migration.name.endsWith('_fsrs_only.sql'));

/** The schema version a database stopped at `MASTERY_ERA_MIGRATIONS` reports. */
export const MASTERY_ERA_SCHEMA_VERSION = 14;

export type Row = Record<string, unknown>;

export interface Session {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface TestDatabase {
  db: PGlite;
  createUser(email: string): Promise<string>;
  /** Runs statements the way a signed-in user's requests reach the database. */
  as<T>(userId: string, work: (session: Session) => Promise<T>): Promise<T>;
  /** Runs statements as a visitor who is not signed in. */
  asAnon<T>(work: (session: Session) => Promise<T>): Promise<T>;
  /** Bypasses RLS, for arranging and inspecting test data only. */
  admin<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface TestDatabaseOptions {
  /**
   * Apply only the first N migrations, to stand in for a project whose owner
   * has not run the newer ones yet. All of them by default.
   */
  migrations?: number;
}

export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const db = new PGlite();
  await db.exec(PLATFORM_STUB);
  for (const migration of readMigrations().slice(0, options.migrations)) await db.exec(migration.sql);

  const session = (tx: Transaction): Session => ({
    async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
      return (await tx.query<T>(sql, params)).rows;
    },
  });

  const run = async <T>(role: 'anon' | 'authenticated', claims: object, work: (s: Session) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await tx.exec(`set local role ${role}`);
      return work(session(tx));
    });

  return {
    db,
    async createUser(email) {
      const result = await db.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email]);
      return result.rows[0]!.id;
    },
    as: (userId, work) => run('authenticated', { sub: userId, role: 'authenticated' }, work),
    asAnon: (work) => run('anon', { role: 'anon' }, work),
    async admin<T extends Row = Row>(sql: string, params: unknown[] = []) {
      return (await db.query<T>(sql, params)).rows;
    },
    close: () => db.close(),
  };
}
