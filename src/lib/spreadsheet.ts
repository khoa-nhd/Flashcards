/**
 * Reading an .xlsx file in the browser. The file never leaves the device: it
 * is unpacked here and handed on as rows of text, which is all the import
 * works with.
 *
 * Library: read-excel-file (MIT), pinned to an exact version. It is loaded
 * only when a spreadsheet is actually chosen, so nobody who does not import
 * one pays for it.
 */
import { parseSheetRows, type ParsedText, type SheetCell } from '../../shared/import.js';

export interface SpreadsheetRead {
  parsed: ParsedText;
  /** The name of the sheet that was read. */
  sheet: string;
  /** Other sheets in the file, which are not read. */
  otherSheets: string[];
}

/** Why a file could not be read as a spreadsheet, in words fit for the reader. */
export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

export const isSpreadsheetName = (name: string): boolean => /\.xlsx$/i.test(name);
/** The older Excel format, which is a different thing entirely and is not read. */
export const isOldExcelName = (name: string): boolean => /\.xls$/i.test(name);

/** The first sheet of an .xlsx file, as rows of text. */
export async function readSpreadsheet(file: Blob): Promise<SpreadsheetRead> {
  const { default: readXlsxFile } = await import('read-excel-file/universal');
  let sheets: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    sheets = await readXlsxFile(file);
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    throw new SpreadsheetError(
      code === 'XLS_FILE_NOT_SUPPORTED'
        ? 'That is an older Excel file (.xls). Save it as .xlsx or as CSV and choose it again.'
        : 'That file could not be read as an Excel spreadsheet. Saving it as CSV and choosing that instead usually works.',
    );
  }
  const first = sheets[0];
  if (first === undefined) throw new SpreadsheetError('That spreadsheet has no sheets in it.');
  return {
    parsed: parseSheetRows(first.data as unknown as SheetCell[][]),
    sheet: first.sheet,
    otherSheets: sheets.slice(1).map((sheet) => sheet.sheet),
  };
}
