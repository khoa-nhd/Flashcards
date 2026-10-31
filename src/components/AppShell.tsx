import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

const item = (route: RouteKey, label: string, labelVi: string, short: string, shortVi: string, icon: IconName): NavItem => ({
  route,
  label,
  labelVi,
  short,
  shortVi,
  icon,
});

const DASHBOARD = item('dashboard', 'Dashboard', 'Tổng quan', 'Home', 'Trang chủ', 'dashboard');
const REVIEW = item('review', 'Review', 'Ôn tập', 'Review', 'Ôn tập', 'review');
const ADD = item('add', 'Add vocabulary', 'Thêm từ', 'Add', 'Thêm', 'add');
const BANK = item('bank', 'Vocabulary bank', 'Sổ từ', 'Words', 'Sổ từ', 'bank');
const PLAY = item('play', 'Play', 'Chơi', 'Play', 'Chơi', 'star');

/** The pages, in three groups, so the menu reads as a few choices rather than eighteen. */
const GROUPS: Array<{ id: 'study' | 'play' | 'more'; label: string; labelVi: string; items: NavItem[] }> = [
  {
    id: 'study',
    label: 'Study',
    labelVi: 'Học',
    items: [
      DASHBOARD,
      REVIEW,
      ADD,
      BANK,
      item('practice', 'Practice', 'Luyện tập', 'Practice', 'Luyện tập', 'practice'),
      item('weak', 'Weak words', 'Từ yếu', 'Weak', 'Từ yếu', 'weak'),
      item('calendar', 'Calendar', 'Lịch', 'Calendar', 'Lịch', 'calendar'),
      item('collections', 'Collections', 'Bộ sưu tập', 'Collections', 'Bộ sưu tập', 'collections'),
      item('chat', 'AI Chat', 'Trợ lý AI', 'Chat', 'Chat', 'chat'),
    ],
  },
  {
    id: 'play',
    label: 'Play',
    labelVi: 'Chơi',
    items: [
      item('achievements', 'Level and quests', 'Level và nhiệm vụ', 'Quests', 'Nhiệm vụ', 'trophy'),
      item('pvp', 'Word duels', 'Đấu từ vựng', 'Duels', 'Đấu', 'duel'),
      item('league', 'League', 'Giải đấu', 'League', 'Giải đấu', 'league'),
      item('friends', 'Friends', 'Bạn bè', 'Friends', 'Bạn bè', 'friends'),
      item('shop', 'Shop', 'Cửa hàng', 'Shop', 'Cửa hàng', 'shop'),
      item('collection', 'Companions & cards', 'Kho đồ', 'Items', 'Kho đồ', 'pet'),
      item('boss', 'Weekly boss', 'Boss tuần', 'Boss', 'Boss', 'sword'),
    ],
  },
  {
    id: 'more',
    label: 'More',
    labelVi: 'Khác',
    items: [
      item('insights', 'Insights', 'Thống kê', 'Insights', 'Thống kê', 'insights'),
      item('profile', 'Profile', 'Hồ sơ', 'Profile', 'Hồ sơ', 'user'),
      item('settings', 'Settings', 'Cài đặt', 'Settings', 'Cài đặt', 'settings'),
      item('help', 'Help', 'Trợ giúp', 'Help', 'Trợ giúp', 'help'),
    ],
  },
];

const ALL_ITEMS = [PLAY, ...GROUPS.flatMap((group) => group.items)];
const groupOf = (route: RouteKey | null) => GROUPS.find((group) => group.items.some((each) => each.route === route))?.id ?? null;

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

/**
 * The phone's "More" sheet: every page not in the bottom bar, in its group,
 * as large tiles. It closes on a choice, a tap outside, or Escape.
 */
function MoreSheet({
  openedAt,
  active,
  label,
  onClose,
}: {
  /** When the sheet was opened; `null` while it is closed. */
  openedAt: number | null;
  active: RouteKey | null;
  label: (item: NavItem) => string;
  onClose: () => void;
}) {
  const language = useUiLanguage();
  const open = openedAt !== null;
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, onClose]);
  if (!open) return null;
  // What the bottom bar already shows is left out.
  const shown = new Set<RouteKey>(['dashboard', 'review', 'bank']);
  return (
    <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label={pick(language, 'More pages', 'Thêm trang')}>
      <button
        type="button"
        aria-label={pick(language, 'Close', 'Đóng')}
        className="absolute inset-0 bg-scrim"
        onClick={() => {
          // The tap that opened the sheet can arrive a second time, on this backdrop that appeared under the finger.
          if (openedAt !== null && Date.now() - openedAt > 400) onClose();
        }}
      />
      <div className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-3xl border-t border-line bg-surface px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" aria-hidden="true" />
        {GROUPS.filter((group) => group.id !== 'play').map((group) => {
          const items = group.items.filter((each) => !shown.has(each.route));
          return (
            <section key={group.id} className="mb-4">
              <h2 className="mb-2 px-1 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-faint">
                {group.id === 'study' ? pick(language, 'Study tools', 'Công cụ học') : pick(language, 'You', 'Bạn')}
              </h2>
              <ul className="grid grid-cols-3 gap-2">
                {items.map((each) => {
                  const current = each.route === active;
                  return (
                    <li key={each.route}>
                      <Link
                        to={ROUTES[each.route]}
                        aria-current={current ? 'page' : undefined}
                        onClick={onClose}
                        className={`flex h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border px-1 text-center text-xs font-medium ${
                          current ? 'border-accent/50 bg-accent-soft text-ink' : 'border-line text-muted active:bg-line/30'
                        }`}
                      >
                        <Icon name={each.icon} className={current ? 'size-6 text-accent' : 'size-6'} />
                        <span className="leading-tight">{label(each)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
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
  const currentNav = ALL_ITEMS.find((each) => each.route === active);
  const [moreOpenedAt, setMoreOpenedAt] = useState<number | null>(null);
  const moreOpen = moreOpenedAt !== null;
  const closeMore = useCallback(() => setMoreOpenedAt(null), [setMoreOpenedAt]);
  const group = groupOf(section);
  const title =
    active === 'import'
      ? pick(language, 'Import', 'Nhập danh sách')
      : active === 'admin'
        ? pick(language, 'Moderation', 'Quản trị')
        : currentNav === undefined
          ? pick(language, 'Vocabulary', 'Từ vựng')
          : navLabel(currentNav);

  const sideLink = (item: NavItem) => {
    // Every game page sits under Play, which the hub links to.
    const current = item.route === 'play' ? section === 'play' || group === 'play' : item.route === section;
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
        <nav aria-label={pick(language, 'Main', 'Chính')} className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {GROUPS.map((each) => (
            <div key={each.id} className="flex flex-col gap-0.5 pb-3">
              <span className="px-3 pb-1 pt-1 text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-faint">
                {pick(language, each.label, each.labelVi)}
              </span>
              {each.id === 'play' ? sideLink(PLAY) : each.items.map(sideLink)}
            </div>
          ))}
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
          className="grid grid-cols-5 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {[DASHBOARD, REVIEW, BANK, PLAY].map((each) => {
            const current = each.route === 'play' ? section === 'play' || group === 'play' : each.route === section;
            return (
              <Link
                key={each.route}
                to={ROUTES[each.route]}
                aria-current={current ? 'page' : undefined}
                aria-label={navLabel(each)}
                className={`relative flex h-14 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium ${
                  current ? 'text-accent' : 'text-muted'
                }`}
              >
                <Icon name={each.icon} />
                <span>{navShort(each)}</span>
                {each.route === 'review' && reviewCount !== null && reviewCount > 0 && (
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
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            onClick={() => setMoreOpenedAt(Date.now())}
            className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium ${
              moreOpen || (section !== 'dashboard' && section !== 'review' && section !== 'bank' && group !== 'play' && section !== 'play')
                ? 'text-accent'
                : 'text-muted'
            }`}
          >
            <Icon name="list" />
            <span>{pick(language, 'More', 'Thêm')}</span>
          </button>
        </nav>
        <MoreSheet openedAt={moreOpenedAt} active={active} label={navLabel} onClose={closeMore} />
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
