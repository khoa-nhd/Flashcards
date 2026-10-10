/**
 * Searching, filtering, sorting and paging the Vocabulary Bank. Pure functions
 * over the already-loaded entries; none of this touches the review queue or
 * its order.
 */
import type { VocabularyEntry } from '../../shared/api.js';
import { addDays, compareDates, isIsoDate, type IsoDate } from '../../shared/dates.js';
import { matchesQuery } from '../../shared/text.js';
import type { ReviewStatus, TextFieldKey } from '../../shared/vocabulary.js';
import { SORT_KEYS, type SortDirection, type SortKey } from './settings.js';

/** `learning` is every word that is not yet mastered and has a usable mastery. */
export const STATUS_FILTERS = ['due_today', 'overdue', 'upcoming', 'mastered', 'learning', 'unscheduled'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_LABELS: Record<StatusFilter, string> = {
  due_today: 'Due today',
  overdue: 'Overdue',
  upcoming: 'Upcoming',
  mastered: 'Completed (mastered)',
  learning: 'Learning',
  unscheduled: 'No review date',
};

export const MISSING_LABELS: Record<TextFieldKey, string> = {
  meaning: 'Missing Vietnamese meaning',
  definition: 'Missing definition',
  example: 'Missing example',
};

export interface BankQuery {
  search: string;
  status: StatusFilter | null;
  /** An exact mastery level. */
  mastery: number | null;
  addedFrom: IsoDate | null;
  addedTo: IsoDate | null;
  /** A descriptive field that must be empty. A data-completeness check, not a review result. */
  missing: TextFieldKey | null;
  sort: SortKey;
  direction: SortDirection;
  page: number;
}

export interface BankDefaults {
  sort: SortKey;
  direction: SortDirection;
}

const LEARNING: readonly ReviewStatus[] = ['due_today', 'overdue', 'upcoming', 'unscheduled'];

const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T | null =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;

/** Reads the bank's state from the address bar, ignoring anything malformed. */
export function parseBankQuery(params: URLSearchParams, defaults: BankDefaults): BankQuery {
  const mastery = Number(params.get('mastery'));
  const page = Number(params.get('page'));
  const date = (key: string) => {
    const value = params.get(key);
    return value !== null && isIsoDate(value) ? value : null;
  };
  return {
    search: params.get('q') ?? '',
    status: oneOf(params.get('status'), STATUS_FILTERS),
    mastery: params.has('mastery') && Number.isInteger(mastery) && mastery >= 0 && mastery <= 10 ? mastery : null,
    addedFrom: date('from'),
    addedTo: date('to'),
    missing: oneOf(params.get('missing'), ['meaning', 'definition', 'example'] as const),
    sort: oneOf(params.get('sort'), SORT_KEYS) ?? defaults.sort,
    direction: oneOf(params.get('dir'), ['asc', 'desc'] as const) ?? defaults.direction,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The query-string values for a bank state; defaults are omitted to keep links short. */
export function bankQueryParams(query: BankQuery, defaults: BankDefaults): Record<string, string | number | null> {
  return {
    q: query.search.trim() === '' ? null : query.search,
    status: query.status,
    mastery: query.mastery,
    from: query.addedFrom,
    to: query.addedTo,
    missing: query.missing,
    sort: query.sort === defaults.sort ? null : query.sort,
    dir: query.direction === defaults.direction ? null : query.direction,
    page: query.page > 1 ? query.page : null,
  };
}

export function hasActiveFilters(query: BankQuery): boolean {
  return (
    query.search.trim() !== '' ||
    query.status !== null ||
    query.mastery !== null ||
    query.addedFrom !== null ||
    query.addedTo !== null ||
    query.missing !== null
  );
}

type Filters = Pick<BankQuery, 'status' | 'mastery' | 'addedFrom' | 'addedTo' | 'missing'>;

const NO_FILTERS: Filters = { status: null, mastery: null, addedFrom: null, addedTo: null, missing: null };

/** How many days back "Recently added" reaches, today included. */
export const RECENT_DAYS = 7;

export interface BankPreset {
  key: string;
  label: string;
  filters: (today: IsoDate) => Filters;
}

/** One-click filter combinations. Each is just a named set of the ordinary filters. */
export const BANK_PRESETS: BankPreset[] = [
  { key: 'all', label: 'All', filters: () => NO_FILTERS },
  { key: 'due_today', label: 'Due today', filters: () => ({ ...NO_FILTERS, status: 'due_today' }) },
  { key: 'overdue', label: 'Overdue', filters: () => ({ ...NO_FILTERS, status: 'overdue' }) },
  { key: 'learning', label: 'Learning', filters: () => ({ ...NO_FILTERS, status: 'learning' }) },
  { key: 'mastered', label: 'Mastered', filters: () => ({ ...NO_FILTERS, status: 'mastered' }) },
  {
    key: 'recent',
    label: 'Recently added',
    filters: (today) => ({ ...NO_FILTERS, addedFrom: addDays(today, -(RECENT_DAYS - 1)), addedTo: today }),
  },
  { key: 'missing_definition', label: 'Missing definition', filters: () => ({ ...NO_FILTERS, missing: 'definition' }) },
  { key: 'missing_example', label: 'Missing example', filters: () => ({ ...NO_FILTERS, missing: 'example' }) },
];

/** The preset whose filters are exactly the ones in effect, if any. */
export function activePreset(query: BankQuery, today: IsoDate): string | null {
  if (query.search.trim() !== '') return null;
  const match = BANK_PRESETS.find((preset) => {
    const filters = preset.filters(today);
    return (Object.keys(filters) as Array<keyof Filters>).every((key) => filters[key] === query[key]);
  });
  return match?.key ?? null;
}

/** The descriptive fields a word has not been given. */
export function missingFields(entry: VocabularyEntry): TextFieldKey[] {
  return (['meaning', 'definition', 'example'] as const).filter((key) => entry[key] === null);
}

function matchesStatus(entry: VocabularyEntry, status: StatusFilter): boolean {
  return status === 'learning' ? LEARNING.includes(entry.reviewStatus) : entry.reviewStatus === status;
}

export function filterEntries(entries: readonly VocabularyEntry[], query: BankQuery): VocabularyEntry[] {
  return entries.filter((entry) => {
    // Only fields that are loaded and shown are searched.
    if (!matchesQuery(query.search, [entry.word, entry.meaning, entry.definition, entry.example])) return false;
    if (query.status !== null && !matchesStatus(entry, query.status)) return false;
    if (query.mastery !== null && entry.mastery !== query.mastery) return false;
    if (query.missing !== null && entry[query.missing] !== null) return false;
    if (query.addedFrom !== null || query.addedTo !== null) {
      // A word with no Date Added cannot be placed in a date range.
      if (entry.dateAdded === null) return false;
      if (query.addedFrom !== null && compareDates(entry.dateAdded, query.addedFrom) < 0) return false;
      if (query.addedTo !== null && compareDates(entry.dateAdded, query.addedTo) > 0) return false;
    }
    return true;
  });
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Sorted copy. Empty values always go last, and ties fall back to the word so the order is stable. */
export function sortEntries(
  entries: readonly VocabularyEntry[],
  sort: SortKey,
  direction: SortDirection,
): VocabularyEntry[] {
  const sign = direction === 'asc' ? 1 : -1;
  const byWord = (a: VocabularyEntry, b: VocabularyEntry) => collator.compare(a.word, b.word);

  return [...entries].sort((a, b) => {
    if (sort === 'word') return sign * byWord(a, b);
    const left = a[sort];
    const right = b[sort];
    if (left === null || right === null) {
      if (left === right) return byWord(a, b);
      return left === null ? 1 : -1;
    }
    const order = typeof left === 'number' ? left - (right as number) : compareDates(left, right as string);
    return order === 0 ? byWord(a, b) : sign * order;
  });
}

export interface Page<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  /** 1-based positions of the first and last item shown; both 0 when there are none. */
  from: number;
  to: number;
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page: current,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}
