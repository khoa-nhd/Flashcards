import { describe, expect, it } from 'vitest';
import { sampleRules } from '../../server/mock/sample-rules.js';
import { VocabularyService, type VocabularyServiceOptions } from '../../server/vocabulary-service.js';
import { createEntryRequestSchema, updateEntryRequestSchema } from '../../shared/api.js';
import { FakeCatalog, entryData } from '../helpers/fake-catalog.js';
import { NOW, TIME_ZONE, TODAY, pageId } from '../helpers/fixtures.js';
import type { EntryData } from '../../server/vocabulary-catalog.js';

const REQUEST_A = '11111111-1111-4111-8111-111111111111';
const REQUEST_B = '22222222-2222-4222-8222-222222222222';

function setup(entries: EntryData[] = [], overrides: Partial<VocabularyServiceOptions> = {}) {
  const catalog = new FakeCatalog(entries);
  const service = new VocabularyService({
    catalog,
    rules: sampleRules,
    defaults: { mastery: 1, reviewDate: 'empty' },
    timeZone: TIME_ZONE,
    writesRequested: true,
    now: () => NOW,
    ...overrides,
  });
  return { catalog, service };
}

/** Requests are built through the same schema the HTTP layer uses. */
const createRequest = (input: Record<string, unknown>) =>
  createEntryRequestSchema.parse({ requestId: REQUEST_A, ...input });
const updateRequest = (input: Record<string, unknown>) => updateEntryRequestSchema.parse(input);

describe('list', () => {
  it('returns every entry with its review status and the session facts', async () => {
    const { service } = setup([
      entryData(1, { reviewDate: TODAY }),
      entryData(2, { reviewDate: '2026-10-01' }),
      entryData(3, { reviewDate: '2026-11-01' }),
      entryData(4, { mastery: 10 }),
      entryData(5, { reviewDate: null }),
      entryData(6, { mastery: null }),
    ]);
    const list = await service.list();
    expect(list.entries.map((entry) => entry.reviewStatus)).toEqual([
      'due_today',
      'overdue',
      'upcoming',
      'mastered',
      'unscheduled',
      'invalid',
    ]);
    expect(list).toMatchObject({
      today: TODAY,
      timeZone: TIME_ZONE,
      mode: 'mock',
      writesEnabled: true,
      defaults: { mastery: 1, reviewDate: 'empty' },
    });
  });

  it('reports read-only when saving is switched off or the schema cannot be written', async () => {
    expect((await setup([], { writesRequested: false }).service.list()).writesEnabled).toBe(false);
    const blocked = setup();
    blocked.catalog.setup = { readIssues: [], writeIssues: [], warnings: [], entryWriteIssues: ['"Definition" is a formula.'] };
    expect((await blocked.service.list()).writesEnabled).toBe(false);
  });

  it('refuses when the schema cannot be read', async () => {
    const { catalog, service } = setup();
    catalog.setup = { readIssues: ['No property named "Word".'], writeIssues: [], warnings: [] };
    await expect(service.list()).rejects.toMatchObject({ status: 503, code: 'setup_incomplete' });
  });
});

describe('create', () => {
  it('creates a word with the configured defaults', async () => {
    const { catalog, service } = setup();
    const { entry, created } = await service.create(createRequest({ word: 'candid' }));
    expect(created).toBe(true);
    expect(catalog.created).toEqual([
      {
        word: 'candid',
        meaning: null,
        definition: null,
        example: null,
        dateAdded: TODAY,
        mastery: 1,
        reviewDate: null,
      },
    ]);
    // No review date counts as due under the rules in use only if they admit it.
    expect(entry).toMatchObject({ word: 'candid', mastery: 1, dateAdded: TODAY, reviewStatus: 'unscheduled' });
  });

  it('uses today in the review time zone as Date Added', async () => {
    // 18:30 UTC on the 9th is already the 10th in Vietnam.
    const { catalog, service } = setup([], { now: () => new Date('2026-10-09T18:30:00Z') });
    await service.create(createRequest({ word: 'late' }));
    expect(catalog.created[0]?.dateAdded).toBe('2026-10-10');
  });

  it('can default the review date to today instead', async () => {
    const { catalog, service } = setup([], { defaults: { mastery: 0, reviewDate: 'today' } });
    await service.create(createRequest({ word: 'candid' }));
    expect(catalog.created[0]).toMatchObject({ mastery: 0, reviewDate: TODAY });
  });

  it('keeps values the form supplied over the defaults', async () => {
    const { catalog, service } = setup();
    await service.create(
      createRequest({
        word: '  ice   cream ',
        meaning: ' kem ',
        definition: 'a frozen dessert',
        example: '',
        dateAdded: '2026-09-30',
        mastery: 4,
        reviewDate: '2026-10-12',
      }),
    );
    expect(catalog.created[0]).toEqual({
      word: 'ice cream',
      meaning: 'kem',
      definition: 'a frozen dessert',
      example: null,
      dateAdded: '2026-09-30',
      mastery: 4,
      reviewDate: '2026-10-12',
    });
  });

  it('accepts an explicit empty review date', async () => {
    const { catalog, service } = setup([], { defaults: { mastery: 1, reviewDate: 'today' } });
    await service.create(createRequest({ word: 'candid', reviewDate: null }));
    expect(catalog.created[0]?.reviewDate).toBeNull();
  });

  it('warns about a duplicate, ignoring case and spacing, and creates nothing', async () => {
    const { catalog, service } = setup([entryData(1, { word: 'Ice Cream' })]);
    await expect(service.create(createRequest({ word: '  ice   cream ' }))).rejects.toMatchObject({
      status: 409,
      code: 'duplicate',
      options: { body: { duplicates: [expect.objectContaining({ id: pageId(1), word: 'Ice Cream' })] } },
    });
    expect(catalog.created).toEqual([]);
  });

  it('creates the duplicate when the user chose to continue', async () => {
    const { catalog, service } = setup([entryData(1, { word: 'bank' })]);
    const { created } = await service.create(createRequest({ word: 'bank', allowDuplicate: true }));
    expect(created).toBe(true);
    expect(catalog.created).toHaveLength(1);
  });

  it('does not treat a word in the trash as a duplicate', async () => {
    const { catalog, service } = setup([entryData(1, { word: 'bank' })]);
    await service.trash(pageId(1));
    await expect(service.create(createRequest({ word: 'bank' }))).resolves.toMatchObject({ created: true });
    expect(catalog.created).toHaveLength(1);
  });

  it('returns the same record for a repeated submission instead of creating two', async () => {
    const { catalog, service } = setup();
    const first = await service.create(createRequest({ word: 'candid' }));
    const retry = await service.create(createRequest({ word: 'candid' }));
    expect(retry.created).toBe(false);
    expect(retry.entry.id).toBe(first.entry.id);
    expect(catalog.created).toHaveLength(1);
  });

  it('handles two simultaneous identical submissions as one', async () => {
    const { catalog, service } = setup();
    const request = createRequest({ word: 'candid' });
    const [a, b] = await Promise.all([service.create(request), service.create(request)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(catalog.created).toHaveLength(1);
  });

  it('catches a second, separate submission of the same word as a duplicate', async () => {
    const { catalog, service } = setup();
    await service.create(createRequest({ word: 'candid', requestId: REQUEST_A }));
    await expect(service.create(createRequest({ word: 'Candid', requestId: REQUEST_B }))).rejects.toMatchObject({
      code: 'duplicate',
    });
    expect(catalog.created).toHaveLength(1);
  });

  it('creates nothing and remembers nothing when the store fails', async () => {
    const { catalog, service } = setup();
    catalog.failNextWrite = new Error('the database is down');
    await expect(service.create(createRequest({ word: 'candid' }))).rejects.toThrow('the database is down');
    // The retry is a real attempt, not a replay of a record that was never made.
    await expect(service.create(createRequest({ word: 'candid' }))).resolves.toMatchObject({ created: true });
    expect(catalog.created).toHaveLength(1);
  });

  it('refuses while saving is switched off', async () => {
    const { catalog, service } = setup([], { writesRequested: false });
    await expect(service.create(createRequest({ word: 'candid' }))).rejects.toMatchObject({
      status: 403,
      code: 'read_only',
    });
    expect(catalog.created).toEqual([]);
  });
});

describe('create request validation', () => {
  const parse = (input: Record<string, unknown>) => createEntryRequestSchema.safeParse({ requestId: REQUEST_A, ...input });

  it('requires a word', () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ word: '' }).success).toBe(false);
    expect(parse({ word: '   ' }).success).toBe(false);
  });

  it('rejects invalid field values', () => {
    expect(parse({ word: 'a'.repeat(201) }).success).toBe(false);
    expect(parse({ word: 'ok', definition: 'x'.repeat(6001) }).success).toBe(false);
    expect(parse({ word: 'ok', mastery: 11 }).success).toBe(false);
    expect(parse({ word: 'ok', mastery: -1 }).success).toBe(false);
    expect(parse({ word: 'ok', mastery: 2.5 }).success).toBe(false);
    expect(parse({ word: 'ok', dateAdded: '2026-02-30' }).success).toBe(false);
    expect(parse({ word: 'ok', reviewDate: 'tomorrow' }).success).toBe(false);
    expect(createEntryRequestSchema.safeParse({ word: 'ok' }).success).toBe(false); // no request id
    expect(createEntryRequestSchema.safeParse({ word: 'ok', requestId: 'abc' }).success).toBe(false);
  });

  it('rejects properties the app does not manage', () => {
    expect(parse({ word: 'ok', 'Answer Shown': true }).success).toBe(false);
    expect(parse({ word: 'ok', properties: { Word: 'x' } }).success).toBe(false);
  });
});

describe('update', () => {
  it('writes only the fields that actually changed', async () => {
    const { catalog, service } = setup([entryData(1)]);
    const entry = await service.update(
      pageId(1),
      updateRequest({ word: 'word-1', meaning: 'nghĩa 1', definition: 'a clearer definition', example: 'example for word-1' }),
    );
    expect(catalog.updated).toEqual([{ id: pageId(1), changes: { definition: 'a clearer definition' } }]);
    expect(entry.definition).toBe('a clearer definition');
  });

  it('never touches mastery or the review date when text is edited', async () => {
    const { catalog, service } = setup([entryData(1, { mastery: 6, reviewDate: '2026-10-20' })]);
    const entry = await service.update(pageId(1), updateRequest({ definition: 'new', example: 'new example' }));
    expect(Object.keys(catalog.updated[0]?.changes ?? {})).toEqual(['definition', 'example']);
    expect(entry).toMatchObject({ mastery: 6, reviewDate: '2026-10-20' });
  });

  it('clears a field when it is emptied', async () => {
    const { catalog, service } = setup([entryData(1)]);
    await service.update(pageId(1), updateRequest({ example: '   ' }));
    expect(catalog.updated).toEqual([{ id: pageId(1), changes: { example: null } }]);
  });

  it('writes nothing at all when nothing differs', async () => {
    const { catalog, service } = setup([entryData(1)]);
    const entry = await service.update(pageId(1), updateRequest({ word: 'word-1', definition: 'definition of word-1' }));
    expect(catalog.updated).toEqual([]);
    expect(entry.id).toBe(pageId(1));
  });

  it('changes the schedule only through the explicit schedule block', async () => {
    const { catalog, service } = setup([entryData(1, { mastery: 3, reviewDate: '2026-10-09' })]);
    const entry = await service.update(
      pageId(1),
      updateRequest({ schedule: { mastery: 5, reviewDate: null } }),
    );
    expect(catalog.updated).toEqual([{ id: pageId(1), changes: { mastery: 5, reviewDate: null } }]);
    expect(entry.reviewStatus).toBe('unscheduled');
  });

  it('warns when a rename collides with another word, but not with itself', async () => {
    const { catalog, service } = setup([entryData(1, { word: 'bank' }), entryData(2, { word: 'river' })]);
    await expect(service.update(pageId(2), updateRequest({ word: 'Bank' }))).rejects.toMatchObject({
      status: 409,
      code: 'duplicate',
    });
    expect(catalog.updated).toEqual([]);

    // Changing only the capitalisation of a word is not a duplicate of itself.
    await service.update(pageId(1), updateRequest({ word: 'Bank' }));
    await service.update(pageId(2), updateRequest({ word: 'bank', allowDuplicate: true }));
    expect(catalog.updated.map((update) => update.changes)).toEqual([{ word: 'Bank' }, { word: 'bank' }]);
  });

  it('answers 404 for a word that is not in the database', async () => {
    const { service } = setup([entryData(1)]);
    await expect(service.update(pageId(9), updateRequest({ definition: 'x' }))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('propagates a failed save without changing anything', async () => {
    const { catalog, service } = setup([entryData(1)]);
    catalog.failNextWrite = new Error('the database is down');
    await expect(service.update(pageId(1), updateRequest({ definition: 'x' }))).rejects.toThrow('the database is down');
    expect((await service.get(pageId(1))).definition).toBe('definition of word-1');
  });

  it('refuses while saving is switched off', async () => {
    const { catalog, service } = setup([entryData(1)], { writesRequested: false });
    await expect(service.update(pageId(1), updateRequest({ definition: 'x' }))).rejects.toMatchObject({
      status: 403,
    });
    expect(catalog.updated).toEqual([]);
  });
});

describe('update request validation', () => {
  it('rejects an empty change, an empty word and unknown properties', () => {
    expect(updateEntryRequestSchema.safeParse({}).success).toBe(false);
    expect(updateEntryRequestSchema.safeParse({ allowDuplicate: true }).success).toBe(false);
    expect(updateEntryRequestSchema.safeParse({ word: '  ' }).success).toBe(false);
    expect(updateEntryRequestSchema.safeParse({ mastery: 5 }).success).toBe(false);
    expect(updateEntryRequestSchema.safeParse({ reviewDate: '2026-10-10' }).success).toBe(false);
    expect(updateEntryRequestSchema.safeParse({ schedule: { mastery: 12, reviewDate: null } }).success).toBe(false);
    expect(updateEntryRequestSchema.safeParse({ schedule: { mastery: 5 } }).success).toBe(false);
  });
});

describe('trash and restore', () => {
  it('moves a word to the trash and takes it out of the list', async () => {
    const { catalog, service } = setup([entryData(1), entryData(2)]);
    await expect(service.trash(pageId(1))).resolves.toEqual({ id: pageId(1), trashed: true });
    expect(catalog.trashed).toEqual([pageId(1)]);
    expect((await service.list()).entries.map((entry) => entry.id)).toEqual([pageId(2)]);
    await expect(service.get(pageId(1))).rejects.toMatchObject({ status: 404 });
  });

  it('restores a trashed word unchanged', async () => {
    const { service } = setup([entryData(1, { mastery: 7 })]);
    await service.trash(pageId(1));
    await expect(service.restore(pageId(1))).resolves.toMatchObject({ id: pageId(1), mastery: 7 });
    expect((await service.list()).entries).toHaveLength(1);
  });

  it('answers 404 for a word that is not in the database', async () => {
    const { catalog, service } = setup([entryData(1)]);
    await expect(service.trash(pageId(9))).rejects.toMatchObject({ status: 404 });
    await expect(service.restore(pageId(9))).rejects.toMatchObject({ status: 404 });
    expect(catalog.trashed).toEqual([]);
  });

  it('refuses while saving is switched off', async () => {
    const { catalog, service } = setup([entryData(1)], { writesRequested: false });
    await expect(service.trash(pageId(1))).rejects.toMatchObject({ status: 403 });
    expect(catalog.trashed).toEqual([]);
  });
});
