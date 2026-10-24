// @vitest-environment jsdom
/**
 * The Practice page: study modes that record what happened and never
 * touch a word's schedule. Questions come in a random order, so each test
 * reads which word is on screen rather than assuming one.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VocabularyEntry } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { analyticsResponse, createFakeApi, entry, weakWord, type FakeApiOptions } from '../helpers/fake-api.js';

const WORDS: VocabularyEntry[] = [
  entry(1, { word: 'candid', meaning: 'thẳng thắn', definition: 'Honest and direct.', example: 'He gave a candid account.' }),
  entry(2, { word: 'lucid', meaning: 'sáng suốt', definition: 'Clear and easy to follow.', example: 'A lucid explanation helps.' }),
  entry(3, { word: 'tenacious', meaning: 'bền bỉ', definition: 'Not giving up.', example: 'She is tenacious about it.' }),
  entry(4, { word: 'ephemeral', meaning: 'phù du', definition: 'Lasting a short time.', example: 'Fame is ephemeral.' }),
  entry(5, {
    word: 'gregarious',
    meaning: 'thích giao du',
    definition: 'Fond of company.',
    example: 'Her gregarious brother knew everyone.',
    reviewable: false,
    reviewStatus: 'upcoming',
    reviewDate: '2026-10-20',
  }),
];

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

const main = () => within(screen.getByRole('main'));
const start = async (user: ReturnType<typeof userEvent.setup>) => user.click(await main().findByRole('button', { name: 'Start' }));
/** The word whose meaning is on screen, in the modes that start from a meaning. */
const promptedWord = () => WORDS.find((item) => main().queryByText(item.meaning!) !== null)!;
const sent = (api: ReturnType<typeof createFakeApi>['api'], index = -1) => api.submitPractice.mock.calls.at(index)?.[0];

describe('the Practice page', () => {
  it('has its own place in the navigation', async () => {
    const { user } = await open('/');
    const nav = within(screen.getAllByRole('navigation', { name: 'Main' })[0]!);
    await user.click(nav.getByRole('link', { name: /^Practice/ }));
    expect(window.location.pathname).toBe('/practice');
    expect(document.title).toBe('Practice · Vocabulary');
    expect(await main().findByRole('heading', { name: 'Start a practice session' })).toBeInTheDocument();
  });

  it('says plainly that practice does not change the schedule', async () => {
    await open('/practice');
    expect(await main().findByText(/it never changes mastery or review dates/)).toBeInTheDocument();
  });

  it('offers the four modes, each with what it asks for', async () => {
    await open('/practice');
    await main().findByRole('heading', { name: 'Start a practice session' });
    expect(main().getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual([
      'RecognitionSee the word, pick its meaning from four.',
      'TypingSee the meaning, type the word.',
      'Fill in the blankSee your example sentence with the word left out, type the word.',
      'ListeningExperimentalHear the word read aloud by your browser, type what you hear.',
    ]);
    expect(main().getByRole('radio', { name: /Recognition/ })).toBeChecked();
  });

  it('says how many of the chosen words a mode can use, and why the others are left out', async () => {
    const entries = [
      ...WORDS.slice(0, 4),
      entry(6, { word: 'bare', meaning: null, definition: null, example: 'A bare wall.' }),
      entry(7, { word: 'alleviate', meaning: 'làm dịu', example: 'It alleviated the pain.' }),
      entry(8, { word: 'silent', meaning: 'im lặng', example: null }),
    ];
    const { user } = await open('/practice', { entries });
    expect(await main().findByText(/can be used for recognition/)).toHaveTextContent('6 of 7 words can be used for recognition.');
    expect(main().getByText(/left out:/)).toHaveTextContent('1 word left out: it needs a meaning or a definition.');

    await user.click(main().getByRole('radio', { name: /Fill in the blank/ }));
    expect(main().getByText(/can be used for fill in the blank/)).toHaveTextContent('5 of 7 words');
    const reasons = main().getAllByText(/left out:/).map((item) => item.textContent);
    expect(reasons).toEqual([
      '1 word left out: it needs an example sentence that contains the word exactly as it is written.',
      '1 word left out: it needs an example sentence.',
    ]);
  });

  it('will not start with nothing to ask', async () => {
    const { user } = await open('/practice', { entries: WORDS.slice(0, 2) });
    // Two words cannot make a four-choice question.
    expect(await main().findByText(/can be used for recognition/)).toHaveTextContent('0 of 2 words');
    expect(main().getByRole('button', { name: 'Start' })).toBeDisabled();
    await user.click(main().getByRole('radio', { name: /Typing/ }));
    expect(main().getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('practises due words by default, and any other set on request', async () => {
    const { user } = await open('/practice');
    expect(await main().findByText(/can be used for/)).toHaveTextContent('4 of 4 words');
    await user.selectOptions(main().getByLabelText('Which words'), 'all');
    // The word that is not due can be practised too: practice does not touch its schedule.
    expect(main().getByText(/can be used for/)).toHaveTextContent('5 of 5 words');
  });

  it('can be opened on a mode and a set of words from a link', async () => {
    await open('/practice?mode=typing&source=weak', { weakWords: { words: [weakWord(5), weakWord(2)] } });
    expect(await main().findByRole('radio', { name: /Typing/ })).toBeChecked();
    expect(main().getByLabelText('Which words')).toHaveValue('weak');
    await waitFor(() => expect(main().getByText(/can be used for typing/)).toHaveTextContent('2 of 2 words'));
  });

  it('ignores a mode or a set it does not know', async () => {
    await open('/practice?mode=telepathy&source=everything');
    expect(await main().findByRole('radio', { name: /Recognition/ })).toBeChecked();
    expect(main().getByLabelText('Which words')).toHaveValue('due');
  });
});

describe('recognition', () => {
  const shownWord = () => WORDS.find((item) => main().queryByText(item.word, { selector: 'p' }) !== null)!;
  const choices = () => within(main().getByRole('group', { name: 'Choose the meaning' })).getAllByRole('button');

  it('offers four different meanings, one of them the word’s own, with nothing marking which', async () => {
    const { user } = await open('/practice');
    await start(user);
    const word = shownWord();
    const texts = choices().map((button) => button.textContent);
    expect(texts).toHaveLength(4);
    expect(new Set(texts).size).toBe(4);
    expect(texts.filter((text) => text?.includes(word.meaning!))).toHaveLength(1);
    for (const button of choices()) {
      expect(button).not.toHaveTextContent(/Correct answer|Your choice/);
      expect(button.outerHTML).not.toContain(word.id);
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('sends the chosen word to be judged, and shows the verdict', async () => {
    const { api, user } = await open('/practice');
    await start(user);
    const word = shownWord();
    await user.click(main().getByRole('button', { name: new RegExp(word.meaning!) }));

    expect(sent(api)).toMatchObject({ pageId: word.id, mode: 'recognition', answer: { kind: 'choice', selectedId: word.id } });
    expect(await main().findByRole('status')).toHaveTextContent('Correct.');
    expect(main().getByRole('button', { name: new RegExp(word.meaning!) })).toHaveTextContent('Correct answer');
  });

  it('marks a wrong choice and shows which one was right', async () => {
    const { api, user } = await open('/practice');
    await start(user);
    const word = shownWord();
    const wrong = choices().find((button) => !button.textContent?.includes(word.meaning!))!;
    await user.click(wrong);

    expect(sent(api)?.answer).toMatchObject({ kind: 'choice' });
    expect(sent(api)?.answer).not.toMatchObject({ selectedId: word.id });
    expect(await main().findByRole('status')).toHaveTextContent('Not quite.');
    expect(wrong).toHaveTextContent('Your choice');
    expect(main().getByRole('button', { name: new RegExp(word.meaning!) })).toHaveTextContent('Correct answer');
  });

  it('takes the keys 1 to 4, once', async () => {
    const { api, user } = await open('/practice');
    await start(user);
    const expected = choices()[1]!.textContent;
    fireEvent.keyDown(document.body, { key: '2' });
    fireEvent.keyDown(document.body, { key: '3' });
    await main().findByRole('status');
    expect(api.submitPractice).toHaveBeenCalledTimes(1);
    const chosen = WORDS.find((item) => item.id === (sent(api)?.answer as { selectedId: string }).selectedId)!;
    expect(expected).toContain(chosen.meaning);
  });

  it('keeps its choices in place while the question is on screen', async () => {
    const { user } = await open('/practice');
    await start(user);
    const before = choices().map((button) => button.textContent);
    await user.click(choices()[0]!);
    await main().findByRole('status');
    const after = choices().map((button) => button.textContent?.replace(/Correct answer|Your choice/g, ''));
    expect(after).toEqual(before);
  });
});

describe('typing', () => {
  it('keeps the word out of the page until an answer is given', async () => {
    const { user } = await open('/practice?mode=typing');
    await start(user);
    const word = promptedWord();
    expect(screen.getByRole('main').innerHTML).not.toContain(word.word);
  });

  it('sends what was typed and reports an exact answer as correct', async () => {
    const { api, user } = await open('/practice?mode=typing');
    await start(user);
    const word = promptedWord();
    await user.type(main().getByLabelText('Your answer'), `${word.word.toUpperCase()}{Enter}`);
    expect(sent(api)).toMatchObject({ pageId: word.id, mode: 'typing', answer: { kind: 'typed', text: word.word.toUpperCase() } });
    expect(await main().findByRole('status')).toHaveTextContent('Correct.');
  });

  it('accepts a difference that is not spelling, and says it did', async () => {
    const { user } = await open('/practice?mode=typing');
    await start(user);
    await user.type(main().getByLabelText('Your answer'), `"${promptedWord().word}"{Enter}`);
    expect(await main().findByRole('status')).toHaveTextContent('Accepted: the same word, written slightly differently.');
  });

  it('does not accept a misspelling, and shows the answer', async () => {
    const { user } = await open('/practice?mode=typing');
    await start(user);
    const word = promptedWord();
    await user.type(main().getByLabelText('Your answer'), `${word.word}x{Enter}`);
    const verdict = await main().findByRole('status');
    expect(verdict).toHaveTextContent('Not quite.');
    expect(verdict).toHaveTextContent(`The answer is ${word.word}.`);
  });

  it('does not send an empty answer', async () => {
    const { api, user } = await open('/practice?mode=typing');
    await start(user);
    expect(main().getByRole('button', { name: 'Check' })).toBeDisabled();
    await user.type(main().getByLabelText('Your answer'), '   {Enter}');
    expect(api.submitPractice).not.toHaveBeenCalled();
  });

  it('does not let answer keys from other modes fire while typing', async () => {
    const { api, user } = await open('/practice?mode=typing');
    await start(user);
    await user.type(main().getByLabelText('Your answer'), '1234');
    expect(api.submitPractice).not.toHaveBeenCalled();
    expect(main().getByLabelText('Your answer')).toHaveValue('1234');
  });
});

describe('fill in the blank', () => {
  it('shows the sentence with the word taken out, and nothing that gives it away', async () => {
    const { user } = await open('/practice?mode=cloze');
    await start(user);
    const word = promptedWord();
    const [before, after] = word.example!.split(word.word);
    const sentence = main().getByText((_text, element) => element?.tagName === 'P' && element.textContent?.includes(before!.trim()) === true);
    expect(sentence).toHaveTextContent(after!.trim());
    expect(screen.getByRole('main').innerHTML).not.toContain(word.word);
  });

  it('judges the typed word and then shows it in its place', async () => {
    const { api, user } = await open('/practice?mode=cloze');
    await start(user);
    const word = promptedWord();
    await user.type(main().getByLabelText('Your answer'), `${word.word}{Enter}`);
    expect(sent(api)).toMatchObject({ pageId: word.id, mode: 'cloze', answer: { kind: 'typed', text: word.word } });
    expect(await main().findByRole('status')).toHaveTextContent('Correct.');
    expect(main().getAllByText(word.word).length).toBeGreaterThan(0);
  });
});

describe('a practice session', () => {
  async function answerAll(user: ReturnType<typeof userEvent.setup>, give: (word: VocabularyEntry) => string) {
    for (;;) {
      const word = promptedWord();
      await user.type(main().getByLabelText('Your answer'), `${give(word)}{Enter}`);
      const next = await main().findByRole('button', { name: /^(Next|Finish)$/ });
      const last = next.textContent === 'Finish';
      await user.click(next);
      if (last) return;
    }
  }

  it('asks each chosen word once, under one session id, each answer with its own request id', async () => {
    const { api, user } = await open('/practice?mode=typing');
    await start(user);
    await answerAll(user, (word) => word.word);

    const requests = api.submitPractice.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((request) => request.pageId)).size).toBe(4);
    expect(new Set(requests.map((request) => request.sessionId)).size).toBe(1);
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(4);
    expect(requests.every((request) => typeof request.durationMs === 'number' && request.durationMs >= 0)).toBe(true);
  });

  it('ends with what was right, what to look at again, and what did not change', async () => {
    const { user } = await open('/practice?mode=typing');
    await start(user);
    await answerAll(user, (word) => (word.word === 'candid' ? 'wrong' : word.word));

    const region = await main().findByRole('region', { name: 'Practice summary' });
    const summary = within(region);
    expect(summary.getByRole('heading', { name: 'Practice finished' })).toBeInTheDocument();
    expect(region).toHaveTextContent('Typing: 3 of 4 answers correct (75%).');
    expect(summary.getByRole('button', { name: 'candid' })).toBeInTheDocument();
    expect(summary.getByText('thẳng thắn')).toBeInTheDocument();
    expect(summary.getByText(/Your mastery levels and review dates are unchanged/)).toBeInTheDocument();
    expect(main().getByRole('heading', { name: 'Practise again' })).toBeInTheDocument();
  });

  it('never sends a review answer, and never re-reads or edits the vocabulary', async () => {
    const { api, user } = await open('/practice?mode=typing');
    await start(user);
    await answerAll(user, (word) => word.word);
    expect(api.submitAction).not.toHaveBeenCalled();
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.undoAction).not.toHaveBeenCalled();
    expect(api.fetchVocabulary).toHaveBeenCalledTimes(1);
  });

  it('respects the number of questions asked for', async () => {
    const { api, user } = await open('/practice?mode=typing&source=all');
    await main().findByRole('heading', { name: 'Start a practice session' });
    await user.selectOptions(main().getByLabelText('How many'), '5');
    await start(user);
    expect(main().getByText(/Question 1 of 5/)).toBeInTheDocument();
    await answerAll(user, (word) => word.word);
    expect(api.submitPractice).toHaveBeenCalledTimes(5);
  });

  it('can be ended early, keeping what was answered', async () => {
    const { user } = await open('/practice?mode=typing');
    await start(user);
    await user.type(main().getByLabelText('Your answer'), `${promptedWord().word}{Enter}`);
    await main().findByRole('status');
    await user.click(main().getByRole('button', { name: 'End practice' }));
    expect(await main().findByRole('region', { name: 'Practice summary' })).toHaveTextContent(
      'Typing: 1 of 1 answer correct (100%).',
    );
  });

  it('says so when answers were judged but not recorded', async () => {
    const { user } = await open('/practice?mode=typing', { practiceOutcome: 'dry_run' });
    await start(user);
    await user.type(main().getByLabelText('Your answer'), `${promptedWord().word}{Enter}`);
    expect(await main().findByRole('status')).toHaveTextContent('Not recorded.');
    await user.click(main().getByRole('button', { name: 'End practice' }));
    expect(await main().findByText(/judged but not recorded/)).toHaveTextContent('1 answer was judged but not recorded');
  });

  it('allows selecting number of questions in comprehensive practice', async () => {
    const { user } = await open('/practice');
    await user.selectOptions(main().getByLabelText('Number of questions'), '5');
    await user.click(main().getByRole('button', { name: 'Start practice' }));
    expect(main().getByText(/Question 1 of 5/)).toBeInTheDocument();
  });

  it('offers a Practice again button at the top of the summary to start another session', async () => {
    const { user } = await open('/practice?mode=typing');
    await start(user);
    await user.type(main().getByLabelText('Your answer'), `${promptedWord().word}{Enter}`);
    await main().findByRole('status');
    await user.click(main().getByRole('button', { name: 'End practice' }));

    const region = await main().findByRole('region', { name: 'Practice summary' });
    const practiceAgainBtn = within(region).getByRole('button', { name: 'Practice again' });
    expect(practiceAgainBtn).toBeInTheDocument();
    expect(practiceAgainBtn.className).toContain('bg-good');

    await user.click(practiceAgainBtn);
    expect(main().getByText(/Question 1 of/)).toBeInTheDocument();
  });
});

describe('when an answer cannot be checked', () => {
  it('shows the verdict at once, and repeats the very same request on Try again', async () => {
    const { api, user } = await open('/practice?mode=typing');
    api.submitPractice.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));
    await start(user);
    const word = promptedWord();
    await user.type(main().getByLabelText('Your answer'), `${word.word}{Enter}`);

    // Judged here at once; it is the save that failed.
    expect(await main().findByRole('status')).toHaveTextContent('Correct.');
    const alert = await main().findByRole('alert');
    expect(alert).toHaveTextContent('The database refused this change.');

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.submitPractice).toHaveBeenCalledTimes(2));
    expect(api.submitPractice.mock.calls[1]?.[0]).toEqual(api.submitPractice.mock.calls[0]?.[0]);
    expect(await main().findByRole('status')).toHaveTextContent('Correct.');
    expect(sent(api, 1)).toEqual(sent(api, 0));
  });

  it('lets the failed question be skipped, and reports it as not recorded', async () => {
    const { api, user } = await open('/practice?mode=typing');
    api.submitPractice.mockRejectedValueOnce(new ApiError('forbidden', 'The database refused this change.', 403));
    await start(user);
    await user.type(main().getByLabelText('Your answer'), 'anything{Enter}');
    await user.click(within(await main().findByRole('alert')).getByRole('button', { name: 'Skip this question' }));
    expect(main().getByText(/Question 2 of 4/)).toBeInTheDocument();
    await user.click(main().getByRole('button', { name: 'End practice' }));
    // It was judged here, but never recorded: the summary says so rather than claiming it saved.
    expect(await main().findByRole('region', { name: 'Practice summary' })).toHaveTextContent(
      '1 answer was judged but not recorded',
    );
  });
});

describe('practice from the weak words', () => {
  it('is offered for every listed word, due or not', async () => {
    const words = [weakWord(5, { word: 'gregarious', reviewable: false }), weakWord(1, { word: 'candid' })];
    const { user } = await open('/weak', { weakWords: { words } });
    const link = await screen.findByRole('link', { name: /Practise these/ });
    expect(link).toHaveAttribute('href', '/practice?source=weak');
    await user.click(link);
    await main().findByRole('heading', { name: 'Start a practice session' });
    await user.click(main().getByRole('radio', { name: /Typing/ }));
    await waitFor(() => expect(main().getByText(/can be used for typing/)).toHaveTextContent('2 of 2 words'));
  });
});

describe('practice in Insights', () => {
  const practised = analyticsResponse({
    practice: {
      available: true,
      modes: [
        { mode: 'typing', answers: 12, correct: 9, accuracy: 0.75 },
        { mode: 'recognition', answers: 3, correct: 3, accuracy: null },
      ],
      today: { answers: 4, correct: 3 },
    },
  });

  it('is tabulated one mode at a time, never as one combined figure', async () => {
    await open('/insights', { analytics: practised });
    const table = await screen.findByRole('table', { name: 'Practice by mode, last 30 days' });
    const cells = (name: RegExp) =>
      within(within(table).getByRole('row', { name })).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells(/^Typing/)).toEqual(['12', '9', '75%']);
    expect(cells(/^Recognition/)).toEqual(['3', '3', 'Not enough data']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    const region = screen.getByRole('region', { name: 'Review activity' });
    expect(region).toHaveTextContent('Today: 3 of 4 practice answers correct.');
    expect(region).toHaveTextContent('never changes mastery or review dates');
  });

  it('is shown even before any review has been saved', async () => {
    await open('/insights', { analytics: practised });
    expect(await screen.findByText(/No saved reviews in the last 90 days/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Practice by mode, last 30 days' })).toBeInTheDocument();
  });

  it('points to the Practice page when there has been none', async () => {
    await open('/insights', { analytics: { practice: { available: true, modes: [], today: { answers: 0, correct: 0 } } } });
    expect(await screen.findByRole('link', { name: 'Start a practice session' })).toHaveAttribute('href', '/practice');
  });

  it('is left out where practice is not recorded', async () => {
    await open('/insights');
    await screen.findByText(/No saved reviews in the last 90 days/);
    expect(within(screen.getByRole('region', { name: 'Review activity' })).queryByText(/practice/i)).not.toBeInTheDocument();
  });
});
