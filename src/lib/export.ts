/** Personal backups of the loaded vocabulary. Exporting reads only; it changes nothing that is stored. */
import type { VocabularyEntry } from '../../shared/api.js';

const COLUMNS: Array<{ header: string; value: (entry: VocabularyEntry) => string | number | null }> = [
  { header: 'Word', value: (entry) => entry.word },
  { header: 'Vietnamese Meaning', value: (entry) => entry.meaning },
  { header: 'Definition', value: (entry) => entry.definition },
  { header: 'Example Sentences', value: (entry) => entry.example },
  { header: 'Mastery', value: (entry) => entry.mastery },
  { header: 'Review Date', value: (entry) => entry.reviewDate },
  { header: 'Date Added', value: (entry) => entry.dateAdded },
  { header: 'ID', value: (entry) => entry.id },
];

/** Quotes a value when it contains a comma, a quote, a line break or edge whitespace. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV with a header row. Text is exported exactly as stored. */
export function toCsv(entries: readonly VocabularyEntry[]): string {
  const rows = [
    COLUMNS.map((column) => csvCell(column.header)),
    ...entries.map((entry) => COLUMNS.map((column) => csvCell(column.value(entry)))),
  ];
  return rows.map((row) => row.join(',')).join('\r\n') + '\r\n';
}

export function toJson(entries: readonly VocabularyEntry[], exportedAt: string): string {
  return JSON.stringify(
    {
      exportedAt,
      count: entries.length,
      entries: entries.map((entry) => ({
        word: entry.word,
        vietnameseMeaning: entry.meaning,
        definition: entry.definition,
        exampleSentences: entry.example,
        mastery: entry.mastery,
        reviewDate: entry.reviewDate,
        dateAdded: entry.dateAdded,
        id: entry.id,
      })),
    },
    null,
    2,
  );
}

/** Hands a generated file to the browser's download handling. */
export function downloadFile(filename: string, mimeType: string, content: string): void {
  // The byte-order mark makes spreadsheet apps read accented text as UTF-8.
  const blob = new Blob(mimeType.startsWith('text/csv') ? ['﻿', content] : [content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
