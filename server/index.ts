/** Node entry point: local development and self-hosting (`npm start`). */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { areWriteRulesConfirmed } from '../shared/review-logic.js';
import { reviewRules } from '../config/review.config.js';
import { buildApp } from './bootstrap.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const { app, config } = buildApp();

if (config.isProduction) {
  // Vite puts a content hash in the name of everything it emits, so a file at these
  // names never changes: it can be kept forever. Everything else — index.html above
  // all — is revalidated, or a deploy would not be seen.
  const hashedName = /-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|svg|png|webp|ico)$/;
  const assets = serveStatic({
    root: './dist',
    onFound: (path, c) => {
      c.header('Cache-Control', hashedName.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  // The built frontend, with a fallback so a refresh on any path still loads the app.
  const shell = serveStatic({
    path: './dist/index.html',
    onFound: (_path, c) => c.header('Cache-Control', 'no-cache'),
  });
  app.use('/*', (c, next) => (c.req.path.startsWith('/api/') ? next() : assets(c, next)));
  app.get('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : shell(c, next)));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, ({ port }) => {
  const writes =
    config.mode === 'mock'
      ? 'in-memory only'
      : config.writesRequested && areWriteRulesConfirmed(reviewRules)
        ? 'ENABLED'
        : 'disabled (read-only preview)';
  console.log(`Flashcard API listening on http://${config.host}:${port}`);
  console.log(`  data: ${config.mode} | writes: ${writes} | access: ${config.mode === 'supabase' ? 'accounts' : 'open'}`);
  for (const issue of config.issues) console.warn(`  setup issue: ${issue}`);
});
