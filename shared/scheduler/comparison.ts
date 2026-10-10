/**
 * Puts the two schedules side by side: for each word that has an FSRS state,
 * when the mastery schedule would show it next and when FSRS would, and how
 * many reviews each would ask for on each of the coming days.
 *
 * It only reads. Nothing here changes a due date, and a word FSRS has not seen
 * yet is left out of the comparison rather than given a made-up date.
 */
import { addDays, compareDates, daysBetween, type IsoDate } from '../dates.js';
import { fsrsDueDay, type FsrsState } from './fsrs.js';

export interface ScheduleCard {
  id: string;
  word: string;
  mastery: number;
  /** The mastery schedule's next review day; empty means due now. */
  reviewDate: IsoDate | null;
  fsrs: FsrsState | null;
}

export interface ComparedCard {
  id: string;
  word: string;
  mastery: number;
  /** `null` when the mastery schedule has retired the word and will not show it again. */
  legacyDue: IsoDate | null;
  fsrsDue: IsoDate;
  fsrsIntervalDays: number;
  /** FSRS day minus mastery-schedule day: positive means FSRS waits longer. `null` when there is no mastery date. */
  differenceDays: number | null;
}

export interface WorkloadDay {
  date: IsoDate;
  legacy: number;
  fsrs: number;
}

export interface ScheduleComparison {
  totalCards: number;
  /** Words with an FSRS state; only these can be compared. */
  comparable: number;
  cards: ComparedCard[];
  /** Reviews falling due per day among comparable words. Anything already overdue counts on the first day. */
  workload: WorkloadDay[];
}

export interface ComparisonOptions {
  /** Mastery at which the mastery schedule stops showing a word. */
  retiredAtMastery: number;
  days?: number;
  limit?: number;
}

export function compareSchedules(
  cards: readonly ScheduleCard[],
  today: IsoDate,
  timeZone: string,
  { retiredAtMastery, days = 14, limit = 200 }: ComparisonOptions,
): ScheduleComparison {
  const compared: ComparedCard[] = [];
  for (const card of cards) {
    if (card.fsrs === null) continue;
    const fsrsDue = fsrsDueDay(card.fsrs, timeZone);
    const retired = card.mastery >= retiredAtMastery;
    // A word with no review date is due at once under the mastery schedule.
    const legacyDue = retired ? null : (card.reviewDate ?? today);
    compared.push({
      id: card.id,
      word: card.word,
      mastery: card.mastery,
      legacyDue,
      fsrsDue,
      fsrsIntervalDays: card.fsrs.scheduledDays,
      differenceDays: legacyDue === null ? null : daysBetween(legacyDue, fsrsDue),
    });
  }
  compared.sort((a, b) => compareDates(a.fsrsDue, b.fsrsDue) || a.word.localeCompare(b.word));

  const last = addDays(today, days - 1);
  const workload: WorkloadDay[] = Array.from({ length: days }, (_, offset) => ({
    date: addDays(today, offset),
    legacy: 0,
    fsrs: 0,
  }));
  const dayOf = (due: IsoDate): WorkloadDay | undefined => {
    if (compareDates(due, last) > 0) return undefined;
    return workload[Math.max(0, daysBetween(today, due))];
  };
  for (const card of compared) {
    const fsrsDay = dayOf(card.fsrsDue);
    if (fsrsDay) fsrsDay.fsrs += 1;
    const legacyDay = card.legacyDue === null ? undefined : dayOf(card.legacyDue);
    if (legacyDay) legacyDay.legacy += 1;
  }

  return { totalCards: cards.length, comparable: compared.length, cards: compared.slice(0, limit), workload };
}
