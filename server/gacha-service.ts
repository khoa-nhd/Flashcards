/**
 * Loot chests on the server. Every roll, every key spent and every duplicate
 * recycled is decided here, from state the browser cannot reach, and written in
 * one step: a refresh mid-animation can neither lose a chest nor open one twice.
 */
import type { GachaApiState, GachaOpenResult } from '../shared/api.js';
import {
  CHESTS,
  GACHA_KEYS_PER_DAY,
  GACHA_SHARDS_PER_KEY,
  chestById,
  dailyKeysDue,
  exchangeShards,
  openChests,
  type OpeningResult,
  type PityState,
  type Random,
  type Rarity,
  secureRandom,
} from '../shared/gacha.js';
import { calendarDateInTimeZone, type IsoDate } from '../shared/dates.js';
import { HttpError } from './errors.js';

/** Everything one account's chests depend on, as the store keeps it. */
export interface GachaSnapshot {
  keys: number;
  shards: number;
  pity: PityState;
  opens: number;
  /** The last calendar day the daily keys were granted on. */
  lastGrantDay: IsoDate | null;
}

export interface InventoryRow {
  itemId: string;
  rarity: Rarity;
  quantity: number;
}

export interface InventoryChange {
  itemId: string;
  rarity: Rarity;
  /** How many copies this change adds. */
  quantity: number;
}

export interface GachaOpenRecord {
  requestId: string;
  chestId: string;
  count: number;
  results: OpeningResult[];
}

export type ApplyOutcome =
  | { outcome: 'applied' }
  | { outcome: 'conflict' }
  | { outcome: 'replayed'; results: OpeningResult[] };

/**
 * Where one account's chests are kept. `apply` must commit the new state, the
 * inventory changes and the opening record together, and must treat a repeated
 * request id as the same opening rather than a second one.
 */
export interface GachaStore {
  readonly available: boolean;
  load(): Promise<{ state: GachaSnapshot; inventory: InventoryRow[] }>;
  /** What this request id already opened, if it was opened before. */
  find(requestId: string): Promise<OpeningResult[] | null>;
  apply(input: {
    /** The `opens` count the caller read; a different one means someone got there first. */
    expectedOpens: number;
    state: GachaSnapshot;
    inventory: InventoryChange[];
    open: GachaOpenRecord | null;
  }): Promise<ApplyOutcome>;
}

export const EMPTY_SNAPSHOT: GachaSnapshot = {
  keys: 0,
  shards: 0,
  pity: { sinceEpic: 0, sinceLegendary: 0 },
  opens: 0,
  lastGrantDay: null,
};

/** Chests in the sample data, kept in memory for the life of the process. */
export function createMemoryGachaStore(initial: GachaSnapshot = EMPTY_SNAPSHOT): GachaStore {
  let state: GachaSnapshot = { ...initial, pity: { ...initial.pity } };
  const inventory = new Map<string, InventoryRow>();
  const opens = new Map<string, GachaOpenRecord>();
  return {
    available: true,
    async load() {
      return { state: { ...state, pity: { ...state.pity } }, inventory: [...inventory.values()].map((row) => ({ ...row })) };
    },
    async find(requestId) {
      return opens.get(requestId)?.results ?? null;
    },
    async apply({ expectedOpens, state: next, inventory: changes, open }) {
      if (open !== null) {
        const seen = opens.get(open.requestId);
        if (seen !== undefined) return { outcome: 'replayed', results: seen.results };
      }
      if (state.opens !== expectedOpens) return { outcome: 'conflict' };
      state = { ...next, pity: { ...next.pity } };
      for (const change of changes) {
        const row = inventory.get(change.itemId) ?? { itemId: change.itemId, rarity: change.rarity, quantity: 0 };
        inventory.set(change.itemId, { ...row, quantity: row.quantity + change.quantity });
      }
      if (open !== null) opens.set(open.requestId, open);
      return { outcome: 'applied' };
    },
  };
}

/** A store that keeps nothing, for accounts whose database is not that new yet. */
export const NO_GACHA_STORE: GachaStore = {
  available: false,
  async load() {
    return { state: EMPTY_SNAPSHOT, inventory: [] };
  },
  async find() {
    return null;
  },
  async apply() {
    return { outcome: 'conflict' };
  },
};

// ---- Spam protection ----

/** How many openings one account may start in the window below. */
export const GACHA_OPENS_PER_WINDOW = 8;
export const GACHA_WINDOW_MS = 10_000;

const recentOpens = new Map<string, number[]>();

/** Clears the window. Used between tests, and when an account signs out elsewhere. */
export function resetGachaRateLimit(): void {
  recentOpens.clear();
}

/**
 * A sliding window per account: a burst of clicks gets a few through, then a
 * 429 with the time to wait. The opening itself is idempotent, so the harmless
 * double-click still ends with exactly one chest opened.
 */
function checkRate(accountId: string, now: number): void {
  const since = now - GACHA_WINDOW_MS;
  const stamps = (recentOpens.get(accountId) ?? []).filter((at) => at > since);
  if (stamps.length >= GACHA_OPENS_PER_WINDOW) {
    const wait = Math.max(1, Math.ceil((stamps[0]! + GACHA_WINDOW_MS - now) / 1000));
    recentOpens.set(accountId, stamps);
    throw new HttpError(429, 'too_many_requests', `Easy there. Try again in ${wait} second${wait === 1 ? '' : 's'}.`, {
      headers: { 'Retry-After': String(wait) },
    });
  }
  stamps.push(now);
  recentOpens.set(accountId, stamps);
}

export interface GachaServiceOptions {
  store: GachaStore;
  /** Whose chests these are; also what the rate limit is counted per. */
  accountId: string;
  timeZone: string;
  now?: () => Date;
  random?: Random;
}

export class GachaService {
  private readonly store: GachaStore;
  private readonly accountId: string;
  private readonly timeZone: string;
  private readonly now: () => Date;
  private readonly random: Random;

  constructor(options: GachaServiceOptions) {
    this.store = options.store;
    this.accountId = options.accountId;
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
    // Injected only by tests; production rolls from the platform's secure source.
    this.random = options.random ?? secureRandom;
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.timeZone);
  }

  private view(state: GachaSnapshot, inventory: InventoryRow[]): GachaApiState {
    const today = this.today();
    return {
      available: true,
      keys: state.keys,
      shards: state.shards,
      pity: { ...state.pity },
      opens: state.opens,
      dailyKeysAvailable: state.lastGrantDay !== today,
      dailyKeys: GACHA_KEYS_PER_DAY,
      shardsPerKey: GACHA_SHARDS_PER_KEY,
      inventory: inventory.map((row) => ({ itemId: row.itemId, quantity: row.quantity })),
    };
  }

  /**
   * Today's chests, with the daily keys granted once. Reads only otherwise: a
   * page that is opened ten times grants nothing extra.
   */
  async state(): Promise<GachaApiState> {
    if (!this.store.available) throw this.unsupported();
    const loaded = await this.store.load();
    const today = this.today();
    const owed = dailyKeysDue(loaded.state.lastGrantDay, today, loaded.state.keys);
    if (owed === 0) return this.view(loaded.state, loaded.inventory);

    const next: GachaSnapshot = {
      ...loaded.state,
      keys: Math.min(99, loaded.state.keys + owed),
      lastGrantDay: today,
    };
    const outcome = await this.store.apply({
      expectedOpens: loaded.state.opens,
      state: next,
      inventory: [],
      open: null,
    });
    if (outcome.outcome === 'applied') return this.view(next, loaded.inventory);
    // Someone else wrote in between: show what is there rather than inventing a grant.
    const fresh = await this.store.load();
    return this.view(fresh.state, fresh.inventory);
  }

  /** Opens one chest or a batch of ten, and says exactly what fell out. */
  async open(input: { chestId: string; count: number; requestId: string }): Promise<GachaOpenResult> {
    if (!this.store.available) throw this.unsupported();
    const chest = chestById(input.chestId);
    if (chest === null) throw new HttpError(400, 'invalid_request', 'There is no chest with that id.');
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 10) {
      throw new HttpError(400, 'invalid_request', 'Open one chest, or a batch of ten.');
    }
    checkRate(this.accountId, this.now().getTime());

    // A retry of an opening that already happened must answer the same results,
    // even though the keys it spent are gone by now.
    const replayed = await this.store.find(input.requestId);
    if (replayed !== null) {
      const loaded = await this.store.load();
      return { state: this.view(loaded.state, loaded.inventory), results: replayed };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await this.store.load();
      const cost = chest.costKeys * input.count;
      if (loaded.state.keys < cost) {
        throw new HttpError(
          409,
          'insufficient_keys',
          `This needs ${cost} key${cost === 1 ? '' : 's'}; you have ${loaded.state.keys}.`,
        );
      }
      const owned = new Set(loaded.inventory.map((row) => row.itemId));
      const opening = openChests({
        chest,
        pity: loaded.state.pity,
        owned,
        count: input.count,
        random: this.random,
      });
      const next: GachaSnapshot = {
        keys: loaded.state.keys - cost,
        shards: loaded.state.shards + opening.shardsGained,
        pity: opening.pity,
        opens: loaded.state.opens + input.count,
        lastGrantDay: loaded.state.lastGrantDay,
      };
      const changes = tally(opening.results);
      const outcome = await this.store.apply({
        expectedOpens: loaded.state.opens,
        state: next,
        inventory: changes,
        open: { requestId: input.requestId, chestId: chest.id, count: input.count, results: opening.results },
      });
      if (outcome.outcome === 'replayed') {
        // A retry of an opening that already happened: hand back the same results.
        const fresh = await this.store.load();
        return { state: this.view(fresh.state, fresh.inventory), results: outcome.results };
      }
      if (outcome.outcome === 'applied') {
        return {
          state: this.view(next, mergeInventory(loaded.inventory, changes)),
          results: opening.results,
        };
      }
    }
    throw new HttpError(409, 'conflict', 'Your chests changed while this was opening. Try again.');
  }

  /** Turns duplicate shards into keys. */
  async exchange(input: { keys: number; requestId: string }): Promise<GachaOpenResult> {
    if (!this.store.available) throw this.unsupported();
    const replayed = await this.store.find(input.requestId);
    if (replayed !== null) {
      const loaded = await this.store.load();
      return { state: this.view(loaded.state, loaded.inventory), results: [] };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await this.store.load();
      const trade = exchangeShards(loaded.state.shards, input.keys);
      if (trade === null) {
        throw new HttpError(
          409,
          'not_enough_shards',
          `One key costs ${GACHA_SHARDS_PER_KEY} shards; you have ${loaded.state.shards}.`,
        );
      }
      const next: GachaSnapshot = {
        ...loaded.state,
        keys: Math.min(99, loaded.state.keys + trade.keys),
        shards: loaded.state.shards - trade.cost,
      };
      const outcome = await this.store.apply({
        expectedOpens: loaded.state.opens,
        state: next,
        inventory: [],
        open: { requestId: input.requestId, chestId: 'shards', count: 0, results: [] },
      });
      if (outcome.outcome === 'replayed') {
        const fresh = await this.store.load();
        return { state: this.view(fresh.state, fresh.inventory), results: [] };
      }
      if (outcome.outcome === 'applied') return { state: this.view(next, loaded.inventory), results: [] };
    }
    throw new HttpError(409, 'conflict', 'Your chests changed while this was trading. Try again.');
  }

  private unsupported(): HttpError {
    return new HttpError(409, 'not_supported', 'Loot chests need the latest database update.');
  }
}

/** Adds up the copies a batch won, so the inventory takes one write per item. */
function tally(results: readonly OpeningResult[]): InventoryChange[] {
  const gained = new Map<string, InventoryChange>();
  for (const result of results) {
    if (result.duplicate) continue;
    const row = gained.get(result.itemId) ?? { itemId: result.itemId, rarity: result.rarity, quantity: 0 };
    row.quantity += 1;
    gained.set(result.itemId, row);
  }
  return [...gained.values()];
}

/** The inventory as the page should see it once this batch has landed. */
function mergeInventory(inventory: readonly InventoryRow[], changes: readonly InventoryChange[]): InventoryRow[] {
  const rows = new Map(inventory.map((row) => [row.itemId, { ...row }]));
  for (const change of changes) {
    const row = rows.get(change.itemId) ?? { itemId: change.itemId, rarity: change.rarity, quantity: 0 };
    row.quantity += change.quantity;
    rows.set(change.itemId, row);
  }
  return [...rows.values()];
}

/** The chest ids the server will accept, for the client's own list. */
export const CHEST_IDS = CHESTS.map((chest) => chest.id);
