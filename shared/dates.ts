/**
 * Calendar-date helpers. Review scheduling works on whole calendar days, so
 * dates are carried as `YYYY-MM-DD` strings and never as local `Date` objects
 * (which would drag the server's own time zone into the comparison).
 */
export type IsoDate = string;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_PREFIX = /^\d{4}-\d{2}-\d{2}T/;
const HAS_UTC_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

export function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!isIsoDate(date)) throw new RangeError(`Invalid calendar date: ${String(date)}`);
  if (!Number.isInteger(days)) throw new RangeError(`Day offset must be a whole number: ${days}`);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Negative when `a` is earlier than `b`. ISO dates sort lexicographically. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const toUtc = (value: IsoDate) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date an instant falls on in the given IANA time zone. */
export function calendarDateInTimeZone(instant: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Normalises a Notion date `start` value to a calendar date. Date-only values
 * pass through untouched; date-times are placed on the calendar of `timeZone`.
 * Anything else is rejected with `null` rather than guessed at.
 */
export function toCalendarDate(value: unknown, timeZone: string): IsoDate | null {
  if (typeof value !== 'string') return null;
  if (isIsoDate(value)) return value;
  if (!ISO_DATETIME_PREFIX.test(value)) return null;
  if (!HAS_UTC_OFFSET.test(value)) {
    // A wall-clock time with no offset already names its own calendar day.
    const datePart = value.slice(0, 10);
    return isIsoDate(datePart) ? datePart : null;
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  return calendarDateInTimeZone(instant, timeZone);
}
