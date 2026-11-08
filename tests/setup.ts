import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// Component tests opt into jsdom per file; server and logic tests stay in Node.
if (typeof document !== 'undefined') {
  const { cleanup, configure } = await import('@testing-library/react');
  // Every page but the dashboard and review arrives as its own chunk, so its content shows
  // up one microtask later than it used to. A second is enough when the suite runs alone and
  // not when every file is competing for the machine, so wait long enough for the load.
  configure({ asyncUtilTimeout: 4_000 });
  afterEach(() => cleanup());
}
