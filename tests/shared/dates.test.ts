import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDateInTimeZone,
  compareDates,
  daysBetween,
  isIsoDate,
  isValidTimeZone,
  toCalendarDate,
} from '../../shared/dates.js';

describe('isIsoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isIsoDate('2026-10-09')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-10-9')).toBe(false);
    expect(isIsoDate('2026-10-09T00:00:00Z')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20261009)).toBe(false);
  });
});

describe('addDays', () => {
  it('moves forward and backward across month, year and leap boundaries', () => {
    expect(addDays('2026-10-09', 1)).toBe('2026-10-10');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-09', 0)).toBe('2026-10-09');
  });

  it('rejects invalid input instead of producing a wrong date', () => {
    expect(() => addDays('not-a-date', 1)).toThrow(RangeError);
    expect(() => addDays('2026-10-09', 1.5)).toThrow(RangeError);
  });
});

describe('comparisons', () => {
  it('orders dates and counts whole days', () => {
    expect(compareDates('2026-10-08', '2026-10-09')).toBeLessThan(0);
    expect(compareDates('2026-10-09', '2026-10-09')).toBe(0);
    expect(compareDates('2027-01-01', '2026-12-31')).toBeGreaterThan(0);
    expect(daysBetween('2026-10-02', '2026-10-09')).toBe(7);
    expect(daysBetween('2026-10-09', '2026-10-02')).toBe(-7);
  });
});

describe('time zones', () => {
  it('finds the calendar day an instant falls on in a zone', () => {
    const lateEveningUtc = new Date('2026-10-09T18:30:00Z');
    expect(calendarDateInTimeZone(lateEveningUtc, 'UTC')).toBe('2026-10-09');
    // 18:30 UTC is already 01:30 the next day in UTC+7.
    expect(calendarDateInTimeZone(lateEveningUtc, 'Asia/Ho_Chi_Minh')).toBe('2026-10-10');
    expect(calendarDateInTimeZone(lateEveningUtc, 'America/Los_Angeles')).toBe('2026-10-09');
  });

  it('validates zone names', () => {
    expect(isValidTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('toCalendarDate', () => {
  it('passes date-only values through unchanged', () => {
    expect(toCalendarDate('2026-10-09', 'Asia/Ho_Chi_Minh')).toBe('2026-10-09');
  });

  it('places a date-time on the calendar of the review time zone', () => {
    expect(toCalendarDate('2026-10-09T23:30:00.000+07:00', 'Asia/Ho_Chi_Minh')).toBe('2026-10-09');
    expect(toCalendarDate('2026-10-09T23:30:00.000+07:00', 'UTC')).toBe('2026-10-09');
    expect(toCalendarDate('2026-10-09T20:00:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('2026-10-10');
  });

  it('keeps the wall-clock day of a date-time that has no offset', () => {
    expect(toCalendarDate('2026-10-09T23:30:00', 'America/Los_Angeles')).toBe('2026-10-09');
  });

  it('returns null for anything unreadable', () => {
    expect(toCalendarDate('next tuesday', 'UTC')).toBeNull();
    expect(toCalendarDate('2026-02-30', 'UTC')).toBeNull();
    expect(toCalendarDate('', 'UTC')).toBeNull();
    expect(toCalendarDate(null, 'UTC')).toBeNull();
    expect(toCalendarDate(undefined, 'UTC')).toBeNull();
  });
});
