import { describe, expect, it } from 'vitest';
import { accessMode } from '../../server/auth.js';
import { loadConfig } from '../../server/env.js';

const notionEnv = {
  NOTION_API_KEY: 'secret_test_value',
  NOTION_DATABASE_ID: '11111111111141118111111111111111',
  REVIEW_TIMEZONE: 'Asia/Ho_Chi_Minh',
};

describe('loadConfig', () => {
  it('uses sample data in development when no Notion key is present', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ mode: 'mock', notion: null, issues: [], writesRequested: true });
    expect(config.timeZone).toBeTruthy();
  });

  it('uses Notion when a key is present', () => {
    const config = loadConfig(notionEnv);
    expect(config).toMatchObject({ mode: 'notion', timeZone: 'Asia/Ho_Chi_Minh', issues: [] });
    expect(config.notion?.databaseId).toBe(notionEnv.NOTION_DATABASE_ID);
  });

  it('keeps Notion writes off unless explicitly enabled', () => {
    expect(loadConfig(notionEnv).writesRequested).toBe(false);
    expect(loadConfig({ ...notionEnv, REVIEW_WRITES_ENABLED: 'false' }).writesRequested).toBe(false);
    expect(loadConfig({ ...notionEnv, REVIEW_WRITES_ENABLED: 'yes' }).writesRequested).toBe(false);
    expect(loadConfig({ ...notionEnv, REVIEW_WRITES_ENABLED: 'true' }).writesRequested).toBe(true);
  });

  it('never falls back to sample data in production', () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.mode).toBe('notion');
    expect(config.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('NOTION_API_KEY'), expect.stringContaining('NOTION_DATABASE_ID')]),
    );
  });

  it('requires a time zone with Notion rather than assuming one', () => {
    const config = loadConfig({ ...notionEnv, REVIEW_TIMEZONE: '' });
    expect(config.timeZone).toBeNull();
    expect(config.issues).toEqual([expect.stringContaining('REVIEW_TIMEZONE')]);
  });

  it('rejects an invalid time zone', () => {
    const config = loadConfig({ ...notionEnv, REVIEW_TIMEZONE: 'Hanoi' });
    expect(config.issues).toEqual([expect.stringContaining('not a valid IANA time zone')]);
  });

  it('treats blank values as unset and never echoes secrets in issues', () => {
    const config = loadConfig({ NOTION_API_KEY: '   ', DATA_MODE: 'notion', APP_ACCESS_PASSWORD: '' });
    expect(config.notion).toBeNull();
    expect(config.accessPassword).toBeNull();
    const withKey = loadConfig({ NOTION_API_KEY: 'secret_test_value', DATA_MODE: 'notion' });
    expect(withKey.issues.join(' ')).not.toContain('secret_test_value');
  });

  it('flags an unknown DATA_MODE', () => {
    expect(loadConfig({ DATA_MODE: 'live' }).issues).toEqual([expect.stringContaining('DATA_MODE')]);
  });
});

describe('accessMode', () => {
  it('is open only for local development or an explicit opt-out', () => {
    expect(accessMode(loadConfig({}))).toBe('open');
    expect(accessMode(loadConfig({ ...notionEnv, NODE_ENV: 'production' }))).toBe('locked');
    expect(accessMode(loadConfig({ ...notionEnv, NODE_ENV: 'production', ALLOW_UNAUTHENTICATED_ACCESS: 'true' }))).toBe(
      'open',
    );
    expect(accessMode(loadConfig({ ...notionEnv, NODE_ENV: 'production', APP_ACCESS_PASSWORD: 'a passphrase' }))).toBe(
      'password',
    );
  });
});
