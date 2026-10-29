/**
 * Daily and weekly quests (docs/gamification-plan.md, 1.3). Each day three are
 * drawn from the pool, each week one, the same for an account however often
 * they are drawn: the draw is seeded by the account and the period. Targets
 * follow the account's own daily goals.
 */
import type { AnswerReason } from './xp.js';

export type DailyQuestKind =
  | 'due_reviews'
  | 'new_words'
  | 'practice'
  | 'listening'
  | 'extra_reviews'
  | 'added_words'
  | 'combo'
  | 'minutes'
  | 'goal';

export type WeeklyQuestKind = 'week_reviews' | 'week_goal_days' | 'week_mastered' | 'week_practice';

export type QuestKind = DailyQuestKind | WeeklyQuestKind;

export interface Quest {
  period: 'day' | 'week';
  /** The day, or the Monday the week starts on. */
  start: string;
  slot: number;
  kind: QuestKind;
  /** In the quest's own unit: answers, words, seconds (minutes), a combo length, or days. */
  target: number;
  /** XP on completion. */
  reward: number;
  progress: number;
  completedAt: string | null;
}

export interface QuestGoals {
  newWords: number;
  reviews: number;
  practice: number;
}

export const DAILY_QUESTS = 3;
export const WEEKLY_REWARD = 300;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Math.round(value)));

/** The pool, with each quest's target worked out from the goals; a quest that cannot apply is left out. */
function dailyPool(goals: QuestGoals): Array<Pick<Quest, 'kind' | 'target' | 'reward'>> {
  return [
    { kind: 'due_reviews' as const, target: clamp(goals.reviews * 0.6, 5, 200), reward: 30 },
    ...(goals.newWords > 0 ? [{ kind: 'new_words' as const, target: clamp(goals.newWords * 0.6, 1, 50), reward: 30 }] : []),
    { kind: 'practice' as const, target: clamp(goals.practice * 0.6, 5, 100), reward: 25 },
    { kind: 'listening' as const, target: 8, reward: 30 },
    { kind: 'extra_reviews' as const, target: 10, reward: 25 },
    { kind: 'added_words' as const, target: 3, reward: 20 },
    { kind: 'combo' as const, target: 25, reward: 35 },
    { kind: 'minutes' as const, target: 10 * 60, reward: 30 },
    { kind: 'goal' as const, target: 1, reward: 40 },
  ];
}

function weeklyPool(goals: QuestGoals): Array<Pick<Quest, 'kind' | 'target' | 'reward'>> {
  return [
    { kind: 'week_reviews' as const, target: clamp(goals.reviews * 7 * 0.7, 100, 2000), reward: WEEKLY_REWARD },
    { kind: 'week_goal_days' as const, target: 5, reward: WEEKLY_REWARD },
    { kind: 'week_mastered' as const, target: 5, reward: WEEKLY_REWARD },
    { kind: 'week_practice' as const, target: clamp(goals.practice * 7 * 0.6, 50, 1000), reward: WEEKLY_REWARD },
  ];
}

/** A small seeded generator (FNV-1a hash, then mulberry32): the same seed always draws the same. */
export function seededRandom(seed: string): () => number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < seed.length; at += 1) {
    hash ^= seed.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function draw<T>(items: readonly T[], count: number, random: () => number): T[] {
  const left = [...items];
  const chosen: T[] = [];
  while (chosen.length < count && left.length > 0) {
    chosen.push(left.splice(Math.floor(random() * left.length), 1)[0]!);
  }
  return chosen;
}

export function drawDailyQuests(account: string, day: string, goals: QuestGoals): Quest[] {
  return draw(dailyPool(goals), DAILY_QUESTS, seededRandom(`${account}:day:${day}`)).map((quest, slot) => ({
    ...quest,
    period: 'day',
    start: day,
    slot,
    progress: 0,
    completedAt: null,
  }));
}

export function drawWeeklyQuest(account: string, weekStart: string, goals: QuestGoals): Quest {
  const [quest] = draw(weeklyPool(goals), 1, seededRandom(`${account}:week:${weekStart}`));
  return { ...quest!, period: 'week', start: weekStart, slot: 0, progress: 0, completedAt: null };
}

/** What one answer adds to a quest of each counting kind: +1, or the seconds it took. */
export function answerProgress(kind: QuestKind, reason: AnswerReason, mode: string | null, durationMs: number | null, mastered: boolean): number {
  switch (kind) {
    case 'due_reviews':
      return reason === 'due' ? 1 : 0;
    case 'new_words':
      return reason === 'new' ? 1 : 0;
    case 'practice':
    case 'week_practice':
      return reason === 'practice' ? 1 : 0;
    case 'listening':
      return reason === 'practice' && mode === 'listening' ? 1 : 0;
    case 'extra_reviews':
      return reason === 'early' || reason === 'extra' ? 1 : 0;
    case 'week_reviews':
      return reason === 'practice' ? 0 : 1;
    case 'minutes':
      return Math.round(Math.max(0, durationMs ?? 0) / 1000);
    case 'week_mastered':
      return mastered ? 1 : 0;
    default:
      // Set from the day as a whole, not counted per answer: combo, added words, goal, goal days.
      return 0;
  }
}
