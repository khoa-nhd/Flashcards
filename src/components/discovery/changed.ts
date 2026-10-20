/**
 * Discovery reaches across places: a phrase is captured from a dialog that
 * could be open anywhere, words are saved from the reading and listening
 * workspaces, and the Discovery page lists what is waiting. This is how a
 * change made in one place reaches a list that is already on screen — one
 * window event, no polling and no shared store.
 */
const EVENT = 'discovery:changed';

/** Tell every interested list that marks or sources have moved. */
export function announceDiscoveryChange(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Listen until the caller's effect cleans up. */
export function onDiscoveryChange(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
