import { isValidTimeZone } from '../shared/dates.js';
import type { DataMode } from './vocabulary-repository.js';

export type { DataMode };

export interface AppConfig {
  mode: DataMode;
  isProduction: boolean;
  notion: { apiKey: string; databaseId: string | null; dataSourceId: string | null } | null;
  /**
   * Where the Supabase project is, and the key browsers are meant to hold.
   * Both are public by design. No privileged key is ever read by this app.
   */
  supabase: { url: string; publicKey: string } | null;
  /**
   * IANA zone that defines "today" for due-date comparisons. With Supabase
   * every account stores its own; this is then only the zone a new account
   * starts with, and may be `null`.
   */
  timeZone: string | null;
  /** The owner asked for writes; they still require confirmed rules and a writable schema. */
  writesRequested: boolean;
  accessPassword: string | null;
  allowUnauthenticated: boolean;
  port: number;
  host: string;
  /** Problems that stop the app from serving reviews. Never contains secret values. */
  issues: string[];
}

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function readFlag(env: Env, key: string): boolean {
  return read(env, key)?.toLowerCase() === 'true';
}

/**
 * True for a key that bypasses Row Level Security. Such a key must never be
 * configured here: this server hands its key to the browser.
 */
export function isPrivilegedSupabaseKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const payload = key.split('.')[1];
  if (payload === undefined) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && (claims as { role?: unknown }).role !== 'anon';
  } catch {
    return false;
  }
}

function isUsableSupabaseUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.protocol === 'https:' || (url.protocol === 'http:' && local);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const issues: string[] = [];
  const isProduction = read(env, 'NODE_ENV') === 'production';

  const apiKey = read(env, 'NOTION_API_KEY');
  const databaseId = read(env, 'NOTION_DATABASE_ID');
  const dataSourceId = read(env, 'NOTION_DATA_SOURCE_ID');

  const requestedMode = read(env, 'DATA_MODE');
  let mode: DataMode;
  if (requestedMode === 'mock' || requestedMode === 'notion' || requestedMode === 'supabase') {
    mode = requestedMode;
  } else {
    if (requestedMode !== null) issues.push('DATA_MODE must be "mock", "notion" or "supabase".');
    // Sample data is a development convenience; a deployment must opt into it.
    // Supabase is never chosen implicitly, and never abandoned implicitly either.
    mode = apiKey !== null || isProduction ? 'notion' : 'mock';
  }

  let timeZone = read(env, 'REVIEW_TIMEZONE');
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    issues.push('REVIEW_TIMEZONE is not a valid IANA time zone (for example "Asia/Ho_Chi_Minh").');
    timeZone = null;
  }

  let notion: AppConfig['notion'] = null;
  let supabase: AppConfig['supabase'] = null;
  if (mode === 'notion') {
    if (apiKey === null) issues.push('NOTION_API_KEY is not set.');
    if (databaseId === null && dataSourceId === null) {
      issues.push('Set NOTION_DATABASE_ID (or NOTION_DATA_SOURCE_ID).');
    }
    // "Due today" depends on the calendar in use, so it is never assumed.
    if (timeZone === null && !issues.some((issue) => issue.startsWith('REVIEW_TIMEZONE'))) {
      issues.push('REVIEW_TIMEZONE is not set. It decides which calendar day counts as "today".');
    }
    if (apiKey !== null) notion = { apiKey, databaseId, dataSourceId };
  } else if (mode === 'supabase') {
    const url = read(env, 'SUPABASE_URL');
    const publicKey = read(env, 'SUPABASE_ANON_KEY') ?? read(env, 'SUPABASE_PUBLISHABLE_KEY');
    if (url === null) issues.push('SUPABASE_URL is not set.');
    else if (!isUsableSupabaseUrl(url)) issues.push('SUPABASE_URL must be an https:// address.');
    if (publicKey === null) {
      issues.push('SUPABASE_ANON_KEY is not set. Use the public (anon / publishable) key.');
    } else if (isPrivilegedSupabaseKey(publicKey)) {
      issues.push(
        'SUPABASE_ANON_KEY holds a privileged key. Replace it with the public (anon / publishable) key; this app never needs a secret one.',
      );
    }
    if (url !== null && publicKey !== null && issues.length === 0) {
      supabase = { url: url.replace(/\/+$/, ''), publicKey };
    }
  } else if (timeZone === null) {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  const port = Number(read(env, 'PORT') ?? '8787');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) issues.push('PORT is not a valid port.');

  // With Notion, saving is opt-in. With Supabase it is what the app is for,
  // and the switch remains only as a way to freeze changes on purpose.
  const writesRequested =
    mode === 'mock'
      ? true
      : mode === 'supabase'
        ? read(env, 'REVIEW_WRITES_ENABLED')?.toLowerCase() !== 'false'
        : readFlag(env, 'REVIEW_WRITES_ENABLED');

  return {
    mode,
    isProduction,
    notion,
    supabase,
    timeZone,
    writesRequested,
    accessPassword: read(env, 'APP_ACCESS_PASSWORD'),
    allowUnauthenticated: readFlag(env, 'ALLOW_UNAUTHENTICATED_ACCESS'),
    port: Number.isInteger(port) ? port : 8787,
    host: read(env, 'HOST') ?? (isProduction ? '0.0.0.0' : '127.0.0.1'),
    issues,
  };
}
