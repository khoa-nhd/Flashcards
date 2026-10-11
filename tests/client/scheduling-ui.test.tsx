// @vitest-environment jsdom
/**
 * Choosing the schedule in charge, FSRS's recall estimate, the what-if
 * comparison, and the places a due date is shown: all as the reviewer sees
 * them. The rules themselves are tested on the server; this is about what is
 * said, what is asked before anything changes, and what is re-read afterwards.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SchedulerReport } from '../../shared/api.js';
import { addDays } from '../../shared/dates.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import {
  analyticsResponse,
  createFakeApi,
  entry,
  periodStats,
  simulationResponse,
  type FakeApiOptions,
} from '../helpers/fake-api.js';
import { TODAY, card } from '../helpers/fixtures.js';

const fsrsRunning = {
  available: true,
  engine: 'v5.4.2 using FSRS-6.0',
  requestRetention: 0.9,
  ratings: { remember: 'Good', notRemember: 'Again' },
};

const comparing: Partial<SchedulerReport> = {
  fsrs: fsrsRunning,
  switchable: true,
  totalCards: 5,
  comparable: 2,
  cards: [
    { id: 'a', word: 'candid', mastery: 4, legacyDue: '2026-10-12', fsrsDue: '2026-10-11', fsrsIntervalDays: 2, differenceDays: -1, recall: 0.918 },
    { id: 'b', word: 'lucid', mastery: 2, legacyDue: '2026-10-10', fsrsDue: '2026-10-12', fsrsIntervalDays: 3, differenceDays: 2, recall: null },
  ],
  workload: [{ date: TODAY, legacy: 1, fsrs: 0 }],
};

async function open(path: string, options: FakeApiOptions = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi({ entries: [entry(1)], ...options });
  render(<App api={fake.api} settings={createSettingsStore(null)} />);
  await screen.findAllByRole('navigation');
  return { ...fake, user: userEvent.setup() };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const scheduling = async () => (await screen.findByRole('heading', { name: 'Scheduling' })).closest('section')!;

describe('which schedule is in charge', () => {
  it('is the mastery schedule to begin with, with FSRS on offer and nothing changed by looking', async () => {
    const { api } = await open('/settings', { scheduler: comparing });
    const section = await scheduling();
    expect(section).toHaveTextContent('Your reviews are scheduled by mastery level');
    expect(await within(section).findByText(/It does not decide what is due unless you put it in charge/)).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Put FSRS in charge…' })).toBeInTheDocument();
    expect(api.chooseScheduler).not.toHaveBeenCalled();
  });

  it('asks first, saying exactly what will and will not change', async () => {
    const { user, api } = await open('/settings', { scheduler: comparing });
    const section = await scheduling();
    await user.click(await within(section).findByRole('button', { name: 'Put FSRS in charge…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Put FSRS in charge?' });
    expect(dialog).toHaveTextContent('instead of on its mastery date');
    expect(dialog).toHaveTextContent('3 of your 5 words have no FSRS schedule yet. They keep their current dates until you next answer them.');
    expect(dialog).toHaveTextContent('Mastery still goes up with each Remember and still retires a word at the top level');
    expect(dialog).toHaveTextContent('You can go back at any time, and nothing is lost either way');

    // Backing out changes nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.chooseScheduler).not.toHaveBeenCalled();
    expect(section).toHaveTextContent('Your reviews are scheduled by mastery level');
  });

  it('puts FSRS in charge on confirmation, says so, and re-reads what is due', async () => {
    const { user, api } = await open('/settings', { scheduler: comparing });
    const section = await scheduling();
    await waitFor(() => expect(api.fetchVocabulary).toHaveBeenCalledTimes(1));
    await user.click(await within(section).findByRole('button', { name: 'Put FSRS in charge…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Put FSRS in charge' }));

    await waitFor(() => expect(api.chooseScheduler).toHaveBeenCalledWith('fsrs'));
    expect(await screen.findByText('FSRS is now in charge of your reviews.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(section).toHaveTextContent('Your reviews are scheduled by FSRS');
    expect(section).toHaveTextContent('still retires a word at the top level');
    expect(within(section).getByRole('button', { name: 'Go back to the mastery schedule…' })).toBeInTheDocument();
    // Every date and status in the app may just have changed.
    await waitFor(() => expect(api.fetchVocabulary).toHaveBeenCalledTimes(2));
  });

  it('goes back to the mastery schedule the same way', async () => {
    const { user, api } = await open('/settings', { scheduler: { ...comparing, active: 'fsrs' } });
    const section = await scheduling();
    await user.click(await within(section).findByRole('button', { name: 'Go back to the mastery schedule…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Go back to the mastery schedule?' });
    expect(dialog).toHaveTextContent('Those dates were kept up to date while FSRS was in charge');
    await user.click(within(dialog).getByRole('button', { name: 'Use the mastery schedule' }));

    await waitFor(() => expect(api.chooseScheduler).toHaveBeenCalledWith('mastery_v1'));
    expect(await screen.findByText('Mastery schedule is now in charge of your reviews.')).toBeInTheDocument();
    expect(section).toHaveTextContent('Your reviews are scheduled by mastery level');
  });

  it('keeps everything as it was, and says why, when the change cannot be saved', async () => {
    const { user, api } = await open('/settings', { scheduler: comparing });
    const section = await scheduling();
    api.chooseScheduler.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server. Check your connection.'));
    await user.click(await within(section).findByRole('button', { name: 'Put FSRS in charge…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Put FSRS in charge' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(section).toHaveTextContent('Your reviews are scheduled by mastery level');
    expect(api.fetchVocabulary).toHaveBeenCalledTimes(1);
  });

  it('offers no choice where the database cannot keep one yet, and says what is needed', async () => {
    await open('/settings', { scheduler: { ...comparing, switchable: false } });
    const section = await scheduling();
    expect(await within(section).findByText(/switching to it is not available yet/)).toBeInTheDocument();
    expect(section).toHaveTextContent('Choosing FSRS instead needs the database’s latest update');
    expect(within(section).queryByRole('button', { name: /in charge/ })).not.toBeInTheDocument();
  });

  it('reloads a review queue that was already open, so it never shows the other schedule’s cards', async () => {
    const { user, api } = await open('/review', { cards: [card(1)], scheduler: comparing });
    await screen.findByTestId('flashcard');
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);

    await user.click(within(screen.getAllByRole('navigation', { name: 'Main' })[0]!).getByRole('link', { name: /^Settings/ }));
    const section = await scheduling();
    await user.click(await within(section).findByRole('button', { name: 'Put FSRS in charge…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Put FSRS in charge' }));
    await waitFor(() => expect(api.fetchQueue).toHaveBeenCalledTimes(2));
  });
});

describe('FSRS’s estimate of recall', () => {
  it('is shown as a rough whole percentage, and withheld where there is too little to go on', async () => {
    await open('/settings', { scheduler: comparing });
    const section = await scheduling();
    const words = (await within(section).findAllByRole('table'))[1]!;
    expect(within(words).getByRole('columnheader', { name: 'Estimated recall now' })).toBeInTheDocument();
    expect(within(words).getByRole('row', { name: /candid/ })).toHaveTextContent('about 92%');
    expect(within(words).getByRole('row', { name: /lucid/ })).toHaveTextContent('Too early to say');
    // No false precision anywhere in the table.
    expect(words).not.toHaveTextContent('91.8');
  });

  it('is labelled as a model’s estimate, apart from what was actually remembered', async () => {
    await open('/settings', { scheduler: comparing });
    const section = await scheduling();
    const note = await within(section).findByText(/Estimated recall is FSRS’s own figure/);
    expect(note).toHaveTextContent('a model’s estimate from your answers so far, not a measurement and not a promise');
    expect(note).toHaveTextContent('a different thing from the share of answers you actually got right');
  });
});

describe('trying FSRS on the saved answers', () => {
  const result = simulationResponse({
    history: { reviews: 12, firstDay: '2026-09-20', lastDay: '2026-10-08', leftOut: { undone: 2, practice: 3, otherWords: 1 } },
    words: { active: 4, replayed: 3, unseen: 1, retired: 1 },
    nextDue: {
      days: Array.from({ length: 30 }, (_, offset) => ({
        date: addDays(TODAY, offset),
        mastery: offset === 0 ? 2 : offset === 3 ? 1 : 0,
        fsrs: offset === 0 ? 1 : offset === 10 ? 2 : 0,
      })),
      later: { mastery: 1, fsrs: 1 },
    },
    ifAllRemembered: {
      days: Array.from({ length: 30 }, (_, offset) => ({
        date: addDays(TODAY, offset),
        mastery: offset % 5 === 0 ? 2 : 0,
        fsrs: offset % 10 === 0 ? 2 : 0,
      })),
      totals: { mastery: 12, fsrs: 6 },
    },
    cards: [
      { id: 'a', word: 'candid', mastery: 4, reviews: 5, masteryDue: '2026-10-12', fsrsDue: '2026-10-19', fsrsIntervalDays: 14, differenceDays: 7 },
      { id: 'b', word: 'unseen', mastery: 1, reviews: 0, masteryDue: '2026-10-11', fsrsDue: '2026-10-11', fsrsIntervalDays: null, differenceDays: 0 },
    ],
  });

  it('works nothing out until asked, then uses the account’s own target', async () => {
    const { user, api } = await open('/settings', { scheduler: comparing, simulation: result });
    const section = await scheduling();
    await within(section).findByRole('heading', { name: 'Try it on your saved answers' });
    expect(api.fetchSimulation).not.toHaveBeenCalled();

    await user.click(within(section).getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(api.fetchSimulation).toHaveBeenCalledWith(0.9));
    expect(await within(section).findByText(/Worked out from/)).toHaveTextContent(
      'Worked out from 12 saved answers to 3 of your 4 active words, given between 2026-09-20 and 2026-10-08.',
    );
  });

  it('says what it rests on, what it leaves out and what it assumes', async () => {
    const { user } = await open('/settings', { scheduler: comparing, simulation: result });
    const section = await scheduling();
    await user.click(await within(section).findByRole('button', { name: 'Compare' }));
    await within(section).findByText(/Worked out from/);

    expect(section).toHaveTextContent('A word is treated as new at its first saved answer');
    expect(section).toHaveTextContent('1 word has no saved answer. FSRS knows nothing about it, so it keeps its mastery date until first answered.');
    expect(section).toHaveTextContent(
      'Not replayed: 2 records of answers taken back with Undo; 3 practice answers; 1 answer to words that are now mastered or in the trash.',
    );
    expect(section).toHaveTextContent('Nothing here is saved, and no review date changes.');
    expect(section).toHaveTextContent('This is a scenario, not a forecast.');
    expect(section).toHaveTextContent('It says nothing about how well you would remember under either.');
  });

  it('sets the two schedules side by side, in stretches rather than thirty separate days', async () => {
    const { user } = await open('/settings', { scheduler: comparing, simulation: result });
    const section = await scheduling();
    await user.click(await within(section).findByRole('button', { name: 'Compare' }));

    const due = (await within(section).findByText('When each of your 4 active words next falls due')).closest('table')!;
    expect(within(due).getByRole('row', { name: /Today or earlier/ })).toHaveTextContent('Today or earlier21');
    expect(within(due).getByRole('row', { name: /The next 7 days/ })).toHaveTextContent('The next 7 days10');
    expect(within(due).getByRole('row', { name: /Days 8 to 29/ })).toHaveTextContent('Days 8 to 2902');
    expect(within(due).getByRole('row', { name: /After 30 days/ })).toHaveTextContent('After 30 days11');

    const scenario = within(section).getByText('Reviews in the next 30 days, if you remembered every word').closest('table')!;
    expect(within(scenario).getByRole('row', { name: /Total/ })).toHaveTextContent('Total126');

    const words = within(section).getByRole('columnheader', { name: 'FSRS at 90%' }).closest('table')!;
    expect(within(words).getByRole('row', { name: /candid/ })).toHaveTextContent('candid52026-10-122026-10-19+7 d');
    // A word FSRS has nothing on is shown staying where it is, not given a made-up date.
    expect(within(words).getByRole('row', { name: /unseen/ })).toHaveTextContent('unseen02026-10-112026-10-11 (unchanged)same day');
  });

  it('works it out again at another target on request', async () => {
    const { user, api } = await open('/settings', { scheduler: comparing, simulation: result });
    const section = await scheduling();
    await user.click(await within(section).findByRole('button', { name: 'Compare' }));
    await within(section).findByText(/Worked out from/);

    await user.selectOptions(within(section).getByLabelText('Target retention to try'), '0.8');
    await waitFor(() => expect(api.fetchSimulation).toHaveBeenLastCalledWith(0.8));
    expect(await within(section).findByRole('columnheader', { name: 'FSRS at 80%' })).toBeInTheDocument();
    // Trying a target never saves it as the account's setting, and never changes the schedule.
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(api.chooseScheduler).not.toHaveBeenCalled();
  });

  it('says there is nothing to replay yet when no answers have been saved', async () => {
    const { user } = await open('/settings', {
      scheduler: comparing,
      simulation: simulationResponse({ words: { active: 3, replayed: 0, unseen: 3, retired: 0 } }),
    });
    const section = await scheduling();
    await user.click(await within(section).findByRole('button', { name: 'Compare' }));
    expect(await within(section).findByText(/There are no saved answers to replay yet/)).toHaveTextContent(
      'every word stays on its mastery date',
    );
  });

  it('says so when it cannot be worked out, and can be tried again', async () => {
    const { user, api } = await open('/settings', { scheduler: comparing, simulation: result });
    const section = await scheduling();
    api.fetchSimulation.mockRejectedValueOnce(new ApiError('timeout', 'Working out the comparison took too long.'));
    await user.click(await within(section).findByRole('button', { name: 'Compare' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('took too long');

    await user.click(within(section).getByRole('button', { name: 'Compare' }));
    expect(await within(section).findByText(/Worked out from/)).toBeInTheDocument();
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('a due date FSRS set', () => {
  it('is what the card goes by, while the mastery date stays the one sent back with the answer', async () => {
    // Stored mastery date in five days; FSRS has it due three days ago.
    const due = card(1, { nextReview: addDays(TODAY, 5), dueOn: addDays(TODAY, -3) });
    const { user, api, saves } = await open('/review', { cards: [due] });
    expect(await screen.findByTestId('flashcard')).toHaveTextContent('3 days overdue');

    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(api.submitAction).toHaveBeenCalledTimes(1));
    expect(api.submitAction.mock.calls[0]![0]).toMatchObject({ expected: { mastery: 3, nextReview: addDays(TODAY, 5) } });
    saves[0]!.resolve({ outcome: 'applied', state: { mastery: 4, nextReview: addDays(TODAY, 3) } });
  });

  it('is marked as FSRS’s in the word panel, and cannot be typed over there', async () => {
    const word = entry(1, { word: 'candid', reviewDate: addDays(TODAY, 9), scheduledBy: 'fsrs', reviewStatus: 'upcoming', reviewable: false });
    const { user } = await open(`/bank?word=${word.id}`, { entries: [word] });
    const panel = await screen.findByRole('dialog', { name: /candid/ });
    expect(await within(panel).findByText('Review date (set by FSRS)')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Edit' }));
    await user.click(within(panel).getByRole('button', { name: /Review schedule/ }));
    const date = within(panel).getByLabelText('Review date');
    expect(date).toBeDisabled();
    expect(date).toHaveAccessibleDescription(/FSRS sets this word’s review date from your answers/);
    // Mastery is still the reviewer's to correct.
    expect(within(panel).getByLabelText('Mastery')).toBeEnabled();
  });

  it('is an ordinary, editable date for a word the mastery schedule still decides', async () => {
    const word = entry(1, { word: 'candid' });
    const { user } = await open(`/bank?word=${word.id}`, { entries: [word] });
    const panel = await screen.findByRole('dialog', { name: /candid/ });
    expect(await within(panel).findByText('Review date')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Edit' }));
    await user.click(within(panel).getByRole('button', { name: /Review schedule/ }));
    expect(within(panel).getByLabelText('Review date')).toBeEnabled();
  });
});

describe('week-by-week trends on Insights', () => {
  const week = (endOffset: number, overrides: Parameters<typeof periodStats>[0]) =>
    periodStats({ from: addDays(TODAY, endOffset - 6), to: addDays(TODAY, endOffset), ...overrides });
  const analytics = analyticsResponse({
    firstReviewOn: addDays(TODAY, -20),
    days: Array.from({ length: 90 }, (_, index) => ({
      date: addDays(TODAY, index - 89),
      reviews: index === 89 ? 4 : 0,
      remembered: index === 89 ? 3 : 0,
      notRemembered: index === 89 ? 1 : 0,
      durationMs: 0,
    })),
    weeks: [
      week(-14, { reviews: 3, remembered: 3, accuracy: null, timedReviews: 0, averageMs: null }),
      week(-7, { reviews: 20, remembered: 15, accuracy: 0.75, timedReviews: 20, averageMs: 6400, durationMs: 128_000 }),
      week(0, { reviews: 10, remembered: 9, accuracy: 0.9, timedReviews: 2, averageMs: 3000, durationMs: 6000 }),
    ],
  });

  it('charts accuracy and time per card, and leaves a thin week blank rather than at zero', async () => {
    const { user } = await open('/insights', { analytics });
    const activity = await screen.findByRole('region', { name: 'Review activity' });
    const accuracy = (await within(activity).findByText('Accuracy by week, last 3 weeks (%)')).closest('figure')!;
    expect(within(accuracy).getByRole('button', { name: /75% \(15 of 20 answers remembered\)/ })).toBeInTheDocument();
    expect(within(accuracy).getByRole('button', { name: /90% \(9 of 10 answers remembered\)/ })).toBeInTheDocument();
    // Three answers is too few to call a percentage; it is not shown as 0% or as 100%.
    expect(within(accuracy).getByRole('button', { name: /Not enough data: 3 of 5 answers needed/ })).toBeInTheDocument();

    const time = within(activity).getByText('Time per card by week, last 3 weeks (seconds)').closest('figure')!;
    expect(within(time).getByRole('button', { name: /6 s per card, over 20 timed answers/ })).toBeInTheDocument();
    // Two timed answers are not enough to speak of a pace.
    expect(within(time).getByRole('button', { name: /Not enough data: 2 of 5 timed answers needed/ })).toBeInTheDocument();

    // The same figures as a table, with the same words for the blanks.
    await user.click(within(accuracy).getByRole('button', { name: 'Show table' }));
    expect(within(accuracy).getByRole('table')).toHaveTextContent('Not enough data: 3 of 5 answers needed');
    expect(activity).toHaveTextContent('Accuracy is what happened in your saved answers, not a prediction.');
  });

  it('says so instead of drawing an empty chart when no week has enough answers', async () => {
    await open('/insights', {
      analytics: { ...analytics, weeks: [week(0, { reviews: 2, remembered: 2, accuracy: null })] },
    });
    const activity = await screen.findByRole('region', { name: 'Review activity' });
    expect(await within(activity).findByText(/No week has had 5 answers yet/)).toBeInTheDocument();
    expect(within(activity).queryByText(/Accuracy by week/)).not.toBeInTheDocument();
  });
});
