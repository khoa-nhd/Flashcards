/**
 * Pieces the league, friends and profile pages share (docs/gamification-plan.md,
 * phase 2), and the league card on the Dashboard.
 */
import type { LeagueResponse } from '../../shared/api.js';
import { MOVING, TIERS } from '../../shared/gamification/league.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { useRemote } from '../hooks/useRemote.js';
import { leagueName } from '../lib/game-text.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';
import { Icon } from './Icon.js';
import { Link } from './Link.js';
import { CARD, HELP } from './ui.js';

/** Each league's colour, from Bronze's warm brown up to Star's pale gold, light enough to read on the night background. */
const TIER_TONE = [
  'bg-[#b07a4a]/15 text-[#e6b285] border-[#b07a4a]/45',
  'bg-[#9aa4ae]/15 text-[#ccd4dc] border-[#9aa4ae]/45',
  'bg-[#d4a72c]/15 text-[#f0c75e] border-[#d4a72c]/45',
  'bg-[#7fb5c9]/15 text-[#a8dcec] border-[#7fb5c9]/45',
  'bg-[#3fa37d]/15 text-[#86dcb6] border-[#3fa37d]/45',
  'bg-[#7c9cf0]/15 text-[#b3c6ff] border-[#7c9cf0]/45',
  'bg-[#a99be8]/15 text-[#cfc5ff] border-[#a99be8]/45',
  'bg-[#f0d36a]/15 text-[#f7e08c] border-[#f0d36a]/50',
] as const;

export function TierBadge({ tier, className = '' }: { tier: number; className?: string }) {
  const language = useUiLanguage();
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold ${TIER_TONE[Math.min(TIERS, Math.max(1, tier)) - 1]} ${className}`}
    >
      <Icon name="league" className="size-3.5" />
      {leagueName(language, tier)}
    </span>
  );
}

/** How long until a moment, in days and hours, or hours and minutes when close. */
export function timeLeft(language: UiLanguage, until: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((Date.parse(until) - now) / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  if (days > 0) return pick(language, `${days}d ${hours}h left`, `Còn ${days} ngày ${hours} giờ`);
  return pick(language, `${hours}h ${minutes % 60}m left`, `Còn ${hours} giờ ${minutes % 60} phút`);
}

/** What a refused nickname needs, in a sentence. */
export function nicknameProblemText(language: UiLanguage, problem: string | null): string {
  switch (problem) {
    case 'length':
      return pick(language, 'A nickname is 3 to 20 characters.', 'Biệt danh dài 3 đến 20 ký tự.');
    case 'characters':
      return pick(language, 'Use letters, digits, spaces and _ only.', 'Chỉ dùng chữ, số, khoảng trắng và dấu _.');
    case 'blocked':
      return pick(language, 'That nickname is not allowed. Try another.', 'Biệt danh này không được phép. Hãy chọn tên khác.');
    case 'taken':
      return pick(language, 'Someone already has that nickname.', 'Đã có người dùng biệt danh này.');
    default:
      return pick(language, 'That nickname cannot be used.', 'Không dùng được biệt danh này.');
  }
}

/** Where the account stands in its group, and what it takes to reach the zone above. */
export function standing(language: UiLanguage, league: LeagueResponse): string | null {
  const rows = league.group?.rows ?? [];
  const me = rows.find((row) => row.me);
  if (me === undefined) return null;
  if (me.zone === 'up') return pick(language, `#${me.rank} · in the promotion zone`, `Hạng ${me.rank} · đang trong vùng lên hạng`);
  const line = rows[MOVING - 1];
  if (line === undefined || league.tier >= TIERS) return pick(language, `#${me.rank} in your league`, `Hạng ${me.rank} trong nhóm`);
  const gap = line.xp - me.xp + 1;
  return pick(language, `#${me.rank} · ${gap} XP to the promotion zone`, `Hạng ${me.rank} · còn ${gap} XP để vào vùng lên hạng`);
}

/** The Dashboard's league line: the account's rank and what it takes to go up. Hidden where leagues are not kept. */
export function LeagueCard() {
  const { api } = useApp();
  const language = useUiLanguage();
  const league = useRemote(api.fetchLeague, 'Could not load the league.');
  if (league.status !== 'ready' || !league.data.available || !league.data.inLeagues) return null;
  const data = league.data;
  const line = standing(language, data);
  return (
    <Link to={ROUTES.league} className={`${CARD} flex items-center gap-4 p-4 transition-colors hover:border-line-strong`}>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Icon name="league" className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
          {pick(language, 'Weekly league', 'Giải đấu tuần')} <TierBadge tier={data.group?.tier ?? data.tier} />
        </span>
        <span className={HELP}>
          {line ?? pick(language, 'Earn XP this week to join a league of 20.', 'Kiếm XP trong tuần này để vào một nhóm 20 người.')} ·{' '}
          {timeLeft(language, data.endsAt)}
        </span>
      </span>
      <Icon name="right" className="size-4 shrink-0 text-faint" />
    </Link>
  );
}
