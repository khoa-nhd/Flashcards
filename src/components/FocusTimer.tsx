import { useEffect, useState } from 'react';

/** The lengths a focus session can be set to, in minutes. */
const DURATIONS = [15, 20] as const;

const asClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * The countdown shown while Focus Mode is on: pick a length, pause when a
 * break is needed, and see when the time is up. It is only a reminder on
 * screen — it never ends the session or moves the reviewer anywhere.
 */
export function FocusTimer() {
  const [minutes, setMinutes] = useState<number>(DURATIONS[0]);
  const [secondsLeft, setSecondsLeft] = useState<number>(DURATIONS[0] * 60);
  const [paused, setPaused] = useState(false);
  const up = secondsLeft === 0;

  // One tick a second while it runs; once it is up, or paused, no interval is left behind.
  useEffect(() => {
    if (paused || secondsLeft === 0) return;
    const id = setInterval(() => setSecondsLeft((current) => Math.max(current - 1, 0)), 1000);
    return () => clearInterval(id);
  }, [paused, secondsLeft]);

  // Choosing a length counts that length down from the start.
  const choose = (value: number) => {
    setMinutes(value);
    setSecondsLeft(value * 60);
    setPaused(false);
  };

  return (
    <div role="group" aria-label="Focus timer" className="flex items-center gap-2">
      {up ? (
        <p role="status" className="text-sm font-semibold text-warn-ink">
          Time is up
        </p>
      ) : (
        <span className="min-w-11 text-sm font-semibold tabular-nums">{asClock(secondsLeft)}</span>
      )}
      <div role="group" aria-label="Session length" className="flex items-center gap-1">
        {DURATIONS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={minutes === value}
            onClick={() => choose(value)}
            className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium transition ${
              minutes === value ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            {value} min
          </button>
        ))}
      </div>
      {!up && (
        <button
          type="button"
          onClick={() => setPaused((current) => !current)}
          className="cursor-pointer rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted transition hover:text-ink"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      )}
    </div>
  );
}
