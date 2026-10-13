import { useEffect, useState } from 'react';

/** The lengths a focus session can be set to, in minutes. */
const DURATIONS = [15, 20] as const;
/** The rest offered when a block ends: long enough to stand up and look away. */
const BREAK_MINUTES = 5;

const asClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const PILL = 'cursor-pointer rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted transition hover:text-ink';

/**
 * The countdown shown while Focus Mode is on: pick a length, pause when a
 * break is needed, and when a block ends take a short counted rest before
 * starting the next one. Nothing starts on its own — the rest and the next
 * block are both offered, and it is up to the reader to take them. It is only
 * a reminder on screen: it never ends the session or moves the reviewer
 * anywhere.
 */
export function FocusTimer() {
  const [minutes, setMinutes] = useState<number>(DURATIONS[0]);
  const [resting, setResting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number>(DURATIONS[0] * 60);
  const [paused, setPaused] = useState(false);
  const up = secondsLeft === 0;

  // One tick a second while it runs; once it is up, or paused, no interval is left behind.
  useEffect(() => {
    if (paused || secondsLeft === 0) return;
    const id = setInterval(() => setSecondsLeft((current) => Math.max(current - 1, 0)), 1000);
    return () => clearInterval(id);
  }, [paused, secondsLeft]);

  /** Begins the chosen block of work, or the rest, from its own start. */
  const startWork = (value: number) => {
    setMinutes(value);
    setResting(false);
    setSecondsLeft(value * 60);
    setPaused(false);
  };
  const startBreak = () => {
    setResting(true);
    setSecondsLeft(BREAK_MINUTES * 60);
    setPaused(false);
  };

  return (
    <div role="group" aria-label="Focus timer" className="flex items-center gap-2">
      {up ? (
        <p role="status" className="text-sm font-semibold text-warn-ink">
          {resting ? 'Break is over' : 'Time is up'}
        </p>
      ) : (
        <span className="min-w-11 text-sm font-semibold tabular-nums">
          {resting && <span className="mr-1 text-xs font-medium text-muted">Break</span>}
          {asClock(secondsLeft)}
        </span>
      )}
      <div role="group" aria-label="Session length" className="flex items-center gap-1">
        {DURATIONS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={minutes === value}
            onClick={() => startWork(value)}
            className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium transition ${
              minutes === value ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            {value} min
          </button>
        ))}
      </div>
      {up ? (
        resting ? (
          <button type="button" onClick={() => startWork(minutes)} className={PILL}>
            Start {minutes} min
          </button>
        ) : (
          <>
            <button type="button" onClick={startBreak} className={PILL}>
              Take a {BREAK_MINUTES} min break
            </button>
            <button type="button" onClick={() => startWork(minutes)} className={PILL}>
              Start again
            </button>
          </>
        )
      ) : (
        <button type="button" onClick={() => setPaused((current) => !current)} className={PILL}>
          {paused ? 'Resume' : 'Pause'}
        </button>
      )}
    </div>
  );
}
