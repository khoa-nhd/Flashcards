import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// Component tests opt into jsdom per file; server and logic tests stay in Node.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());

  // Review tests exercise the plain two-button flow. The app asks for confidence by
  // default now; these tests seed it off in this browser store, and study-experience
  // pins the default-on path itself.
  window.localStorage.setItem('vocabulary-review:settings:v1', JSON.stringify({ askConfidence: false }));
}
