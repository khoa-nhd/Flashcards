// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VocabularyEntry } from '../../shared/api.js';
import { App } from '../../src/App.js';
import { ApiError, type ApiAuth } from '../../src/lib/api-client.js';
import { createSettingsStore } from '../../src/lib/settings.js';
import { createFakeApi, entry } from '../helpers/fake-api.js';
import { createFakeAuth, type FakeAccount } from '../helpers/fake-auth.js';
import { card } from '../helpers/fixtures.js';

const ALICE: FakeAccount = { id: 'user-alice', email: 'alice@example.com', password: 'correct horse' };
const BOB: FakeAccount = { id: 'user-bob', email: 'bob@example.com', password: 'battery staple' };

const WORDS: Record<string, VocabularyEntry[]> = {
  [ALICE.id]: [entry(1, { word: 'alices-word', meaning: 'của Alice' })],
  [BOB.id]: [entry(2, { word: 'bobs-word', meaning: 'của Bob' })],
};

/** Renders the app with accounts. Each signed-in user gets a server of their own, as in production. */
function open(options: { path?: string; signedInAs?: FakeAccount; trashed?: VocabularyEntry[] } = {}) {
  window.history.replaceState(null, '', options.path ?? '/bank');
  const fake = createFakeAuth(
    [ALICE, BOB],
    options.signedInAs
      ? { status: 'signed_in', user: { id: options.signedInAs.id, email: options.signedInAs.email } }
      : { status: 'signed_out' },
  );
  const servers: Array<{ userId: string; auth: ApiAuth; fake: ReturnType<typeof createFakeApi> }> = [];

  const apiFor = vi.fn((auth: ApiAuth) => {
    const state = fake.auth.getState();
    const userId = 'user' in state ? state.user.id : 'nobody';
    const server = createFakeApi({
      entries: WORDS[userId] ?? [],
      cards: [card(1)],
      list: { mode: 'supabase' },
      queue: { mode: 'supabase' },
      trashed: options.trashed,
      account: { email: 'user' in state ? state.user.email : null },
    });
    servers.push({ userId, auth, fake: server });
    return server.api;
  });

  const view = render(<App auth={fake.auth} apiFor={apiFor} settings={createSettingsStore(null)} />);
  return { ...fake, apiFor, servers, user: userEvent.setup(), ...view };
}

async function signIn(user: ReturnType<typeof userEvent.setup>, account: FakeAccount, password = account.password) {
  await user.type(screen.getByLabelText('Email'), account.email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('before anyone is signed in', () => {
  it('shows the sign-in screen and asks the server for nothing', () => {
    const { apiFor } = open();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(apiFor).not.toHaveBeenCalled();
  });

  it('waits while a saved session is looked up, without flashing the sign-in screen', () => {
    window.history.replaceState(null, '', '/bank');
    const fake = createFakeAuth([ALICE], { status: 'loading' });
    render(<App auth={fake.auth} apiFor={() => createFakeApi().api} settings={createSettingsStore(null)} />);
    expect(screen.getByRole('status')).toHaveTextContent('Starting');
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();

    act(() => fake.set({ status: 'signed_out' }));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('rejects a wrong password with a clear message and lets nobody in', async () => {
    const { user, apiFor } = open();
    await signIn(user, ALICE, 'wrong password');
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password do not match an account.');
    expect(apiFor).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('signing in', () => {
  it('opens that account’s own vocabulary', async () => {
    const { user, servers } = open();
    await signIn(user, ALICE);

    expect(await screen.findByText('alices-word')).toBeInTheDocument();
    expect(screen.queryByText('bobs-word')).not.toBeInTheDocument();
    expect(servers).toHaveLength(1);
    // Every request is made with the signed-in user's own token.
    await expect(servers[0]?.auth.token()).resolves.toBe(`token-for.${ALICE.id}.signature`);
  });

  it('restores a saved session without asking again', async () => {
    open({ signedInAs: BOB });
    expect(await screen.findByText('bobs-word')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('names the signed-in account and never mentions Notion', async () => {
    open({ signedInAs: ALICE, path: '/settings' });
    const account = (await screen.findByRole('heading', { name: 'Account' })).closest('section')!;
    expect(account).toHaveTextContent('alice@example.com');
    const connection = (await screen.findByRole('heading', { name: 'Connection' })).closest('section')!;
    await waitFor(() => expect(connection).toHaveTextContent('Your account (Supabase)'));
    expect(connection).toHaveTextContent('They do not appear instantly');
    expect(document.body).not.toHaveTextContent(/notion/i);
  });

  it.each(['/', '/bank', '/add', '/calendar', '/insights', '/review'])('does not mention Notion on %s', async (path) => {
    open({ signedInAs: ALICE, path });
    await screen.findAllByRole('navigation');
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent(/notion/i);
  });
});

describe('creating an account', () => {
  it('signs a new person straight in when no confirmation is needed', async () => {
    const { user, auth } = open();
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await screen.findAllByRole('navigation');
    expect(auth.signUp).toHaveBeenCalledWith('new@example.com', 'a long passphrase');
    // A brand-new account has nothing in it.
    expect(screen.queryByText('alices-word')).not.toBeInTheDocument();
    expect(screen.queryByText('bobs-word')).not.toBeInTheDocument();
  });

  it('explains the confirmation email when the project requires one', async () => {
    const { user, control } = open();
    control.confirmationRequired = true;
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/open the confirmation link/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('asks for a longer password before contacting anyone', async () => {
    const { user, auth } = open();
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 8 characters');
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('says so when the email already has an account', async () => {
    const { user } = open();
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Email'), ALICE.email);
    await user.type(screen.getByLabelText('Password'), 'a long passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already an account');
  });
});

describe('a forgotten password', () => {
  it('sends a reset link without revealing whether the address has an account', async () => {
    const { user, auth } = open();
    await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    await user.type(screen.getByLabelText('Email'), 'whoever@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(auth.sendPasswordReset).toHaveBeenCalledWith('whoever@example.com');
    expect(await screen.findByText(/If that address has an account/)).toBeInTheDocument();
  });

  it('asks for a new password after the reset link, before showing anything else', async () => {
    window.history.replaceState(null, '', '/bank');
    const fake = createFakeAuth([ALICE], { status: 'recovering', user: { id: ALICE.id, email: ALICE.email } });
    const apiFor = vi.fn(() => createFakeApi({ entries: WORDS[ALICE.id], list: { mode: 'supabase' } }).api);
    render(<App auth={fake.auth} apiFor={apiFor} settings={createSettingsStore(null)} />);
    const user = userEvent.setup();

    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    expect(apiFor).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('New password'), 'a brand new passphrase');
    await user.click(screen.getByRole('button', { name: 'Save password' }));

    expect(fake.auth.setPassword).toHaveBeenCalledWith('a brand new passphrase');
    expect(await screen.findByText('alices-word')).toBeInTheDocument();
  });
});

describe('signing out and switching accounts', () => {
  it('returns to the sign-in screen and drops everything that was loaded', async () => {
    const { user, auth } = open({ signedInAs: ALICE, path: '/settings' });
    const account = (await screen.findByRole('heading', { name: 'Account' })).closest('section')!;
    await user.click(within(account).getByRole('button', { name: 'Sign out' }));

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    // An ordinary sign-out is not reported as a problem.
    expect(screen.queryByText(/session ended/)).not.toBeInTheDocument();
  });

  it('never shows the previous account’s words to the next one', async () => {
    const { user, servers, auth } = open({ signedInAs: ALICE });
    expect(await screen.findByText('alices-word')).toBeInTheDocument();

    await act(async () => {
      await auth.signOut();
    });
    await signIn(user, BOB);

    expect(await screen.findByText('bobs-word')).toBeInTheDocument();
    expect(screen.queryByText('alices-word')).not.toBeInTheDocument();
    // Bob's data came from a connection made for Bob; Alice's was never reused.
    expect(servers.map((server) => server.userId)).toEqual([ALICE.id, BOB.id]);
    expect(servers[1]?.fake.api.fetchVocabulary).toHaveBeenCalled();
    await expect(servers[1]?.auth.token()).resolves.toBe(`token-for.${BOB.id}.signature`);
  });

  it('starts the next account’s review session from scratch', async () => {
    const { user, servers, auth } = open({ signedInAs: ALICE, path: '/review' });
    await screen.findByTestId('flashcard');
    await act(async () => {
      await auth.signOut();
    });
    await signIn(user, BOB);
    await screen.findByTestId('flashcard');
    expect(servers[0]?.fake.api.fetchQueue).toHaveBeenCalledTimes(1);
    expect(servers[1]?.fake.api.fetchQueue).toHaveBeenCalledTimes(1);
    expect(servers[1]?.fake.api.submitAction).not.toHaveBeenCalled();
  });
});

describe('a session that has ended', () => {
  it('returns to the sign-in screen and says why', async () => {
    const { servers } = open({ signedInAs: ALICE });
    expect(await screen.findByText('alices-word')).toBeInTheDocument();

    // The server refused a renewed token: the API layer reports the session as over.
    act(() => servers[0]?.auth.onRejected());

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended. Sign in again to continue.');
    expect(screen.queryByText('alices-word')).not.toBeInTheDocument();
  });

  it('does not ask for a shared password when a request is refused', async () => {
    window.history.replaceState(null, '', '/bank');
    const fake = createFakeAuth([ALICE], { status: 'signed_in', user: { id: ALICE.id, email: ALICE.email } });
    const server = createFakeApi({ list: { mode: 'supabase' } });
    server.api.fetchVocabulary.mockRejectedValue(new ApiError('unauthorized', 'Your session has ended. Sign in again to continue.', 401));
    render(<App auth={fake.auth} apiFor={() => server.api} settings={createSettingsStore(null)} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has ended');
    expect(screen.queryByLabelText('Access password')).not.toBeInTheDocument();
  });
});

describe('account settings', () => {
  it('shows the stored time zone and saves a new one', async () => {
    const { user, servers } = open({ signedInAs: ALICE, path: '/settings' });
    const section = (await screen.findByRole('heading', { name: 'Time zone' })).closest('section')!;
    const select = await within(section).findByLabelText('Your time zone');
    expect(select).toHaveValue('Asia/Ho_Chi_Minh');
    expect(within(section).getByRole('button', { name: 'Save time zone' })).toBeDisabled();

    await user.selectOptions(select, 'UTC');
    await user.click(within(section).getByRole('button', { name: 'Save time zone' }));

    const api = servers[0]!.fake.api;
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ timeZone: 'UTC' }));
    // "Today" may have changed, so what is due is read again.
    await waitFor(() => expect(api.fetchVocabulary).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Time zone set to UTC.')).toBeInTheDocument();
  });

  it('lists deleted words and restores one', async () => {
    const gone = entry(9, { word: 'forgotten', meaning: 'bị quên', mastery: 7 });
    const { user, servers } = open({ signedInAs: ALICE, path: '/settings', trashed: [gone] });
    const section = (await screen.findByRole('heading', { name: 'Deleted words' })).closest('section')!;
    expect(await within(section).findByText('forgotten')).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Restore forgotten' }));

    const api = servers[0]!.fake.api;
    await waitFor(() => expect(api.restoreEntry).toHaveBeenCalledWith(gone.id));
    expect(await within(section).findByText('Nothing has been deleted.')).toBeInTheDocument();
    expect(await screen.findByText('Restored “forgotten”.')).toBeInTheDocument();
  });
});
