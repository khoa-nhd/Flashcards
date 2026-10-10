/**
 * The long-lived objects every page shares: the API client, the review
 * session, the loaded vocabulary, preferences and toasts. They are created
 * once for the app's lifetime, so moving between tabs keeps a review session
 * where it was and never reloads data needlessly.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { AppApi } from './lib/api-client.js';
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
  ensureReviewSession(focus?: 'weak' | null): void;
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
  // A saved answer changes mastery and dates, so the other pages must re-read.
  const session = createSessionController(api, () => vocabulary.markStale());
  let reviewStarted = false;
  const ensureReviewSession = (focus: 'weak' | null = null) => {
    const current = session.getState();
    const failedToLoad = current.status === 'error' && current.error?.kind === 'load';
    // Asking for a different selection of cards is a new session. An answer that is still being saved, or that
    // failed and is waiting for a retry, is never dropped for it.
    const unsettled = current.status === 'saving' || (current.status === 'error' && !failedToLoad);
    const refocused = reviewStarted && current.meta !== null && current.meta.focus !== focus && !unsettled;
    if (!reviewStarted || current.status === 'completed' || failedToLoad || refocused) {
      reviewStarted = true;
      void session.load({ focus });
    }
  };
  return { api, session, vocabulary, settings, toasts: createToastStore(), account, ensureReviewSession };
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

export function useSettings(): Settings {
  const { settings } = useApp();
  return useSyncExternalStore(settings.subscribe, settings.getState);
}
