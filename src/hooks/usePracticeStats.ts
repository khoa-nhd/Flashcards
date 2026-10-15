import { useMemo, useState, useEffect, useCallback } from 'react';
import type { IsoDate } from '../../shared/dates.js';
import {
  type PracticeAnswer,
} from '../../shared/true-mastery.js';
import { practiceMasteryOf } from '../../shared/study-modes.js';
import { useApp, useVocabulary } from '../app-context.js';

export interface PracticeModeStats {
  mode: string;
  correct: number;
  total: number;
  mastery: number; // correct answers, capped at 3 per mode (practiceMasteryOf)
}

export interface WordPracticeStats {
  vocabularyId: string;
  word: string;
  modes: PracticeModeStats[];
  totalCorrect: number;
  totalAnswers: number;
  lastPractisedOn: IsoDate | null;
}

export interface UsePracticeStatsReturn {
  statsMap: Map<string, WordPracticeStats>;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Hook to compute practice statistics per word from practice history.
 * Shows correct/total answers per mode for each word.
 */
const EMPTY: PracticeAnswer[] = [];

export function usePracticeStats(): UsePracticeStatsReturn {
  const { api } = useApp();
  const { entries, meta } = useVocabulary();

  const today = meta?.today ?? null;
  const [reloads, setReloads] = useState(0);
  /** The latest answer, tagged with the load it belongs to so a stale one is never shown as current. */
  const [result, setResult] = useState<{ key: string; history: PracticeAnswer[]; error: string | null } | null>(null);
  const key = `${today}:${reloads}`;

  useEffect(() => {
    if (today === null) return;
    let active = true;
    api.fetchPracticeHistory(null).then(
      (response) => {
        if (active) setResult({ key, history: response.available ? response.answers : [], error: null });
      },
      (err: unknown) => {
        if (active) setResult((latest) => ({ key, history: latest?.history ?? [], error: err instanceof Error ? err.message : 'Failed to load practice history' }));
      },
    );
    return () => {
      active = false;
    };
  }, [api, today, key]);

  const history = result?.history ?? EMPTY;
  const loading = today !== null && result?.key !== key;
  const error = result?.key === key ? result.error : null;
  const reload = useCallback(() => setReloads((count) => count + 1), []);

  const statsMap = useMemo(() => {
    const map = new Map<string, WordPracticeStats>();

    // Group history by vocabulary ID
    const historyByVocab = new Map<string, PracticeAnswer[]>();
    for (const answer of history) {
      const arr = historyByVocab.get(answer.vocabularyId) ?? [];
      arr.push(answer);
      historyByVocab.set(answer.vocabularyId, arr);
    }

    // Compute stats for each entry
    for (const entry of entries) {
      const vocabHistory = historyByVocab.get(entry.id) ?? [];

      // Group by mode
      const byMode = new Map<string, PracticeAnswer[]>();
      for (const answer of vocabHistory) {
        const arr = byMode.get(answer.mode) ?? [];
        arr.push(answer);
        byMode.set(answer.mode, arr);
      }

      const modes: PracticeModeStats[] = [];
      let totalCorrect = 0;
      let totalAnswers = 0;
      let lastPractisedOn: IsoDate | null = null;

      for (const [mode, modeAnswers] of byMode) {
        const correct = modeAnswers.filter((a) => a.correct).length;
        const total = modeAnswers.length;
        modes.push({
          mode,
          correct,
          total,
          mastery: practiceMasteryOf(correct),
        });
        totalCorrect += correct;
        totalAnswers += total;

        // Track last practised date
        for (const answer of modeAnswers) {
          if (lastPractisedOn === null || answer.reviewedOn > lastPractisedOn) {
            lastPractisedOn = answer.reviewedOn;
          }
        }
      }

      // Sort modes by total answers descending
      modes.sort((a, b) => b.total - a.total);

      map.set(entry.id, {
        vocabularyId: entry.id,
        word: entry.word,
        modes,
        totalCorrect,
        totalAnswers,
        lastPractisedOn,
      });
    }

    return map;
  }, [entries, history]);

  return {
    statsMap,
    loading,
    error,
    reload,
  };
}