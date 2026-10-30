/**
 * Leagues, nicknames, friends, profiles and moderation, as the server runs
 * them (docs/gamification-plan.md, phase 2).
 *
 * Every write is an operation this server works out and signs (`game_apply`),
 * valid for a minute. Other accounts are read only through functions that
 * return their public columns, and the browser only ever sees them by
 * nickname. League rivals that are not real people are worked out here, from
 * the group, and are never stored or marked as such in any reply.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Challenge, Friend, FriendsResponse, LeagueResponse, LeagueRow, ProfileResponse } from '../shared/api.js';
import { calendarDateInTimeZone, compareDates, type IsoDate } from '../shared/dates.js';
import {
  GROUP_SIZE,
  MOVING,
  TIERS,
  botLevel,
  botXp,
  groupBots,
  leagueWeekOf,
  rankStandings,
  settleGroup,
  weekEndsAt,
  type Bot,
  type GroupToSettle,
} from '../shared/gamification/league.js';
import { BADGES } from '../shared/gamification/badges.js';
import { levelOf } from '../shared/gamification/levels.js';
import { nicknameProblem, randomNickname, tidyNickname, type NicknameProblem } from '../shared/gamification/nickname.js';
import { seededRandom } from '../shared/gamification/quests.js';
import { streakOf } from '../shared/study-goals.js';
import { signGameChange } from './game-service.js';
import { DatabaseError, type VocabularyDatabase } from './supabase/supabase-database.js';

// ---- What the store gives ----

const count = z.coerce.number().int();
/** A one-column result comes back as bare values or as objects, depending on how it is called. */
const single = <T extends z.ZodType>(name: string, value: T) =>
  z
    .union([value, z.object({ [name]: value })])
    .transform(
      (row) => (typeof row === 'object' && row !== null && name in row ? (row as Record<string, unknown>)[name] : row) as z.infer<T>,
    );
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const meRowSchema = z.object({
  nickname: z.string().nullable(),
  frame: z.string().nullable(),
  title: z.string().nullable(),
  in_leagues: z.boolean(),
  hidden: z.boolean(),
  tier: count,
  week_xp: count,
  total_xp: count,
});

export const boardRowSchema = z.object({
  group_id: z.string(),
  group_tier: count,
  group_created_at: z.string(),
  finalized: z.boolean(),
  member_id: z.string(),
  is_me: z.boolean(),
  nickname: z.string().nullable(),
  total_xp: count,
  week_xp: count,
  joined_at: z.string(),
});

export const unsettledRowSchema = z.object({
  group_id: z.string(),
  tier: count,
  created_at: z.string(),
  member_id: z.string(),
  week_xp: count,
  joined_at: z.string(),
});

export const profileRowSchema = z.object({
  member_id: z.string(),
  is_me: z.boolean(),
  nickname: z.string().nullable(),
  frame: z.string().nullable(),
  title: z.string().nullable(),
  total_xp: count,
  tier: count,
  mastered: count,
  following: z.boolean(),
  followed_by: z.boolean(),
  blocked: z.boolean(),
});

export const searchRowSchema = z.object({
  nickname: z.string(),
  total_xp: count,
  tier: count,
});

export const friendRowSchema = z.object({
  member_id: z.string(),
  nickname: z.string().nullable(),
  total_xp: count,
  tier: count,
  week_xp: count,
  mutual: z.boolean(),
});

export const challengeRowSchema = z.object({
  id: z.string(),
  week_start: day,
  mine: z.boolean(),
  other_id: z.string(),
  other_nickname: z.string().nullable(),
  accepted: z.boolean(),
  settled: z.boolean(),
  won: z.boolean().nullable(),
  my_xp: count,
  other_xp: count,
});

export const reportRowSchema = z.object({
  id: z.string(),
  target_id: z.string(),
  nickname: z.string(),
  hidden: z.boolean(),
  reason: z.string(),
  created_at: z.string(),
  reports: count,
});

export type MeRow = z.infer<typeof meRowSchema>;
export type BoardRow = z.infer<typeof boardRowSchema>;
export type UnsettledRow = z.infer<typeof unsettledRowSchema>;
export type ProfileRow = z.infer<typeof profileRowSchema>;
export type SearchRow = z.infer<typeof searchRowSchema>;
export type FriendRow = z.infer<typeof friendRowSchema>;
export type ChallengeRow = z.infer<typeof challengeRowSchema>;
export type ReportRow = z.infer<typeof reportRowSchema>;

/** One signed write (see `game_apply` in the version 18 migration). */
export type CompetitionOp = { op: string } & Record<string, unknown>;

/** Where the competition is kept. */
export interface CompetitionStore {
  me(week: IsoDate): Promise<MeRow>;
  /** Applies an operation; the group id for `league_join`. */
  apply(op: CompetitionOp): Promise<string | null>;
  board(week: IsoDate): Promise<BoardRow[]>;
  unsettled(week: IsoDate): Promise<UnsettledRow[]>;
  weeksToSettle(before: IsoDate): Promise<IsoDate[]>;
  profile(nickname: string): Promise<ProfileRow | null>;
  badges(member: string): Promise<Array<{ badge: string; tier: number }>>;
  /** Met days, and days a freeze covered; only for oneself and those one follows or is followed by. */
  streakDays(member: string): Promise<Array<{ day: IsoDate; covered: boolean }>>;
  search(query: string): Promise<SearchRow[]>;
  friends(week: IsoDate): Promise<FriendRow[]>;
  challenges(): Promise<ChallengeRow[]>;
  isAdmin(): Promise<boolean>;
  reports(): Promise<ReportRow[]>;
}

// ---- The database store ----

/** How long a signed operation stays valid. */
const OP_LIFETIME_MS = 60_000;

export function createDatabaseCompetitionStore(
  database: VocabularyDatabase,
  account: string,
  signingKey: string,
  now: () => Date = () => new Date(),
): CompetitionStore {
  const call = async <T>(
    fn: Parameters<NonNullable<VocabularyDatabase['competitionCall']>>[0],
    args: Record<string, string | null>,
    schema: z.ZodType<T>,
  ) => {
    if (database.competitionCall === undefined) {
      throw new DatabaseError('schema_missing', 'Leagues and friends need the latest database update (version 18).');
    }
    const rows = z.array(schema).safeParse(await database.competitionCall(fn, args));
    if (!rows.success) throw new DatabaseError('unavailable', 'The database returned the league in an unexpected shape.');
    return rows.data;
  };
  return {
    async me(week) {
      const [row] = await call('competition_me', { p_week: week }, meRowSchema);
      if (row === undefined) throw new DatabaseError('unavailable', 'The database did not return the account’s league.');
      return row;
    },
    async apply(op) {
      const payload = JSON.stringify({
        ...op,
        user: account,
        exp: new Date(now().getTime() + OP_LIFETIME_MS).toISOString(),
      });
      const [row] = await call(
        'game_apply',
        {
          p_payload: payload,
          p_signature: signGameChange(payload, signingKey),
        },
        single('result', z.string().nullable()),
      );
      return row ?? null;
    },
    board: (week) => call('league_board', { p_week: week }, boardRowSchema),
    unsettled: (week) => call('league_unsettled', { p_week: week }, unsettledRowSchema),
    async weeksToSettle(before) {
      return call('league_weeks_to_settle', { p_before: before }, single('week_start', day));
    },
    async profile(nickname) {
      const [row] = await call('profile_by_nickname', { p_nickname: nickname }, profileRowSchema);
      return row ?? null;
    },
    badges: (member) => call('profile_badges', { p_user: member }, z.object({ badge: z.string(), tier: count })),
    streakDays: (member) => call('streak_days', { p_user: member }, z.object({ day, covered: z.boolean() })),
    search: (query) => call('profile_search', { p_query: query }, searchRowSchema),
    friends: (week) => call('friends_list', { p_week: week }, friendRowSchema),
    challenges: () => call('challenges_list', {}, challengeRowSchema),
    async isAdmin() {
      const [row] = await call('is_app_admin', {}, single('admin', z.boolean()));
      return row === true;
    },
    reports: () => call('admin_reports', {}, reportRowSchema),
  };
}

// ---- The service ----

export type CompetitionFailure = 'not_found' | 'invalid' | 'taken' | 'forbidden';

export class CompetitionError extends Error {
  constructor(
    public readonly failure: CompetitionFailure,
    message: string,
    public readonly problem: NicknameProblem | 'taken' | null = null,
  ) {
    super(message);
    this.name = 'CompetitionError';
  }
}

export interface CompetitionServiceOptions {
  store: CompetitionStore;
  account: string;
  /** Checked against `ADMIN_EMAILS` before the database's own list of admins. */
  email: string | null;
  adminEmails: readonly string[];
  /** The account's own zone, for its streak's "today". */
  timeZone: string;
  now?: () => Date;
}

/** XP for winning a weekly challenge, and for each side of a draw. */
export const CHALLENGE_XP = { won: 100, draw: 50 } as const;
/** Invite links stop working after this long. */
const INVITE_DAYS = 30;

const isTaken = (error: unknown) => error instanceof DatabaseError && error.code === '23505';

export class CompetitionService {
  private readonly now: () => Date;

  constructor(private readonly options: CompetitionServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private week(): IsoDate {
    return leagueWeekOf(this.now());
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  /** The account's own side, with a random nickname given on the first visit. */
  async me(): Promise<MeRow> {
    const { store, account } = this.options;
    const week = this.week();
    const me = await store.me(week);
    if (me.nickname !== null) return me;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const nickname = randomNickname(`${account}:${attempt}`);
      try {
        await store.apply({
          op: 'profile',
          nickname,
          frame: null,
          title: null,
          inLeagues: true,
        });
        return { ...me, nickname, in_leagues: true };
      } catch (error) {
        if (!isTaken(error)) throw error;
      }
    }
    throw new CompetitionError('taken', 'No free nickname could be found; choose one in Settings.');
  }

  async saveProfile(update: { nickname?: string; inLeagues?: boolean }): Promise<ProfileResponse> {
    const me = await this.me();
    let nickname = me.nickname!;
    if (update.nickname !== undefined) {
      nickname = tidyNickname(update.nickname);
      const problem = nicknameProblem(nickname);
      if (problem !== null) throw new CompetitionError('invalid', 'That nickname cannot be used.', problem);
    }
    try {
      await this.options.store.apply({
        op: 'profile',
        nickname,
        frame: me.frame,
        title: me.title,
        inLeagues: update.inLeagues ?? me.in_leagues,
      });
    } catch (error) {
      if (isTaken(error)) throw new CompetitionError('taken', 'That nickname is taken.', 'taken');
      throw error;
    }
    return this.profile(null);
  }

  // ---- Leagues ----

  /**
   * Settles every finished week that is not settled yet. Whoever looks first
   * after a week ends settles it for everyone; settling twice changes nothing.
   */
  private async settlePastWeeks(): Promise<void> {
    const { store } = this.options;
    for (const week of await store.weeksToSettle(this.week())) {
      const groups = new Map<string, GroupToSettle>();
      for (const row of await store.unsettled(week)) {
        const group = groups.get(row.group_id) ?? {
          id: row.group_id,
          tier: row.tier,
          createdAt: row.created_at,
          members: [],
        };
        group.members.push({
          user: row.member_id,
          xp: row.week_xp,
          joinedAt: row.joined_at,
        });
        groups.set(row.group_id, group);
      }
      const all = [...groups.values()];
      for (let at = 0; at < all.length; at += 50) {
        await store.apply({
          op: 'league_settle',
          week,
          groups: all.slice(at, at + 50).map((group) => ({
            id: group.id,
            members: settleGroup(group, week),
          })),
        });
      }
    }
  }

  async league(): Promise<LeagueResponse> {
    const { store } = this.options;
    await this.settlePastWeeks();
    const week = this.week();
    const me = await this.me();
    let board = await store.board(week);
    // The first XP of the week puts the account in a group of its tier.
    if (board.length === 0 && me.in_leagues && !me.hidden && me.week_xp > 0) {
      await store.apply({ op: 'league_join', week, tier: me.tier });
      board = await store.board(week);
    }
    const first = board[0];
    return {
      available: true,
      reason: null,
      week,
      endsAt: weekEndsAt(week),
      nickname: me.nickname,
      tier: me.tier,
      inLeagues: me.in_leagues,
      weekXp: me.week_xp,
      group: first === undefined ? null : { tier: first.group_tier, rows: this.rows(board, week) },
    };
  }

  private bots(board: readonly BoardRow[]): Bot[] {
    const first = board[0];
    return first === undefined ? [] : groupBots(first.group_id, first.group_tier, board.length);
  }

  private rows(board: readonly BoardRow[], week: IsoDate): LeagueRow[] {
    const first = board[0]!;
    const now = this.now();
    const bots = this.bots(board);
    const cards = new Map<string, { nickname: string | null; level: number; me: boolean }>();
    for (const member of board)
      cards.set(member.member_id, {
        nickname: member.nickname,
        level: levelOf(member.total_xp).level,
        me: member.is_me,
      });
    bots.forEach((bot) =>
      cards.set(`bot:${bot.seat}`, {
        nickname: bot.nickname,
        level: botLevel(bot),
        me: false,
      }),
    );
    const ranked = rankStandings([
      ...board.map((member) => ({
        id: member.member_id,
        xp: member.week_xp,
        joinedAt: member.joined_at,
      })),
      ...bots.map((bot) => ({
        id: `bot:${bot.seat}`,
        xp: botXp(bot, week, now),
        joinedAt: first.group_created_at,
      })),
    ]);
    const size = Math.max(GROUP_SIZE, ranked.length);
    return ranked.map((standing) => {
      const card = cards.get(standing.id)!;
      const zone =
        standing.rank <= MOVING && first.group_tier < TIERS
          ? 'up'
          : standing.rank > size - MOVING && first.group_tier > 1
            ? 'down'
            : 'stay';
      return {
        nickname: card.nickname,
        level: card.level,
        xp: standing.xp,
        rank: standing.rank,
        me: card.me,
        zone,
      };
    });
  }

  // ---- Profiles ----

  /** A profile by nickname, or one's own for `null`. */
  async profile(nickname: string | null): Promise<ProfileResponse> {
    const { store, account } = this.options;
    const me = await this.me();
    const wanted = nickname === null ? me.nickname! : tidyNickname(nickname);
    const row = await store.profile(wanted);
    if (row === null && nickname === null) {
      // One's own, hidden by an admin: only its owner still sees it.
      return {
        nickname: wanted,
        frame: me.frame,
        title: me.title,
        level: levelOf(me.total_xp).level,
        totalXp: me.total_xp,
        tier: me.tier,
        streak: this.streakFrom(await store.streakDays(account)),
        mastered: 0,
        badges: await store.badges(account),
        me: true,
        limited: true,
        following: false,
        followedBy: false,
        blocked: false,
        inLeagues: me.in_leagues,
        admin: await this.isAdmin(),
      };
    }
    if (row === null) {
      // A rival in one's own league is shown as a player who keeps their profile to themselves.
      const board = await store.board(this.week());
      const bot = this.bots(board).find((each) => each.nickname.toLowerCase() === wanted.toLowerCase());
      if (bot === undefined) throw new CompetitionError('not_found', 'No player has that nickname.');
      return this.botProfile(bot, board[0]!.group_tier);
    }
    const [badges, days] = await Promise.all([
      store.badges(row.member_id),
      row.is_me || row.following || row.followed_by ? store.streakDays(row.member_id) : Promise.resolve([]),
    ]);
    return {
      nickname: row.nickname ?? wanted,
      frame: row.frame,
      title: row.title,
      level: levelOf(row.total_xp).level,
      totalXp: row.total_xp,
      tier: row.tier,
      streak: this.streakFrom(days),
      mastered: row.mastered,
      badges,
      me: row.is_me,
      limited: false,
      following: row.following,
      followedBy: row.followed_by,
      blocked: row.blocked,
      ...(row.is_me ? { inLeagues: me.in_leagues, admin: await this.isAdmin() } : {}),
    };
  }

  private botProfile(bot: Bot, tier: number): ProfileResponse {
    const random = seededRandom(`bot-profile:${bot.nickname}`);
    const ids = BADGES.map((badge) => badge.id);
    const badges = ids
      .filter(() => random() < 0.45)
      .slice(0, 4)
      .map((badge) => ({
        badge,
        tier: 1 + Math.floor(random() * Math.min(3, tier)),
      }));
    return {
      nickname: bot.nickname,
      frame: null,
      title: null,
      level: botLevel(bot),
      totalXp: bot.totalXp,
      tier,
      streak: Math.floor(random() * 4 * tier),
      mastered: Math.floor(random() * 15 * tier),
      badges,
      me: false,
      limited: true,
      following: false,
      followedBy: false,
      blocked: false,
    };
  }

  private streakFrom(days: ReadonlyArray<{ day: IsoDate; covered: boolean }>): number {
    const today = this.today();
    const met = days.filter((entry) => !entry.covered).map((entry) => entry.day);
    const covered = days.filter((entry) => entry.covered).map((entry) => entry.day);
    return streakOf(met, today, met.includes(today), covered).current;
  }

  async search(query: string): Promise<Array<{ nickname: string; level: number; tier: number }>> {
    const tidy = tidyNickname(query);
    if ([...tidy].length < 2) return [];
    return (await this.options.store.search(tidy)).map((row) => ({
      nickname: row.nickname,
      level: levelOf(row.total_xp).level,
      tier: row.tier,
    }));
  }

  /** Another player's account, by nickname; never one's own. */
  private async other(nickname: string): Promise<ProfileRow> {
    const row = await this.options.store.profile(tidyNickname(nickname));
    if (row === null) throw new CompetitionError('not_found', 'No player has that nickname.');
    if (row.is_me) throw new CompetitionError('invalid', 'That is your own nickname.');
    return row;
  }

  async follow(nickname: string): Promise<void> {
    await this.me();
    await this.options.store.apply({
      op: 'follow',
      other: (await this.other(nickname)).member_id,
    });
  }

  async unfollow(nickname: string): Promise<void> {
    await this.options.store.apply({
      op: 'unfollow',
      other: (await this.other(nickname)).member_id,
    });
  }

  async block(nickname: string): Promise<void> {
    await this.options.store.apply({
      op: 'block',
      other: (await this.other(nickname)).member_id,
    });
  }

  async unblock(nickname: string): Promise<void> {
    await this.options.store.apply({
      op: 'unblock',
      other: (await this.other(nickname)).member_id,
    });
  }

  async report(nickname: string, reason: string): Promise<void> {
    await this.options.store.apply({
      op: 'report',
      other: (await this.other(nickname)).member_id,
      reason: reason.trim().slice(0, 300),
    });
  }

  // ---- Friends ----

  async invite(): Promise<{ token: string; expiresAt: string }> {
    await this.me();
    const token = randomBytes(18).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + INVITE_DAYS * 86_400_000).toISOString();
    await this.options.store.apply({ op: 'invite', token, expires: expiresAt });
    return { token, expiresAt };
  }

  async acceptInvite(token: string): Promise<void> {
    await this.me();
    try {
      await this.options.store.apply({ op: 'invite_accept', token });
    } catch (error) {
      if (error instanceof DatabaseError && error.failure === 'invalid') {
        throw new CompetitionError('not_found', 'That invite link has expired or does not work.');
      }
      throw error;
    }
  }

  async challenge(nickname: string): Promise<void> {
    const other = await this.other(nickname);
    if (!(other.following && other.followed_by))
      throw new CompetitionError('invalid', 'Challenges are between friends who follow each other.');
    await this.options.store.apply({
      op: 'challenge',
      other: other.member_id,
      week: this.week(),
    });
  }

  async acceptChallenge(id: string): Promise<void> {
    await this.options.store.apply({ op: 'challenge_accept', id });
  }

  /** Decides finished challenges: the most XP in the week wins. */
  private async settleChallenges(rows: readonly ChallengeRow[]): Promise<boolean> {
    const { store, account } = this.options;
    const week = this.week();
    let settled = false;
    let meName: string | null | undefined;
    for (const row of rows) {
      if (row.settled || !row.accepted || compareDates(row.week_start, week) >= 0) continue;
      const draw = row.my_xp === row.other_xp;
      const winner = draw ? null : row.my_xp > row.other_xp ? account : row.other_id;
      meName ??= (await store.me(week)).nickname;
      const payload = (against: string | null, outcome: 'won' | 'draw', xp: number) => ({ xp, week: row.week_start, against, outcome });
      const rewards = draw
        ? [
            {
              user: account,
              payload: payload(row.other_nickname, 'draw', CHALLENGE_XP.draw),
            },
            {
              user: row.other_id,
              payload: payload(meName, 'draw', CHALLENGE_XP.draw),
            },
          ]
        : [
            {
              user: winner,
              payload: payload(winner === account ? row.other_nickname : meName, 'won', CHALLENGE_XP.won),
            },
          ];
      await store.apply({
        op: 'challenge_settle',
        id: row.id,
        winner,
        rewards,
      });
      settled = true;
    }
    return settled;
  }

  async friends(): Promise<FriendsResponse> {
    const { store, account } = this.options;
    const me = await this.me();
    const week = this.week();
    let challengeRows = await store.challenges();
    if (await this.settleChallenges(challengeRows)) challengeRows = await store.challenges();
    const rows = await store.friends(week);
    const mine = rows.some((row) => row.mutual) ? await store.streakDays(account) : [];
    const friends = await Promise.all(
      rows
        .filter((row) => row.nickname !== null)
        .map(async (row): Promise<Friend> => {
          const days = row.mutual ? await store.streakDays(row.member_id) : [];
          return {
            nickname: row.nickname!,
            level: levelOf(row.total_xp).level,
            tier: row.tier,
            weekXp: row.week_xp,
            mutual: row.mutual,
            streak: row.mutual ? this.streakFrom(days) : null,
            sharedStreak: row.mutual ? this.sharedStreak(mine, days) : null,
          };
        }),
    );
    friends.sort((a, b) => b.weekXp - a.weekXp || a.nickname.localeCompare(b.nickname));
    const challenges = challengeRows.map((row): Challenge => ({
      id: row.id,
      week: row.week_start,
      current: row.week_start === week,
      nickname: row.other_nickname,
      mine: row.mine,
      accepted: row.accepted,
      settled: row.settled,
      result: !row.settled ? null : row.won === true ? 'won' : row.my_xp === row.other_xp ? 'draw' : 'lost',
      myXp: row.my_xp,
      otherXp: row.other_xp,
    }));
    return {
      week,
      endsAt: weekEndsAt(week),
      nickname: me.nickname,
      weekXp: me.week_xp,
      friends,
      challenges,
    };
  }

  /** Days in a row both met their goals; a day one of them covered with a freeze keeps it going. */
  private sharedStreak(
    mine: ReadonlyArray<{ day: IsoDate; covered: boolean }>,
    theirs: ReadonlyArray<{ day: IsoDate; covered: boolean }>,
  ): number {
    const standing = (days: ReadonlyArray<{ day: IsoDate; covered: boolean }>) => new Map(days.map((entry) => [entry.day, entry.covered]));
    const a = standing(mine);
    const b = standing(theirs);
    const both = [...a.keys()].filter((key) => b.has(key));
    const met = both.filter((key) => a.get(key) === false && b.get(key) === false);
    const covered = both.filter((key) => !met.includes(key));
    const today = this.today();
    return streakOf(met, today, met.includes(today), covered).current;
  }

  // ---- Moderation ----

  private async isAdmin(): Promise<boolean> {
    const email = this.options.email?.trim().toLowerCase() ?? null;
    if (email === null || !this.options.adminEmails.includes(email)) return false;
    return this.options.store.isAdmin();
  }

  private async needAdmin(): Promise<void> {
    if (!(await this.isAdmin())) throw new CompetitionError('forbidden', 'Only an admin can do that.');
  }

  async reports() {
    await this.needAdmin();
    return (await this.options.store.reports()).map((row) => ({
      id: row.id,
      target: row.target_id,
      nickname: row.nickname,
      hidden: row.hidden,
      reason: row.reason,
      createdAt: row.created_at,
      reports: row.reports,
    }));
  }

  async moderate(target: string, action: 'rename' | 'hide' | 'unhide' | 'resolve'): Promise<void> {
    await this.needAdmin();
    const { store } = this.options;
    if (action === 'resolve') return void (await store.apply({ op: 'admin_resolve', other: target }));
    if (action === 'hide' || action === 'unhide')
      return void (await store.apply({
        op: 'admin_hide',
        other: target,
        hidden: action === 'hide',
      }));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await store.apply({
          op: 'admin_rename',
          other: target,
          nickname: randomNickname(`renamed:${target}:${this.now().getTime()}:${attempt}`),
        });
        return;
      } catch (error) {
        if (!isTaken(error)) throw error;
      }
    }
    throw new CompetitionError('taken', 'No free nickname could be found.');
  }
}
