/** A sign-in service that lives in memory, for component tests. */
import { vi } from 'vitest';
import { AuthFailure, type AuthClient, type AuthState, type AuthUser } from '../../src/lib/auth.js';

export interface FakeAccount extends AuthUser {
  email: string;
  password: string;
}

export function createFakeAuth(accounts: FakeAccount[] = [], initial: AuthState = { status: 'signed_out' }) {
  const known = new Map(accounts.map((account) => [account.email, { ...account }]));
  let state = initial;
  const listeners = new Set<() => void>();
  /** Set to make the next token request behave as if the session had been revoked. */
  const control = { tokenRevoked: false, confirmationRequired: false };

  const set = (next: AuthState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const auth = {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    accessToken: vi.fn<AuthClient['accessToken']>(async () => {
      if (control.tokenRevoked || !('user' in state)) return null;
      return `token-for.${state.user.id}.signature`;
    }),
    signIn: vi.fn<AuthClient['signIn']>(async (email, password) => {
      const account = known.get(email);
      if (account === undefined || account.password !== password) {
        throw new AuthFailure('invalid_credentials', 'That email and password do not match an account.');
      }
      control.tokenRevoked = false;
      set({ status: 'signed_in', user: { id: account.id, email: account.email } });
    }),
    signUp: vi.fn<AuthClient['signUp']>(async (email, password) => {
      if (known.has(email)) throw new AuthFailure('already_registered', 'There is already an account with that email. Sign in instead.');
      const account = { id: `user-${known.size + 1}`, email, password };
      known.set(email, account);
      if (control.confirmationRequired) return { confirmationRequired: true };
      set({ status: 'signed_in', user: { id: account.id, email } });
      return { confirmationRequired: false };
    }),
    signOut: vi.fn<AuthClient['signOut']>(async () => {
      set({ status: 'signed_out' });
    }),
    sendPasswordReset: vi.fn<AuthClient['sendPasswordReset']>(async () => undefined),
    setPassword: vi.fn<AuthClient['setPassword']>(async (password) => {
      if (!('user' in state)) throw new AuthFailure('unknown', 'That did not work. Try again in a moment.');
      const account = [...known.values()].find((item) => item.id === (state as { user: AuthUser }).user.id);
      if (account) account.password = password;
      set({ status: 'signed_in', user: state.user });
    }),
  } satisfies AuthClient;

  return { auth, control, set };
}
