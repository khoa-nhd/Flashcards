// @vitest-environment jsdom
/**
 * The exam page: a test the reader builds from their own words — sections of
 * questions, clocks that run out honestly, free movement between sections, and
 * a report that names the missed words. Every answer goes down the recorded
 * practice path (so the clocks only ever end the exam, never a review), and
 * the drill from the report opens Practice on exactly those words.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App.js';
import { createFakeApi, entry, type FakeApiOptions } from '../helpers/fake-api.js';
import { pageId } from '../helpers/fixtures.js';

/** The same way of opening a page as the other client tests: copied, not shared. */
async function open(path: string, options: FakeApiOptions = {}) {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi(options);
  render(<App api={fake.api} />);
  await screen.findAllByRole('navigation');
  return fake;
}

afterEach(() => {
  vi.useRealTimers();
});

/** The word the recognition card is showing right now: the prompt is the only place it appears. */
function currentRecognitionWord(): string {
  const shown = ['word-1', 'word-2', 'word-3', 'word-4'].find((word) => screen.queryByText(word) !== null);
  return shown ?? 'word-1';
}

describe('building an exam', () => {
  it('counts the words each section could use and starts with what it has', async () => {
    await open('/exam', { entries: [entry(1), entry(2), entry(3), entry(4)] });
    expect(await screen.findByRole('heading', { name: 'Build your exam' })).toBeInTheDocument();
    // The default asks for 10, but only 4 words exist: the note says so honestly.
    expect(screen.getByText('Only 4 words can be used for recognition — this section will have 4 questions.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add a section' }));
    fireEvent.change(screen.getByLabelText('Section 2: how'), { target: { value: 'typing' } });
    expect(screen.getByText('Only 4 words can be used for typing — this section will have 4 questions.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start the exam' }));
    const tabs = screen.getByRole('group', { name: 'Sections' });
    expect(within(tabs).getAllByRole('button')).toHaveLength(2);
    expect(tabs).toHaveTextContent('1. Recognition 0/4');
    expect(tabs).toHaveTextContent('2. Typing 0/4');
  });
});

describe('sitting the exam', () => {
  it('asks every question, records each answer, and ends the section read through', async () => {
    const fake = await open('/exam', { entries: [entry(1), entry(2), entry(3), entry(4)] });
    fireEvent.change(screen.getByLabelText('Section 1: questions'), { target: { value: '2' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start the exam' }));

    // Question 1: whichever word is up, its own meaning is the right choice.
    const first = currentRecognitionWord();
    fireEvent.click(screen.getByRole('button', { name: `nghĩa ${first.slice('word-'.length)}` }));
    const next = await screen.findByRole('button', { name: 'Next' });
    expect(fake.api.submitPractice).toHaveBeenCalledTimes(1);
    fireEvent.click(next);

    // Question 2: answered wrongly, on purpose — any meaning but its own is wrong, and all four are offered.
    const second = currentRecognitionWord();
    const wrong = second.endsWith('1') ? 'nghĩa 2' : 'nghĩa 1';
    fireEvent.click(screen.getByRole('button', { name: wrong }));
    await screen.findByRole('button', { name: 'Finish' });
    expect(fake.api.submitPractice).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(screen.getByText('Section complete — 1 of 2 correct.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'See the report' }));
    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    // The wrong word is named, with what was said and what was wanted, and leads into a drill.
    expect(screen.getByText(/you said/)).toBeInTheDocument();
    expect(screen.getByText(/expected/)).toBeInTheDocument();
    const drill = screen.getByRole('link', { name: 'Practise the missed words' });
    expect(drill.getAttribute('href')).toContain('source=missed');
    expect(drill.getAttribute('href')).toContain('mode=recognition');
  });

  it('shows both clocks and ends the exam when the whole-exam clock runs out', async () => {
    await open('/exam', { entries: [entry(1), entry(2), entry(3), entry(4)] });
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Section 1: questions'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Section 1: minutes (optional)'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Time for the whole exam in minutes (optional)'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start the exam' }));

    expect(screen.getByText('Overall 1:00')).toBeInTheDocument();
    expect(screen.getByText('This section 1:00')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    // The report appears on its own at zero, with both words named as not answered.
    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText('0 / 2')).toBeInTheDocument();
    expect(screen.getAllByText('not answered', { exact: false })).toHaveLength(2);
  });

  it('locks a section when its own clock runs out and leaves the rest of the exam standing', async () => {
    const fake = await open('/exam', { entries: [entry(1), entry(2), entry(3), entry(4)] });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Add a section' }));
    fireEvent.change(screen.getByLabelText('Section 1: questions'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Section 1: minutes (optional)'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Section 2: how'), { target: { value: 'typing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start the exam' }));

    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    // The clock ends the section, not the exam: nothing was asked, and section 2 waits.
    expect(screen.getByText('Time is up for this section')).toBeInTheDocument();
    expect(screen.getByText(/2 questions left unanswered\./)).toBeInTheDocument();
    expect(fake.api.submitPractice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Go to section 2 (Typing)' }));
    expect(screen.getByPlaceholderText('Type the word')).toBeInTheDocument();
    // The untimed section carries no clock of its own.
    expect(screen.queryByText(/This section/)).not.toBeInTheDocument();
  });
});

describe('the drill from the report', () => {
  it('opens Practice on exactly the missed words', async () => {
    await open(`/practice?mode=typing&source=missed:${pageId(1)},${pageId(2)}`, {
      entries: [entry(1), entry(2), entry(3)],
    });

    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    // The address survives the trip: both ids, and no third word joins them.
    const picker = screen.getByRole('combobox', { name: 'Which words' }) as HTMLSelectElement;
    expect(picker.value).toContain('missed:');
    expect(
      screen
        .getAllByRole('status')
        .some((node) => /2\s+of\s+2\s+words\s+can\s+be\s+used\s+for\s+typing\./.test(node.textContent ?? '')),
    ).toBe(true);
    expect(screen.getByText('Words you missed in an exam')).toBeInTheDocument();
  });
});
