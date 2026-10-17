/**
 * The assistant bubble's wait: a spinner plus one rotating line at a time,
 * drawn from the seeded thinking engine — stages, phrasing or trivia,
 * flavored by a persona, with matched emoji now and then. The rotating part
 * is hidden from screen readers; the stable label below it is what assistive
 * tech reads. Reduced motion freezes the first pick for the whole wait.
 *
 * `streaming` switches the layout from the empty bubble's comfortable line
 * to a one-line row above the arriving reply (trivia hands over to phrasing
 * there — see the engine).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion.js';
import { STAGE_ORDER } from '../lib/thinking-content.js';
import { createThinkingSession, seedFromString, type ThinkingItem } from '../lib/thinking-engine.js';
import { Spinner } from './Spinner.js';

function Line({ item }: { item: ThinkingItem }) {
  return (
    <>
      {item.kind === 'emoji' ? (
        <span className="text-lg leading-none">{item.text}</span>
      ) : (
        <>
          {item.kind === 'trivia' && <span className="mr-1">💡</span>}
          <span className={item.kind === 'trivia' ? 'italic' : ''}>{item.text}</span>
        </>
      )}
      {item.emoji !== null && <span className="ml-1 text-base leading-none">{item.emoji}</span>}
    </>
  );
}

function StageDots({ stage }: { stage: number }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {STAGE_ORDER.map((id, index) => (
        <span key={id} className={`size-1 rounded-full ${index <= stage ? 'bg-accent' : 'bg-line'}`} />
      ))}
    </span>
  );
}

export function ThinkingIndicator({ messageId, streaming }: { messageId: string; streaming: boolean }) {
  const reducedMotion = useReducedMotion();
  const session = useMemo(
    () => createThinkingSession({ seed: seedFromString(messageId), reducedMotion }),
    [messageId, reducedMotion],
  );
  const startedAt = useRef<number | null>(null);
  const [item, setItem] = useState<ThinkingItem>(() => session.at(0, { streaming: false }));

  // Step to the next line when its dwell time is up; a phase change steps now.
  useEffect(() => {
    if (startedAt.current === null) startedAt.current = Date.now();
    const start = startedAt.current;
    let timer: number | undefined;
    const tick = () => {
      const next = session.at(Date.now() - start, { streaming });
      setItem(next);
      timer = window.setTimeout(tick, next.dwellMs);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [session, streaming]);

  const label = <span className="sr-only">Assistant is thinking</span>;

  if (streaming) {
    return (
      <span
        className="mb-1.5 flex h-6 min-w-0 items-center gap-2 text-xs text-muted"
        data-testid="thinking-indicator"
        data-phase="streaming"
      >
        {label}
        <span aria-hidden="true" className="flex min-w-0 items-center gap-2">
          <Spinner className="size-3.5" />
          {item.stage !== null && <StageDots stage={item.stage} />}
          <span key={item.key} className="thinking-swap block min-w-0 truncate" data-testid="thinking-line">
            <Line item={item} />
          </span>
        </span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2 text-muted" data-testid="thinking-indicator" data-phase="waiting">
      {label}
      <span aria-hidden="true" className="flex min-w-0 items-center gap-2">
        <Spinner />
        {item.stage !== null && <StageDots stage={item.stage} />}
        <span key={item.key} className="thinking-swap min-w-0 leading-snug" data-testid="thinking-line">
          <Line item={item} />
        </span>
      </span>
    </span>
  );
}
