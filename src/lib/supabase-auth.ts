/**
 * Supabase Auth in the browser. Uses only the public key, which is meant to
 * be held by browsers; what a signed-in user can reach is decided by the
 * database's Row Level Security, not by anything in this file.
 */
import { createClient, isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { AuthFailure, type AuthClient, type AuthFailureCode, type AuthState, type AuthUser } from './auth.js';

interface SdkError {
  code?: string;
  status?: number;
  message?: string;
}

const MESSAGES: Record<AuthFailureCode, string> = {
  invalid_credentials: 'That email and password do not match an account.',
  email_not_confirmed: 'Confirm your email address first: open the link in the message you were sent.',
  weak_password: 'Choose a longer or less common password.',
  already_registered: 'There is already an account with that email. Sign in instead.',
  invalid_email: 'That does not look like an email address that can be used.',
  signups_disabled: 'New accounts are switched off for this app.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  network: 'Could not reach the sign-in service. Check your connection.',
  unknown: 'That did not work. Try again in a moment.',
};

/** Reduces an SDK error to one the app can show, without passing provider wording through. */
export function toAuthFailure(error: unknown): AuthFailure {
  const { code, status } = (typeof error === 'object' && error !== null ? error : {}) as SdkError;
  let kind: AuthFailureCode = 'unknown';
  if (isAuthRetryableFetchError(error)) kind = 'network';
  else if (code === 'invalid_credentials') kind = 'invalid_credentials';
  else if (code === 'email_not_confirmed') kind = 'email_not_confirmed';
  else if (code === 'weak_password' || code === 'same_password') kind = 'weak_password';
  else if (code === 'user_already_exists' || code === 'email_exists') kind = 'already_registered';
  else if (code === 'email_address_invalid' || code === 'email_address_not_authorized' || code === 'validation_failed') {
    kind = 'invalid_email';
  } else if (code === 'signup_disabled' || code === 'email_provider_disabled') kind = 'signups_disabled';
  else if (status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') {
    kind = 'rate_limited';
  }
  return new AuthFailure(kind, MESSAGES[kind]);
}

const userOf = (session: Session): AuthUser => ({ id: session.user.id, email: session.user.email ?? null });

/** One client per project for the life of the page: two would fight over the same saved session. */
const clients = new Map<string, AuthClient>();

export function createSupabaseAuth(url: string, publicKey: string): AuthClient {
  const key = `${url}\n${publicKey}`;
  let auth = clients.get(key);
  if (auth === undefined) {
    auth = connect(url, publicKey);
    clients.set(key, auth);
  }
  return auth;
}

function connect(url: string, publicKey: string): AuthClient {
  const client = createClient(url, publicKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let state: AuthState = { status: 'loading' };
  const listeners = new Set<() => void>();

  const set = (next: AuthState) => {
    const sameUser =
      'user' in next && 'user' in state && next.user.id === state.user.id && next.user.email === state.user.email;
    // A renewed token for the same person is not a change anyone needs to hear about.
    if (next.status === state.status && (sameUser || !('user' in next))) return;
    state = next;
    for (const listener of listeners) listener();
  };

  // Fires once with the saved session (or none) and again whenever it changes,
  // including when another tab of this browser signs in or out.
  client.auth.onAuthStateChange((event, session) => {
    if (session === null) set({ status: 'signed_out' });
    else if (event === 'PASSWORD_RECOVERY') set({ status: 'recovering', user: userOf(session) });
    // Stay on the new-password step until it is done; a token renewal must not skip it.
    else if (state.status === 'recovering' && state.user.id === session.user.id && event !== 'USER_UPDATED') return;
    else set({ status: 'signed_in', user: userOf(session) });
  });

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async accessToken({ forceRefresh = false } = {}) {
      // getSession renews the token first when it has expired.
      const { data, error } = forceRefresh ? await client.auth.refreshSession() : await client.auth.getSession();
      // Being offline is not the same as being signed out: report it instead of ending the session.
      if (error && isAuthRetryableFetchError(error)) throw toAuthFailure(error);
      return error ? null : (data.session?.access_token ?? null);
    },

    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw toAuthFailure(error);
    },

    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw toAuthFailure(error);
      return { confirmationRequired: data.session === null };
    },

    async signOut() {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw toAuthFailure(error);
    },

    async sendPasswordReset(email) {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      if (error) throw toAuthFailure(error);
    },

    async setPassword(password) {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw toAuthFailure(error);
      // The reset is complete: leave the new-password step.
      const { data } = await client.auth.getSession();
      if (data.session !== null) set({ status: 'signed_in', user: userOf(data.session) });
    },
  };
}
