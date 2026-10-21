// @vitest-environment jsdom
/**
 * Practice mastery as the reader sees it: four small scores in a word's
 * panel, and one line after each practice answer saying where that word now
 * stands in that mode. The counting itself is tested on the server.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VocabularyEntry } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { ticksThatFit } from '../../src/components/BarChart.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';
import { pageId } from '../helpers/fixtures.js';

const WORDS: VocabularyEntry[] = [
  entry(1, { word: 'candid', meaning: 'thẳng thắn', definition: 'Honest and direct.', example: 'He gave a candid account.' }),
];

async function open(path: string, options: FakeApiOptions = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: WORDS, ...options });
  render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup() };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const main = () => within(screen.getByRole('main'));
const panelOf = async () => screen.findByRole('dialog', { name: /candid/ });
const section = async () => (await within(await panelOf()).findByRole('heading', { name: 'Practice mastery' })).closest('section')!;

describe('practice mastery in a word’s panel', () => {
  it('shows every mode with its score out of three, and reads nothing else', async () => {
    const { api } = await open(`/bank?word=${pageId(1)}`, { practiceCorrect: { [pageId(1)]: { typing: 2, cloze: 12 } } });
    const shown = await section();
    expect(api.fetchPracticeMastery).toHaveBeenCalledWith(pageId(1));

    const rows = within(shown).getAllByRole('listitem').map((item) => item.textContent);
    expect(rows).toEqual(['Recognition0 / 3', 'Typing2 / 3', 'Fill in the blank3 / 3', 'Listening0 / 3']);
    const typing = within(shown).getByRole('meter', { name: 'Typing practice mastery' });
    expect(typing).toHaveAttribute('aria-valuenow', '2');
    expect(typing).toHaveAttribute('aria-valuemax', '3');
    expect(typing).toHaveAttribute('aria-valuetext', '2 of 3');
    // Twelve correct answers are still three: the score stops at its ceiling.
    expect(within(shown).getByRole('meter', { name: 'Fill in the blank practice mastery' })).toHaveAttribute('aria-valuenow', '3');
  });

  it('says what the score is, and that it is not the review mastery', async () => {
    await open(`/bank?word=${pageId(1)}`, { practiceCorrect: { [pageId(1)]: { typing: 3 } } });
    const shown = await section();
    expect(shown).toHaveTextContent('One point for each correct practice answer in that mode, up to 3.');
    expect(shown).toHaveTextContent('A wrong answer changes nothing.');
    expect(shown).toHaveTextContent('it never decides when the word is due, and reviewing does not change it');
    // Already practised, so there is no nudge to start.
    expect(within(shown).queryByRole('link', { name: 'Start practising' })).not.toBeInTheDocument();
  });

  it('points to Practice for a word that has not been practised yet', async () => {
    await open(`/bank?word=${pageId(1)}`);
    const shown = await section();
    expect(within(shown).getAllByRole('meter').map((meter) => meter.getAttribute('aria-valuenow'))).toEqual(['0', '0', '0', '0']);
    expect(within(shown).getByRole('link', { name: 'Start practising' })).toHaveAttribute('href', '/practice?source=all');
  });

  it('is left out altogether where practice is not recorded', async () => {
    const { api } = await open(`/bank?word=${pageId(1)}`, { practiceMasteryAvailable: false });
    const panel = await panelOf();
    await waitFor(() => expect(api.fetchPracticeMastery).toHaveBeenCalled());
    await waitFor(() => expect(within(panel).queryByText('Loading practice mastery…')).not.toBeInTheDocument());
    expect(within(panel).queryByRole('heading', { name: 'Practice mastery' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('meter')).not.toBeInTheDocument();
  });

  it('says so when it cannot be loaded, without hiding the rest of the word, and can be tried again', async () => {
    window.history.replaceState(null, '', `/bank?word=${pageId(1)}`);
    const fake = createFakeApi({ entries: WORDS, practiceCorrect: { [pageId(1)]: { cloze: 2 } } });
    fake.api.fetchPracticeMastery.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server. Check your connection.'));
    render(<App api={fake.api} settings={createSettingsStore(null)} />);
    const user = userEvent.setup();

    const panel = await panelOf();
    expect(await within(panel).findByText('Could not reach the server. Check your connection.')).toBeInTheDocument();
    expect(within(panel).getByText('thẳng thắn')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await within(panel).findByRole('meter', { name: 'Fill in the blank practice mastery' })).toHaveAttribute('aria-valuenow', '2');
  });

  it('cannot be edited: the panel’s edit form has no field for it', async () => {
    const { user, api } = await open(`/bank?word=${pageId(1)}`, { practiceCorrect: { [pageId(1)]: { typing: 3 } } });
    const panel = await panelOf();
    await section();
    await user.click(within(panel).getByRole('button', { name: 'Edit' }));
    await user.click(within(panel).getByRole('button', { name: /Review schedule/ }));
    // The one mastery that can be set by hand is the review mastery.
    expect(within(panel).getAllByLabelText(/mastery/i).map((field) => field.getAttribute('id'))).toEqual(['edit-mastery']);
    expect(api.updateEntry).not.toHaveBeenCalled();
  });
});

describe('practice mastery after a practice answer', () => {
  const start = async (user: ReturnType<typeof userEvent.setup>) => user.click(await main().findByRole('button', { name: 'Start' }));

  it('says where the word now stands in that mode after a correct answer', async () => {
    const { user } = await open('/practice?mode=typing&source=all', { practiceCorrect: { [pageId(1)]: { typing: 1 } } });
    await start(user);
    await user.type(await main().findByLabelText('Your answer'), 'candid{Enter}');
    const verdict = (await main().findByText('Correct.')).closest('[role="status"]')!;
    expect(verdict).toHaveTextContent('Typing mastery for this word: 2 of 3.');
  });

  it('shows the same number as before after a wrong answer', async () => {
    const { user } = await open('/practice?mode=typing&source=all', { practiceCorrect: { [pageId(1)]: { typing: 2 } } });
    await start(user);
    await user.type(await main().findByLabelText('Your answer'), 'candit{Enter}');
    const verdict = (await main().findByText('Not quite.')).closest('[role="status"]')!;
    expect(verdict).toHaveTextContent('Typing mastery for this word: 2 of 3.');
  });

  it('names the mode that was practised, since each has a score of its own', async () => {
    const { user } = await open('/practice?mode=cloze&source=all');
    await start(user);
    await user.type(await main().findByLabelText('Your answer'), 'candid{Enter}');
    const verdict = (await main().findByText('Correct.')).closest('[role="status"]')!;
    expect(verdict).toHaveTextContent('Fill in the blank mastery for this word: 1 of 3.');
  });

  it('claims no score when the answer was judged but not recorded', async () => {
    const { user } = await open('/practice?mode=typing&source=all', { practiceOutcome: 'dry_run' });
    await start(user);
    await user.type(await main().findByLabelText('Your answer'), 'candid{Enter}');
    const verdict = (await main().findByText('Correct.')).closest('[role="status"]')!;
    expect(verdict).toHaveTextContent('Not recorded.');
    expect(verdict).not.toHaveTextContent('mastery for this word');
  });
});

describe('axis labels on a chart', () => {
  const ticks = (count: number, every: number) =>
    Array.from({ length: count }, (_, index) => ((count - 1 - index) % every === 0 ? 'Oct 12' : ''));

  it('keeps every label until the width is known', () => {
    expect(ticksThatFit(['a', '', 'b'], null)).toEqual([true, false, true]);
  });

  it('keeps them all when there is room', () => {
    const shown = ticksThatFit(ticks(30, 7), 600);
    expect(shown.filter(Boolean)).toHaveLength(5);
  });

  it('drops labels rather than letting them run into each other on a narrow chart, newest kept', () => {
    // Ninety days in 280 px: a label every seventh bar would need about twice the room there is.
    const labels = ticks(90, 7);
    const shown = ticksThatFit(labels, 280);
    expect(shown[89]).toBe(true);
    const kept = shown.filter(Boolean).length;
    expect(kept).toBeGreaterThan(1);
    expect(kept).toBeLessThan(labels.filter((label) => label !== '').length);

    // No two kept labels overlap, by the same arithmetic the chart draws with.
    const column = 280 / 90;
    const width = 'Oct 12'.length * 6.5;
    const lefts = shown
      .map((keep, index) => (keep ? (index === 89 ? 280 - width : (index + 0.5) * column - width / 2) : null))
      .filter((left) => left !== null);
    for (let index = 1; index < lefts.length; index += 1) expect(lefts[index]! - lefts[index - 1]!).toBeGreaterThanOrEqual(width);
  });

  it('never shows a label for a bar that has none', () => {
    expect(ticksThatFit(['', '', ''], 300)).toEqual([false, false, false]);
  });
});
