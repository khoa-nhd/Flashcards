/**
 * Fetching a web page for the learner to read: the one place this server
 * reaches out to the internet, built so the address it fetches cannot be
 * turned back at this machine or anything behind it.
 *
 * The guards, in the order they apply:
 *   - only http and https, no credentials in the address, only the ports a
 *     public page is served on;
 *   - every redirect is re-checked from the start — scheme, host, port,
 *     resolved addresses — and only a few hops are followed at all;
 *   - the host is resolved first and every address it yields must be a
 *     public one: loopback, private, link-local (which is where cloud
 *     metadata lives), CGNAT, unique-local and multicast ranges are
 *     refused, and a host that does not resolve is unreachable;
 *   - only text content types are accepted, the body is read under a byte
 *     cap with a deadline, and HTML is stripped to plain text — scripts,
 *     styles and tags are gone before the text exists, so what is stored
 *     has nothing in it to execute and nothing a page could render.
 *
 * What this does NOT do: bypass a login, a paywall or any access control.
 * It sends no cookie and no credential — only a plain GET a stranger's
 * browser could make.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DISCOVERY_LIMITS } from '../shared/discovery.js';

export const WEB_IMPORT_LIMITS = {
  /** Read under this many bytes; a bigger page is refused, not truncated into nonsense. */
  bytes: 1_000_000,
  /** One request's deadline, redirects included. */
  timeoutMs: 5_000,
  redirects: 3,
  /** The ports a plain public page is served on. Anything else is not reached. */
  ports: [80, 443, 8080, 8443],
} as const;

const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'text/xml', 'application/xml']);

export type WebImportFailure =
  | 'invalid_url'
  | 'blocked'
  | 'timeout'
  | 'too_large'
  | 'unsupported_type'
  | 'empty'
  | 'unreachable';

/** A refused fetch, with a message meant for the person who typed the address. */
export class WebImportError extends Error {
  constructor(
    readonly failure: WebImportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WebImportError';
  }
}

export type LookupAddress = Array<{ address: string; family: number }>;

export interface WebImporterOptions {
  /** Injectable so tests never reach the network. */
  fetchText?: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable for the same reason; defaults to the system resolver. */
  lookup?: (hostname: string) => Promise<LookupAddress>;
}

export interface FetchedPage {
  title: string;
  text: string;
  origin: string;
}

export interface WebImporter {
  /** Brings back the page as plain text and a title, or throws a WebImportError. */
  fetch(url: string): Promise<FetchedPage>;
}

/** Is this literal address one the public internet may answer on? Fail closed. */
export function isPublicAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (value.includes(':')) {
    // IPv6 (including the ::ffff:d.d.d.d form some resolvers hand back).
    if (value.startsWith('::ffff:')) return isPublicAddress(value.slice('::ffff:'.length));
    if (value === '::' || value === '::1') return false;
    if (value.startsWith('ff')) return false; // multicast
    if (/^fe[89ab]/.test(value)) return false; // fe80::/10 link-local
    if (/^f[cd]/.test(value)) return false; // fc00::/7 unique local
    if (value.startsWith('64:ff9b')) return false; // NAT64
    if (value.startsWith('2001:db8')) return false; // documentation
    if (value.startsWith('100:')) return false; // discard-only
    // Any other IPv6 we cannot positively place is still only reached after
    // this check passes; unmapped global addresses are public.
    return isIP(value) === 6;
  }
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local — and the cloud metadata endpoints on it
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast and reserved
  return true;
}

function parseAddress(raw: string): URL {
  if (!URL.canParse(raw)) throw new WebImportError('invalid_url', 'That is not a web address this app can open.');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebImportError('invalid_url', 'Only http and https addresses can be opened.');
  }
  if (url.username !== '' || url.password !== '') {
    // Credentials in an address are either an attempt at smuggling access
    // or a mistake; either way this app does not carry them.
    throw new WebImportError('blocked', 'Addresses with a username or password in them are not opened.');
  }
  if (url.port !== '' && !WEB_IMPORT_LIMITS.ports.some((port) => port === Number(url.port))) {
    throw new WebImportError('blocked', `Only the usual web ports (${WEB_IMPORT_LIMITS.ports.join(', ')}) are opened.`);
  }
  if (url.hostname === '') throw new WebImportError('invalid_url', 'That address has no host to fetch from.');
  return url;
}

/** Every address the host stands for must be public — all of them, not one of them. */
async function assertPublicHost(url: URL, lookup: (hostname: string) => Promise<LookupAddress>): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: LookupAddress;
  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await lookup(hostname);
    } catch {
      throw new WebImportError('unreachable', `The address "${hostname}" could not be looked up.`);
    }
  }
  if (addresses.length === 0) {
    throw new WebImportError('unreachable', `The address "${hostname}" could not be looked up.`);
  }
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new WebImportError('blocked', `The address "${hostname}" points at a private or internal network and was not fetched.`);
    }
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML to plain text: the pieces that could carry behaviour go first, then
 * every tag, then entities — what survives is text, in the order it read.
 */
export function htmlToText(html: string): { text: string; title: string | null } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1] === undefined ? null : decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim());
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Paragraph ends become line breaks before the tags themselves vanish.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, title };
}

function mimeOf(response: Response): string | null {
  const raw = response.headers.get('content-type');
  if (raw === null) return null;
  return raw.split(';')[0]?.trim().toLowerCase() ?? null;
}

/** Read a body under the byte cap; past it the page is refused outright. */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > WEB_IMPORT_LIMITS.bytes) {
      await reader.cancel().catch(() => undefined);
      throw new WebImportError('too_large', 'That page is too large to bring in. Try a plain-text copy of the part you want.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

export function createWebImporter(options: WebImporterOptions = {}): WebImporter {
  const fetchText = options.fetchText ?? ((url: string, init: RequestInit) => fetch(url, init));
  const lookup = options.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));

  return {
    async fetch(raw: string): Promise<FetchedPage> {
      let current = raw;
      let response: Response | null = null;
      for (let hop = 0; hop <= WEB_IMPORT_LIMITS.redirects; hop += 1) {
        const url = parseAddress(current);
        // Checked from scratch at every hop: a redirect cannot point the
        // next request somewhere this check would have refused.
        await assertPublicHost(url, lookup);
        try {
          response = await fetchText(url.toString(), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(WEB_IMPORT_LIMITS.timeoutMs),
            headers: {
              accept: 'text/html, text/plain;q=0.9, text/markdown;q=0.8, application/xhtml+xml;q=0.8',
              'user-agent': 'Vocabulary-Flashcards/1.0 (discovery import)',
            },
          });
        } catch (error) {
          if (error instanceof WebImportError) throw error;
          if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new WebImportError('timeout', 'That address did not answer in time.');
          }
          throw new WebImportError('unreachable', 'That address could not be reached.');
        }
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location !== null) {
          if (hop === WEB_IMPORT_LIMITS.redirects) {
            throw new WebImportError('unreachable', 'That address redirected too many times.');
          }
          current = new URL(location, url).toString();
          response = null;
          continue;
        }
        break;
      }
      if (response === null) throw new WebImportError('unreachable', 'That address could not be reached.');
      if (response.status >= 300 && response.status < 400) {
        throw new WebImportError('unreachable', 'That address redirected without saying where.');
      }
      if (!response.ok) {
        throw new WebImportError('unreachable', `The site answered with an error (${response.status}).`);
      }

      const mime = mimeOf(response);
      if (mime !== null && !TEXT_TYPES.has(mime)) {
        throw new WebImportError(
          'unsupported_type',
          `That address is "${mime}", not readable text. Bring in a text page, or paste the text itself.`,
        );
      }

      const bodyText = await readCapped(response);
      const finalUrl = parseAddress(current);
      if (mime === null || mime === 'text/plain' || mime === 'text/markdown') {
        const text = bodyText.trim();
        if (text.length === 0) throw new WebImportError('empty', 'There was no text at that address.');
        if (text.length > DISCOVERY_LIMITS.content) {
          throw new WebImportError('too_large', 'That text is longer than one reading. Import the part you want.');
        }
        return { title: finalUrl.hostname, text, origin: finalUrl.toString() };
      }
      const { text, title } = htmlToText(bodyText);
      if (text.length === 0) throw new WebImportError('empty', 'That page had no readable text on it.');
      if (text.length > DISCOVERY_LIMITS.content) {
        throw new WebImportError('too_large', 'That page holds more text than one reading. Import the part you want.');
      }
      return { title: title !== null && title !== '' ? title : finalUrl.hostname, text, origin: finalUrl.toString() };
    },
  };
}
