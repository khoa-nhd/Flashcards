/**
 * The app once kept its vocabulary in Notion. That integration was removed
 * when the data moved to Supabase, and this test keeps it removed: no code
 * that runs, no dependency, no setting and no script may refer to it again.
 *
 * Documentation and tests may still mention it, because the history of where
 * the review rules came from is worth keeping; the migration SQL is left
 * exactly as it was applied.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../server/bootstrap.js';
import { loadConfig } from '../server/env.js';

const SOURCE_DIRECTORIES = ['src', 'server', 'shared', 'config', 'api', 'scripts'];
const ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'vercel.json',
  'index.html',
  'eslint.config.js',
  'tsconfig.json',
  '.env.example',
];

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const sourceFiles = [...SOURCE_DIRECTORIES.flatMap(filesUnder), ...ROOT_FILES.filter((file) => existsSync(file))];

describe('the removed Notion integration', () => {
  it('is not mentioned anywhere in the code, configuration or scripts', () => {
    expect(sourceFiles.length).toBeGreaterThan(60);
    const mentions = sourceFiles.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, where: `${file}:${index + 1}` }))
        .filter(({ line }) => /notion/i.test(line))
        .map(({ where }) => where),
    );
    expect(mentions).toEqual([]);
  });

  it('is not a dependency, directly or indirectly', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string> | undefined>;
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies });
    expect(declared.filter((name) => /notion/i.test(name))).toEqual([]);
    expect(readFileSync('package-lock.json', 'utf8')).not.toMatch(/notion/i);
    expect(existsSync(join('node_modules', '@notionhq'))).toBe(false);
  });

  it('has no files of its own left', () => {
    for (const path of ['server/notion', 'scripts/inspect-notion.ts', 'scripts/export-notion.ts', 'server/auth.ts']) {
      expect(existsSync(path), path).toBe(false);
    }
    expect(sourceFiles.filter((file) => /notion/i.test(file))).toEqual([]);
  });

  it('cannot be selected as a data source, and nothing is served in its place', async () => {
    const env = {
      DATA_MODE: 'notion',
      NOTION_API_KEY: 'secret_test_value',
      NOTION_DATABASE_ID: '11111111111141118111111111111111',
      SUPABASE_URL: 'https://project-ref.supabase.co',
      SUPABASE_ANON_KEY: 'sb_publishable_test_key',
    };
    expect(loadConfig(env).issues).toEqual(['DATA_MODE must be "supabase" or "mock".']);

    const { app } = buildApp(env);
    const health = (await (await app.request('/api/health')).json()) as { ok: boolean };
    expect(health.ok).toBe(false);
    for (const path of ['/api/vocabulary', '/api/review-queue']) {
      const response = await app.request(path, { headers: { Authorization: 'Bearer a.b.c' } });
      expect(response.status, path).toBe(503);
    }
  });

  it('leaves its old settings without any effect', () => {
    const base = { SUPABASE_URL: 'https://project-ref.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test_key' };
    const withLeftovers = {
      ...base,
      NOTION_API_KEY: 'secret_test_value',
      NOTION_DATABASE_ID: '11111111111141118111111111111111',
      NOTION_DATA_SOURCE_ID: '22222222222242228222222222222222',
      APP_ACCESS_PASSWORD: 'a passphrase',
      ALLOW_UNAUTHENTICATED_ACCESS: 'true',
    };
    expect(loadConfig(withLeftovers)).toEqual(loadConfig(base));
  });
});
