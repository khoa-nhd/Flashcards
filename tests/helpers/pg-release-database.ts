/**
 * Real PostgreSQL and several independent connections — the release-safety
 * half of the database tests. `tests/helpers/test-database.ts` runs the same
 * migrations on PGlite, which is one connection: sound for the schema, the
 * policies and the calls, but it cannot overlap two transactions. This
 * harness talks to a genuine local PostgreSQL instance over loopback (one
 * `pg` connection per session, so overlapping transactions are real) and
 * exposes the same `as` / `asAnon` / `admin` shape the PGlite suites use.
 *
 * The suites live next to this file and end in `.pgtest.ts`, which the
 * project's `npm test` does not collect. They run after the instance is up:
 *
 *     $env:PGREL_PASSWORD = '…'          # the instance's own password
 *     npx vitest run --config tests/pg-release/vitest.config.ts
 *
 * Numbers: `pg` returns `bigint` / `numeric` as strings — cast in the SQL
 * (`::int`, `::text`) the way the PGlite suites already do.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const HOST = process.env.PGREL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PGREL_PORT ?? '15432');
const USER = process.env.PGREL_USER ?? 'rel012_admin';
const PASSWORD = process.env.PGREL_PASSWORD ?? '';

/** Only databases whose name starts with this prefix may be created or dropped. */
const TEST_DATABASE_PREFIX = 'rel012_';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

export function readMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

/**
 * The parts of a hosted Supabase project the migrations rely on and a bare
 * PostgreSQL does not have: the `anon` / `authenticated` / `service_role`
 * roles, the `auth` schema with its users table, and `auth.uid()` reading the
 * request's JWT claims. Same stub as the PGlite harness, made idempotent
 * because the roles live once per cluster, not once per database.
 */
const PLATFORM_STUB = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    if not exists (select 1 from pg_roles where rolname = 'rel012_authenticator') then
      execute 'create role rel012_authenticator login password ''${PASSWORD.replace(/'/g, "''")}''';
    end if;
  end $$;

  -- The session user of every identity session, the way the hosted path
  -- works: PostgREST connects as a non-superuser "authenticator" and switches
  -- to anon/authenticated per request. A session user with no attributes and
  -- only these two memberships is what makes \`set role\` answer to the same
  -- check a hosted session would face — FC-SEC-013's recovery role must stay
  -- out of reach that way, and a superuser session user would mask it.
  grant authenticated to rel012_authenticator;
  grant anon to rel012_authenticator;

  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique not null
  );
  create or replace function auth.uid() returns uuid language sql stable as $$
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

export type Row = Record<string, unknown>;

export interface Session {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Who the statements in a session are made as, mirroring the hosted path. */
export type Identity =
  | { role: 'anon' }
  | { role: 'authenticated'; userId: string; claims?: Record<string, unknown> };

export interface OpenSession extends Session {
  /** Starts a transaction and, with an identity, the claims and role of it. */
  begin(identity?: Identity): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  /** The session's own backend pid — the handle every lock test reasons by. */
  backendPid(): Promise<number>;
}

export interface OpenOptions {
  /** Applied for the session: how long a blocked statement waits on a lock. */
  lockTimeout?: string;
  /** Applied for the session: how long any statement may run. */
  statementTimeout?: string;
}

export interface ReleaseDatabase {
  name: string;
  createUser(email: string): Promise<string>;
  /** Runs statements the way a signed-in user's requests reach the database. */
  as<T>(userId: string, work: (session: Session) => Promise<T>): Promise<T>;
  /** Runs statements as a visitor who is not signed in. */
  asAnon<T>(work: (session: Session) => Promise<T>): Promise<T>;
  /** Bypasses RLS, for arranging and inspecting test data only. */
  admin<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * An independent connection — one backend of its own. Two of these hold two
   * transactions that can genuinely overlap, which is the point of this
   * harness: `begin` on both, and the statements between them are concurrent.
   */
  open(identity?: Identity, options?: OpenOptions): Promise<OpenSession>;
  /** An owner-level connection, for watching backends and locks from outside. */
  openInspector(): Promise<OpenSession>;
  /**
   * Applies migrations up to `to` (the count from the beginning of the
   * sequence), continuing where creation stopped — an owner upgrading a
   * project that has fallen behind.
   */
  applyMigrations(to: number): Promise<void>;
  /** Ends every session of this database and drops it. */
  drop(): Promise<void>;
}

export interface ReleaseDatabaseOptions {
  /**
   * Apply only the first N migrations, to stand in for a project whose owner
   * has not run the newer ones yet. All of them by default.
   */
  migrations?: number;
}

/** The hosted stand-in: every identity session's session user (see the stub). */
const AUTHENTICATOR = 'rel012_authenticator';

const connectionOptions = (database: string, user: string) => ({
  host: HOST,
  port: PORT,
  user,
  password: PASSWORD,
  database,
  application_name: 'fc-release-012',
  connectionTimeoutMillis: 5000,
});

const connect = async (database: string, user: string = USER) => {
  const client = new Client(connectionOptions(database, user));
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('password authentication failed') || message.includes('no password supplied')) {
      throw new Error(
        `PostgreSQL at ${HOST}:${PORT} rejected ${user}. Set PGREL_PASSWORD to the instance's password ` +
          `(and check the instance is up — see FC-RELEASE-012-REPORT.md section A). Original: ${message}`,
        { cause: error },
      );
    }
    throw error;
  }
};

const session = (client: Client): Session => ({
  async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
    return (await client.query<T>(sql, params as never[])).rows;
  },
});

const openSession = async (client: Client, identity?: Identity, options: OpenOptions = {}): Promise<OpenSession> => {
  const base = session(client);
  if (options.lockTimeout) await client.query(`select set_config('lock_timeout', $1, false)`, [options.lockTimeout]);
  if (options.statementTimeout) await client.query(`select set_config('statement_timeout', $1, false)`, [options.statementTimeout]);
  let pid = 0;
  return {
    ...base,
    async begin(identityOfTransaction) {
      await client.query('begin');
      const who = identityOfTransaction ?? identity;
      if (who?.role === 'authenticated') {
        const claims = { sub: who.userId, role: 'authenticated', ...who.claims };
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await client.query('set local role authenticated');
      } else if (who?.role === 'anon') {
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
        await client.query('set local role anon');
      }
    },
    async commit() {
      await client.query('commit');
    },
    async rollback() {
      await client.query('rollback');
    },
    async close() {
      await client.end();
    },
    async backendPid() {
      if (pid === 0) {
        const rows = await base.query<{ pid: number }>('select pg_backend_pid() as pid');
        pid = rows[0]!.pid;
      }
      return pid;
    },
  };
};

/** The name guard: this harness never touches a database it did not create. */
const checkedName = (name: string) => {
  if (!new RegExp(`^${TEST_DATABASE_PREFIX}[a-z0-9_]+$`).test(name)) {
    throw new Error(`Refusing to touch database "${name}": names under "${TEST_DATABASE_PREFIX}" only.`);
  }
  return name;
};

export async function createReleaseDatabase(
  name: string,
  options: ReleaseDatabaseOptions = {},
): Promise<ReleaseDatabase> {
  const database = checkedName(name);

  const postgres = await connect('postgres');
  try {
    await postgres.query(`drop database if exists ${database} with (force)`);
    await postgres.query(`create database ${database}`);
  } finally {
    await postgres.end();
  }

  const owner = await connect(database);
  // A dropped or restarted database ends this connection behind our back;
  // the failure would surface as an unhandled event rather than an error.
  owner.on('error', () => undefined);
  const runAsOwner = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await owner.query(sql, params as never[])).rows as T[];

  await runAsOwner(PLATFORM_STUB);
  const migrations = readMigrations();
  let applied = 0;
  const applyUpTo = async (to: number) => {
    for (const migration of migrations.slice(applied, to)) await runAsOwner(migration.sql);
    applied = to;
  };
  await applyUpTo(options.migrations ?? migrations.length);

  // Identity sessions connect as the authenticator, not the owner: their
  // session user is a plain non-superuser with no role memberships beyond
  // anon/authenticated, exactly like the hosted request path. Owner-level
  // sessions (admin, migrations, the inspector) keep the owner connection.
  const open = async (identity?: Identity, openOptions?: OpenOptions) =>
    openSession(await connect(database, AUTHENTICATOR), identity, openOptions);

  return {
    name: database,
    async createUser(email) {
      const rows = await runAsOwner<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email]);
      return rows[0]!.id;
    },
    async as(userId, work) {
      const s = await open({ role: 'authenticated', userId });
      try {
        await s.begin();
        const result = await work(s);
        await s.commit();
        return result;
      } catch (error) {
        await s.rollback().catch(() => undefined);
        throw error;
      } finally {
        await s.close();
      }
    },
    async asAnon(work) {
      const s = await open({ role: 'anon' });
      try {
        await s.begin();
        const result = await work(s);
        await s.commit();
        return result;
      } catch (error) {
        await s.rollback().catch(() => undefined);
        throw error;
      } finally {
        await s.close();
      }
    },
    async admin<T extends Row = Row>(sql: string, params: unknown[] = []) {
      return (await runAsOwner(sql, params)) as T[];
    },
    open,
    async openInspector() {
      return openSession(await connect(database));
    },
    async applyMigrations(to: number) {
      await applyUpTo(to);
    },
    async drop() {
      await owner.end().catch(() => undefined);
      const postgres = await connect('postgres');
      try {
        await postgres.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
          [database],
        );
        await postgres.query(`drop database if exists ${database} with (force)`);
      } finally {
        await postgres.end();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Concurrency evidence helpers: real overlap needs both sides observed, so
// every test can show the schedule rather than only its result.
// ---------------------------------------------------------------------------

/** Fails the test if `promise` has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: not settled within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits until the given backend is parked on a lock — the synchronization
 * point of every interleaving here: one transaction holds what the other is
 * waiting for, and this is how the test knows the overlap is real.
 */
export async function waitUntilBlocked(inspector: Session, backendPid: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await inspector.query<{ wait_event_type: string | null; state: string | null }>(
      'select wait_event_type, state from pg_stat_activity where pid = $1',
      [backendPid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return;
    if (Date.now() > deadline) {
      throw new Error(
        `backend ${backendPid} never reached a lock wait within ${timeoutMs}ms ` +
          `(state ${rows[0]?.state ?? 'gone'}, wait ${rows[0]?.wait_event_type ?? 'none'})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What a backend is doing right now — for the schedule each test records. */
export async function backendInfo(inspector: Session, backendPid: number) {
  const rows = await inspector.query<{ state: string | null; wait_event_type: string | null; query: string }>(
    'select state, wait_event_type, left(query, 160) as query from pg_stat_activity where pid = $1',
    [backendPid],
  );
  return rows[0];
}

/** The locks a backend holds right now — evidence of acquisition order. */
export async function locksHeld(inspector: Session, backendPid: number) {
  return inspector.query<{ locktype: string; mode: string; relation: string | null; granted: boolean }>(
    `select l.locktype, l.mode, c.relname as relation, l.granted
       from pg_locks l left join pg_class c on c.oid = l.relation
      where l.pid = $1`,
    [backendPid],
  );
}

/** Cancels a stuck statement, so a failed test never leaves a session parked. */
export async function cancelBackend(inspector: Session, backendPid: number): Promise<void> {
  await inspector.query('select pg_cancel_backend($1)', [backendPid]);
}
