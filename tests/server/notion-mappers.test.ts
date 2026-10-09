import { describe, expect, it } from 'vitest';
import { mapPageToRecord, pageSchema, readDate, readNumber, readText } from '../../server/notion/notion-mappers.js';
import { TIME_ZONE, pageId } from '../helpers/fixtures.js';
import { TEST_FIELDS, TEST_PROPERTIES, notionPage, richText } from '../helpers/notion-fixtures.js';

const mapping = { properties: TEST_PROPERTIES, fields: TEST_FIELDS, timeZone: TIME_ZONE };
const map = (options: Parameters<typeof notionPage>[0]) => mapPageToRecord(pageSchema.parse(notionPage(options)), mapping);

describe('readText', () => {
  it('joins rich text fragments', () => {
    expect(readText({ type: 'rich_text', rich_text: richText('to make ', 'less severe') })).toEqual({
      ok: true,
      value: 'to make less severe',
    });
    expect(readText({ type: 'title', title: richText('alleviate') })).toEqual({ ok: true, value: 'alleviate' });
  });

  it('treats empty and whitespace-only values as missing', () => {
    expect(readText({ type: 'rich_text', rich_text: [] })).toEqual({ ok: true, value: null });
    expect(readText({ type: 'rich_text', rich_text: richText('   ') })).toEqual({ ok: true, value: null });
    expect(readText({ type: 'select', select: null })).toEqual({ ok: true, value: null });
    expect(readText({ type: 'url', url: null })).toEqual({ ok: true, value: null });
  });

  it('reads select, status, multi-select, url and number values', () => {
    expect(readText({ type: 'select', select: { name: 'verb' } })).toEqual({ ok: true, value: 'verb' });
    expect(readText({ type: 'status', status: { name: 'Learning' } })).toEqual({ ok: true, value: 'Learning' });
    expect(readText({ type: 'multi_select', multi_select: [{ name: 'B2' }, { name: 'formal' }] })).toEqual({
      ok: true,
      value: 'B2, formal',
    });
    expect(readText({ type: 'url', url: 'https://example.com' })).toEqual({ ok: true, value: 'https://example.com' });
    expect(readText({ type: 'number', number: 7 })).toEqual({ ok: true, value: '7' });
  });

  it('reads formula and rollup results', () => {
    expect(readText({ type: 'formula', formula: { type: 'string', string: 'shown text' } })).toEqual({
      ok: true,
      value: 'shown text',
    });
    // A "hide when mastered" style formula returns an empty string.
    expect(readText({ type: 'formula', formula: { type: 'string', string: '' } })).toEqual({ ok: true, value: null });
    expect(readText({ type: 'formula', formula: { type: 'string', string: null } })).toEqual({ ok: true, value: null });
    expect(
      readText({
        type: 'rollup',
        rollup: { type: 'array', array: [{ type: 'rich_text', rich_text: richText('one') }, { type: 'select', select: { name: 'two' } }] },
      }),
    ).toEqual({ ok: true, value: 'one, two' });
  });

  it('refuses types that are not text and missing properties', () => {
    expect(readText({ type: 'button', button: {} }).ok).toBe(false);
    expect(readText({ type: 'people', people: [] }).ok).toBe(false);
    expect(readText(undefined).ok).toBe(false);
    expect(readText({ type: 'rich_text', rich_text: 'not an array' }).ok).toBe(false);
  });
});

describe('readNumber', () => {
  it('reads numbers, including zero', () => {
    expect(readNumber({ type: 'number', number: 0 })).toEqual({ ok: true, value: 0 });
    expect(readNumber({ type: 'number', number: 10 })).toEqual({ ok: true, value: 10 });
    expect(readNumber({ type: 'number', number: null })).toEqual({ ok: true, value: null });
  });

  it('reads numeric formulas and rollups', () => {
    expect(readNumber({ type: 'formula', formula: { type: 'number', number: 4 } })).toEqual({ ok: true, value: 4 });
    expect(readNumber({ type: 'rollup', rollup: { type: 'number', number: 2, function: 'sum' } })).toEqual({
      ok: true,
      value: 2,
    });
  });

  it('rejects anything that is not a number', () => {
    expect(readNumber({ type: 'number', number: '5' }).ok).toBe(false);
    expect(readNumber({ type: 'formula', formula: { type: 'string', string: '5' } }).ok).toBe(false);
    expect(readNumber({ type: 'rich_text', rich_text: richText('5') }).ok).toBe(false);
    expect(readNumber(undefined).ok).toBe(false);
  });
});

describe('readDate', () => {
  it('reads date-only values unchanged', () => {
    expect(readDate({ type: 'date', date: { start: '2026-10-09', end: null } }, TIME_ZONE)).toEqual({
      ok: true,
      value: '2026-10-09',
    });
  });

  it('places date-times on the review time zone calendar', () => {
    expect(readDate({ type: 'date', date: { start: '2026-10-09T20:00:00.000Z' } }, TIME_ZONE)).toEqual({
      ok: true,
      value: '2026-10-10',
    });
  });

  it('reads date formulas', () => {
    expect(readDate({ type: 'formula', formula: { type: 'date', date: { start: '2026-10-12' } } }, TIME_ZONE)).toEqual({
      ok: true,
      value: '2026-10-12',
    });
    expect(readDate({ type: 'formula', formula: { type: 'date', date: null } }, TIME_ZONE)).toEqual({
      ok: true,
      value: null,
    });
  });

  it('distinguishes an empty date from an unreadable one', () => {
    expect(readDate({ type: 'date', date: null }, TIME_ZONE)).toEqual({ ok: true, value: null });
    expect(readDate({ type: 'date', date: { start: 'someday' } }, TIME_ZONE).ok).toBe(false);
    expect(readDate({ type: 'number', number: 3 }, TIME_ZONE).ok).toBe(false);
  });
});

describe('mapPageToRecord', () => {
  it('maps a complete page', () => {
    expect(map({ id: pageId(1), word: 'candid', mastery: 4, nextReview: '2026-10-08' })).toEqual({
      ok: true,
      record: {
        id: pageId(1),
        word: 'candid',
        mastery: 4,
        nextReview: '2026-10-08',
        fields: { partOfSpeech: 'noun', definition: 'a happy accident', example: 'What serendipity!' },
      },
    });
  });

  it('normalises undashed ids', () => {
    const mapped = map({ id: pageId(7).replace(/-/g, '').toUpperCase() });
    expect(mapped.ok && mapped.record.id).toBe(pageId(7));
  });

  it('keeps a record whose optional definition or example is missing', () => {
    const mapped = map({ id: pageId(1), definition: null, example: null });
    expect(mapped.ok && mapped.record.fields).toEqual({ partOfSpeech: 'noun', definition: null, example: null });
  });

  it('keeps empty mastery and empty date as null for the rules to judge', () => {
    const mapped = map({ id: pageId(1), mastery: null, nextReview: null });
    expect(mapped.ok && [mapped.record.mastery, mapped.record.nextReview]).toEqual([null, null]);
  });

  it('skips a page with no word', () => {
    const mapped = map({ id: pageId(1), word: '  ' });
    expect(mapped).toEqual({ ok: false, skipped: { id: pageId(1), word: null, reason: '"Word" is empty.' } });
  });

  it('skips a page whose due date cannot be read, naming the word', () => {
    const mapped = map({
      id: pageId(1),
      word: 'candid',
      properties: { 'Next Review': { type: 'date', date: { start: 'garbage' } } },
    });
    expect(mapped.ok).toBe(false);
    expect(!mapped.ok && mapped.skipped).toMatchObject({ id: pageId(1), word: 'candid' });
    expect(!mapped.ok && mapped.skipped.reason).toContain('Next Review');
  });

  it('skips a page whose mastery is not a number', () => {
    const mapped = map({ id: pageId(1), properties: { Mastery: { type: 'rich_text', rich_text: richText('3') } } });
    expect(!mapped.ok && mapped.skipped.reason).toContain('Mastery');
  });
});
