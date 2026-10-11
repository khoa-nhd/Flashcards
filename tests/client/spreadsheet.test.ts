/**
 * Reading an Excel file. The files here are real .xlsx archives built for the
 * test and read by the real library, so this checks the whole path from bytes
 * to the rows the import works on.
 */
import { describe, expect, it } from 'vitest';
import { checkRows, guessMapping, looksLikeHeader, parseSheetRows, toImportRows } from '../../shared/import.js';
import { SpreadsheetError, isOldExcelName, isSpreadsheetName, readSpreadsheet } from '../../src/lib/spreadsheet.js';
import { buildXlsx } from '../helpers/xlsx-file.js';

const fileOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

describe('turning sheet cells into text', () => {
  it('keeps text, writes numbers plainly and reads a date cell as its calendar day', () => {
    const parsed = parseSheetRows([
      ['candid', 'thẳng thắn', 3, new Date(Date.UTC(2026, 8, 1)), true],
      [' lucid ', null, 2.5, undefined, false],
    ]);
    expect(parsed).toEqual({
      format: 'spreadsheet',
      delimiter: null,
      header: null,
      rows: [
        ['candid', 'thẳng thắn', '3', '2026-09-01', 'TRUE'],
        ['lucid', '', '2.5', '', 'FALSE'],
      ],
    });
  });

  it('drops empty rows and the empty cells that trail a row, but keeps a gap inside one', () => {
    expect(parseSheetRows([['candid', null, 'Honest.', null, null], [null, null], [], ['', '  '], ['lucid']]).rows).toEqual([
      ['candid', '', 'Honest.'],
      ['lucid'],
    ]);
  });

  it('reads an unusable date as empty rather than as a wrong day', () => {
    expect(parseSheetRows([['candid', new Date(Number.NaN)]]).rows).toEqual([['candid']]);
  });

  it('is nothing at all for an empty sheet', () => {
    expect(parseSheetRows([]).rows).toEqual([]);
  });
});

describe('telling the formats apart by name', () => {
  it('takes .xlsx, in any capitals, and nothing else', () => {
    expect(isSpreadsheetName('words.xlsx')).toBe(true);
    expect(isSpreadsheetName('WORDS.XLSX')).toBe(true);
    for (const other of ['words.xls', 'words.csv', 'words.xlsx.txt', 'xlsx']) expect(isSpreadsheetName(other)).toBe(false);
    expect(isOldExcelName('words.xls')).toBe(true);
    expect(isOldExcelName('words.xlsx')).toBe(false);
  });
});

describe('reading a real .xlsx file', () => {
  const words = buildXlsx([
    {
      name: 'Vocabulary',
      rows: [
        ['Word', 'Vietnamese Meaning', 'Definition', 'Date Added'],
        ['candid', 'thẳng thắn', 'Honest & direct, "frank".', new Date(Date.UTC(2026, 8, 1))],
        [null, null, null, null],
        ['well-known', 'nổi tiếng', null, new Date(Date.UTC(2026, 8, 15))],
        ['lucid', null, '<clear>', null],
      ],
    },
  ]);

  it('gives the first sheet’s rows as text, dates as days, with special characters intact', async () => {
    const read = await readSpreadsheet(fileOf(words));
    expect(read.sheet).toBe('Vocabulary');
    expect(read.otherSheets).toEqual([]);
    expect(read.parsed.rows).toEqual([
      ['Word', 'Vietnamese Meaning', 'Definition', 'Date Added'],
      ['candid', 'thẳng thắn', 'Honest & direct, "frank".', '2026-09-01'],
      ['well-known', 'nổi tiếng', '', '2026-09-15'],
      ['lucid', '', '<clear>'],
    ]);
  });

  it('goes through the same checks as any other list: its first row is recognised as column names', async () => {
    const { parsed } = await readSpreadsheet(fileOf(words));
    const first = parsed.rows[0]!;
    expect(parsed.header).toBeNull();
    expect(looksLikeHeader(first)).toBe(true);
    const mapping = guessMapping(4, first);
    expect(mapping).toEqual(['word', 'meaning', 'definition', 'dateAdded']);

    const checked = checkRows(toImportRows(parsed.rows, mapping, true), []);
    expect(checked.map((row) => [row.word, row.status, row.dateAdded])).toEqual([
      ['candid', 'new', '2026-09-01'],
      ['well-known', 'new', '2026-09-15'],
      ['lucid', 'new', null],
    ]);
    // The row of column names is not a word.
    expect(checked.map((row) => row.word)).not.toContain('Word');
  });

  it('reads only the first sheet and names the others', async () => {
    const book = buildXlsx([
      { name: 'Words', rows: [['candid', 'thẳng thắn']] },
      { name: 'Notes', rows: [['not a word list']] },
      { name: 'Old', rows: [['lucid']] },
    ]);
    const read = await readSpreadsheet(fileOf(book));
    expect(read.sheet).toBe('Words');
    expect(read.otherSheets).toEqual(['Notes', 'Old']);
    expect(read.parsed.rows).toEqual([['candid', 'thẳng thắn']]);
  });

  it('reads an empty sheet as no rows, without failing', async () => {
    const read = await readSpreadsheet(fileOf(buildXlsx([{ name: 'Empty', rows: [] }])));
    expect(read.parsed.rows).toEqual([]);
  });

  it('refuses something that is not a spreadsheet, in words fit to show', async () => {
    const attempt = readSpreadsheet(new Blob(['word,meaning\ncandid,thẳng thắn\n']));
    await expect(attempt).rejects.toBeInstanceOf(SpreadsheetError);
    await expect(attempt).rejects.toThrow(/could not be read as an Excel spreadsheet/);
  });

  it('refuses a damaged file the same way', async () => {
    const damaged = words.slice(0, Math.floor(words.length / 2));
    await expect(readSpreadsheet(fileOf(damaged))).rejects.toBeInstanceOf(SpreadsheetError);
  });
});
