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

export interface AppServices {
  api: AppApi;
  session: SessionController;
  vocabulary: VocabularyStore;
  settings: SettingsStore;
  toasts: ToastStore;
  /**
   * Called when the Review tab is shown. Loads the queue on the first visit;
   * afterwards only a finished or failed session is replaced, so one in
   * progress survives a trip to another tab.
   */
  ensureReviewSession(): void;
}

export function createAppServices(api: AppApi, settings: SettingsStore = createSettingsStore()): AppServices {
  const vocabulary = createVocabularyStore(api);
  // A saved answer changes mastery and dates, so the other pages must re-read.
  const session = createSessionController(api, () => vocabulary.markStale());
  let reviewStarted = false;
  const ensureReviewSession = () => {
    const current = session.getState();
    const failedToLoad = current.status === 'error' && current.error?.kind === 'load';
    if (!reviewStarted || current.status === 'completed' || failedToLoad) {
      reviewStarted = true;
      void session.load();
    }
  };
  return { api, session, vocabulary, settings, toasts: createToastStore(), ensureReviewSession };
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
  }, [vocabulary]);
  return state;
}

export function useSettings(): Settings {
  const { settings } = useApp();
  return useSyncExternalStore(settings.subscribe, settings.getState);
}
