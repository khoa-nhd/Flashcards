/**
 * Streak freezes and the seven-day check-in (docs/gamification-plan.md, 1.5
 * and 1.6). A freeze covers one missed day so the streak carries on over it;
 * the covered day joins the run without adding to its length.
 */
import { addDays, compareDates, type IsoDate } from '../dates.js';

export const FREEZE_MAX = 2;
/** A freeze is given at every multiple of this many days of streak. */
export const FREEZE_EVERY = 7;

export interface Freeze {
  id: string;
  grantedOn: IsoDate;
  usedOn: IsoDate | null;
}

/**
 * The days missed since the last met (or already covered) day, up to
 * yesterday, when the freezes held can cover all of them; otherwise none: a
 * streak that is lost anyway keeps its freezes for the next one.
 */
export function daysToCover(
  metDays: readonly IsoDate[],
  covered: readonly IsoDate[],
  held: number,
  today: IsoDate,
): IsoDate[] {
  const kept = [...metDays, ...covered].filter((day) => compareDates(day, today) < 0).sort(compareDates);
  const last = kept.at(-1);
  if (last === undefined || held <= 0) return [];
  const gap: IsoDate[] = [];
  for (let day = addDays(last, 1); compareDates(day, today) < 0; day = addDays(day, 1)) gap.push(day);
  return gap.length > 0 && gap.length <= held ? gap : [];
}

/** XP for each day of the check-in cycle, day 1 to day 7. */
export const CHECKIN_XP = [10, 15, 20, 25, 30, 40, 100] as const;

/** The cycle's day after a day with any study: one more after yesterday, otherwise back to 1. */
export function nextCheckinDay(previous: { day: number; lastOn: IsoDate | null }, today: IsoDate): number {
  if (previous.lastOn !== null && addDays(previous.lastOn, 1) === today) {
    return (previous.day % CHECKIN_XP.length) + 1;
  }
  return 1;
}
