import { describe, expect, it } from 'vitest';
import type { VocabularyEntry } from '../../shared/api.js';
import {
  IMPORT_LIMITS,
  checkRows,
  chunkForUpload,
  detectDelimiter,
  fieldForHeader,
  guessMapping,
  looksLikeHeader,
  mappingProblem,
  parseDelimited,
  parseImportText,
  rowProblem,
  toImportRows,
  type ImportRow,
} from '../../shared/import.js';
import { toCsv, toJson } from '../../src/lib/export.js';

const row = (overrides: Partial<ImportRow> = {}): ImportRow => ({
  line: 1,
  word: 'candid',
  meaning: null,
  definition: null,
  example: null,
  dateAdded: null,
  ...overrides,
});

describe('reading delimited text', () => {
  it('splits rows and cells, trimming what is not quoted', () => {
    expect(parseDelimited('word, meaning\ncandid , thẳng thắn\n', ',')).toEqual([
      ['word', 'meaning'],
      ['candid', 'thẳng thắn'],
    ]);
  });

  it('keeps delimiters, line breaks, quotes and outer spaces that are inside quotes', () => {
    const text = 'candid,"honest, and direct"\nlucid,"clear\nacross two lines"\nsay,"He said ""no"""\npad,"  kept  "\n';
    expect(parseDelimited(text, ',')).toEqual([
      ['candid', 'honest, and direct'],
      ['lucid', 'clear\nacross two lines'],
      ['say', 'He said "no"'],
      ['pad', '  kept  '],
    ]);
  });

  it('reads Windows line endings, a byte-order mark and a missing final line break', () => {
    expect(parseDelimited('\uFEFFa,b\r\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps empty cells in place and drops rows that are entirely empty', () => {
    expect(parseDelimited('a,,c\n\n,,\n"",x\n', ',')).toEqual([
      ['a', '', 'c'],
      ['', 'x'],
    ]);
  });

  it('treats a quote in the middle of a cell as an ordinary character', () => {
    expect(parseDelimited('a 5" nail,b\n', ',')).toEqual([['a 5" nail', 'b']]);
  });

  it('reads tabs and semicolons the same way', () => {
    expect(parseDelimited('candid\tthẳng thắn\n', '\t')).toEqual([['candid', 'thẳng thắn']]);
    expect(parseDelimited('candid;"a; b"\n', ';')).toEqual([['candid', 'a; b']]);
  });
});

describe('working out how a text is written', () => {
  it('finds the delimiter that splits the lines evenly', () => {
    expect(detectDelimiter('word,meaning\na,b\nc,d\n')).toBe(',');
    expect(detectDelimiter('word\tmeaning\na\tb\n')).toBe('\t');
    expect(detectDelimiter('word;meaning\na;b\n')).toBe(';');
  });

  it('is not misled by a delimiter inside quotes', () => {
    expect(detectDelimiter('word\tmeaning\ncandid\t"honest, direct, and plain"\n')).toBe('\t');
  });

  it('finds none in a plain list, even when some lines contain a comma', () => {
    expect(detectDelimiter('candid\nlucid\ntenacious\n')).toBeNull();
    expect(detectDelimiter('candid\nwell, then\nlucid\ntenacious\nephemeral\n')).toBeNull();
    expect(detectDelimiter('')).toBeNull();
  });

  it('reads a plain list as one word per line, taken whole', () => {
    expect(parseImportText(' candid \n\nwell, then\r\nlucid')).toEqual({
      format: 'lines',
      delimiter: null,
      rows: [['candid'], ['well, then'], ['lucid']],
      header: null,
    });
  });

  it('reads delimited text and says which delimiter it used', () => {
    expect(parseImportText('word;meaning\ncandid;thẳng thắn')).toMatchObject({ format: 'delimited', delimiter: ';' });
  });

  it('falls back to text when something that looks like JSON is not', () => {
    expect(parseImportText('[not json').format).toBe('lines');
    expect(parseImportText('{"unrelated": true}').format).toBe('lines');
  });
});

describe('matching columns to fields', () => {
  it('recognises the headings this app exports, and common others', () => {
    expect(fieldForHeader('Word')).toBe('word');
    expect(fieldForHeader('Vietnamese Meaning')).toBe('meaning');
    expect(fieldForHeader(' definition ')).toBe('definition');
    expect(fieldForHeader('Example Sentences')).toBe('example');
    expect(fieldForHeader('date_added')).toBe('dateAdded');
    expect(fieldForHeader('Nghĩa')).toBe('meaning');
  });

  it('does not map the columns that carry review state or an id', () => {
    for (const heading of ['Mastery', 'Review Date', 'ID', 'Notes', '']) expect(fieldForHeader(heading), heading).toBeNull();
  });

  it('tells a header row from a row of data', () => {
    expect(looksLikeHeader(['Word', 'Vietnamese Meaning'])).toBe(true);
    expect(looksLikeHeader(['candid', 'thẳng thắn'])).toBe(false);
    // "definition" alone is a perfectly good word to be learning.
    expect(looksLikeHeader(['definition', 'định nghĩa'])).toBe(false);
  });

  it('follows the headings when there are some, each field once', () => {
    expect(guessMapping(5, ['Word', 'Mastery', 'Meaning', 'Word', 'Example'])).toEqual(['word', null, 'meaning', null, 'example']);
  });

  it('assumes the usual order when there are none, and leaves extra columns out', () => {
    expect(guessMapping(2, null)).toEqual(['word', 'meaning']);
    expect(guessMapping(6, null)).toEqual(['word', 'meaning', 'definition', 'example', null, null]);
  });

  it('needs a word column, and each field from one column only', () => {
    expect(mappingProblem(['word', 'meaning'])).toBeNull();
    expect(mappingProblem([null, 'meaning'])).toBe('Choose which column holds the word.');
    expect(mappingProblem(['word', 'meaning', 'meaning'])).toMatch(/Two columns are set to “Vietnamese meaning”/);
  });
});

describe('turning rows into words', () => {
  it('picks out the mapped columns, tidies the word, and treats an empty cell as no value', () => {
    const rows = [
      ['Word', 'Skip', 'Meaning'],
      ['  take   off ', 'x', ' cất cánh '],
      ['candid', 'x', ''],
    ];
    expect(toImportRows(rows, ['word', null, 'meaning'], true)).toEqual([
      row({ line: 2, word: 'take off', meaning: 'cất cánh' }),
      row({ line: 3, word: 'candid', meaning: null }),
    ]);
  });

  it('keeps a row that has content but no word, so it can be reported rather than lost', () => {
    const rows = [
      ['', 'orphan meaning'],
      ['', ''],
      ['candid'],
    ];
    const built = toImportRows(rows, ['word', 'meaning'], false);
    expect(built.map((item) => [item.line, item.word, item.meaning])).toEqual([
      [1, '', 'orphan meaning'],
      [3, 'candid', null],
    ]);
  });

  it('counts lines from the top of the source, header included', () => {
    expect(toImportRows([['Word'], ['a'], ['b']], ['word'], true).map((item) => item.line)).toEqual([2, 3]);
    expect(toImportRows([['a'], ['b']], ['word'], false).map((item) => item.line)).toEqual([1, 2]);
  });

  it('never reads a mastery or a review date, whatever the file holds', () => {
    const rows = [
      ['Word', 'Mastery', 'Review Date'],
      ['candid', '10', '2030-01-01'],
    ];
    const [built] = toImportRows(rows, guessMapping(3, rows[0]!), true);
    expect(built).toEqual(row({ line: 2, word: 'candid' }));
    expect(Object.keys(built!)).not.toContain('mastery');
    expect(Object.keys(built!)).not.toContain('reviewDate');
  });
});

describe('checking a row', () => {
  it('accepts a word alone, and a full row', () => {
    expect(rowProblem(row())).toBeNull();
    expect(rowProblem(row({ meaning: 'm', definition: 'd', example: 'e', dateAdded: '2026-10-09' }))).toBeNull();
  });

  it('refuses a row with no word, an over-long value, or a date that is not YYYY-MM-DD', () => {
    expect(rowProblem(row({ word: '' }))).toBe('No word.');
    expect(rowProblem(row({ word: 'x'.repeat(IMPORT_LIMITS.word + 1) }))).toMatch(/longer than 200/);
    expect(rowProblem(row({ definition: 'x'.repeat(IMPORT_LIMITS.text + 1) }))).toMatch(/definition is longer than 6000/);
    for (const date of ['09/10/2026', '2026-13-01', '2026-02-30', 'yesterday', '20261009']) {
      expect(rowProblem(row({ dateAdded: date })), date).toMatch(/not a date written as YYYY-MM-DD/);
    }
  });
});

describe('finding duplicates', () => {
  const existing = [
    { id: 'e1', word: 'Candid', meaning: 'thẳng thắn' },
    { id: 'e2', word: 'take off', meaning: 'cất cánh' },
    { id: 'e3', word: 'take off', meaning: 'cởi ra' },
  ];

  it('marks a word that is already in the vocabulary, whatever its case or spacing, and shows what it matches', () => {
    const [checked] = checkRows([row({ word: 'candid' })], existing);
    expect(checked).toMatchObject({ status: 'duplicate', matches: [{ id: 'e1', word: 'Candid', meaning: 'thẳng thắn' }] });
    expect(checkRows([row({ word: 'TAKE  OFF' })], existing)[0]?.matches.map((match) => match.id)).toEqual(['e2', 'e3']);
  });

  it('marks a word repeated within the file, pointing at its first line, and keeps the first as new', () => {
    const checked = checkRows(
      [row({ line: 2, word: 'lucid' }), row({ line: 3, word: 'tenacious' }), row({ line: 4, word: 'Lucid ' })],
      existing,
    );
    expect(checked.map((item) => [item.status, item.firstLine])).toEqual([
      ['new', null],
      ['new', null],
      ['repeated', 2],
    ]);
  });

  it('does not treat similar words as the same', () => {
    const checked = checkRows([row({ word: 'candidly' }), row({ word: 'candid.' }), row({ word: 'candide' })], existing);
    expect(checked.every((item) => item.status === 'new')).toBe(true);
  });

  it('keeps the spelling from the file and merges nothing', () => {
    const [checked] = checkRows([row({ word: 'CANDID', meaning: 'a different meaning' })], existing);
    expect(checked).toMatchObject({ word: 'CANDID', meaning: 'a different meaning', status: 'duplicate' });
  });

  it('reports an invalid row as invalid, not as a duplicate', () => {
    const [checked] = checkRows([row({ word: 'candid', dateAdded: 'soon' })], existing);
    expect(checked).toMatchObject({ status: 'invalid', matches: [] });
    expect(checked?.problem).toMatch(/not a date/);
  });

  it('does not let an invalid row hide a later valid one as "repeated"', () => {
    const checked = checkRows([row({ line: 1, word: 'lucid', dateAdded: 'bad' }), row({ line: 2, word: 'lucid' })], []);
    expect(checked.map((item) => item.status)).toEqual(['invalid', 'new']);
  });
});

describe('sending in batches', () => {
  it('keeps every item, in order, in chunks no larger than asked', () => {
    const items = Array.from({ length: 60 }, (_, index) => ({ word: `w${index}` }));
    const chunks = chunkForUpload(items, 25);
    expect(chunks.map((chunk) => chunk.length)).toEqual([25, 25, 10]);
    expect(chunks.flat()).toEqual(items);
  });

  it('splits earlier when the rows are large, and never drops an oversized one', () => {
    const big = { word: 'w', example: 'x'.repeat(5000) };
    const chunks = chunkForUpload([big, big, big, big], 25, 12_000);
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 2]);
    expect(chunkForUpload([big], 25, 100)).toEqual([[big]]);
    expect(chunkForUpload([], 25)).toEqual([]);
  });

  it('measures size in bytes, so accented text is not undercounted', () => {
    const accented = { word: 'ệ'.repeat(1000) };
    expect(chunkForUpload([accented, accented], 25, 4000)).toHaveLength(2);
  });
});

describe('a round trip through this app’s own exports', () => {
  const entries: VocabularyEntry[] = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      word: 'candid',
      meaning: 'thẳng thắn, bộc trực',
      definition: 'Honest and direct, "even" when uncomfortable.',
      example: 'He gave a candid account.\nShe was candid too.',
      mastery: 7,
      reviewDate: '2026-10-20',
      dateAdded: '2026-09-01',
      reviewStatus: 'upcoming',
      reviewable: false,
      createdTime: null,
      lastEditedTime: null,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      word: 'take off',
      meaning: null,
      definition: null,
      example: '  leading space kept  ',
      mastery: 1,
      reviewDate: null,
      dateAdded: null,
      reviewStatus: 'unscheduled',
      reviewable: true,
      createdTime: null,
      lastEditedTime: null,
    },
  ];

  const expected = [
    row({
      line: 2,
      word: 'candid',
      meaning: 'thẳng thắn, bộc trực',
      definition: 'Honest and direct, "even" when uncomfortable.',
      example: 'He gave a candid account.\nShe was candid too.',
      dateAdded: '2026-09-01',
    }),
    row({ line: 3, word: 'take off', example: 'leading space kept' }),
  ];

  it('reads back the CSV export with the same content, and without its mastery, review date or id', () => {
    const parsed = parseImportText(toCsv(entries));
    expect(parsed).toMatchObject({ format: 'delimited', delimiter: ',' });
    expect(looksLikeHeader(parsed.rows[0]!)).toBe(true);
    const mapping = guessMapping(parsed.rows[0]!.length, parsed.rows[0]!);
    expect(mapping).toEqual(['word', 'meaning', 'definition', 'example', null, null, 'dateAdded', null]);
    expect(toImportRows(parsed.rows, mapping, true)).toEqual(expected);
  });

  it('reads back the JSON export the same way', () => {
    const parsed = parseImportText(toJson(entries, '2026-10-09T05:00:00.000Z'));
    expect(parsed.format).toBe('json');
    const mapping = guessMapping(parsed.header!.length, parsed.header);
    expect(mapping).toEqual(['word', 'meaning', 'definition', 'example', 'dateAdded']);
    expect(toImportRows(parsed.rows, mapping, false)).toEqual(expected.map((item, index) => ({ ...item, line: index + 1 })));
  });

  it('finds every exported word to be a duplicate when imported back into the same vocabulary', () => {
    const parsed = parseImportText(toCsv(entries));
    const rows = toImportRows(parsed.rows, guessMapping(parsed.rows[0]!.length, parsed.rows[0]!), true);
    const checked = checkRows(rows, entries);
    expect(checked.map((item) => item.status)).toEqual(['duplicate', 'duplicate']);
    expect(checked.map((item) => item.matches[0]?.id)).toEqual(entries.map((entry) => entry.id));
  });

  it('finds them all new in an empty vocabulary', () => {
    const parsed = parseImportText(toCsv(entries));
    const rows = toImportRows(parsed.rows, guessMapping(parsed.rows[0]!.length, parsed.rows[0]!), true);
    expect(checkRows(rows, []).map((item) => item.status)).toEqual(['new', 'new']);
  });
});
