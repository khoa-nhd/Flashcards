/**
 * Word duels on the service, with the in-memory store and a clock the test
 * moves: matchmaking ends with a rival, answers are judged on the server
 * against sealed answers, own words are saved as practice, and a match ends
 * on time, on health or when given up.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryPvpStore } from '../../server/mock/mock-pvp.js';
import { PvpService, unseal } from '../../server/pvp-service.js';
import { PVP } from '../../shared/pvp.js';
import type { VocabularyCatalog } from '../../server/vocabulary-catalog.js';
import type { PracticeWrite } from '../../server/vocabulary-repository.js';

const KEY = 'k'.repeat(64);

function setup() {
  let clock = Date.parse('2026-10-31T05:00:00Z');
  const now = () => new Date(clock);
  const rewards: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const store = createMemoryPvpStore('me', async () => 'Moon Owl', (reward) => rewards.push(reward), now);
  const entries = Array.from({ length: 12 }, (_, at) => ({ id: `word-${at}`, word: `word${at}`, meaning: `nghĩa ${at}` }));
  const practice: PracticeWrite[] = [];
  const service = new PvpService({
    store,
    account: 'me',
    signingKey: KEY,
    timeZone: 'Asia/Ho_Chi_Minh',
    catalog: { listEntries: async () => ({ entries, invalid: [] }) } as unknown as VocabularyCatalog,
    repository: {
      recordPractice: async (write) => {
        practice.push(write);
        return 'recorded';
      },
    },
    resolve: async () => null,
    leadingPet: async () => null,
    now,
    random: () => 0.5,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  /** The right option for the question on screen, read the way only the server can. */
  const rightFor = async (id: string, index: number) => {
    const found = await store.match(id);
    return unseal(KEY, found!.questions.find((each) => each.idx === index)!.sealed);
  };
  const start = async () => {
    await service.consent();
    await service.join();
    advance(PVP.botAfterMs);
    const tick = await service.tick();
    return tick.matchId!;
  };
  return { service, store, advance, rightFor, start, practice, rewards };
}

describe('matchmaking', () => {
  it('asks for the warning about words to be accepted before a ranked match', async () => {
    const { service } = setup();
    await expect(service.join()).rejects.toMatchObject({ status: 409, code: 'consent' });
  });

  it('waits, then brings a rival after ten seconds', async () => {
    const { service, advance } = setup();
    await service.consent();
    expect(await service.join()).toEqual({ state: 'waiting', matchId: null });
    advance(PVP.botAfterMs - 1000);
    expect((await service.tick()).state).toBe('waiting');
    advance(1000);
    const tick = await service.tick();
    expect(tick.state).toBe('match');
    const match = await service.view(tick.matchId!);
    expect(match).toMatchObject({ mode: 'rival', finished: false, me: { hp: 100 }, them: { hp: 100 } });
    expect(match.them.nickname).toMatch(/\S/);
  });
});

describe('a match', () => {
  it('shows a question with four options and never its answer', async () => {
    const { service, store, start } = setup();
    const id = await start();
    const match = await service.view(id);
    expect(match.question?.options).toHaveLength(4);
    expect(JSON.stringify(match)).not.toMatch(/"answer"/);
    const stored = await store.match(id);
    for (const question of stored!.questions) expect(Object.keys(question).sort()).toEqual(['direction', 'idx', 'options', 'prompt', 'sealed']);
  });

  it('hurts the rival more for a fast right answer, and locks for three seconds after a wrong one', async () => {
    const { service, start, rightFor, advance } = setup();
    const id = await start();
    advance(1000);
    const right = await rightFor(id, 0);
    const fast = await service.answer(id, 0, right.answer);
    expect(fast.last).toMatchObject({ correct: true, crit: true, damage: PVP.crit });
    expect(fast.them.hp).toBe(100 - PVP.crit);

    advance(4000);
    const second = await rightFor(id, 1);
    const slow = await service.answer(id, 1, second.answer);
    expect(slow.last).toMatchObject({ correct: true, crit: false, damage: PVP.hit });

    advance(500);
    const third = await rightFor(id, 2);
    const wrong = await service.answer(id, 2, (third.answer + 1) % 4);
    expect(wrong.last).toMatchObject({ correct: false, right: third.answer });
    expect(wrong.me.lockedUntil).toBeGreaterThan(wrong.now);

    // During the lock the next answer is refused: nothing moves.
    advance(1000);
    const fourth = await rightFor(id, 3);
    const locked = await service.answer(id, 3, fourth.answer);
    expect(locked.last).toBeNull();
    expect(locked.question?.index).toBe(3);
  });

  it('saves answers on one’s own words as practice, which never moves a schedule', async () => {
    const { service, start, rightFor, advance, practice } = setup();
    const id = await start();
    for (let index = 0; index < 6; index += 1) {
      advance(1500);
      const right = await rightFor(id, index);
      await service.answer(id, index, right.answer);
    }
    expect(practice.length).toBeGreaterThan(0);
    expect(practice.length).toBeLessThan(6);
    for (const write of practice) expect(write).toMatchObject({ mode: 'recognition', grading: 'auto', correct: true });
    expect(new Set(practice.map((write) => write.requestId)).size).toBe(practice.length);
  });

  it('lets the rival answer as time passes, and ends when time is up, rated and rewarded once', async () => {
    const { service, start, advance, rewards } = setup();
    const id = await start();
    advance(30_000);
    const midway = await service.view(id);
    expect(midway.them.correct).toBeGreaterThan(0);
    for (let at = 0; at < PVP.durationMs; at += 5000) {
      advance(5000);
      await service.view(id);
    }
    const done = await service.view(id);
    expect(done.finished).toBe(true);
    expect(['won', 'lost', 'draw']).toContain(done.result);
    expect(done.reward).not.toBeNull();
    expect(done.reward!.ratingTo).not.toBe(done.reward!.ratingFrom);
    // Viewing it again settles nothing again.
    await service.view(id);
    expect(rewards.filter((reward) => reward.kind === 'pvp')).toHaveLength(1);
    const lobby = await service.lobby();
    expect(lobby.rating).toBe(done.reward!.ratingTo);
    expect(lobby.recent).toHaveLength(1);
  });

  it('is lost by giving up', async () => {
    const { service, start } = setup();
    const id = await start();
    const gone = await service.forfeit(id);
    expect(gone).toMatchObject({ finished: true, result: 'lost', reason: 'left' });
  });

  it('offers the other side’s words to add, after the match', async () => {
    const { service, start } = setup();
    const id = await start();
    const done = await service.forfeit(id);
    expect(done.words.length).toBeGreaterThan(0);
    for (const word of done.words) expect(word.word).not.toMatch(/^word\d+$/);
  });
});
