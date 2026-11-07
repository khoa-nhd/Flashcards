// @vitest-environment jsdom
/**
 * The chest room: it draws what the server reports, and opening a chest walks
 * through the build-up to a reward card before the page is usable again.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi } from '../helpers/fake-api.js';

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/chests');
});

const renderPage = (options: Parameters<typeof createFakeApi>[0] = {}) => {
  const { api } = createFakeApi(options);
  render(<App api={api} settings={createSettingsStore(null)} />);
  return api;
};

describe('the chest room', () => {
  it('loads the account’s chests and shows the collection', async () => {
    const api = renderPage();
    expect((await screen.findAllByRole('heading', { name: /^chests$/i })).length).toBeGreaterThan(0);
    // The page is a chunk of its own, so its own content is what says it has mounted.
    expect(await screen.findByRole('heading', { name: /wooden chest/i })).toBeTruthy();
    expect(api.fetchGacha).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: /silver chest/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /golden chest/i })).toBeTruthy();
    // Nothing has been opened, so the collection is still all question marks.
    expect(screen.getAllByText('❓')).toHaveLength(12);
  });

  it('opens a chest on the server, plays the reveal, and lands on a reward card', async () => {
    const api = renderPage();
    const open = (await screen.findAllByRole('button', { name: /^open ·/i }))[0]!;
    fireEvent.click(open);

    expect(api.openChest).toHaveBeenCalledWith(expect.objectContaining({ chestId: 'wooden', count: 1 }));
    expect(await screen.findByRole('dialog')).toBeTruthy();

    // The reveal ends on a single card, dismissed in its own time.
    const done = await screen.findByRole('button', { name: /lovely/i }, { timeout: 6000 });
    fireEvent.click(done);
    expect(screen.queryByRole('dialog')).toBeNull();
  }, 10_000);

  it('summarises a batch of ten with its shards, and lets the player skip ahead', async () => {
    renderPage({ gachaKeys: 12 });
    // Ten keys are enough for one wooden batch of ten.
    const batch = (await screen.findAllByRole('button', { name: /open 10×/i }))[0]!;
    expect((batch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(batch);
    await screen.findByRole('dialog');

    fireEvent.click(await screen.findByRole('button', { name: /skip the rest/i }, { timeout: 6000 }));
    expect(await screen.findByRole('button', { name: /keep them/i })).toBeTruthy();
  }, 10_000);
});
