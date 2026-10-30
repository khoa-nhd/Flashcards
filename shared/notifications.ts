/**
 * Who to remind of what (docs/gamification-plan.md, phase 4). Pure: the
 * timer's run reads what the database says, this decides, and the server
 * claims and sends. Every time here is in the account's own zone, except the
 * league's Sunday evening, which is Vietnam's like the league itself.
 */
import type { IsoDate } from './dates.js';
import { goldenHour } from './gamification/economy.js';
import { GROUP_SIZE, MOVING, TIERS, botXp, groupBots, leagueWeekOf, rankStandings } from './gamification/league.js';

/** At most this many reminders a day, whatever happens. */
export const DAILY_LIMIT = 6;
/** The streak reminders, in the account's own time. */
export const STREAK_TIMES = ['20:00', '22:30'] as const;
/** How long after the chosen time the daily reminder may still go: a late timer still reminds. */
export const REMINDER_WINDOW_MINUTES = 120;
/** How long before the golden hour its reminder goes. */
export const GOLDEN_LEAD_MINUTES = 20;
/** The league's Sunday-evening warning, in Vietnam's time. */
export const DEMOTION_WARNING_FROM = '18:00';

export interface Candidate {
  user: string;
  timeZone: string;
  language: 'vi' | 'en';
  day: IsoDate;
  /** The account's own time of day, HH:MM(:SS). */
  time: string;
  kinds: { streak: boolean; league: boolean; reminder: boolean; social: boolean };
  reminderAt: string;
  quietFrom: string;
  quietUntil: string;
  metToday: boolean;
  streakAlive: boolean;
  due: number;
  /** Reminders already sent today. */
  sent: readonly string[];
  /** What the timer remembered from before. */
  state: Readonly<Record<string, string>>;
  /** The latest league result, if one came in the last two days. */
  leagueResult: { id: string; tier: number; rank: number; outcome: string } | null;
  /** Whether the admin left the golden hour on. */
  goldenHourOn: boolean;
}

export interface LeagueMember {
  group: string;
  tier: number;
  createdAt: string;
  user: string;
  xp: number;
  joinedAt: string;
}

export type Social =
  | { kind: 'friend'; user: string; other: string; nickname: string | null; myXp: number; otherXp: number }
  | { kind: 'challenge'; user: string; other: string; nickname: string | null; id: string };

export interface Reminder {
  user: string;
  day: IsoDate;
  key: string;
  title: string;
  body: string;
  url: string;
}

export interface Decision {
  sends: Reminder[];
  state: Array<{ user: string; key: string; value: string }>;
}

const minutes = (time: string) => {
  const [hours, mins] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
};

/** Whether a time of day falls in the quiet hours, which may run over midnight. */
export function isQuiet(time: string, from: string, until: string): boolean {
  const at = minutes(time);
  const start = minutes(from);
  const end = minutes(until);
  if (start === end) return false;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

const pick = (language: 'vi' | 'en', en: string, vi: string) => (language === 'en' ? en : vi);

/** Where each real member of a group stands now, rivals counted as the league page counts them. */
export function zonesNow(members: readonly LeagueMember[], now: Date): Map<string, 'up' | 'down' | 'stay'> {
  const zones = new Map<string, 'up' | 'down' | 'stay'>();
  const groups = new Map<string, LeagueMember[]>();
  for (const member of members) groups.set(member.group, [...(groups.get(member.group) ?? []), member]);
  const week = leagueWeekOf(now);
  for (const [id, group] of groups) {
    const { tier, createdAt } = group[0]!;
    const bots = groupBots(id, tier, group.length);
    const ranked = rankStandings([
      ...group.map((member) => ({ id: member.user, xp: member.xp, joinedAt: member.joinedAt })),
      ...bots.map((bot) => ({ id: `bot:${bot.seat}`, xp: botXp(bot, week, now), joinedAt: createdAt })),
    ]);
    const size = Math.max(GROUP_SIZE, ranked.length);
    for (const standing of ranked) {
      if (standing.id.startsWith('bot:')) continue;
      const zone = standing.rank <= MOVING && tier < TIERS ? 'up' : standing.rank > size - MOVING && tier > 1 ? 'down' : 'stay';
      zones.set(standing.id, zone);
    }
  }
  return zones;
}

/** Decides one timer run's reminders, and what to remember for the next. */
export function decide(candidates: readonly Candidate[], league: readonly LeagueMember[], social: readonly Social[], now: Date): Decision {
  const decision: Decision = { sends: [], state: [] };
  const zones = zonesNow(league, now);
  const week = leagueWeekOf(now);
  const vietnam = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(vietnam.formatToParts(now).map((part) => [part.type, part.value]));
  const sundayEvening = parts.weekday === 'Sun' && minutes(`${parts.hour}:${parts.minute}`) >= minutes(DEMOTION_WARNING_FROM);

  for (const person of candidates) {
    const { user, day, language: lang } = person;
    const at = minutes(person.time);
    const wanted: Reminder[] = [];
    const want = (key: string, title: string, body: string, url: string) => {
      if (!person.sent.includes(key)) wanted.push({ user, day, key, title, body, url });
    };
    const remember = (key: string, value: string) => {
      if (person.state[key] !== value) decision.state.push({ user, key, value });
    };
    /** Remembered only once its reminder goes (or is not wanted), so quiet hours delay it rather than drop it. */
    const once: Array<{ key: string; state: string; value: string; wanted: boolean }> = [];

    // The streak, before the day is over.
    if (person.kinds.streak && person.streakAlive && !person.metToday) {
      if (at >= minutes(STREAK_TIMES[1])) {
        want(
          'streak_2230',
          pick(lang, 'Your streak ends at midnight', 'Chuỗi ngày sắp đứt'),
          pick(lang, 'A few reviews keep it going.', 'Ôn vài từ trước nửa đêm để giữ chuỗi.'),
          '/review',
        );
      } else if (at >= minutes(STREAK_TIMES[0])) {
        want(
          'streak_2000',
          pick(lang, 'Keep your streak', 'Giữ chuỗi ngày nhé'),
          pick(lang, 'Today’s goals are not met yet.', 'Hôm nay bạn chưa đạt mục tiêu.'),
          '/review',
        );
      }
    }

    // The daily reminder at the chosen time.
    const from = minutes(person.reminderAt);
    if (person.kinds.reminder && !person.metToday && person.due > 0 && at >= from && at < from + REMINDER_WINDOW_MINUTES) {
      want(
        'reminder',
        pick(lang, 'Time to review', 'Đến giờ ôn bài'),
        pick(lang, `${person.due} ${person.due === 1 ? 'word is' : 'words are'} waiting.`, `${person.due} từ đang chờ bạn ôn.`),
        '/review',
      );
    }

    // The golden hour, just before it starts.
    if (person.kinds.social && person.goldenHourOn) {
      const start = goldenHour(user, day) * 60;
      if (start - at > 0 && start - at <= GOLDEN_LEAD_MINUTES) {
        want(
          'golden',
          pick(lang, 'Golden hour is about to start', 'Sắp đến giờ vàng'),
          pick(lang, `Double XP from ${start / 60}:00 for an hour.`, `x2 XP từ ${start / 60}:00 trong một giờ.`),
          '/review',
        );
      }
    }

    // The league: pushed out of the promotion zone, near the bottom on Sunday evening, the week's result.
    const zone = zones.get(user);
    if (zone !== undefined) {
      const before = person.state.zone;
      if (person.kinds.league && before === `${week}:up` && zone !== 'up') {
        want(
          'league_overtaken',
          pick(lang, 'You were pushed out of the promotion zone', 'Bạn vừa bị đẩy khỏi vùng lên hạng'),
          pick(lang, 'A little XP gets you back in.', 'Thêm chút XP để quay lại.'),
          '/league',
        );
      }
      if (person.kinds.league && sundayEvening && zone === 'down') {
        want(
          'league_down',
          pick(lang, 'The week ends tonight', 'Tuần đấu kết thúc tối nay'),
          pick(lang, 'You are in the demotion zone.', 'Bạn đang ở vùng xuống hạng.'),
          '/league',
        );
      }
      remember('zone', `${week}:${zone}`);
    }
    const result = person.leagueResult;
    if (result !== null && person.state.result !== result.id) {
      once.push({ key: 'league_result', state: 'result', value: result.id, wanted: person.kinds.league });
      if (person.kinds.league) {
        const title =
          result.outcome === 'up'
            ? pick(lang, 'Promoted', 'Bạn đã lên hạng')
            : result.outcome === 'down'
              ? pick(lang, 'A new week, a new league', 'Tuần mới, hạng mới')
              : pick(lang, 'The week is over', 'Tuần đấu đã kết thúc');
        want('league_result', title, pick(lang, `You finished #${result.rank}.`, `Bạn về hạng ${result.rank} trong nhóm.`), '/league');
      }
    }

    // Friends.
    for (const entry of social) {
      if (entry.user !== user) continue;
      const name = entry.nickname ?? pick(lang, 'A friend', 'Một người bạn');
      if (entry.kind === 'friend') {
        const ahead = entry.otherXp > entry.myXp ? 'them' : 'me';
        const key = `ahead:${entry.other}`;
        if (person.kinds.social && person.state[key] === `${week}:me` && ahead === 'them') {
          want(
            `friend:${entry.other}`,
            pick(lang, `${name} passed you`, `${name} vừa vượt bạn`),
            pick(lang, 'Win this week back.', 'Giành lại vị trí tuần này nhé.'),
            '/friends',
          );
        }
        remember(key, `${week}:${ahead}`);
      } else {
        const key = `challenge:${entry.id}`;
        if (person.state[key] === undefined) {
          once.push({ key, state: key, value: 'seen', wanted: person.kinds.social });
          if (person.kinds.social)
            want(
              key,
              pick(lang, `${name} challenged you`, `${name} thách đấu bạn`),
              pick(lang, 'Most XP this week wins.', 'Ai nhiều XP hơn trong tuần sẽ thắng.'),
              '/friends',
            );
        }
      }
    }

    // Quiet hours and the daily limit keep only what may go now.
    const going = isQuiet(person.time, person.quietFrom, person.quietUntil)
      ? []
      : wanted.slice(0, Math.max(0, DAILY_LIMIT - person.sent.length));
    decision.sends.push(...going);
    for (const entry of once) {
      if (!entry.wanted || going.some((send) => send.key === entry.key)) remember(entry.state, entry.value);
    }
  }
  return decision;
}
