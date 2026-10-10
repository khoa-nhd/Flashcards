import { Link } from './Link.js';

export interface StatTileProps {
  label: string;
  /** A count, or ready-made text such as a percentage or a duration. */
  value: number | string;
  /** A short clarification of what is counted. */
  hint?: string;
  /** Where the number can be explored, if anywhere. */
  to?: string;
  /** Draws attention to a count that needs action when it is above zero. */
  emphasis?: 'accent' | 'bad' | null;
}

const numberFormat = new Intl.NumberFormat();

/** One headline number. The value is plain text; colour only ever sits beside it. */
export function StatTile({ label, value, hint, to, emphasis = null }: StatTileProps) {
  const marked = emphasis !== null && typeof value === 'number' && value > 0;
  const body = (
    <>
      <div className="flex items-center gap-2 text-sm text-muted">
        {marked && (
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${emphasis === 'bad' ? 'bg-bad' : 'bg-accent'}`}
          />
        )}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-3xl font-semibold tracking-tight text-ink">
        {typeof value === 'number' ? numberFormat.format(value) : value}
      </div>
      {hint !== undefined && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </>
  );

  const frame = 'block rounded-2xl border border-line bg-surface p-4';
  return to === undefined ? (
    <div className={frame}>{body}</div>
  ) : (
    <Link to={to} className={`${frame} transition hover:border-muted`}>
      {body}
    </Link>
  );
}
