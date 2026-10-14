import { useEffect, useState } from 'react';
import { useMutationQueue } from '../app-context.js';
import { Icon } from './Icon.js';

/** A subtle sync status indicator for the header. */
export function SyncStatus() {
  const queue = useMutationQueue();
  const [status, setStatus] = useState<{ pending: number; syncing: boolean; hasErrors: boolean }>({
    pending: 0,
    syncing: false,
    hasErrors: false,
  });

  useEffect(() => {
    let current = true;
    const update = async () => {
      const all = await queue.getAll();
      const pending = all.filter((m) => m.status === 'pending' || m.status === 'transient' || m.status === 'syncing').length;
      const syncing = queue.isSyncing();
      const hasErrors = all.some((m) => m.status === 'permanent');
      if (current) setStatus({ pending, syncing, hasErrors });
    };
    update();
    const unsubscribe = queue.subscribe(update);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [queue]);

  if (status.pending === 0 && !status.syncing && !status.hasErrors) return null;

  return (
    <div className="flex items-center gap-1.5" title={status.hasErrors ? 'Some changes could not be saved' : status.syncing ? 'Syncing...' : `${status.pending} change${status.pending === 1 ? '' : 's'} pending`}>
      {status.syncing && <Icon name="sync" className="size-4 text-accent animate-spin" />}
      {status.hasErrors && !status.syncing && <Icon name="alertTriangle" className="size-4 text-bad" />}
      {status.pending > 0 && !status.syncing && !status.hasErrors && <Icon name="clock" className="size-4 text-muted" />}
      <span className="text-xs font-medium text-muted">
        {status.syncing
          ? 'Syncing...'
          : status.hasErrors
            ? 'Sync failed'
            : `${status.pending} pending`}
      </span>
    </div>
  );
}

/** A more detailed sync panel for when the user wants to see what's pending. */
export function SyncPanel() {
  const queue = useMutationQueue();
  const [mutations, setMutations] = useState<Array<{ id: string; kind: string; status: string; error: string | null }>>([]);

  useEffect(() => {
    let current = true;
    const update = async () => {
      const all = await queue.getAll();
      if (current) {
        setMutations(
          all
            .filter((m) => m.status !== 'synced')
            .map((m) => ({
              id: m.id,
              kind: m.kind,
              status: m.status,
              error: m.lastError,
            })),
        );
      }
    };
    update();
    const unsubscribe = queue.subscribe(update);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [queue]);

  if (mutations.length === 0) return null;

  return (
    <details className="rounded-xl border border-line bg-surface p-3">
      <summary className="flex items-center gap-2 cursor-pointer font-medium text-sm">
        <Icon name="database" className="size-4" />
        Sync status ({mutations.length} pending)
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5 text-xs">
        {mutations.map((m) => (
          <li key={m.id} className="flex items-center gap-2 text-muted">
            <span className="font-mono">{m.kind}</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              m.status === 'pending' ? 'bg-muted/20' :
              m.status === 'syncing' ? 'bg-accent-soft text-accent' :
              m.status === 'transient' ? 'bg-warn-soft text-warn-ink' :
              'bg-bad-soft text-bad-ink'
            }`}>
              {m.status}
            </span>
            {m.error && <span className="truncate max-w-xs text-bad-ink">{m.error}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}