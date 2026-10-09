import { isValidTimeZone } from '../shared/dates.js';

export type DataMode = 'mock' | 'notion';

export interface AppConfig {
  mode: DataMode;
  isProduction: boolean;
  notion: { apiKey: string; databaseId: string | null; dataSourceId: string | null } | null;
  /** IANA zone that defines "today" for due-date comparisons. */
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

export function loadConfig(env: Env = process.env): AppConfig {
  const issues: string[] = [];
  const isProduction = read(env, 'NODE_ENV') === 'production';

  const apiKey = read(env, 'NOTION_API_KEY');
  const databaseId = read(env, 'NOTION_DATABASE_ID');
  const dataSourceId = read(env, 'NOTION_DATA_SOURCE_ID');

  const requestedMode = read(env, 'DATA_MODE');
  let mode: DataMode;
  if (requestedMode === 'mock' || requestedMode === 'notion') {
    mode = requestedMode;
  } else {
    if (requestedMode !== null) issues.push('DATA_MODE must be "mock" or "notion".');
    // Sample data is a development convenience; a deployment must opt into it.
    mode = apiKey !== null || isProduction ? 'notion' : 'mock';
  }

  let timeZone = read(env, 'REVIEW_TIMEZONE');
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    issues.push('REVIEW_TIMEZONE is not a valid IANA time zone (for example "Asia/Ho_Chi_Minh").');
    timeZone = null;
  }

  let notion: AppConfig['notion'] = null;
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
  } else if (timeZone === null) {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  const port = Number(read(env, 'PORT') ?? '8787');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) issues.push('PORT is not a valid port.');

  return {
    mode,
    isProduction,
    notion,
    timeZone,
    writesRequested: mode === 'mock' ? true : readFlag(env, 'REVIEW_WRITES_ENABLED'),
    accessPassword: read(env, 'APP_ACCESS_PASSWORD'),
    allowUnauthenticated: readFlag(env, 'ALLOW_UNAUTHENTICATED_ACCESS'),
    port: Number.isInteger(port) ? port : 8787,
    host: read(env, 'HOST') ?? (isProduction ? '0.0.0.0' : '127.0.0.1'),
    issues,
  };
}
