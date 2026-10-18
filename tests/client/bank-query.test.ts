import { describe, expect, it } from 'vitest';
import { pageId } from '../helpers/fixtures.js';
import {
  BANK_PRESETS,
  activePreset,
  bankQueryParams,
  defaultSortDirection,
  filterEntries,
  hasActiveFilters,
  missingFields,
  paginate,
  parseBankQuery,
  sortEntries,
  type BankQuery,
} from '../../src/lib/bank-query.js';
import { csvCell, toCsv, toJson } from '../../src/lib/export.js';
import { buildHref, matchRoute } from '../../src/lib/router.js';
import { entry } from '../helpers/fake-api.js';
import { TODAY } from '../helpers/fixtures.js';

const DEFAULTS = { sort: 'dateAdded', direction: 'desc' } as const;
const query = (patch: Partial<BankQuery> = {}): BankQuery => ({
  search: '',
  status: null,
  mastery: null,
  addedFrom: null,
  addedTo: null,
  missing: null,
  sort: 'word',
  direction: 'asc',
  page: 1,
  ...patch,
});

const words = [
  entry(1, { word: 'Serendipity', meaning: 'sự tình cờ', definition: 'a happy accident', example: 'What luck!', mastery: 2, reviewStatus: 'overdue', reviewDate: '2026-10-01', dateAdded: '2026-09-20' }),
  entry(2, { word: 'candid', meaning: 'thẳng thắn', definition: null, example: null, mastery: 10, reviewStatus: 'mastered', reviewable: false, reviewDate: '2026-09-01', dateAdded: '2026-08-01' }),
  entry(3, { word: 'alleviate', meaning: null, definition: 'to make less severe', example: 'It alleviates stress.', mastery: 5, reviewStatus: 'due_today', reviewDate: TODAY, dateAdded: TODAY }),
  entry(4, { word: 'banal', meaning: 'tầm thường', definition: 'boring and ordinary', example: null, mastery: 5, reviewStatus: 'upcoming', reviewable: false, reviewDate: '2026-10-20', dateAdded: '2026-10-05' }),
  entry(5, { word: 'zeal', meaning: 'nhiệt huyết', definition: 'great energy', example: 'Full of zeal.', mastery: 1, reviewStatus: 'unscheduled', reviewDate: null, dateAdded: null }),
];
const names = (list: Array<{ word: string }>) => list.map((item) => item.word);

describe('searching', () => {
  it('finds partial, case-insensitive matches in the word', () => {
    expect(names(filterEntries(words, query({ search: 'SEREN' })))).toEqual(['Serendipity']);
  });

  it('ignores surrounding whitespace', () => {
    expect(names(filterEntries(words, query({ search: '   candid  ' })))).toEqual(['candid']);
  });

  it('searches the meaning, definition and example as well', () => {
    expect(names(filterEntries(words, query({ search: 'tầm thường' })))).toEqual(['banal']);
    expect(names(filterEntries(words, query({ search: 'less severe' })))).toEqual(['alleviate']);
    expect(names(filterEntries(words, query({ search: 'what luck' })))).toEqual(['Serendipity']);
  });

  it('returns nothing for a term that matches no field', () => {
    expect(filterEntries(words, query({ search: 'xylophone' }))).toEqual([]);
  });

  it('returns everything for an empty search', () => {
    expect(filterEntries(words, query({ search: '  ' }))).toHaveLength(5);
  });
});

describe('filtering', () => {
  it('filters by each review status', () => {
    expect(names(filterEntries(words, query({ status: 'due_today' })))).toEqual(['alleviate']);
    expect(names(filterEntries(words, query({ status: 'overdue' })))).toEqual(['Serendipity']);
    expect(names(filterEntries(words, query({ status: 'unscheduled' })))).toEqual(['zeal']);
  });

  it('treats Completed as mastery 10', () => {
    expect(names(filterEntries(words, query({ status: 'mastered' })))).toEqual(['candid']);
  });

  it('keeps already-due words out of Upcoming', () => {
    expect(names(filterEntries(words, query({ status: 'upcoming' })))).toEqual(['banal']);
  });

  it('counts every unfinished word as Learning', () => {
    expect(names(filterEntries(words, query({ status: 'learning' })))).toEqual([
      'Serendipity',
      'alleviate',
      'banal',
      'zeal',
    ]);
  });

  it('filters by an exact mastery level, including 0', () => {
    expect(names(filterEntries(words, query({ mastery: 5 })))).toEqual(['alleviate', 'banal']);
    expect(filterEntries([entry(9, { mastery: 0 })], query({ mastery: 0 }))).toHaveLength(1);
    expect(filterEntries(words, query({ mastery: 0 }))).toEqual([]);
  });

  it('filters by a Date Added range, inclusive at both ends', () => {
    expect(names(filterEntries(words, query({ addedFrom: '2026-09-20', addedTo: '2026-10-05' })))).toEqual([
      'Serendipity',
      'banal',
    ]);
    expect(names(filterEntries(words, query({ addedFrom: TODAY })))).toEqual(['alleviate']);
    expect(names(filterEntries(words, query({ addedTo: '2026-08-01' })))).toEqual(['candid']);
  });

  it('leaves words without a Date Added out of any date range', () => {
    expect(names(filterEntries(words, query({ addedFrom: '2000-01-01' })))).not.toContain('zeal');
  });

  it('finds words missing a descriptive field', () => {
    expect(names(filterEntries(words, query({ missing: 'definition' })))).toEqual(['candid']);
    expect(names(filterEntries(words, query({ missing: 'example' })))).toEqual(['candid', 'banal']);
    expect(names(filterEntries(words, query({ missing: 'meaning' })))).toEqual(['alleviate']);
    expect(missingFields(words[1]!)).toEqual(['definition', 'example']);
    expect(missingFields(words[0]!)).toEqual([]);
  });

  it('combines filters with search', () => {
    expect(names(filterEntries(words, query({ mastery: 5, search: 'ordinary' })))).toEqual(['banal']);
    expect(filterEntries(words, query({ mastery: 5, status: 'mastered' }))).toEqual([]);
  });

  it('never changes the entries it is given', () => {
    const before = JSON.stringify(words);
    filterEntries(words, query({ status: 'overdue', search: 'x' }));
    sortEntries(words, 'mastery', 'desc');
    expect(JSON.stringify(words)).toBe(before);
  });

  it('knows when any filter is active', () => {
    expect(hasActiveFilters(query())).toBe(false);
    expect(hasActiveFilters(query({ sort: 'mastery', direction: 'desc', page: 3 }))).toBe(false);
    expect(hasActiveFilters(query({ search: 'a' }))).toBe(true);
    expect(hasActiveFilters(query({ mastery: 0 }))).toBe(true);
  });
});

describe('presets', () => {
  it('are plain combinations of the ordinary filters', () => {
    const apply = (key: string) => {
      const preset = BANK_PRESETS.find((item) => item.key === key)!;
      return names(filterEntries(words, query(preset.filters(TODAY))));
    };
    expect(apply('all')).toHaveLength(5);
    expect(apply('due_today')).toEqual(['alleviate']);
    expect(apply('overdue')).toEqual(['Serendipity']);
    expect(apply('mastered')).toEqual(['candid']);
    expect(apply('learning')).toHaveLength(4);
    // Today and the six days before it.
    expect(apply('recent')).toEqual(['alleviate', 'banal']);
    expect(apply('missing_definition')).toEqual(['candid']);
    expect(apply('missing_example')).toEqual(['candid', 'banal']);
  });

  it('is shown as active only when the filters match it exactly', () => {
    expect(activePreset(query(), TODAY)).toBe('all');
    expect(activePreset(query({ status: 'overdue' }), TODAY)).toBe('overdue');
    expect(activePreset(query({ status: 'overdue', mastery: 3 }), TODAY)).toBeNull();
    expect(activePreset(query({ status: 'overdue', search: 'x' }), TODAY)).toBeNull();
    expect(activePreset(query({ addedFrom: '2026-10-03', addedTo: TODAY }), TODAY)).toBe('recent');
  });
});

describe('sorting', () => {
  it('sorts alphabetically without regard to case, both ways', () => {
    expect(names(sortEntries(words, 'word', 'asc'))).toEqual(['alleviate', 'banal', 'candid', 'Serendipity', 'zeal']);
    expect(names(sortEntries(words, 'word', 'desc'))).toEqual(['zeal', 'Serendipity', 'candid', 'banal', 'alleviate']);
  });

  it('sorts by mastery, with ties in alphabetical order', () => {
    expect(names(sortEntries(words, 'mastery', 'asc'))).toEqual(['zeal', 'Serendipity', 'alleviate', 'banal', 'candid']);
    expect(names(sortEntries(words, 'mastery', 'desc'))).toEqual(['candid', 'alleviate', 'banal', 'Serendipity', 'zeal']);
  });

  it('sorts by Date Added and puts undated words last in both directions', () => {
    expect(names(sortEntries(words, 'dateAdded', 'asc'))).toEqual(['candid', 'Serendipity', 'banal', 'alleviate', 'zeal']);
    expect(names(sortEntries(words, 'dateAdded', 'desc'))).toEqual(['alleviate', 'banal', 'Serendipity', 'candid', 'zeal']);
  });

  it('sorts by review date and puts unscheduled words last in both directions', () => {
    expect(names(sortEntries(words, 'reviewDate', 'asc'))).toEqual(['candid', 'Serendipity', 'alleviate', 'banal', 'zeal']);
    expect(names(sortEntries(words, 'reviewDate', 'desc')).at(-1)).toBe('zeal');
  });

  it('starts every weakness sort from the weakest and every addition sort from the newest', () => {
    expect(defaultSortDirection('word')).toBe('asc');
    expect(defaultSortDirection('mastery')).toBe('asc');
    expect(defaultSortDirection('trueMastery')).toBe('asc');
    expect(defaultSortDirection('reviewDate')).toBe('asc');
    expect(defaultSortDirection('dateAdded')).toBe('desc');
  });
});

describe('pagination', () => {
  const items = Array.from({ length: 23 }, (_, index) => index + 1);

  it('splits results into pages and reports the range shown', () => {
    expect(paginate(items, 1, 10)).toMatchObject({ items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], page: 1, pageCount: 3, total: 23, from: 1, to: 10 });
    expect(paginate(items, 3, 10)).toMatchObject({ items: [21, 22, 23], page: 3, from: 21, to: 23 });
  });

  it('clamps a page number that is out of range', () => {
    expect(paginate(items, 99, 10).page).toBe(3);
    expect(paginate(items, 0, 10).page).toBe(1);
  });

  it('handles an empty result', () => {
    expect(paginate([], 1, 10)).toEqual({ items: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0 });
  });

  it('fits exactly full pages without an empty last page', () => {
    expect(paginate(items.slice(0, 20), 2, 10)).toMatchObject({ pageCount: 2, from: 11, to: 20 });
  });
});

describe('the bank address', () => {
  it('round-trips the whole state through the query string', () => {
    const state = query({
      search: 'ser',
      status: 'overdue',
      mastery: 0,
      addedFrom: '2026-10-01',
      addedTo: TODAY,
      missing: 'example',
      sort: 'mastery',
      direction: 'asc',
      page: 2,
    });
    const href = buildHref('/bank', bankQueryParams(state, DEFAULTS));
    const parsed = parseBankQuery(new URLSearchParams(href.split('?')[1]), DEFAULTS);
    expect(parsed).toEqual(state);
  });

  it('keeps the address clean when everything is at its default', () => {
    expect(buildHref('/bank', bankQueryParams(parseBankQuery(new URLSearchParams(), DEFAULTS), DEFAULTS))).toBe('/bank');
  });

  it('ignores malformed values instead of failing', () => {
    const parsed = parseBankQuery(
      new URLSearchParams('status=nonsense&mastery=42&from=2026-02-30&to=yesterday&missing=price&sort=colour&dir=sideways&page=-3'),
      DEFAULTS,
    );
    expect(parsed).toEqual(query({ sort: 'dateAdded', direction: 'desc' }));
  });

  it('recognises each page path', () => {
    expect(matchRoute('/')).toBe('dashboard');
    expect(matchRoute('/review')).toBe('review');
    expect(matchRoute('/bank')).toBe('bank');
    expect(matchRoute('/nowhere')).toBeNull();
  });
});

describe('export', () => {
  it('quotes CSV values only when needed and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('one, two')).toBe('"one, two"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell(' padded ')).toBe('" padded "');
    expect(csvCell(7)).toBe('7');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
  });

  it('writes a header row and one row per word, keeping text and dates as stored', () => {
    const csv = toCsv([
      entry(1, { word: 'café', meaning: 'quán, "cà phê"', definition: 'a small restaurant', example: null, mastery: 0, reviewDate: null, dateAdded: '2026-10-01' }),
    ]);
    expect(csv).toBe(
      'Word,Vietnamese Meaning,Definition,Example Sentences,Mastery,Review Date,Date Added,ID\r\n' +
        `café,"quán, ""cà phê""",a small restaurant,,0,,2026-10-01,${pageId(1)}\r\n`,
    );
  });

  it('exports JSON with the same fields and no credentials', () => {
    const parsed = JSON.parse(toJson([words[0]!], '2026-10-10T00:00:00.000Z'));
    expect(parsed).toMatchObject({ exportedAt: '2026-10-10T00:00:00.000Z', count: 1 });
    expect(Object.keys(parsed.entries[0]).sort()).toEqual(
      ['dateAdded', 'definition', 'exampleSentences', 'id', 'mastery', 'reviewDate', 'vietnameseMeaning', 'word'].sort(),
    );
    expect(parsed.entries[0]).toMatchObject({ word: 'Serendipity', mastery: 2, dateAdded: '2026-09-20' });
  });
});
