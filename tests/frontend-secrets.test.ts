/**
 * Nothing privileged may reach a browser. The only Supabase key this app uses
 * is the public one, which is safe to hand out because row-level security
 * decides what each signed-in user can see. This test keeps it that way by
 * reading the source: code that is bundled for the browser may not read the
 * environment, name a privileged key, or import server code, and the server
 * itself may not be given a privileged key to use.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/env.js';

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Lines of `files` matching `pattern`, as "file:line". */
function mentions(files: readonly string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, index) => ({ line, where: `${file.replaceAll('\\', '/')}:${index + 1}` }))
      .filter(({ line }) => pattern.test(line))
      .map(({ where }) => where),
  );
}

/** Everything Vite can bundle for the browser: the app, and the shared code and settings it imports. */
const browserFiles = [...['src', 'shared', 'config'].flatMap(filesUnder), 'index.html'];
const serverFiles = ['server', 'api', 'scripts'].flatMap(filesUnder);

describe('code that runs in the browser', () => {
  it('is actually being read by this test', () => {
    expect(browserFiles.length).toBeGreaterThan(50);
    expect(serverFiles.length).toBeGreaterThan(15);
  });

  it('never reads the environment, where secrets live', () => {
    // Vite inlines `import.meta.env.VITE_*` into the bundle; the app takes its public settings from /api/config instead.
    expect(mentions(browserFiles, /process\.env|import\.meta\.env|loadEnvFile/)).toEqual([]);
  });

  it('never names a privileged key', () => {
    expect(mentions(browserFiles, /service[_-]?role|sb_secret_|secret[_-]?key/i)).toEqual([]);
    // As part of a setting's name. The plain word is fine in a sentence saying something is not one.
    expect(mentions(browserFiles, /[A-Z0-9_]*SECRET[A-Z0-9_]*/)).toEqual([]);
  });

  it('never imports server code or scripts', () => {
    expect(mentions(browserFiles, /from\s+'(\.\.\/)+(server|scripts|api)\//)).toEqual([]);
    expect(mentions(browserFiles, /import\(\s*'(\.\.\/)+(server|scripts|api)\//)).toEqual([]);
  });

  it('creates its Supabase client only from what the server hands out as public', () => {
    // One place builds the browser's client, and it takes the address and key as arguments.
    const creators = mentions(filesUnder('src'), /createClient\(/);
    expect(creators.map((where) => where.split(':')[0])).toEqual(['src/lib/supabase-auth.ts']);
  });
});

describe('the server', () => {
  it('has no setting through which a privileged key could be supplied', () => {
    expect(mentions(serverFiles, /\b[A-Z][A-Z0-9_]*(SERVICE_ROLE|SECRET)[A-Z0-9_]*\b/)).toEqual([]);
  });

  it('refuses to start with a privileged key in place of the public one', () => {
    const privileged = Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase' })).toString('base64url');
    for (const key of ['sb_secret_test_value', `e30.${privileged}.signature`]) {
      const { issues } = loadConfig({ SUPABASE_URL: 'https://project-ref.supabase.co', SUPABASE_ANON_KEY: key });
      expect(issues.join(' '), key.slice(0, 12)).toMatch(/public|publishable|secret|service/i);
      expect(issues.length).toBeGreaterThan(0);
    }
  });
});
