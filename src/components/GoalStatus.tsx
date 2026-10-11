import type { DayPlanResponse } from '../../shared/api.js';
import { useApp } from '../app-context.js';
import { useRemote, type Remote } from '../hooks/useRemote.js';
import { count, formatDuration } from '../lib/format.js';

/** The day's plan is loaded by whoever shows it, so their Refresh can re-read it. */
export function useDayPlan(): Remote<DayPlanResponse> & { reload(): void } {
  const { api } = useApp();
  return useRemote(api.fetchPlan, 'Could not load your daily goal.');
}

export const hasGoal = (plan: DayPlanResponse): boolean => plan.reviews !== null || plan.time !== null;

/**
 * What the figures mean for the rest of the day, in a sentence or two. A goal
 * that is reached, or smaller than the workload, never removes a word: the
 * text says the rest stay due.
 */
export function goalMessage(plan: DayPlanResponse): string {
  const due = plan.due.total;
  const are = due === 1 ? 'is' : 'are';
  const estimate = plan.estimatedDueMs !== null && due > 0 ? `, about ${formatDuration(plan.estimatedDueMs)}` : '';

  if (plan.met === true) {
    if (due === 0) return 'Reached today. Nothing else is due.';
    return `Reached today. ${count(due, 'word')} ${are} still due${estimate}; ${due === 1 ? 'it stays' : 'they stay'} in the queue.`;
  }

  let toGo: string;
  if (plan.cardsToGoal !== null) {
    // A count of reviews is exact; one worked out from time at the reviewer's pace is an estimate.
    const exact = plan.time === null || plan.time.met;
    toGo = `${exact ? '' : 'About '}${count(plan.cardsToGoal, 'more answer')} to reach it.`;
  } else if (plan.time !== null) {
    toGo = `${formatDuration(plan.time.remaining)} of review time to go.`;
  } else {
    toGo = '';
  }

  if (due === 0) return `${toGo} Nothing is due right now.`.trim();
  if (plan.beyondGoal !== null && plan.beyondGoal > 0) {
    return `${toGo} ${count(due, 'word')} ${are} due${estimate}: more than the goal asks for. The rest stay due.`.trim();
  }
  return `${toGo} ${count(due, 'word')} ${are} due${estimate}.`.trim();
}

function Bar({ name, text, done, target }: { name: string; text: string; done: number; target: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="tabular-nums">{text}</span>
        {done >= target && <span className="text-xs font-medium text-good-ink">Reached</span>}
      </div>
      <div
        role="progressbar"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(done, target)}
        aria-valuetext={text}
        className="mt-1 h-2 overflow-hidden rounded-full bg-accent-soft"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (done / target) * 100)}%` }} />
      </div>
    </div>
  );
}

/** Progress towards today's goal. Renders nothing when no goal is set. */
export function GoalProgress({ plan }: { plan: DayPlanResponse }) {
  if (!hasGoal(plan)) return null;
  return (
    <div role="group" aria-label="Daily goal" className="flex flex-col gap-2">
      <p className="text-sm font-semibold tracking-tight">Daily goal</p>
      {plan.reviews !== null && (
        <Bar
          name="Reviews towards today’s goal"
          text={`${plan.reviews.done} of ${count(plan.reviews.target, 'review')}`}
          done={plan.reviews.done}
          target={plan.reviews.target}
        />
      )}
      {plan.time !== null && (
        <Bar
          name="Time towards today’s goal"
          text={`${formatDuration(plan.time.done)} of ${plan.time.target / 60_000} min`}
          done={plan.time.done}
          target={plan.time.target}
        />
      )}
      <p className="text-xs text-muted">{goalMessage(plan)}</p>
    </div>
  );
}
