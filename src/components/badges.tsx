import type { VocabularyEntry } from '../../shared/api.js';
import { daysBetween, type IsoDate } from '../../shared/dates.js';
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
};

/* State reads in stroke and weight; colour is kept for answers, not labels. */
const STATUS_TONE: Record<ReviewStatus, string> = {
  mastered: 'border border-line-strong text-muted',
  overdue: 'border border-line-strong text-ink',
  due_today: 'border border-accent/50 text-accent',
  unscheduled: 'border border-line text-faint',
  upcoming: 'border border-line text-faint',
  invalid: 'border border-line-strong text-ink',
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
