import { isValidTimeZone } from '../shared/dates.js';
import type { DataMode } from './vocabulary-repository.js';

export type { DataMode };

export interface AppConfig {
  mode: DataMode;
  isProduction: boolean;
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
  /** False only when saving has been frozen on purpose. */
  writesRequested: boolean;
  /**
   * Signs the game's changes, so only this server can write XP (schema
   * version 17). The database holds the same value. `null` leaves the game off.
   */
  gameSigningKey: string | null;
  /**
   * Accounts that may open the moderation page (ADMIN_EMAILS, comma separated,
   * lower case). The database's own list of admins must name them too.
   */
  adminEmails: string[];
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

  const url = read(env, 'SUPABASE_URL');
  const publicKey = read(env, 'SUPABASE_ANON_KEY') ?? read(env, 'SUPABASE_PUBLISHABLE_KEY');

  const requestedMode = read(env, 'DATA_MODE');
  let mode: DataMode;
  if (requestedMode === 'mock' || requestedMode === 'supabase') {
    mode = requestedMode;
  } else {
    if (requestedMode !== null) issues.push('DATA_MODE must be "supabase" or "mock".');
    // Sample data is a development convenience only: a deployment, or anything
    // that names a Supabase project, uses Supabase and says so if it cannot.
    mode = isProduction || url !== null || requestedMode !== null ? 'supabase' : 'mock';
  }

  let timeZone = read(env, 'REVIEW_TIMEZONE');
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    issues.push('REVIEW_TIMEZONE is not a valid IANA time zone (for example "Asia/Ho_Chi_Minh").');
    timeZone = null;
  }

  let supabase: AppConfig['supabase'] = null;
  if (mode === 'supabase') {
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

  // Too short a key is as good as none: the game stays off rather than signing with it.
  const gameKey = read(env, 'GAME_SIGNING_KEY');
  const gameSigningKey = gameKey !== null && gameKey.length >= 32 ? gameKey : null;

  const adminEmails = (read(env, 'ADMIN_EMAILS') ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes('@'));

  const port = Number(read(env, 'PORT') ?? '8787');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) issues.push('PORT is not a valid port.');

  return {
    mode,
    isProduction,
    supabase,
    timeZone,
    // Saving is what the app is for; the switch exists only to freeze changes deliberately.
    writesRequested: mode === 'mock' || read(env, 'REVIEW_WRITES_ENABLED')?.toLowerCase() !== 'false',
    gameSigningKey,
    adminEmails,
    port: Number.isInteger(port) ? port : 8787,
    host: read(env, 'HOST') ?? (isProduction ? '0.0.0.0' : '127.0.0.1'),
    issues,
  };
}
