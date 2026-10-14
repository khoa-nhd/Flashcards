// @vitest-environment jsdom
/**
 * Step 2 of docs/offline-mode-design.md: an answer whose fate is unknown — no
 * connection, a timeout, a server that could not answer — is kept instead of
 * blocking the reviewer, counted where they can always see it, and sent again
 * with the same request id, so one answer is recorded once and never twice.
 * A 4xx is the server's final word and is reported with the word it was for;
 * a 401 stops the sending until sign-in, keeping every entry. The outbox
 * lives only as long as the page (storage is step 3), and the answer carries
 * the instant it was given, so a late save still lands on its own day.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReviewActionResponse, ReviewCard } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError } from '../../src/lib/api-client.js';
import { createOutbox, type OutboxEntry } from '../../src/lib/outbox.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi } from '../helpers/fake-api.js';
import { TODAY, card, pageId, type Deferred } from '../helpers/fixtures.js';

beforeEach(() => {
  window.history.replaceState(null, '', '/review');
});

/** A key press that lands on the page itself, as when nothing is focused. */
const press = (key: string) => fireEvent.keyDown(document.body, { key, code: key === ' ' ? 'Space' : key });

async function fail(save: Deferred<ReviewActionResponse> | undefined, error: unknown) {
  await act(async () => {
    save?.reject(error);
  });
}

async function renderSession(cards: ReviewCard[] = [card(1)]) {
  const fake = createFakeApi({ cards });
  // The app asks for confidence by default; these tests exercise the plain flow.
  const settings = createSettingsStore(null);
  settings.update({ askConfidence: false });
  const view = render(<App api={fake.api} settings={settings} />);
  await screen.findByTestId('flashcard');
  return { ...fake, user: userEvent.setup(), ...view };
}

/** An entry as the session controller would hand it to the outbox. */
const entryFor = (n: number): OutboxEntry => {
  const requestId = `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;
  return {
    requestId,
    word: `word-${n}`,
    request: {
      pageId: pageId(n),
      action: 'remember',
      expected: { mastery: 3, nextReview: TODAY },
      requestId,
      sessionId: `00000000-0000-4000-8000-${String(950 + n).padStart(12, '0')}`,
    },
  };
};

describe('a sitting while the server cannot be reached', () => {
  it('keeps the answer, continues to the end and counts what is waiting the whole way', async () => {
    const { api, saves, user } = await renderSession();
    press(' ');
    press('ArrowRight');
    // The answer carries the instant it was given, so a save that waits still lands on this day.
    expect(api.submitAction.mock.calls[0]?.[0]).toMatchObject({
      requestId: expect.any(String),
      answeredAt: expect.any(String),
    });
    await fail(saves[0], new ApiError('network', 'Could not reach the server.'));

    // The card leaves the queue: the answer waits instead of blocking the reviewer.
    expect(await screen.findByRole('heading', { name: 'Review complete' })).toBeInTheDocument();
    expect(screen.getByText('1 answer waiting to be saved.')).toBeInTheDocument();
    // The saved counts come from the server, so the waiting answer is named beside them, not inside them.
    expect(screen.getByText('1 answer from this sitting is still waiting to be saved.')).toBeInTheDocument();

    api.submitAction.mockResolvedValueOnce({ outcome: 'applied', state: null });
    await user.click(screen.getByRole('button', { name: 'Try now' }));
    await waitFor(() => expect(screen.queryByText(/waiting to be saved/)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Try now' })).not.toBeInTheDocument();
  });

  it('shows a refusal with the word it was for, until it is dismissed', async () => {
    const { api, saves, user } = await renderSession();
    press(' ');
    press('ArrowRight');
    await fail(saves[0], new ApiError('network', 'offline'));
    await screen.findByRole('heading', { name: 'Review complete' });

    api.submitAction.mockRejectedValueOnce(new ApiError('conflict', 'This card was changed on another device.', 409));
    await user.click(screen.getByRole('button', { name: 'Try now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '“word-1” was not saved: This card was changed on another device.',
    );
    expect(screen.queryByText('1 answer waiting to be saved.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the outbox itself', () => {
  it('repeats a kept answer with the same request id, oldest first', async () => {
    const { api } = createFakeApi({ entries: [] });
    const outbox = createOutbox(api);
    api.submitAction.mockReset().mockRejectedValue(new ApiError('network', 'offline'));
    outbox.enqueue(entryFor(1));
    outbox.enqueue(entryFor(2));

    await outbox.flush();
    // Nothing was confirmed, so nothing is dropped.
    expect(outbox.getState().entries.map((entry) => entry.word)).toEqual(['word-1', 'word-2']);

    api.submitAction.mockReset().mockResolvedValue({ outcome: 'applied', state: null });
    await outbox.flush();
    expect(api.submitAction.mock.calls.map((call) => call[0]?.requestId)).toEqual([
      entryFor(1).requestId,
      entryFor(2).requestId,
    ]);
    expect(outbox.getState().entries).toHaveLength(0);
  });

  it('drops only what the server refused, and reports it with the word it was for', async () => {
    const { api } = createFakeApi({ entries: [] });
    const outbox = createOutbox(api);
    api.submitAction.mockReset().mockRejectedValue(new ApiError('conflict', 'That card changed on another device.', 409));
    outbox.enqueue(entryFor(1));

    await outbox.flush();
    expect(outbox.getState().entries).toHaveLength(0);
    expect(outbox.getState().refused).toEqual([{ word: 'word-1', reason: 'That card changed on another device.' }]);
    outbox.dismissRefused();
    expect(outbox.getState().refused).toEqual([]);
  });

  it('says so when an entry was received but nothing was recorded', async () => {
    const { api } = createFakeApi({ entries: [] });
    const outbox = createOutbox(api);
    api.submitAction.mockReset().mockResolvedValue({ outcome: 'dry_run', state: null });
    outbox.enqueue(entryFor(1));

    await outbox.flush();
    expect(outbox.getState().entries).toHaveLength(0);
    expect(outbox.getState().refused).toEqual([
      { word: 'word-1', reason: 'Nothing was recorded, because saving is switched off.' },
    ]);
  });

  it('stops sending until the reviewer signs in again, keeping every entry', async () => {
    const { api } = createFakeApi({ entries: [] });
    const outbox = createOutbox(api);
    api.submitAction.mockReset().mockRejectedValue(new ApiError('unauthorized', 'You are signed out.', 401));
    outbox.enqueue(entryFor(1));

    await outbox.flush();
    expect(outbox.getState().waitingForSignIn).toBe(true);
    expect(outbox.getState().entries).toHaveLength(1);
  });
});
