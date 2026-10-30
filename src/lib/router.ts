/**
 * A minimal path router on the History API: enough for a handful of top-level
 * pages with query-string state, direct links and working back/forward.
 */
import { useMemo, useSyncExternalStore } from 'react';

export const ROUTES = {
  dashboard: '/',
  review: '/review',
  add: '/add',
  import: '/import',
  bank: '/bank',
  calendar: '/calendar',
  practice: '/practice',
  collections: '/collections',
  weak: '/weak',
  insights: '/insights',
  settings: '/settings',
  achievements: '/achievements',
  league: '/league',
  friends: '/friends',
  /** A player's profile is `/profile?u=<nickname>`; without it, one's own. */
  profile: '/profile',
  admin: '/admin',
  shop: '/shop',
  collection: '/collection',
  boss: '/boss',
  chat: '/chat',
  help: '/help',
} as const;

export type RouteKey = keyof typeof ROUTES;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

const currentHref = () => window.location.pathname + window.location.search;

/** Goes to a path (with optional query). `replace` rewrites the current history entry instead of adding one. */
export function navigate(to: string, options: { replace?: boolean; state?: unknown } = {}): void {
  if (to === currentHref()) return;
  const state = options.state ?? null;
  if (options.replace) window.history.replaceState(state, '', to);
  else window.history.pushState(state, '', to);
  for (const listener of listeners) listener();
}

const WORD_PARAM = 'word';

/** The id of the word whose detail panel the address asks for, if any. */
export function wordInQuery(query: URLSearchParams): string | null {
  return query.get(WORD_PARAM);
}

/** Opens a word's detail panel over the current page, as its own history entry. */
export function openWord(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(WORD_PARAM, id);
  navigate(url.pathname + url.search, { state: { wordPanel: true } });
}

/** Closes the detail panel: Back if it was opened from within the app, otherwise in place. */
export function closeWord(): void {
  const state: unknown = window.history.state;
  if (typeof state === 'object' && state !== null && 'wordPanel' in state) {
    window.history.back();
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(WORD_PARAM);
  navigate(url.pathname + url.search, { replace: true });
}

export interface Location {
  pathname: string;
  query: URLSearchParams;
  href: string;
}

export function useLocation(): Location {
  const href = useSyncExternalStore(subscribe, currentHref);
  return useMemo(() => {
    const [pathname = '/', search = ''] = href.split('?');
    return { pathname: pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(search), href };
  }, [href]);
}

/**
 * Builds a link from a path and query values. `null`, `undefined` and empty
 * strings are left out, so a default never clutters the address.
 */
export function buildHref(
  pathname: string,
  params: Record<string, string | number | null | undefined> = {},
  base?: URLSearchParams,
): string {
  const query = new URLSearchParams(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') query.delete(key);
    else query.set(key, String(value));
  }
  const search = query.toString();
  return search === '' ? pathname : `${pathname}?${search}`;
}

/** The page a path belongs to, or `null` for an unknown path. */
export function matchRoute(pathname: string): RouteKey | null {
  const entry = (Object.entries(ROUTES) as Array<[RouteKey, string]>).find(([, path]) => path === pathname);
  return entry ? entry[0] : null;
}
