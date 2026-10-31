/**
 * The sample data's word duels, kept in memory: the same operations as
 * `pvp_apply` (the version 21 migration), for one player. With nobody else
 * to meet, a ranked search ends with a rival after ten seconds.
 */
import type { PvpOp, PvpStore, MatchRow, QuestionRow, QueueRow, RatingRow } from '../pvp-service.js';

export function createMemoryPvpStore(
  account: string,
  nickname: () => Promise<string | null>,
  give: (reward: { kind: 'pvp' | 'pvp_season'; payload: Record<string, unknown> }) => void,
  now: () => Date = () => new Date(),
): PvpStore {
  let rating: RatingRow | null = null;
  let queue: (QueueRow & { pool: unknown }) | null = null;
  const matches = new Map<string, MatchRow>();
  const questions = new Map<string, QuestionRow[]>();
  const iso = () => now().toISOString();

  return {
    rating: async () => (rating === null ? null : { ...rating }),
    queue: async () => (queue === null ? null : { mode: queue.mode, rating: queue.rating, target: queue.target, joined_at: queue.joined_at, match_id: queue.match_id }),
    async match(id) {
      const match = matches.get(id);
      return match === undefined ? null : { match: structuredClone(match), questions: questions.get(id) ?? [] };
    },
    async matches(options) {
      return [...matches.values()]
        .filter((match) => options.unfinished !== true || match.finished_at === null)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, options.limit)
        .map((match) => structuredClone(match));
    },
    async sides(id) {
      const match = matches.get(id);
      return match === undefined ? [] : [{ side: 'a', nickname: await nickname(), rating: rating?.rating ?? 1000 }];
    },
    async today() {
      const start = new Date(now());
      start.setUTCHours(0, 0, 0, 0);
      return [{ side: 'a', matches: [...matches.values()].filter((match) => Date.parse(match.created_at) >= start.getTime()).length }];
    },
    invites: async () => [],
    headToHead: async () => [],
    async apply(op: PvpOp) {
      switch (op.op) {
        case 'consent':
          rating = { ...(rating ?? { rating: 1000, season: String(op.season), wins: 0, losses: 0, draws: 0, locked_until: null }), consented: true };
          return null;
        case 'season_close':
          if (rating !== null && rating.season !== op.season) {
            rating = { ...rating, rating: Number(op.rating), season: String(op.season), wins: 0, losses: 0, draws: 0 };
            if (op.reward != null) give({ kind: 'pvp_season', payload: op.reward as Record<string, unknown> });
          }
          return null;
        case 'queue_join':
          queue = { mode: op.mode as QueueRow['mode'], rating: Number(op.rating), target: (op.target as string | null) ?? null, joined_at: iso(), match_id: null, pool: op.pool };
          return null;
        case 'queue_leave':
          queue = null;
          return null;
        case 'claim':
          return null;
        case 'match_create': {
          const id = String(op.id);
          matches.set(id, {
            id,
            mode: op.mode as MatchRow['mode'],
            player_a: account,
            player_b: null,
            rival: (op.rival as MatchRow['rival']) ?? null,
            season: String(op.season),
            state: op.state as Record<string, unknown>,
            version: 0,
            created_at: iso(),
            finished_at: null,
            winner: null,
            settled: false,
          });
          questions.set(id, op.questions as QuestionRow[]);
          queue = null;
          return null;
        }
        case 'match_commit': {
          const match = matches.get(String(op.id));
          if (match === undefined || match.version !== op.version) return { outcome: 'stale' };
          const state = op.state as { finished?: boolean; winner?: MatchRow['winner'] };
          match.state = op.state as Record<string, unknown>;
          match.version += 1;
          if (state.finished === true && match.finished_at === null) match.finished_at = iso();
          match.winner = match.winner ?? state.winner ?? null;
          return { outcome: 'ok', version: match.version };
        }
        case 'match_settle': {
          const match = matches.get(String(op.id));
          if (match === undefined || match.settled || match.finished_at === null) return { outcome: 'already' };
          match.settled = true;
          for (const entry of (op.ratings as Array<{ user: string; rating: number; season: string; result: string }>) ?? []) {
            if (entry.user !== account) continue;
            const base = rating ?? { rating: 1000, season: entry.season, wins: 0, losses: 0, draws: 0, consented: true, locked_until: null };
            rating = {
              ...base,
              rating: entry.rating,
              season: entry.season,
              wins: base.wins + (entry.result === 'won' ? 1 : 0),
              losses: base.losses + (entry.result === 'lost' ? 1 : 0),
              draws: base.draws + (entry.result === 'draw' ? 1 : 0),
            };
          }
          for (const reward of (op.rewards as Array<{ user: string; kind: 'pvp'; payload: Record<string, unknown> }>) ?? []) {
            if (reward.user === account) give({ kind: reward.kind, payload: reward.payload });
          }
          return null;
        }
        default:
          return null;
      }
    },
  };
}
