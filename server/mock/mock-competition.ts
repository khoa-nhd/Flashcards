/**
 * The sample data's competition, kept in memory like the rest of it: the
 * sample account, two sample players to try friends and challenges with, and
 * league rivals worked out the same way as on the real server. It follows the
 * rules of `game_apply` (the version 18 migration) closely enough to click
 * through every screen, and never leaves the process.
 */
import { randomUUID } from 'node:crypto';
import { addDays, calendarDateInTimeZone, type IsoDate } from '../../shared/dates.js';
import { LEAGUE_TIME_ZONE, weekEndsAt, weekStartsAt } from '../../shared/gamification/league.js';
import type { CompetitionOp, CompetitionStore } from '../competition-service.js';
import type { Reward } from '../../shared/gamification/engine.js';
import { DatabaseError } from '../supabase/supabase-database.js';

interface Player {
  id: string;
  nickname: string;
  frame: string | null;
  title: string | null;
  inLeagues: boolean;
  hidden: boolean;
  totalXp: number;
  weekXp: number;
  badges: Array<{ badge: string; tier: number }>;
  /** How many days in a row, up to yesterday, the player met their goals. */
  streak: number;
  mastered: number;
}

export interface MockCompetitionSource {
  account: string;
  xpBetween(from: string, to: string): number;
  totalXp(): number;
  metDays(): IsoDate[];
  give(reward: Omit<Reward, 'id' | 'createdAt'>): void;
  setEvent?(event: 'goldenHour' | 'sunday' | 'monthly' | 'boss', enabled: boolean): void;
  /** The sample account's items and leading companions. */
  owned?(): Promise<{ items: string[]; leading: string[] }>;
  now?: () => Date;
}

/** The sample players' ids, shaped like real account ids. */
const FRIEND_ONE = '00000000-0000-4000-8000-00000000f001';
const FRIEND_TWO = '00000000-0000-4000-8000-00000000f002';

export function createMemoryCompetitionStore(source: MockCompetitionSource): CompetitionStore {
  const now = source.now ?? (() => new Date());
  const me = source.account;
  const players = new Map<string, Player>([
    [
      FRIEND_ONE,
      {
        id: FRIEND_ONE,
        nickname: 'Mèo Mơ 2048',
        frame: null,
        title: null,
        inLeagues: true,
        hidden: false,
        totalXp: 2600,
        weekXp: 340,
        badges: [
          { badge: 'streak', tier: 2 },
          { badge: 'reviews', tier: 2 },
        ],
        streak: 9,
        mastered: 14,
      },
    ],
    [
      FRIEND_TWO,
      {
        id: FRIEND_TWO,
        nickname: 'Cáo Bạc 3310',
        frame: null,
        title: null,
        inLeagues: true,
        hidden: false,
        totalXp: 900,
        weekXp: 120,
        badges: [{ badge: 'practice', tier: 1 }],
        streak: 3,
        mastered: 2,
      },
    ],
  ]);
  let profile: {
    nickname: string;
    frame: string | null;
    title: string | null;
    inLeagues: boolean;
  } | null = null;
  let tier = 1;
  const groups = new Map<string, { week: IsoDate; tier: number; createdAt: string; finalized: boolean }>();
  const membership = new Map<IsoDate, { group: string; joinedAt: string }>();
  // The first sample player already follows the sample account back.
  const follows = new Set<string>([`${FRIEND_ONE}>${me}`]);
  const blocks = new Set<string>();
  const invites = new Map<string, string>();
  const challenges: Array<{
    id: string;
    week: IsoDate;
    challenger: string;
    opponent: string;
    accepted: boolean;
    settled: boolean;
    winner: string | null;
  }> = [];
  const reports: Array<{
    id: string;
    target: string;
    reason: string;
    createdAt: string;
    resolved: boolean;
  }> = [];

  const weekXp = (week: IsoDate) => source.xpBetween(weekStartsAt(week), weekEndsAt(week));
  const nameOf = (id: string) => (id === me ? (profile?.nickname ?? null) : (players.get(id)?.nickname ?? null));
  const xpOf = (id: string, week: IsoDate) => (id === me ? weekXp(week) : (players.get(id)?.weekXp ?? 0));
  const taken = (nickname: string) => [...players.values()].some((player) => player.nickname.toLowerCase() === nickname.toLowerCase());
  const conflict = () => new DatabaseError('invalid', 'The database rejected a value in this change.', '23505');
  const today = () => calendarDateInTimeZone(now(), LEAGUE_TIME_ZONE);

  return {
    async me(week) {
      return {
        nickname: profile?.nickname ?? null,
        frame: profile?.frame ?? null,
        title: profile?.title ?? null,
        in_leagues: profile?.inLeagues ?? true,
        hidden: false,
        tier,
        week_xp: weekXp(week),
        total_xp: source.totalXp(),
      };
    },

    async apply(op: CompetitionOp) {
      const other = typeof op.other === 'string' ? op.other : null;
      switch (op.op) {
        case 'profile': {
          const nickname = String(op.nickname);
          if (taken(nickname)) throw conflict();
          profile = {
            nickname,
            frame: (op.frame as string | null) ?? null,
            title: (op.title as string | null) ?? null,
            inLeagues: op.inLeagues !== false,
          };
          return null;
        }
        case 'league_join': {
          const week = String(op.week);
          const known = membership.get(week);
          if (known !== undefined) return known.group;
          const id = randomUUID();
          groups.set(id, {
            week,
            tier: Number(op.tier),
            createdAt: now().toISOString(),
            finalized: false,
          });
          membership.set(week, { group: id, joinedAt: now().toISOString() });
          return id;
        }
        case 'league_settle': {
          for (const group of (op.groups as Array<{
            id: string;
            members: Array<{
              user: string;
              tier: number;
              reward: Record<string, unknown>;
            }>;
          }>) ?? []) {
            const known = groups.get(group.id);
            if (known === undefined || known.finalized) continue;
            known.finalized = true;
            for (const member of group.members) {
              if (member.user !== me) continue;
              tier = member.tier;
              source.give({ kind: 'league', payload: member.reward });
            }
          }
          return null;
        }
        case 'follow':
          if (blocks.has(`${me}>${other}`) || blocks.has(`${other}>${me}`))
            throw new DatabaseError('forbidden', 'The database refused this change.', '42501');
          follows.add(`${me}>${other}`);
          return null;
        case 'unfollow':
          follows.delete(`${me}>${other}`);
          return null;
        case 'block':
          blocks.add(`${me}>${other}`);
          follows.delete(`${me}>${other}`);
          follows.delete(`${other}>${me}`);
          return null;
        case 'unblock':
          blocks.delete(`${me}>${other}`);
          return null;
        case 'invite':
          invites.set(String(op.token), me);
          return null;
        case 'invite_accept': {
          const owner = invites.get(String(op.token));
          if (owner === undefined || owner === me)
            throw new DatabaseError('invalid', 'The database rejected a value in this change.', '22023');
          return null;
        }
        case 'challenge': {
          const week = String(op.week);
          if (!challenges.some((each) => each.week === week && each.challenger === me && each.opponent === other)) {
            // The sample player takes it up straight away, so the challenge can be watched.
            challenges.push({
              id: randomUUID(),
              week,
              challenger: me,
              opponent: other!,
              accepted: true,
              settled: false,
              winner: null,
            });
          }
          return null;
        }
        case 'challenge_accept': {
          const challenge = challenges.find((each) => each.id === op.id && each.opponent === me);
          if (challenge !== undefined) challenge.accepted = true;
          return null;
        }
        case 'challenge_settle': {
          const challenge = challenges.find((each) => each.id === op.id && !each.settled);
          if (challenge === undefined) return null;
          challenge.settled = true;
          challenge.winner = (op.winner as string | null) ?? null;
          for (const reward of (op.rewards as Array<{
            user: string;
            payload: Record<string, unknown>;
          }>) ?? []) {
            if (reward.user === me) source.give({ kind: 'challenge', payload: reward.payload });
          }
          return null;
        }
        case 'report':
          reports.push({
            id: randomUUID(),
            target: other!,
            reason: String(op.reason),
            createdAt: now().toISOString(),
            resolved: false,
          });
          return null;
        case 'admin_rename': {
          const player = players.get(other!);
          if (player !== undefined) player.nickname = String(op.nickname);
          for (const report of reports) if (report.target === other) report.resolved = true;
          return null;
        }
        case 'admin_hide': {
          const player = players.get(other!);
          if (player !== undefined) player.hidden = op.hidden !== false;
          for (const report of reports) if (report.target === other) report.resolved = true;
          return null;
        }
        case 'admin_event': {
          const names = { golden_hour: 'goldenHour', sunday: 'sunday', monthly: 'monthly', boss: 'boss' } as const;
          const event = names[String(op.event) as keyof typeof names];
          if (event !== undefined) source.setEvent?.(event, op.enabled !== false);
          return null;
        }
        case 'admin_resolve':
          for (const report of reports) if (report.target === other) report.resolved = true;
          return null;
        default:
          throw new DatabaseError('invalid', 'The database rejected a value in this change.', '22023');
      }
    },

    async board(week) {
      const joined = membership.get(week);
      if (joined === undefined || profile === null) return [];
      const group = groups.get(joined.group)!;
      return [
        {
          group_id: joined.group,
          group_tier: group.tier,
          group_created_at: group.createdAt,
          finalized: group.finalized,
          member_id: me,
          is_me: true,
          nickname: profile.nickname,
          total_xp: source.totalXp(),
          week_xp: weekXp(week),
          joined_at: joined.joinedAt,
        },
      ];
    },

    async unsettled(week) {
      const joined = membership.get(week);
      const group = joined === undefined ? undefined : groups.get(joined.group);
      if (joined === undefined || group === undefined || group.finalized) return [];
      return [
        {
          group_id: joined.group,
          tier: group.tier,
          created_at: group.createdAt,
          member_id: me,
          week_xp: weekXp(week),
          joined_at: joined.joinedAt,
        },
      ];
    },

    async weeksToSettle(before) {
      return [...groups.values()].filter((group) => !group.finalized && group.week < before).map((group) => group.week);
    },

    async profile(nickname) {
      const wanted = nickname.toLowerCase();
      if (profile !== null && profile.nickname.toLowerCase() === wanted) {
        return {
          member_id: me,
          is_me: true,
          nickname: profile.nickname,
          frame: profile.frame,
          title: profile.title,
          total_xp: source.totalXp(),
          tier,
          mastered: 0,
          following: false,
          followed_by: false,
          blocked: false,
        };
      }
      const player = [...players.values()].find((each) => each.nickname.toLowerCase() === wanted && !each.hidden);
      if (player === undefined || blocks.has(`${player.id}>${me}`)) return null;
      return {
        member_id: player.id,
        is_me: false,
        nickname: player.nickname,
        frame: player.frame,
        title: player.title,
        total_xp: player.totalXp,
        tier: 2,
        mastered: player.mastered,
        following: follows.has(`${me}>${player.id}`),
        followed_by: follows.has(`${player.id}>${me}`),
        blocked: blocks.has(`${me}>${player.id}`),
      };
    },

    async badges(member) {
      return member === me ? [] : (players.get(member)?.badges ?? []);
    },

    async streakDays(member) {
      if (member === me) return source.metDays().map((day) => ({ day, covered: false }));
      const player = players.get(member);
      if (player === undefined) return [];
      return Array.from({ length: player.streak }, (_, at) => ({
        day: addDays(today(), -(at + 1)),
        covered: false,
      }));
    },

    async search(query) {
      const wanted = query.toLowerCase();
      return [...players.values()]
        .filter(
          (player) =>
            !player.hidden &&
            player.nickname.toLowerCase().startsWith(wanted) &&
            !blocks.has(`${player.id}>${me}`) &&
            !blocks.has(`${me}>${player.id}`),
        )
        .map((player) => ({
          nickname: player.nickname,
          total_xp: player.totalXp,
          tier: 2,
        }));
    },

    async friends() {
      return [...players.values()]
        .filter((player) => follows.has(`${me}>${player.id}`))
        .map((player) => ({
          member_id: player.id,
          nickname: player.hidden ? null : player.nickname,
          total_xp: player.totalXp,
          tier: 2,
          week_xp: player.weekXp,
          mutual: follows.has(`${player.id}>${me}`),
        }));
    },

    async challenges() {
      return challenges
        .filter((each) => each.challenger === me || each.opponent === me)
        .map((each) => {
          const otherId = each.challenger === me ? each.opponent : each.challenger;
          return {
            id: each.id,
            week_start: each.week,
            mine: each.challenger === me,
            other_id: otherId,
            other_nickname: nameOf(otherId),
            accepted: each.accepted,
            settled: each.settled,
            won: each.settled ? each.winner === me : null,
            my_xp: xpOf(me, each.week),
            other_xp: xpOf(otherId, each.week),
          };
        });
    },

    async isAdmin() {
      return true;
    },

    async showcase(member) {
      if (member === me) {
        const owned = (await source.owned?.()) ?? { items: [], leading: [] };
        return owned.items.map((item) => ({ item_id: item, is_leading: owned.leading.includes(item) }));
      }
      // The first sample player leads a companion and has a few cards.
      return member === FRIEND_ONE
        ? [
            { item_id: 'pet_whale', is_leading: true },
            { item_id: 'card_orion', is_leading: false },
            { item_id: 'card_lyra', is_leading: false },
          ]
        : [];
    },

    async reports() {
      return reports
        .filter((report) => !report.resolved)
        .map((report) => ({
          id: report.id,
          target_id: report.target,
          nickname: nameOf(report.target) ?? '',
          hidden: players.get(report.target)?.hidden ?? false,
          reason: report.reason,
          created_at: report.createdAt,
          reports: reports.filter((each) => each.target === report.target && !each.resolved).length,
        }));
    },
  };
}
