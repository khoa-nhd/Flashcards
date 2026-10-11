import { EXPORT_FORMAT, EXPORT_VERSION, type AccountExport, type ExportedWord } from '../shared/export-format.js';
import type { SchedulerId } from '../shared/scheduler/active.js';
import type { DailyGoal } from '../shared/session-planner.js';
import type { LibraryService } from './library-service.js';
import type { EntryData, VocabularyCatalog } from './vocabulary-catalog.js';
import type { VocabularyRepository } from './vocabulary-repository.js';

export interface ExportServiceOptions {
  repository: VocabularyRepository;
  catalog: VocabularyCatalog;
  library: LibraryService;
  /** The account's settings as they stand for this request. */
  settings: () => { timeZone: string; dailyGoal: DailyGoal; fsrsRetention: number | null; scheduler: SchedulerId };
  now?: () => Date;
}

/**
 * Everything one account can read about itself, in one document. Reads only:
 * nothing is changed, and nothing of any other account can be reached, because
 * every read goes through the same per-account stores as the rest of the app.
 */
export class ExportService {
  constructor(private readonly options: ExportServiceOptions) {}

  async exportAccount(): Promise<AccountExport> {
    const { repository, catalog, library, settings } = this.options;
    const [{ entries }, trashed, schedules, organised, reviewHistory] = await Promise.all([
      catalog.listEntries(),
      catalog.listTrashed(),
      repository.listSchedules(),
      library.load(),
      repository.listHistory(),
    ]);

    const fsrs = new Map(schedules.map((card) => [card.id, card.fsrs]));
    const toWord = (entry: EntryData, inTrash: boolean): ExportedWord => ({
      id: entry.id,
      word: entry.word,
      meaning: entry.meaning,
      definition: entry.definition,
      example: entry.example,
      dateAdded: entry.dateAdded,
      createdAt: entry.createdTime,
      updatedAt: entry.lastEditedTime,
      mastery: entry.mastery,
      reviewDate: entry.reviewDate,
      fsrs: fsrs.get(entry.id) ?? null,
      inTrash,
    });

    const current = settings();
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      settings: {
        timeZone: current.timeZone,
        dailyGoal: current.dailyGoal,
        fsrsRequestRetention: current.fsrsRetention,
        scheduler: current.scheduler,
      },
      counts: {
        words: entries.length,
        wordsInTrash: trashed.length,
        collections: organised.collections.length,
        examples: organised.examples.length,
        relations: organised.relations.length,
        historyEvents: reviewHistory.length,
      },
      vocabulary: [...entries.map((entry) => toWord(entry, false)), ...trashed.map((entry) => toWord(entry, true))],
      collections: organised.collections,
      examples: organised.examples,
      relations: organised.relations,
      reviewHistory,
    };
  }
}
