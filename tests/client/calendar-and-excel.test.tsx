// @vitest-environment jsdom
/**
 * Two things a reader does with files and days: looking at saved reviews on
 * the calendar, and bringing a word list in from an Excel file. The Excel
 * files here are real ones, built for the test and read by the real library.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VocabularyEntry } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { heatLevel, reviewHeatLevel } from '../../src/pages/CalendarPage.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';
import { TODAY } from '../helpers/fixtures.js';
import { buildXlsx } from '../helpers/xlsx-file.js';

// TODAY is Friday 9 October 2026.
const WORDS: VocabularyEntry[] = [
  entry(1, { word: 'Candid', meaning: 'thẳng thắn', dateAdded: TODAY }),
  entry(2, { word: 'lucid', meaning: 'sáng suốt', dateAdded: '2026-10-05' }),
];

const REVIEWED = [
  { date: '2026-09-30', reviews: 3, remembered: 3 },
  { date: '2026-10-05', reviews: 12, remembered: 9 },
  { date: TODAY, reviews: 1, remembered: 0 },
];

async function open(path: string, options: FakeApiOptions = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: WORDS, reviewDays: REVIEWED, ...options });
  render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup() };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const main = () => within(screen.getByRole('main'));
const day = (label: RegExp) => screen.getByRole('button', { name: label });

describe('reviews on the calendar', () => {
  it('shows words added unless asked, and asks the server for nothing else', async () => {
    const { api } = await open('/calendar');
    expect(await screen.findByRole('button', { name: 'Words added' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Reviews' })).toHaveAttribute('aria-pressed', 'false');
    expect(day(/^Oct 9, 2026: 1 word added \(today\)$/)).toBeInTheDocument();
    expect(api.fetchReviewDays).not.toHaveBeenCalled();
  });

  it('switches to saved reviews per day, loaded for the whole grid on show', async () => {
    const { user, api } = await open('/calendar');
    await user.click(await screen.findByRole('button', { name: 'Reviews' }));
    expect(window.location.search).toBe('?month=2026-10&view=reviews');

    // October 2026 is drawn from Monday 28 September to Sunday 1 November.
    await waitFor(() => expect(api.fetchReviewDays).toHaveBeenCalledWith('2026-09-28', '2026-11-01'));
    expect(await screen.findByRole('button', { name: /^Oct 5, 2026: 12 reviews$/ })).toHaveAttribute('data-level', '2');
    expect(day(/^Oct 9, 2026: 1 review \(today\)$/)).toHaveAttribute('data-level', '1');
    expect(day(/^Oct 6, 2026: no reviews$/)).toHaveAttribute('data-level', '0');
    // A day of the month before that shows in the grid is counted on the grid, not in the month's total.
    expect(day(/^Sep 30, 2026: 3 reviews$/)).toBeInTheDocument();
    expect(screen.getByText('13 reviews saved this month.')).toBeInTheDocument();
    expect(screen.getByLabelText('Legend: reviews per day')).toHaveTextContent('Reviews1–910–2425–4950+');
    expect(main().getByText(/Answers taken back with Undo are not counted/)).toBeInTheDocument();
  });

  it('says how a selected day went, without pretending to list its words', async () => {
    const { user } = await open('/calendar?view=reviews');
    await user.click(await screen.findByRole('button', { name: /^Oct 5, 2026: 12 reviews$/ }));
    expect(window.location.search).toBe('?month=2026-10&date=2026-10-05&view=reviews');
    const panel = screen.getByRole('heading', { name: 'Oct 5, 2026' }).closest('section')!;
    expect(panel).toHaveTextContent('12 reviews saved: 9 remembered, 3 not remembered.');
    // "lucid" was added that day, which is the other view's business.
    expect(within(panel).queryByRole('button', { name: /lucid/ })).not.toBeInTheDocument();

    await user.click(day(/^Oct 6, 2026/));
    expect(screen.getByText('No reviews were saved on this day.')).toBeInTheDocument();
  });

  it('keeps the view while moving between months, and loads each month it shows', async () => {
    const { user, api } = await open('/calendar?view=reviews');
    await screen.findByRole('button', { name: /^Oct 5, 2026: 12 reviews$/ });
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
    expect(window.location.search).toBe('?month=2026-09&view=reviews');
    await waitFor(() => expect(api.fetchReviewDays).toHaveBeenLastCalledWith('2026-08-31', '2026-10-04'));
    expect(await screen.findByText('3 reviews saved this month.')).toBeInTheDocument();
  });

  it('goes back to words added, exactly as before', async () => {
    const { user } = await open('/calendar?month=2026-10&date=2026-10-05&view=reviews');
    await user.click(await screen.findByRole('button', { name: 'Words added' }));
    expect(window.location.search).toBe('?month=2026-10&date=2026-10-05');
    const panel = screen.getByRole('heading', { name: 'Oct 5, 2026' }).closest('section')!;
    expect(panel).toHaveTextContent('1 word added.');
    expect(within(panel).getByRole('button', { name: /lucid/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Legend: words added per day')).toBeInTheDocument();
  });

  it('says so when the reviews cannot be loaded, shows no made-up zeros as fact, and can be tried again', async () => {
    const { user, api } = await open('/calendar?date=2026-10-05');
    api.fetchReviewDays.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server. Check your connection.'));
    await user.click(await screen.findByRole('button', { name: 'Reviews' }));

    const alert = await main().findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the server');
    expect(screen.getByText('The reviews for this day could not be loaded.')).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^Oct 5, 2026: 12 reviews$/ })).toBeInTheDocument();
    expect(main().queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says what is needed where the database keeps no review statistics yet', async () => {
    const { user, api } = await open('/calendar');
    api.fetchReviewDays.mockResolvedValueOnce({ available: false, from: '2026-09-28', to: '2026-11-01', days: [] });
    await user.click(await screen.findByRole('button', { name: 'Reviews' }));
    expect(await main().findByText(/Reviews per day cannot be shown yet: the database needs its latest update/)).toBeInTheDocument();
  });

  it('shades by a scale that suits each kind of count', () => {
    expect([0, 1, 2, 3, 4, 6, 7].map(heatLevel)).toEqual([0, 1, 2, 2, 3, 3, 4]);
    expect([0, 1, 9, 10, 24, 25, 49, 50, 400].map(reviewHeatLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe('importing from an Excel file', () => {
  const xlsx = (name: string, bytes: Uint8Array) =>
    new File([bytes as BlobPart], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const book = buildXlsx([
    {
      name: 'Vocabulary',
      rows: [
        ['Word', 'Vietnamese Meaning', 'Mastery', 'Date Added'],
        ['candid', 'thẳng', 9, new Date(Date.UTC(2026, 8, 1))],
        ['tenacious', 'bền bỉ', 3, new Date(Date.UTC(2026, 8, 2))],
        [null, null, null, null],
        ['gregarious', 'thích giao du, hòa đồng', 1, null],
      ],
    },
    { name: 'Scratch', rows: [['not for import']] },
  ]);
  const rowOf = (word: string) => within(main().getByRole('table')).getByRole('rowheader', { name: word }).closest('tr')!;

  it('reads the first sheet on this device, shows it for checking, and sends nothing', async () => {
    const { user, api } = await open('/import');
    await user.upload(await main().findByLabelText('Choose a file'), xlsx('words.xlsx', book));

    expect(await main().findByText(/Read from the first sheet, “Vocabulary”/)).toHaveTextContent(
      '1 other sheet in the file was not read: Scratch. 4 rows, 4 columns.',
    );
    // The row of column names was recognised as one, so it is not offered as a word.
    expect(main().getByLabelText('The first row holds column names, not a word')).toBeChecked();
    const table = await main().findByRole('table');
    expect(within(table).queryByRole('rowheader', { name: 'Word' })).not.toBeInTheDocument();
    expect(rowOf('tenacious')).toHaveTextContent('bền bỉ');
    expect(rowOf('gregarious')).toHaveTextContent('thích giao du, hòa đồng');
    // Already in the vocabulary, whatever its capitals: flagged, and left out unless ticked.
    expect(rowOf('candid')).toHaveTextContent('Already in your vocabulary');
    expect(api.importWords).not.toHaveBeenCalled();
  });

  it('imports the confirmed rows as new words, ignoring any mastery in the file', async () => {
    const { user, api } = await open('/import');
    await user.upload(await main().findByLabelText('Choose a file'), xlsx('words.xlsx', book));
    await main().findByRole('table');
    await user.click(main().getByRole('button', { name: /^Import 2/ }));

    await waitFor(() => expect(api.importWords).toHaveBeenCalledTimes(1));
    const items = api.importWords.mock.calls[0]![0];
    expect(items.map((item) => [item.word, item.meaning, item.dateAdded])).toEqual([
      ['tenacious', 'bền bỉ', '2026-09-02'],
      ['gregarious', 'thích giao du, hòa đồng', undefined],
    ]);
    for (const item of items) expect(item).not.toHaveProperty('mastery');
    expect(await main().findByRole('heading', { name: 'Import finished' })).toBeInTheDocument();
  });

  it('refuses the older .xls format by name, saying what to do instead', async () => {
    const { api } = await open('/import');
    // The file picker's filter is only a hint; a reader can still choose any file.
    const anyFile = userEvent.setup({ applyAccept: false });
    await anyFile.upload(await main().findByLabelText('Choose a file'), new File(['anything'], 'words.xls'));
    expect(await main().findByRole('alert')).toHaveTextContent('older Excel file (.xls). Save it as .xlsx or as CSV');
    expect(main().queryByRole('table')).not.toBeInTheDocument();
    expect(api.importWords).not.toHaveBeenCalled();
  });

  it('says so when a file named .xlsx is not a spreadsheet, and shows nothing from it', async () => {
    const { user } = await open('/import');
    await user.upload(await main().findByLabelText('Choose a file'), xlsx('broken.xlsx', new Uint8Array([1, 2, 3, 4])));
    expect(await main().findByRole('alert')).toHaveTextContent('could not be read as an Excel spreadsheet');
    expect(main().queryByRole('table')).not.toBeInTheDocument();
  });

  it('still reads a CSV file as text, as before', async () => {
    const { user } = await open('/import');
    await user.upload(await main().findByLabelText('Choose a file'), new File(['word,meaning\ntenacious,bền bỉ\n'], 'words.csv'));
    expect(await main().findByText(/Read as text separated by commas/)).toBeInTheDocument();
    expect(rowOf('tenacious')).toHaveTextContent('bền bỉ');
  });
});
