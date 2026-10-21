/**
 * The app must keep working on a database that has not had the newer SQL
 * files run yet. The API tests cannot see a mistake in the real Supabase
 * gateway, because they go through a mirror of it that speaks SQL. So this
 * runs the real application, through the real gateway, against a stand-in for
 * the Supabase SDK that only records what it is asked for, and then checks
 * every table, view, column and function asked for against the schema as it
 * really is at that version.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cardFields, fsrsRatingMap, newWordDefaults, reviewRules } from '../../config/review.config.js';
import { createApp } from '../../server/create-app.js';
import { loadConfig } from '../../server/env.js';
import { createSupabaseAccounts } from '../../server/supabase/supabase-accounts.js';
import { LATEST_SCHEMA_VERSION, createSupabaseDatabase } from '../../server/supabase/supabase-database.js';
import { SupabaseVocabularyRepository } from '../../server/supabase/supabase-repository.js';
import { NOW, TODAY } from '../helpers/fixtures.js';
import { SUPABASE_ENV, newId } from '../helpers/supabase-app.js';
import { createTestDatabase, readMigrations, type TestDatabase } from '../helpers/test-database.js';

interface Asked {
  kind: 'relation' | 'function';
  name: string;
  /** Column names read or written, where the request named them. */
  columns: Set<string>;
  /** The request that led to it. */
  during: string;
}

const WRITES = new Set(['insert', 'update', 'upsert']);
/** Calls whose first argument names a column to filter or sort by. */
const FILTERS = new Set(['eq', 'neq', 'is', 'lt', 'lte', 'gt', 'gte', 'in', 'order']);

/** Column names out of a select list. Anything that is not a plain name (a count, an embed) is skipped. */
const namesIn = (list: string) =>
  list
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^[a-z_][a-z0-9_]*$/.test(part));

/** Stands in for the Supabase client: answers every query with nothing, and remembers what was asked. */
function recorder(version: number) {
  const asked: Asked[] = [];
  let during = 'start-up';

  const chain = (entry: Asked, data: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
              Promise.resolve({ data, error: null, status: 200, count: 0 }).then(resolve, reject);
          }
          return (...args: unknown[]) => {
            if (property === 'select' && typeof args[0] === 'string') for (const name of namesIn(args[0])) entry.columns.add(name);
            if (typeof property === 'string' && FILTERS.has(property) && typeof args[0] === 'string') {
              for (const name of namesIn(args[0])) entry.columns.add(name);
            }
            if (typeof property === 'string' && WRITES.has(property) && typeof args[0] === 'object' && args[0] !== null) {
              for (const name of Object.keys(args[0])) entry.columns.add(name);
            }
            // One row was asked for, and there is none.
            return chain(entry, property === 'maybeSingle' || property === 'single' ? null : data);
          };
        },
      },
    );

  const record = (kind: Asked['kind'], name: string) => {
    const entry: Asked = { kind, name, columns: new Set(), during };
    asked.push(entry);
    return entry;
  };

  return {
    asked,
    during(label: string) {
      during = label;
    },
    client: {
      from: (name: string) => chain(record('relation', name), []),
      rpc: (name: string) => chain(record('function', name), name === 'app_schema_version' ? version : []),
    },
  };
}

interface Catalogue {
  columns: Map<string, Set<string>>;
  functions: Set<string>;
}

/** What the database really has after each migration, read from PostgreSQL's own catalogue. */
const catalogues: Catalogue[] = [];
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ migrations: 0 });
  for (const migration of readMigrations()) {
    await db.db.exec(migration.sql);
    const columns = new Map<string, Set<string>>();
    for (const row of await db.admin<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    )) {
      columns.set(row.table_name, (columns.get(row.table_name) ?? new Set()).add(row.column_name));
    }
    const functions = new Set(
      (
        await db.admin<{ proname: string }>(
          `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
        )
      ).map((row) => row.proname),
    );
    catalogues.push({ columns, functions });
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

const USER = { id: '0b0e7c6a-5a4e-4c1f-9d2b-3f1e2d4c5b6a', email: 'owner@example.com' };
const WORD = '00000000-0000-4000-8000-000000000001';

/** Everything the app reads, and every write that reaches the database even when it holds nothing. */
const REQUESTS: Array<[label: string, path: string, method?: 'POST' | 'PUT', body?: unknown]> = [
  ['the review queue', '/api/review-queue'],
  ['the review queue, weakest first', '/api/review-queue?focus=weak'],
  ['the review queue, words the reviewer picked', '/api/review-queue', 'POST', { ids: [WORD] }],
  ['the word list', '/api/vocabulary'],
  ['one word', `/api/vocabulary/${WORD}`],
  ['a word’s practice mastery', `/api/vocabulary/${WORD}/practice-mastery`],
  ['the trash', '/api/trash'],
  ['settings', '/api/settings'],
  ['the day’s plan', '/api/plan'],
  ['review activity', '/api/analytics'],
  ['weak words', '/api/weak-words'],
  ['the schedule comparison', '/api/scheduler'],
  ['the what-if comparison', '/api/simulation'],
  ['reviews per day', `/api/review-days?from=${TODAY}&to=${TODAY}`],
  ['collections, examples and links', '/api/library'],
  ['the account export', '/api/export'],
  ['a session summary', `/api/sessions/${newId()}/summary`],
  ['saving the time zone', '/api/settings', 'PUT', { timeZone: 'UTC' }],
  ['saving the FSRS target', '/api/settings', 'PUT', { fsrsRetention: 0.85 }],
  ['saving whether a review counts', '/api/settings', 'PUT', { countReviewsTowardMastery: false }],
  ['saving a daily goal', '/api/goal', 'PUT', { reviews: 5, minutes: null }],
  ['choosing FSRS', '/api/scheduler', 'PUT', { scheduler: 'fsrs' }],
  ['adding a word', '/api/vocabulary', 'POST', { requestId: newId(), word: 'candid' }],
  ['importing a word', '/api/vocabulary/import', 'POST', { items: [{ requestId: newId(), word: 'lucid' }] }],
  ['answering a card', '/api/review-action', 'POST', { pageId: WORD, action: 'remember', expected: { mastery: 3, nextReview: TODAY }, requestId: newId() }],
  ['undoing an answer', '/api/review-undo', 'POST', { reviewRequestId: newId(), requestId: newId() }],
  ['a practice answer', '/api/practice', 'POST', { pageId: WORD, mode: 'typing', answer: { kind: 'typed', text: 'candid' }, requestId: newId() }],
  ['creating a collection', '/api/collections', 'POST', { name: 'Travel' }],
  ['adding an example', `/api/vocabulary/${WORD}/examples`, 'POST', { sentence: 'A candid answer.' }],
  ['linking two words', '/api/relations', 'POST', { fromId: WORD, toId: '00000000-0000-4000-8000-000000000002', kind: 'synonym' }],
];

/** Runs the whole application at one schema version and returns everything it asked the database for. */
async function askedAt(version: number): Promise<Asked[]> {
  const fake = recorder(version);
  const config = loadConfig(SUPABASE_ENV);
  if (config.supabase === null) throw new Error('Test configuration is incomplete.');
  const connect = (_token: string, schemaVersion?: number) => createSupabaseDatabase(fake.client as never, schemaVersion);
  const app = createApp({
    config,
    service: null,
    accounts: createSupabaseAccounts({
      url: config.supabase.url,
      publicKey: config.supabase.publicKey,
      rules: reviewRules,
      cardFields,
      defaults: newWordDefaults,
      defaultTimeZone: 'UTC',
      writesRequested: true,
      verifier: { verify: async () => USER },
      ratingMap: fsrsRatingMap,
      connect,
      now: () => NOW,
    }),
  });

  // Empty answers make some requests fail on purpose; what the server logs about that is not of interest here.
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const [label, path, method, body] of REQUESTS) {
    fake.during(label);
    // The answers are empty, so many of these end in "not found". What was asked on the way is the point.
    await app.request(path, {
      method: method ?? 'GET',
      headers: { Authorization: 'Bearer a.b.c', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // The writes that need a word to exist before they reach the database: asked for directly,
  // through the same repository the services use, which is where the version decides the route.
  const repository = new SupabaseVocabularyRepository(connect('', version), reviewRules, version);
  fake.during('saving an answer');
  await repository
    .applyReview({
      id: WORD,
      requestId: newId(),
      action: 'remember',
      expected: { mastery: 3, nextReview: TODAY },
      next: { mastery: 4, nextReview: TODAY },
      reviewedOn: TODAY,
      durationMs: null,
      sessionId: newId(),
      confidence: 2,
    })
    .catch(() => undefined);
  // From version 15 an answer, its Undo and an archive go through the FSRS-only functions.
  fake.during('saving an answer under FSRS alone');
  await repository
    .applyFsrsReview({
      id: WORD,
      requestId: newId(),
      action: 'remember',
      expectedRevision: 0,
      countsTowardSchedule: true,
      rating: 3,
      engine: 'test',
      after: {
        due: '2026-10-20T00:00:00.000Z',
        stability: 3,
        difficulty: 5,
        scheduledDays: 3,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        lastReview: '2026-10-17T00:00:00.000Z',
      },
      reviewedOn: TODAY,
      answeredAt: null,
      durationMs: null,
      sessionId: newId(),
      confidence: null,
    })
    .catch(() => undefined);
  fake.during('taking an answer back under FSRS alone');
  await repository.undoFsrsReview({ reviewRequestId: newId(), requestId: newId() }).catch(() => undefined);
  fake.during('archiving words');
  await repository.setEntriesSuspended([WORD], true).catch(() => undefined);
  fake.during('recording practice');
  await repository
    .recordPractice({
      id: WORD,
      requestId: newId(),
      sessionId: null,
      mode: 'typing',
      correct: true,
      grading: 'auto',
      submitted: 'candid',
      reviewedOn: TODAY,
      durationMs: null,
      confidence: null,
    })
    .catch(() => undefined);
  fake.during('counting practice mastery');
  await repository.practiceCorrectCounts(WORD).catch(() => undefined);
  fake.during('marking a reply added');
  await repository.markAiMessageSaved(newId(), newId(), WORD).catch(() => undefined);
  quiet.mockRestore();
  return fake.asked;
}

describe.each(Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1))('a database at version %i', (version) => {
  let asked: Asked[];

  beforeAll(async () => {
    asked = await askedAt(version);
  });

  it('is asked only for tables, views and columns it has', () => {
    const { columns } = catalogues[version - 1]!;
    const missing: string[] = [];
    for (const entry of asked.filter((item) => item.kind === 'relation')) {
      const known = columns.get(entry.name);
      if (known === undefined) {
        missing.push(`${entry.name} (while ${entry.during})`);
        continue;
      }
      for (const column of entry.columns) {
        if (!known.has(column)) missing.push(`${entry.name}.${column} (while ${entry.during})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('is asked only for functions it has', () => {
    const { functions } = catalogues[version - 1]!;
    const missing = asked
      .filter((item) => item.kind === 'function' && item.name !== 'app_schema_version')
      .filter((item) => !functions.has(item.name))
      .map((item) => `${item.name} (while ${item.during})`);
    expect(missing).toEqual([]);
  });

  it('builds the review queue from the card view alone, as it has since version 1', () => {
    const forQueue = new Set(asked.filter((item) => item.during === 'the review queue').map((item) => `${item.kind} ${item.name}`));
    expect(forQueue).toContain('relation vocabulary_cards');
    // Beyond that, only what opening any signed-in request needs: the schema version and the account's settings.
    forQueue.delete('relation vocabulary_cards');
    forQueue.delete('relation user_settings');
    forQueue.delete('function app_schema_version');
    expect([...forQueue]).toEqual([]);
  });

  it('counts practice mastery only where practice is recorded, from the history alone', () => {
    const used = asked.filter((item) => item.during === 'counting practice mastery');
    if (version < 6) {
      expect(used).toEqual([]);
      return;
    }
    expect(used.map((item) => `${item.kind} ${item.name}`)).toEqual(['relation review_logs']);
    // The columns it filters on arrived with practice itself, so they are checked like any others above.
    expect([...used[0]!.columns].sort()).toEqual(['answer_correct', 'id', 'kind', 'review_mode', 'vocabulary_id']);
  });

  it('saves an answer through the function that version has', () => {
    const used = asked.filter((item) => item.during === 'saving an answer').map((item) => item.name);
    expect(used).toEqual([version >= 2 ? 'record_review' : 'apply_review']);
  });

  it('saves, takes back and archives under FSRS alone only from version 15', () => {
    const used = (label: string) => asked.filter((item) => item.during === label).map((item) => item.name);
    expect(used('saving an answer under FSRS alone')).toEqual(version >= 15 ? ['record_fsrs_review'] : []);
    expect(used('taking an answer back under FSRS alone')).toEqual(version >= 15 ? ['undo_fsrs_review'] : []);
    // The recorder reports no word as changed, so nothing is read back after it.
    expect(used('archiving words')).toEqual(version >= 15 ? ['set_cards_suspended'] : []);
  });

  it('marks a reply added only where the link can be kept', () => {
    const used = asked.filter((item) => item.during === 'marking a reply added').map((item) => item.name);
    expect(used).toEqual(version >= 12 ? ['mark_ai_message_saved'] : []);
  });
});

describe('the recording itself', () => {
  it('saw the app reach for the things each version adds, so an empty record cannot pass for a clean one', async () => {
    const names = new Set((await askedAt(LATEST_SCHEMA_VERSION)).map((item) => item.name));
    for (const expected of [
      'vocabulary_cards',
      'user_settings',
      'review_logs',
      'collections',
      'vocabulary_examples',
      'vocabulary_relations',
      'record_review',
      'record_fsrs_review',
      'undo_fsrs_review',
      'set_cards_suspended',
      'session_summary',
      'review_daily_stats',
      'weak_word_days',
      'confidence_stats',
      'practice_daily_stats',
      'record_practice',
      'create_vocabulary',
      'mark_ai_message_saved',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it('would catch a function that does not exist at the version in use', () => {
    // What went wrong once: the queue read through a function only the newest file would have created.
    expect(catalogues[3]!.functions.has('list_due_cards')).toBe(false);
    expect(catalogues[LATEST_SCHEMA_VERSION - 1]!.functions.has('list_due_cards')).toBe(false);
    expect(catalogues[0]!.functions.has('apply_review')).toBe(true);
    expect(catalogues[0]!.functions.has('record_review')).toBe(false);
  });

  it('reads the choice of schedule only where the column exists', async () => {
    const settingsColumns = async (version: number) =>
      new Set((await askedAt(version)).filter((item) => item.name === 'user_settings').flatMap((item) => [...item.columns]));
    expect(await settingsColumns(7)).not.toContain('scheduler');
    expect(await settingsColumns(8)).toContain('scheduler');
  });

  it('reads whether a review counts towards mastery only where the column exists', async () => {
    const settingsColumns = async (version: number) =>
      new Set((await askedAt(version)).filter((item) => item.name === 'user_settings').flatMap((item) => [...item.columns]));
    expect(await settingsColumns(12)).not.toContain('count_reviews_toward_mastery');
    expect(await settingsColumns(LATEST_SCHEMA_VERSION)).toContain('count_reviews_toward_mastery');
  });
});
