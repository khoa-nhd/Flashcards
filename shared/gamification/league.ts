/**
 * Weekly leagues (docs/gamification-plan.md, 2.2 and 2.3). Pure, so the
 * server, the sample data and the tests rank and settle the same way.
 *
 * Every group shows twenty seats. Seats no real person holds are simulated
 * rivals: worked out from the group's id and the time alone, never stored,
 * so every look at the board agrees and their XP only ever goes up.
 */
import { addDays, calendarDateInTimeZone, type IsoDate } from '../dates.js';
import { weekStartOf } from './engine.js';
import { levelOf } from './levels.js';
import { randomNickname } from './nickname.js';
import { seededRandom } from './quests.js';

export const TIERS = 8;
export const GROUP_SIZE = 20;
/** How many go up from the top, and down from the bottom. */
export const MOVING = 5;
/** Leagues share one clock: a week runs from Monday 00:00 to Sunday 24:00 in Vietnam. */
export const LEAGUE_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const OFFSET = '+07:00';

export type Outcome = 'up' | 'down' | 'stay';

/** The Monday of the league week `now` is in. */
export function leagueWeekOf(now: string | Date): IsoDate {
  return weekStartOf(calendarDateInTimeZone(new Date(now), LEAGUE_TIME_ZONE));
}

/** When a league week starts, as an instant. */
export function weekStartsAt(week: IsoDate): string {
  return new Date(`${week}T00:00:00${OFFSET}`).toISOString();
}

/** When a league week ends, as an instant. */
export function weekEndsAt(week: IsoDate): string {
  return weekStartsAt(addDays(week, 7));
}

// ---- Simulated rivals ----

export type Personality = 'lazy' | 'steady' | 'weekend' | 'grinder';

export interface Bot {
  /** Stable within the group: the seat it was drawn for. */
  seat: number;
  nickname: string;
  personality: Personality;
  /** XP by the end of the week. */
  target: number;
  /** The XP total its level is shown from. */
  totalXp: number;
  /** When each study session starts (ms after the week starts) and the XP it brings. */
  sessions: Array<{ start: number; xp: number }>;
}

/** A steady rival's week in each tier, before each rival's own spread. Real data can replace it later. */
export const BOT_WEEK_XP = [250, 340, 460, 620, 840, 1130, 1530, 2070] as const;

const PERSONALITY_SHARE: Array<[Personality, number]> = [
  ['lazy', 0.3],
  ['steady', 0.45],
  ['weekend', 0.2],
  ['grinder', 0.05],
];
const PERSONALITY_SCALE: Record<Personality, number> = {
  lazy: 0.25,
  steady: 1,
  weekend: 1.1,
  grinder: 3,
};
/** The chance of a day off, on a weekday and at the weekend. */
const DAY_OFF: Record<Personality, [number, number]> = {
  lazy: [0.55, 0.6],
  steady: [0.15, 0.25],
  weekend: [0.35, 0.05],
  grinder: [0.03, 0.03],
};
const DAY_WEIGHT: Record<Personality, [number, number]> = {
  lazy: [1, 1],
  steady: [1, 1],
  weekend: [0.5, 2.5],
  grinder: [1, 1.2],
};

const HOUR = 3_600_000;
const SESSION = 25 * 60_000;

function personalityOf(random: () => number): Personality {
  let roll = random();
  for (const [personality, share] of PERSONALITY_SHARE) {
    if (roll < share) return personality;
    roll -= share;
  }
  return 'steady';
}

/** The rival drawn for a seat of a group. The same group and seat always give the same rival. */
export function botFor(groupId: string, tier: number, seat: number): Bot {
  const random = seededRandom(`bot:${groupId}:${seat}`);
  const personality = personalityOf(random);
  const spread = 0.6 + random() * 0.8;
  const target = Math.max(20, Math.round(BOT_WEEK_XP[Math.min(TIERS, Math.max(1, tier)) - 1]! * PERSONALITY_SCALE[personality] * spread));

  // Which days it studies, how much of the week each gets, and at what hours.
  const days = Array.from({ length: 7 }, (_, day): number => {
    const weekend = day >= 5 ? 1 : 0;
    const off = random() < DAY_OFF[personality][weekend];
    return off ? 0 : DAY_WEIGHT[personality][weekend] * (0.6 + random() * 0.8);
  });
  if (!days.some((weight) => weight > 0)) days[Math.floor(random() * 7)] = 1;
  const total = days.reduce((sum, weight) => sum + weight, 0);
  const sessions: Bot['sessions'] = [];
  days.forEach((weight, day) => {
    if (weight === 0) return;
    const count = 1 + Math.floor(random() * (personality === 'grinder' ? 4 : 3));
    const dayXp = (target * weight) / total;
    for (let at = 0; at < count; at += 1) {
      // Mostly mornings, lunchtimes and evenings, between 6:00 and 23:00.
      const hour = 6 + Math.floor(random() * 17);
      const start = day * 24 * HOUR + hour * HOUR + Math.floor(random() * 60) * 60_000;
      sessions.push({ start, xp: dayXp / count });
    }
  });
  sessions.sort((a, b) => a.start - b.start);

  const level = Math.max(1, Math.round(tier * 3 + random() * 8 - 2));
  let totalXp = 0;
  for (let step = 1; step < level; step += 1) totalXp += Math.round(100 * 1.15 ** (step - 1));
  totalXp += Math.floor(random() * 80);

  return {
    seat,
    nickname: randomNickname(`bot:${groupId}:${seat}`),
    personality,
    target,
    totalXp,
    sessions,
  };
}

/** A rival's XP at a moment of the week: never less than a moment before. */
export function botXp(bot: Bot, week: IsoDate, now: string | Date): number {
  const elapsed = new Date(now).getTime() - Date.parse(weekStartsAt(week));
  if (elapsed <= 0) return 0;
  let xp = 0;
  for (const session of bot.sessions) {
    if (elapsed <= session.start) break;
    xp += session.xp * Math.min(1, (elapsed - session.start) / SESSION);
  }
  return Math.floor(xp);
}

/**
 * The rivals filling a group's empty seats. When a real person joins, the
 * rival with the smallest week leaves; which ones stay never depends on the time.
 */
export function groupBots(groupId: string, tier: number, realMembers: number): Bot[] {
  const seats = Math.max(0, GROUP_SIZE - realMembers);
  return Array.from({ length: GROUP_SIZE }, (_, seat) => botFor(groupId, tier, seat))
    .sort((a, b) => b.target - a.target || a.seat - b.seat)
    .slice(0, seats);
}

/** The level a rival's card shows, as a real person's would be worked out. */
export function botLevel(bot: Bot): number {
  return levelOf(bot.totalXp).level;
}

// ---- Ranking and settling ----

export interface Standing {
  /** A real member's account, or `bot:<seat>`. */
  id: string;
  xp: number;
  /** Earlier joiners rank first on equal XP. */
  joinedAt: string;
}

export interface Ranked extends Standing {
  rank: number;
}

/** Most XP first; on a tie, whoever joined first. */
export function rankStandings(standings: readonly Standing[]): Ranked[] {
  return [...standings]
    .sort((a, b) => b.xp - a.xp || a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id))
    .map((standing, at) => ({ ...standing, rank: at + 1 }));
}

/** Where a rank leaves someone: the top five go up, the bottom five down; Bronze never goes down, Star never up. */
export function outcomeOf(rank: number, size: number, tier: number, xp: number): Outcome {
  if (xp <= 0) return 'stay';
  if (rank <= MOVING && tier < TIERS) return 'up';
  if (rank > size - MOVING && tier > 1) return 'down';
  return 'stay';
}

export function tierAfter(tier: number, outcome: Outcome): number {
  if (outcome === 'up') return Math.min(TIERS, tier + 1);
  if (outcome === 'down') return Math.max(1, tier - 1);
  return tier;
}

export interface GroupToSettle {
  id: string;
  tier: number;
  createdAt: string;
  members: Array<{ user: string; xp: number; joinedAt: string }>;
}

export interface SettledMember {
  user: string;
  rank: number;
  xp: number;
  outcome: Outcome;
  tier: number;
  reward: {
    week: IsoDate;
    from: number;
    tier: number;
    rank: number;
    outcome: Outcome;
    xp?: number;
  };
}

/** A finished week's result for each real member of a group, rivals counted at the week's end. */
export function settleGroup(group: GroupToSettle, week: IsoDate): SettledMember[] {
  const end = weekEndsAt(week);
  const bots = groupBots(group.id, group.tier, group.members.length);
  const ranked = rankStandings([
    ...group.members.map((member) => ({
      id: member.user,
      xp: member.xp,
      joinedAt: member.joinedAt,
    })),
    ...bots.map((bot) => ({
      id: `bot:${bot.seat}`,
      xp: botXp(bot, week, end),
      joinedAt: group.createdAt,
    })),
  ]);
  const size = ranked.length;
  return ranked
    .filter((standing) => !standing.id.startsWith('bot:'))
    .map((standing) => {
      const outcome = outcomeOf(standing.rank, size, group.tier, standing.xp);
      const tier = tierAfter(group.tier, outcome);
      return {
        user: standing.id,
        rank: standing.rank,
        xp: standing.xp,
        outcome,
        tier,
        reward: { week, from: group.tier, tier, rank: standing.rank, outcome },
      };
    });
}
