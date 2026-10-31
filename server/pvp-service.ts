/**
 * PvP word duels, as the server referees them (docs/gamification-plan.md, phase 5).
 *
 * The questions and their right answers are made here. Each right answer is
 * sealed with the server's key (AES-256-GCM) before it is stored, so the two
 * players can read their match but not the answer to a question before
 * answering it. Every answer comes here, is judged here, and moves the match
 * on through a signed change that only applies to the version it was made
 * from. Answers on one's own words are saved as practice, which never moves
 * a schedule.
 *
 * A match is followed by a heartbeat: each player's page asks for it about
 * once a second, which also plays a simulated rival's due answers and notices
 * a player who has gone.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PvpLobby, PvpMatch, PvpTick } from '../shared/api.js';
import { calendarDateInTimeZone } from '../shared/dates.js';
import {
  BATTLE_SKILL,
  PVP,
  RATING_START,
  answer,
  buildQuestions,
  elo,
  matchReward,
  playRival,
  ratingTier,
  ratingWindow,
  rivalFor,
  seasonCarry,
  seasonOf,
  seasonStardust,
  settle,
  startMatch,
  type BattleSkill,
  type MatchState,
  type PoolWord,
  type Side,
} from '../shared/pvp.js';
import { signGameChange } from './game-service.js';
import { HttpError } from './errors.js';
import { DatabaseError, type VocabularyDatabase } from './supabase/supabase-database.js';
import type { VocabularyCatalog } from './vocabulary-catalog.js';
import type { VocabularyRepository } from './vocabulary-repository.js';

// ---- Sealing the answers ----

export interface Sealed {
  answer: number;
  word: string;
  meaning: string;
  owner: string;
  vocabularyId: string | null;
}

const sealKey = (key: string) => createHash('sha256').update(`${key}|pvp-seal`).digest();

export function seal(key: string, value: Sealed): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(key), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(key: string, sealed: string): Sealed {
  const raw = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', sealKey(key), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as Sealed;
}

// ---- What the store gives ----

const count = z.coerce.number().int();

export const ratingRowSchema = z.object({
  rating: count,
  season: z.string(),
  wins: count,
  losses: count,
  draws: count,
  consented: z.boolean(),
  locked_until: z.string().nullable(),
});

export const queueRowSchema = z.object({
  mode: z.enum(['ranked', 'friend']),
  rating: count,
  target: z.string().nullable(),
  joined_at: z.string(),
  match_id: z.string().nullable(),
});

export const matchRowSchema = z.object({
  id: z.string(),
  mode: z.enum(['ranked', 'friend', 'rival']),
  player_a: z.string(),
  player_b: z.string().nullable(),
  rival: z.object({ basis: count }).nullable(),
  season: z.string(),
  state: z.record(z.string(), z.unknown()),
  version: count,
  created_at: z.string(),
  finished_at: z.string().nullable(),
  winner: z.enum(['a', 'b', 'draw']).nullable(),
  settled: z.boolean(),
});

export const questionRowSchema = z.object({
  idx: count,
  direction: z.enum(['en-vi', 'vi-en']),
  prompt: z.string(),
  options: z.array(z.string()),
  sealed: z.string(),
});

export type RatingRow = z.infer<typeof ratingRowSchema>;
export type QueueRow = z.infer<typeof queueRowSchema>;
export type MatchRow = z.infer<typeof matchRowSchema>;
export type QuestionRow = z.infer<typeof questionRowSchema>;

/** What a match keeps beyond the rules' state: what each side got once it was over. */
type Stored = MatchState & {
  results?: Partial<Record<Side, { from: number; to: number; xp: number; stardust: number }>>;
};

export type PvpOp = { op: string } & Record<string, unknown>;

export interface PvpStore {
  rating(): Promise<RatingRow | null>;
  queue(): Promise<QueueRow | null>;
  match(id: string): Promise<{ match: MatchRow; questions: QuestionRow[] } | null>;
  matches(options: { unfinished?: boolean; limit: number }): Promise<MatchRow[]>;
  sides(id: string): Promise<Array<{ side: Side; nickname: string | null; rating: number }>>;
  today(id: string): Promise<Array<{ side: Side; matches: number }>>;
  invites(): Promise<Array<{ nickname: string; invited_at: string }>>;
  headToHead(): Promise<Array<{ nickname: string; wins: number; losses: number; draws: number }>>;
  /** Applies a signed operation; what it has to say back. */
  apply(op: PvpOp): Promise<Record<string, unknown> | null>;
}

const OP_LIFETIME_MS = 60_000;

export function createDatabasePvpStore(database: VocabularyDatabase, account: string, signingKey: string, now: () => Date = () => new Date()): PvpStore {
  const need = <T>(method: T | undefined): T => {
    if (method === undefined) throw new DatabaseError('schema_missing', 'Word duels need the latest database update (version 21).');
    return method;
  };
  const rows = async <T>(table: Parameters<NonNullable<VocabularyDatabase['pvpRows']>>[0], filter: Parameters<NonNullable<VocabularyDatabase['pvpRows']>>[1], schema: z.ZodType<T>) => {
    const parsed = z.array(schema).safeParse(await need(database.pvpRows).call(database, table, filter));
    if (!parsed.success) throw new DatabaseError('unavailable', 'The database returned a match in an unexpected shape.');
    return parsed.data;
  };
  const call = async <T>(fn: Parameters<NonNullable<VocabularyDatabase['competitionCall']>>[0], args: Record<string, string | null>, schema: z.ZodType<T>) => {
    const parsed = z.array(schema).safeParse(await need(database.competitionCall).call(database, fn, args));
    if (!parsed.success) throw new DatabaseError('unavailable', 'The database returned a match in an unexpected shape.');
    return parsed.data;
  };
  return {
    rating: async () => (await rows('pvp_ratings', { limit: 1 }, ratingRowSchema))[0] ?? null,
    queue: async () => (await rows('pvp_queue', { limit: 1 }, queueRowSchema))[0] ?? null,
    async match(id) {
      const [match] = await rows('pvp_matches', { id, limit: 1 }, matchRowSchema);
      if (match === undefined) return null;
      return { match, questions: await rows('pvp_questions', { matchId: id, limit: 200 }, questionRowSchema) };
    },
    matches: (options) => rows('pvp_matches', { unfinished: options.unfinished, limit: options.limit }, matchRowSchema),
    sides: (id) => call('pvp_sides', { p_match: id }, z.object({ side: z.enum(['a', 'b']), nickname: z.string().nullable(), rating: count })),
    today: (id) => call('pvp_today', { p_match: id }, z.object({ side: z.enum(['a', 'b']), matches: count })),
    invites: () => call('pvp_invites', {}, z.object({ nickname: z.string(), invited_at: z.string() })),
    headToHead: () => call('pvp_head_to_head', {}, z.object({ nickname: z.string(), wins: count, losses: count, draws: count })),
    async apply(op) {
      const payload = JSON.stringify({ ...op, user: account, exp: new Date(now().getTime() + OP_LIFETIME_MS).toISOString() });
      const result = z.union([z.record(z.string(), z.unknown()), z.null(), z.object({ result: z.record(z.string(), z.unknown()).nullable() })]);
      const [row] = await call('pvp_apply', { p_payload: payload, p_signature: signGameChange(payload, signingKey) }, result);
      if (row == null) return null;
      return 'result' in row && (row.result === null || typeof row.result === 'object') && Object.keys(row).length === 1
        ? (row.result as Record<string, unknown> | null)
        : (row as Record<string, unknown>);
    },
  };
}

// ---- The service ----

export interface PvpServiceOptions {
  store: PvpStore;
  account: string;
  /** The game signing key: the answers are sealed with a key made from it. */
  signingKey: string;
  timeZone: string;
  catalog: VocabularyCatalog;
  repository: Pick<VocabularyRepository, 'recordPractice'>;
  /** A player by nickname: who it is, and whether the two follow each other. */
  resolve: (nickname: string) => Promise<{ id: string; mutual: boolean } | null>;
  /** The companion leading into battle. */
  leadingPet: () => Promise<string | null>;
  /** Gives the account its nickname if it has none yet: what the other player sees. */
  ensureProfile?: () => Promise<unknown>;
  now?: () => Date;
  newId?: () => string;
  random?: () => number;
}

/** A practice answer's request id, the same for the same question: a repeated answer is saved once. */
const requestIdFor = (match: string, index: number, side: Side) => {
  const hex = createHash('sha256').update(`pvp:${match}:${index}:${side}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const RETRIES = 3;
/** How often a heartbeat alone is written down. */
const SEEN_EVERY_MS = 4000;

export class PvpService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly random: () => number;

  constructor(private readonly options: PvpServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.random = options.random ?? Math.random;
  }

  private season(): string {
    return seasonOf(this.now());
  }

  /** The account's rating now: a new season starts it from halfway back to 1,000. */
  private async rating(): Promise<{ row: RatingRow | null; rating: number }> {
    const row = await this.options.store.rating();
    if (row === null) return { row, rating: RATING_START };
    return { row, rating: row.season === this.season() ? row.rating : seasonCarry(row.rating) };
  }

  // ---- The lobby ----

  async lobby(): Promise<PvpLobby> {
    const { store } = this.options;
    await this.options.ensureProfile?.();
    let { row, rating } = await this.rating();
    // A finished season: its reward waits, and the rating carries over.
    if (row !== null && row.season !== this.season()) {
      const tier = ratingTier(row.rating);
      const played = row.wins + row.losses + row.draws > 0;
      await store.apply({
        op: 'season_close',
        season: this.season(),
        rating,
        reward: played ? { season: row.season, tier, stardust: seasonStardust(tier) } : null,
      });
      ({ row, rating } = await this.rating());
    }
    const [queue, active, invites, headToHead, recent] = await Promise.all([
      store.queue(),
      store.matches({ unfinished: true, limit: 1 }),
      store.invites(),
      store.headToHead(),
      store.matches({ limit: 10 }),
    ]);
    const live = active.find((match) => this.now().getTime() - Date.parse(match.created_at) < PVP.durationMs + PVP.goneMs + 60_000) ?? null;
    const sides = new Map<string, string | null>();
    for (const match of recent.filter((each) => each.winner !== null).slice(0, 10)) {
      sides.set(match.id, await this.opponentName(match));
    }
    return {
      available: true,
      reason: null,
      season: this.season(),
      rating,
      tier: ratingTier(rating),
      record: { wins: row?.season === this.season() ? row.wins : 0, losses: row?.season === this.season() ? row.losses : 0, draws: row?.season === this.season() ? row.draws : 0 },
      consented: row?.consented ?? false,
      lockedUntil: row?.locked_until != null && Date.parse(row.locked_until) > this.now().getTime() ? row.locked_until : null,
      waiting: queue === null || queue.match_id !== null ? null : { mode: queue.mode, since: queue.joined_at, friend: null },
      matchId: live?.id ?? queue?.match_id ?? null,
      invites: invites.map((invite) => ({ nickname: invite.nickname, at: invite.invited_at })),
      headToHead,
      recent: recent
        .filter((match) => match.winner !== null)
        .map((match) => ({
          id: match.id,
          mode: match.mode,
          opponent: sides.get(match.id) ?? null,
          result: match.winner === 'draw' ? ('draw' as const) : match.winner === this.sideOf(match) ? ('won' as const) : ('lost' as const),
          at: match.created_at,
        })),
    };
  }

  private sideOf(match: MatchRow): Side {
    return match.player_a === this.options.account ? 'a' : 'b';
  }

  private async opponentName(match: MatchRow): Promise<string | null> {
    if (match.rival !== null) return rivalFor(match.id, match.rival.basis).nickname;
    const sides = await this.options.store.sides(match.id);
    return sides.find((each) => each.side !== this.sideOf(match))?.nickname ?? null;
  }

  async consent(): Promise<void> {
    await this.options.ensureProfile?.();
    await this.options.store.apply({ op: 'consent', season: this.season() });
  }

  private async needUnlocked(): Promise<{ rating: number }> {
    const { row, rating } = await this.rating();
    if (row?.locked_until != null && Date.parse(row.locked_until) > this.now().getTime()) {
      throw new HttpError(409, 'locked', 'Leaving matches has locked matchmaking for a few minutes.');
    }
    return { rating };
  }

  /** The words this player brings: their own, with a meaning, not archived. */
  private async pool(): Promise<{ words: PoolWord[]; skill: BattleSkill | null }> {
    const entries = (await this.options.catalog.listEntries()).entries.filter((entry) => entry.meaning !== null && entry.meaning.trim() !== '' && entry.suspended !== true);
    const picked = [...entries].sort(() => this.random() - 0.5).slice(0, 20);
    const pet = await this.options.leadingPet();
    return {
      words: picked.map((entry) => ({ word: entry.word, meaning: entry.meaning!, owner: this.options.account, vocabularyId: entry.id })),
      skill: pet === null ? null : (BATTLE_SKILL[pet] ?? null),
    };
  }

  async join(): Promise<PvpTick> {
    const { rating } = await this.needUnlocked();
    const row = await this.options.store.rating();
    if (row?.consented !== true) throw new HttpError(409, 'consent', 'Accept that the other player will see some of your words first.');
    await this.options.store.apply({ op: 'queue_join', mode: 'ranked', rating, pool: await this.pool(), target: null });
    return this.tick();
  }

  /** Invites a friend (who follows back) to a match; they have a minute to accept. */
  async invite(nickname: string): Promise<PvpTick> {
    const { rating } = await this.needUnlocked();
    const friend = await this.options.resolve(nickname);
    if (friend === null) throw new HttpError(404, 'not_found', 'No player has that nickname.');
    if (!friend.mutual) throw new HttpError(400, 'invalid_request', 'Matches with friends are between players who follow each other.');
    await this.options.store.apply({ op: 'queue_join', mode: 'friend', rating, pool: await this.pool(), target: friend.id });
    return this.tick();
  }

  async accept(nickname: string): Promise<PvpTick> {
    await this.needUnlocked();
    const friend = await this.options.resolve(nickname);
    if (friend === null) throw new HttpError(404, 'not_found', 'No player has that nickname.');
    const claimed = await this.options.store.apply({ op: 'claim', mode: 'friend', target: friend.id });
    if (claimed === null) throw new HttpError(404, 'not_found', 'That invitation has expired.');
    const id = await this.create('friend', claimed);
    return { state: 'match', matchId: id };
  }

  async leave(): Promise<void> {
    await this.options.store.apply({ op: 'queue_leave' });
  }

  /**
   * While waiting: pairs with another player in reach of the rating (a wider
   * reach the longer one waits), or after ten seconds brings a rival.
   */
  async tick(): Promise<PvpTick> {
    const { store } = this.options;
    const queue = await store.queue();
    if (queue === null) {
      const [active] = await store.matches({ unfinished: true, limit: 1 });
      return active === undefined ? { state: 'idle', matchId: null } : { state: 'match', matchId: active.id };
    }
    if (queue.match_id !== null) {
      await store.apply({ op: 'queue_leave' });
      return { state: 'match', matchId: queue.match_id };
    }
    const waited = this.now().getTime() - Date.parse(queue.joined_at);
    if (queue.mode === 'friend') {
      if (waited > PVP.inviteMs) {
        await store.apply({ op: 'queue_leave' });
        return { state: 'idle', matchId: null };
      }
      return { state: 'waiting', matchId: null };
    }
    const claimed = await store.apply({ op: 'claim', mode: 'ranked', rating: queue.rating, window: ratingWindow(waited) });
    if (claimed !== null) return { state: 'match', matchId: await this.create('ranked', claimed) };
    if (waited >= PVP.botAfterMs) return { state: 'match', matchId: await this.create('rival', null, queue.rating) };
    return { state: 'waiting', matchId: null };
  }

  /** Makes a match: the questions from both sides' words, each answer sealed. */
  private async create(mode: 'ranked' | 'friend' | 'rival', opponent: Record<string, unknown> | null, basis = RATING_START): Promise<string> {
    const id = this.newId();
    const mine = await this.pool();
    const theirs = opponent === null ? null : z.object({ words: z.array(z.custom<PoolWord>()), skill: z.string().nullable() }).safeParse(opponent.pool);
    const rival = opponent === null ? rivalFor(id, basis) : null;
    const questions = buildQuestions(id, [mine.words, theirs?.success === true ? theirs.data.words : []]);
    const now = this.now().getTime();
    const theirSkill = rival !== null ? rival.skill : theirs?.success === true ? (theirs.data.skill as BattleSkill | null) : null;
    const state = startMatch(now, [mine.skill, theirSkill]);
    await this.options.store.apply({
      op: 'match_create',
      id,
      mode,
      opponent: opponent === null ? null : String(opponent.user),
      rival: rival === null ? null : { basis },
      season: this.season(),
      state,
      questions: questions.map((question) => ({
        idx: question.index,
        direction: question.direction,
        prompt: question.prompt,
        options: question.options,
        sealed: seal(this.options.signingKey, {
          answer: question.answer,
          word: question.word,
          meaning: question.meaning,
          owner: question.owner,
          vocabularyId: question.vocabularyId,
        }),
      })),
    });
    return id;
  }

  // ---- The match ----

  private async load(id: string) {
    const found = await this.options.store.match(id);
    if (found === null) throw new HttpError(404, 'not_found', 'There is no such match.');
    const side = this.sideOf(found.match);
    const rival = found.match.rival === null ? null : rivalFor(found.match.id, found.match.rival.basis);
    return { ...found, side, rival, state: found.match.state as unknown as Stored };
  }

  /** Brings a match up to now: the rival's due answers, this player's presence, and its end. */
  private advance(state: Stored, side: Side, rival: ReturnType<typeof rivalFor> | null, now: number): Stored {
    if (state.finished) return state;
    // Present first, and the rival's answers played, before anyone is judged to have gone.
    let next: MatchState = { ...state, [side]: { ...state[side], lastSeen: now } };
    if (rival !== null) next = playRival(next, rival, now);
    return { ...settle(next, now), results: state.results };
  }

  private async commit(match: MatchRow, state: Stored, answers: unknown[] = []): Promise<boolean> {
    const result = await this.options.store.apply({ op: 'match_commit', id: match.id, version: match.version, state, answers });
    return result?.outcome === 'ok';
  }

  /** The heartbeat: about once a second while a match is on screen. */
  async view(id: string): Promise<PvpMatch> {
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const loaded = await this.load(id);
      const now = this.now().getTime();
      const before = loaded.state;
      const after = this.advance(before, loaded.side, loaded.rival, now);
      const changed =
        after.finished !== before.finished ||
        after.b.at !== before.b.at ||
        now - before[loaded.side].lastSeen >= SEEN_EVERY_MS;
      if (!changed || (await this.commit(loaded.match, after))) {
        const settled = after.finished ? await this.settle(id) : null;
        return this.render(settled ?? { ...loaded, state: after }, null);
      }
    }
    return this.render(await this.load(id), null);
  }

  async answer(id: string, index: number, choice: number): Promise<PvpMatch> {
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const loaded = await this.load(id);
      const question = loaded.questions.find((each) => each.idx === index);
      if (question === undefined) throw new HttpError(400, 'invalid_request', 'There is no such question.');
      const now = this.now().getTime();
      const current = this.advance(loaded.state, loaded.side, loaded.rival, now);
      const sealed = unseal(this.options.signingKey, question.sealed);
      const correct = choice === sealed.answer;
      const outcome = answer(current, loaded.side, index, correct, now);
      if (outcome.kind !== 'scored') return this.render({ ...loaded, state: current }, null);
      const own = sealed.owner === this.options.account;
      const state: Stored = {
        ...outcome.state,
        [loaded.side]: { ...outcome.state[loaded.side], away: outcome.state[loaded.side].away + (own ? 0 : 1) },
        results: loaded.state.results,
      };
      const ok = await this.commit(loaded.match, state, [{ side: loaded.side, idx: index, choice, correct, at: new Date(now).toISOString() }]);
      if (!ok) continue;
      // One's own word: a practice answer, which earns as practice does and never moves its schedule.
      if (own && sealed.vocabularyId !== null) {
        try {
          await this.options.repository.recordPractice({
            id: sealed.vocabularyId,
            requestId: requestIdFor(id, index, loaded.side),
            sessionId: null,
            mode: 'recognition',
            correct,
            grading: 'auto',
            submitted: question.options[choice] ?? null,
            reviewedOn: calendarDateInTimeZone(new Date(now), this.options.timeZone),
            durationMs: Math.max(0, now - current[loaded.side].shownAt),
            confidence: null,
          });
        } catch (error) {
          // The duel goes on; the practice record is what is lost, and the log says so.
          console.error(`Saving a duel answer as practice failed: ${error instanceof Error ? error.name : 'unknown'}`);
        }
      }
      const settled = state.finished ? await this.settle(id) : null;
      return this.render(settled ?? { ...loaded, match: { ...loaded.match, version: loaded.match.version + 1 }, state }, {
        index,
        correct,
        crit: outcome.crit,
        damage: outcome.damage,
        right: sealed.answer,
      });
    }
    throw new HttpError(409, 'conflict', 'The match moved on meanwhile; try again.');
  }

  /** Gives up: the other side wins, and leaving too often locks matchmaking for a while. */
  async forfeit(id: string): Promise<PvpMatch> {
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const loaded = await this.load(id);
      if (loaded.state.finished) break;
      const state: Stored = { ...settle(loaded.state, this.now().getTime(), loaded.side), results: loaded.state.results };
      if (await this.commit(loaded.match, state)) break;
    }
    const settled = await this.settle(id);
    return this.render(settled ?? (await this.load(id)), null);
  }

  /** Once a match is over: ratings, rewards, once. */
  private async settle(id: string) {
    const loaded = await this.load(id);
    const { match, state } = loaded;
    if (!state.finished || match.settled) return loaded;
    const { store } = this.options;
    const [sides, today] = await Promise.all([store.sides(id), store.today(id)]);
    const ratingOf = (side: Side) => (side === 'b' && loaded.rival !== null ? loaded.rival.rating : (sides.find((each) => each.side === side)?.rating ?? RATING_START));
    const users: Partial<Record<Side, string>> = { a: match.player_a, ...(match.player_b === null ? {} : { b: match.player_b }) };
    const name = (side: Side) => (side === 'b' && loaded.rival !== null ? loaded.rival.nickname : (sides.find((each) => each.side === side)?.nickname ?? null));
    const results: NonNullable<Stored['results']> = {};
    const ratings: unknown[] = [];
    const rewards: unknown[] = [];
    for (const side of ['a', 'b'] as const) {
      const user = users[side];
      if (user === undefined) continue;
      const other: Side = side === 'a' ? 'b' : 'a';
      const result = state.winner === 'draw' ? 'draw' : state.winner === side ? 'won' : 'lost';
      const from = ratingOf(side);
      const rated = match.mode !== 'friend';
      const to = rated ? elo(from, ratingOf(other), result === 'won' ? 1 : result === 'draw' ? 0.5 : 0) : from;
      const reward = matchReward(state[side].away, result, today.find((each) => each.side === side)?.matches ?? 0);
      results[side] = { from, to, ...reward };
      if (rated) {
        ratings.push({ user, rating: to, season: this.season(), result, abandoned: state.reason === 'left' && result === 'lost' });
      }
      rewards.push({ user, kind: 'pvp', payload: { ...reward, result, opponent: name(other), mode: match.mode, match: id } });
    }
    const withResults: Stored = { ...state, results };
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const fresh = attempt === 0 ? loaded : await this.load(id);
      if (fresh.match.settled) return fresh;
      if (await this.commit(fresh.match, { ...withResults, results: { ...fresh.state.results, ...results } })) break;
    }
    await store.apply({ op: 'match_settle', id, ratings, rewards });
    return this.load(id);
  }

  private async render(loaded: Awaited<ReturnType<PvpService['load']>>, last: PvpMatch['last']): Promise<PvpMatch> {
    const { match, questions, side, rival, state } = loaded;
    const other: Side = side === 'a' ? 'b' : 'a';
    const me = state[side];
    const them = state[other];
    const sides = await this.options.store.sides(match.id);
    const nameOf = (which: Side) => (which === 'b' && rival !== null ? rival.nickname : (sides.find((each) => each.side === which)?.nickname ?? null));
    const ratingOf = (which: Side) => (which === 'b' && rival !== null ? rival.rating : (sides.find((each) => each.side === which)?.rating ?? RATING_START));
    const question = state.finished ? undefined : questions.find((each) => each.idx === me.at);
    const result = !state.finished ? null : state.winner === 'draw' ? 'draw' : state.winner === side ? 'won' : 'lost';
    const own = state.results?.[side];
    // After the match, the other side's words: each one could be added to one's own vocabulary.
    let words: PvpMatch['words'] = [];
    if (state.finished) {
      const known = new Set((await this.options.catalog.listEntries()).entries.map((entry) => entry.word.trim().toLowerCase()));
      const seenWords = new Set<string>();
      for (const each of questions) {
        const sealed = unseal(this.options.signingKey, each.sealed);
        const key = sealed.word.trim().toLowerCase();
        if (sealed.owner === this.options.account || known.has(key) || seenWords.has(key)) continue;
        seenWords.add(key);
        words.push({ word: sealed.word, meaning: sealed.meaning });
      }
      words = words.slice(0, 12);
    }
    return {
      id: match.id,
      mode: match.mode,
      now: this.now().getTime(),
      endsAt: state.endsAt,
      me: { nickname: nameOf(side), rating: ratingOf(side), hp: me.hp, correct: me.correct, wrong: me.wrong, lockedUntil: me.lockedUntil, skill: me.skill },
      them: { nickname: nameOf(other), rating: ratingOf(other), hp: them.hp, correct: them.correct },
      question: question === undefined ? null : { index: question.idx, direction: question.direction, prompt: question.prompt, options: question.options },
      last,
      finished: state.finished,
      result,
      reason: state.reason,
      reward: own === undefined ? null : { xp: own.xp, stardust: own.stardust, ratingFrom: own.from, ratingTo: own.to },
      words,
    };
  }
}
