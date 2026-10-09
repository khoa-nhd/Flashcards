/** Node entry point: local development and self-hosting (`npm start`). */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { areWriteRulesConfirmed } from '../shared/review-logic.js';
import { reviewRules } from '../config/review.config.js';
import { accessMode } from './auth.js';
import { buildApp } from './bootstrap.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const { app, config } = buildApp();

if (config.isProduction) {
  // The built frontend, with a fallback so a refresh on any path still loads the app.
  const assets = serveStatic({ root: './dist' });
  const shell = serveStatic({ path: './dist/index.html' });
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
  console.log(`  data: ${config.mode} | Notion writes: ${writes} | access: ${accessMode(config)}`);
  for (const issue of config.issues) console.warn(`  setup issue: ${issue}`);
});
