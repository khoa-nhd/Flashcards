/**
 * The game's small, always-there pieces (docs/gamification-plan.md, phase 1):
 * the level beside the navigation, the XP each answer earns floating up by the
 * card, and the listener that keeps both current from the answers' replies.
 */
import { useTheme } from './Collectibles.js';
import { useEffect, useRef, useState } from 'react';
import type { AnswerGame } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { applyAnswer, subscribeEarned, useGame } from '../lib/game-state.js';
import { pick } from '../lib/i18n.js';
import { ROUTES } from '../lib/router.js';
import { Icon } from './Icon.js';
import { Link } from './Link.js';

/**
 * Brings the game forward with every saved answer's reply. Answers travel
 * through the outbox, so their replies arrive as its "settled" events.
 */
export function GameWatcher() {
  const { api, sync } = useApp();
  const game = useGame(api);
  useTheme(game.data?.economy?.theme);
  useEffect(
    () =>
      sync.subscribeEvents((event) => {
        if (event.type !== 'settled') return;
        if (event.op.kind !== 'review_action' && event.op.kind !== 'practice') return;
        const game = (event.value as { game?: AnswerGame } | undefined)?.game;
        if (game !== undefined) applyAnswer(api, game);
      }),
    [api, sync],
  );
  return null;
}

function ProgressBar({ into, needed }: { into: number; needed: number }) {
  const share = needed <= 0 ? 0 : Math.min(1, into / needed);
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
      <span
        className="block h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${Math.round(share * 100)}%` }}
      />
    </span>
  );
}

/** The level and the way to the next one, at the foot of the side navigation. */
export function XpCard() {
  const { api } = useApp();
  const language = useUiLanguage();
  const { data } = useGame(api);
  if (data === null || !data.available) return null;
  const { level, into, needed } = data.level;
  return (
    <Link
      to={ROUTES.achievements}
      className="mx-1 mb-3 flex flex-col gap-1.5 rounded-xl border border-line px-3 py-2.5 transition-colors hover:border-line-strong hover:bg-surface/60"
      aria-label={pick(language, `Level ${level}: ${into} of ${needed} XP. Open achievements`, `Level ${level}: ${into}/${needed} XP. Mở thành tích`)}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink">
          {pick(language, 'Level', 'Level')} <span className="tabular-nums">{level}</span>
        </span>
        <span className="text-[0.6875rem] tabular-nums text-faint">
          {into}/{needed} XP
        </span>
      </span>
      <ProgressBar into={into} needed={needed} />
      {data.economy != null && (
        <span className="flex items-center gap-1 text-[0.6875rem] tabular-nums text-muted">
          <Icon name="star" className="size-3 text-[#f0c75e]" />
          {data.economy.stardust.toLocaleString(language)} {pick(language, 'stardust', 'bụi sao')}
        </span>
      )}
      {data.rewards.length > 0 && (
        <span className="text-[0.6875rem] font-medium text-accent">
          {pick(
            language,
            `${data.rewards.length} ${data.rewards.length === 1 ? 'reward' : 'rewards'} to claim`,
            `${data.rewards.length} phần thưởng chờ nhận`,
          )}
        </span>
      )}
    </Link>
  );
}

/** The level in the phone's header, as a ring that fills towards the next one. */
export function XpChip() {
  const { api } = useApp();
  const language = useUiLanguage();
  const { data } = useGame(api);
  if (data === null || !data.available) return null;
  const { level, into, needed } = data.level;
  const radius = 15;
  const around = 2 * Math.PI * radius;
  const share = needed <= 0 ? 0 : Math.min(1, into / needed);
  return (
    <Link
      to={ROUTES.achievements}
      aria-label={pick(language, `Level ${level}: ${into} of ${needed} XP`, `Level ${level}: ${into}/${needed} XP`)}
      className="relative flex size-9 items-center justify-center rounded-full text-ink"
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r={radius} fill="none" stroke="var(--line-strong)" strokeWidth="2.5" />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={around}
          strokeDashoffset={around * (1 - share)}
          className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
        />
      </svg>
      <span className="text-[0.6875rem] font-semibold tabular-nums">{level}</span>
      {data.rewards.length > 0 && (
        <span aria-hidden="true" className="absolute right-0.5 top-0.5 size-2 rounded-full bg-accent ring-2 ring-paper" />
      )}
    </Link>
  );
}

interface Float {
  id: number;
  xp: number;
  comboBonus: number;
  combo: number;
  /** The answer earned nothing because today's review XP is used up. */
  limit: boolean;
}

/**
 * "+10 XP" rising beside the card each time an answer is saved, with the
 * combo bonus when there is one. Announced politely, never in the way of the
 * keys or the card.
 */
export function XpFloat() {
  const language = useUiLanguage();
  const [floats, setFloats] = useState<Float[]>([]);
  const next = useRef(0);

  useEffect(
    () =>
      subscribeEarned((answer) => {
        const limit = answer.xp === 0 && answer.reviewXpLeft === 0;
        if (answer.xp === 0 && !limit) return;
        next.current += 1;
        const float: Float = { id: next.current, xp: answer.xp, comboBonus: answer.comboBonus, combo: answer.combo, limit };
        setFloats((current) => [...current.slice(-2), float]);
        setTimeout(() => setFloats((current) => current.filter((each) => each.id !== float.id)), 1400);
      }),
    [],
  );

  const latest = floats.at(-1);
  return (
    <div className="pointer-events-none absolute right-3 top-2 z-10 flex flex-col items-end gap-1 sm:right-6" aria-live="polite">
      {floats.map((float) => (
        <span
          key={float.id}
          className={`xp-float rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums shadow-sm ${
            float.xp > 0 ? 'bg-accent-soft text-accent' : 'bg-line text-muted'
          }`}
        >
          {float.limit
            ? pick(language, 'Daily XP limit reached', 'Đã đạt giới hạn XP hôm nay')
            : `${float.xp > 0 ? `+${float.xp}` : float.xp} XP`}
        </span>
      ))}
      {latest !== undefined && latest.comboBonus > 0 && (
        <span key={`combo-${latest.id}`} className="xp-float flex items-center gap-1 text-[0.6875rem] font-semibold text-warn-ink">
          <Icon name="trophy" className="size-3.5" />
          {pick(language, `Combo ${latest.combo} · +${latest.comboBonus}%`, `Combo ${latest.combo} · +${latest.comboBonus}%`)}
        </span>
      )}
    </div>
  );
}
