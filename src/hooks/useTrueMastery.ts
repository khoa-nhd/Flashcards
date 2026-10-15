import { useMemo, useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import type { IsoDate } from '../../shared/dates.js';
import {
  calculateTrueMastery,
  getEvidenceCoverageLabel,
  getTrueMasteryTier,
  type PracticeAnswer,
  type TrueMasteryResult,
} from '../../shared/true-mastery.js';
import { useApp, useVocabulary } from '../app-context.js';
import {
  getCachedPracticeHistory,
  setCachedPracticeHistory,
  subscribeToPracticeHistory,
  invalidatePracticeHistory,
} from '../lib/practice-history-cache.js';

const EMPTY_HISTORY: PracticeAnswer[] = [];

/**
 * Hook for computing True Mastery from practice history.
 * Uses the canonical evidence-based implementation from shared/true-mastery.ts
 * Shares a global cache with other components to avoid duplicate fetches.
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
 * Uses a shared global cache to avoid duplicate fetches across components.
 */
export function useTrueMastery(): UseTrueMasteryReturn {
  const { api } = useApp();
  const { entries, meta } = useVocabulary();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const since: IsoDate | null = null; // null means all history

  // useSyncExternalStore subscribes to the global cache for practice history
  const history = useSyncExternalStore(
    useCallback((callback) => subscribeToPracticeHistory(since, callback), [since]),
    () => {
      const cached = getCachedPracticeHistory(since);
      if (cached) return cached.answers;
      // Return a stable empty array reference
      return EMPTY_HISTORY;
    },
    () => EMPTY_HISTORY
  );

  const loadHistory = useCallback(async () => {
    const today = meta?.today;
    if (!today) return;

    // Check cache first
    const cached = getCachedPracticeHistory(since);
    if (cached && cached.answers.length > 0) {
      // Cache hit - use cached data
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // Fetch practice history for all words in the vocabulary
      // We fetch since the beginning to get all history
      const response = await api.fetchPracticeHistory(since);
      if (response.available) {
        setCachedPracticeHistory(since, response.answers);
      } else {
        setCachedPracticeHistory(since, []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load practice history');
    } finally {
      setLoading(false);
    }
  }, [api, meta?.today, since]);

  // Load on mount and when today changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on mount/dependency change
    void loadHistory();
  }, [loadHistory]);

  // Expose a way to force refresh (e.g., after a new practice answer is confirmed)
  const reload = useCallback(() => {
    invalidatePracticeHistory(since);
    void loadHistory();
  }, [loadHistory, since]);

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
    reload,
  };
}