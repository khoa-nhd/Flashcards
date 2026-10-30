import { describe, expect, it } from 'vitest';
import { goldenHour } from '../../shared/gamification/economy.js';
import { DAILY_LIMIT, decide, isQuiet, type Candidate, type LeagueMember } from '../../shared/notifications.js';

// A Thursday, 13:00 UTC: 20:00 in Ho Chi Minh City.
const NOW = new Date('2026-10-29T13:00:00Z');
const WEEK = '2026-10-26';

const person = (overrides: Partial<Candidate> = {}): Candidate => ({
  user: 'u1',
  timeZone: 'Asia/Ho_Chi_Minh',
  language: 'vi',
  day: '2026-10-29',
  time: '20:00',
  kinds: { streak: true, league: true, reminder: true, social: true },
  reminderAt: '19:00',
  quietFrom: '23:00',
  quietUntil: '07:00',
  metToday: false,
  streakAlive: true,
  due: 12,
  sent: [],
  state: {},
  leagueResult: null,
  goldenHourOn: false,
  ...overrides,
});

const keys = (candidate: Candidate, league: LeagueMember[] = [], now = NOW) =>
  decide([candidate], league, [], now).sends.map((send) => send.key);

describe('quiet hours', () => {
  it('run over midnight', () => {
    expect(isQuiet('23:30', '23:00', '07:00')).toBe(true);
    expect(isQuiet('06:59', '23:00', '07:00')).toBe(true);
    expect(isQuiet('07:00', '23:00', '07:00')).toBe(false);
    expect(isQuiet('13:00', '12:00', '14:00')).toBe(true);
    expect(isQuiet('13:00', '00:00', '00:00')).toBe(false);
  });

  it('hold back every reminder', () => {
    expect(keys(person({ time: '23:10' }))).toEqual([]);
  });
});

describe('the streak', () => {
  it('reminds at 20:00 and again at 22:30 when today’s goals are not met', () => {
    expect(keys(person({ time: '19:59', kinds: { streak: true, league: false, reminder: false, social: false } }))).toEqual([]);
    expect(keys(person({ kinds: { streak: true, league: false, reminder: false, social: false } }))).toEqual(['streak_2000']);
    expect(
      keys(person({ time: '22:31', sent: ['streak_2000'], kinds: { streak: true, league: false, reminder: false, social: false } })),
    ).toEqual(['streak_2230']);
  });

  it('says nothing once the goals are met, with no streak to lose, or when switched off', () => {
    expect(keys(person({ metToday: true }))).toEqual([]);
    expect(keys(person({ streakAlive: false, kinds: { streak: true, league: false, reminder: false, social: false } }))).toEqual([]);
    expect(keys(person({ kinds: { streak: false, league: false, reminder: false, social: false } }))).toEqual([]);
  });

  it('never sends the same reminder twice a day', () => {
    expect(keys(person({ sent: ['streak_2000'], kinds: { streak: true, league: false, reminder: false, social: false } }))).toEqual([]);
  });
});

describe('the daily reminder', () => {
  const only = { streak: false, league: false, reminder: true, social: false };
  it('goes at the chosen time, with the words waiting, for two hours after', () => {
    const [send] = decide([person({ time: '19:05', kinds: only })], [], [], NOW).sends;
    expect(send).toMatchObject({ key: 'reminder', body: '12 từ đang chờ bạn ôn.', url: '/review' });
    expect(keys(person({ time: '21:01', kinds: only }))).toEqual([]);
    expect(keys(person({ time: '18:59', kinds: only }))).toEqual([]);
    expect(keys(person({ time: '19:05', due: 0, kinds: only }))).toEqual([]);
  });

  it('speaks the account’s language', () => {
    expect(decide([person({ time: '19:05', kinds: only, language: 'en' })], [], [], NOW).sends[0]?.body).toBe('12 words are waiting.');
  });
});

describe('the golden hour', () => {
  it('is announced in the twenty minutes before it starts, when switched on', () => {
    const start = goldenHour('u1', '2026-10-29');
    const before = `${String(start - 1).padStart(2, '0')}:50`;
    const only = { streak: false, league: false, reminder: false, social: true };
    expect(keys(person({ time: before, kinds: only, goldenHourOn: true }))).toEqual(['golden']);
    expect(keys(person({ time: before, kinds: only, goldenHourOn: false }))).toEqual([]);
    expect(keys(person({ time: `${start}:00`, kinds: only, goldenHourOn: true }))).toEqual([]);
  });
});

describe('the daily limit', () => {
  it('sends at most six a day', () => {
    const sent = ['a', 'b', 'c', 'd', 'e'];
    expect(sent.length).toBe(DAILY_LIMIT - 1);
    expect(keys(person({ time: '19:30', sent }))).toHaveLength(1);
    expect(keys(person({ time: '19:30', sent: [...sent, 'f'] }))).toEqual([]);
  });
});

describe('the league', () => {
  const group = (xp: number): LeagueMember[] => [
    { group: 'g1', tier: 3, createdAt: '2026-10-26T00:00:00Z', user: 'u1', xp, joinedAt: '2026-10-26T01:00:00Z' },
  ];
  const only = { streak: false, league: true, reminder: false, social: false };

  it('tells someone pushed out of the promotion zone, once, and remembers where they stand', () => {
    const decision = decide([person({ kinds: only, state: { zone: `${WEEK}:up` } })], group(0), [], NOW);
    expect(decision.sends.map((send) => send.key)).toEqual(['league_overtaken']);
    expect(decision.state).toEqual([{ user: 'u1', key: 'zone', value: `${WEEK}:down` }]);
    // Up top with a huge week: nothing to say, but the zone is remembered for next time.
    const top = decide([person({ kinds: only })], group(1_000_000), [], NOW);
    expect(top.sends).toEqual([]);
    expect(top.state).toEqual([{ user: 'u1', key: 'zone', value: `${WEEK}:up` }]);
  });

  it('warns of the demotion zone on Sunday evening, Vietnam time', () => {
    const sunday = new Date('2026-11-01T12:00:00Z'); // 19:00 in Vietnam
    expect(decide([person({ kinds: only, day: '2026-11-01', time: '19:00' })], group(0), [], sunday).sends.map((send) => send.key)).toEqual(
      ['league_down'],
    );
    expect(keys(person({ kinds: only }), group(0))).toEqual([]);
  });

  it('tells the week’s result once; in quiet hours it waits for the morning', () => {
    const result = { id: 'r1', tier: 4, rank: 2, outcome: 'up' };
    const quiet = decide([person({ kinds: only, time: '23:30', leagueResult: result })], [], [], NOW);
    expect(quiet.sends).toEqual([]);
    expect(quiet.state).toEqual([]);
    const morning = decide([person({ kinds: only, time: '08:00', leagueResult: result })], [], [], NOW);
    expect(morning.sends).toEqual([expect.objectContaining({ key: 'league_result', title: 'Bạn đã lên hạng' })]);
    expect(morning.state).toEqual([{ user: 'u1', key: 'result', value: 'r1' }]);
    expect(keys(person({ kinds: only, time: '08:00', leagueResult: result, state: { result: 'r1' } }))).toEqual([]);
  });
});

describe('friends', () => {
  const only = { streak: false, league: false, reminder: false, social: true };

  it('tells when a friend passes this week, once the friend was behind', () => {
    const passed = decide(
      [person({ kinds: only, state: { 'ahead:u2': `${WEEK}:me` } })],
      [],
      [{ kind: 'friend', user: 'u1', other: 'u2', nickname: 'Bob Fox', myXp: 100, otherXp: 140 }],
      NOW,
    );
    expect(passed.sends).toEqual([expect.objectContaining({ key: 'friend:u2', title: 'Bob Fox vừa vượt bạn' })]);
    expect(passed.state).toEqual([{ user: 'u1', key: 'ahead:u2', value: `${WEEK}:them` }]);
    // First seen already ahead: nothing to say.
    expect(
      decide([person({ kinds: only })], [], [{ kind: 'friend', user: 'u1', other: 'u2', nickname: 'Bob', myXp: 1, otherXp: 9 }], NOW).sends,
    ).toEqual([]);
  });

  it('tells of a new challenge once', () => {
    const challenge = { kind: 'challenge' as const, user: 'u1', other: 'u2', nickname: 'Bob', id: 'c1' };
    const first = decide([person({ kinds: only })], [], [challenge], NOW);
    expect(first.sends.map((send) => send.key)).toEqual(['challenge:c1']);
    expect(decide([person({ kinds: only, state: { 'challenge:c1': 'seen' } })], [], [challenge], NOW).sends).toEqual([]);
  });
});
