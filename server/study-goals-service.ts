/**
 * The two daily goals and the streak, under FSRS as the only schedule. Reads
 * the day's answers and what is still due, and records how the day stands so
 * the streak can be counted later. Nothing here selects, hides or reschedules
 * a card: the goals only decide the streak.
 */
import type { StudyGoalsResponse } from '../shared/api.js';
import { calendarDateInTimeZone, compareDates, type IsoDate } from '../shared/dates.js';
import { fsrsDueDay } from '../shared/scheduler/fsrs.js';
import {
  SUGGESTED_STUDY_GOALS,
  evaluateDay,
  streakOf,
  studyGoalsProblem,
  type StudyGoals,
} from '../shared/study-goals.js';
import { HttpError } from './errors.js';
import type { VocabularyRepository } from './vocabulary-repository.js';

/** Where the account keeps its two goals. `get` is `null` until they are chosen. */
export interface StudyGoalStore {
  readonly available: boolean;
  get(): StudyGoals | null;
  save(goals: StudyGoals): Promise<StudyGoals>;
}

/** Goals kept in memory, saved through `persist` where there is somewhere to keep them. */
export function createStudyGoalStore(
  initial: StudyGoals | null = null,
  persist: (goals: StudyGoals) => Promise<StudyGoals> = async (goals) => goals,
): StudyGoalStore {
  let current = initial;
  return {
    available: true,
    get: () => current,
    async save(goals) {
      current = await persist(goals);
      return current;
    },
  };
}

export interface StudyGoalsServiceOptions {
  repository: VocabularyRepository;
  store: StudyGoalStore;
  timeZone: string;
  now?: () => Date;
}

export class StudyGoalsService {
  private readonly now: () => Date;

  constructor(private readonly options: StudyGoalsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private today(): IsoDate {
    return calendarDateInTimeZone(this.now(), this.options.timeZone);
  }

  /** Where today stands, recorded so a met day keeps counting towards the streak. */
  async progress(): Promise<StudyGoalsResponse> {
    const { repository, store, timeZone } = this.options;
    const today = this.today();
    const available = repository.capabilities.fsrsOnly && store.available;
    const chosen = store.get();
    const goals = chosen ?? SUGGESTED_STUDY_GOALS;

    // What is still due, and what has never been studied; archived words count for neither.
    const { records } = await repository.listLiveRecords();
    let total = 0;
    let overdue = 0;
    let newLeft = 0;
    for (const record of records) {
      if (record.suspended === true) continue;
      const state = record.fsrs?.state ?? null;
      if (state === null) newLeft += 1;
      const due = state !== null ? fsrsDueDay(state, timeZone) : (record.dueOn ?? record.nextReview ?? today);
      const order = compareDates(due, today);
      // A word never studied is new, not a review: it counts towards the new-word goal instead.
      if (state !== null && order <= 0) total += 1;
      if (state !== null && order < 0) overdue += 1;
    }

    const counts =
      available && repository.studyDayCounts !== undefined
        ? await repository.studyDayCounts(today)
        : { newWords: 0, reviews: 0 };
    const day = evaluateDay({ goals, newDone: counts.newWords, reviewsDone: counts.reviews, dueLeft: total, newLeft });

    let metToday = day.met;
    let metDays: IsoDate[] = [];
    if (available && repository.recordStudyDay !== undefined && repository.listMetStudyDays !== undefined) {
      // Only a chosen pair of goals is held to; before that the day is only shown, never recorded.
      if (chosen !== null) {
        metToday = await repository.recordStudyDay({
          day: today,
          newWords: counts.newWords,
          reviews: counts.reviews,
          newGoal: goals.newWords,
          reviewGoal: goals.reviews,
          met: day.met,
        });
      }
      metDays = await repository.listMetStudyDays();
    }

    return {
      available,
      chosen: chosen !== null,
      today,
      timeZone,
      goals,
      newWords: day.newWords,
      reviews: day.reviews,
      due: { total, overdue },
      streak: streakOf(metDays, today, metToday),
    };
  }

  /** Changes the goals. Today is judged against the new ones; earlier days keep theirs. */
  async save(changes: Partial<StudyGoals>): Promise<StudyGoalsResponse> {
    const { repository, store } = this.options;
    if (!repository.capabilities.fsrsOnly || !store.available) {
      throw new HttpError(409, 'not_supported', 'Daily goals need the latest database update.');
    }
    const next: StudyGoals = { ...(store.get() ?? SUGGESTED_STUDY_GOALS), ...changes };
    const problem = studyGoalsProblem(next);
    if (problem !== null) throw new HttpError(400, 'invalid_request', problem);
    await store.save(next);
    return this.progress();
  }
}
