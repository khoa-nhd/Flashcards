import { useState, type FormEvent } from 'react';
import { ApiError, type ReviewApi } from '../lib/api-client.js';
import { Spinner } from './Spinner.js';

export interface UnlockScreenProps {
  api: Pick<ReviewApi, 'login'>;
  onUnlocked: () => void;
}

export function UnlockScreen({ api, onUnlocked }: UnlockScreenProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onUnlocked();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not sign in.');
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="mx-auto flex h-full w-full max-w-sm flex-col justify-center gap-4 px-6"
    >
      <div>
        <h2 className="font-serif text-3xl font-semibold">Locked</h2>
        <p className="mt-2 text-muted">Enter the access password to open your review queue.</p>
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Access password
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-12 rounded-xl border border-line bg-surface px-3 text-base font-normal"
        />
      </label>
      {error !== null && (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="flex h-12 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-accent font-semibold text-white disabled:cursor-wait disabled:opacity-70 dark:text-paper"
      >
        {busy && <Spinner />}
        Unlock
      </button>
    </form>
  );
}
