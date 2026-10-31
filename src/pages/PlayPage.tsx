/**
 * The game in one place: a tile for each part, with where it stands now, so
 * the menu needs one entry for all of it.
 */
import type { ReactNode } from 'react';
import { useApp, useUiLanguage } from '../app-context.js';
import { PetArt } from '../components/Collectibles.js';
import { Icon, type IconName } from '../components/Icon.js';
import { TierBadge, standing } from '../components/League.js';
import { Link } from '../components/Link.js';
import { ProgressBar } from '../components/Quests.js';
import { CARD, PAGE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { useGame } from '../lib/game-state.js';
import { pick } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';

function Tile({
  to,
  icon,
  title,
  detail,
  children,
  wide = false,
}: {
  to: string;
  icon: IconName;
  title: string;
  detail: string;
  children?: ReactNode;
  wide?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`${CARD} flex min-h-28 flex-col gap-2 p-4 transition-colors hover:border-line-strong active:bg-line/20 ${wide ? 'col-span-2' : ''}`}
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon name={icon} className="size-5 text-accent" />
        {title}
      </span>
      <span className="text-xs leading-snug text-muted">{detail}</span>
      {children}
    </Link>
  );
}

export function PlayPage() {
  const { api } = useApp();
  const language = useUiLanguage();
  const { data: game } = useGame(api);
  const league = useRemote(api.fetchLeague, 'Could not load the league.');

  const ready = game !== null && game.available;
  const quests = ready ? [...game.quests.day, ...(game.quests.week === null ? [] : [game.quests.week])] : [];
  const done = quests.filter((quest) => quest.completed).length;
  const economy = ready ? (game.economy ?? null) : null;
  const lead = economy?.pets[0];
  const leagueData = league.status === 'ready' && league.data.available ? league.data : null;

  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      {ready && (
        <section className={`${CARD} pool pool-top mb-4 flex items-center gap-4 p-4`}>
          <span className="flex size-14 shrink-0 flex-col items-center justify-center rounded-full border-2 border-accent/60">
            <span className="text-[0.5625rem] font-semibold uppercase tracking-[0.16em] text-faint">Level</span>
            <span className="font-serif text-2xl font-semibold leading-none text-ink">{game.level.level}</span>
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-sm text-muted">
              {pick(
                language,
                `${game.level.needed - game.level.into} XP to level ${game.level.level + 1}`,
                `Còn ${game.level.needed - game.level.into} XP để lên level ${game.level.level + 1}`,
              )}
            </span>
            <ProgressBar share={game.level.needed === 0 ? 0 : game.level.into / game.level.needed} />
          </span>
          {economy != null && (
            <Link
              to={ROUTES.shop}
              className="flex shrink-0 items-center gap-1 rounded-full border border-line px-3 py-1.5 text-sm font-semibold tabular-nums text-ink"
            >
              <Icon name="star" className="size-4 text-[#f0c75e]" />
              {economy.stardust.toLocaleString(language)}
            </Link>
          )}
        </section>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Tile to={ROUTES.pvp} icon="sword" title={pick(language, 'Word duels', 'Đấu từ vựng')} detail={pick(language, 'Two minutes against another player', 'Hai phút đối đầu người khác')} wide />
        <Tile
          to={ROUTES.achievements}
          icon="trophy"
          title={pick(language, 'Quests', 'Nhiệm vụ')}
          detail={
            ready && game.rewards.length > 0
              ? pick(language, `${game.rewards.length} rewards to claim`, `${game.rewards.length} phần thưởng chờ nhận`)
              : pick(language, `${done} of ${quests.length} done`, `Xong ${done}/${quests.length}`)
          }
        >
          {quests.length > 0 && <ProgressBar share={done / quests.length} />}
        </Tile>
        <Tile
          to={ROUTES.league}
          icon="league"
          title={pick(language, 'League', 'Giải đấu')}
          detail={
            leagueData === null
              ? pick(language, 'Weekly ranking', 'Xếp hạng tuần')
              : (standing(language, leagueData) ?? pick(language, 'Earn XP to join', 'Kiếm XP để vào nhóm'))
          }
        >
          {leagueData !== null && <TierBadge tier={leagueData.group?.tier ?? leagueData.tier} className="self-start" />}
        </Tile>
        <Tile
          to={ROUTES.collection}
          icon="pet"
          title={pick(language, 'Companions', 'Linh vật')}
          detail={
            lead === undefined
              ? pick(language, 'Choose your first one', 'Chọn con đầu tiên')
              : pick(language, 'Grows as you study', 'Lớn lên khi bạn học')
          }
        >
          {lead !== undefined && <PetArt id={lead.id} form={lead.form} mood={lead.mood} className="size-12 self-start" />}
        </Tile>
        <Tile
          to={ROUTES.shop}
          icon="shop"
          title={pick(language, 'Shop', 'Cửa hàng')}
          detail={pick(language, 'Four new items every day', 'Mỗi ngày bốn món mới')}
        />
        <Tile
          to={ROUTES.boss}
          icon="sword"
          title={pick(language, 'Weekly boss', 'Boss tuần')}
          detail={pick(language, 'Your weakest words, as one foe', 'Những từ hay quên nhất')}
        />
        <Tile
          to={ROUTES.friends}
          icon="friends"
          title={pick(language, 'Friends', 'Bạn bè')}
          detail={pick(language, 'Streaks together, challenges', 'Chuỗi chung, thách đấu')}
        />
      </div>
    </div>
  );
}
