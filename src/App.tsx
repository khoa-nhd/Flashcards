import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { pageIdSchema, type AppConfigResponse } from '../shared/api.js';
import { AppProvider, createAppServices, useApp, useSettings, type AccountControls } from './app-context.js';
import { AppShell } from './components/AppShell.js';
import { AuthScreen } from './components/AuthScreen.js';
import { Link } from './components/Link.js';
import { Spinner } from './components/Spinner.js';
import { Toasts } from './components/Toasts.js';
import { UnlockScreen } from './components/UnlockScreen.js';
import { WordDetailPanel } from './components/WordDetailPanel.js';
import { BUTTON_PRIMARY } from './components/ui.js';
import { ApiError, appApi, createAppApi, fetchAppConfig, type ApiAuth, type AppApi } from './lib/api-client.js';
import type { AuthClient } from './lib/auth.js';
import { ROUTES, closeWord, matchRoute, useLocation, wordInQuery, type RouteKey } from './lib/router.js';
import type { SettingsStore } from './lib/settings.js';
import { AddPage } from './pages/AddPage.js';
import { BankPage } from './pages/BankPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { InsightsPage } from './pages/InsightsPage.js';
import { ReviewPage } from './pages/ReviewPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

const PAGES: Record<RouteKey, { title: string; render: () => ReactNode }> = {
  dashboard: { title: 'Dashboard', render: () => <DashboardPage /> },
  review: { title: 'Review', render: () => <ReviewPage /> },
  add: { title: 'Add vocabulary', render: () => <AddPage /> },
  bank: { title: 'Vocabulary bank', render: () => <BankPage /> },
  calendar: { title: 'Calendar', render: () => <CalendarPage /> },
  insights: { title: 'Insights', render: () => <InsightsPage /> },
  settings: { title: 'Settings', render: () => <SettingsPage /> },
};

export interface AppProps {
  /** Given directly where the app runs without accounts, and in tests. */
  api?: AppApi;
  settings?: SettingsStore;
  /** Given in tests of the account flow; otherwise built from what the server says it uses. */
  auth?: AuthClient;
  /** Builds the API for a signed-in user. Replaceable in tests. */
  apiFor?: (auth: ApiAuth) => AppApi;
  /** Asks the server how people sign in. Replaceable in tests. */
  loadConfig?: () => Promise<AppConfigResponse>;
}

export function App({ api, settings, auth, apiFor, loadConfig }: AppProps) {
  if (auth !== undefined) return <AccountApp auth={auth} settings={settings} apiFor={apiFor} />;
  if (api !== undefined) return <Workspace api={api} settings={settings} account={null} />;
  return <Boot settings={settings} apiFor={apiFor} loadConfig={loadConfig} />;
}

function Splash({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      {children ?? (
        <p role="status" className="flex items-center gap-3 text-muted">
          <Spinner className="size-5" />
          Starting…
        </p>
      )}
    </div>
  );
}

type BootState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'open' }
  | { status: 'accounts'; auth: AuthClient };

/** Finds out from the server whether this deployment has accounts, then starts the right app. */
function Boot({ settings, apiFor, loadConfig = fetchAppConfig }: Pick<AppProps, 'settings' | 'apiFor' | 'loadConfig'>) {
  const [state, setState] = useState<BootState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const config = await loadConfig();
        if (config.auth !== 'account') return { status: 'open' } as const;
        if (config.supabase === null) {
          return { status: 'failed', message: 'The server is not configured yet. Open /api/health for the details.' } as const;
        }
        // Loaded only where accounts are in use.
        const { createSupabaseAuth } = await import('./lib/supabase-auth.js');
        return { status: 'accounts', auth: createSupabaseAuth(config.supabase.url, config.supabase.publicKey) } as const;
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof ApiError ? error.message : 'The app could not start.',
        } as const;
      }
    })().then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
    };
  }, [loadConfig, attempt]);

  if (state.status === 'loading') return <Splash />;
  if (state.status === 'failed') {
    return (
      <Splash>
        <h1 className="font-serif text-2xl font-semibold">Could not start</h1>
        <p role="alert" className="max-w-md text-sm text-muted">
          {state.message}
        </p>
        <button
          type="button"
          className={BUTTON_PRIMARY}
          onClick={() => {
            setState({ status: 'loading' });
            setAttempt((count) => count + 1);
          }}
        >
          Try again
        </button>
      </Splash>
    );
  }
  if (state.status === 'accounts') return <AccountApp auth={state.auth} settings={settings} apiFor={apiFor} />;
  return <Workspace api={appApi} settings={settings} account={null} />;
}

/** Shows the sign-in screen until someone is signed in, then that person's own workspace. */
function AccountApp({
  auth,
  settings,
  apiFor = createAppApi,
}: {
  auth: AuthClient;
  settings?: SettingsStore;
  apiFor?: (auth: ApiAuth) => AppApi;
}) {
  const state = useSyncExternalStore(auth.subscribe, auth.getState);
  const [ended, setEnded] = useState(false);

  if (state.status === 'loading') return <Splash />;
  if (state.status === 'signed_out' || state.status === 'recovering') {
    return (
      <div className="h-dvh">
        <AuthScreen
          key={state.status}
          auth={auth}
          recovering={state.status === 'recovering'}
          notice={ended && state.status === 'signed_out' ? 'Your session ended. Sign in again to continue.' : null}
        />
      </div>
    );
  }

  // Keyed by account: a different person starts from nothing, never from what the last one loaded.
  return (
    <SignedIn
      key={state.user.id}
      auth={auth}
      email={state.user.email}
      settings={settings}
      apiFor={apiFor}
      onSessionEnded={() => setEnded(true)}
      onSignedOut={() => setEnded(false)}
    />
  );
}

function SignedIn({
  auth,
  email,
  settings,
  apiFor,
  onSessionEnded,
  onSignedOut,
}: {
  auth: AuthClient;
  email: string | null;
  settings?: SettingsStore;
  apiFor: (auth: ApiAuth) => AppApi;
  onSessionEnded: () => void;
  onSignedOut: () => void;
}) {
  const [{ api, account }] = useState(() => ({
    api: apiFor({
      token: (options) => auth.accessToken(options),
      // The server no longer accepts this session: end it here too, and say why on the sign-in screen.
      onRejected: () => {
        onSessionEnded();
        void auth.signOut().catch(() => undefined);
      },
    }),
    account: {
      email,
      signOut: async () => {
        onSignedOut();
        await auth.signOut();
      },
    },
  }));
  return <Workspace api={api} settings={settings} account={account} />;
}

function Workspace({ api, settings, account }: { api: AppApi; settings?: SettingsStore; account: AccountControls | null }) {
  // Created once: the review session and the loaded vocabulary outlive any single page.
  const [services] = useState(() => createAppServices(api, settings, account));
  return (
    <AppProvider value={services}>
      <Root />
    </AppProvider>
  );
}

function Root() {
  const { api, session, vocabulary, account } = useApp();
  const location = useLocation();
  const route = matchRoute(location.pathname);
  const vocab = useSyncExternalStore(vocabulary.subscribe, vocabulary.getState);
  const review = useSyncExternalStore(session.subscribe, session.getState);
  const { reduceMotion } = useSettings();

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    document.title = route === null ? 'Vocabulary' : `${PAGES[route].title} · Vocabulary`;
  }, [route]);

  const reviewLocked = review.status === 'error' && review.error?.kind === 'load' && review.error.unauthorized;
  const vocabularyLocked = vocab.error?.unauthorized === true;
  // With accounts, an ended session leads back to the sign-in screen instead; there is no shared password to ask for.
  if (account === null && (reviewLocked || vocabularyLocked)) {
    return (
      <div className="h-dvh">
        <UnlockScreen
          api={api}
          onUnlocked={() => {
            if (vocabularyLocked) void vocabulary.reload();
            if (reviewLocked) void session.load();
          }}
        />
      </div>
    );
  }

  const badge = vocab.meta === null ? null : vocab.meta.mode === 'mock' ? 'Demo' : vocab.meta.writesEnabled ? null : 'Read-only';
  // On the Review tab the session's own progress is the truth, so no second count is shown there.
  const reviewCount =
    route === 'review' || vocab.status !== 'ready' ? null : vocab.entries.filter((entry) => entry.reviewable).length;
  const wordId = wordInQuery(location.query);

  return (
    <>
      <AppShell active={route} reviewCount={reviewCount} badge={badge} account={account}>
        {route === null ? (
          <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
            <h1 className="font-serif text-3xl font-semibold">Page not found</h1>
            <p className="text-muted">There is nothing at this address.</p>
            <Link to={ROUTES.dashboard} className={BUTTON_PRIMARY}>
              Go to the dashboard
            </Link>
          </div>
        ) : (
          PAGES[route].render()
        )}
      </AppShell>
      {wordId !== null && pageIdSchema.safeParse(wordId).success && (
        <WordDetailPanel key={wordId} entryId={wordId} onClose={closeWord} />
      )}
      <Toasts />
    </>
  );
}
