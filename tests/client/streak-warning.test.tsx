// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudyGoalsResponse } from '../../shared/api.js';
import { AppProvider, createAppServices } from '../../src/app-context.js';
import { StudyGoalsCard, minutesLeftOf, streakRisk } from '../../src/components/StudyGoals.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, studyGoalsResponse } from '../helpers/fake-api.js';
import { TIME_ZONE, TODAY } from '../helpers/fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

/** A five-day streak standing from yesterday, with today not met yet. */
const atRisk = (overrides: Partial<StudyGoalsResponse> = {}) =>
  studyGoalsResponse({
    chosen: true,
    newWords: { target: 10, done: 4, remaining: 6, met: false, exhausted: false },
    reviews: { target: 30, done: 30, remaining: 0, met: true, exhausted: false },
    streak: { current: 5, longest: 8, metToday: false },
    ...overrides,
  });

/** A moment on TODAY in the fixtures' time zone (UTC+7). */
const at = (time: string) => new Date(`${TODAY}T${time}:00+07:00`);

describe('when a streak is close to being lost', () => {
  it('counts the minutes left of the day in the account time zone', () => {
    expect(minutesLeftOf(TODAY, TIME_ZONE, at('20:15'))).toBe(225);
    expect(minutesLeftOf(TODAY, TIME_ZONE, at('23:59'))).toBe(1);
    // Past midnight the goals describe yesterday, so they say nothing about now.
    expect(minutesLeftOf(TODAY, TIME_ZONE, new Date(`${TODAY}T17:30:00Z`))).toBeNull();
  });

  it('says nothing during the day, warns from 18:00 and grows urgent from 22:00', () => {
    expect(streakRisk(atRisk(), at('17:59'))).toBeNull();
    expect(streakRisk(atRisk(), at('18:00'))).toEqual({ minutesLeft: 360, urgent: false });
    expect(streakRisk(atRisk(), at('21:59'))).toEqual({ minutesLeft: 121, urgent: false });
    expect(streakRisk(atRisk(), at('22:00'))).toEqual({ minutesLeft: 120, urgent: true });
  });

  it('has nothing to warn about without a streak, once today is met, or for goals never chosen', () => {
    const late = at('23:00');
    expect(streakRisk(atRisk({ streak: { current: 0, longest: 8, metToday: false } }), late)).toBeNull();
    expect(streakRisk(atRisk({ streak: { current: 6, longest: 8, metToday: true } }), late)).toBeNull();
    expect(streakRisk(atRisk({ chosen: false }), late)).toBeNull();
  });

  it('shows what is left on the dashboard card, with the way to do it', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('22:30'));
    const services = createAppServices(createFakeApi().api, createSettingsStore(null));
    render(
      <AppProvider value={services}>
        <StudyGoalsCard data={atRisk()} onSaved={() => undefined} compact />
      </AppProvider>,
    );
    const warning = screen.getByRole('region', { name: 'Streak at risk' });
    expect(warning).toHaveTextContent('Your 5-day streak ends in 1 h 30 min.');
    expect(warning).toHaveTextContent('Still to do: 6 new words.');
    // Only the goal still open gets a way in.
    expect(within(warning).getByRole('link', { name: 'Add words' })).toHaveAttribute('href', '/add');
    expect(within(warning).queryByRole('link', { name: 'Review now' })).not.toBeInTheDocument();
  });

  it('leaves the card as it was earlier in the day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('10:00'));
    const services = createAppServices(createFakeApi().api, createSettingsStore(null));
    render(
      <AppProvider value={services}>
        <StudyGoalsCard data={atRisk()} onSaved={() => undefined} compact />
      </AppProvider>,
    );
    expect(screen.queryByRole('region', { name: 'Streak at risk' })).not.toBeInTheDocument();
  });
});
