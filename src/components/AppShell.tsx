import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSync } from '../app-context.js';
import { ROUTES, type RouteKey } from '../lib/router.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon, type IconName } from './Icon.js';
import { Link } from './Link.js';
import { SyncStatus } from './SyncStatus.js';

interface NavItem {
  route: RouteKey;
  label: string;
  /** A shorter label for the narrow bottom bar. */
  short: string;
  icon: IconName;
}

const PRIMARY: NavItem[] = [
  { route: 'dashboard', label: 'Dashboard', short: 'Home', icon: 'dashboard' },
  { route: 'review', label: 'Review', short: 'Review', icon: 'review' },
  { route: 'add', label: 'Add vocabulary', short: 'Add', icon: 'add' },
  { route: 'bank', label: 'Vocabulary bank', short: 'Bank', icon: 'bank' },
  { route: 'calendar', label: 'Calendar', short: 'Calendar', icon: 'calendar' },
  { route: 'chat', label: 'AI Chat', short: 'Chat', icon: 'chat' },
];

const SECONDARY: NavItem[] = [
  { route: 'practice', label: 'Practice', short: 'Practice', icon: 'practice' },
  { route: 'collections', label: 'Collections', short: 'Collections', icon: 'collections' },
  { route: 'weak', label: 'Weak words', short: 'Weak', icon: 'weak' },
  { route: 'insights', label: 'Insights', short: 'Insights', icon: 'insights' },
  { route: 'settings', label: 'Settings', short: 'Settings', icon: 'settings' },
];

export interface AppShellProps {
  /** The page being shown; `null` for an unknown address. */
  active: RouteKey | null;
  /** How many words are ready to review, shown beside the Review item when known. */
  reviewCount: number | null;
  /** A short status label such as "Sample data" or "Read-only". */
  badge: string | null;
  /** The signed-in account, where the app has accounts. */
  account?: { email: string | null; signOut(): Promise<void> } | null;
  children: ReactNode;
}

export function AppShell({ active, reviewCount, badge, account = null, children }: AppShellProps) {
  const main = useRef<HTMLElement>(null);

  // A new page starts at its top, like a full page load would.
  useEffect(() => {
    main.current?.scrollTo?.({ top: 0 });
  }, [active]);

  // Importing is part of adding vocabulary, and is reached from there.
  const section: RouteKey | null = active === 'import' ? 'add' : active;
  const title =
    active === 'import' ? 'Import' : ([...PRIMARY, ...SECONDARY].find((item) => item.route === active)?.label ?? 'Vocabulary');

  const sideLink = (item: NavItem) => {
    const current = item.route === section;
    return (
      <Link
        key={item.route}
        to={ROUTES[item.route]}
        aria-current={current ? 'page' : undefined}
        className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${
          current ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-line/40 hover:text-ink'
        }`}
      >
        <Icon name={item.icon} />
        <span className="flex-1">{item.label}</span>
        {item.route === 'review' && reviewCount !== null && reviewCount > 0 && (
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold tabular-nums text-white dark:text-paper">
            {reviewCount}
            <span className="sr-only"> ready to review</span>
          </span>
        )}
      </Link>
    );
  };

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface/50 p-3 md:flex">
        <div className="flex flex-wrap items-center gap-2 px-3 pb-4 pt-2">
          <span className="font-serif text-lg font-semibold tracking-tight">Vocabulary</span>
          {badge !== null && (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn-ink">{badge}</span>
          )}
          <SyncStatus />
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {PRIMARY.map(sideLink)}
          <div className="my-2 border-t border-line" />
          {SECONDARY.map(sideLink)}
        </nav>
        {account !== null && (
          <div className="flex flex-col gap-1 border-t border-line px-3 pt-3 text-xs text-muted">
            <span className="truncate" title={account.email ?? undefined}>
              {account.email ?? 'Signed in'}
            </span>
            <SignOut account={account} />
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
            {badge !== null && (
              <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn-ink">
                {badge}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <SyncStatus />
            {SECONDARY.map((item) => (
              <Link
                key={item.route}
                to={ROUTES[item.route]}
                aria-label={item.label}
                aria-current={item.route === active ? 'page' : undefined}
                className={`flex size-9 items-center justify-center rounded-xl ${
                  item.route === active ? 'bg-accent-soft text-accent' : 'text-muted'
                }`}
              >
                <Icon name={item.icon} />
              </Link>
            ))}
          </div>
        </header>

        {/*
          The main content area owns vertical scrolling. It uses `min-h-0` to allow
          shrinking below its content size, `flex-1` to fill available space, and
          `overflow-y-auto` to scroll when content overflows. The `relative` class
          creates a containing block for absolutely positioned descendants (like
          the `.sr-only` live region) so they stay clipped within the scroll area.
          Fixed-position overlays (WordDetailPanel, ConfirmDialog) are unaffected
          because they are positioned relative to the viewport, not this container.
        */}
        <main ref={main} className="relative min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>

        <nav
          aria-label="Main"
          className="grid grid-cols-6 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {PRIMARY.map((item) => {
            const current = item.route === section;
            return (
              <Link
                key={item.route}
                to={ROUTES[item.route]}
                aria-current={current ? 'page' : undefined}
                aria-label={item.label}
                className={`relative flex h-14 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium ${
                  current ? 'text-accent' : 'text-muted'
                }`}
              >
                <Icon name={item.icon} />
                <span>{item.short}</span>
                {item.route === 'review' && reviewCount !== null && reviewCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute right-[calc(50%-1.4rem)] top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[0.625rem] font-semibold leading-4 tabular-nums text-white dark:text-paper"
                  >
                    {reviewCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/**
 * Signing out is safe for anything already sent, but it leaves the outbox
 * behind: changes still waiting would go next time this account signs in on
 * this device, and ones the server refused would wait for a decision that can
 * only be made while signed in. So unsent work asks first.
 */
function SignOut({ account }: { account: NonNullable<AppShellProps['account']> }) {
  const { pending, refused } = useSync();
  const [asking, setAsking] = useState(false);
  const outstanding = pending + refused;
  const signOut = () => void account.signOut().catch(() => undefined);

  return (
    <>
      <button
        type="button"
        className="cursor-pointer self-start font-semibold text-accent underline-offset-2 hover:underline"
        onClick={() => (outstanding === 0 ? signOut() : setAsking(true))}
      >
        Sign out
      </button>
      {asking && (
        <ConfirmDialog
          title="Sign out with unsent changes?"
          confirmLabel="Sign out anyway"
          onConfirm={signOut}
          onCancel={() => setAsking(false)}
        >
          <p>
            {outstanding === 1 ? 'One change has' : `${outstanding} changes have`} not reached the server. They stay on
            this device, under this account, and are sent the next time you sign in here as the same person. Anything the
            server refused waits for a retry or a dismissal, which you can only give while signed in.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
