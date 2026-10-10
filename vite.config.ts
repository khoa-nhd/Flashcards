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
      if (server.config.mode === 'mock') {
        // `npm run dev:mock`: built-in sample words, never Notion, whatever .env says.
        process.env.DATA_MODE = 'mock';
        process.env.APP_ACCESS_PASSWORD = '';
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
  },
});
