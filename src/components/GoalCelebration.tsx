/**
 * The two streak moments, both drawn in the room's own night.
 *
 * - Moonrise: both daily goals are met. The two goal rings draw together into
 *   a full moon, the room fills with its light and the streak turns over to
 *   the new day. It plays once a day per account, at the moment the day is
 *   completed — after the answer, the word added or the import that completes
 *   it — or on the next visit when the day was completed somewhere else.
 * - Moonset: a streak has ended. The moon carrying the old count passes into
 *   shadow, and a new crescent lights at its edge: a missed day is told
 *   plainly and gently, never as a punishment. It plays once, on the
 *   dashboard, never in the middle of a review.
 *
 * Both only read the goals: nothing here can change what counts or when.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { GameResponse, GameRewardView, ReviewActionResponse, StudyGoalsResponse } from '../../shared/api.js';
import { useApp, useUiLanguage } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { adoptGame, useGame } from '../lib/game-state.js';
import { chestName, itemName, rewardText } from '../lib/game-text.js';
import { pick } from '../lib/i18n.js';
import { ROUTES, useLocation } from '../lib/router.js';
import { Icon, type IconName } from './Icon.js';
import { Link } from './Link.js';
import { fetchShared, knownStudyGoals, subscribeGoalWork, subscribeStudyGoals } from './StudyGoals.js';
import { BUTTON_GHOST, BUTTON_PRIMARY } from './ui.js';

/** The day each account last celebrated, kept on this device so a reload does not play it twice. */
const celebratedKey = (accountId: string) => `vocab.goals-celebrated.${accountId}`;
/** The streak this device last saw for each account, and on which day: how an ended streak is noticed. */
const seenKey = (accountId: string) => `vocab.streak-seen.${accountId}`;

export interface SeenStreak {
  day: string;
  current: number;
}

function celebratedOn(accountId: string): string | null {
  try {
    return window.localStorage.getItem(celebratedKey(accountId));
  } catch {
    return null;
  }
}

function markCelebrated(accountId: string, day: string) {
  try {
    window.localStorage.setItem(celebratedKey(accountId), day);
  } catch {
    // Without storage it may play again after a reload; nothing else depends on it.
  }
}

function seenStreak(accountId: string): SeenStreak | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(seenKey(accountId)) ?? 'null');
    if (typeof value !== 'object' || value === null) return null;
    const { day, current } = value as Partial<SeenStreak>;
    return typeof day === 'string' && typeof current === 'number' ? { day, current } : null;
  } catch {
    return null;
  }
}

function markSeen(accountId: string, goals: StudyGoalsResponse) {
  try {
    window.localStorage.setItem(seenKey(accountId), JSON.stringify({ day: goals.today, current: goals.streak.current }));
  } catch {
    // Without storage an ended streak simply goes unmarked.
  }
}

/**
 * The streak that has ended since it was last seen, if one has. On the same
 * day a streak can only grow, since a met day stays met; on a later day a
 * smaller count means the run was broken.
 */
export function endedStreak(seen: SeenStreak | null, goals: StudyGoalsResponse): number | null {
  if (seen === null || seen.day === goals.today || seen.current === 0) return null;
  return goals.streak.current < seen.current ? seen.current : null;
}

function reducedMotion(): boolean {
  if (document.documentElement.dataset.reduceMotion === 'true') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Waits this long after the last saved answer before asking, so a quick run of answers asks once. */
const SETTLE_MS = 600;

type Moment = { kind: 'met'; goals: StudyGoalsResponse } | { kind: 'ended'; goals: StudyGoalsResponse; days: number };

/**
 * Watches for the day being completed, and for a streak that ended while the
 * app was closed. Asks for the goals only when the work since they were last
 * seen could have completed them, so a long session does not ask after every
 * answer.
 */
export function GoalCelebration() {
  const { api, sync, accountId } = useApp();
  const [moment, setMoment] = useState<Moment | null>(null);

  useEffect(() => {
    let last = knownStudyGoals(api);
    let answers = 0;
    let added = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const consider = (goals: StudyGoalsResponse) => {
      last = goals;
      answers = 0;
      added = 0;
      // Only goals the reviewer chose make a streak, so only they have these moments.
      if (!goals.available || !goals.chosen) return;
      if (goals.streak.metToday && celebratedOn(accountId) !== goals.today) {
        // A day completed outweighs the run that ended before it: the moonrise says the new one has begun.
        markCelebrated(accountId, goals.today);
        markSeen(accountId, goals);
        setMoment({ kind: 'met', goals });
        return;
      }
      const days = endedStreak(seenStreak(accountId), goals);
      if (days !== null) {
        // Kept for the dashboard: an ended streak is not news to break in the middle of a review.
        if (window.location.pathname !== ROUTES.dashboard) return;
        markSeen(accountId, goals);
        setMoment({ kind: 'ended', goals, days });
        return;
      }
      markSeen(accountId, goals);
    };

    const couldBeMet = () => {
      if (last === undefined) return true;
      if (last.streak.metToday) return false;
      // Generous on purpose: a check too many costs one request, a check missed costs the moment.
      const reviews = last.reviews.met || answers >= Math.min(last.reviews.remaining, last.due.total);
      const newWords = last.newWords.met || added >= last.newWords.remaining;
      return reviews && newWords;
    };

    const checkSoon = () => {
      if (!couldBeMet()) return;
      clearTimeout(timer);
      timer = setTimeout(() => void fetchShared(api).catch(() => undefined), SETTLE_MS);
    };

    const stopGoals = subscribeStudyGoals((source, goals) => {
      if (source === api) consider(goals);
    });
    const stopWork = subscribeGoalWork(() => {
      added = Number.POSITIVE_INFINITY;
      checkSoon();
    });
    const stopEvents = sync.subscribeEvents((event) => {
      if (event.type !== 'settled') return;
      if (event.op.kind === 'review_action') {
        if ((event.value as ReviewActionResponse | undefined)?.outcome !== 'applied') return;
        answers += 1;
      } else if (event.op.kind === 'vocab_create') {
        added += 1;
      } else {
        return;
      }
      checkSoon();
    });
    // Goals already on the page (a dashboard opened first) may show a day completed elsewhere.
    if (last !== undefined) consider(last);

    return () => {
      clearTimeout(timer);
      stopGoals();
      stopWork();
      stopEvents();
    };
  }, [api, sync, accountId]);

  if (moment === null) return <RewardsOnDashboard />;
  const close = () => setMoment(null);
  return moment.kind === 'met' ? (
    <Moonrise goals={moment.goals} onClose={close} />
  ) : (
    <Moonset goals={moment.goals} days={moment.days} onClose={close} />
  );
}

/** A fixed scatter of stars, the same on every visit: position, size, brightness, timing. */
const STARS = Array.from({ length: 42 }, (_, index) => {
  const noise = (salt: number) => {
    const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return value - Math.floor(value);
  };
  return {
    left: noise(1) * 100,
    top: noise(2) * 100,
    size: 1 + noise(3) * 1.8,
    brightness: 0.35 + noise(4) * 0.55,
    delay: 120 + noise(5) * 900,
    twinkle: 2600 + noise(6) * 2600,
  };
});

/** Moonlight thrown off as the rings meet. */
const SPARKS = Array.from({ length: 16 }, (_, index) => ({
  angle: index * (360 / 16) + ((index * 37) % 11) - 5,
  reach: 118 + ((index * 53) % 5) * 14,
  size: 3 + (index % 3),
  delay: 930 + (index % 4) * 40,
  tone: index % 3 === 0 ? 'var(--good-ink)' : index % 3 === 1 ? 'var(--accent-hover)' : 'var(--ink)',
}));

const LEAVE_MS = 260;

const delay = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties;

/**
 * The night both moments play in: a modal over a darkened, blurred page, with
 * the stars. Focus is held on the scene until it has settled, so a key press
 * left over from the card neither closes it nor reaches the review behind;
 * then it moves to the first action inside `actions`.
 */
/**
 * Rewards waiting to be claimed, opened full screen each time the dashboard is
 * reached (the owner's choice), after any moonrise or moonset has been seen.
 * "Later" puts them away until the next visit.
 */
function RewardsOnDashboard() {
  const { api } = useApp();
  const { pathname: path } = useLocation();
  const game = useGame(api);
  const onDashboard = path === ROUTES.dashboard;
  // Put away for this visit; reaching the dashboard again brings them back.
  const [putAway, setPutAway] = useState(false);
  const [visit, setVisit] = useState(path);
  if (visit !== path) {
    setVisit(path);
    if (onDashboard) setPutAway(false);
  }
  // What the chests just claimed held: shown even once no reward is left.
  const [opened, setOpened] = useState<Opened[]>([]);
  const rewards = game.data?.available === true ? game.data.rewards : [];
  if (!onDashboard || putAway || (rewards.length === 0 && opened.length === 0)) return null;
  return (
    <RewardsScene
      rewards={rewards}
      opened={opened}
      onOpened={setOpened}
      onClose={() => {
        setOpened([]);
        setPutAway(true);
      }}
    />
  );
}

type Opened = NonNullable<GameResponse['opened']>[number];

/** What came out of the chests just opened. */
function ChestContents({ opened, onDone, actions }: { opened: readonly Opened[]; onDone: () => void; actions: RefObject<HTMLDivElement | null> }) {
  const language = useUiLanguage();
  const stardust = opened.reduce((sum, each) => sum + each.contents.stardust, 0);
  const xp = opened.reduce((sum, each) => sum + each.contents.xp, 0);
  const items = opened.flatMap((each) => each.contents.items);
  const best = opened.some((each) => each.contents.rarity === 'legendary') ? 'legendary' : opened.some((each) => each.contents.rarity === 'rare') ? 'rare' : 'common';
  return (
    <>
      <p className="moonrise-rise text-xs font-semibold uppercase tracking-[0.2em] text-faint" style={delay(100)}>
        {chestName(language, best)}
      </p>
      <div
        className={`moonrise-rise mt-8 flex size-36 items-center justify-center rounded-full border ${
          best === 'legendary' ? 'border-[#f0c75e]/60 text-[#f0c75e] shadow-[0_0_90px_-6px_rgb(240_199_94_/_0.55)]' : 'border-accent/40 text-accent shadow-[0_0_80px_-10px_rgb(165_201_238_/_0.45)]'
        } bg-accent-soft`}
        style={delay(200)}
        aria-hidden="true"
      >
        <Icon name="chest" className="size-14" />
      </div>
      <h2 id="rewards-title" className="moonrise-rise mt-8 font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl" style={delay(300)}>
        {pick(language, 'Inside', 'Bên trong có')}
      </h2>
      <ul id="rewards-detail" className="moonrise-rise mt-4 flex max-w-sm flex-col items-center gap-1.5 text-sm text-muted" style={delay(380)}>
        {stardust > 0 && <li className="font-semibold text-ink">+{stardust} {pick(language, 'stardust', 'bụi sao')}</li>}
        {xp > 0 && <li className="font-semibold text-ink">+{xp} XP</li>}
        {items.map((id) => (
          <li key={id} className="font-semibold text-ink">
            {itemName(language, id)}
          </li>
        ))}
      </ul>
      <div ref={actions} className="moonrise-rise mt-9 flex justify-center" style={delay(460)}>
        <button type="button" className={`min-w-36 ${BUTTON_PRIMARY}`} onClick={onDone}>
          {pick(language, 'Continue', 'Tiếp tục')}
        </button>
      </div>
    </>
  );
}

const REWARD_ICON: Record<GameRewardView['kind'], IconName> = {
  level: 'trophy',
  badge: 'trophy',
  quest: 'check',
  quests_all: 'check',
  checkin: 'calendar',
  freeze_granted: 'snow',
  freeze_used: 'snow',
  comeback: 'refresh',
  league: 'trophy',
  challenge: 'trophy',
  chest: 'chest',
  boss: 'trophy',
  set: 'star',
};

function RewardsScene({
  rewards,
  opened,
  onOpened,
  onClose,
}: {
  rewards: readonly GameRewardView[];
  opened: readonly Opened[];
  onOpened: (opened: Opened[]) => void;
  onClose: () => void;
}) {
  const { api, toasts } = useApp();
  const language = useUiLanguage();
  const actions = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const reward = rewards[0];
  const { title, detail } = reward === undefined ? { title: '', detail: '' } : rewardText(language, reward);
  const xp = typeof reward?.payload.xp === 'number' ? reward.payload.xp : 0;
  const stardust = typeof reward?.payload.stardust === 'number' ? reward.payload.stardust : 0;
  const chest = reward !== undefined && (reward.kind === 'chest' || typeof reward.payload.chest === 'string');

  const claim = async (ids: readonly string[] | 'all') => {
    setBusy(true);
    try {
      const game = await api.claimGameRewards(ids);
      adoptGame(api, game);
      if ((game.opened ?? []).length > 0) onOpened(game.opened!);
    } catch (cause) {
      toasts.show({
        message: cause instanceof ApiError ? cause.message : pick(language, 'Could not claim the reward.', 'Không nhận được phần thưởng.'),
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <NightScene titleId="rewards-title" detailId="rewards-detail" settleMs={700} onClose={onClose} actions={actions}>
      {() =>
        opened.length > 0 || reward === undefined ? (
          <ChestContents
            opened={opened}
            actions={actions}
            onDone={() => {
              onOpened([]);
              if (rewards.length === 0) onClose();
            }}
          />
        ) : (
        <>
          <p className="moonrise-rise text-xs font-semibold uppercase tracking-[0.2em] text-faint" style={delay(150)}>
            {pick(language, 'Rewards to claim', 'Phần thưởng chờ nhận')}
            {rewards.length > 1 && <span className="tabular-nums"> · 1/{rewards.length}</span>}
          </p>
          <div
            key={reward.id}
            className="moonrise-rise mt-8 flex size-36 items-center justify-center rounded-full border border-accent/40 bg-accent-soft text-accent shadow-[0_0_80px_-10px_rgb(165_201_238_/_0.45)]"
            style={delay(250)}
            aria-hidden="true"
          >
            {reward.kind === 'level' ? (
              <span className="font-serif text-6xl font-semibold tabular-nums text-ink">{String(reward.payload.level)}</span>
            ) : chest ? (
              <Icon name="chest" className="size-14" />
            ) : (
              <Icon name={REWARD_ICON[reward.kind]} className="size-14" />
            )}
          </div>
          <h2
            id="rewards-title"
            key={`title-${reward.id}`}
            className="moonrise-rise mt-8 font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl"
            style={delay(350)}
          >
            {title}
          </h2>
          <p id="rewards-detail" key={`detail-${reward.id}`} className="moonrise-rise mt-3 max-w-sm text-sm leading-relaxed text-muted" style={delay(430)}>
            {detail}
          </p>
          <div ref={actions} className="moonrise-rise mt-9 flex flex-wrap items-center justify-center gap-2" style={delay(520)}>
            <button type="button" className={`min-w-36 ${BUTTON_PRIMARY}`} disabled={busy} onClick={() => void claim([reward.id])}>
              {chest
                ? pick(language, 'Open', 'Mở rương')
                : xp > 0
                  ? pick(language, `Claim +${xp} XP`, `Nhận +${xp} XP`)
                  : stardust > 0
                    ? pick(language, `Claim +${stardust} stardust`, `Nhận +${stardust} bụi sao`)
                    : pick(language, 'Claim', 'Nhận')}
            </button>
            {rewards.length > 1 && (
              <button type="button" className={BUTTON_GHOST} disabled={busy} onClick={() => void claim('all')}>
                {pick(language, `Claim all ${rewards.length}`, `Nhận tất cả ${rewards.length}`)}
              </button>
            )}
            <button type="button" className={BUTTON_GHOST} disabled={busy} onClick={onClose}>
              {pick(language, 'Later', 'Để sau')}
            </button>
          </div>
        </>
        )
      }
    </NightScene>
  );
}

function NightScene({
  titleId,
  detailId,
  settleMs,
  onClose,
  onOpen,
  actions,
  children,
}: {
  titleId: string;
  detailId: string;
  /** When the scene has settled enough that a key press is meant for it. */
  settleMs: number;
  onClose: () => void;
  /** Runs once the scene is shown, with whether motion is reduced; may return a clean-up. */
  onOpen?: (calm: boolean) => (() => void) | void;
  /** Holds the scene's actions; the first one takes focus once it has settled. */
  actions: RefObject<HTMLElement | null>;
  children: (close: () => void) => ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const opened = useRef(onOpen);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (typeof element.showModal === 'function' && !element.open) element.showModal();
    else element.setAttribute('open', '');
    // The answer keys may still be under the reviewer's fingers: hold focus on the scene, not a button.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stage.current?.focus();
    const calm = reducedMotion();
    const settle = setTimeout(
      () => {
        setReady(true);
        actions.current?.querySelector<HTMLElement>('a[href], button')?.focus();
      },
      calm ? 400 : settleMs,
    );
    const stopOpen = opened.current?.(calm);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(settle);
      stopOpen?.();
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
      if (typeof element.close === 'function' && element.open) element.close();
      else element.removeAttribute('open');
    };
  }, [actions, settleMs]);

  // The review shortcuts listen on the window; none of them may reach the card behind.
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    const swallow = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (!ready && event.key !== 'Tab') event.preventDefault();
    };
    element.addEventListener('keydown', swallow);
    return () => element.removeEventListener('keydown', swallow);
  }, [ready]);

  const close = () => {
    if (!ready || leaving) return;
    setLeaving(true);
    setTimeout(onClose, reducedMotion() ? 0 : LEAVE_MS);
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={detailId}
      data-leaving={leaving || undefined}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        // Anywhere in the night closes it; the actions handle their own clicks.
        if (event.target === dialog.current || event.target === stage.current) close();
      }}
      className="moonrise m-0 h-dvh max-h-none w-screen max-w-none overflow-x-hidden overflow-y-auto border-0 bg-transparent p-0 text-ink"
    >
      <div className="moonrise-sky fixed inset-0" aria-hidden="true">
        {STARS.map((star, index) => (
          <span
            key={index}
            className="moonrise-star"
            style={
              {
                left: `${star.left}%`,
                top: `${star.top}%`,
                '--s': `${star.size}px`,
                '--o': star.brightness,
                '--d': `${star.delay}ms`,
                '--t': `${star.twinkle}ms`,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <div
        ref={stage}
        tabIndex={-1}
        className="relative flex min-h-full flex-col items-center justify-center px-4 pt-10 pb-[max(2.5rem,env(safe-area-inset-bottom))] text-center outline-none"
      >
        {children(close)}
      </div>
    </dialog>
  );
}

function Moonrise({ goals, onClose }: { goals: StudyGoalsResponse; onClose: () => void }) {
  const language = useUiLanguage();
  const actions = useRef<HTMLDivElement>(null);

  const streak = goals.streak.current;
  const before = Math.max(0, streak - 1);
  const best = streak > 1 && streak >= goals.streak.longest;

  return (
    <NightScene
      titleId="moonrise-title"
      detailId="moonrise-detail"
      settleMs={1700}
      onClose={onClose}
      actions={actions}
      onOpen={(calm) => {
        if (calm) return;
        // A small knock as the rings meet, where the device has one.
        const knock = setTimeout(() => navigator.vibrate?.([14, 70, 26]), 920);
        return () => clearTimeout(knock);
      }}
    >
      {(close) => (
        <>
          <div className="relative size-64 shrink-0" aria-hidden="true">
            <div className="moonrise-glow absolute -inset-16 rounded-full" />
            <span className="moonrise-halo absolute inset-[3.5rem] rounded-full" style={delay(940)} />
            <span className="moonrise-halo absolute inset-[3.5rem] rounded-full" style={delay(1140)} />
            {SPARKS.map((spark, index) => (
              <span
                key={index}
                className="moonrise-spark"
                style={
                  {
                    '--a': `${spark.angle}deg`,
                    '--r': `${spark.reach}px`,
                    '--s': `${spark.size}px`,
                    '--d': `${spark.delay}ms`,
                    background: spark.tone,
                  } as CSSProperties
                }
              />
            ))}
            <MeltingRing side="left" color="var(--accent)" label={`${goals.newWords.done}/${goals.newWords.target}`} />
            <MeltingRing side="right" color="var(--ink)" label={`${goals.reviews.done}/${goals.reviews.target}`} />
            <div className="moonrise-moon absolute inset-[3.5rem] rounded-full">
              <Craters />
              <svg viewBox="0 0 100 100" className="absolute inset-0 size-full">
                <path
                  className="moonrise-check"
                  d="M31 52 L45 65 L70 37"
                  fill="none"
                  stroke="var(--on-accent)"
                  strokeOpacity="0.82"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                />
              </svg>
            </div>
          </div>

          <p
            className="moonrise-rise mt-2 text-xs font-semibold uppercase tracking-[0.2em] text-faint"
            style={delay(1220)}
          >
            {pick(language, 'Both goals met', 'Đạt cả hai mục tiêu')}
          </p>
          <h2
            id="moonrise-title"
            className="moonrise-rise mt-3 font-serif text-4xl font-semibold tracking-tight text-ink sm:text-5xl"
            style={delay(1300)}
          >
            {pick(language, 'Today is complete.', 'Hôm nay đã trọn vẹn.')}
          </h2>
          <p
            id="moonrise-detail"
            className="moonrise-rise mt-3 max-w-sm text-sm leading-relaxed text-muted"
            style={delay(1380)}
          >
            {pick(
              language,
              `${goals.newWords.done} new ${goals.newWords.done === 1 ? 'word' : 'words'} and ${goals.reviews.done} ${goals.reviews.done === 1 ? 'review' : 'reviews'} today.`,
              `Hôm nay: ${goals.newWords.done} từ mới và ${goals.reviews.done} lượt ôn.`,
            )}
          </p>

          <div className="moonrise-rise mt-7 flex flex-col items-center" style={delay(1480)}>
            <div className="moonrise-pop relative h-14 overflow-hidden font-serif text-5xl font-semibold leading-[3.5rem] tabular-nums text-ink">
              <span className="invisible">{streak}</span>
              {before !== streak && (
                <span className="moonrise-roll-out absolute inset-0" aria-hidden="true">
                  {before}
                </span>
              )}
              <span className="moonrise-roll-in absolute inset-0">{streak}</span>
            </div>
            <p className="mt-1 text-sm font-medium text-muted">
              {streak === 1
                ? pick(language, 'Your streak starts today.', 'Chuỗi ngày bắt đầu từ hôm nay.')
                : pick(language, `days in a row`, `ngày liên tiếp`)}
            </p>
            {best && (
              <p
                className="moonrise-rise mt-2 rounded-full bg-good-soft px-3 py-1 text-xs font-semibold text-good-ink"
                style={delay(2150)}
              >
                {pick(language, 'Your longest streak yet', 'Chuỗi dài nhất của bạn')}
              </p>
            )}
          </div>

          <div ref={actions} className="moonrise-rise mt-9" style={delay(1600)}>
            <button type="button" className={`min-w-36 ${BUTTON_PRIMARY}`} onClick={close}>
              {pick(language, 'Continue', 'Tiếp tục')}
            </button>
          </div>
        </>
      )}
    </NightScene>
  );
}

/**
 * A streak has ended. The moon carrying the old count passes into shadow,
 * then a new crescent lights at its edge. No red and no knock: a missed day
 * is a fact to tell kindly, and the way back is the next thing on the page.
 */
function Moonset({ goals, days, onClose }: { goals: StudyGoalsResponse; days: number; onClose: () => void }) {
  const language = useUiLanguage();
  const actions = useRef<HTMLDivElement>(null);
  const restarted = goals.streak.metToday;
  const newLeft = goals.newWords.met ? 0 : goals.newWords.remaining;
  const reviewsLeft = goals.reviews.met ? 0 : goals.reviews.remaining;
  const todo = [
    newLeft > 0 ? pick(language, `${newLeft} new ${newLeft === 1 ? 'word' : 'words'}`, `${newLeft} từ mới`) : null,
    reviewsLeft > 0
      ? pick(language, `${reviewsLeft} ${reviewsLeft === 1 ? 'review' : 'reviews'}`, `${reviewsLeft} lượt ôn`)
      : null,
  ].filter((item): item is string => item !== null);
  // The way back is whichever goal is still open, reviews first since they are what is due.
  const again = reviewsLeft > 0 ? ROUTES.review : ROUTES.add;

  return (
    <NightScene titleId="moonset-title" detailId="moonset-detail" settleMs={2600} onClose={onClose} actions={actions}>
      {(close) => (
        <>
          <div className="relative size-64 shrink-0" aria-hidden="true">
            <div className="moonset-glow absolute -inset-16 rounded-full" />
            <div className="moonset-body absolute inset-[3.5rem] overflow-hidden rounded-full">
              <div className="moonset-light absolute inset-0 rounded-full">
                <Craters />
                <span className="absolute inset-0 flex items-center justify-center font-serif text-5xl font-semibold tabular-nums text-on-accent/80">
                  {days}
                </span>
              </div>
              <div className="moonset-shadow absolute -inset-px rounded-full" />
            </div>
            <span className="moonset-rim absolute inset-[3.5rem] rounded-full" />
            <svg viewBox="0 0 100 100" className="moonset-crescent absolute inset-[3.5rem] overflow-visible">
              <defs>
                <mask id="moonset-crescent-mask">
                  <rect x="-10" y="-10" width="120" height="120" fill="white" />
                  <circle cx="61" cy="50" r="50" fill="black" />
                </mask>
              </defs>
              <circle cx="50" cy="50" r="50" fill="var(--accent-hover)" mask="url(#moonset-crescent-mask)" />
            </svg>
          </div>

          <p
            className="moonrise-rise mt-2 text-xs font-semibold uppercase tracking-[0.2em] text-faint"
            style={delay(2050)}
          >
            {pick(language, 'Streak ended', 'Chuỗi ngày đã khép lại')}
          </p>
          <h2
            id="moonset-title"
            className="moonrise-rise mt-3 font-serif text-4xl font-semibold tracking-tight text-ink sm:text-5xl"
            style={delay(2130)}
          >
            {pick(language, `Your ${days}-day streak has ended.`, `Chuỗi ${days} ngày đã kết thúc.`)}
          </h2>
          <p
            id="moonset-detail"
            className="moonrise-rise mt-3 max-w-sm text-sm leading-relaxed text-muted"
            style={delay(2210)}
          >
            {pick(
              language,
              'Missing a day happens. Every word you have learned is still here, and tonight a new moon starts the next streak.',
              'Lỡ một ngày là chuyện bình thường. Mọi từ bạn đã học vẫn còn nguyên, và đêm nay trăng non mở đầu chuỗi mới.',
            )}
          </p>

          <div className="moonrise-rise mt-6 flex flex-col items-center gap-2" style={delay(2300)}>
            {(restarted || todo.length > 0) && (
              <p className="text-sm font-medium text-ink">
                {restarted
                  ? pick(
                      language,
                      'You have already met today’s goals, so a new streak has begun.',
                      'Hôm nay bạn đã đạt mục tiêu, chuỗi mới đã bắt đầu.',
                    )
                  : pick(
                      language,
                      `To start again today: ${todo.join(' and ')}.`,
                      `Để bắt đầu lại hôm nay: ${todo.join(' và ')}.`,
                    )}
              </p>
            )}
            {goals.streak.longest > 0 && (
              <p className="rounded-full border border-line-strong px-3 py-1 text-xs font-semibold tabular-nums text-muted">
                {pick(
                  language,
                  `Longest streak: ${goals.streak.longest} ${goals.streak.longest === 1 ? 'day' : 'days'}`,
                  `Chuỗi dài nhất: ${goals.streak.longest} ngày`,
                )}
              </p>
            )}
          </div>

          <div
            ref={actions}
            className="moonrise-rise mt-8 flex flex-wrap items-center justify-center gap-2"
            style={delay(2400)}
          >
            {restarted ? (
              <button type="button" className={`min-w-36 ${BUTTON_PRIMARY}`} onClick={close}>
                {pick(language, 'Continue', 'Tiếp tục')}
              </button>
            ) : (
              <>
                <Link to={again} className={`min-w-36 ${BUTTON_PRIMARY}`} onClick={close}>
                  {pick(language, 'Start again', 'Bắt đầu lại')}
                </Link>
                <button type="button" className={BUTTON_GHOST} onClick={close}>
                  {pick(language, 'Not now', 'Để sau')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </NightScene>
  );
}

function Craters() {
  return (
    <>
      <span className="absolute left-[22%] top-[26%] size-[22%] rounded-full bg-[rgb(8_16_32_/_0.045)]" />
      <span className="absolute left-[58%] top-[56%] size-[16%] rounded-full bg-[rgb(8_16_32_/_0.05)]" />
      <span className="absolute left-[60%] top-[22%] size-[9%] rounded-full bg-[rgb(8_16_32_/_0.045)]" />
    </>
  );
}

/** One of the two goal rings, full, sliding in from its side to meet the other. */
function MeltingRing({ side, color, label }: { side: 'left' | 'right'; color: string; label: string }) {
  return (
    <div className={`moonrise-ring moonrise-ring-${side} absolute inset-[3.5rem]`}>
      <svg viewBox="0 0 100 100" className="size-full">
        <circle cx="50" cy="50" r="38" fill="rgb(8 16 32 / 0.55)" stroke={color} strokeWidth="7" />
      </svg>
      <span className="moonrise-ring-label absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums text-ink">
        {label}
      </span>
    </div>
  );
}
