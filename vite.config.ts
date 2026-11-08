import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Serves /api/* from the same dev server as the frontend, so `npm run dev` is
 * one process on one port. The server code is loaded through Vite, which also
 * reloads it when a file under server/, shared/ or config/ changes.
 */
function apiDevServer(): Plugin {
  return {
    name: 'flashcard-api-dev-server',
    apply: (_config, env) => env.command === 'serve' && env.mode !== 'test',
    configureServer(server) {
      if (server.config.mode === 'mock' || server.config.mode === 'mock-fsrs') {
        // `npm run dev:mock`: built-in sample words and no database, whatever .env says.
        process.env.DATA_MODE = 'mock';
        // `npm run dev:mock-fsrs`: the same words with FSRS as the only schedule (schema version 15).
        process.env.MOCK_FSRS_ONLY = server.config.mode === 'mock-fsrs' ? 'true' : 'false';
      } else {
        try {
          process.loadEnvFile();
        } catch {
          // No .env file: mock mode with defaults.
        }
      }
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        try {
          const bootstrap = (await server.ssrLoadModule('/server/bootstrap.ts')) as typeof import('./server/bootstrap.js');
          const { app } = bootstrap.getApp();
          await getRequestListener((request) => app.fetch(request))(req, res);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

/**
 * Fills in the service worker's two build-time facts: which files make up the entry, so a
 * repeat visit is answered from the cache instead of the network, and a version taken from
 * their names, so a new deployment replaces the previous cache. Without this the worker
 * precaches only the shell and keeps an old bundle until a newer one happens to be fetched.
 */
function serviceWorkerPrecache(): Plugin {
  let files: string[] = [];
  let outDir = 'dist';
  return {
    name: 'flashcard-service-worker-precache',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      files = Object.values(bundle)
        .filter((file) => file.type === 'chunk' && file.isEntry)
        .map((file) => `/${file.fileName}`)
        .concat(Object.values(bundle).filter((file) => file.type === 'asset' && file.fileName.endsWith('.css')).map((file) => `/${file.fileName}`));
    },
    async closeBundle() {
      const path = join(outDir, 'sw.js');
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 8);
      try {
        const source = await readFile(path, 'utf8');
        await writeFile(
          path,
          source
            .replace("'flashcards-shell-dev'", `'flashcards-shell-${version}'`)
            .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(files)};`),
        );
      } catch {
        // No worker in this build (a mode without public/): nothing to fill in.
      }
    },
  };
}

/**
 * Starts the downloads the first paint is waiting for as soon as the HTML is parsed,
 * instead of after the entry chunk has run: the two faces body text is drawn in (Latin
 * for the interface, Vietnamese for the words) and the sign-in chunk, which every boot
 * imports whether the deployment has accounts or not. File names carry a content hash,
 * so everything is read from the bundle rather than written here. The serif headings and
 * the 500/600 weights are left out on purpose — they are not on the first screen, and a
 * hint for each would compete for the same slow connection.
 */
function loadHints(): Plugin {
  const FONTS = /^assets\/public-sans-(?:latin|vietnamese)-400-normal-[^/]*\.woff2$/;
  const AUTH = /^assets\/supabase-auth-[^/]*\.js$/;
  return {
    name: 'flashcard-load-hints',
    apply: 'build',
    // The index.html asset only exists once Vite's own build plugins have emitted it.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle['index.html'];
      if (html === undefined || html.type !== 'asset' || typeof html.source !== 'string') return;
      const fonts = Object.keys(bundle)
        .filter((name) => FONTS.test(name))
        .sort()
        .map((name) => `    <link rel="preload" href="/${name}" as="font" type="font/woff2" crossorigin />`);
      const auth = Object.keys(bundle)
        .filter((name) => AUTH.test(name))
        .map((name) => `    <link rel="modulepreload" href="/${name}" />`);
      const hints = [...fonts, ...auth];
      if (hints.length === 0) return;
      html.source = html.source.replace('</title>', `</title>\n${hints.join('\n')}`);
    },
  };
}

/**
 * Starts the browser's TLS handshake with the Supabase project before /api/config has
 * answered, so signing in does not pay for it. The address is the same public one the
 * server hands to the browser anyway; a build without it in the environment leaves the
 * hint out rather than guessing.
 */
function supabasePreconnect(): Plugin {
  let origin: string | null = null;
  return {
    name: 'flashcard-supabase-preconnect',
    configResolved(config) {
      const env = loadEnv(config.mode, process.cwd(), '');
      const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '';
      try {
        origin = url === '' ? null : new URL(url).origin;
      } catch {
        origin = null;
      }
    },
    transformIndexHtml() {
      if (origin === null) return;
      return [{ tag: 'link', attrs: { rel: 'preconnect', href: origin, crossorigin: '' }, injectTo: 'head-prepend' as const }];
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    apiDevServer(),
    supabasePreconnect(),
    loadHints(),
    serviceWorkerPrecache(),
  ],
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    // The page tests type into real forms in jsdom. With every file running at once on a busy machine, one
    // that passes in two seconds alone has been seen to take over fifteen; this leaves room for that.
    testTimeout: 30_000,
    // Every test file gets a process of its own, most with a whole browser page or a whole PostgreSQL in it.
    // One per processor core starves them all: files fail to start and typing tests time out. Half as many
    // finishes no later and leaves the machine usable.
    maxWorkers: '50%',
  },
});
