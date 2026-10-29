/**
 * The game as the page knows it (docs/gamification-plan.md, phase 1): the last
 * copy the server sent, kept for as long as the page is open and brought
 * forward by every answer's reply, so the XP bar moves with each card without
 * asking again. Keyed by the account's API object, so one account never sees
 * another's.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { AnswerGame, GameResponse } from '../../shared/api.js';
import { levelOf } from '../../shared/gamification/levels.js';
import type { AppApi } from './api-client.js';
import { ApiError } from './api-client.js';

type GameApi = Pick<AppApi, 'fetchGame'>;

const known = new WeakMap<object, GameResponse>();
const inFlight = new WeakMap<object, Promise<GameResponse>>();
const listeners = new Set<() => void>();
const earned = new Set<(answer: AnswerGame) => void>();

function publish(api: object, game: GameResponse) {
  known.set(api, game);
  for (const listener of listeners) listener();
}

/** The game this account was last told, if any. */
export function knownGame(api: object): GameResponse | undefined {
  return known.get(api);
}

/** Asks for the game; requests made at the same time share one. */
export function fetchGameShared(api: GameApi): Promise<GameResponse> {
  const pending = inFlight.get(api);
  if (pending !== undefined) return pending;
  const request = api.fetchGame().then(
    (game) => {
      inFlight.delete(api);
      publish(api, game);
      return game;
    },
    (error: unknown) => {
      inFlight.delete(api);
      throw error;
    },
  );
  inFlight.set(api, request);
  return request;
}

/** Takes a game the server just sent (after a claim, say) as the latest. */
export function adoptGame(api: object, game: GameResponse): void {
  publish(api, game);
}

/**
 * Brings the known game forward by one answer's reply, and tells whoever shows
 * the "+XP" beside the card.
 */
export function applyAnswer(api: object, answer: AnswerGame): void {
  const game = known.get(api);
  if (game !== undefined) {
    publish(api, {
      ...game,
      totalXp: answer.totalXp,
      level: levelOf(answer.totalXp),
      combo: { ...game.combo, count: answer.combo, bonus: answer.comboBonus, longest: Math.max(game.combo.longest, answer.combo) },
    });
  }
  for (const listener of earned) listener(answer);
}

/** Called with each answer's reply that carried XP. */
export function subscribeEarned(listener: (answer: AnswerGame) => void): () => void {
  earned.add(listener);
  return () => earned.delete(listener);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface GameState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: GameResponse | null;
  error: string | null;
  reload: () => Promise<void>;
}

/** The game, loaded on first use and kept current; `enabled` false leaves it unasked. */
export function useGame(api: GameApi, enabled = true): GameState {
  const data = useSyncExternalStore(subscribe, () => known.get(api) ?? null, () => null);
  const [status, setStatus] = useState<GameState['status']>(() =>
    known.has(api) ? 'ready' : enabled ? 'loading' : 'idle',
  );
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
    setError(null);
    try {
      await fetchGameShared(api);
      setStatus('ready');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load your XP.');
      setStatus((current) => (current === 'ready' ? 'ready' : 'error'));
    }
  }, [api, enabled]);

  // The first load: state is set only when the answer arrives, never during the effect itself.
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    fetchGameShared(api).then(
      () => {
        if (active) setStatus('ready');
      },
      (cause: unknown) => {
        if (!active) return;
        setError(cause instanceof ApiError ? cause.message : 'Could not load your XP.');
        setStatus((current) => (current === 'ready' ? 'ready' : 'error'));
      },
    );
    return () => {
      active = false;
    };
  }, [api, enabled]);

  return { status: data === null ? status : 'ready', data, error, reload };
}
