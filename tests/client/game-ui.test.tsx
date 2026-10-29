// @vitest-environment jsdom
/**
 * The game as the reader sees it: the level beside the navigation, "+XP" by
 * the card as each answer is saved, today's quests, rewards claimed full screen
 * on the dashboard, and the Achievements page.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GameResponse } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, gameResponse } from '../helpers/fake-api.js';
import { card } from '../helpers/fixtures.js';

beforeEach(() => {
  window.localStorage.clear();
});

const playing = (overrides: Partial<GameResponse> = {}) =>
  gameResponse({
    available: true,
    totalXp: 140,
    level: { level: 2, into: 40, needed: 115 },
    quests: {
      day: [
        { period: 'day', kind: 'due_reviews', target: 18, progress: 6, reward: 30, completed: false },
        { period: 'day', kind: 'practice', target: 12, progress: 12, reward: 25, completed: true },
        { period: 'day', kind: 'combo', target: 25, progress: 3, reward: 35, completed: false },
      ],
      week: { period: 'week', kind: 'week_goal_days', target: 5, progress: 2, reward: 300, completed: false },
    },
    badgeValues: { reviews: 820 },
    badges: [{ badge: 'reviews', tier: 1, earnedAt: '2026-10-08T00:00:00Z' }],
    ...overrides,
  });

const open = (path: string, options: Parameters<typeof createFakeApi>[0] = {}) => {
  window.history.replaceState(null, '', path);
  const fake = createFakeApi(options);
  render(<App api={fake.api} settings={createSettingsStore(null)} />);
  return fake;
};

describe('the level', () => {
  it('shows beside the navigation, and is left out while the game is off', async () => {
    open('/', { game: playing() });
    // Beside the side navigation, and in the phone's header: both lead to the achievements.
    const links = await screen.findAllByRole('link', { name: /Level 2: 40 of 115 XP/ });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/achievements', '/achievements']);
  });

  it('is not shown when the database cannot keep the game', async () => {
    const { api } = open('/');
    await waitFor(() => expect(api.fetchGame).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Level \d/ })).not.toBeInTheDocument();
  });
});

describe('XP for each answer', () => {
  it('rises beside the card as the answer is saved, with the combo bonus', async () => {
    const { saves } = open('/review', { cards: [card(1), card(2)], game: playing() });
    await screen.findByTestId('flashcard');
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
    await waitFor(() => expect(saves).toHaveLength(1));
    await act(async () =>
      saves[0]!.resolve({ outcome: 'applied', state: null, game: { xp: 11, totalXp: 151, level: 2, combo: 10, comboBonus: 10 } }),
    );
    expect(await screen.findByText('+11 XP')).toBeInTheDocument();
    expect(screen.getByText('Combo 10 · +10%')).toBeInTheDocument();
    // The level beside the navigation moves with it.
    expect(await screen.findAllByRole('link', { name: /Level 2: 51 of 115 XP/ })).not.toHaveLength(0);
  });
});

describe('today’s quests', () => {
  it('are on the dashboard, done ones marked, with the week’s quest', async () => {
    open('/', { game: playing() });
    const quests = await screen.findByRole('region', { name: 'Today’s quests' });
    expect(quests).toHaveTextContent('Review 18 due words');
    expect(quests).toHaveTextContent('6/18 · +30 XP');
    expect(quests).toHaveTextContent('Done');
    expect(quests).toHaveTextContent('Meet your goals on 5 days this week');
  });
});

describe('claiming rewards on the dashboard', () => {
  it('opens full screen, one reward at a time, and claims its XP', async () => {
    const { api } = open('/', {
      game: playing({
        rewards: [
          { id: '00000000-0000-4000-8000-000000000001', kind: 'checkin', payload: { day: 3, xp: 20 }, createdAt: '2026-10-09T01:00:00Z' },
          { id: '00000000-0000-4000-8000-000000000002', kind: 'badge', payload: { badge: 'reviews', tier: 1 }, createdAt: '2026-10-09T01:00:00Z' },
        ],
      }),
    });
    const scene = await screen.findByRole('dialog', { name: 'Check-in · day 3 of 7' });
    expect(scene).toHaveTextContent('1/2');
    const claim = within(scene).getByRole('button', { name: 'Claim +20 XP' });
    await waitFor(() => expect(document.activeElement).toBe(claim), { timeout: 3000 });
    fireEvent.click(claim);
    await waitFor(() => expect(api.claimGameRewards).toHaveBeenCalledWith(['00000000-0000-4000-8000-000000000001']));
    // The next one takes its place.
    expect(await screen.findByRole('dialog', { name: 'Reviewer · Bronze' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // 140 + 20 claimed: level 2, 60 of the 115 it takes.
    expect(await screen.findAllByRole('link', { name: /Level 2: 60 of 115 XP/ })).not.toHaveLength(0);
  });

  it('can be put away until the next visit', async () => {
    open('/', {
      game: playing({
        rewards: [{ id: '00000000-0000-4000-8000-000000000003', kind: 'level', payload: { level: 2 }, createdAt: '2026-10-09T01:00:00Z' }],
      }),
    });
    const scene = await screen.findByRole('dialog', { name: 'Level 2' });
    const later = within(scene).getByRole('button', { name: 'Later' });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body), { timeout: 3000 });
    fireEvent.click(later);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('the Achievements page', () => {
  it('shows the level, the check-in, freezes and every badge with the way to its next tier', async () => {
    open('/achievements', { game: playing({ checkin: { day: 2, lastOn: '2026-10-09' }, freezes: { held: 1, max: 2 } }) });
    expect(await screen.findByText('75 XP to level 3')).toBeInTheDocument();
    expect(screen.getByText('Streak freezes: 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Day 2: 15 XP, done' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Day 3: 20 XP' })).toBeInTheDocument();
    // Reviewer holds Bronze (100) and is on the way to Silver (1000).
    expect(screen.getByText(/Next: 1000 reviews/)).toHaveTextContent('820/1000');
  });

  it('says why when the game cannot be kept', async () => {
    open('/achievements');
    expect(await screen.findByText(/XP and levels need the latest database update/)).toBeInTheDocument();
  });
});
