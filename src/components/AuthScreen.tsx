import { useState, type FormEvent } from 'react';
import { AuthFailure, MIN_PASSWORD_LENGTH, type AuthClient } from '../lib/auth.js';
import { Spinner } from './Spinner.js';

type Mode = 'sign_in' | 'sign_up' | 'forgot';

export interface AuthScreenProps {
  auth: AuthClient;
  /** Shown above the form, for example after a session ended on its own. */
  notice?: string | null;
  /** True after following a password-reset link: only a new password is asked for. */
  recovering?: boolean;
}

const COPY: Record<Mode, { title: string; lead: string; submit: string }> = {
  sign_in: { title: 'Sign in', lead: 'Your vocabulary and review progress are kept in your account.', submit: 'Sign in' },
  sign_up: {
    title: 'Create an account',
    lead: 'Each account has its own vocabulary. Nobody else can see or change yours.',
    submit: 'Create account',
  },
  forgot: {
    title: 'Reset your password',
    lead: 'Enter your email address and a link to choose a new password will be sent to it.',
    submit: 'Send reset link',
  },
};

const INPUT =
  'h-12 rounded-xl border border-line-strong bg-paper px-3 text-base font-normal transition-colors focus:border-accent';
const SUBMIT =
  'flex h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-accent font-semibold text-on-accent transition hover:bg-accent-hover disabled:cursor-wait disabled:opacity-70 focus-visible:outline-on-accent';
// Padded so the links are comfortable to tap on a phone.
const TEXT_BUTTON = 'cursor-pointer rounded-lg px-1 py-2 font-semibold text-accent underline-offset-2 hover:underline';

const messageOf = (cause: unknown) =>
  cause instanceof AuthFailure ? cause.message : 'That did not work. Try again in a moment.';

export function AuthScreen({ auth, notice = null, recovering = false }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choosesPassword = recovering || mode === 'sign_up';
  const copy = recovering
    ? { title: 'Choose a new password', lead: 'Enter the password you want to use from now on.', submit: 'Save password' }
    : COPY[mode];

  const go = (next: Mode) => {
    setMode(next);
    setError(null);
    setInfo(null);
    setPassword('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    if (choosesPassword && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);
      return;
    }
    setBusy(true);
    try {
      if (recovering) {
        await auth.setPassword(password);
      } else if (mode === 'sign_in') {
        await auth.signIn(email.trim(), password);
      } else if (mode === 'sign_up') {
        const { confirmationRequired } = await auth.signUp(email.trim(), password);
        if (confirmationRequired) {
          setMode('sign_in');
          setPassword('');
          setInfo('Almost there: open the confirmation link sent to your email, then sign in here.');
        }
      } else {
        await auth.sendPasswordReset(email.trim());
        setMode('sign_in');
        setInfo('If that address has an account, a reset link is on its way. It can take a minute to arrive.');
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-line bg-surface p-6 sm:p-7"
      noValidate
    >
      <div>
        <p className="text-sm font-semibold tracking-[-0.01em] text-faint">Vocabulary</p>
        <h1 className="mt-2 font-serif text-[2rem] font-semibold leading-tight tracking-[-0.02em]">{copy.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{copy.lead}</p>
      </div>

      {notice !== null && info === null && error === null && (
        <p role="status" className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink">
          {notice}
        </p>
      )}
      {info !== null && (
        <p role="status" className="rounded-xl bg-accent-soft px-3 py-2 text-sm text-ink">
          {info}
        </p>
      )}

      {!recovering && (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Email
          <input
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={INPUT}
          />
        </label>
      )}

      {(recovering || mode !== 'forgot') && (
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {recovering ? 'New password' : 'Password'}
            <input
              type="password"
              name="password"
              autoComplete={choosesPassword ? 'new-password' : 'current-password'}
              autoFocus={recovering}
              required
              minLength={choosesPassword ? MIN_PASSWORD_LENGTH : undefined}
              aria-describedby={choosesPassword ? 'password-hint' : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT}
            />
          </label>
          {choosesPassword && (
            <p id="password-hint" className="text-xs text-muted">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          )}
        </div>
      )}

      {error !== null && (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy} className={SUBMIT}>
        {busy && <Spinner />}
        {copy.submit}
      </button>

      {recovering ? (
        <p className="text-center text-sm text-muted">
          <button type="button" className={TEXT_BUTTON} onClick={() => void auth.signOut().catch(() => undefined)}>
            Cancel and sign out
          </button>
        </p>
      ) : (
        <div className="flex flex-col items-center gap-2 text-sm text-muted">
          {mode === 'sign_in' && (
            <>
              <p>
                New here?{' '}
                <button type="button" className={TEXT_BUTTON} onClick={() => go('sign_up')}>
                  Create an account
                </button>
              </p>
              <button type="button" className={TEXT_BUTTON} onClick={() => go('forgot')}>
                Forgot your password?
              </button>
            </>
          )}
          {mode !== 'sign_in' && (
            <p>
              Already have an account?{' '}
              <button type="button" className={TEXT_BUTTON} onClick={() => go('sign_in')}>
                Sign in
              </button>
            </p>
          )}
        </div>
      )}
    </form>
  );
}
