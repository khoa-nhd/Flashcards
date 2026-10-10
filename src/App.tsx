import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { pageIdSchema } from '../shared/api.js';
import { AppProvider, createAppServices, useApp, useSettings } from './app-context.js';
import { AppShell } from './components/AppShell.js';
import { Link } from './components/Link.js';
import { Toasts } from './components/Toasts.js';
import { UnlockScreen } from './components/UnlockScreen.js';
import { WordDetailPanel } from './components/WordDetailPanel.js';
import { BUTTON_PRIMARY } from './components/ui.js';
import { appApi, type AppApi } from './lib/api-client.js';
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

export function App({ api = appApi, settings }: { api?: AppApi; settings?: SettingsStore }) {
  // Created once: the review session and the loaded vocabulary outlive any single page.
  const [services] = useState(() => createAppServices(api, settings));
  return (
    <AppProvider value={services}>
      <Root />
    </AppProvider>
  );
}

function Root() {
  const { api, session, vocabulary } = useApp();
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
  if (reviewLocked || vocabularyLocked) {
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
      <AppShell active={route} reviewCount={reviewCount} badge={badge}>
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
