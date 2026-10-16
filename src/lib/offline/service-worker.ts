/**
 * Registers the small service worker that makes the page itself load without a
 * connection, so the app can open and read what it has kept on the device.
 *
 * Only production builds register it. In development the app is served
 * straight from source and the worker would only get in the way; the build
 * marks itself through a `%MODE%` placeholder in the page, which keeps this
 * file free of anything the build system injects.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const mode = document.querySelector('meta[name="app-mode"]')?.getAttribute('content');
  if (mode !== 'production') return;
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
