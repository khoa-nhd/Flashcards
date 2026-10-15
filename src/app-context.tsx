/**
 * The long-lived objects every page shares: the API client, the review
 * session, the loaded vocabulary, preferences and toasts. They are created
 * once for the app's lifetime, so moving between tabs keeps a review session
 * where it was and never reloads data needlessly.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ReviewFocus } from '../shared/api.js';
import type { AppApi } from './lib/api-client.js';
import { createLibraryStore, type LibraryState, type LibraryStore } from './lib/library-store.js';
import { invalidateAllPracticeHistory } from './lib/practice-history-cache.js';
import { createSessionController, type SessionController } from './lib/session-controller.js';
import { saveIssue } from './lib/session-machine.js';
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
}

/**
 * With accounts, one set of services is created per signed-in user and thrown
 * away when they sign out, so nothing loaded for one account is ever shown to
 * another.
 */
export function createAppServices(
  api: AppApi,
  settings: SettingsStore = createSettingsStore(),
  account: AccountControls | null = null,
): AppServices {
  const vocabulary = createVocabularyStore(api);
  // The practice history cache lives outside these services; a new account must not start with the last one's.
  invalidateAllPracticeHistory();
  // A saved answer changes mastery and dates, so the other pages must re-read.
  const session = createSessionController(api, () => vocabulary.markStale());
  let reviewStarted = false;
  const library = createLibraryStore(api);
  const ensureReviewSession = (focus: ReviewFocus | null = null, collection: string | null = null) => {
    const current = session.getState();
    const failedToLoad = current.status === 'error' && current.error?.kind === 'load';
    // Asking for a different selection of cards is a new session. An answer that is still being saved, or that
    // failed and is waiting for a retry, is never dropped for it.
    const unsettled = current.saving !== null || saveIssue(current) !== null;
    const changed =
      current.meta !== null && (current.meta.focus !== focus || (current.meta.collection?.id ?? null) !== collection);
    const refocused = reviewStarted && changed && !unsettled;
    if (!reviewStarted || current.status === 'completed' || failedToLoad || refocused) {
      reviewStarted = true;
      void session.load({ focus, collection });
    }
  };

  return { api, session, vocabulary, settings, toasts: createToastStore(), account, ensureReviewSession, library };
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