import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSync, useUiLanguage } from '../app-context.js';
import { pick } from '../lib/i18n.js';
import { ROUTES, type RouteKey } from '../lib/router.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { GoalCelebration } from './GoalCelebration.js';
import { GameWatcher, XpCard, XpChip } from './GameBar.js';
import { Icon, type IconName } from './Icon.js';
import { Link } from './Link.js';
import { Onboarding } from './Onboarding.js';
import { SyncStatus } from './SyncStatus.js';

interface NavItem {
  route: RouteKey;
  label: string;
  labelVi: string;
  /** A shorter label for the narrow bottom bar. */
  short: string;
  shortVi: string;
  icon: IconName;
}

const PRIMARY: NavItem[] = [
  { route: 'dashboard', label: 'Dashboard', labelVi: 'Tổng quan', short: 'Home', shortVi: 'Trang chủ', icon: 'dashboard' },
  { route: 'review', label: 'Review', labelVi: 'Ôn tập', short: 'Review', shortVi: 'Ôn tập', icon: 'review' },
  { route: 'add', label: 'Add vocabulary', labelVi: 'Thêm từ', short: 'Add', shortVi: 'Thêm', icon: 'add' },
  { route: 'bank', label: 'Vocabulary bank', labelVi: 'Sổ từ', short: 'Bank', shortVi: 'Sổ từ', icon: 'bank' },
  { route: 'calendar', label: 'Calendar', labelVi: 'Lịch', short: 'Calendar', shortVi: 'Lịch', icon: 'calendar' },
  { route: 'chat', label: 'AI Chat', labelVi: 'Trợ lý AI', short: 'Chat', shortVi: 'Chat', icon: 'chat' },
];

const SECONDARY: NavItem[] = [
  { route: 'league', label: 'League', labelVi: 'Giải đấu', short: 'League', shortVi: 'Giải đấu', icon: 'league' },
  { route: 'friends', label: 'Friends', labelVi: 'Bạn bè', short: 'Friends', shortVi: 'Bạn bè', icon: 'friends' },
  { route: 'practice', label: 'Practice', labelVi: 'Luyện tập', short: 'Practice', shortVi: 'Luyện tập', icon: 'practice' },
  { route: 'collections', label: 'Collections', labelVi: 'Bộ sưu tập', short: 'Collections', shortVi: 'Bộ sưu tập', icon: 'collections' },
  { route: 'weak', label: 'Weak words', labelVi: 'Từ yếu', short: 'Weak', shortVi: 'Từ yếu', icon: 'weak' },
  { route: 'insights', label: 'Insights', labelVi: 'Thống kê', short: 'Insights', shortVi: 'Thống kê', icon: 'insights' },
  { route: 'help', label: 'Help', labelVi: 'Trợ giúp', short: 'Help', shortVi: 'Trợ giúp', icon: 'help' },
  { route: 'settings', label: 'Settings', labelVi: 'Cài đặt', short: 'Settings', shortVi: 'Cài đặt', icon: 'settings' },
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
  const language = useUiLanguage();
  const navLabel = (item: NavItem) => pick(language, item.label, item.labelVi);
  const navShort = (item: NavItem) => pick(language, item.short, item.shortVi);

  // A new page starts at its top, like a full page load would.
  useEffect(() => {
    main.current?.scrollTo?.({ top: 0 });
  }, [active]);

  // Importing is part of adding vocabulary, and is reached from there.
  const section: RouteKey | null = active === 'import' ? 'add' : active;
  const currentNav = [...PRIMARY, ...SECONDARY].find((item) => item.route === active);
  const title =
    active === 'import'
      ? pick(language, 'Import', 'Nhập danh sách')
      : active === 'achievements'
        ? pick(language, 'Achievements', 'Thành tích')
        : active === 'profile'
          ? pick(language, 'Profile', 'Hồ sơ')
          : active === 'admin'
            ? pick(language, 'Moderation', 'Quản trị')
            : currentNav === undefined
        ? pick(language, 'Vocabulary', 'Từ vựng')
        : navLabel(currentNav);

  const sideLink = (item: NavItem) => {
    const current = item.route === section;
    return (
      <Link
        key={item.route}
        to={ROUTES[item.route]}
        aria-current={current ? 'page' : undefined}
        className={`relative flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm font-medium transition-colors ${
          current ? 'bg-surface text-ink' : 'text-muted hover:bg-surface/60 hover:text-ink'
        }`}
      >
        {current && (
          <span aria-hidden="true" className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
        )}
        <Icon name={item.icon} className={current ? 'size-5 text-accent' : 'size-5'} />
        <span className="flex-1">{navLabel(item)}</span>
        {item.route === 'review' && reviewCount !== null && reviewCount > 0 && (
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold tabular-nums text-on-accent">
            {reviewCount}
            <span className="sr-only"> {pick(language, 'ready to review', 'từ sẵn sàng ôn')}</span>
          </span>
        )}
      </Link>
    );
  };

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-paper p-3 md:flex">
        <div className="flex flex-wrap items-center gap-2 px-3 pb-5 pt-2">
          <span className="font-sans text-[1.0625rem] font-semibold tracking-[-0.02em] text-ink">Vocabulary</span>
          {badge !== null && (
            <span className="rounded-full border border-line-strong px-2 py-0.5 text-[0.6875rem] font-medium text-faint">
              {badge}
            </span>
          )}
          <SyncStatus />
        </div>
        <nav aria-label={pick(language, 'Main', 'Chính')} className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {PRIMARY.map(sideLink)}
          <div className="my-2 border-t border-line" />
          {SECONDARY.map(sideLink)}
        </nav>
        <XpCard />
        {account !== null && (
          <div className="flex flex-col gap-1 border-t border-line px-3 pt-3 text-xs text-faint">
            <span className="truncate" title={account.email ?? undefined}>
              {account.email ?? pick(language, 'Signed in', 'Đã đăng nhập')}
            </span>
            <SignOut account={account} />
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:hidden">
          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            <h1 title={title} className="truncate text-[0.9375rem] font-semibold tracking-[-0.01em]">{title}</h1>
            {badge !== null && (
              <span className="shrink-0 rounded-full border border-line-strong px-1 py-0.5 text-[0.6875rem] font-medium text-faint sm:px-2">
                {badge}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <SyncStatus />
            <XpChip />
            {SECONDARY.map((item) => (
              <Link
                key={item.route}
                to={ROUTES[item.route]}
                aria-label={navLabel(item)}
                aria-current={item.route === active ? 'page' : undefined}
                className={`flex size-9 items-center justify-center rounded-[10px] ${
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
          aria-label={pick(language, 'Main', 'Chính')}
          className="grid grid-cols-6 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {PRIMARY.map((item) => {
            const current = item.route === section;
            return (
              <Link
                key={item.route}
                to={ROUTES[item.route]}
                aria-current={current ? 'page' : undefined}
                aria-label={navLabel(item)}
                className={`relative flex h-14 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium ${
                  current ? 'text-accent' : 'text-muted'
                }`}
              >
                <Icon name={item.icon} />
                <span>{navShort(item)}</span>
                {item.route === 'review' && reviewCount !== null && reviewCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute right-[calc(50%-1.4rem)] top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[0.625rem] font-semibold leading-4 tabular-nums text-on-accent"
                  >
                    {reviewCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>
      <Onboarding />
      <GameWatcher />
      <GoalCelebration />
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
