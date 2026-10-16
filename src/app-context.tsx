/**
 * The long-lived objects every page shares: the API client, the review
 * session, the loaded vocabulary, preferences, toasts and the sync engine
 * behind them all. They are created once for the app's lifetime, so moving
 * between tabs keeps a review session where it was and never reloads data
 * needlessly.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ReviewFocus } from '../shared/api.js';
import type { AppApi } from './lib/api-client.js';
import { createLibraryStore, type LibraryState, type LibraryStore } from './lib/library-store.js';
import { createSender } from './lib/offline/send.js';
import { createMemoryStore, type LocalStore } from './lib/offline/storage.js';
import { withCachedReads } from './lib/offline/cached-api.js';
import { createSyncEngine, type SyncEngine, type SyncEngineState } from './lib/offline/sync-engine.js';
import { invalidateAllPracticeHistory } from './lib/practice-history-cache.js';
import { createSessionController, type SessionController } from './lib/session-controller.js';
import { createSettingsStore, type Settings, type SettingsStore } from './lib/settings.js';
import { createToastStore, type ToastStore } from './lib/toasts.js';
import { createVocabularyStore, type VocabularyState, type VocabularyStore } from './lib/vocabulary-store.js';

/** The signed-in account, where the app has accounts. */
export interface AccountControls {
  email: string | null;
  /** Signs out on this device. */
  signOut(): Promise<void>;
}

export interface AppServices {
  api: AppApi;
  session: SessionController;
  vocabulary: VocabularyStore;
  settings: SettingsStore;
  toasts: ToastStore;
  /** `null` with the built-in sample words, which need no account. */
  account: AccountControls | null;
  /**
   * Called when the Review tab is shown. Loads the queue on the first visit;
   * afterwards only a finished or failed session is replaced, so one in
   * progress survives a trip to another tab.
   */
  ensureReviewSession(focus?: ReviewFocus | null, collection?: string | null): void;
  /** Collections, further examples and relationships between words. */
  library: LibraryStore;
  /**
   * The outbox behind every write: what is waiting to reach the server, what
   * it refused, and the way to retry or dismiss it.
   */
  sync: SyncEngine;
  /**
   * What this device keeps for this account between visits: the outbox and the
   * caches behind offline reading. None of it is the only copy of anything, so
   * clearing it never touches what the account holds.
   */
  local: {
    /** False without durable storage: nothing is kept once the tab is closed. */
    persistent: boolean;
    /** Removes everything kept for this account on this device. */
    clear(): Promise<void>;
  };
}

export interface AppServiceOptions {
  /** The signed-in account's id. Data under one id is never shown under another. */
  accountId?: string;
  /** This device's durable storage. Without one, everything is kept in memory only. */
  store?: LocalStore;
}

/**
 * With accounts, one set of services is created per signed-in user and thrown
 * away when they sign out, so nothing loaded for one account is ever shown to
 * another. Each account's writes wait in its own outbox, named by its id.
 */
export function createAppServices(
  api: AppApi,
  settings: SettingsStore = createSettingsStore(),
  account: AccountControls | null = null,
  options: AppServiceOptions = {},
): AppServices {
  const accountId = options.accountId ?? 'local';
  const store = options.store ?? createMemoryStore();
  // Reads that cannot reach the server are answered from this device's own copies, where there are any.
  const client = withCachedReads(api, { store, accountId });
  // Temporary ids of words added on this device, shared between the store that
  // makes them and the sender that has to name the real word once it exists.
  const ids = new Map<string, string>();
  const sync = createSyncEngine({ accountId, store, sender: createSender(client, (id) => ids.get(id) ?? id) });
  const vocabulary = createVocabularyStore({ api: client, engine: sync, store, accountId, ids });
  // The practice history cache lives outside these services; a new account must not start with the last one's.
  invalidateAllPracticeHistory();
  // A saved answer changes mastery and dates, so the other pages must re-read.
  const session = createSessionController({ api: client, engine: sync, store, accountId, onSaved: () => vocabulary.markStale() });
  let reviewStarted = false;
  const library = createLibraryStore(client);
  const ensureReviewSession = (focus: ReviewFocus | null = null, collection: string | null = null) => {
    const current = session.getState();
    const failedToLoad = current.status === 'error' && current.error?.kind === 'load';
    // Asking for a different selection of cards is a new session. Answers
    // already given are not at risk: their writes are in the outbox.
    const changed =
      current.meta !== null && (current.meta.focus !== focus || (current.meta.collection?.id ?? null) !== collection);
    const refocused = reviewStarted && changed;
    if (!reviewStarted || current.status === 'completed' || failedToLoad || refocused) {
      reviewStarted = true;
      void session.load({ focus, collection });
    }
  };

  return {
    api: client,
    session,
    vocabulary,
    settings,
    toasts: createToastStore(),
    account,
    ensureReviewSession,
    library,
    sync,
    local: {
      get persistent() {
        return store.persistent;
      },
      clear: () => store.clearAccount(accountId),
    },
  };
}

const AppContext = createContext<AppServices | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): AppServices {
  const services = useContext(AppContext);
  if (services === null) throw new Error('useApp must be used inside <AppProvider>.');
  return services;
}

/** The vocabulary, loading it on first use and refreshing it when it has gone stale. */
export function useVocabulary(): VocabularyState {
  const { vocabulary } = useApp();
  const state = useSyncExternalStore(vocabulary.subscribe, vocabulary.getState);
  useEffect(() => {
    vocabulary.ensureFresh();
    // Coming back to the tab is when another device's changes are most likely to be missing.
    const refresh = () => {
      if (document.visibilityState === 'visible') vocabulary.ensureFresh();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [vocabulary]);
  return state;
}

/** How the outbox is doing: what is waiting, what was refused, and why. */
export function useSync(): SyncEngineState {
  const { sync } = useApp();
  return useSyncExternalStore(sync.subscribe, sync.getState);
}

/** The account's collections, examples and relationships, loading them on first use. */
export function useLibrary(): LibraryState {
  const { library } = useApp();
  const state = useSyncExternalStore(library.subscribe, library.getState);
  useEffect(() => {
    library.ensureLoaded();
  }, [library]);
  return state;
}

export function useSettings(): Settings {
  const { settings } = useApp();
  return useSyncExternalStore(settings.subscribe, settings.getState);
}

/** Access True Mastery data for vocabulary entries. */
export { useTrueMastery } from './hooks/useTrueMastery.js';
export type { SyncEngineState } from './lib/offline/sync-engine.js';
