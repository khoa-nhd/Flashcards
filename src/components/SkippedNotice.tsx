import type { SkippedRecord } from '../../shared/api.js';

/** Lists records the queue could not use, so a data problem is visible instead of silent. */
export function SkippedNotice({ skipped }: { skipped: SkippedRecord[] }) {
  if (skipped.length === 0) return null;
  return (
    <details className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink">
      <summary className="cursor-pointer font-medium">
        {skipped.length} {skipped.length === 1 ? 'record was' : 'records were'} left out of this queue
      </summary>
      <ul className="mt-2 space-y-1">
        {skipped.map((record) => (
          <li key={record.id}>
            <span className="font-medium">{record.word ?? 'Untitled'}</span> — {record.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}
