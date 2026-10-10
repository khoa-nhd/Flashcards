import { describe, expect, it, vi } from 'vitest';
import { bearerToken } from '../../server/accounts.js';
import { isPrivilegedSupabaseKey, loadConfig } from '../../server/env.js';
import { accountFromClaims, createSupabaseAccounts } from '../../server/supabase/supabase-accounts.js';
import { DatabaseError, toDatabaseError, type VocabularyDatabase } from '../../server/supabase/supabase-database.js';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { TEST_FIELDS } from '../helpers/notion-fixtures.js';

const USER = '0b0e7c6a-5a4e-4c1f-9d2b-3f1e2d4c5b6a';

describe('bearerToken', () => {
  it('extracts a JWT-shaped token and nothing else', () => {
    expect(bearerToken('Bearer aaa.bbb.ccc')).toBe('aaa.bbb.ccc');
    expect(bearerToken('bearer   aaa.bbb.ccc  ')).toBe('aaa.bbb.ccc');
    for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Bearer abc', 'Bearer a.b', 'Basic aaa.bbb.ccc', 'aaa.bbb.ccc', 'Bearer a.b.c extra']) {
      expect(bearerToken(header)).toBeNull();
    }
    expect(bearerToken(`Bearer ${'a'.repeat(9000)}.b.c`)).toBeNull();
  });
});

describe('accountFromClaims', () => {
  it('accepts a signed-in user', () => {
    expect(accountFromClaims({ sub: USER.toUpperCase(), role: 'authenticated', email: 'me@example.com' })).toEqual({
      id: USER,
      email: 'me@example.com',
    });
    expect(accountFromClaims({ sub: USER, role: 'authenticated' })).toEqual({ id: USER, email: null });
  });

  it.each([
    ['the public key itself', { role: 'anon' }],
    ['a privileged key', { role: 'service_role', sub: USER }],
    ['a token with no subject', { role: 'authenticated' }],
    ['a subject that is not a user id', { role: 'authenticated', sub: 'admin' }],
    ['a token with no role', { sub: USER }],
  ])('refuses %s', (_name, claims) => {
    expect(accountFromClaims(claims)).toBeNull();
  });
});

describe('isPrivilegedSupabaseKey', () => {
  const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

  it('tells public keys from secret ones', () => {
    expect(isPrivilegedSupabaseKey('sb_publishable_abc123')).toBe(false);
    expect(isPrivilegedSupabaseKey(jwt({ role: 'anon', iss: 'supabase' }))).toBe(false);
    expect(isPrivilegedSupabaseKey('sb_secret_abc123')).toBe(true);
    expect(isPrivilegedSupabaseKey(jwt({ role: 'service_role', iss: 'supabase' }))).toBe(true);
    expect(isPrivilegedSupabaseKey('not.a-jwt.atall')).toBe(false);
  });
});

describe('Supabase configuration', () => {
  const env = { DATA_MODE: 'supabase', SUPABASE_URL: 'https://project.supabase.co/', SUPABASE_ANON_KEY: 'sb_publishable_abc' };

  it('needs only the address and the public key', () => {
    const config = loadConfig(env);
    expect(config).toMatchObject({
      mode: 'supabase',
      supabase: { url: 'https://project.supabase.co', publicKey: 'sb_publishable_abc' },
      notion: null,
      timeZone: null,
      writesRequested: true,
      issues: [],
    });
  });

  it('accepts the key under its newer name', () => {
    const config = loadConfig({ DATA_MODE: 'supabase', SUPABASE_URL: env.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_new' });
    expect(config.supabase?.publicKey).toBe('sb_publishable_new');
  });

  it('is only ever selected explicitly', () => {
    const { DATA_MODE: _mode, ...withoutMode } = env;
    void _mode;
    expect(loadConfig(withoutMode).mode).toBe('mock');
    expect(loadConfig({ ...withoutMode, NODE_ENV: 'production' }).mode).toBe('notion');
  });

  it('names what is missing', () => {
    expect(loadConfig({ DATA_MODE: 'supabase' }).issues).toEqual([
      expect.stringContaining('SUPABASE_URL'),
      expect.stringContaining('SUPABASE_ANON_KEY'),
    ]);
    expect(loadConfig({ ...env, SUPABASE_URL: 'http://project.supabase.co' }).issues).toEqual([expect.stringContaining('https://')]);
    expect(loadConfig({ ...env, SUPABASE_URL: 'http://localhost:54321' }).issues).toEqual([]);
  });

  it('lets saving be frozen on purpose, and only on purpose', () => {
    expect(loadConfig({ ...env, REVIEW_WRITES_ENABLED: 'false' }).writesRequested).toBe(false);
    expect(loadConfig({ ...env, REVIEW_WRITES_ENABLED: 'true' }).writesRequested).toBe(true);
    expect(loadConfig({ ...env, REVIEW_WRITES_ENABLED: '' }).writesRequested).toBe(true);
  });

  it('ignores Notion settings entirely', () => {
    const config = loadConfig({ ...env, NOTION_API_KEY: 'secret_test_value', NOTION_DATABASE_ID: '11111111111141118111111111111111' });
    expect(config).toMatchObject({ mode: 'supabase', notion: null, issues: [] });
  });
});

describe('toDatabaseError', () => {
  it.each([
    [{ code: 'PGRST301' }, undefined, 'unauthorized'],
    [{}, 401, 'unauthorized'],
    [{ code: '42P01' }, 404, 'schema_missing'],
    [{ code: 'PGRST202' }, 404, 'schema_missing'],
    [{ code: '42501' }, 403, 'forbidden'],
    [{ code: '23514' }, 400, 'invalid'],
    [{ code: '22P02' }, 400, 'invalid'],
    [{ code: '57014' }, 500, 'unavailable'],
    [{}, undefined, 'unavailable'],
  ] as const)('maps %o (HTTP %s) to %s', (error, status, failure) => {
    expect(toDatabaseError(error, status).failure).toBe(failure);
  });

  it('never carries the database’s own message, which can quote stored values', () => {
    const error = toDatabaseError({ code: '23505', message: 'Key (word)=(a private word) already exists.' }, 409);
    expect(error.message).not.toContain('private word');
    expect(error.code).toBe('23505');
  });
});

/** A database that only knows a time zone, and records who opened it. */
function zoneDatabase(stored: string | null) {
  const state = { zone: stored };
  const database = {
    getTimeZone: vi.fn(async () => state.zone),
    ensureTimeZone: vi.fn(async (zone: string) => (state.zone ??= zone)),
    saveTimeZone: vi.fn(async (zone: string) => (state.zone = zone)),
  } as unknown as VocabularyDatabase;
  return { database, state };
}

function gateway(stored: string | null, defaultTimeZone: string | null = null) {
  const { database, state } = zoneDatabase(stored);
  const connect = vi.fn(() => database);
  const accounts = createSupabaseAccounts({
    url: 'https://project.supabase.co',
    publicKey: 'sb_publishable_abc',
    rules: sampleRules,
    cardFields: TEST_FIELDS,
    defaults: { mastery: 1, reviewDate: 'empty' },
    defaultTimeZone,
    writesRequested: true,
    verifier: { verify: async (token) => (token === 'good.token.x' ? { id: USER, email: 'me@example.com' } : null) },
    connect,
  });
  return { accounts, connect, database, state };
}

describe('opening a session', () => {
  it('refuses a token that does not verify, without touching the database', async () => {
    const { accounts, connect } = gateway('UTC');
    expect(await accounts.open('bad.token.x', { timeZone: null })).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('connects to the database with the caller’s own token', async () => {
    const { accounts, connect } = gateway('Asia/Ho_Chi_Minh');
    const session = await accounts.open('good.token.x', { timeZone: 'UTC' });
    expect(connect).toHaveBeenCalledWith('good.token.x');
    expect(session).toMatchObject({ account: { id: USER, email: 'me@example.com' }, timeZone: 'Asia/Ho_Chi_Minh' });
  });

  it('gives a new account the device’s zone, then the server default, then UTC', async () => {
    const hinted = gateway(null, 'Asia/Tokyo');
    expect((await hinted.accounts.open('good.token.x', { timeZone: 'Europe/Paris' }))?.timeZone).toBe('Europe/Paris');
    expect(hinted.state.zone).toBe('Europe/Paris');

    const configured = gateway(null, 'Asia/Tokyo');
    expect((await configured.accounts.open('good.token.x', { timeZone: 'Not/AZone' }))?.timeZone).toBe('Asia/Tokyo');

    const bare = gateway(null);
    expect((await bare.accounts.open('good.token.x', { timeZone: null }))?.timeZone).toBe('UTC');
  });

  it('builds separate services for every request', async () => {
    const { accounts } = gateway('UTC');
    const first = await accounts.open('good.token.x', { timeZone: null });
    const second = await accounts.open('good.token.x', { timeZone: null });
    expect(first?.review).not.toBe(second?.review);
    expect(first?.vocabulary).not.toBe(second?.vocabulary);
  });

  it('only saves a time zone that exists', async () => {
    const { accounts, database } = gateway('UTC');
    const session = await accounts.open('good.token.x', { timeZone: null });
    await expect(session?.saveTimeZone('Hanoi')).rejects.toBeInstanceOf(DatabaseError);
    expect(database.saveTimeZone).not.toHaveBeenCalled();
    await expect(session?.saveTimeZone('Asia/Ho_Chi_Minh')).resolves.toBe('Asia/Ho_Chi_Minh');
  });
});
