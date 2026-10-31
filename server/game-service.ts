/**
 * The game, as the server runs it (docs/gamification-plan.md, phase 1). The
 * rules are the shared engine's; this file reads what they need, hands the
 * engine's change to a store, and turns the result into what the page shows.
 *
 * It only reads saved answers. Nothing here can change what is due.
 */
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AnswerGame, BossResponse, BuyRequest, CollectionResponse, GameResponse, ShopResponse } from '../shared/api.js';
import { CARD_SETS, itemById, petById } from '../shared/gamification/catalog.js';
import {
  ALL_EVENTS,
  ALWAYS,
  BOOST_MS,
  BOSS_HP,
  BOSS_WORDS,
  BOSS_XP,
  MONTHLY_TARGET,
  STARDUST,
  bossHealth,
  dailyShop,
  goldenHour,
  monthKey,
  petEffects,
  petForm,
  petMood,
  petSlots,
  priceOf,
  repairDays,
  type EventSwitches,
} from '../shared/gamification/economy.js';
import { calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import { BADGES, type BadgeId, type BadgeMetrics } from '../shared/gamification/badges.js';
import { streakOf } from '../shared/study-goals.js';
import {
  INITIAL_STATE,
  addItems,
  claim,
  isEmpty,
  stateChange,
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

/** Why a purchase or a choice of companions was refused. */
export class GameError extends Error {
  constructor(
    public readonly failure: 'insufficient' | 'owned' | 'unavailable' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

/** A number in [0, 1) from a secure source: chests are drawn with it. */
const secureRandom = () => randomInt(0, 2 ** 47) / 2 ** 47;

/** Totals the badges read; the streak and the combo come from the engine. */
export type GameMetrics = Omit<BadgeMetrics, 'longestStreak' | 'longestCombo' | 'bosses'>;

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
  /** Phase 3 (version 19): which events are on. Absent where the economy is not kept. */
  events?(): Promise<EventSwitches>;
  /** Practice answers on the boss's words since a moment, remembered and forgotten. */
  bossProgress?(words: readonly string[], from: string): Promise<{ correct: number; wrong: number }>;
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
    stardust: rows.state?.stardust ?? 0,
    inventory: rows.inventory,
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
    ...(database.gameEvents === undefined
      ? {}
      : {
          async events(): Promise<EventSwitches> {
            const rows = await need(database.gameEvents).call(database);
            const on = (event: string) => rows.find((row) => row.event === event)?.enabled ?? true;
            return { goldenHour: on('golden_hour'), sunday: on('sunday'), monthly: on('monthly'), boss: on('boss') };
          },
          async bossProgress(words: readonly string[], from: string) {
            const rows = await need(database.competitionCall).call(database, 'boss_progress', { p_words: [...words], p_from: from });
            const row = z.object({ correct: z.coerce.number().int(), wrong: z.coerce.number().int() }).safeParse(rows[0]);
            if (!row.success) throw new DatabaseError('unavailable', 'The database returned the boss in an unexpected shape.');
            return row.data;
          },
        }),
    async commit(change) {
      const payload = JSON.stringify({ user: account, ...change });
      try {
        const result = await need(database.gameCommit).call(database, payload, signGameChange(payload, signingKey));
        return result.outcome;
      } catch (error) {
        if (error instanceof DatabaseError && error.code === '23514') throw new GameError('insufficient', 'Not enough stardust.');
        // The only other refusal a change signed here can meet is a key the database does not share.
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
  /** Switches an event, as the admin page does. */
  setEvent(event: keyof EventSwitches, enabled: boolean): void;
}

export function createMemoryGameStore(source: {
  answers(): AnswerEvent[];
  metrics(): GameMetrics;
  /** Practice answers, for the weekly boss. */
  practice?(): Array<{ id: string; correct: boolean; at: string }>;
}): MemoryGameStore {
  let version = 0;
  let state: GameStateData = { ...INITIAL_STATE };
  const ledger = new Map<string, { source: string; amount: number; reason: string; on: IsoDate; at: string }>();
  const quests = new Map<string, Quest>();
  const badges = new Map<string, { badge: BadgeId; tier: number; earnedAt: string }>();
  const freezes = new Map<string, { id: string; grantedOn: IsoDate; usedOn: IsoDate | null }>();
  const rewards = new Map<string, Reward & { claimed: boolean }>();
  const stardust = new Map<string, number>();
  const inventory = new Map<string, string>();
  const events: EventSwitches = { ...ALL_EVENTS };
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
        stardust: [...stardust.values()].reduce((sum, amount) => sum + amount, 0),
        inventory: [...inventory.keys()],
      };
    },
    async events() {
      return { ...events };
    },
    setEvent(event, enabled) {
      events[event] = enabled;
    },
    async bossProgress(words, from) {
      const wanted = new Set(words);
      const answers = (source.practice?.() ?? []).filter((answer) => wanted.has(answer.id) && Date.parse(answer.at) >= Date.parse(from));
      return { correct: answers.filter((answer) => answer.correct).length, wrong: answers.filter((answer) => !answer.correct).length };
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
      const fresh = change.stardust.filter((entry) => !stardust.has(`${entry.source}:${entry.sourceId}`));
      const balance = [...stardust.values(), ...fresh.map((entry) => entry.amount)].reduce((sum, amount) => sum + amount, 0);
      if (balance < 0) throw new GameError('insufficient', 'Not enough stardust.');
      for (const entry of fresh) stardust.set(`${entry.source}:${entry.sourceId}`, entry.amount);
      for (const entry of change.inventory) if (!inventory.has(entry.item)) inventory.set(entry.item, entry.source);
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
  /** Phase 3 is kept (schema version 19 and a store that keeps it). */
  economy?: boolean;
  /** The words the weekly boss is made of, weakest first (Weak words' order). */
  weakWords?: () => Promise<Array<{ id: string; word: string }>>;
  /** Draws chests; a secure source unless a test gives its own. */
  random?: () => number;
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
    const economy = await this.economyContext();

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
          economy,
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
        bosses: this.last.state.bossWins,
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
    let opened: GameResponse['opened'] = [];
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const snapshot = await store.snapshot(today, weekStart);
      const wanted = ids === 'all' ? snapshot.rewards.map((reward) => reward.id) : ids;
      const random = this.economyOn() ? (this.options.random ?? secureRandom) : null;
      const { opened: drawn, ...change } = claim(snapshot, wanted, this.now().toISOString(), today, this.newId, random);
      if (change.claimed.length === 0) break;
      // A chest is drawn here, before the change is signed, and stored with it: claiming it again finds it claimed.
      if ((await store.commit(change)) === 'ok') {
        opened = drawn;
        break;
      }
    }
    return { ...(await this.state()), opened };
  }

  // ---- The economy (phase 3) ----

  /** The events read by the last count, for the page. */
  private lastEvents: EventSwitches | null = null;

  private economyOn(): boolean {
    return this.options.economy === true && this.options.store.events !== undefined;
  }

  private async economyContext(): Promise<{ timeZone: string; events: EventSwitches } | null> {
    if (!this.economyOn()) return null;
    this.lastEvents = await this.options.store.events!();
    return { timeZone: this.options.timeZone, events: this.lastEvents };
  }

  private needEconomy(): void {
    if (!this.economyOn()) throw new GameError('unavailable', 'The shop and collection need the latest database update (version 19).');
  }

  /**
   * Stores a change worked out from a fresh snapshot, working it out again if
   * the game moved on meanwhile. `make` returns null when there is nothing to do.
   */
  private async change(make: (snapshot: GameSnapshot) => GameChange | null): Promise<void> {
    const { store } = this.options;
    const today = this.today();
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const snapshot = await store.snapshot(today, weekStartOf(today));
      const change = make(snapshot);
      if (change === null || (await store.commit(change)) === 'ok') return;
    }
    throw new GameError('unavailable', 'The game changed meanwhile; try again.');
  }

  async shop(): Promise<ShopResponse> {
    const today = this.today();
    if (!this.economyOn()) {
      return { available: false, reason: 'The shop needs the latest database update (version 19).', today, stardust: 0, items: [], services: [] };
    }
    const snapshot = await this.sync();
    const owned = new Set(snapshot.inventory);
    const facts = await this.facts({});
    const covered = snapshot.freezes.flatMap((freeze) => (freeze.usedOn === null ? [] : [freeze.usedOn]));
    const held = snapshot.freezes.filter((freeze) => freeze.usedOn === null).length;
    return {
      available: true,
      reason: null,
      today,
      stardust: snapshot.stardust,
      items: dailyShop(this.options.account, today).map((id) => ({ item: id, price: priceOf(itemById(id)!), owned: owned.has(id) })),
      services: [
        { kind: 'freeze', price: ALWAYS.freeze, blocked: held >= FREEZE_MAX ? 'held' : null },
        { kind: 'boost', price: ALWAYS.boost, blocked: null },
        { kind: 'repair', price: ALWAYS.repair, blocked: repairDays(facts.metDays, covered, today).length === 0 ? 'nothing' : null },
        { kind: 'slot', price: ALWAYS.slot, blocked: owned.has('slot_bought') ? 'owned' : null },
      ],
    };
  }

  async buy(request: BuyRequest): Promise<ShopResponse> {
    this.needEconomy();
    const today = this.today();
    const now = this.now();
    const at = now.toISOString();
    const facts = await this.facts({});
    await this.sync(facts);
    await this.change((snapshot) => {
      const owned = new Set(snapshot.inventory);
      const change = stateChange(snapshot, { ...INITIAL_STATE, ...snapshot.state });
      const pay = (price: number, reason: string) => {
        if (snapshot.stardust < price) throw new GameError('insufficient', 'Not enough stardust.');
        change.stardust.push({ source: 'shop', sourceId: this.newId(), amount: -price, reason, at });
      };
      switch (request.kind) {
        case 'item': {
          const item = itemById(request.item);
          if (item === undefined || !dailyShop(this.options.account, today).includes(item.id)) {
            throw new GameError('invalid', 'That is not for sale today.');
          }
          if (owned.has(item.id)) throw new GameError('owned', 'You already have that.');
          pay(priceOf(item), item.id);
          addItems(change, owned, [item.id], 'shop', at, this.newId);
          break;
        }
        case 'freeze': {
          if (snapshot.freezes.filter((freeze) => freeze.usedOn === null).length >= FREEZE_MAX) {
            throw new GameError('owned', 'You already hold as many streak freezes as you can.');
          }
          pay(ALWAYS.freeze, 'freeze');
          change.freezes.push({ id: this.newId(), grantedOn: today, usedOn: null });
          break;
        }
        case 'boost': {
          pay(ALWAYS.boost, 'boost');
          const from = Math.max(now.getTime(), snapshot.state.boostUntil === null ? 0 : Date.parse(snapshot.state.boostUntil));
          change.state = { ...change.state, boostUntil: new Date(from + BOOST_MS).toISOString() };
          break;
        }
        case 'repair': {
          const covered = snapshot.freezes.flatMap((freeze) => (freeze.usedOn === null ? [] : [freeze.usedOn]));
          const days = repairDays(facts.metDays, covered, today);
          if (days.length === 0) throw new GameError('invalid', 'There is no broken streak to repair.');
          pay(ALWAYS.repair, 'repair');
          // A repair is freezes spent on the missed days after the fact.
          for (const day of days) change.freezes.push({ id: this.newId(), grantedOn: today, usedOn: day });
          break;
        }
        case 'slot': {
          if (owned.has('slot_bought')) throw new GameError('owned', 'You already bought that slot.');
          pay(ALWAYS.slot, 'slot');
          change.inventory.push({ item: 'slot_bought', source: 'shop' });
          break;
        }
      }
      return change;
    });
    return this.shop();
  }

  async collection(): Promise<CollectionResponse> {
    if (!this.economyOn()) {
      return {
        available: false,
        reason: 'The collection needs the latest database update (version 19).',
        stardust: 0,
        owned: [],
        slots: 1,
        leading: [],
        petDays: {},
        sets: [],
        theme: null,
      };
    }
    const snapshot = await this.sync();
    const owned = new Set(snapshot.inventory);
    const pets = { ...INITIAL_STATE.pets, ...snapshot.state.pets };
    return {
      available: true,
      reason: null,
      stardust: snapshot.stardust,
      owned: snapshot.inventory,
      slots: petSlots(levelOf(snapshot.totalXp).level, pets, owned),
      leading: pets.active,
      petDays: pets.days,
      sets: CARD_SETS.map((set) => ({
        id: set.id,
        have: set.cards.filter((card) => owned.has(card)).length,
        total: set.cards.length,
        done: snapshot.state.setsDone.includes(set.id),
      })),
      theme: snapshot.state.theme,
    };
  }

  /** Every account is given one companion of its choosing, once. */
  async starter(pet: string): Promise<CollectionResponse> {
    this.needEconomy();
    if (petById(pet) === undefined) throw new GameError('invalid', 'There is no such companion.');
    await this.change((snapshot) => {
      if (snapshot.inventory.some((item) => petById(item) !== undefined)) throw new GameError('owned', 'Your first companion is already chosen.');
      const state = { ...INITIAL_STATE, ...snapshot.state };
      const change = stateChange(snapshot, { ...state, pets: { ...state.pets, active: [pet] } });
      change.inventory.push({ item: pet, source: 'starter' });
      return change;
    });
    return this.collection();
  }

  /** Which companions lead, and the colour theme: only what is owned, and no more companions than slots. */
  async equip(choice: { pets?: string[]; theme?: string | null }): Promise<CollectionResponse> {
    this.needEconomy();
    await this.change((snapshot) => {
      const owned = new Set(snapshot.inventory);
      const state = { ...INITIAL_STATE, ...snapshot.state };
      let next = state;
      if (choice.pets !== undefined) {
        const pets = [...new Set(choice.pets)];
        if (pets.some((pet) => petById(pet) === undefined || !owned.has(pet))) throw new GameError('invalid', 'You can only lead companions you have.');
        if (pets.length > petSlots(levelOf(snapshot.totalXp).level, state.pets, owned)) throw new GameError('invalid', 'Not enough companion slots.');
        next = { ...next, pets: { ...state.pets, active: pets } };
      }
      if (choice.theme !== undefined) {
        if (choice.theme !== null && (itemById(choice.theme)?.kind !== 'theme' || !owned.has(choice.theme))) {
          throw new GameError('invalid', 'You can only use a theme you have.');
        }
        next = { ...next, theme: choice.theme };
      }
      return stateChange(snapshot, next);
    });
    return this.collection();
  }

  /** Which events are on, for the admin page. */
  async events(): Promise<EventSwitches> {
    this.needEconomy();
    return this.options.store.events!();
  }

  /** The companion leading into battle: the first one leading, where the economy is kept. */
  async leadingPet(): Promise<string | null> {
    if (!this.economyOn()) return null;
    const today = this.today();
    const snapshot = await this.options.store.snapshot(today, weekStartOf(today));
    return snapshot.state.pets?.active[0] ?? null;
  }

  /** Whether the account owns an item: what may be worn on the public profile. */
  async owns(item: string): Promise<boolean> {
    if (!this.economyOn()) return false;
    const today = this.today();
    return (await this.options.store.snapshot(today, weekStartOf(today))).inventory.includes(item);
  }

  /**
   * This week's boss: the account's weakest words, beaten with practice. Its
   * health is worked out from the practice answers on its words, so a
   * schedule is never touched; beating it gives its reward once.
   */
  async boss(): Promise<BossResponse> {
    const today = this.today();
    const week = weekStartOf(today);
    const off = (reason: string): BossResponse => ({ available: false, reason, week, words: [], hp: BOSS_HP, max: BOSS_HP, correct: 0, wrong: 0, won: false });
    if (!this.economyOn() || this.options.store.bossProgress === undefined) return off('The weekly boss needs the latest database update (version 19).');
    const events = await this.options.store.events!();
    if (!events.boss) return off('The weekly boss is switched off this week.');
    let snapshot = await this.sync();
    if (snapshot.state.boss?.week !== week) {
      const weakest = ((await this.options.weakWords?.()) ?? []).slice(0, BOSS_WORDS);
      if (weakest.length < 5) return off('The boss needs at least five weak words to be made of.');
      await this.change((fresh) =>
        fresh.state.boss?.week === week ? null : stateChange(fresh, { ...INITIAL_STATE, ...fresh.state, boss: { week, words: weakest.map((word) => word.id), won: false } }),
      );
      snapshot = await this.options.store.snapshot(today, week);
    }
    const boss = snapshot.state.boss!;
    const from = zonedMidnight(week, this.options.timeZone);
    const { correct, wrong } = await this.options.store.bossProgress(boss.words, from);
    const hp = bossHealth(correct, wrong);
    if (hp === 0 && !boss.won) {
      await this.change((fresh) => {
        if (fresh.state.boss?.won !== false || fresh.state.boss.week !== week) return null;
        const state = { ...INITIAL_STATE, ...fresh.state };
        const change = stateChange(fresh, { ...state, boss: { ...boss, won: true }, bossWins: state.bossWins + 1 });
        const at = this.now().toISOString();
        change.rewards.push({ id: this.newId(), kind: 'boss', payload: { xp: BOSS_XP, stardust: STARDUST.boss, week }, createdAt: at });
        addItems(change, new Set(fresh.inventory), ['title_boss'], `boss:${week}`, at, this.newId);
        return change;
      });
      // The boss badge is counted from the wins.
      await this.sync({ badges: true });
    }
    const names = new Map(((await this.options.weakWords?.()) ?? []).map((word) => [word.id, word.word]));
    const catalog = this.options.catalog === undefined ? [] : (await this.options.catalog.listEntries()).entries;
    for (const entry of catalog) if (!names.has(entry.id)) names.set(entry.id, entry.word);
    return {
      available: true,
      reason: null,
      week,
      words: boss.words.flatMap((id) => (names.has(id) ? [{ id, word: names.get(id)! }] : [])),
      hp,
      max: BOSS_HP,
      correct,
      wrong,
      won: hp === 0,
    };
  }

  async saveSettings(settings: { earlyDays: number }): Promise<GameResponse> {
    await this.change((snapshot) => stateChange(snapshot, { ...snapshot.state, earlyDays: settings.earlyDays }));
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
      economy: this.economyView(snapshot),
    };
  }

  private economyView(snapshot: GameSnapshot): GameResponse['economy'] {
    if (!this.economyOn() || this.lastEvents === null) return null;
    const today = this.today();
    const owned = new Set(snapshot.inventory);
    const pets = { ...INITIAL_STATE.pets, ...snapshot.state.pets };
    const events = this.lastEvents;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.options.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(this.now()));
    const golden = events.goldenHour ? goldenHour(this.options.account, today) : null;
    const month = snapshot.state.month?.key === monthKey(today) ? snapshot.state.month : null;
    return {
      stardust: snapshot.stardust,
      pets: pets.active.map((id) => ({ id, days: pets.days[id] ?? 0, form: petForm(pets.days[id] ?? 0), mood: petMood(snapshot.state.lastActiveOn, today) })),
      slots: petSlots(levelOf(snapshot.totalXp).level, pets, owned),
      petBonus: petEffects(pets.active).xpPercent,
      theme: snapshot.state.theme,
      boostUntil:
        snapshot.state.boostUntil !== null && Date.parse(snapshot.state.boostUntil) > this.now().getTime() ? snapshot.state.boostUntil : null,
      goldenHour: golden,
      goldenNow: golden !== null && hour === golden,
      sunday: events.sunday && new Date(`${today}T00:00:00Z`).getUTCDay() === 0,
      month: events.monthly ? { count: month?.count ?? 0, target: MONTHLY_TARGET, done: month?.done ?? false } : null,
    };
  }
}

/** Midnight at the start of a day in a zone, as an instant. */
export function zonedMidnight(day: IsoDate, timeZone: string): string {
  // The zone's offset at noon that day, applied to midnight (no zone the app offers moves its clock at midnight).
  const noon = new Date(`${day}T12:00:00Z`);
  const local = new Date(noon.toLocaleString('en-US', { timeZone }));
  const utc = new Date(noon.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = local.getTime() - utc.getTime();
  return new Date(Date.parse(`${day}T00:00:00Z`) - offset).toISOString();
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
