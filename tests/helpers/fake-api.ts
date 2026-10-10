/** A complete in-memory stand-in for the server, for component tests. */
import { vi } from 'vitest';
import type {
  AccountSettings,
  QueueResponse,
  ReviewActionResponse,
  ReviewCard,
  VocabularyEntry,
  VocabularyListResponse,
} from '../../shared/api.js';
import { ApiError, type AppApi } from '../../src/lib/api-client.js';
import { TIME_ZONE, TODAY, deferred, pageId, queueResponse, type Deferred } from './fixtures.js';

export function entry(n: number, overrides: Partial<VocabularyEntry> = {}): VocabularyEntry {
  return {
    id: pageId(n),
    word: `word-${n}`,
    meaning: `nghĩa ${n}`,
    definition: `definition of word-${n}`,
    example: `example for word-${n}`,
    mastery: 3,
    reviewDate: TODAY,
    dateAdded: '2026-10-01',
    reviewStatus: 'due_today',
    reviewable: true,
    createdTime: '2026-10-01T02:00:00.000Z',
    lastEditedTime: '2026-10-05T02:00:00.000Z',
    ...overrides,
  };
}

export function vocabularyList(
  entries: VocabularyEntry[],
  overrides: Partial<VocabularyListResponse> = {},
): VocabularyListResponse {
  return {
    entries,
    today: TODAY,
    timeZone: TIME_ZONE,
    mode: 'supabase',
    writesEnabled: true,
    skipped: [],
    defaults: { mastery: 1, reviewDate: 'empty' },
    ...overrides,
  };
}

export interface FakeApiOptions {
  cards?: ReviewCard[];
  queue?: Partial<QueueResponse>;
  entries?: VocabularyEntry[];
  list?: Partial<VocabularyListResponse>;
  /** Words already in the trash. */
  trashed?: VocabularyEntry[];
  account?: Partial<AccountSettings>;
}

export function createFakeApi({
  cards = [],
  queue = {},
  entries = [],
  list = {},
  trashed = [],
  account = {},
}: FakeApiOptions = {}) {
  /** Review saves stay pending until a test settles them. */
  const saves: Array<Deferred<ReviewActionResponse>> = [];
  const store = entries.map((item) => ({ ...item }));
  const trash = new Map<string, VocabularyEntry>(trashed.map((item) => [item.id, { ...item }]));
  const settings: AccountSettings = { timeZone: TIME_ZONE, timeZoneEditable: true, email: 'me@example.test', ...account };
  let nextId = 500;

  const find = (id: string) => {
    const found = store.find((item) => item.id === id);
    if (!found) throw new ApiError('not_found', 'That word is not in the vocabulary database.', 404);
    return found;
  };

  const api = {
    fetchQueue: vi.fn<AppApi['fetchQueue']>(async () => queueResponse(cards, queue)),
    submitAction: vi.fn<AppApi['submitAction']>(() => {
      const pending = deferred<ReviewActionResponse>();
      saves.push(pending);
      return pending.promise;
    }),
    fetchVocabulary: vi.fn<AppApi['fetchVocabulary']>(async () => vocabularyList(store.map((item) => ({ ...item })), list)),
    fetchEntry: vi.fn<AppApi['fetchEntry']>(async (id) => ({ ...find(id) })),
    createEntry: vi.fn<AppApi['createEntry']>(async (input) => {
      const created = entry(nextId++, {
        word: input.word.trim(),
        meaning: input.meaning?.trim() || null,
        definition: input.definition?.trim() || null,
        example: input.example?.trim() || null,
        dateAdded: input.dateAdded ?? TODAY,
        mastery: input.mastery ?? 1,
        reviewDate: input.reviewDate ?? null,
        reviewStatus: input.reviewDate ? 'upcoming' : 'unscheduled',
        reviewable: !input.reviewDate,
      });
      store.unshift(created);
      return { ...created };
    }),
    updateEntry: vi.fn<AppApi['updateEntry']>(async (id, input) => {
      const current = find(id);
      const text = (value: string | undefined, before: string | null) =>
        value === undefined ? before : value.trim() === '' ? null : value.trim();
      Object.assign(current, {
        word: input.word?.trim() ?? current.word,
        meaning: text(input.meaning, current.meaning),
        definition: text(input.definition, current.definition),
        example: text(input.example, current.example),
        dateAdded: input.dateAdded === undefined ? current.dateAdded : input.dateAdded,
        mastery: input.schedule?.mastery ?? current.mastery,
        reviewDate: input.schedule === undefined ? current.reviewDate : input.schedule.reviewDate,
      });
      return { ...current };
    }),
    deleteEntry: vi.fn<AppApi['deleteEntry']>(async (id) => {
      const current = find(id);
      store.splice(store.indexOf(current), 1);
      trash.set(id, current);
    }),
    restoreEntry: vi.fn<AppApi['restoreEntry']>(async (id) => {
      const restored = trash.get(id);
      if (!restored) throw new ApiError('not_found', 'That word is not in the vocabulary database.', 404);
      trash.delete(id);
      store.unshift(restored);
      return { ...restored };
    }),
    fetchTrash: vi.fn<AppApi['fetchTrash']>(async () => [...trash.values()].map((item) => ({ ...item }))),

    fetchSettings: vi.fn<AppApi['fetchSettings']>(async () => ({ ...settings })),
    saveSettings: vi.fn<AppApi['saveSettings']>(async ({ timeZone }) => {
      settings.timeZone = timeZone;
      return { ...settings };
    }),
  } satisfies AppApi;

  return { api, saves, store };
}
