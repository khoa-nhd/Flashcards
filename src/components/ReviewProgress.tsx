export interface ReviewProgressProps {
  /** Cards already answered or skipped in this session. */
  done: number;
  total: number;
}

export function ReviewProgress({ done, total }: ReviewProgressProps) {
  const position = Math.min(done + 1, total);
  const remaining = total - done;
  const percent = total === 0 ? 0 : (done / total) * 100;

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="font-semibold tabular-nums" aria-label={`Card ${position} of ${total}`}>
        {position} / {total}
      </span>
      <div
        role="progressbar"
        aria-label="Session progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-muted tabular-nums">{remaining} left</span>
    </div>
  );
}
