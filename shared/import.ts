/**
 * Reading a list of words that someone pasted or uploaded, and working out
 * what importing it would do, before anything is sent to the server.
 *
 * Pure functions. Nothing is imported here: the output is a preview for the
 * owner to check, and the rows they then confirm.
 *
 * Only a word's content is imported: the word, its meaning, definition,
 * example and the date it was added. A mastery level or a review date in the
 * file is deliberately not read. An imported word starts the way a newly
 * added one does, so no review progress is ever made up from a file.
 */
import { isIsoDate } from './dates.js';
import { normalizeWord, tidyWord } from './text.js';

/** The same limits the Add form and the database enforce. */
export const IMPORT_LIMITS = { word: 200, text: 6000, rows: 2000 } as const;

export const IMPORT_FIELDS = ['word', 'meaning', 'definition', 'example', 'dateAdded'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  word: 'Word',
  meaning: 'Vietnamese meaning',
  definition: 'Definition',
  example: 'Example',
  dateAdded: 'Date added',
};

// ---- Reading the text ----

export type Delimiter = ',' | ';' | '\t' | '|';

const DELIMITERS: Delimiter[] = [',', '\t', ';', '|'];

/**
 * Splits delimited text into rows of cells, following RFC 4180: a cell may
 * be wrapped in double quotes, inside which the delimiter, line breaks and
 * doubled quotes ("") are literal. A byte-order mark is dropped, and lines
 * may end in LF or CRLF. Rows that are entirely empty are left out.
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  // Whether the current cell began with a quote: only then is a quote special.
  let wasQuoted = false;

  const endCell = () => {
    row.push(wasQuoted ? cell : cell.trim());
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.trim() === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      cell = '';
    } else if (char === delimiter) {
      endCell();
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      if (source[index + 1] === '\n') index += 1;
      endRow();
    } else if (!wasQuoted) {
      cell += char;
    }
    // Anything after a closing quote and before the next delimiter is ignored.
  }
  if (cell !== '' || row.length > 0 || wasQuoted) endRow();
  return rows;
}

/** How much of a text is looked at to work out its delimiter. */
const DETECTION_SAMPLE = 200_000;

/**
 * Picks the delimiter the text is written with: the candidate that splits it
 * into records of the same number of cells, more than one. Each candidate is
 * tried with the real parser, so a delimiter or a line break inside a quoted
 * cell does not mislead it. `null` when none fits, which means one value per
 * line.
 */
export function detectDelimiter(text: string): Delimiter | null {
  const sample = text.slice(0, DETECTION_SAMPLE);
  let best: { delimiter: Delimiter; cells: number } | null = null;
  for (const delimiter of DELIMITERS) {
    const widths = parseDelimited(sample, delimiter).map((row) => row.length);
    const first = widths[0];
    if (first === undefined || first < 2) continue;
    // A few ragged rows are tolerated; most must agree with the first.
    const agreeing = widths.filter((width) => width === first).length;
    if (agreeing >= Math.ceil(widths.length * 0.8) && (best === null || first > best.cells)) {
      best = { delimiter, cells: first };
    }
  }
  return best?.delimiter ?? null;
}

export interface ParsedText {
  /** How the text was read. */
  format: 'delimited' | 'lines' | 'json' | 'spreadsheet';
  delimiter: Delimiter | null;
  rows: string[][];
  /** Column names, when the source names them itself (the app's own JSON export). */
  header: string[] | null;
}

const JSON_KEYS: Array<[ImportField, string[]]> = [
  ['word', ['word']],
  ['meaning', ['vietnameseMeaning', 'meaning']],
  ['definition', ['definition']],
  ['example', ['exampleSentences', 'example']],
  ['dateAdded', ['dateAdded']],
];

/** The words in a JSON document of the kind this app exports, or `null` if it is not one. */
function parseJsonExport(text: string): ParsedText | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const holder = parsed as { entries?: unknown; vocabulary?: unknown } | null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(holder?.entries) ? holder.entries : holder?.vocabulary;
  if (!Array.isArray(list)) return null;
  const rows: string[][] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    rows.push(
      JSON_KEYS.map(([, keys]) => {
        const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === 'string');
        return typeof value === 'string' ? value : '';
      }),
    );
  }
  return { format: 'json', delimiter: null, rows, header: JSON_KEYS.map(([field]) => IMPORT_FIELD_LABELS[field]) };
}

/**
 * Reads pasted or uploaded text as rows of cells: this app's own JSON export,
 * delimited text (CSV and its relatives), or failing both, one value per line.
 */
export function parseImportText(text: string): ParsedText {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = parseJsonExport(trimmed);
    if (json !== null) return json;
  }
  const delimiter = detectDelimiter(text);
  if (delimiter !== null) return { format: 'delimited', delimiter, rows: parseDelimited(text, delimiter), header: null };
  // One value per line, taken whole: a comma in such a line is part of the text, not a separator.
  const rows = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => [line]);
  return { format: 'lines', delimiter: null, rows, header: null };
}

/** A spreadsheet cell as a reader hands it over. */
export type SheetCell = string | number | boolean | Date | null | undefined;

/** A date cell is a day, not a moment: its calendar date as the sheet shows it. */
function cellText(cell: SheetCell): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10);
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return String(cell).trim();
}

/**
 * The rows of one sheet of a spreadsheet, as the text the rest of the import
 * works on. Rows with nothing in them are dropped, and so are the empty cells
 * that trail a row. Whether the first row holds column names is left to the
 * same check, and the same tick box, as for any other list.
 */
export function parseSheetRows(data: readonly (readonly SheetCell[])[]): ParsedText {
  const rows: string[][] = [];
  for (const row of data) {
    const cells = row.map(cellText);
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) rows.push(cells);
  }
  return { format: 'spreadsheet', delimiter: null, rows, header: null };
}

// ---- Which column is which ----

/** For each column of the source, the field it fills, or `null` to leave it out. */
export type ColumnMapping = Array<ImportField | null>;

const HEADER_NAMES: Record<ImportField, string[]> = {
  word: ['word', 'words', 'term', 'vocabulary', 'từ', 'tu', 'english'],
  meaning: ['vietnamese meaning', 'meaning', 'vietnamese', 'translation', 'nghĩa', 'nghia', 'tiếng việt'],
  definition: ['definition', 'definitions', 'english definition', 'định nghĩa'],
  example: ['example sentences', 'example sentence', 'example', 'examples', 'sentence', 'ví dụ'],
  dateAdded: ['date added', 'added', 'date', 'created', 'ngày thêm'],
};

const headerKey = (text: string) => text.normalize('NFC').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** The field a column heading names, or `null` when it names none this app imports. */
export function fieldForHeader(heading: string): ImportField | null {
  const key = headerKey(heading);
  return IMPORT_FIELDS.find((field) => HEADER_NAMES[field].includes(key)) ?? null;
}

/** Whether the first row reads as headings: at least one cell names a field, and one of them is the word. */
export function looksLikeHeader(row: readonly string[]): boolean {
  return row.some((cell) => fieldForHeader(cell) === 'word');
}

/**
 * A starting guess at the mapping, for the owner to correct. With headings,
 * each column goes to the field its heading names (the first of each wins).
 * Without, the columns are taken in the usual order: word, meaning,
 * definition, example.
 */
export function guessMapping(columns: number, header: readonly string[] | null): ColumnMapping {
  if (header !== null) {
    const used = new Set<ImportField>();
    return Array.from({ length: columns }, (_, index) => {
      const field = fieldForHeader(header[index] ?? '');
      if (field === null || used.has(field)) return null;
      used.add(field);
      return field;
    });
  }
  const order: ImportField[] = ['word', 'meaning', 'definition', 'example'];
  return Array.from({ length: columns }, (_, index) => order[index] ?? null);
}

/** Why a mapping cannot be used, or `null` when it can. */
export function mappingProblem(mapping: ColumnMapping): string | null {
  const chosen = mapping.filter((field): field is ImportField => field !== null);
  if (!chosen.includes('word')) return 'Choose which column holds the word.';
  const repeated = chosen.find((field, index) => chosen.indexOf(field) !== index);
  if (repeated !== undefined) return `Two columns are set to “${IMPORT_FIELD_LABELS[repeated]}”. Each field can come from one column.`;
  return null;
}

// ---- What importing would do ----

export interface ImportRow {
  /** Where the row was in the source, counting from 1 and including a header row. */
  line: number;
  word: string;
  meaning: string | null;
  definition: string | null;
  example: string | null;
  dateAdded: string | null;
}

export type RowStatus =
  /** Nothing like it exists: it will be imported. */
  | 'new'
  /** The same word is already in the vocabulary. Left out unless the owner says otherwise. */
  | 'duplicate'
  /** The same word appears earlier in this file. Left out unless the owner says otherwise. */
  | 'repeated'
  /** It cannot be imported as it stands. */
  | 'invalid';

export interface CheckedRow extends ImportRow {
  status: RowStatus;
  /** For an invalid row, what is wrong with it. */
  problem: string | null;
  /** For a duplicate, the existing words it matches. */
  matches: Array<{ id: string; word: string; meaning: string | null }>;
  /** For a repeated row, the line of the first occurrence. */
  firstLine: number | null;
}

const optional = (text: string | undefined): string | null => {
  const value = (text ?? '').normalize('NFC').trim();
  return value === '' ? null : value;
};

/** The rows the mapping picks out of the source, as words. Rows with no word and nothing else are dropped. */
export function toImportRows(rows: readonly string[][], mapping: ColumnMapping, hasHeader: boolean): ImportRow[] {
  const column = (field: ImportField) => mapping.indexOf(field);
  const indexes = Object.fromEntries(IMPORT_FIELDS.map((field) => [field, column(field)])) as Record<ImportField, number>;
  const result: ImportRow[] = [];
  rows.forEach((cells, position) => {
    if (hasHeader && position === 0) return;
    const pick = (field: ImportField) => (indexes[field] === -1 ? undefined : cells[indexes[field]]);
    const row: ImportRow = {
      line: position + 1,
      word: tidyWord(pick('word') ?? ''),
      meaning: optional(pick('meaning')),
      definition: optional(pick('definition')),
      example: optional(pick('example')),
      dateAdded: optional(pick('dateAdded')),
    };
    const empty = row.word === '' && row.meaning === null && row.definition === null && row.example === null;
    if (!empty) result.push(row);
  });
  return result;
}

/** What is wrong with a row, or `null`. A date has to be YYYY-MM-DD: any other form is ambiguous. */
export function rowProblem(row: ImportRow): string | null {
  if (row.word === '') return 'No word.';
  if (row.word.length > IMPORT_LIMITS.word) return `The word is longer than ${IMPORT_LIMITS.word} characters.`;
  for (const field of ['meaning', 'definition', 'example'] as const) {
    if ((row[field]?.length ?? 0) > IMPORT_LIMITS.text) {
      return `The ${IMPORT_FIELD_LABELS[field].toLowerCase()} is longer than ${IMPORT_LIMITS.text} characters.`;
    }
  }
  if (row.dateAdded !== null && !isIsoDate(row.dateAdded)) {
    return `“${row.dateAdded}” is not a date written as YYYY-MM-DD.`;
  }
  return null;
}

/**
 * Sorts rows into new, duplicate, repeated and invalid. Two words are the
 * same when they match after trimming, collapsing spaces, Unicode
 * normalisation and ignoring case; the spelling in the file is kept as it is.
 * Nothing is merged: a duplicate is only pointed out, with what it matches.
 */
export function checkRows(
  rows: readonly ImportRow[],
  existing: ReadonlyArray<{ id: string; word: string; meaning: string | null }>,
): CheckedRow[] {
  const known = new Map<string, Array<{ id: string; word: string; meaning: string | null }>>();
  for (const entry of existing) {
    const key = normalizeWord(entry.word);
    known.set(key, [...(known.get(key) ?? []), { id: entry.id, word: entry.word, meaning: entry.meaning }]);
  }
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const problem = rowProblem(row);
    if (problem !== null) return { ...row, status: 'invalid', problem, matches: [], firstLine: null };
    const key = normalizeWord(row.word);
    const matches = known.get(key) ?? [];
    const firstLine = seen.get(key) ?? null;
    if (firstLine === null) seen.set(key, row.line);
    if (matches.length > 0) return { ...row, status: 'duplicate', problem: null, matches, firstLine: null };
    if (firstLine !== null) return { ...row, status: 'repeated', problem: null, matches: [], firstLine };
    return { ...row, status: 'new', problem: null, matches: [], firstLine: null };
  });
}

/** One word as it is sent to be imported. */
export interface ImportItem {
  requestId: string;
  word: string;
  meaning?: string;
  definition?: string;
  example?: string;
  dateAdded?: string;
  /** Set only for a row the owner chose to import although it is a duplicate. */
  allowDuplicate?: boolean;
}

/**
 * Splits the rows to send into requests the server will accept: at most
 * `maxItems` each, and small enough to stay under its body limit.
 */
export function chunkForUpload<T>(items: readonly T[], maxItems = 25, maxBytes = 60_000): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (current.length > 0 && (current.length >= maxItems || size + bytes > maxBytes)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
