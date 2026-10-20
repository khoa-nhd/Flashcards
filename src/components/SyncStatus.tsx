import { useEffect, useState } from 'react';
import { useSync } from '../app-context.js';
import { Spinner } from './Spinner.js';

const CHIP = 'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium';

/**
 * One quiet line about what has not reached the server: changes waiting, ones
 * the server refused, or no connection at all. It is a hint, not an alarm —
 * the app works either way — so it says nothing while everything is saved.
 * `navigator.onLine` only decides which words are used here; sending is driven
 * by what actually happens to each request.
 */
export function SyncStatus() {
  const { pending, refused, lastError } = useSync();
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  if (refused > 0) {
    return (
      <span
        role="status"
        title={
          (lastError === null ? 'The server refused some changes. ' : `${lastError} `) +
          'They are kept on this device until you retry or dismiss them.'
        }
        className={`${CHIP} bg-bad-soft text-bad-ink`}
      >
        {refused} not saved
      </span>
    );
  }
  if (pending > 0) {
    return (
      <span
        role="status"
        title={`${pending} ${pending === 1 ? 'change is' : 'changes are'} waiting to be sent. They are kept on this device until the server has them.`}
        className={`${CHIP} bg-line-strong/50 text-muted`}
      >
        <Spinner className="size-3" />
        Saving{pending > 1 ? ` ${pending}` : ''}…
      </span>
    );
  }
  if (!online) {
    return (
      <span
        role="status"
        title="No connection. The app keeps working, and anything you do is sent when the connection is back."
        className={`${CHIP} bg-warn-soft text-warn-ink`}
      >
        Offline
      </span>
    );
  }
  return null;
}
