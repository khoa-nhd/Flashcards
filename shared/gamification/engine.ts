/**
 * The game engine: from what is stored and the answers not yet counted, what
 * to store next. Pure and deterministic, so the server, the sample data and
 * the tests run exactly the same rules (docs/gamification-plan.md, phase 1).
 *
 * Nothing here can change a word's schedule. It only reads answers that were
 * already saved, and every amount comes from how an answer was saved, never
 * from whether it was remembered.
 */
import { addDays, compareDates, type IsoDate } from '../dates.js';
import { streakOf } from '../study-goals.js';
import { newTiers, type BadgeId, type BadgeMetrics } from './badges.js';
import { levelOf } from './levels.js';
import {
  DAILY_QUESTS,
  answerProgress,
  drawDailyQuests,
  drawWeeklyQuest,
  type Quest,
  type QuestGoals,
} from './quests.js';
import { CHECKIN_XP, FREEZE_EVERY, FREEZE_MAX, daysToCover, nextCheckinDay, type Freeze } from './streak.js';
import { CARD_SETS } from './catalog.js';
import {
  BOOST_BONUS,
  GOLDEN_HOUR_BONUS,
  INITIAL_PETS,
  MONTHLY_TARGET,
  STARDUST,
  SUNDAY_BONUS,
  chestRarity,
  goldenHour,
  monthBadge,
  monthKey,
  openChest,
  petEffects,
  type ChestContents,
  type EventSwitches,
  type PetState,
} from './economy.js';
import {
  COMBO_GAP_MS,
  COMEBACK_AFTER_DAYS,
  COMEBACK_BONUS,
  COMEBACK_HOURS,
  RATE_LIMIT,
  XP,
  answerReason,
  comboBonus,
  withBonus,
  type AnswerEvent,
  type AnswerReason,
} from './xp.js';

/** What the game keeps between visits, beyond its ledger. */
export interface GameStateData {
  combo: number;
  longestCombo: number;
  lastAnswerAt: string | null;
  lastActiveOn: IsoDate | null;
  comebackUntil: string | null;
  checkin: { day: number; lastOn: IsoDate | null };
  /** The last met day already given its goal XP. */
  goalCursor: IsoDate | null;
  /** The level last shown to the reviewer. */
  levelAnnounced: number;
  /** The day a freeze was last given, so a milestone gives one only once. */
  freezeGrantedOn: IsoDate | null;
  /** When the game first counted this account: earlier answers earn XP but no bonuses or rewards. */
  installedAt: string | null;
  /** How many days ahead "review early" reaches. */
  earlyDays: number;
  /** The day the combo high-water mark below belongs to. */
  comboDay: { on: IsoDate; longest: number } | null;
  // ---- Phase 3 ----
  pets: PetState;
  /** Until when a bought boost doubles XP. */
  boostUntil: string | null;
  /** This month's challenge: answers counted, and whether its badge is earned. */
  month: { key: string; count: number; done: boolean } | null;
  /** This week's boss: its words, and whether it is beaten. */
  boss: { week: IsoDate; words: string[]; won: boolean } | null;
  bossWins: number;
  /** Card sets completed, so each gives its reward once. */
  setsDone: string[];
  /** The colour theme chosen, if any. */
  theme: string | null;
  /** What the earning limits have counted so far (xp.ts, RATE_LIMIT). */
  limits: { recent: string[]; last?: string };
}

export const INITIAL_STATE: GameStateData = {
  combo: 0,
  longestCombo: 0,
  lastAnswerAt: null,
  lastActiveOn: null,
  comebackUntil: null,
  checkin: { day: 0, lastOn: null },
  goalCursor: null,
  levelAnnounced: 0,
  freezeGrantedOn: null,
  installedAt: null,
  earlyDays: 3,
  comboDay: null,
  limits: { recent: [] },
  pets: INITIAL_PETS,
  boostUntil: null,
  month: null,
  boss: null,
  bossWins: 0,
  setsDone: [],
  theme: null,
};

export interface LedgerEntry {
  source: 'answer' | 'goal' | 'reward';
  sourceId: string;
  amount: number;
  base: number;
  bonus: number;
  reason: string;
  at: string;
  on: IsoDate;
}

export type RewardKind =
  | 'level'
  | 'badge'
  | 'quest'
  | 'quests_all'
  | 'checkin'
  | 'freeze_granted'
  | 'freeze_used'
  | 'comeback'
  | 'league'
  | 'challenge'
  | 'chest'
  | 'boss'
  | 'set';

export interface Reward {
  id: string;
  kind: RewardKind;
  /** `xp` is given when the reward is claimed; the rest describes it. */
  payload: { xp?: number } & Record<string, unknown>;
  createdAt: string;
}

export interface HeldBadge {
  badge: BadgeId;
  tier: number;
  earnedAt: string;
}

export interface GameSnapshot {
  version: number;
  totalXp: number;
  state: GameStateData;
  /** Today's and this week's quests. */
  quests: Quest[];
  badges: HeldBadge[];
  freezes: Freeze[];
  /** Rewards not yet claimed, oldest first. */
  rewards: Reward[];
  /** Stardust held (phase 3); 0 where the database keeps none. */
  stardust: number;
  /** Items owned (phase 3). */
  inventory: string[];
}

export interface StardustEntry {
  source: 'reward' | 'chest' | 'shop' | 'set';
  sourceId: string;
  amount: number;
  reason: string;
  at: string;
}

export interface InventoryEntry {
  item: string;
  source: string;
}

/** What to store: a change against the snapshot of `version`. */
export interface GameChange {
  version: number;
  state: GameStateData;
  ledger: LedgerEntry[];
  quests: Quest[];
  badges: Array<{ badge: BadgeId; tier: number }>;
  freezes: Freeze[];
  rewards: Reward[];
  claimed: string[];
  stardust: StardustEntry[];
  inventory: InventoryEntry[];
}

/** An earlier answer an undo takes back, as the ledger has it. */
export interface Undone {
  amount: number;
  reason: string;
  on: IsoDate;
}

export interface SyncContext {
  account: string;
  now: string;
  today: IsoDate;
  goals: QuestGoals;
  /** Answers not yet counted, oldest first. */
  answers: readonly AnswerEvent[];
  /** Earlier answers the undos among `answers` take back. */
  undone: ReadonlyMap<string, Undone>;
  /** Every met day of the daily goals. */
  metDays: readonly IsoDate[];
  metToday: boolean;
  addedToday: number;
  /** Totals the badges are read from; streak and combo are filled in here. */
  metrics: Omit<BadgeMetrics, 'longestStreak' | 'longestCombo' | 'bosses'>;
  /** Makes reward and freeze ids. */
  newId: () => string;
  /** Phase 3, where the database keeps it (version 19): events, companions, chests and stardust. */
  economy?: { timeZone: string; events: EventSwitches } | null;
}

/** The hour of the day an instant falls in, in a zone. */
function hourIn(iso: string, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
}

const isSunday = (day: IsoDate) => new Date(`${day}T00:00:00Z`).getUTCDay() === 0;

/** Stardust for reaching every level from just after `from` up to `to`. */
export function levelStardust(from: number, to: number): number {
  let total = 0;
  for (let level = Math.max(2, from + 1); level <= to; level += 1) total += STARDUST.level(level);
  return total;
}

const time = (iso: string) => Date.parse(iso);

/** The Monday of the week `day` is in. */
export function weekStartOf(day: IsoDate): IsoDate {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

const daysBetween = (from: IsoDate, to: IsoDate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const questKey = (quest: Quest) => `${quest.period}:${quest.start}:${quest.slot}`;

/**
 * Whether an answer is past an earning limit (xp.ts, RATE_LIMIT); if not, it
 * is counted against them. Every answer counts towards the gap, so tapping
 * fast earns nothing; only answers that earn count towards the minute.
 * Answers saved before version 18 carry no database time and are not limited.
 */
function overLimit(limits: GameStateData['limits'], event: AnswerEvent): boolean {
  if (!event.recordedAt) return false;
  const at = time(event.recordedAt);
  const previous = limits.last === undefined ? null : time(limits.last);
  limits.last = event.recordedAt;
  if (previous !== null && at >= previous && at - previous < RATE_LIMIT.minGapMs) return true;
  limits.recent = limits.recent.filter((seen) => {
    const then = time(seen);
    return then <= at && at - then < 60_000;
  });
  if (limits.recent.length >= RATE_LIMIT.perMinute) return true;
  limits.recent.push(event.recordedAt);
  return false;
}

/**
 * Brings the game up to date: counts the answers, gives the goal XP, draws and
 * settles the quests, settles the streak's freezes, awards badges and
 * announces a new level. The returned change is what to store.
 */
export function sync(snapshot: GameSnapshot, context: SyncContext): GameChange {
  const { now, today, account, goals, newId } = context;
  const weekStart = weekStartOf(today);
  const state: GameStateData = { ...INITIAL_STATE, ...snapshot.state, checkin: { ...snapshot.state.checkin } };
  const limits = snapshot.state.limits ?? INITIAL_STATE.limits;
  state.limits = { ...limits, recent: [...limits.recent] };
  if (state.installedAt === null) state.installedAt = now;
  const installedAt = time(state.installedAt);
  const economy = context.economy ?? null;
  state.pets = { ...INITIAL_PETS, ...state.pets, days: { ...(state.pets?.days ?? {}) }, active: [...(state.pets?.active ?? [])] };
  const pets = economy === null ? { xpPercent: 0, comboExtraMs: 0, chestRarePercent: 0 } : petEffects(state.pets.active);

  const ledger: LedgerEntry[] = [];
  const rewards: Reward[] = [];
  const reward = (kind: RewardKind, payload: Reward['payload'] = {}) =>
    rewards.push({ id: newId(), kind, payload, createdAt: now });

  // Today's and this week's quests, drawn the first time they are needed.
  const quests = new Map(snapshot.quests.map((quest) => [questKey(quest), { ...quest }]));
  const daily = [...quests.values()].filter((quest) => quest.period === 'day' && quest.start === today);
  if (daily.length === 0) {
    for (const quest of drawDailyQuests(account, today, goals)) quests.set(questKey(quest), quest);
  }
  if (![...quests.values()].some((quest) => quest.period === 'week' && quest.start === weekStart)) {
    const quest = drawWeeklyQuest(account, weekStart, goals);
    quests.set(questKey(quest), quest);
  }
  const current = () =>
    [...quests.values()].filter(
      (quest) => (quest.period === 'day' && quest.start === today) || (quest.period === 'week' && quest.start === weekStart),
    );
  const touched = new Set<string>();

  // ---- Answers ----
  const counted = new Map<string, Undone>();
  const monthlyEarned: string[] = [];
  for (const event of context.answers) {
    const at = time(event.at);
    const live = at >= installedAt;
    const inWeek = compareDates(event.on, weekStart) >= 0 && compareDates(event.on, today) <= 0;

    if (event.kind === 'undo') {
      const target = (event.undoes !== null ? (counted.get(event.undoes) ?? context.undone.get(event.undoes)) : undefined) ?? null;
      const amount = target === null || target.amount === 0 ? 0 : -target.amount;
      ledger.push({ source: 'answer', sourceId: event.id, amount, base: amount, bonus: 0, reason: 'undo', at: event.at, on: event.on });
      // A counted answer taken back no longer counts towards today's or this week's quests.
      if (target !== null && target.reason !== 'capped' && live) {
        for (const quest of current()) {
          if (quest.completedAt !== null) continue;
          if (quest.period === 'day' && target.on !== today) continue;
          if (quest.period === 'week' && !(compareDates(target.on, weekStart) >= 0)) continue;
          const step = answerProgress(quest.kind, target.reason as AnswerReason, null, null, false);
          if (step > 0) {
            quest.progress = Math.max(0, quest.progress - step);
            touched.add(questKey(quest));
          }
        }
      }
      continue;
    }

    const reason = answerReason(event)!;
    if (live && overLimit(state.limits, event)) {
      // Saved, and the schedule moved, but past a limit: it earns nothing.
      ledger.push({ source: 'answer', sourceId: event.id, amount: 0, base: 0, bonus: 0, reason: 'capped', at: event.at, on: event.on });
      counted.set(event.id, { amount: 0, reason: 'capped', on: event.on });
      continue;
    }
    const base = XP[reason];
    let bonus = 0;

    if (live) {
      const last = state.lastAnswerAt === null ? null : time(state.lastAnswerAt);
      if (last === null || at - last > COMBO_GAP_MS + pets.comboExtraMs) {
        state.combo = 1;
      } else if (at >= last) {
        state.combo += 1;
      }
      bonus += comboBonus(state.combo);
      state.longestCombo = Math.max(state.longestCombo, state.combo);
      if (event.on === today) {
        state.comboDay = { on: today, longest: Math.max(state.comboDay?.on === today ? state.comboDay.longest : 0, state.combo) };
      }

      // Back after days away: double XP for a day.
      if (state.lastActiveOn !== null && daysBetween(state.lastActiveOn, event.on) - 1 >= COMEBACK_AFTER_DAYS) {
        state.comebackUntil = new Date(at + COMEBACK_HOURS * 3_600_000).toISOString();
        reward('comeback', { until: state.comebackUntil, days: daysBetween(state.lastActiveOn, event.on) - 1 });
      }
      if (state.comebackUntil !== null && at < time(state.comebackUntil)) bonus += COMEBACK_BONUS;

      if (economy !== null) {
        bonus += pets.xpPercent;
        if (state.boostUntil !== null && at < time(state.boostUntil)) bonus += BOOST_BONUS;
        if (economy.events.goldenHour && hourIn(event.at, economy.timeZone) === goldenHour(account, event.on)) bonus += GOLDEN_HOUR_BONUS;
        if (economy.events.sunday && isSunday(event.on)) bonus += SUNDAY_BONUS;
        // Every new day of study grows the companions leading.
        if (state.lastActiveOn === null || compareDates(event.on, state.lastActiveOn) > 0) {
          for (const pet of state.pets.active) state.pets.days[pet] = (state.pets.days[pet] ?? 0) + 1;
        }
        if (economy.events.monthly) {
          const key = monthKey(event.on);
          const month = state.month?.key === key ? { ...state.month } : { key, count: 0, done: false };
          month.count += 1;
          if (!month.done && month.count >= MONTHLY_TARGET) {
            month.done = true;
            monthlyEarned.push(key);
          }
          state.month = month;
        }
      }
    }

    // The first answer of a day is the day's check-in.
    if (state.checkin.lastOn === null || compareDates(event.on, state.checkin.lastOn) > 0) {
      const day = nextCheckinDay(state.checkin, event.on);
      state.checkin = { day, lastOn: event.on };
      // With chests kept, the seventh day's check-in is a rare chest instead of its XP.
      if (live) reward('checkin', economy !== null && day === 7 ? { day, chest: 'rare' } : { day, xp: CHECKIN_XP[day - 1] });
    }
    if (state.lastActiveOn === null || compareDates(event.on, state.lastActiveOn) > 0) state.lastActiveOn = event.on;
    if (live && (state.lastAnswerAt === null || at >= time(state.lastAnswerAt))) state.lastAnswerAt = event.at;

    const amount = withBonus(base, bonus);
    ledger.push({ source: 'answer', sourceId: event.id, amount, base, bonus, reason, at: event.at, on: event.on });
    counted.set(event.id, { amount, reason, on: event.on });

    if (live) {
      for (const quest of current()) {
        if (quest.completedAt !== null) continue;
        if (quest.period === 'day' && event.on !== today) continue;
        if (quest.period === 'week' && !inWeek) continue;
        const step = answerProgress(quest.kind, reason, event.mode, event.durationMs, event.mastered);
        if (step > 0) {
          quest.progress += step;
          touched.add(questKey(quest));
        }
      }
    }
  }

  // ---- Goal days ----
  /** Met days given their XP now and recent enough to bring a chest (a whole history does not become chests). */
  const newGoalDays: IsoDate[] = [];
  const metDays = [...new Set(context.metToday ? [...context.metDays, today] : context.metDays)]
    .filter((day) => compareDates(day, today) <= 0)
    .sort(compareDates);
  for (const day of metDays) {
    if (state.goalCursor !== null && compareDates(day, state.goalCursor) <= 0) continue;
    ledger.push({ source: 'goal', sourceId: day, amount: XP.goalDay, base: XP.goalDay, bonus: 0, reason: 'goal', at: now, on: day });
    state.goalCursor = day;
    if (compareDates(day, addDays(today, -1)) >= 0) newGoalDays.push(day);
  }

  // ---- Quests set from the day as a whole ----
  const goalDaysThisWeek = metDays.filter((day) => compareDates(day, weekStart) >= 0).length;
  for (const quest of current()) {
    if (quest.completedAt !== null) continue;
    let value: number | null = null;
    if (quest.kind === 'added_words') value = context.addedToday;
    if (quest.kind === 'goal') value = context.metToday ? 1 : 0;
    if (quest.kind === 'combo') value = state.comboDay?.on === today ? state.comboDay.longest : 0;
    if (quest.kind === 'week_goal_days') value = goalDaysThisWeek;
    if (value !== null && value !== quest.progress) {
      quest.progress = Math.max(quest.progress, value);
      touched.add(questKey(quest));
    }
  }
  const dailyBefore = snapshot.quests.filter((quest) => quest.period === 'day' && quest.start === today && quest.completedAt !== null).length;
  for (const quest of current()) {
    if (quest.completedAt === null && quest.progress >= quest.target) {
      quest.completedAt = now;
      touched.add(questKey(quest));
      reward('quest', {
        xp: quest.reward,
        quest: quest.kind,
        period: quest.period,
        target: quest.target,
        ...(economy === null ? {} : { stardust: quest.period === 'week' ? STARDUST.weeklyQuest : STARDUST.dailyQuest }),
      });
    }
  }
  const dailyAfter = current().filter((quest) => quest.period === 'day' && quest.completedAt !== null).length;
  if (dailyBefore < DAILY_QUESTS && dailyAfter >= DAILY_QUESTS) {
    reward('quests_all', { xp: XP.allQuests, ...(economy === null ? {} : { stardust: STARDUST.allQuests }) });
  }

  // ---- Streak freezes ----
  const freezes = snapshot.freezes.map((freeze) => ({ ...freeze }));
  const changedFreezes = new Map<string, Freeze>();
  const covered = () => freezes.flatMap((freeze) => (freeze.usedOn === null ? [] : [freeze.usedOn]));
  const held = () => freezes.filter((freeze) => freeze.usedOn === null);
  const missed = daysToCover(metDays, covered(), held().length, today);
  if (missed.length > 0) {
    const spare = held().sort((a, b) => compareDates(a.grantedOn, b.grantedOn));
    missed.forEach((day, at) => {
      const freeze = spare[at]!;
      freeze.usedOn = day;
      changedFreezes.set(freeze.id, freeze);
    });
    reward('freeze_used', { days: missed });
  }
  const streak = streakOf(metDays, today, context.metToday, covered());
  if (
    context.metToday &&
    streak.current > 0 &&
    streak.current % FREEZE_EVERY === 0 &&
    state.freezeGrantedOn !== today &&
    held().length < FREEZE_MAX
  ) {
    const freeze: Freeze = { id: newId(), grantedOn: today, usedOn: null };
    freezes.push(freeze);
    changedFreezes.set(freeze.id, freeze);
    state.freezeGrantedOn = today;
    reward('freeze_granted', { streak: streak.current });
  }

  // ---- Chests: one for each day the goals are met ----
  if (economy !== null) for (const day of newGoalDays) reward('chest', { day, streak: streak.current, rarePercent: pets.chestRarePercent });

  // ---- Badges ----
  const heldBadges = new Set(snapshot.badges.map((badge) => `${badge.badge}:${badge.tier}`));
  const badges = newTiers(
    { ...context.metrics, longestStreak: streak.longest, longestCombo: state.longestCombo, bosses: state.bossWins },
    heldBadges,
  );
  for (const month of monthlyEarned) {
    badges.push({ badge: monthBadge(month) as BadgeId, tier: 1 });
    reward('badge', { badge: monthBadge(month), tier: 1, month });
  }
  for (const badge of badges) reward('badge', { badge: badge.badge, tier: badge.tier });

  // ---- Level ----
  const total = snapshot.totalXp + ledger.reduce((sum, entry) => sum + entry.amount, 0);
  const level = levelOf(total).level;
  // Level 1 is where everyone starts: only a level above it, and above the last one shown, is news.
  if (level > Math.max(1, state.levelAnnounced)) {
    reward('level', {
      level,
      from: state.levelAnnounced,
      ...(economy === null ? {} : { stardust: levelStardust(state.levelAnnounced, level) }),
    });
  }
  state.levelAnnounced = Math.max(state.levelAnnounced, level);

  return {
    version: snapshot.version,
    state,
    ledger,
    quests: [...touched].map((key) => quests.get(key)!).concat(
      [...quests.values()].filter((quest) => !snapshot.quests.some((known) => questKey(known) === questKey(quest)) && !touched.has(questKey(quest))),
    ),
    badges: badges.map(({ badge, tier }) => ({ badge, tier })),
    freezes: [...changedFreezes.values()],
    rewards,
    claimed: [],
    stardust: [],
    inventory: [],
  };
}

/** A change that only moves the state on: where the shop's, the boss's and the companions' changes start. */
export function stateChange(snapshot: GameSnapshot, state: GameStateData): GameChange {
  return { version: snapshot.version, state, ledger: [], quests: [], badges: [], freezes: [], rewards: [], claimed: [], stardust: [], inventory: [] };
}

/**
 * Adds items to a change (any already owned are left out: whoever adds them
 * turns them into stardust first), and gives the reward of every card set
 * they complete.
 */
export function addItems(change: GameChange, owned: ReadonlySet<string>, items: readonly string[], source: string, at: string, newId: () => string): void {
  const have = new Set([...owned, ...change.inventory.map((entry) => entry.item)]);
  for (const item of items) {
    if (have.has(item)) continue;
    have.add(item);
    change.inventory.push({ item, source });
  }
  for (const set of CARD_SETS) {
    if (change.state.setsDone.includes(set.id) || !set.cards.every((card) => have.has(card))) continue;
    change.state = { ...change.state, setsDone: [...change.state.setsDone, set.id] };
    if (!have.has(set.title)) {
      have.add(set.title);
      change.inventory.push({ item: set.title, source: set.id });
    }
    change.rewards.push({ id: newId(), kind: 'set', payload: { set: set.id, stardust: set.stardust, title: set.title }, createdAt: at });
  }
}

/** A chest opened as it was claimed. */
export interface Opened {
  reward: string;
  contents: ChestContents;
}

/**
 * Claims rewards: each one's XP goes into the ledger, and a new level from
 * that XP is announced the same way as any other.
 */
export function claim(
  snapshot: GameSnapshot,
  ids: readonly string[],
  now: string,
  today: IsoDate,
  newId: () => string,
  /** Draws chests, where the database keeps what is in them (version 19); without it chests stay closed. */
  random: (() => number) | null = null,
): GameChange & { opened: Opened[] } {
  const state: GameStateData = { ...INITIAL_STATE, ...snapshot.state };
  const wanted = new Set(ids);
  const isChest = (reward: Reward) => reward.kind === 'chest' || typeof reward.payload.chest === 'string';
  const claiming = snapshot.rewards.filter((reward) => wanted.has(reward.id) && (random !== null || !isChest(reward)));
  const ledger: LedgerEntry[] = claiming
    .filter((reward) => (reward.payload.xp ?? 0) > 0)
    .map((reward) => ({
      source: 'reward',
      sourceId: reward.id,
      amount: reward.payload.xp!,
      base: reward.payload.xp!,
      bonus: 0,
      reason: reward.kind,
      at: now,
      on: today,
    }));
  const change: GameChange & { opened: Opened[] } = { ...stateChange(snapshot, state), ledger, opened: [] };
  const owned = new Set(snapshot.inventory);
  for (const reward of claiming) {
    const stardust = typeof reward.payload.stardust === 'number' ? reward.payload.stardust : 0;
    if (stardust > 0) change.stardust.push({ source: 'reward', sourceId: reward.id, amount: stardust, reason: reward.kind, at: now });
    // Reaching Gold in a league opens a companion slot for good.
    if (reward.kind === 'league' && Number(reward.payload.tier) >= 3) {
      change.state = { ...change.state, pets: { ...INITIAL_PETS, ...change.state.pets, goldReached: true } };
    }
    if (!isChest(reward) || random === null) continue;
    const given = typeof reward.payload.chest === 'string' ? reward.payload.chest : reward.payload.rarity;
    const rarity =
      given === 'common' || given === 'rare' || given === 'legendary'
        ? given
        : chestRarity(random, Number(reward.payload.streak ?? 0), Number(reward.payload.rarePercent ?? 0));
    const contents = openChest(rarity, random, new Set([...owned, ...change.inventory.map((entry) => entry.item)]));
    if (contents.xp > 0) {
      ledger.push({ source: 'reward', sourceId: reward.id, amount: contents.xp, base: contents.xp, bonus: 0, reason: 'chest', at: now, on: today });
    }
    if (contents.stardust > 0) change.stardust.push({ source: 'chest', sourceId: reward.id, amount: contents.stardust, reason: rarity, at: now });
    addItems(change, owned, contents.items, `chest:${reward.id}`, now, newId);
    change.opened.push({ reward: reward.id, contents });
  }
  const total = snapshot.totalXp + ledger.reduce((sum, entry) => sum + entry.amount, 0);
  const level = levelOf(total).level;
  if (level > Math.max(1, change.state.levelAnnounced)) {
    change.rewards.push({
      id: newId(),
      kind: 'level',
      payload: {
        level,
        from: change.state.levelAnnounced,
        ...(random === null ? {} : { stardust: levelStardust(change.state.levelAnnounced, level) }),
      },
      createdAt: now,
    });
  }
  change.state = { ...change.state, levelAnnounced: Math.max(change.state.levelAnnounced, level) };
  change.claimed = claiming.map((reward) => reward.id);
  return change;
}

/** Whether a change stores anything at all; an empty one need not be sent. */
export function isEmpty(change: GameChange, before: GameStateData): boolean {
  return (
    change.ledger.length === 0 &&
    change.quests.length === 0 &&
    change.badges.length === 0 &&
    change.freezes.length === 0 &&
    change.rewards.length === 0 &&
    change.claimed.length === 0 &&
    change.stardust.length === 0 &&
    change.inventory.length === 0 &&
    JSON.stringify(change.state) === JSON.stringify({ ...INITIAL_STATE, ...before })
  );
}
