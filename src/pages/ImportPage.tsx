import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  IMPORT_LIMITS,
  checkRows,
  chunkForUpload,
  guessMapping,
  looksLikeHeader,
  mappingProblem,
  parseImportText,
  toImportRows,
  type CheckedRow,
  type ColumnMapping,
  type ImportField,
  type ImportItem,
  type ParsedText,
  type RowStatus,
} from '../../shared/import.js';
import { useApp, useVocabulary } from '../app-context.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, PAGE, SECTION_TITLE, TEXTAREA } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';
import { count } from '../lib/format.js';
import { newRequestId } from '../lib/request-id.js';
import { ROUTES } from '../lib/router.js';
import { SpreadsheetError, isOldExcelName, isSpreadsheetName, readSpreadsheet } from '../lib/spreadsheet.js';

/** How many rows of the preview are drawn. Every row is counted and checked either way. */
const PREVIEW_ROWS = 200;

const DELIMITER_NAMES: Record<string, string> = { ',': 'commas', ';': 'semicolons', '\t': 'tabs', '|': 'vertical bars' };

const STATUS_TEXT: Record<RowStatus, string> = {
  new: 'New',
  duplicate: 'Already in your vocabulary',
  repeated: 'Repeated in this list',
  invalid: 'Cannot be imported',
};

const STATUS_TONE: Record<RowStatus, string> = {
  new: 'bg-good-soft text-good-ink',
  duplicate: 'bg-warn-soft text-warn-ink',
  repeated: 'bg-warn-soft text-warn-ink',
  invalid: 'bg-bad-soft text-bad-ink',
};

interface Report {
  /** Rows that were read but not sent: duplicates left unticked, and rows that could not be imported. */
  leftOut: number;
  imported: number;
  alreadyImported: number;
  /** Rows the server would not take, with why. */
  refused: Array<{ word: string; reason: string }>;
  /** Set when sending stopped before the end. */
  stopped: string | null;
  /** Rows not sent or not confirmed, for another attempt. */
  remaining: ImportItem[];
  /** The spreading chosen for this import, kept so a retry continues it. */
  wordsPerDay: number | null;
  /** How many rows were already processed, so a retry keeps the same day boundaries. */
  spreadOffset: number;
}

/** A list over one default day's worth is worth asking about, not silently flooding the queue. */
const SPREAD_ASK_ABOVE = 20;

/**
 * Bringing in a list of words. Nothing is sent anywhere until the last step:
 * the list is read and checked in the browser, shown for review, and only the
 * rows the owner confirms are imported, each as a new word.
 */
export function ImportPage() {
  const { api, vocabulary } = useApp();
  const state = useVocabulary();
  const canWrite = state.meta?.writesEnabled ?? false;
  const fsrsOnly = state.meta?.fsrsOnly === true;

  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  /** Said about a spreadsheet once it has been read: which sheet was used, and which were not. */
  const [sheetNote, setSheetNote] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedText | null>(null);
  const [hasHeader, setHasHeader] = useState(false);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  /** Lines of duplicate or repeated rows the owner chose to import anyway. */
  const [forced, setForced] = useState<ReadonlySet<number>>(new Set());
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [spreadPrompt, setSpreadPrompt] = useState(false);
  const [spread, setSpread] = useState(true);
  const [wordsPerDay, setWordsPerDay] = useState('20');
  const [spreadError, setSpreadError] = useState<string | null>(null);
  /** One request id per line, kept for as long as this list is on screen, so a retry never imports a row twice. */
  const requestIds = useRef(new Map<number, string>());

  const columns = useMemo(() => Math.max(0, ...(parsed?.rows ?? []).map((row) => row.length)), [parsed]);
  const header = parsed === null ? null : (parsed.header ?? (hasHeader ? (parsed.rows[0] ?? null) : null));
  // The app's own JSON names its fields itself; its rows are all data.
  const skipFirst = parsed !== null && parsed.header === null && hasHeader;
  const problem = parsed === null ? null : mappingProblem(mapping);

  const checked: CheckedRow[] = useMemo(() => {
    if (parsed === null || problem !== null) return [];
    return checkRows(toImportRows(parsed.rows, mapping, skipFirst), state.entries);
  }, [parsed, mapping, skipFirst, problem, state.entries]);

  const counts = useMemo(() => {
    const totals: Record<RowStatus, number> = { new: 0, duplicate: 0, repeated: 0, invalid: 0 };
    for (const row of checked) totals[row.status] += 1;
    return totals;
  }, [checked]);

  const chosen = checked.filter((row) => row.status === 'new' || ((row.status === 'duplicate' || row.status === 'repeated') && forced.has(row.line)));
  const tooMany = checked.length > IMPORT_LIMITS.rows;

  /** Puts a list that has been read on screen for checking. Nothing is sent by this. */
  const show = (next: ParsedText) => {
    const width = Math.max(0, ...next.rows.map((row) => row.length));
    const first = next.rows[0] ?? [];
    const headed = next.header === null && looksLikeHeader(first);
    setParsed(next);
    setHasHeader(headed);
    setMapping(guessMapping(width, next.header ?? (headed ? first : null)));
    setForced(new Set());
    setReport(null);
    setSpreadPrompt(false);
    setSpreadError(null);
    requestIds.current = new Map();
  };

  const preview = (source: string) => {
    setSheetNote(null);
    show(parseImportText(source));
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setReadError(null);
    if (file.size > 5_000_000) {
      setReadError('That file is larger than 5 MB. Split it into smaller lists.');
      return;
    }
    if (isOldExcelName(file.name)) {
      setReadError('That is an older Excel file (.xls). Save it as .xlsx or as CSV and choose it again.');
      return;
    }
    try {
      if (isSpreadsheetName(file.name)) {
        const read = await readSpreadsheet(file);
        // A spreadsheet is not text, so there is nothing to put in the box above.
        setText('');
        setFileName(file.name);
        setSheetNote(
          read.otherSheets.length === 0
            ? `Read from the sheet “${read.sheet}”.`
            : `Read from the first sheet, “${read.sheet}”. ${count(read.otherSheets.length, 'other sheet')} in the file ${
                read.otherSheets.length === 1 ? 'was' : 'were'
              } not read: ${read.otherSheets.join(', ')}.`,
        );
        show(read.parsed);
      } else {
        const content = await file.text();
        setText(content);
        setFileName(file.name);
        preview(content);
      }
    } catch (cause) {
      setParsed(null);
      setReadError(cause instanceof SpreadsheetError ? cause.message : 'That file could not be read.');
    }
  };

  const reset = () => {
    setText('');
    setFileName(null);
    setParsed(null);
    setReport(null);
    setForced(new Set());
    setReadError(null);
    setSheetNote(null);
    setSpreadPrompt(false);
    setSpreadError(null);
  };

  const toItems = (rows: readonly CheckedRow[]): ImportItem[] =>
    rows.map((row) => {
      const requestId = requestIds.current.get(row.line) ?? newRequestId();
      requestIds.current.set(row.line, requestId);
      return {
        requestId,
        word: row.word,
        ...(row.meaning === null ? {} : { meaning: row.meaning }),
        ...(row.definition === null ? {} : { definition: row.definition }),
        ...(row.example === null ? {} : { example: row.example }),
        ...(row.dateAdded === null ? {} : { dateAdded: row.dateAdded }),
        ...(row.status === 'new' ? {} : { allowDuplicate: true }),
      };
    });

  const send = async (items: ImportItem[], earlier: Report | null, spreadPerDay = earlier?.wordsPerDay ?? null) => {
    const result: Report = {
      leftOut: earlier?.leftOut ?? checked.length - items.length,
      imported: earlier?.imported ?? 0,
      alreadyImported: earlier?.alreadyImported ?? 0,
      refused: [...(earlier?.refused ?? [])],
      stopped: null,
      remaining: [],
      wordsPerDay: spreadPerDay,
      spreadOffset: earlier?.spreadOffset ?? 0,
    };
    let done = 0;
    let offset = result.spreadOffset;
    setSending({ done, total: items.length });
    const chunks = chunkForUpload(items);
    for (const [position, chunk] of chunks.entries()) {
      const rest = () => chunks.slice(position).flat();
      try {
        const reply = await api.importWords(chunk, spreadPerDay ?? undefined, offset);
        reply.results.forEach((outcome, index) => {
          if (outcome.outcome === 'imported') result.imported += 1;
          else if (outcome.outcome === 'already_imported') result.alreadyImported += 1;
          else result.refused.push({ word: chunk[index]?.word ?? '', reason: outcome.message ?? STATUS_TEXT.invalid });
        });
        if (reply.stopped !== null) {
          result.stopped = reply.stopped.message;
          // Rows before the stopping point were processed; the rest continue from there.
          result.spreadOffset = offset + reply.results.length;
          result.remaining = [...chunk.slice(reply.stopped.index), ...chunks.slice(position + 1).flat()];
          break;
        }
      } catch (cause) {
        result.stopped = cause instanceof ApiError ? cause.message : 'The import could not be sent.';
        result.spreadOffset = offset;
        result.remaining = rest();
        break;
      }
      done += chunk.length;
      offset += chunk.length;
      result.spreadOffset = offset;
      setSending({ done, total: items.length });
    }
    setSending(null);
    setReport(result);
    // The new words belong in every other view straight away.
    if (result.imported > 0) void vocabulary.reload();
  };

  const askOrImport = () => {
    if (fsrsOnly && chosen.length > SPREAD_ASK_ABOVE) {
      setSpreadError(null);
      setSpreadPrompt(true);
      return;
    }
    void send(toItems(chosen), null);
  };

  const confirmImport = () => {
    const perDay = Number(wordsPerDay);
    if (spread && (!Number.isInteger(perDay) || perDay < 1 || perDay > 1000)) {
      setSpreadError('Choose a whole number from 1 to 1000 words a day.');
      return;
    }
    setSpreadError(null);
    setSpreadPrompt(false);
    void send(toItems(chosen), null, spread ? perDay : undefined);
  };

  const setColumn = (index: number, field: ImportField | null) =>
    setMapping((current) => current.map((existing, position) => (position === index ? field : existing)));

  return (
    <div className={PAGE}>
      <PageHeader
        title="Import"
        description="Bring in a list of words from a spreadsheet, a file or plain text. You see exactly what will be added before anything is."
      />

      <VocabularyGate state={state}>
        <div className="flex max-w-3xl flex-col gap-6">
          {!canWrite && (
            <p className={`${CARD} px-4 py-3 text-sm text-muted`}>
              Saving is switched off, so a list can be checked here but not imported.
            </p>
          )}

          {report !== null ? (
            <section className={`${CARD} flex flex-col gap-3 p-5`} aria-label="Import report">
              <h2 className="font-serif text-2xl font-semibold">{report.stopped === null ? 'Import finished' : 'Import stopped part-way'}</h2>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:max-w-md">
                <dt className="text-muted">Imported</dt>
                <dd className="m-0 font-semibold tabular-nums">{report.imported}</dd>
                {report.alreadyImported > 0 && (
                  <>
                    <dt className="text-muted">Already imported earlier</dt>
                    <dd className="m-0 tabular-nums">{report.alreadyImported}</dd>
                  </>
                )}
                <dt className="text-muted">Left out by you or by the checks</dt>
                <dd className="m-0 tabular-nums">{report.leftOut}</dd>
                <dt className="text-muted">Refused by the server</dt>
                <dd className="m-0 tabular-nums">{report.refused.length}</dd>
                {report.remaining.length > 0 && (
                  <>
                    <dt className="text-muted">Not sent yet</dt>
                    <dd className="m-0 tabular-nums">{report.remaining.length}</dd>
                  </>
                )}
              </dl>
              {report.stopped !== null && (
                <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
                  {report.stopped} Nothing was imported twice; the rows not sent can be tried again.
                </p>
              )}
              {report.refused.length > 0 && (
                <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm">
                  {report.refused.slice(0, 50).map((row, index) => (
                    <li key={`${row.word}:${index}`}>
                      <span className="font-medium">{row.word || '(no word)'}</span>: {row.reason}
                    </li>
                  ))}
                </ul>
              )}
              {report.wordsPerDay !== null && (
                <p className={HELP}>
                  New words were spread at {report.wordsPerDay} a day, starting with today. Change the daily pace
                  anytime from Settings or the dashboard goals.
                </p>
              )}
              <p className={HELP}>
                {fsrsOnly
                  ? 'Imported words start as new: no mastery, no review history, and due on their assigned day. Nothing was merged into, or changed on, a word you already had.'
                  : 'Imported words start like any newly added word: at the starting mastery, with no review history. Nothing was merged into, or changed on, a word you already had.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {report.remaining.length > 0 && (
                  <button type="button" className={BUTTON_PRIMARY} disabled={sending !== null} onClick={() => void send(report.remaining, report)}>
                    Try the {count(report.remaining.length, 'remaining row')} again
                  </button>
                )}
                <button type="button" className={BUTTON_SECONDARY} onClick={reset}>
                  Import another list
                </button>
                <Link to={ROUTES.bank} className={BUTTON_SECONDARY}>
                  Open the vocabulary bank
                </Link>
              </div>
            </section>
          ) : (
            <>
              <section className={`${CARD} flex flex-col gap-3 p-5`} aria-labelledby="import-source-title">
                <h2 id="import-source-title" className={SECTION_TITLE}>
                  1. The list
                </h2>
                <label htmlFor="import-text" className="text-sm font-medium">
                  Paste it here
                </label>
                <textarea
                  id="import-text"
                  rows={6}
                  className={`${TEXTAREA} font-mono text-xs`}
                  placeholder={'word, meaning, definition, example\ncandid, thẳng thắn, Honest and direct., He gave a candid account.'}
                  value={text}
                  spellCheck={false}
                  onChange={(event) => {
                    setText(event.target.value);
                    setFileName(null);
                    setSheetNote(null);
                    setParsed(null);
                  }}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" className={BUTTON_PRIMARY} disabled={text.trim() === ''} onClick={() => preview(text)}>
                    Preview
                  </button>
                  <label className={`${BUTTON_SECONDARY} cursor-pointer`}>
                    Choose a file
                    <input type="file" accept=".csv,.tsv,.txt,.json,.xlsx,text/csv,text/plain,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(event) => void onFile(event)} />
                  </label>
                  {fileName !== null && <span className="text-sm text-muted">{fileName}</span>}
                </div>
                {readError !== null && (
                  <p role="alert" className="text-sm text-bad-ink">
                    {readError}
                  </p>
                )}
                <p className={HELP}>
                  CSV or tab-separated text with one word per row, a plain list with one word per line, an Excel file
                  (.xlsx, first sheet only), or a file this app exported. A file is read on this device and is not
                  uploaded. Only the word, meaning, definition, example and date added are used. A mastery or review
                  date in the file is ignored: an imported word starts as a new one
                  {fsrsOnly ? ', with FSRS deciding when it comes up.' : '.'}
                </p>
              </section>

              {parsed !== null && (
                <section className={`${CARD} flex flex-col gap-3 p-5`} aria-labelledby="import-columns-title">
                  <h2 id="import-columns-title" className={SECTION_TITLE}>
                    2. Which column is which
                  </h2>
                  {parsed.rows.length === 0 ? (
                    <p role="alert" className="text-sm text-bad-ink">
                      Nothing could be read from that text.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-muted">
                        {parsed.format === 'json'
                          ? 'Read as a file exported from this app.'
                          : parsed.format === 'spreadsheet'
                            ? (sheetNote ?? 'Read from a spreadsheet.')
                            : parsed.format === 'lines'
                              ? 'Read as a plain list: one value per line.'
                            : `Read as text separated by ${DELIMITER_NAMES[parsed.delimiter ?? ','] ?? 'a delimiter'}.`}{' '}
                        {count(parsed.rows.length, 'row')}, {count(columns, 'column')}.
                      </p>
                      {parsed.header === null && (
                        <label className="flex cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--accent)]"
                            checked={hasHeader}
                            onChange={(event) => {
                              setHasHeader(event.target.checked);
                              setMapping(guessMapping(columns, event.target.checked ? (parsed.rows[0] ?? null) : null));
                            }}
                          />
                          The first row holds column names, not a word
                        </label>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        {Array.from({ length: columns }, (_, index) => (
                          <div key={index} className="flex flex-col gap-1">
                            <label htmlFor={`import-column-${index}`} className="text-xs font-medium text-muted">
                              Column {index + 1}
                              {header?.[index] ? `: “${header[index]}”` : ''}
                            </label>
                            <select
                              id={`import-column-${index}`}
                              className={INPUT}
                              value={mapping[index] ?? ''}
                              onChange={(event) => setColumn(index, event.target.value === '' ? null : (event.target.value as ImportField))}
                            >
                              <option value="">Do not import</option>
                              {IMPORT_FIELDS.map((field) => (
                                <option key={field} value={field}>
                                  {IMPORT_FIELD_LABELS[field]}
                                </option>
                              ))}
                            </select>
                            <p className="truncate text-xs text-muted">e.g. {parsed.rows[skipFirst ? 1 : 0]?.[index] || '(empty)'}</p>
                          </div>
                        ))}
                      </div>
                      {problem !== null && (
                        <p role="alert" className="text-sm text-bad-ink">
                          {problem}
                        </p>
                      )}
                    </>
                  )}
                </section>
              )}

              {parsed !== null && problem === null && parsed.rows.length > 0 && (
                <section className={`${CARD} flex flex-col gap-3 p-5`} aria-labelledby="import-check-title">
                  <h2 id="import-check-title" className={SECTION_TITLE}>
                    3. Check and confirm
                  </h2>
                  <p className="text-sm" role="status">
                    <strong className="font-semibold tabular-nums">{counts.new}</strong> new ·{' '}
                    <span className="tabular-nums">{counts.duplicate}</span> already in your vocabulary ·{' '}
                    <span className="tabular-nums">{counts.repeated}</span> repeated in this list ·{' '}
                    <span className="tabular-nums">{counts.invalid}</span> cannot be imported
                  </p>
                  {(counts.duplicate > 0 || counts.repeated > 0) && (
                    <p className={HELP}>
                      A word counts as the same when it matches after ignoring case and extra spaces. Duplicates are left
                      out unless you tick them; ticking one adds it as a separate word and merges nothing.
                    </p>
                  )}
                  {tooMany && (
                    <p role="alert" className="text-sm text-bad-ink">
                      This list has {checked.length} rows. Import at most {IMPORT_LIMITS.rows} at a time.
                    </p>
                  )}

                  <div className="max-h-96 overflow-auto rounded-xl border border-line">
                    <table className="w-full min-w-[36rem] text-left text-sm">
                      <caption className="sr-only">The rows that were read, and what importing would do with each</caption>
                      <thead className="sticky top-0 bg-surface text-xs text-muted">
                        <tr>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Line
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Word
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Meaning
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            What will happen
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {checked.slice(0, PREVIEW_ROWS).map((row) => {
                          const optional = row.status === 'duplicate' || row.status === 'repeated';
                          return (
                            <tr key={row.line} className="border-t border-line align-top">
                              <td className="px-3 py-1.5 tabular-nums text-muted">{row.line}</td>
                              <th scope="row" className="px-3 py-1.5 font-medium wrap-anywhere">
                                {row.word || <span className="text-muted">(none)</span>}
                              </th>
                              <td className="px-3 py-1.5 text-muted wrap-anywhere">{row.meaning ?? row.definition ?? ''}</td>
                              <td className="px-3 py-1.5">
                                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[row.status]}`}>
                                  {STATUS_TEXT[row.status]}
                                </span>
                                {row.problem !== null && <span className="mt-0.5 block text-xs text-bad-ink">{row.problem}</span>}
                                {row.status === 'duplicate' && (
                                  <span className="mt-0.5 block text-xs text-muted">
                                    Matches “{row.matches[0]?.word}”{row.matches[0]?.meaning ? ` (${row.matches[0].meaning})` : ''}
                                    {row.matches.length > 1 ? ` and ${row.matches.length - 1} more` : ''}.
                                  </span>
                                )}
                                {row.status === 'repeated' && (
                                  <span className="mt-0.5 block text-xs text-muted">Same as line {row.firstLine}.</span>
                                )}
                                {optional && (
                                  <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-xs">
                                    <input
                                      type="checkbox"
                                      className="size-3.5 accent-[var(--accent)]"
                                      checked={forced.has(row.line)}
                                      onChange={(event) =>
                                        setForced((current) => {
                                          const next = new Set(current);
                                          if (event.target.checked) next.add(row.line);
                                          else next.delete(row.line);
                                          return next;
                                        })
                                      }
                                    />
                                    Import “{row.word}” anyway, as a separate word
                                  </label>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {checked.length > PREVIEW_ROWS && (
                    <p className={HELP}>
                      Showing the first {PREVIEW_ROWS} of {checked.length} rows. Every row was checked and is counted
                      above.
                    </p>
                  )}

                  {spreadPrompt && (
                    <div
                      role="group"
                      aria-label="Spread this import over several days"
                      className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-soft/40 p-4"
                    >
                      <div>
                        <p className="text-sm font-semibold text-ink">
                          This list has {chosen.length} words. Spread them over several days?
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-muted">
                          A large list all at once would flood the queue. Spread words are still in the Bank right
                          away; only their first due day changes.
                        </p>
                      </div>
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="radio"
                          name="spread-import"
                          className="mt-1 accent-[var(--accent)]"
                          checked={spread}
                          onChange={() => setSpread(true)}
                        />
                        <span className="flex flex-wrap items-center gap-2">
                          Yes, about
                          <input
                            type="number"
                            min={1}
                            max={1000}
                            inputMode="numeric"
                            aria-label="New words per day"
                            className={`${INPUT} w-24`}
                            value={wordsPerDay}
                            disabled={!spread}
                            onChange={(event) => setWordsPerDay(event.target.value)}
                          />
                          new words a day
                        </span>
                      </label>
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="radio"
                          name="spread-import"
                          className="mt-1 accent-[var(--accent)]"
                          checked={!spread}
                          onChange={() => setSpread(false)}
                        />
                        <span>No, make every word due today.</span>
                      </label>
                      {spread && (
                        <p className="text-xs text-muted">
                          The first {Math.max(1, Number(wordsPerDay) || 0)} are due today, the next on the following
                          days. You can change the pace later.
                        </p>
                      )}
                      {spreadError !== null && (
                        <p role="alert" className="text-xs text-bad-ink">
                          {spreadError}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className={BUTTON_PRIMARY} onClick={confirmImport}>
                          Import {count(chosen.length, 'word')}
                        </button>
                        <button type="button" className={BUTTON_SECONDARY} onClick={() => setSpreadPrompt(false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className={BUTTON_PRIMARY}
                      disabled={!canWrite || chosen.length === 0 || tooMany || sending !== null || spreadPrompt}
                      onClick={askOrImport}
                    >
                      {sending !== null ? `Importing ${sending.done} of ${sending.total}…` : `Import ${count(chosen.length, 'word')}`}
                    </button>
                    <button type="button" className={BUTTON_SECONDARY} disabled={sending !== null} onClick={reset}>
                      Start over
                    </button>
                    <span className={HELP}>Nothing has been added yet.</span>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </VocabularyGate>
    </div>
  );
}
