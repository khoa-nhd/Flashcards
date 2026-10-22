import type { MemoryStrength, VocabularyEntry } from '../../shared/api.js';
import { daysBetween, type IsoDate } from '../../shared/dates.js';
import { pick, type UiLanguage } from '../lib/i18n.js';
import type { ReviewStatus } from '../../shared/vocabulary.js';
import { missingFields, MISSING_LABELS } from '../lib/bank-query.js';
import { Icon } from './Icon.js';

const STATUS_TEXT: Record<ReviewStatus, string> = {
  mastered: 'Mastered',
  overdue: 'Overdue',
  due_today: 'Due today',
  unscheduled: 'No review date',
  upcoming: 'Upcoming',
  invalid: 'Needs a mastery',
  new: 'New',
  suspended: 'Archived',
};

/* State reads in stroke and weight; colour is kept for answers, not labels. */
const STATUS_TONE: Record<ReviewStatus, string> = {
  mastered: 'border border-line-strong text-muted',
  overdue: 'border border-line-strong text-ink',
  due_today: 'border border-accent/50 text-accent',
  unscheduled: 'border border-line text-faint',
  upcoming: 'border border-line text-faint',
  invalid: 'border border-line-strong text-ink',
  new: 'border border-line text-ink',
  suspended: 'border border-line text-faint',
};

/** Where a word stands in the review cycle, always as words and never as colour alone. */
export function StatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {STATUS_TEXT[status]}
    </span>
  );
}

export function MasteryPill({ mastery }: { mastery: number | null }) {
  return (
    <span className="inline-flex min-w-7 justify-center rounded-full border border-line bg-paper px-2 py-0.5 text-xs font-semibold tabular-nums text-ink">
      {mastery === null ? '–' : mastery}
      <span className="sr-only">{mastery === null ? ' no mastery' : ' of 10 mastery'}</span>
    </span>
  );
}

const STRENGTH_TONE: Record<MemoryStrength['label'], string> = {
  New: 'border-line text-muted',
  Learning: 'border-line-strong text-ink',
  Familiar: 'border-accent/35 bg-accent-soft/50 text-accent',
  Strong: 'border-accent/50 bg-accent-soft text-accent',
  Master: 'border-accent bg-accent text-on-accent',
};

const STRENGTH_TITLE = {
  vi: 'Ước lượng sức nhớ từ FSRS. Chỉ số này không quyết định ngày ôn.',
  en: 'Estimated from FSRS. This index never decides when a word is due.',
} as const;

/**
 * Memory strength, the display-only scale derived from FSRS stability. It is
 * shown wherever a word has FSRS state; older mastery-era data keeps MasteryPill.
 */
export function StrengthPill({
  memory,
  compact = false,
  needsReview = false,
  language = 'en',
  className = '',
}: {
  memory: Pick<MemoryStrength, 'level' | 'label'>;
  /** The level and band without the "Sức nhớ" prefix, for dense tables. */
  compact?: boolean;
  /** A quiet arrow after a drop in strength; never a warning colour. */
  needsReview?: boolean;
  language?: UiLanguage;
  className?: string;
}) {
  const prefix = pick(language, 'Memory strength', 'Sức nhớ');
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}
      title={`${pick(language, prefix, prefix)} ${memory.level}/10 · ${memory.label}. ${STRENGTH_TITLE[language]}`}
    >
      <span
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${STRENGTH_TONE[memory.label]}`}
      >
        <span className="sr-only">{prefix} </span>
        <span>
          {memory.level}/10{!compact && ` · ${memory.label}`}
        </span>
        {compact && <span className="font-medium">{memory.label}</span>}
      </span>
      {needsReview && (
        <span className="whitespace-nowrap text-[0.6875rem] font-medium text-muted">
          <span aria-hidden="true">↓ </span>
          {pick(language, 'needs review', 'cần ôn lại')}
        </span>
      )}
    </span>
  );
}

/** Ten quiet segments for the detail panel: one filled per strength level. */
export function StrengthMeter({ memory, language = 'en' }: { memory: Pick<MemoryStrength, 'level' | 'percent'>; language?: UiLanguage }) {
  return (
    <div
      role="meter"
      aria-label={pick(language, 'Memory strength', 'Sức nhớ')}
      aria-valuemin={1}
      aria-valuemax={10}
      aria-valuenow={memory.level}
      className="flex gap-1"
    >
      {Array.from({ length: 10 }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={`h-1.5 flex-1 rounded-full ${index < memory.level ? 'bg-accent' : 'bg-line-strong'}`}
        />
      ))}
    </div>
  );
}

/** A quiet marker for a word whose descriptive fields are incomplete. It never blocks reviewing. */
export function QualityFlag({ entry }: { entry: VocabularyEntry }) {
  const missing = missingFields(entry);
  if (missing.length === 0) return null;
  const text = missing.map((key) => MISSING_LABELS[key]).join(', ');
  return (
    <span title={text} className="inline-flex shrink-0 items-center text-warn-ink">
      <Icon name="warning" className="size-4" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A calendar day as readable text. Formatted in UTC so the day shown is the day stored. */
export function formatDate(date: IsoDate | null, style: 'full' | 'short' = 'full'): string {
  if (date === null) return '—';
  const value = new Date(`${date}T00:00:00Z`);
  return (style === 'full' ? dateFormat : shortDateFormat).format(value);
}

/** A review date relative to today: "today", "in 3 days", "2 days ago". */
export function relativeDay(date: IsoDate | null, today: IsoDate | null): string | null {
  if (date === null || today === null) return null;
  const days = daysBetween(today, date);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
