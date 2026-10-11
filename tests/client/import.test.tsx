// @vitest-environment jsdom
/**
 * Importing a list and exporting the account, in the browser. The promise of
 * the Import page is that nothing is added before the owner has seen exactly
 * what will be, so several tests here are about what has NOT been sent.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportResponse, VocabularyEntry } from '../../shared/api.js';
import { EXPORT_FORMAT } from '../../shared/export-format.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';

const WORDS: VocabularyEntry[] = [entry(1, { word: 'Candid', meaning: 'thẳng thắn' }), entry(2, { word: 'lucid', meaning: 'sáng suốt' })];

async function open(path: string, options: FakeApiOptions = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: WORDS, ...options });
  const view = render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup(), ...view };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const main = () => within(screen.getByRole('main'));

/** Puts text in the box and asks for the preview. Pasted in one go, as a real paste is. */
async function preview(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = await main().findByLabelText('Paste it here');
  await user.click(box);
  await user.paste(text);
  await user.click(main().getByRole('button', { name: 'Preview' }));
}

const rowsOf = () =>
  within(main().getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent).concat(within(row).getByRole('rowheader').textContent ?? ''));
const row = (word: string) => within(main().getByRole('table')).getByRole('rowheader', { name: word }).closest('tr')!;
const column = (n: number) => main().getByLabelText(new RegExp(`^Column ${n}`)) as HTMLSelectElement;

const LIST = ['Word,Vietnamese Meaning,Mastery,Date Added', 'candid,thẳng,9,2026-09-01', 'tenacious,bền bỉ,3,2026-09-02', 'gregarious,"thích giao du, hòa đồng",1,'].join('\n');

describe('reaching the Import page', () => {
  it('is linked from Add vocabulary, and belongs to that section', async () => {
    const { user } = await open('/add');
    await user.click(await main().findByRole('link', { name: 'Import a list' }));
    expect(window.location.pathname).toBe('/import');
    expect(document.title).toBe('Import · Vocabulary');
    const nav = within(screen.getAllByRole('navigation', { name: 'Main' })[0]!);
    expect(nav.getByRole('link', { name: /^Add vocabulary/ })).toHaveAttribute('aria-current', 'page');
  });

  it('says what is read from a list and what is not', async () => {
    await open('/import');
    expect(await main().findByText(/A mastery or review date in the file is ignored/)).toBeInTheDocument();
  });
});

describe('previewing a list', () => {
  it('reads the headings, maps the columns by them, and leaves the rest out', async () => {
    const { api, user } = await open('/import');
    await preview(user, LIST);
    expect(main().getByText(/Read as text separated by commas\./)).toHaveTextContent('4 rows, 4 columns.');
    expect(main().getByLabelText(/The first row holds column names/)).toBeChecked();
    expect([1, 2, 3, 4].map((n) => column(n).value)).toEqual(['word', 'meaning', '', 'dateAdded']);
    expect(column(3).closest('div')).toHaveTextContent('Column 3: “Mastery”');
    // Looking is not importing.
    expect(api.importWords).not.toHaveBeenCalled();
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('shows what importing would do with every row before anything is added', async () => {
    const { api, user } = await open('/import');
    await preview(user, LIST);
    expect(main().getByRole('status')).toHaveTextContent('2 new · 1 already in your vocabulary · 0 repeated in this list · 0 cannot be imported');
    expect(row('candid')).toHaveTextContent('Already in your vocabulary');
    expect(row('candid')).toHaveTextContent('Matches “Candid” (thẳng thắn).');
    expect(row('tenacious')).toHaveTextContent('New');
    // A comma inside quotes stayed inside its cell.
    expect(row('gregarious')).toHaveTextContent('thích giao du, hòa đồng');
    expect(main().getByText('Nothing has been added yet.')).toBeInTheDocument();
    expect(main().getByRole('button', { name: 'Import 2 words' })).toBeEnabled();
    expect(api.importWords).not.toHaveBeenCalled();
  });

  it('points out rows that cannot be imported, with the reason, and rows repeated in the list', async () => {
    const { user } = await open('/import');
    await preview(user, ['word,meaning,date added', 'tenacious,bền bỉ,09/10/2026', ',orphan,', 'serene,thanh thản,', 'Serene,again,'].join('\n'));
    expect(main().getByRole('status')).toHaveTextContent('1 new · 0 already in your vocabulary · 1 repeated in this list · 2 cannot be imported');
    expect(row('tenacious')).toHaveTextContent('“09/10/2026” is not a date written as YYYY-MM-DD.');
    expect(rowsOf().find((cells) => cells.includes('(none)'))?.join(' ')).toContain('No word.');
    expect(row('Serene')).toHaveTextContent('Same as line 4.');
    expect(main().getByRole('button', { name: 'Import 1 word' })).toBeEnabled();
  });

  it('reads a plain list as one word per line', async () => {
    const { user } = await open('/import');
    await preview(user, 'tenacious\nwell, then\n\nserene');
    expect(main().getByText(/Read as a plain list: one value per line\./)).toHaveTextContent('3 rows, 1 column.');
    expect(main().getByLabelText(/The first row holds column names/)).not.toBeChecked();
    expect(rowsOf().map((cells) => cells.at(-1))).toEqual(['tenacious', 'well, then', 'serene']);
  });

  it('reads tab-separated text without headings in the usual order', async () => {
    const { user } = await open('/import');
    await preview(user, 'tenacious\tbền bỉ\nserene\tthanh thản');
    expect(main().getByText(/Read as text separated by tabs\./)).toBeInTheDocument();
    expect([column(1).value, column(2).value]).toEqual(['word', 'meaning']);
    expect(row('serene')).toHaveTextContent('thanh thản');
  });

  it('lets the columns be corrected, and will not go on without a word column', async () => {
    const { user } = await open('/import');
    await preview(user, 'bền bỉ,tenacious\nthanh thản,serene');
    // Guessed the wrong way round: the first column is not the word.
    await user.selectOptions(column(1), 'meaning');
    expect(main().getByRole('alert')).toHaveTextContent('Choose which column holds the word.');
    expect(main().queryByRole('table')).not.toBeInTheDocument();
    expect(main().queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();

    await user.selectOptions(column(2), 'word');
    expect(main().queryByRole('alert')).not.toBeInTheDocument();
    expect(row('tenacious')).toHaveTextContent('bền bỉ');

    await user.selectOptions(column(1), 'word');
    expect(main().getByRole('alert')).toHaveTextContent('Two columns are set to “Word”. Each field can come from one column.');
    expect(main().queryByRole('table')).not.toBeInTheDocument();
  });

  it('treats the first row as a word when told it is not a heading', async () => {
    const { user } = await open('/import');
    await preview(user, 'word,meaning\ntenacious,bền bỉ');
    expect(main().getByRole('status')).toHaveTextContent('1 new');
    await user.click(main().getByLabelText(/The first row holds column names/));
    expect(main().getByRole('status')).toHaveTextContent('2 new');
    expect(row('word')).toHaveTextContent('meaning');
  });

  it('reads a file chosen from the device', async () => {
    const { user } = await open('/import');
    const file = new File([LIST], 'my-words.csv', { type: 'text/csv' });
    await user.upload(await main().findByLabelText('Choose a file'), file);
    expect(await main().findByText('my-words.csv')).toBeInTheDocument();
    expect(await main().findByRole('button', { name: 'Import 2 words' })).toBeInTheDocument();
  });

  it('refuses a file too large to be a word list', async () => {
    const { user } = await open('/import');
    const file = new File(['x'], 'huge.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'size', { value: 6_000_000 });
    await user.upload(await main().findByLabelText('Choose a file'), file);
    expect(await main().findByRole('alert')).toHaveTextContent('larger than 5 MB');
    expect(main().queryByRole('table')).not.toBeInTheDocument();
  });

  it('recognises a file this app exported', async () => {
    const { user } = await open('/import');
    const exported = JSON.stringify({
      format: EXPORT_FORMAT,
      vocabulary: [{ word: 'serene', meaning: 'thanh thản', mastery: 9, reviewDate: '2030-01-01', example: 'A serene lake.' }],
    });
    await preview(user, exported);
    expect(main().getByText(/Read as a file exported from this app\./)).toBeInTheDocument();
    expect(main().queryByLabelText(/The first row holds column names/)).not.toBeInTheDocument();
    expect(row('serene')).toHaveTextContent('New');
  });

  it('says so when nothing can be read', async () => {
    const { user } = await open('/import');
    await preview(user, '\n \n');
    // Only blank lines: there is nothing to preview, so the button stays out of reach.
    expect(main().queryByRole('table')).not.toBeInTheDocument();
  });

  it('starts over cleanly', async () => {
    const { user } = await open('/import');
    await preview(user, LIST);
    await user.click(main().getByRole('button', { name: 'Start over' }));
    expect(main().getByLabelText('Paste it here')).toHaveValue('');
    expect(main().queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('confirming an import', () => {
  it('sends only the new rows, with their content and nothing about a schedule', async () => {
    const { api, user } = await open('/import');
    await preview(user, LIST);
    await user.click(main().getByRole('button', { name: 'Import 2 words' }));

    await waitFor(() => expect(api.importWords).toHaveBeenCalledTimes(1));
    const sent = api.importWords.mock.calls[0]![0];
    const withoutIds = sent.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'requestId')));
    expect(withoutIds).toEqual([
      { word: 'tenacious', meaning: 'bền bỉ', dateAdded: '2026-09-02' },
      { word: 'gregarious', meaning: 'thích giao du, hòa đồng' },
    ]);
    expect(new Set(sent.map((item) => item.requestId)).size).toBe(2);
    expect(JSON.stringify(sent)).not.toMatch(/mastery|reviewDate/);
  });

  it('reports what happened and refreshes the vocabulary', async () => {
    const { api, user } = await open('/import');
    await preview(user, LIST);
    await user.click(main().getByRole('button', { name: 'Import 2 words' }));

    const report = await main().findByRole('region', { name: 'Import report' });
    expect(within(report).getByRole('heading', { name: 'Import finished' })).toBeInTheDocument();
    expect(report).toHaveTextContent('Imported2');
    expect(report).toHaveTextContent('Left out by you or by the checks1');
    expect(report).toHaveTextContent('Refused by the server0');
    expect(report).toHaveTextContent('Nothing was merged into, or changed on, a word you already had.');
    await waitFor(() => expect(api.fetchVocabulary).toHaveBeenCalledTimes(2));
    expect(within(report).getByRole('link', { name: 'Open the vocabulary bank' })).toHaveAttribute('href', '/bank');
  });

  it('imports a duplicate only when it is ticked, and then as a separate word', async () => {
    const { api, user } = await open('/import');
    await preview(user, LIST);
    await user.click(within(row('candid')).getByRole('checkbox', { name: /Import “candid” anyway, as a separate word/ }));
    await user.click(main().getByRole('button', { name: 'Import 3 words' }));

    await waitFor(() => expect(api.importWords).toHaveBeenCalled());
    const sent = api.importWords.mock.calls[0]![0];
    expect(sent.find((item) => item.word === 'candid')).toMatchObject({ meaning: 'thẳng', allowDuplicate: true });
    expect(sent.filter((item) => item.allowDuplicate === true)).toHaveLength(1);
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('lists the rows the server would not take', async () => {
    const { api, user } = await open('/import');
    api.importWords.mockResolvedValueOnce({
      results: [
        { outcome: 'imported', entry: null, message: null },
        { outcome: 'duplicate', entry: null, message: '"gregarious" is already in your vocabulary.' },
      ],
      stopped: null,
    } satisfies ImportResponse);
    await preview(user, LIST);
    await user.click(main().getByRole('button', { name: 'Import 2 words' }));
    const report = await main().findByRole('region', { name: 'Import report' });
    expect(report).toHaveTextContent('Imported1');
    expect(report).toHaveTextContent('Refused by the server1');
    expect(within(report).getByRole('listitem')).toHaveTextContent('gregarious: "gregarious" is already in your vocabulary.');
  });

  it('stops honestly when sending fails, and resends exactly the unsent rows with the same ids', async () => {
    const many = ['word', ...Array.from({ length: 30 }, (_, index) => `word${index}`)].join('\n');
    const { api, user } = await open('/import');
    await preview(user, many);
    await user.click(main().getByLabelText(/The first row holds column names/));
    await user.click(main().getByLabelText(/The first row holds column names/));

    const real = api.importWords.getMockImplementation()!;
    api.importWords
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'))
      .mockImplementation(real);
    await user.click(main().getByRole('button', { name: 'Import 30 words' }));

    const report = await main().findByRole('region', { name: 'Import report' });
    expect(within(report).getByRole('heading', { name: 'Import stopped part-way' })).toBeInTheDocument();
    expect(report).toHaveTextContent('Imported25');
    expect(report).toHaveTextContent('Not sent yet5');
    expect(within(report).getByRole('alert')).toHaveTextContent('Could not reach the server. Nothing was imported twice');

    const failed = api.importWords.mock.calls[1]![0];
    await user.click(within(report).getByRole('button', { name: 'Try the 5 remaining rows again' }));
    await waitFor(() => expect(api.importWords).toHaveBeenCalledTimes(3));
    expect(api.importWords.mock.calls[2]![0]).toEqual(failed);
    expect(await main().findByRole('heading', { name: 'Import finished' })).toBeInTheDocument();
    expect(main().getByRole('region', { name: 'Import report' })).toHaveTextContent('Imported30');
  });

  it('picks up where the server said it stopped', async () => {
    const { api, user } = await open('/import');
    api.importWords.mockResolvedValueOnce({
      results: [{ outcome: 'imported', entry: null, message: null }],
      stopped: { index: 1, message: 'The database could not be reached.' },
    });
    await preview(user, LIST);
    await user.click(main().getByRole('button', { name: 'Import 2 words' }));
    const report = await main().findByRole('region', { name: 'Import report' });
    expect(report).toHaveTextContent('Imported1');
    expect(report).toHaveTextContent('Not sent yet1');
    await user.click(within(report).getByRole('button', { name: 'Try the 1 remaining row again' }));
    await waitFor(() => expect(api.importWords).toHaveBeenCalledTimes(2));
    expect(api.importWords.mock.calls[1]![0].map((item) => item.word)).toEqual(['gregarious']);
  });

  it('lets a list be checked but not imported while saving is switched off', async () => {
    const { api, user } = await open('/import', { list: { writesEnabled: false } });
    expect(await main().findByText(/a list can be checked here but not imported/)).toBeInTheDocument();
    await preview(user, LIST);
    expect(main().getByRole('button', { name: 'Import 2 words' })).toBeDisabled();
    expect(api.importWords).not.toHaveBeenCalled();
  });

  it('offers nothing to import when every row is already there', async () => {
    const { user } = await open('/import');
    await preview(user, 'candid\nLUCID');
    expect(main().getByRole('status')).toHaveTextContent('0 new · 2 already in your vocabulary');
    expect(main().getByRole('button', { name: 'Import 0 words' })).toBeDisabled();
  });
});

describe('exporting everything', () => {
  function captureDownload() {
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), 'blob:test'), revokeObjectURL: () => undefined }));
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    return { blobs, names, click };
  }

  it('downloads the whole account as one JSON file, and changes nothing', async () => {
    const { blobs, names } = captureDownload();
    const { api, user } = await open('/settings');
    await user.click(await main().findByRole('button', { name: 'Export everything (JSON)' }));

    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(names).toEqual(['vocabulary-everything-2026-10-09.json']);
    const exported = JSON.parse(await blobs[0]!.text()) as { format: string; vocabulary: Array<{ word: string }> };
    expect(exported.format).toBe(EXPORT_FORMAT);
    expect(exported.vocabulary.map((word) => word.word)).toEqual(['Candid', 'lucid']);
    expect(api.fetchExport).toHaveBeenCalledTimes(1);
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.importWords).not.toHaveBeenCalled();
  });

  it('says plainly that it is a copy, not a database backup', async () => {
    await open('/settings');
    expect(await main().findByText(/It is not a database backup/)).toBeInTheDocument();
    expect(main().getByRole('link', { name: 'Import a list of words' })).toHaveAttribute('href', '/import');
  });

  it('reports a failure and downloads nothing', async () => {
    const { blobs } = captureDownload();
    const { api, user } = await open('/settings');
    api.fetchExport.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    await user.click(await main().findByRole('button', { name: 'Export everything (JSON)' }));
    expect(await main().findByText('Could not reach the server.')).toBeInTheDocument();
    expect(blobs).toEqual([]);
  });
});
