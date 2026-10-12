import { useEffect, useRef, type ReactNode } from 'react';
import { ROUTES, type RouteKey } from '../lib/router.js';
import { Icon, type IconName } from './Icon.js';
import { Link } from './Link.js';

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
        <div className="flex items-center gap-2 px-3 pb-4 pt-2">
          <span className="font-serif text-lg font-semibold tracking-tight">Vocabulary</span>
          {badge !== null && (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn-ink">{badge}</span>
          )}
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {PRIMARY.map(sideLink)}
          <div className="my-2 border-t border-line" />
          {SECONDARY.map(sideLink)}
        </nav>
        {account !== null && (
          <div className="flex flex-col gap-1 border-t border-line px-3 pt-3 text-xs text-muted">
            <span className="truncate" title={account.email ?? undefined}>
              {account.email ?? 'Signed in'}
            </span>
            <button
              type="button"
              className="cursor-pointer self-start font-semibold text-accent underline-offset-2 hover:underline"
              onClick={() => void account.signOut().catch(() => undefined)}
            >
              Sign out
            </button>
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

        <main ref={main} className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>

        <nav
          aria-label="Main"
          className="grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
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
