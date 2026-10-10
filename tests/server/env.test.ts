import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/env.js';

const supabaseEnv = {
  SUPABASE_URL: 'https://project-ref.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_test_key',
};

describe('loadConfig', () => {
  it('uses sample data in development when nothing is configured', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ mode: 'mock', supabase: null, issues: [], writesRequested: true });
    expect(config.timeZone).toBeTruthy();
  });

  it('uses Supabase as soon as a project is named', () => {
    const config = loadConfig(supabaseEnv);
    expect(config).toMatchObject({ mode: 'supabase', issues: [], writesRequested: true });
    expect(config.supabase).toEqual({ url: supabaseEnv.SUPABASE_URL, publicKey: supabaseEnv.SUPABASE_ANON_KEY });
  });

  it('never serves sample data from a deployment unless told to', () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.mode).toBe('supabase');
    expect(config.supabase).toBeNull();
    expect(config.issues).toEqual([expect.stringContaining('SUPABASE_URL'), expect.stringContaining('SUPABASE_ANON_KEY')]);

    expect(loadConfig({ NODE_ENV: 'production', DATA_MODE: 'mock' })).toMatchObject({ mode: 'mock', issues: [] });
  });

  it('keeps sample data when asked for it, even with a project configured', () => {
    expect(loadConfig({ ...supabaseEnv, DATA_MODE: 'mock' })).toMatchObject({ mode: 'mock', supabase: null, issues: [] });
  });

  it('keeps saving on unless it is frozen on purpose', () => {
    expect(loadConfig(supabaseEnv).writesRequested).toBe(true);
    expect(loadConfig({ ...supabaseEnv, REVIEW_WRITES_ENABLED: 'true' }).writesRequested).toBe(true);
    expect(loadConfig({ ...supabaseEnv, REVIEW_WRITES_ENABLED: 'yes' }).writesRequested).toBe(true);
    expect(loadConfig({ ...supabaseEnv, REVIEW_WRITES_ENABLED: 'FALSE' }).writesRequested).toBe(false);
  });

  it('treats the time zone as optional, and rejects one that does not exist', () => {
    expect(loadConfig(supabaseEnv).timeZone).toBeNull();
    expect(loadConfig({ ...supabaseEnv, REVIEW_TIMEZONE: 'Asia/Ho_Chi_Minh' }).timeZone).toBe('Asia/Ho_Chi_Minh');
    const invalid = loadConfig({ ...supabaseEnv, REVIEW_TIMEZONE: 'Hanoi' });
    expect(invalid.issues).toEqual([expect.stringContaining('not a valid IANA time zone')]);
    expect(invalid.supabase).toBeNull();
  });

  it('treats blank values as unset and never echoes a key in its issues', () => {
    const blank = loadConfig({ SUPABASE_URL: '   ', SUPABASE_ANON_KEY: '', DATA_MODE: 'supabase' });
    expect(blank.supabase).toBeNull();
    expect(blank.issues).toHaveLength(2);

    const secret = loadConfig({ ...supabaseEnv, SUPABASE_ANON_KEY: 'sb_secret_do_not_print_me' });
    expect(secret.supabase).toBeNull();
    expect(secret.issues.join(' ')).not.toContain('sb_secret_do_not_print_me');
  });

  it('flags a data source it does not have, and serves nothing in its place', () => {
    for (const mode of ['live', 'notion']) {
      const config = loadConfig({ ...supabaseEnv, DATA_MODE: mode });
      expect(config.issues).toEqual([expect.stringContaining('DATA_MODE must be')]);
      expect(config.supabase).toBeNull();
    }
  });

  it('ignores settings that belonged to the old data source', () => {
    const config = loadConfig({
      ...supabaseEnv,
      NOTION_API_KEY: 'secret_test_value',
      NOTION_DATABASE_ID: '11111111111141118111111111111111',
      APP_ACCESS_PASSWORD: 'a passphrase',
      ALLOW_UNAUTHENTICATED_ACCESS: 'true',
    });
    expect(config).toMatchObject({ mode: 'supabase', issues: [] });
    expect(JSON.stringify(config)).not.toContain('secret_test_value');
    expect(JSON.stringify(config)).not.toContain('a passphrase');
  });
});
