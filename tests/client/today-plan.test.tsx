// @vitest-environment jsdom
/**
 * The "What to do today" card on the Dashboard: a couple of concrete steps
 * worked out from figures the app already has — due cards and high-priority
 * weak words — each linking straight to the page that does it. It suggests
 * and links; it never orders or limits anything.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { TodayPlan } from '../../src/components/TodayPlan.js';
import { createFakeApi, entry, weakWord } from '../helpers/fake-api.js';

describe('the card on its own', () => {
  it('lists the due review and the weak words, each with its own way in', () => {
    render(<TodayPlan due={3} weakHigh={2} />);

    expect(screen.getByRole('heading', { name: 'What to do today' })).toBeInTheDocument();
    expect(screen.getByText('Review the 3 cards that are due.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start review' })).toHaveAttribute('href', '/review');
    expect(screen.getByText('Practise the 2 weakest words.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Practise now' })).toHaveAttribute('href', '/practice?source=weak');
    // Nothing is due only becomes advice when nothing is due.
    expect(screen.queryByText(/Nothing is due/)).not.toBeInTheDocument();
  });

  it('says singular where the figure is one', () => {
    render(<TodayPlan due={1} weakHigh={0} />);

    expect(screen.getByText('Review the 1 card that is due.')).toBeInTheDocument();
    expect(screen.queryByText(/Practise/)).not.toBeInTheDocument();
    // "Nothing is due" is advice for when nothing is due; a card waiting is not that.
    expect(screen.queryByText(/Nothing is due/)).not.toBeInTheDocument();
  });

  it('leaves the weak line out while that count is not known, and points at new words', () => {
    render(<TodayPlan due={0} weakHigh={null} />);

    expect(screen.queryByText(/Practise/)).not.toBeInTheDocument();
    expect(screen.getByText('Nothing is due — add new words or read something to collect more.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add vocabulary' })).toHaveAttribute('href', '/add');
  });
});

describe('the card on the Dashboard', () => {
  it('shows the real figures the page already has', async () => {
    window.history.replaceState(null, '', '/');
    const fake = createFakeApi({
      entries: [entry(1, { reviewable: true }), entry(2, { reviewable: false })],
      weakWords: { words: [weakWord(1, { severity: 'high' }), weakWord(2)] },
    });
    render(<App api={fake.api} />);
    await screen.findAllByRole('navigation');

    expect(await screen.findByRole('heading', { name: 'What to do today' })).toBeInTheDocument();
    expect(screen.getByText('Review the 1 card that is due.')).toBeInTheDocument();
    // Only the high-priority weak word counts here; the medium one belongs to the weak page itself.
    expect(screen.getByText('Practise the 1 weakest word.')).toBeInTheDocument();
  });
});
