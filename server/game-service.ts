/**
 * The game, as the server runs it (docs/gamification-plan.md, phase 1). The
 * rules are the shared engine's; this file reads what they need, hands the
 * engine's change to a store, and turns the result into what the page shows.
 *
 * It only reads saved answers. Nothing here can change what is due.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { AnswerGame, GameResponse } from '../shared/api.js';
import { calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import { BADGES, type BadgeId, type BadgeMetrics } from '../shared/gamification/badges.js';
import { streakOf } from '../shared/study-goals.js';
import {
  INITIAL_STATE,
  claim,
  isEmpty,
  sync,
  weekStartOf,
  type GameChange,
  type GameSnapshot,
  type GameStateData,
  type Reward,
  type RewardKind,
  type Undone,
} from '../shared/gamification/engine.js';
import { levelOf } from '../shared/gamification/levels.js';
import type { Quest, QuestGoals, QuestKind } from '../shared/gamification/quests.js';
import { FREEZE_MAX } from '../shared/gamification/streak.js';
import { comboBonus, type AnswerEvent } from '../shared/gamification/xp.js';
import type { GameSnapshotRows, VocabularyDatabase } from './supabase/supabase-database.js';
import { DatabaseError } from './supabase/supabase-database.js';
import type { VocabularyCatalog } from './vocabulary-catalog.js';
import type { VocabularyRepository } from './vocabulary-repository.js';

/** Totals the badges read; the streak and the combo come from the engine. */
export type GameMetrics = Omit<BadgeMetrics, 'longestStreak' | 'longestCombo'>;

/** Where the game is kept. */
export interface GameStore {
  snapshot(today: IsoDate, weekStart: IsoDate): Promise<GameSnapshot>;
  /** Answers not yet counted, oldest first. */
  pendingAnswers(limit: number): Promise<AnswerEvent[]>;
  /** What the ledger gave the answers named, for the undos that take them back. */
  ledger(answerIds: readonly string[]): Promise<Map<string, Undone>>;
  metrics(): Promise<GameMetrics>;
  /** Stores a change; `stale` when the game moved on since its snapshot. */
  commit(change: GameChange): Promise<'ok' | 'stale'>;
}

// ---- The database store: every change is signed ----

/** The signature `game_commit` checks: HMAC-SHA256 of the exact payload text, in hex. */
export function signGameChange(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

function snapshotFromRows(rows: GameSnapshotRows): GameSnapshot {
  return {
    version: rows.state?.version ?? 0,
    totalXp: rows.state?.total_xp ?? 0,
    state: { ...INITIAL_STATE, ...(rows.state?.state as Partial<GameStateData> | undefined) },
    quests: rows.quests.map(
      (row): Quest => ({
        period: row.period,
        start: row.period_start,
        slot: row.slot,
        kind: row.kind as QuestKind,
        target: row.target,
        reward: row.reward,
        progress: row.progress,
        completedAt: row.completed_at,
      }),
    ),
    badges: rows.badges.map((row) => ({ badge: row.badge as BadgeId, tier: row.tier, earnedAt: row.earned_at })),
    freezes: rows.freezes.map((row) => ({ id: row.id, grantedOn: row.granted_on, usedOn: row.used_on })),
    rewards: rows.rewards.map((row) => ({
      id: row.id,
      kind: row.kind as RewardKind,
      payload: row.payload as Reward['payload'],
      createdAt: row.created_at,
    })),
  };
}

export function createDatabaseGameStore(database: VocabularyDatabase, account: string, signingKey: string): GameStore {
  const need = <T>(method: T | undefined): T => {
    if (method === undefined) throw new DatabaseError('schema_missing', 'The game needs the latest database update.');
    return method;
  };
  return {
    async snapshot(today, weekStart) {
      return snapshotFromRows(await need(database.gameSnapshot).call(database, today, weekStart));
    },
    async pendingAnswers(limit) {
      const rows = await need(database.gamePendingAnswers).call(database, limit);
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        undoes: row.undoes,
        at: row.answered_at,
        on: row.answered_on,
        isNew: row.is_new,
        counted: row.counted,
        wasDue: row.was_due,
        durationMs: row.duration_ms,
        mode: row.mode,
        mastered: row.mastered,
        recordedAt: row.recorded_at ?? null,
      }));
    },
    async ledger(answerIds) {
      const rows = await need(database.gameLedger).call(database, answerIds);
      return new Map(rows.map((row) => [row.source_id, { amount: row.amount, reason: row.reason, on: row.earned_on }]));
    },
    async metrics() {
      const row = await need(database.gameBadgeMetrics).call(database);
      return {
        wordsStudied: row.words_studied,
        mastered: row.mastered,
        reviews: row.reviews,
        practice: row.practice,
        durationMs: row.duration_ms,
        nightAnswers: row.night_answers,
      };
    },
    async commit(change) {
      const payload = JSON.stringify({ user: account, ...change });
      try {
        const result = await need(database.gameCommit).call(database, payload, signGameChange(payload, signingKey));
        return result.outcome;
      } catch (error) {
        // The only refusal a change signed here can meet is a key the database does not share.
        if (error instanceof DatabaseError && error.failure === 'forbidden') {
          throw new DatabaseError(
            'forbidden',
            'The game signing key on the server does not match the one in the database.',
            error.code,
          );
        }
        throw error;
      }
    },
  };
}

// ---- The memory store: the sample data's, kept for as long as the server runs ----

export interface MemoryGameStore extends GameStore {
  /** XP earned from `from` (inclusive) to `to`: what the sample league counts. */
  xpBetween(from: string, to: string): number;
  /** Adds a reward from outside the game, as a league or a challenge does. */
  give(reward: Omit<Reward, 'id' | 'createdAt'>): void;
}

export function createMemoryGameStore(source: { answers(): AnswerEvent[]; metrics(): GameMetrics }): MemoryGameStore {
  let version = 0;
  let state: GameStateData = { ...INITIAL_STATE };
  const ledger = new Map<string, { source: string; amount: number; reason: string; on: IsoDate; at: string }>();
  const quests = new Map<string, Quest>();
  const badges = new Map<string, { badge: BadgeId; tier: number; earnedAt: string }>();
  const freezes = new Map<string, { id: string; grantedOn: IsoDate; usedOn: IsoDate | null }>();
  const rewards = new Map<string, Reward & { claimed: boolean }>();
  const key = (quest: Pick<Quest, 'period' | 'start' | 'slot'>) => `${quest.period}:${quest.start}:${quest.slot}`;

  return {
    xpBetween(from, to) {
      const [start, end] = [Date.parse(from), Date.parse(to)];
      return [...ledger.values()].filter((entry) => Date.parse(entry.at) >= start && Date.parse(entry.at) < end).reduce((sum, entry) => sum + entry.amount, 0);
    },
    give(reward) {
      const id = randomUUID();
      rewards.set(id, { ...reward, id, createdAt: new Date().toISOString(), claimed: false });
    },
    async snapshot(today, weekStart) {
      return {
        version,
        totalXp: [...ledger.values()].reduce((sum, entry) => sum + entry.amount, 0),
        state: { ...state },
        quests: [...quests.values()].filter(
          (quest) => (quest.period === 'day' && quest.start === today) || (quest.period === 'week' && quest.start === weekStart),
        ),
        badges: [...badges.values()],
        freezes: [...freezes.values()],
        rewards: [...rewards.values()]
          .filter((reward) => !reward.claimed)
          .map((reward) => ({ id: reward.id, kind: reward.kind, payload: reward.payload, createdAt: reward.createdAt })),
      };
    },
    async pendingAnswers(limit) {
      return source
        .answers()
        .filter((answer) => !ledger.has(`answer:${answer.id}`))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async ledger(answerIds) {
      return new Map(
        answerIds.flatMap((id) => {
          const entry = ledger.get(`answer:${id}`);
          return entry === undefined ? [] : [[id, { amount: entry.amount, reason: entry.reason, on: entry.on }]];
        }),
      );
    },
    async metrics() {
      return source.metrics();
    },
    async commit(change) {
      if (change.version !== version) return 'stale';
      for (const entry of change.ledger) {
        const id = `${entry.source}:${entry.sourceId}`;
        if (!ledger.has(id)) ledger.set(id, { source: entry.source, amount: entry.amount, reason: entry.reason, on: entry.on, at: entry.at });
      }
      for (const quest of change.quests) {
        const known = quests.get(key(quest));
        quests.set(key(quest), { ...quest, completedAt: known?.completedAt ?? quest.completedAt });
      }
      for (const badge of change.badges) {
        const id = `${badge.badge}:${badge.tier}`;
        if (!badges.has(id)) badges.set(id, { ...badge, earnedAt: new Date().toISOString() });
      }
      for (const freeze of change.freezes) {
        const known = freezes.get(freeze.id);
        freezes.set(freeze.id, { ...freeze, usedOn: known?.usedOn ?? freeze.usedOn });
      }
      for (const reward of change.rewards) if (!rewards.has(reward.id)) rewards.set(reward.id, { ...reward, claimed: false });
      for (const id of change.claimed) {
        const reward = rewards.get(id);
        if (reward !== undefined) reward.claimed = true;
      }
      state = change.state;
      version += 1;
      return 'ok';
    },
  };
}

// ---- The service ----

export interface GameServiceOptions {
  store: GameStore;
  /** The account's id: seeds its quests. */
  account: string;
  repository: VocabularyRepository;
  /** Where the words are listed, to count those added today. */
  catalog?: VocabularyCatalog;
  goals: () => QuestGoals;
  timeZone: string;
  now?: () => Date;
  newId?: () => string;
}

/** Answers counted per round; a long history is counted over several rounds. */
const BATCH = 2000;
const MAX_ROUNDS = 40;
const RETRIES = 3;

interface DayFacts {
  metDays: readonly IsoDate[];
  metToday: boolean;
  addedToday: number;
}

export class GameService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** XP the answers counted by syncs have earned, and how many syncs there were: see `mark`. */
  private gained = 0;
  private syncs = 0;
  private last: GameSnapshot | null = null;
  /** The totals the last badge check read, with the streak and combo it worked out. */
  private values: BadgeMetrics | null = null;

  constructor(private readonly options: GameServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  private async facts(given: Partial<DayFacts>): Promise<DayFacts> {
    const today = this.today();
    const metDays = given.metDays ?? (await this.options.repository.listMetStudyDays?.()) ?? [];
    const metToday = given.metToday ?? metDays.includes(today);
    let addedToday = given.addedToday;
    if (addedToday === undefined) {
      const catalog = this.options.catalog;
      addedToday = catalog === undefined ? 0 : (await catalog.listEntries()).entries.filter((entry) => entry.dateAdded === today).length;
    }
    return { metDays, metToday, addedToday };
  }

  /**
   * Counts every answer not yet counted, then settles quests, freezes, badges
   * (when asked: they read totals over the whole history) and the level.
   */
  async sync(options: Partial<DayFacts> & { badges?: boolean } = {}): Promise<GameSnapshot> {
    const { store } = this.options;
    const today = this.today();
    const weekStart = weekStartOf(today);
    const facts = await this.facts(options);
    const metrics = options.badges === true ? await store.metrics() : null;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let answers: AnswerEvent[] = [];
      for (let attempt = 0; attempt < RETRIES; attempt += 1) {
        const snapshot = await store.snapshot(today, weekStart);
        answers = await store.pendingAnswers(BATCH);
        const inBatch = new Set(answers.map((answer) => answer.id));
        const earlier = answers.flatMap((answer) =>
          answer.kind === 'undo' && answer.undoes !== null && !inBatch.has(answer.undoes) ? [answer.undoes] : [],
        );
        const change = sync(snapshot, {
          account: this.options.account,
          now: this.now().toISOString(),
          today,
          goals: this.options.goals(),
          answers,
          undone: await store.ledger(earlier),
          metDays: facts.metDays,
          metToday: facts.metToday,
          addedToday: facts.addedToday,
          // Without fresh totals only the streak and combo badges, which the engine knows itself, can be reached.
          metrics: metrics ?? { wordsStudied: 0, mastered: 0, reviews: 0, practice: 0, durationMs: 0, nightAnswers: 0 },
          newId: this.newId,
        });
        if (isEmpty(change, snapshot.state)) break;
        if ((await store.commit(change)) === 'ok') {
          this.gained += change.ledger
            // An undo counts here as what it took back, so the reply to it shows the XP going.
            .filter((entry) => entry.source === 'answer')
            .reduce((sum, entry) => sum + entry.amount, 0);
          break;
        }
        // Stale: the game moved on meanwhile, so it is worked out again from a fresh snapshot.
      }
      // Caught up once a round counted fewer answers than a full batch.
      if (answers.length < BATCH) break;
    }
    this.last = await store.snapshot(today, weekStart);
    this.syncs += 1;
    if (metrics !== null) {
      const covered = this.last.freezes.flatMap((freeze) => (freeze.usedOn === null ? [] : [freeze.usedOn]));
      this.values = {
        ...metrics,
        longestStreak: streakOf(facts.metDays, today, facts.metToday, covered).longest,
        longestCombo: this.last.state.longestCombo,
      };
    }
    return this.last;
  }

  /**
   * Where the game stands before a request's work, so that what the work earned
   * can be told apart from earlier requests' (the sample data keeps one service
   * for every request).
   */
  mark(): { gained: number; syncs: number } {
    return { gained: this.gained, syncs: this.syncs };
  }

  /**
   * What the reply to an answer carries: what was earned since `mark`. Counts
   * the answer first unless a sync since then (the daily goals') already has.
   */
  async answerSince(mark: { gained: number; syncs: number }): Promise<AnswerGame> {
    const snapshot = this.syncs > mark.syncs && this.last !== null ? this.last : await this.sync();
    return this.summary(snapshot, this.gained - mark.gained);
  }

  private summary(snapshot: GameSnapshot, xp: number): AnswerGame {
    const combo = snapshot.state.combo;
    return { xp, totalXp: snapshot.totalXp, level: levelOf(snapshot.totalXp).level, combo, comboBonus: comboBonus(combo) };
  }

  /** The days streak freezes covered, after spending any that a missed day calls for. */
  async coveredDays(facts: Partial<DayFacts> = {}): Promise<IsoDate[]> {
    const used = (snapshot: GameSnapshot) => snapshot.freezes.flatMap((freeze) => (freeze.usedOn === null ? [] : [freeze.usedOn]));
    try {
      return used(await this.sync(facts));
    } catch (error) {
      // Spending a freeze needs a signed change; reading the ones already spent does not. So a
      // game that cannot write (its key not set, or not matching) still shows the streak as it
      // stands, and the goals are not lost with it. The failure is logged; reading again is not
      // hidden: if that fails too, it is reported.
      if (!(error instanceof DatabaseError)) throw error;
      console.error(`Settling streak freezes failed: database ${error.failure}`);
      const today = this.today();
      return used(await this.options.store.snapshot(today, weekStartOf(today)));
    }
  }

  async state(): Promise<GameResponse> {
    return this.view(await this.sync({ badges: true }));
  }

  async claim(ids: readonly string[] | 'all'): Promise<GameResponse> {
    const { store } = this.options;
    const today = this.today();
    const weekStart = weekStartOf(today);
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const snapshot = await store.snapshot(today, weekStart);
      const wanted = ids === 'all' ? snapshot.rewards.map((reward) => reward.id) : ids;
      const change = claim(snapshot, wanted, this.now().toISOString(), today, this.newId);
      if (change.claimed.length === 0) break;
      if ((await store.commit(change)) === 'ok') break;
    }
    return this.state();
  }

  async saveSettings(settings: { earlyDays: number }): Promise<GameResponse> {
    const { store } = this.options;
    const today = this.today();
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const snapshot = await store.snapshot(today, weekStartOf(today));
      const change: GameChange = {
        version: snapshot.version,
        state: { ...snapshot.state, earlyDays: settings.earlyDays },
        ledger: [],
        quests: [],
        badges: [],
        freezes: [],
        rewards: [],
        claimed: [],
      };
      if ((await store.commit(change)) === 'ok') break;
    }
    return this.state();
  }

  /** How many days ahead "review early" reaches for this account. */
  async earlyDays(): Promise<number> {
    const today = this.today();
    const snapshot = this.last ?? (await this.options.store.snapshot(today, weekStartOf(today)));
    return snapshot.state.earlyDays;
  }

  private view(snapshot: GameSnapshot): GameResponse {
    const today = this.today();
    const weekStart = weekStartOf(today);
    const quest = (each: Quest) => ({
      period: each.period,
      kind: each.kind,
      target: each.target,
      progress: Math.min(each.progress, each.target),
      reward: each.reward,
      completed: each.completedAt !== null,
    });
    const week = snapshot.quests.find((each) => each.period === 'week' && each.start === weekStart);
    const combo = snapshot.state.combo;
    const comebackUntil =
      snapshot.state.comebackUntil !== null && Date.parse(snapshot.state.comebackUntil) > this.now().getTime()
        ? snapshot.state.comebackUntil
        : null;
    return {
      available: true,
      reason: null,
      today,
      totalXp: snapshot.totalXp,
      level: levelOf(snapshot.totalXp),
      combo: { count: combo, bonus: comboBonus(combo), longest: snapshot.state.longestCombo },
      comebackUntil,
      quests: {
        day: snapshot.quests
          .filter((each) => each.period === 'day' && each.start === today)
          .sort((a, b) => a.slot - b.slot)
          .map(quest),
        week: week === undefined ? null : quest(week),
      },
      badges: snapshot.badges.map((badge) => ({ badge: badge.badge, tier: badge.tier, earnedAt: badge.earnedAt })),
      badgeValues: Object.fromEntries(BADGES.map((badge) => [badge.id, this.values === null ? 0 : badge.value(this.values)])),
      freezes: { held: snapshot.freezes.filter((freeze) => freeze.usedOn === null).length, max: FREEZE_MAX },
      checkin: { day: snapshot.state.checkin.day, lastOn: snapshot.state.checkin.lastOn },
      earlyDays: snapshot.state.earlyDays,
      rewards: snapshot.rewards.map((reward) => ({ ...reward, payload: { ...reward.payload } })),
    };
  }
}

/** The answer when the game cannot be kept, with why, so the page can say so. */
export function unavailableGame(today: IsoDate, reason: string): GameResponse {
  return {
    available: false,
    reason,
    today,
    totalXp: 0,
    level: levelOf(0),
    combo: { count: 0, bonus: 0, longest: 0 },
    comebackUntil: null,
    quests: { day: [], week: null },
    badges: [],
    badgeValues: {},
    freezes: { held: 0, max: FREEZE_MAX },
    checkin: { day: 0, lastOn: null },
    earlyDays: INITIAL_STATE.earlyDays,
    rewards: [],
  };
}
