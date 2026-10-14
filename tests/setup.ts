import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { setGlobalTestMode } from '../src/lib/mutation-queue.js';

// Component tests opt into jsdom per file; server and logic tests stay in Node.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());
}

// Enable synchronous mutation queue processing for tests
setGlobalTestMode(true);