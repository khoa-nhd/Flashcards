/**
 * The real token verification, as it runs in production, with the Auth server
 * replaced by a local stand-in. Tokens here are signed with keys generated in
 * the test, so signature checking is exercised for real.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSupabaseVerifier } from '../../server/supabase/supabase-accounts.js';
import { DatabaseError } from '../../server/supabase/supabase-database.js';

const URL_BASE = 'https://project-ref.supabase.co';
const USER = '0b0e7c6a-5a4e-4c1f-9d2b-3f1e2d4c5b6a';

const encode = (value: object | Uint8Array) =>
  Buffer.from(value instanceof Uint8Array ? value : JSON.stringify(value)).toString('base64url');

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

async function newSigningKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] } };
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

async function sign(key: SigningKey, claims: Record<string, unknown>): Promise<string> {
  const body = `${encode({ alg: 'ES256', typ: 'JWT', kid: key.kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(body));
  return `${body}.${encode(new Uint8Array(signature))}`;
}

/** A token signed with a shared secret, which only the Auth server can check. */
const legacyToken = (claims: Record<string, unknown>) =>
  `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.${encode(new Uint8Array(32))}`;

const userClaims = (overrides: Record<string, unknown> = {}) => ({
  sub: USER,
  role: 'authenticated',
  email: 'me@example.com',
  aud: 'authenticated',
  iss: `${URL_BASE}/auth/v1`,
  iat: Math.floor(Date.now() / 1000),
  exp: inAnHour(),
  ...overrides,
});

let projectKey: SigningKey;
let strangerKey: SigningKey;

beforeAll(async () => {
  projectKey = await newSigningKey('project-key-1');
  strangerKey = await newSigningKey('project-key-1');
});

/**
 * An Auth server that publishes the project's signing keys and answers
 * `/user` the way the real one does: only for a token it issued itself.
 */
function authServer(options: { issued?: string[]; down?: boolean; base?: string } = {}) {
  const base = options.base ?? URL_BASE;
  const requests: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url.replace(base, ''));
    if (options.down) throw new TypeError('fetch failed');
    if (url.endsWith('/auth/v1/.well-known/jwks.json')) {
      return Response.json({ keys: [projectKey.jwk] });
    }
    if (url.endsWith('/auth/v1/user')) {
      const presented = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      return (options.issued ?? []).includes(presented)
        ? Response.json({ id: USER, email: 'me@example.com', aud: 'authenticated', role: 'authenticated' })
        : Response.json({ code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }, { status: 403 });
    }
    return Response.json({ msg: 'not found' }, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, base };
}

const verifierFor = (server: ReturnType<typeof authServer>) =>
  createSupabaseVerifier(server.base, 'sb_publishable_test_key', server.fetchImpl);

describe('a token signed with the project’s key', () => {
  it('is accepted, and says who the user is', async () => {
    const server = authServer();
    const account = await verifierFor(server).verify(await sign(projectKey, userClaims()));
    expect(account).toEqual({ id: USER, email: 'me@example.com' });
    // Checked against the published keys; the user's token is not sent anywhere else.
    expect(server.requests).toEqual(['/auth/v1/.well-known/jwks.json']);
  });

  it('is refused once it has expired', async () => {
    const expired = await sign(projectKey, userClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));
    expect(await verifierFor(authServer()).verify(expired)).toBeNull();
  });

  it('is refused when it is not a signed-in user’s', async () => {
    const verifier = verifierFor(authServer());
    expect(await verifier.verify(await sign(projectKey, userClaims({ role: 'anon', sub: undefined })))).toBeNull();
    expect(await verifier.verify(await sign(projectKey, userClaims({ role: 'service_role' })))).toBeNull();
  });
});

describe('a forged or damaged token', () => {
  it('is refused when signed with somebody else’s key', async () => {
    const forged = await sign(strangerKey, userClaims());
    expect(await verifierFor(authServer()).verify(forged)).toBeNull();
  });

  it('is refused when its contents were changed after signing', async () => {
    const [header, , signature] = (await sign(projectKey, userClaims())).split('.');
    const tampered = `${header}.${encode(userClaims({ sub: '11111111-1111-4111-8111-111111111111' }))}.${signature}`;
    expect(await verifierFor(authServer()).verify(tampered)).toBeNull();
  });

  it('is refused when it names a key the project does not have', async () => {
    // With no key to check against, the Auth server is asked, and it did not issue this.
    const server = authServer();
    const unknown = await sign({ ...projectKey, kid: 'some-other-key' }, userClaims());
    expect(await verifierFor(server).verify(unknown)).toBeNull();
    expect(server.requests).toContain('/auth/v1/user');
  });

  it('is refused when it claims to need no signature', async () => {
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(userClaims())}.`;
    expect(await verifierFor(authServer()).verify(unsigned)).toBeNull();
  });

  it.each([['aaa.bbb.ccc'], ['a.b.c'], ['....'], ['%%%.%%%.%%%'], ['']])(
    'is refused, not crashed on, when it is not a token at all: "%s"',
    async (token) => {
      await expect(verifierFor(authServer()).verify(token)).resolves.toBeNull();
    },
  );
});

describe('a project that still signs with a shared secret', () => {
  it('asks the Auth server, and accepts a token it issued', async () => {
    const token = legacyToken(userClaims());
    const server = authServer({ issued: [token] });
    expect(await verifierFor(server).verify(token)).toEqual({ id: USER, email: 'me@example.com' });
    expect(server.requests).toEqual(['/auth/v1/user']);
  });

  it('refuses a token the Auth server did not issue, whatever it claims', async () => {
    const server = authServer({ issued: [legacyToken(userClaims())] });
    const forged = legacyToken(userClaims({ sub: '11111111-1111-4111-8111-111111111111' }));
    expect(await verifierFor(server).verify(forged)).toBeNull();
  });
});

describe('when the sign-in service cannot be reached', () => {
  it('reports that, instead of treating a good session as a bad one', async () => {
    // A project whose keys have never been fetched, so there is nothing to check a signature against.
    const cold = authServer({ down: true, base: 'https://never-seen-before.supabase.co' });
    await expect(verifierFor(cold).verify(await sign(projectKey, userClaims()))).rejects.toBeInstanceOf(DatabaseError);

    const token = legacyToken(userClaims());
    await expect(verifierFor(authServer({ down: true, issued: [token] })).verify(token)).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });

  it('keeps accepting good tokens with the keys it already has', async () => {
    const token = await sign(projectKey, userClaims());
    await verifierFor(authServer()).verify(token);
    const down = authServer({ down: true });
    await expect(verifierFor(down).verify(token)).resolves.toEqual({ id: USER, email: 'me@example.com' });
    // And still refuses a forged one, without needing the network to do so.
    await expect(verifierFor(down).verify(await sign(strangerKey, userClaims()))).resolves.toBeNull();
  });

  it('still refuses a token that is plainly not one', async () => {
    await expect(verifierFor(authServer({ down: true })).verify('aaa.bbb.ccc')).resolves.toBeNull();
  });
});
