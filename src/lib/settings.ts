/**
 * Display and review preferences, kept in this browser only. Nothing here is a secret,
 * none of it is vocabulary, and nothing here is sent to the server.
 */
import { z } from 'zod';
import { DEFAULT_SPEECH_LANGUAGE, SPEECH_LANGUAGES } from './speech.js';

export const SORT_KEYS = [
  'word',
  'dateAdded',
  'reviewDate',
  'mastery',
  'strength',
  'due',
  'reps',
  'lapses',
  'trueMastery',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

const settingsSchema = z.object({
  bankView: z.enum(['table', 'list']),
  bankSort: z.enum(SORT_KEYS),
  bankDirection: z.enum(['asc', 'desc']),
  bankPageSize: z.union([z.literal(25), z.literal(50), z.literal(100)]),
  /** How many days of additions the dashboard chart covers. */
  dashboardDays: z.union([z.literal(14), z.literal(30), z.literal(90)]),
  /** Turns animations off regardless of the system setting. */
  reduceMotion: z.boolean(),
  /** An extra pair of answer keys beside the arrow keys. */
  answerKeys: z.enum(['none', 'jk', 'fj', 'numbers']),
  /** The accent Listening practice asks the browser to read in. */
  speechLang: z.enum(SPEECH_LANGUAGES.map(([code]) => code)),
  /** The interface language. `auto` follows the browser, falling back to Vietnamese. */
  uiLanguage: z.enum(['auto', 'vi', 'en']),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  bankView: 'table',
  bankSort: 'dateAdded',
  bankDirection: 'desc',
  bankPageSize: 50,
  dashboardDays: 30,
  reduceMotion: false,
  answerKeys: 'none',
  speechLang: DEFAULT_SPEECH_LANGUAGE,
  uiLanguage: 'auto',
};

const STORAGE_KEY = 'vocabulary-review:settings:v1';

export interface SettingsStore {
  getState(): Settings;
  subscribe(listener: () => void): () => void;
  update(patch: Partial<Settings>): void;
  reset(): void;
}

function read(storage: Pick<Storage, 'getItem'> | null): Settings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    // Unknown or outdated values fall back field by field rather than discarding everything.
    const stored: unknown = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...(typeof stored === 'object' && stored !== null ? stored : {}) };
    const parsed = settingsSchema.safeParse(merged);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // Storage can be blocked entirely; the app then just uses defaults.
  }
}

export function createSettingsStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = defaultStorage()): SettingsStore {
  let state = read(storage);
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(patch) {
      const next = settingsSchema.safeParse({ ...state, ...patch });
      if (!next.success) return;
      state = next.data;
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // A full or blocked store only means the preference does not persist.
      }
      publish();
    },
    reset() {
      state = DEFAULT_SETTINGS;
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // See above.
      }
      publish();
    },
  };
}
