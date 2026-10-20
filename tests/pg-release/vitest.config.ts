import { defineConfig } from 'vitest/config';

/**
 * The PostgreSQL release suites: real, multi-connection verification against
 * the local instance (see tests/helpers/pg-release-database.ts). They end in
 * `.pgtest.ts` so the project's `npm test` — which must stay green on a
 * machine with no PostgreSQL running — never collects them.
 *
 *     $env:PGREL_PASSWORD = '…'
 *     npx vitest run --config tests/pg-release/vitest.config.ts
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.pgtest.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // One file at a time in a single worker: the suites talk to one local
    // PostgreSQL instance and stay inside a small memory budget (Vitest 4+
    // removed `poolOptions`; these are the top-level equivalents).
    fileParallelism: false,
    maxWorkers: 1,
  },
});
