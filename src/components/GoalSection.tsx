import { useState, type FormEvent } from 'react';
import type { DayPlanResponse } from '../../shared/api.js';
import { GOAL_LIMITS, GOAL_MINUTE_PRESETS, goalProblem, type DailyGoal } from '../../shared/session-planner.js';
import { useApp } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { GoalProgress, useDayPlan } from './GoalStatus.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, FIELD_ERROR, HELP, INPUT, SECTION_TITLE } from './ui.js';

/** An empty box means "no goal of this kind"; anything else has to be a whole number. */
function parsePart(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 'invalid';
}

const asText = (value: number | null) => (value === null ? '' : String(value));

/** The daily goal: how many reviews, how many minutes, either or both. Kept with the account. */
export function GoalSection() {
  const loaded = useDayPlan();

  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`} aria-labelledby="goal-section-title">
      <h2 id="goal-section-title" className={SECTION_TITLE}>
        Daily goal
      </h2>
      <p className="text-sm">
        A target to measure each day against. It never hides or postpones a word: everything that is due stays due, and
        your review schedule is not changed by it.
      </p>

      {loaded.status === 'loading' && (
        <p role="status" className="text-sm text-muted">
          Loading…
        </p>
      )}
      {loaded.status === 'failed' && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-bad-ink">
            {loaded.error}
          </p>
          <button type="button" className={BUTTON_SECONDARY} onClick={loaded.reload}>
            Try again
          </button>
        </div>
      )}
      {loaded.status === 'ready' &&
        (loaded.data.available ? (
          <GoalForm initial={loaded.data} />
        ) : (
          <p className={HELP}>A daily goal can be kept once the database has its latest update.</p>
        ))}
    </section>
  );
}

/** The form, started from what is stored. Shown only once that has been read. */
function GoalForm({ initial }: { initial: DayPlanResponse }) {
  const { api, toasts } = useApp();
  const [plan, setPlan] = useState(initial);
  const [reviews, setReviews] = useState(asText(initial.goal.reviews));
  const [minutes, setMinutes] = useState(asText(initial.goal.minutes));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (goal: DailyGoal) => {
    const problem = goalProblem(goal);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveGoal(goal);
      setPlan(next);
      setReviews(asText(next.goal.reviews));
      setMinutes(asText(next.goal.minutes));
      toasts.show({
        message: next.goal.reviews === null && next.goal.minutes === null ? 'Daily goal cleared.' : 'Daily goal saved.',
      });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not save the goal.');
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = { reviews: parsePart(reviews), minutes: parsePart(minutes) };
    if (parsed.reviews === 'invalid' || parsed.minutes === 'invalid') {
      setError('Enter whole numbers, or leave a box empty for no goal of that kind.');
      return;
    }
    void save({ reviews: parsed.reviews, minutes: parsed.minutes });
  };

  return (
    <>
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="goal-reviews" className="text-sm font-medium">
              Reviews per day
            </label>
            <input
              id="goal-reviews"
              className={INPUT}
              inputMode="numeric"
              autoComplete="off"
              placeholder="No goal"
              value={reviews}
              disabled={saving}
              aria-describedby="goal-reviews-help"
              onChange={(event) => setReviews(event.target.value)}
            />
            <p id="goal-reviews-help" className={HELP}>
              Answers saved in a day, from {GOAL_LIMITS.reviews.min} to {GOAL_LIMITS.reviews.max}. Empty for none.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="goal-minutes" className="text-sm font-medium">
              Minutes per day
            </label>
            <input
              id="goal-minutes"
              className={INPUT}
              inputMode="numeric"
              autoComplete="off"
              placeholder="No goal"
              value={minutes}
              disabled={saving}
              aria-describedby="goal-minutes-help"
              onChange={(event) => setMinutes(event.target.value)}
            />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common time goals">
              {GOAL_MINUTE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={saving}
                  aria-pressed={minutes.trim() === String(preset)}
                  onClick={() => setMinutes(String(preset))}
                  className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                    minutes.trim() === String(preset)
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line bg-surface text-muted hover:text-ink'
                  }`}
                >
                  {preset} min
                </button>
              ))}
            </div>
            <p id="goal-minutes-help" className={HELP}>
              Time on cards in a day, from {GOAL_LIMITS.minutes.min} to {GOAL_LIMITS.minutes.max}. Empty for none.
            </p>
          </div>
        </div>
        <p className={HELP}>With both set, the goal is reached when both are.</p>
        {error !== null && (
          <p role="alert" className={FIELD_ERROR}>
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={BUTTON_PRIMARY} disabled={saving}>
            {saving ? 'Saving…' : 'Save goal'}
          </button>
          {(plan.goal.reviews !== null || plan.goal.minutes !== null) && (
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={saving}
              onClick={() => void save({ reviews: null, minutes: null })}
            >
              Clear goal
            </button>
          )}
        </div>
      </form>
      <GoalProgress plan={plan} />
    </>
  );
}
