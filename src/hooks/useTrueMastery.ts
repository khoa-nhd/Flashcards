import { useMemo, useState, useEffect, useCallback } from 'react';
import type { IsoDate } from '../../shared/dates.js';
import {
  calculateTrueMastery,
  getEvidenceCoverageLabel,
  getTrueMasteryTier,
  type PracticeAnswer,
  type TrueMasteryResult,
} from '../../shared/true-mastery.js';
import { useApp, useVocabulary } from '../app-context.js';

/**
 * Hook for computing True Mastery from practice history.
 * Uses the canonical evidence-based implementation from shared/true-mastery.ts
 */

export interface TrueMasteryEntry {
  mastery: number | null;
  tier: string;
  coverage: 'insufficient' | 'low' | 'moderate' | 'high';
  coverageLabel: string;
  totalEffectiveEvidence: number;
  modesWithEvidence: number;
  modes: TrueMasteryResult['modes'];
  hasAnyPractice: boolean;
  /** Per-mode stats for display in the vocabulary bank tooltip */
  modeStats: Array<{
    mode: string;
    correct: number;
    total: number;
    accuracy: number;
    effectiveEvidence: number;
  }>;
}

export interface UseTrueMasteryReturn {
  /** Map from vocabulary entry ID to True Mastery data */
  trueMasteryMap: Map<string, TrueMasteryEntry>;
  /** Whether practice history is still loading */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** Reload practice history */
  reload: () => void;
}

/**
 * Hook to compute True Mastery for vocabulary entries.
 * Fetches practice history from the API and computes evidence-based mastery.
 */
export function useTrueMastery(): UseTrueMasteryReturn {
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
      // Fetch practice history for all words in the vocabulary
      // We fetch since the beginning to get all history
      const since: IsoDate | null = null; // null means all history
      const response = await api.fetchPracticeHistory(since);
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

  // Load on mount and when today changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on mount/dependency change
    void loadHistory();
  }, [loadHistory]);

  const trueMasteryMap = useMemo(() => {
    const today = meta?.today;
    if (!today) return new Map<string, TrueMasteryEntry>();

    const map = new Map<string, TrueMasteryEntry>();

    // Group history by vocabulary ID
    const historyByVocab = new Map<string, PracticeAnswer[]>();
    for (const answer of history) {
      const arr = historyByVocab.get(answer.vocabularyId) ?? [];
      arr.push(answer);
      historyByVocab.set(answer.vocabularyId, arr);
    }

    // Compute True Mastery for each entry that has history
    for (const entry of entries) {
      const vocabHistory = historyByVocab.get(entry.id) ?? [];
      const result = calculateTrueMastery(vocabHistory, today);
      map.set(entry.id, {
        mastery: result.mastery,
        tier: getTrueMasteryTier(result.mastery),
        coverage: result.coverage,
        coverageLabel: getEvidenceCoverageLabel(result.coverage),
        totalEffectiveEvidence: result.totalEffectiveEvidence,
        modesWithEvidence: result.modesWithEvidence,
        modes: result.modes,
        hasAnyPractice: result.hasAnyPractice,
        modeStats: result.modes.map(m => ({
          mode: m.mode,
          correct: m.correctAnswers,
          total: m.totalAnswers,
          accuracy: m.accuracy,
          effectiveEvidence: m.effectiveEvidence,
        })),
      });
    }

    return map;
  }, [entries, history, meta?.today]);

  return {
    trueMasteryMap,
    loading,
    error,
    reload: loadHistory,
  };
}