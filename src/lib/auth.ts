/**
 * Accounts as the rest of the app sees them. The implementation that talks to
 * Supabase lives in supabase-auth.ts; nothing else imports the SDK.
 */
export interface AuthUser {
  id: string;
  email: string | null;
}

export type AuthState =
  /** Looking for a session saved on this device. */
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; user: AuthUser }
  /** Arrived from a password-reset link: must choose a new password before anything else. */
  | { status: 'recovering'; user: AuthUser };

export type AuthFailureCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'weak_password'
  | 'already_registered'
  | 'invalid_email'
  | 'signups_disabled'
  | 'rate_limited'
  | 'network'
  | 'unknown';

/** A failed account operation, with a message fit to show as it is. */
export class AuthFailure extends Error {
  constructor(
    public readonly code: AuthFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthFailure';
  }
}

export interface AuthClient {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  /**
   * An access token for the signed-in user, renewed first if it has expired.
   * `forceRefresh` asks for a new one regardless. `null` when signed out.
   */
  accessToken(options?: { forceRefresh?: boolean }): Promise<string | null>;
  signIn(email: string, password: string): Promise<void>;
  /** `confirmationRequired` when the account must be confirmed by email before it can sign in. */
  signUp(email: string, password: string): Promise<{ confirmationRequired: boolean }>;
  /** Signs out on this device only; other devices stay signed in. */
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  /** Sets a new password for the signed-in user (the last step of a reset). */
  setPassword(password: string): Promise<void>;
}

export const MIN_PASSWORD_LENGTH = 8;
