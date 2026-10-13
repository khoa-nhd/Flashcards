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
   * Where a language model is reached, for the features that ask one (Smart
   * Reader, Writing Challenge). The key is read here and never handed to the
   * browser — the frontend-secrets test keeps that true. `null` when no key
   * is set: the AI features then simply do not answer, and the app falls
   * back to entering everything by hand. Missing AI is not a startup issue.
   */
  ai: { baseUrl: string; apiKey: string; model: string; timeoutMs: number } | null;
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

  const port = Number(read(env, 'PORT') ?? '8787');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) issues.push('PORT is not a valid port.');

  // The language model, spoken to through its OpenAI-compatible endpoint. The
  // default is Gemini's, because its free tier is generous; any other
  // provider that speaks the same protocol is a different base URL and key.
  let ai: AppConfig['ai'] = null;
  const aiKey = read(env, 'AI_API_KEY');
  if (aiKey !== null) {
    const aiBaseUrl = read(env, 'AI_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta/openai/';
    const aiModel = read(env, 'AI_MODEL') ?? 'gemini-2.5-flash';
    const timeoutRaw = read(env, 'AI_TIMEOUT_MS') ?? '20000';
    const aiTimeoutMs = Number(timeoutRaw);
    if (!Number.isInteger(aiTimeoutMs) || aiTimeoutMs < 1000 || aiTimeoutMs > 28_000) {
      // Below Vercel's own 30s ceiling, so a slow answer is ours to time out, not the platform's.
      issues.push('AI_TIMEOUT_MS must be a whole number of milliseconds between 1000 and 28000.');
    } else {
      ai = { baseUrl: aiBaseUrl.endsWith('/') ? aiBaseUrl : `${aiBaseUrl}/`, apiKey: aiKey, model: aiModel, timeoutMs: aiTimeoutMs };
    }
  }

  return {
    mode,
    isProduction,
    supabase,
    timeZone,
    // Saving is what the app is for; the switch exists only to freeze changes deliberately.
    writesRequested: mode === 'mock' || read(env, 'REVIEW_WRITES_ENABLED')?.toLowerCase() !== 'false',
    ai,
    port: Number.isInteger(port) ? port : 8787,
    host: read(env, 'HOST') ?? (isProduction ? '0.0.0.0' : '127.0.0.1'),
    issues,
  };
}
