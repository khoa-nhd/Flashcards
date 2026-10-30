/**
 * The weekly boss on the game service: made of the weakest words, worn down
 * by practice answers, and rewarding its win once.
 */
import { describe, expect, it } from 'vitest';
import { GameService, createMemoryGameStore } from '../../server/game-service.js';
import type { VocabularyRepository } from '../../server/vocabulary-repository.js';

const NOW = new Date('2026-10-29T05:00:00Z');

function setup(weak: number) {
  const practice: Array<{ id: string; correct: boolean; at: string }> = [];
  const store = createMemoryGameStore({
    answers: () => [],
    metrics: () => ({ wordsStudied: 0, mastered: 0, reviews: 0, practice: 0, durationMs: 0, nightAnswers: 0 }),
    practice: () => practice,
  });
  const words = Array.from({ length: weak }, (_, at) => ({ id: `word-${at}`, word: `word ${at}` }));
  const game = new GameService({
    store,
    account: 'account-1',
    repository: { listMetStudyDays: async () => [] } as unknown as VocabularyRepository,
    goals: () => ({ newWords: 10, reviews: 20, practice: 20 }),
    timeZone: 'Asia/Ho_Chi_Minh',
    now: () => NOW,
    economy: true,
    weakWords: async () => words,
  });
  const answer = (id: string, correct: boolean) => practice.push({ id, correct, at: NOW.toISOString() });
  return { game, store, answer };
}

describe('the weekly boss', () => {
  it('is made of up to fifteen of the weakest words, at full health', async () => {
    const { game } = setup(20);
    const boss = await game.boss();
    expect(boss).toMatchObject({ available: true, hp: 40, won: false });
    expect(boss.words.map((word) => word.id)).toEqual(Array.from({ length: 15 }, (_, at) => `word-${at}`));
  });

  it('needs five weak words', async () => {
    expect(await setup(4).game.boss()).toMatchObject({ available: false });
  });

  it('loses health to remembered practice answers on its words only, and heals on forgotten ones', async () => {
    const { game, answer } = setup(15);
    await game.boss();
    for (let at = 0; at < 10; at += 1) answer('word-1', true);
    answer('word-2', false);
    answer('elsewhere', true);
    expect(await game.boss()).toMatchObject({ hp: 30.5, correct: 10, wrong: 1 });
  });

  it('gives its reward and the boss slayer title once when beaten', async () => {
    const { game, store, answer } = setup(15);
    await game.boss();
    for (let at = 0; at < 40; at += 1) answer('word-3', true);
    expect(await game.boss()).toMatchObject({ hp: 0, won: true });
    await game.boss();
    const snapshot = await store.snapshot('2026-10-29', '2026-10-26');
    expect(snapshot.rewards.filter((reward) => reward.kind === 'boss')).toHaveLength(1);
    expect(snapshot.rewards.find((reward) => reward.kind === 'boss')?.payload).toMatchObject({ xp: 300, stardust: 200 });
    expect(snapshot.inventory).toContain('title_boss');
    expect(snapshot.state.bossWins).toBe(1);
    expect(snapshot.badges.map((badge) => `${badge.badge}:${badge.tier}`)).toContain('boss:1');
  });
});
