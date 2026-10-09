/**
 * Turns raw Notion JSON into validated internal records. Nothing outside this
 * file reads Notion's response shapes directly.
 */
import { z } from 'zod';
import { normalizeId, type SkippedRecord } from '../../shared/api.js';
import { toCalendarDate, type IsoDate } from '../../shared/dates.js';
import type { CardFieldConfig, NotionPropertyConfig, VocabularyRecord } from '../../shared/vocabulary.js';

export const databaseSchema = z.looseObject({
  id: z.string(),
  data_sources: z.array(z.looseObject({ id: z.string(), name: z.string().optional() })),
});

export const dataSourceSchema = z.looseObject({
  id: z.string(),
  properties: z.record(z.string(), z.looseObject({ type: z.string() })),
});

export const pageSchema = z.looseObject({
  object: z.literal('page'),
  id: z.string(),
  in_trash: z.boolean().optional(),
  archived: z.boolean().optional(),
  parent: z.looseObject({
    type: z.string(),
    data_source_id: z.string().optional(),
    database_id: z.string().optional(),
  }),
  properties: z.record(z.string(), z.unknown()),
});

export type NotionPage = z.infer<typeof pageSchema>;

/** Property types each kind of value can be read from. */
export const TEXT_TYPES = [
  'title',
  'rich_text',
  'select',
  'status',
  'multi_select',
  'url',
  'email',
  'phone_number',
  'number',
  'formula',
  'rollup',
] as const;
export const NUMBER_TYPES = ['number', 'formula', 'rollup'] as const;
export const DATE_TYPES = ['date', 'formula', 'rollup'] as const;

export type Extracted<T> = { ok: true; value: T | null } | { ok: false; reason: string };

const found = <T>(value: T | null): Extracted<T> => ({ ok: true, value });
const unreadable = (reason: string): Extracted<never> => ({ ok: false, reason });

const typedSchema = z.looseObject({ type: z.string() });
const richTextSchema = z.array(z.looseObject({ plain_text: z.string() }));
const namedSchema = z.looseObject({ name: z.string() });
const dateSchema = z.looseObject({ start: z.string() });

function clean(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** The payload stored under a property's own type key, e.g. `property.number`. */
function payload(property: unknown): { type: string; value: unknown } | null {
  const typed = typedSchema.safeParse(property);
  if (!typed.success) return null;
  return { type: typed.data.type, value: (typed.data as Record<string, unknown>)[typed.data.type] };
}

export function readText(property: unknown): Extracted<string> {
  const entry = payload(property);
  if (entry === null) return unreadable('the property is missing');
  const { type, value } = entry;

  switch (type) {
    case 'title':
    case 'rich_text': {
      const parsed = richTextSchema.safeParse(value);
      if (!parsed.success) return unreadable(`unexpected ${type} value`);
      return found(clean(parsed.data.map((item) => item.plain_text).join('')));
    }
    case 'select':
    case 'status': {
      if (value === null) return found(null);
      const parsed = namedSchema.safeParse(value);
      return parsed.success ? found(clean(parsed.data.name)) : unreadable(`unexpected ${type} value`);
    }
    case 'multi_select': {
      const parsed = z.array(namedSchema).safeParse(value);
      if (!parsed.success) return unreadable('unexpected multi_select value');
      return found(clean(parsed.data.map((option) => option.name).join(', ')));
    }
    case 'url':
    case 'email':
    case 'phone_number':
    case 'string':
      if (value === null) return found(null);
      return typeof value === 'string' ? found(clean(value)) : unreadable(`unexpected ${type} value`);
    case 'number':
      if (value === null) return found(null);
      return typeof value === 'number' ? found(String(value)) : unreadable('unexpected number value');
    case 'boolean':
      return value === null ? found(null) : found(String(value));
    case 'date': {
      if (value === null) return found(null);
      const parsed = dateSchema.safeParse(value);
      return parsed.success ? found(clean(parsed.data.start)) : unreadable('unexpected date value');
    }
    case 'formula':
      // A formula result is itself a typed value: { type: 'string', string: … }.
      return readText(value);
    case 'rollup': {
      const inner = payload(value);
      if (inner === null) return unreadable('unexpected rollup value');
      if (inner.type !== 'array') return readText(value);
      if (!Array.isArray(inner.value)) return unreadable('unexpected rollup value');
      const parts: string[] = [];
      for (const item of inner.value) {
        const text = readText(item);
        if (!text.ok) return text;
        if (text.value !== null) parts.push(text.value);
      }
      return found(clean(parts.join(', ')));
    }
    default:
      return unreadable(`"${type}" properties cannot be shown as text`);
  }
}

export function readNumber(property: unknown): Extracted<number> {
  const entry = payload(property);
  if (entry === null) return unreadable('the property is missing');
  const { type, value } = entry;

  if (type === 'number') {
    if (value === null) return found(null);
    return typeof value === 'number' && Number.isFinite(value)
      ? found(value)
      : unreadable('the value is not a number');
  }
  if (type === 'formula' || type === 'rollup') {
    const inner = payload(value);
    if (inner?.type !== 'number') return unreadable(`the ${type} does not produce a number`);
    return readNumber(value);
  }
  return unreadable(`"${type}" properties are not numbers`);
}

export function readDate(property: unknown, timeZone: string): Extracted<IsoDate> {
  const entry = payload(property);
  if (entry === null) return unreadable('the property is missing');
  const { type, value } = entry;

  if (type === 'date') {
    if (value === null) return found(null);
    const parsed = dateSchema.safeParse(value);
    if (!parsed.success) return unreadable('unexpected date value');
    const date = toCalendarDate(parsed.data.start, timeZone);
    return date === null ? unreadable(`"${parsed.data.start}" is not a readable date`) : found(date);
  }
  if (type === 'formula' || type === 'rollup') {
    const inner = payload(value);
    if (inner?.type !== 'date') return unreadable(`the ${type} does not produce a date`);
    return readDate(value, timeZone);
  }
  return unreadable(`"${type}" properties are not dates`);
}

export interface RecordMapping {
  properties: NotionPropertyConfig;
  fields: readonly CardFieldConfig[];
  timeZone: string;
}

export type MappedPage =
  | { ok: true; record: VocabularyRecord }
  | { ok: false; skipped: SkippedRecord };

/**
 * Maps one page to a record. A page that cannot be trusted (no word, an
 * unreadable mastery or date) is reported as skipped rather than patched up
 * with defaults, so a data problem can never be reviewed and written back.
 */
export function mapPageToRecord(page: NotionPage, mapping: RecordMapping): MappedPage {
  const id = normalizeId(page.id);
  const { properties } = mapping;

  const word = readText(page.properties[properties.word]);
  const wordText = word.ok ? word.value : null;
  const skip = (reason: string): MappedPage => ({ ok: false, skipped: { id, word: wordText, reason } });

  if (!word.ok) return skip(`Could not read "${properties.word}": ${word.reason}.`);
  if (word.value === null) return skip(`"${properties.word}" is empty.`);

  const mastery = readNumber(page.properties[properties.mastery]);
  if (!mastery.ok) return skip(`Could not read "${properties.mastery}": ${mastery.reason}.`);

  const nextReview = readDate(page.properties[properties.nextReview], mapping.timeZone);
  if (!nextReview.ok) return skip(`Could not read "${properties.nextReview}": ${nextReview.reason}.`);

  const fields: Record<string, string | null> = {};
  for (const field of mapping.fields) {
    const text = readText(page.properties[field.property]);
    fields[field.key] = text.ok ? text.value : null;
  }

  return {
    ok: true,
    record: { id, word: word.value, mastery: mastery.value, nextReview: nextReview.value, fields },
  };
}
