/**
 * Bringing in a page by address, held against the two promises that make it
 * safe to offer at all:
 *
 *   the server's one outbound fetch cannot be aimed back at this machine or
 *   anything behind it — no scheme trick, no credentials, no odd port, no
 *   private or loopback address, no cloud metadata endpoint, no redirect or
 *   DNS answer that lands somewhere the first check would have refused, and
 *   nothing of the account travels with the request;
 *   fetching only previews: the page comes back as plain text and is stored
 *   nowhere until the learner presses a separate save, and a refused address
 *   arrives as one clear message rather than a stack trace.
 *
 * Every network edge is injected — no test here touches a real socket.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fetchUrlResponseSchema } from '../../shared/discovery.js';
import { createWebImporter, htmlToText, WebImportError, type FetchedPage } from '../../server/web-importer.js';
import { call, createSupabaseTestApp, createTestUser, newId, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  alice = await createTestUser(db, 'alice');
  bob = await createTestUser(db, 'bob');
});

const TODAY = '2026-10-09';
const on = (webImporter?: { fetch: (url: string) => Promise<FetchedPage> }) =>
  createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${TODAY}T05:00:00Z`), webImporter });

const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];

/** A page answering `text/html` by default; a chain of replies for redirects. */
function pageReply(body: string, type = 'text/html; charset=utf-8', status = 200) {
  return new Response(body, { status, headers: { 'content-type': type } });
}

const failureOf = async (promise: Promise<unknown>): Promise<WebImportError> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WebImportError);
  return error as WebImportError;
};

// ---------------------------------------------------------------------------
// The guards themselves
// ---------------------------------------------------------------------------

describe('the address itself', () => {
  it('brings back a page as plain text, with nothing left of the page but words', async () => {
    const importer = createWebImporter({
      lookup: async () => PUBLIC_IP,
      fetchText: async () =>
        pageReply(
          '<html><head><title> Notes &amp; Words </title><style>body{color:red}</style></head>' +
            '<body><p onclick="steal()">A candid answer.</p><script>window.steal = 1;</script>' +
            '<h1>The heading</h1></body></html>',
        ),
    });
    const page = await importer.fetch('https://example.test/notes');
    expect(page.title).toBe('Notes & Words');
    expect(page.text).toContain('A candid answer.');
    expect(page.text).toContain('The heading');
    // Scripts, handlers and styles are gone before the text exists.
    expect(page.text).not.toContain('steal');
    expect(page.text).not.toContain('window');
    expect(page.text).not.toContain('color');
    expect(page.origin).toBe('https://example.test/notes');
  });

  it('refuses anything that is not a plain http(s) address, or one carrying credentials or a strange port', async () => {
    const importer = createWebImporter({ lookup: async () => PUBLIC_IP, fetchText: async () => pageReply('never') });
    expect((await failureOf(importer.fetch('not a url at all'))).failure).toBe('invalid_url');
    expect((await failureOf(importer.fetch('file:///etc/passwd'))).failure).toBe('invalid_url');
    expect((await failureOf(importer.fetch('javascript:alert(1)'))).failure).toBe('invalid_url');
    expect((await failureOf(importer.fetch('https://user:secret@example.test/'))).failure).toBe('blocked');
    expect((await failureOf(importer.fetch('https://example.test:22/'))).failure).toBe('blocked');
  });

  it('refuses a host that resolves to a private, loopback, metadata or mixed answer', async () => {
    const cases: Array<[string, Array<{ address: string; family: number }>]> = [
      ['https://intranet.test/', [{ address: '10.0.0.5', family: 4 }]],
      ['https://loopback.test/', [{ address: '127.0.0.1', family: 4 }]],
      ['https://metadata.test/', [{ address: '169.254.169.254', family: 4 }]],
      ['https://corp.test/', [{ address: '192.168.1.1', family: 4 }]],
      ['https://cgnat.test/', [{ address: '100.64.0.7', family: 4 }]],
      ['https://local6.test/', [{ address: 'fd00::1', family: 6 }]],
      ['https://v4mapped.test/', [{ address: '::ffff:192.168.0.1', family: 6 }]],
      // One public answer does not launder a private one hiding beside it.
      ['https://mixed.test/', [{ address: '93.184.216.34', family: 4 }, { address: '172.16.0.9', family: 4 }]],
    ];
    for (const [url, answers] of cases) {
      const importer = createWebImporter({ lookup: async () => answers, fetchText: async () => pageReply('never') });
      expect((await failureOf(importer.fetch(url))).failure, url).toBe('blocked');
    }
    // And a literal private address never reaches the resolver at all.
    const literal = createWebImporter({
      lookup: async () => {
        throw new Error('the resolver must not be consulted for a literal address');
      },
      fetchText: async () => pageReply('never'),
    });
    expect((await failureOf(literal.fetch('http://192.168.13.37/'))).failure).toBe('blocked');
    expect((await failureOf(literal.fetch('http://[::1]/'))).failure).toBe('blocked');
  });

  it('calls an address that cannot be looked up unreachable, not open', async () => {
    const importer = createWebImporter({
      lookup: async () => {
        throw new Error('NXDOMAIN');
      },
      fetchText: async () => pageReply('never'),
    });
    expect((await failureOf(importer.fetch('https://nowhere.test/'))).failure).toBe('unreachable');
    const empty = createWebImporter({ lookup: async () => [], fetchText: async () => pageReply('never') });
    expect((await failureOf(empty.fetch('https://nowhere.test/'))).failure).toBe('unreachable');
  });

  it('re-checks every redirect — a hop to the inside of the machine is refused there', async () => {
    const reached: string[] = [];
    const importer = createWebImporter({
      lookup: async (hostname) =>
        hostname === 'internal.test' ? [{ address: '10.1.2.3', family: 4 }] : PUBLIC_IP,
      fetchText: async (url) => {
        reached.push(url);
        if (url === 'https://example.test/bounce') {
          return new Response(null, { status: 302, headers: { location: 'http://internal.test/secrets' } });
        }
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      },
    });
    expect((await failureOf(importer.fetch('https://example.test/bounce'))).failure).toBe('blocked');
    // The private host was refused on the way out — only the public hop ran.
    expect(reached).toEqual(['https://example.test/bounce']);
  });

  it('follows only a few redirects before giving up', async () => {
    let hops = 0;
    const importer = createWebImporter({
      lookup: async () => PUBLIC_IP,
      fetchText: async () => {
        hops += 1;
        return new Response(null, { status: 302, headers: { location: `https://example.test/hop${hops}` } });
      },
    });
    expect((await failureOf(importer.fetch('https://example.test/start'))).failure).toBe('unreachable');
    expect(hops).toBeLessThanOrEqual(4);
  });

  it('refuses a page that is not readable text, one too large, one that is empty, and one that times out', async () => {
    const pdf = createWebImporter({ lookup: async () => PUBLIC_IP, fetchText: async () => pageReply('%PDF-1.4', 'application/pdf') });
    expect((await failureOf(pdf.fetch('https://example.test/paper'))).failure).toBe('unsupported_type');

    const big = createWebImporter({
      lookup: async () => PUBLIC_IP,
      fetchText: async () =>
        new Response(new Uint8Array(1_200_000).fill(65), { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    expect((await failureOf(big.fetch('https://example.test/book'))).failure).toBe('too_large');

    const blank = createWebImporter({ lookup: async () => PUBLIC_IP, fetchText: async () => pageReply('   ', 'text/plain') });
    expect((await failureOf(blank.fetch('https://example.test/nothing'))).failure).toBe('empty');

    const slow = createWebImporter({
      lookup: async () => PUBLIC_IP,
      fetchText: async () => {
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        throw timeout;
      },
    });
    expect((await failureOf(slow.fetch('https://example.test/slow'))).failure).toBe('timeout');

    const broken = createWebImporter({ lookup: async () => PUBLIC_IP, fetchText: async () => pageReply('gone', 'text/html', 500) });
    expect((await failureOf(broken.fetch('https://example.test/broken'))).failure).toBe('unreachable');
  });

  it('sends a stranger’s plain GET — no cookie, no credential, no authorization', async () => {
    const seen: RequestInit[] = [];
    const importer = createWebImporter({
      lookup: async () => PUBLIC_IP,
      fetchText: async (_url, init) => {
        seen.push(init);
        return pageReply('<title>Plain</title><p>Plain reading.</p>');
      },
    });
    await importer.fetch('https://example.test/plain');
    expect(seen).toHaveLength(1);
    const headers = new Headers(seen[0]!.headers);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.redirect).toBe('manual');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect([...headers.keys()].every((key) => ['accept', 'user-agent'].includes(key))).toBe(true);
  });
});

describe('what htmlToText leaves behind', () => {
  it('keeps the words in order and drops everything that could act', () => {
    const { text, title } = htmlToText(
      '<title>Safe &amp; sound</title>' +
        '<nav><a href="https://evil.test">Menu</a></nav>' +
        '<article><p>First&nbsp;line.</p><p onclick="x()">Second &lt;line&gt;.</p></article>' +
        '<iframe src="https://evil.test/frame"></iframe><script>document.write("nope")</script>',
    );
    expect(title).toBe('Safe & sound');
    expect(text).toContain('First line.');
    expect(text).toContain('Second <line>.');
    expect(text).not.toContain('onclick');
    expect(text).not.toContain('document.write');
    expect(text).not.toContain('iframe');
    expect(text).not.toContain('href');
  });
});

// ---------------------------------------------------------------------------
// Through the API: preview only, and the errors a person can act on
// ---------------------------------------------------------------------------

describe('fetching a page through the API', () => {
  it('previews the page and stores nothing — the save is a separate press', async () => {
    const app = on({
      async fetch() {
        return { title: 'An article', text: 'A candid answer changed the plan.', origin: 'https://example.test/article' };
      },
    });
    const response = await call(app, alice, '/api/discovery/fetch-url', {
      method: 'POST',
      body: { url: 'https://example.test/article' },
    });
    const preview = fetchUrlResponseSchema.parse(await response.json());
    expect(preview.title).toBe('An article');
    expect(preview.origin).toBe('https://example.test/article');

    // Nothing was written: no source exists yet.
    const sources = (await call(app, alice, '/api/discovery')).json() as Promise<{ sources: unknown[] }>;
    expect((await sources).sources).toEqual([]);
  });

  it('carries a refused fetch out as the one message the learner can act on', async () => {
    const app = on({
      async fetch() {
        throw new WebImportError('blocked', 'That address points at a private network and was not fetched.');
      },
    });
    const response = await call(app, alice, '/api/discovery/fetch-url', {
      method: 'POST',
      body: { url: 'https://intranet.test/' },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('url_blocked');
    expect(body.error.message).toContain('private network');
  });

  it('answers a too-large or unreachable address with its own status, not a 500', async () => {
    for (const [failure, status, code] of [
      ['too_large', 413, 'content_too_large'],
      ['unreachable', 502, 'upstream_unreachable'],
      ['timeout', 504, 'upstream_timeout'],
      ['unsupported_type', 415, 'unsupported_media_type'],
      ['empty', 400, 'invalid_request'],
      ['invalid_url', 400, 'invalid_request'],
    ] as const) {
      const app = on({
        async fetch() {
          throw new WebImportError(failure, `Refused: ${failure}`);
        },
      });
      const response = await call(app, alice, '/api/discovery/fetch-url', { method: 'POST', body: { url: 'https://example.test/x' } });
      expect(response.status, failure).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code, failure).toBe(code);
    }
  });

  it('previews even with saving switched off — opening a page is reading; storing it is what saving means', async () => {
    const app = on({
      async fetch() {
        return { title: 'Readable', text: 'A page worth reading.', origin: 'https://example.test/readable' };
      },
    });
    // A second app over the same database with writes frozen.
    const frozen = createSupabaseTestApp(db, [alice, bob], {
      now: () => new Date(`${TODAY}T05:00:00Z`),
      env: { REVIEW_WRITES_ENABLED: 'false' },
      webImporter: {
        async fetch() {
          return { title: 'Readable', text: 'A page worth reading.', origin: 'https://example.test/readable' };
        },
      },
    });
    const preview = await call(frozen, alice, '/api/discovery/fetch-url', {
      method: 'POST',
      body: { url: 'https://example.test/readable' },
    });
    expect(preview.status).toBe(200);
    // …and storing it under a frozen account is refused, as any write is.
    const refused = await call(frozen, alice, '/api/discovery', {
      method: 'POST',
      body: { kind: 'web', title: 'Readable', content: 'A page worth reading.', requestId: newId() },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('read_only');
    // The writing app still previewed too — the fetch is not what was gated.
    expect((await call(app, alice, '/api/discovery')).status).toBe(200);
  });

  it('previews only for the account that asked — the fetch is not a door into anyone’s sources', async () => {
    const app = on({
      async fetch() {
        return { title: 'Shared page', text: 'Same page for whoever asks.', origin: 'https://example.test/shared' };
      },
    });
    const forAlice = await call(app, alice, '/api/discovery/fetch-url', { method: 'POST', body: { url: 'https://example.test/shared' } });
    const forBob = await call(app, bob, '/api/discovery/fetch-url', { method: 'POST', body: { url: 'https://example.test/shared' } });
    expect(forAlice.status).toBe(200);
    expect(forBob.status).toBe(200);
    // Both previews exist, yet neither account has any source yet — preview
    // is stateless for everyone.
    for (const user of [alice, bob]) {
      const sources = (await call(app, user, '/api/discovery')).json() as Promise<{ sources: unknown[] }>;
      expect((await sources).sources).toEqual([]);
    }
  });
});

describe('the preview response is exactly the schema the client expects', () => {
  it('carries title, text and origin and nothing else', async () => {
    const app = on({
      async fetch() {
        return { title: 'T', text: 'The words.', origin: 'https://example.test/t' };
      },
    });
    const response = await call(app, alice, '/api/discovery/fetch-url', { method: 'POST', body: { url: 'https://example.test/t' } });
    const raw = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['origin', 'text', 'title']);
    expect(fetchUrlResponseSchema.safeParse(raw).success).toBe(true);
  });
});
