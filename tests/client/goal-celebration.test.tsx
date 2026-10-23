// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StudyGoalsResponse } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { endedStreak } from '../../src/components/GoalCelebration.js';
import { studyGoalsMayHaveMoved } from '../../src/components/StudyGoals.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, studyGoalsResponse } from '../helpers/fake-api.js';
import { TODAY, card } from '../helpers/fixtures.js';

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/review');
});

/** One review short of both goals: the new word is in, one due review is left. */
const almost = (overrides: Partial<StudyGoalsResponse> = {}) =>
  studyGoalsResponse({
    chosen: true,
    goals: { newWords: 1, reviews: 1, maintenanceMode: false },
    newWords: { target: 1, done: 1, remaining: 0, met: true, exhausted: false },
    reviews: { target: 1, done: 0, remaining: 1, met: false, exhausted: false },
    due: { total: 2, overdue: 0 },
    ...overrides,
  });

const met = (overrides: Partial<StudyGoalsResponse> = {}) =>
  almost({
    reviews: { target: 1, done: 1, remaining: 0, met: true, exhausted: false },
    due: { total: 1, overdue: 0 },
    streak: { current: 4, longest: 4, metToday: true },
    ...overrides,
  });

/** A key press on the page itself, as on the review screen. */
const press = (key: string) => fireEvent.keyDown(document.body, { key, code: key === ' ' ? 'Space' : key });
/** A key press where focus is, as it is inside the open scene. */
const pressHere = (key: string) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, code: key === ' ' ? 'Space' : key });

async function answerOnce(goalsAfter: StudyGoalsResponse) {
  const { api, saves } = createFakeApi({ cards: [card(1), card(2)], studyGoals: almost() });
  render(<App api={api} settings={createSettingsStore(null)} />);
  await screen.findByTestId('flashcard');
  api.fetchStudyGoals.mockResolvedValue(goalsAfter);
  press(' ');
  press('ArrowRight');
  await waitFor(() => expect(api.submitAction).toHaveBeenCalledTimes(1));
  // The server saves the answer.
  await act(async () => saves[0]!.resolve({ outcome: 'applied', state: null }));
  return api;
}

describe('the celebration when both daily goals are met', () => {
  it('plays once, right after the answer that completes the day', async () => {
    const api = await answerOnce(met());
    const scene = await screen.findByRole('dialog', { name: 'Today is complete.' }, { timeout: 3000 });
    expect(scene).toHaveTextContent('1 new word and 1 review today.');
    expect(scene).toHaveTextContent('days in a row');
    expect(scene).toHaveTextContent('Your longest streak yet');
    expect(window.localStorage.getItem('vocab.goals-celebrated.local')).toBe(TODAY);

    // Keys still meant for the card do not reach the review behind, nor close the scene too soon.
    expect(scene.contains(document.activeElement)).toBe(true);
    pressHere(' ');
    pressHere('ArrowRight');
    expect(api.submitAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Today is complete.' })).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(document.activeElement).toBe(button), { timeout: 3000 });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Today is complete.' })).not.toBeInTheDocument());

    // The same day is not celebrated twice.
    act(() => studyGoalsMayHaveMoved());
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.queryByRole('dialog', { name: 'Today is complete.' })).not.toBeInTheDocument();
  });

  it('stays quiet while a goal is still open', async () => {
    const api = await answerOnce(
      almost({ reviews: { target: 1, done: 0, remaining: 1, met: false, exhausted: false } }),
    );
    // The answer could have completed the day, so the goals were asked for.
    await waitFor(() => expect(api.fetchStudyGoals).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole('dialog', { name: 'Today is complete.' })).not.toBeInTheDocument();
  });

  it('does not celebrate suggested goals that were never chosen, since they make no streak', async () => {
    const api = await answerOnce(met({ chosen: false }));
    await waitFor(() => expect(api.fetchStudyGoals).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole('dialog', { name: 'Today is complete.' })).not.toBeInTheDocument();
  });
});

describe('the moment a streak has ended', () => {
  const seen = (day: string, current: number) =>
    window.localStorage.setItem('vocab.streak-seen.local', JSON.stringify({ day, current }));
  const broken = (overrides: Partial<StudyGoalsResponse> = {}) =>
    almost({ streak: { current: 0, longest: 15, metToday: false }, ...overrides });

  it('notices a smaller streak on a later day, and only then', () => {
    const goals = broken();
    expect(endedStreak({ day: '2026-10-07', current: 12 }, goals)).toBe(12);
    // The same day: a met day stays met, so the count cannot have dropped.
    expect(endedStreak({ day: TODAY, current: 12 }, goals)).toBeNull();
    // Still standing from yesterday, or grown since.
    expect(
      endedStreak(
        { day: '2026-10-08', current: 12 },
        almost({ streak: { current: 12, longest: 15, metToday: false } }),
      ),
    ).toBeNull();
    expect(endedStreak({ day: '2026-10-08', current: 0 }, goals)).toBeNull();
    expect(endedStreak(null, goals)).toBeNull();
  });

  it('tells it once on the dashboard, kindly, with the way back', async () => {
    window.history.replaceState(null, '', '/');
    seen('2026-10-06', 12);
    const { api } = createFakeApi({ cards: [card(1)], studyGoals: broken() });
    render(<App api={api} settings={createSettingsStore(null)} />);
    const scene = await screen.findByRole('dialog', { name: 'Your 12-day streak has ended.' }, { timeout: 3000 });
    expect(scene).toHaveTextContent('Missing a day happens.');
    expect(scene).toHaveTextContent('To start again today: 1 review.');
    expect(scene).toHaveTextContent('Longest streak: 15 days');
    expect(within(scene).getByRole('link', { name: 'Start again' })).toHaveAttribute('href', '/review');
    // What was seen is brought up to date, so the same ending is not told twice.
    expect(JSON.parse(window.localStorage.getItem('vocab.streak-seen.local') ?? 'null')).toEqual({
      day: TODAY,
      current: 0,
    });

    const notNow = within(scene).getByRole('button', { name: 'Not now' });
    await waitFor(() => expect(document.activeElement).toBe(within(scene).getByRole('link', { name: 'Start again' })), {
      timeout: 4000,
    });
    fireEvent.click(notNow);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('waits for the dashboard rather than breaking into a review', async () => {
    seen('2026-10-06', 12);
    const { api } = createFakeApi({ cards: [card(1), card(2)], studyGoals: broken() });
    render(<App api={api} settings={createSettingsStore(null)} />);
    await screen.findByTestId('flashcard');
    act(() => studyGoalsMayHaveMoved());
    await waitFor(() => expect(api.fetchStudyGoals).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Still waiting to be told.
    expect(JSON.parse(window.localStorage.getItem('vocab.streak-seen.local') ?? 'null')).toEqual({
      day: '2026-10-06',
      current: 12,
    });
  });

  it('lets a completed day speak instead, since a new streak has already begun', async () => {
    seen('2026-10-06', 12);
    await answerOnce(met({ streak: { current: 1, longest: 15, metToday: true } }));
    expect(await screen.findByRole('dialog', { name: 'Today is complete.' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /streak has ended/ })).not.toBeInTheDocument();
  });
});
