/**
 * What a review is narrowed to. Everything due and the weakest words are named
 * by the address, so the server can work them out on its own. The reviewer's own
 * picked words are not: only this device knows which ones were ticked and in
 * what order, so they travel with the session and its queue request.
 *
 * A narrowing is also what this device files its cached queue and its sitting in
 * progress under, which is why a picked set has to name itself precisely.
 */

export type ReviewScope =
  | { kind: 'all' }
  | { kind: 'weak' }
  | { kind: 'selection'; ids: readonly string[] };

export const ALL_SCOPE: ReviewScope = { kind: 'all' };
export const WEAK_SCOPE: ReviewScope = { kind: 'weak' };

/** The words the reviewer picked, in the order they were ticked. */
export const selection = (ids: readonly string[]): ReviewScope => ({ kind: 'selection', ids });

/** Whether two scopes come to the same cards: a picked set counts as the same only in the same order. */
export function sameScope(a: ReviewScope, b: ReviewScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'selection' || b.kind !== 'selection') return true;
  return a.ids.length === b.ids.length && a.ids.every((id, at) => b.ids[at] === id);
}

/** Whether a queue built for this scope may bring a word forward before it is due. */
export const allowsEarly = (scope: ReviewScope): boolean => scope.kind !== 'all';

/**
 * The name this device files the scope's queue and sitting under. Two different
 * picked sets must never share one, or a queue cached for the first would be
 * shown as the second's.
 */
export function scopeKey(scope: ReviewScope): string {
  return scope.kind === 'selection' ? `select:${digest(scope.ids)}` : scope.kind;
}

/**
 * A short, stable digest of the ticked ids, in order (FNV-1a, then written in
 * base 36). It only has to tell this device's own selections apart.
 */
function digest(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  const mix = (code: number) => {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193);
  };
  for (const id of ids) {
    for (let at = 0; at < id.length; at += 1) mix(id.charCodeAt(at));
    // A separator, so "ab"+"c" and "a"+"bc" cannot come to the same digest.
    mix(0x2c);
  }
  return (hash >>> 0).toString(36);
}
