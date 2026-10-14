import { useMemo, useState, useEffect, useCallback } from 'react';
import type { IsoDate } from '../../shared/dates.js';
import {
  type PracticeAnswer,
  type PracticeHistoryResponse,
} from '../../shared/true-mastery.js';
import { useApp, useVocabulary } from '../app-context.js';

export interface PracticeModeStats {
  mode: string;
  correct: number;
  total: number;
  mastery: number; // correct, capped at max (10)
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
export function usePracticeStats(): UsePracticeStatsReturn {
  const { api } = useApp();
  const { entries, meta } = useVocabulary();

  const [history, setHistory] = useState<PracticeAnswer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    const today = meta?.today;
    if (!today) {
      setHistory([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await api.fetchPracticeHistory(null);
      if (response.available) {
        setHistory(response.answers);
      } else {
        setHistory([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load practice history');
    } finally {
      setLoading(false);
    }
  }, [api, meta?.today]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

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
          mastery: correct, // We'll cap at 10 for display if needed
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
    reload: loadHistory,
  };
}