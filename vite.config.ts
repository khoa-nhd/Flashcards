import { getRequestListener } from '@hono/node-server';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
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

export default defineConfig({
  plugins: [react(), tailwindcss(), apiDevServer()],
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
