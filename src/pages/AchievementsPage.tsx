/**
 * Everything the game keeps for the account (docs/gamification-plan.md,
 * phase 1): the level, the week's check-in, streak freezes, today's and this
 * week's quests, and every badge with the way to its next tier.
 */
import { useState } from 'react';
import type { GameResponse } from '../../shared/api.js';
import { BADGES } from '../../shared/gamification/badges.js';
import { CHECKIN_XP } from '../../shared/gamification/streak.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { Icon } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_PRIMARY, CARD, HELP, PAGE, SECTION_TITLE } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';
import { ProgressBar, QuestRow } from '../components/Quests.js';
import { adoptGame, useGame } from '../lib/game-state.js';
import { badgeMeasure, badgeName, tierName } from '../lib/game-text.js';
import { pick, type UiLanguage } from '../lib/i18n.js';

function Level({ game, language }: { game: GameResponse; language: UiLanguage }) {
  const { level, into, needed } = game.level;
  return (
    <section className={`${CARD} pool pool-top flex items-center gap-4 p-5 sm:gap-8 sm:p-6`}>
      <div className="flex size-20 shrink-0 flex-col items-center justify-center rounded-full border-2 border-accent/60 bg-paper/60 sm:size-24">
        <span className="text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-faint">Level</span>
        <span className="font-serif text-4xl font-semibold tabular-nums leading-none text-ink">{level}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm text-muted">
          {pick(language, `${needed - into} XP to level ${level + 1}`, `Còn ${needed - into} XP để lên level ${level + 1}`)}
        </p>
        <ProgressBar share={needed === 0 ? 0 : into / needed} />
        <p className={`${HELP} tabular-nums`}>
          {pick(language, `${game.totalXp.toLocaleString('en')} XP in all`, `Tổng ${game.totalXp.toLocaleString('vi')} XP`)} ·{' '}
          {pick(language, `longest combo ${game.combo.longest}`, `combo dài nhất ${game.combo.longest}`)}
        </p>
        {game.dailyXp !== undefined && (
          <p className={`${HELP} tabular-nums`}>
            {pick(
              language,
              `Today’s XP limit: reviews ${game.dailyXp.review.earned.toLocaleString('en')}/${game.dailyXp.review.cap.toLocaleString('en')} · practice ${game.dailyXp.practice.earned.toLocaleString('en')}/${game.dailyXp.practice.cap.toLocaleString('en')}`,
              `Giới hạn XP hôm nay: ôn ${game.dailyXp.review.earned.toLocaleString('vi')}/${game.dailyXp.review.cap.toLocaleString('vi')} · luyện tập ${game.dailyXp.practice.earned.toLocaleString('vi')}/${game.dailyXp.practice.cap.toLocaleString('vi')}`,
            )}
          </p>
        )}
        {game.comebackUntil !== null && (
          <p className="text-xs font-semibold text-warn-ink">
            {pick(language, 'Double XP: welcome back.', 'Nhân đôi XP: chào mừng trở lại.')}
          </p>
        )}
      </div>
    </section>
  );
}

function Checkin({ game, language }: { game: GameResponse; language: UiLanguage }) {
  const doneToday = game.checkin.lastOn === game.today;
  return (
    <section className={`${CARD} p-5`}>
      <h2 className={SECTION_TITLE}>{pick(language, 'Seven-day check-in', 'Điểm danh 7 ngày')}</h2>
      <p className={`${HELP} mt-1`}>
        {pick(
          language,
          'Study at least once a day. Missing a day starts the week again.',
          'Học ít nhất một lượt mỗi ngày. Lỡ một ngày thì bắt đầu lại từ ngày 1.',
        )}
      </p>
      <ol className="mt-4 grid grid-cols-7 gap-1.5">
        {CHECKIN_XP.map((xp, at) => {
          const day = at + 1;
          const reached = day <= game.checkin.day;
          const today = doneToday ? day === game.checkin.day : day === game.checkin.day + 1;
          return (
            <li
              key={day}
              aria-label={pick(language, `Day ${day}: ${xp} XP${reached ? ', done' : ''}`, `Ngày ${day}: ${xp} XP${reached ? ', đã xong' : ''}`)}
              className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-center ${
                reached ? 'border-accent/50 bg-accent-soft' : today ? 'border-line-strong' : 'border-line'
              }`}
            >
              <span className="text-[0.625rem] font-medium uppercase tracking-wider text-faint">{day}</span>
              <span className={`text-xs font-semibold tabular-nums ${reached ? 'text-accent' : 'text-muted'}`}>+{xp}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Freezes({ game, language }: { game: GameResponse; language: UiLanguage }) {
  return (
    <section className={`${CARD} flex items-center gap-4 p-5`}>
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Icon name="snow" className="size-5" />
      </span>
      <div className="min-w-0">
        <h2 className={SECTION_TITLE}>
          {pick(language, `Streak freezes: ${game.freezes.held} of ${game.freezes.max}`, `Đóng băng streak: ${game.freezes.held}/${game.freezes.max}`)}
        </h2>
        <p className={`${HELP} mt-1`}>
          {pick(
            language,
            'One is given for every 7 days of streak. A missed day uses one, so the streak carries on.',
            'Cứ mỗi 7 ngày streak được tặng một. Lỡ một ngày sẽ tự dùng một cái để giữ chuỗi.',
          )}
        </p>
      </div>
    </section>
  );
}

function Badges({ game, language }: { game: GameResponse; language: UiLanguage }) {
  const held = new Map<string, number>();
  for (const badge of game.badges) held.set(badge.badge, Math.max(held.get(badge.badge) ?? 0, badge.tier));
  return (
    <section className={`${CARD} p-5`}>
      <h2 className={SECTION_TITLE}>{pick(language, 'Badges', 'Huy hiệu')}</h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {BADGES.map((badge) => {
          const tier = held.get(badge.id) ?? 0;
          const value = game.badgeValues[badge.id] ?? 0;
          const next = badge.tiers[tier];
          const previous = tier === 0 ? 0 : badge.tiers[tier - 1]!;
          return (
            <li key={badge.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-3">
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-full ${
                  tier > 0 ? 'bg-accent-soft text-accent' : 'bg-line/60 text-faint'
                }`}
              >
                <Icon name="trophy" className="size-5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-ink">{badgeName(language, badge.id)}</span>
                  <span className="shrink-0 text-[0.6875rem] font-medium text-faint">
                    {tier === 0 ? pick(language, 'Not yet', 'Chưa có') : tierName(language, tier)}
                  </span>
                </span>
                {next === undefined ? (
                  <span className="text-xs font-semibold text-good-ink">{pick(language, 'Every tier earned', 'Đã đạt mọi bậc')}</span>
                ) : (
                  <>
                    <span className="text-xs text-muted">
                      {pick(language, 'Next: ', 'Tiếp theo: ')}
                      {badgeMeasure(language, badge.id, next)} · <span className="tabular-nums">{Math.min(value, next)}/{next}</span>
                    </span>
                    <ProgressBar share={(value - previous) / (next - previous)} />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AchievementsPage() {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const game = useGame(api);
  const [claiming, setClaiming] = useState(false);

  const claimAll = async () => {
    setClaiming(true);
    try {
      adoptGame(api, await api.claimGameRewards('all'));
      toasts.show({ message: pick(language, 'Rewards claimed.', 'Đã nhận phần thưởng.') });
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'Could not claim the rewards.', 'Không nhận được phần thưởng.'),
      });
    } finally {
      setClaiming(false);
    }
  };

  const data = game.data;
  return (
    <div className={`${PAGE} mx-auto max-w-3xl`}>
      <PageHeader
        title={pick(language, 'Achievements', 'Thành tích')}
        description={pick(language, 'Your level, quests, check-in and badges.', 'Level, nhiệm vụ, điểm danh và huy hiệu của bạn.')}
        actions={
          data !== null && data.rewards.length > 0 ? (
            <button type="button" className={BUTTON_PRIMARY} disabled={claiming} onClick={() => void claimAll()}>
              {claiming && <Spinner />}
              {pick(language, `Claim ${data.rewards.length} ${data.rewards.length === 1 ? 'reward' : 'rewards'}`, `Nhận ${data.rewards.length} phần thưởng`)}
            </button>
          ) : null
        }
      />

      <div className="mt-6 flex flex-col gap-5">
        {data === null ? (
          game.status === 'error' ? (
            <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
              {game.error}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> {pick(language, 'Loading…', 'Đang tải…')}
            </p>
          )
        ) : !data.available ? (
          <p className={`${CARD} p-5 text-sm text-muted`}>{data.reason}</p>
        ) : (
          <>
            <Level game={data} language={language} />
            <section className={`${CARD} p-5`}>
              <h2 className={SECTION_TITLE}>{pick(language, 'Today’s quests', 'Nhiệm vụ hôm nay')}</h2>
              <ul className="mt-4 flex flex-col gap-4">
                {data.quests.day.map((quest) => (
                  <QuestRow key={quest.kind} quest={quest} language={language} />
                ))}
              </ul>
              {data.quests.week !== null && (
                <>
                  <h3 className="mt-6 text-xs font-semibold uppercase tracking-[0.14em] text-faint">
                    {pick(language, 'This week', 'Tuần này')}
                  </h3>
                  <ul className="mt-3 flex flex-col gap-4">
                    <QuestRow quest={data.quests.week} language={language} />
                  </ul>
                </>
              )}
            </section>
            <Checkin game={data} language={language} />
            <Freezes game={data} language={language} />
            <Badges game={data} language={language} />
          </>
        )}
      </div>
    </div>
  );
}
