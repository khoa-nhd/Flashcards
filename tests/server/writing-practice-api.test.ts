/**
 * The Writing Challenge through the HTTP API on the real schema. What these
 * tests defend: a whole essay is judged and kept whole; and where a model is
 * configured, the coach's note rides along beside the verdict — while every
 * way that note can fail still costs the answer nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardFields, fsrsRatingMap, newWordDefaults, reviewRules } from '../../config/review.config.js';
import { createAiAdapter } from '../../server/ai/adapter.js';
import { createTokenBucket } from '../../server/ai/rate-limit.js';
import { WRITING_COACH_RATE, createWritingCoach } from '../../server/ai/writing-coach.js';
import { createApp } from '../../server/create-app.js';
import { loadConfig } from '../../server/env.js';
import { createSupabaseAccounts } from '../../server/supabase/supabase-accounts.js';
import { entryResponseSchema, practiceRequestSchema, practiceResponseSchema, type VocabularyEntry } from '../../shared/api.js';
import { createPgVocabularyDatabase } from '../helpers/pg-vocabulary-database.js';
import { SUPABASE_ENV, call, createSupabaseTestApp, createTestUser, newId, type TestApp, type TestUser } from '../helpers/supabase-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let db: TestDatabase;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin('delete from auth.users');
  alice = await createTestUser(db, 'alice');
  bob = await createTestUser(db, 'bob');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TODAY = '2026-10-09';
const AI_ENV = { AI_API_KEY: 'test-key', AI_MODEL: 'test-model' };

const on = (day: string) => createSupabaseTestApp(db, [alice, bob], { now: () => new Date(`${day}T05:00:00Z`) });

/**
 * The app as the server wires it, coach and all: one coach built from the
 * configured model, shared by every account. `createSupabaseTestApp` builds
 * none, so this is the same assembly `bootstrap.ts` does, by hand.
 */
function withCoach(env: Record<string, string> = AI_ENV): TestApp {
  const config = loadConfig({ ...SUPABASE_ENV, ...env });
  if (config.supabase === null) throw new Error(`Test configuration is incomplete: ${config.issues.join(' ')}`);
  const users = new Map([alice, bob].map((user) => [user.token, user]));
  const coach =
    config.ai === null ? null : createWritingCoach({ adapter: createAiAdapter(config.ai), limiter: createTokenBucket(WRITING_COACH_RATE) });
  const accounts = createSupabaseAccounts({
    url: config.supabase.url,
    publicKey: config.supabase.publicKey,
    rules: reviewRules,
    cardFields,
    defaults: newWordDefaults,
    defaultTimeZone: config.timeZone,
    writesRequested: config.writesRequested,
    verifier: {
      async verify(token) {
        const user = users.get(token);
        return user === undefined ? null : { id: user.id, email: user.email };
      },
    },
    ratingMap: fsrsRatingMap,
    connect(token, schemaVersion) {
      const user = users.get(token);
      if (user === undefined) throw new Error('No such test user.');
      return createPgVocabularyDatabase(db, user.id, schemaVersion);
    },
    coach,
    now: () => new Date(`${TODAY}T05:00:00Z`),
  });
  return createApp({ config, service: null, accounts });
}

async function addWord(app: TestApp, user: TestUser, input: Record<string, unknown>): Promise<VocabularyEntry> {
  const response = await call(app, user, '/api/vocabulary', { method: 'POST', body: { requestId: newId(), ...input } });
  expect(response.status).toBe(201);
  return entryResponseSchema.parse(await response.json()).entry;
}

const candid = (app: TestApp) =>
  addWord(app, alice, {
    word: 'candid',
    meaning: 'thẳng thắn',
    definition: 'Honest and direct.',
    example: 'He gave a candid account.',
    mastery: 3,
    reviewDate: TODAY,
  });

const practise = (app: TestApp, user: TestUser, body: Record<string, unknown>) =>
  call(app, user, '/api/practice', { method: 'POST', body: { requestId: newId(), ...body } });

const practised = async (app: TestApp, user: TestUser, body: Record<string, unknown>) => {
  const response = await practise(app, user, body);
  expect(response.status, JSON.stringify(body)).toBe(200);
  return practiceResponseSchema.parse(await response.json());
};

/** The two coach columns, as the database holds them after one practice answer. */
const coachColumns = () =>
  db.admin<{ ai_feedback: string | null; model_answer: string | null }>(
    'select ai_feedback, model_answer from public.review_logs where kind = $1',
    ['practice'],
  );

describe('a whole essay, with no model in sight', () => {
  it('keeps a sentence of over 3,000 characters whole, in the response and in the row', async () => {
    const app = on(TODAY);
    const word = await candid(app);
    const essay = 'I stayed candid throughout the long and winding tale. '.repeat(60).trim();
    expect(essay.length).toBeGreaterThan(3000);

    const response = await practise(app, alice, { pageId: word.id, mode: 'writing', answer: { kind: 'typed', text: essay } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // No coach was configured, so the answer says nothing about one.
    expect(body).not.toHaveProperty('aiFeedback');
    expect(body).not.toHaveProperty('modelAnswer');
    expect(practiceResponseSchema.parse(body)).toMatchObject({ outcome: 'recorded', correct: true, typed: 'exact', expected: 'candid' });

    // The whole sentence is in the history: longer than any typed word's 500 could ever be.
    const [row] = await db.admin<{ review_mode: string; answer_correct: boolean; submitted_answer: string | null }>(
      'select review_mode, answer_correct, submitted_answer from public.review_logs where kind = $1',
      ['practice'],
    );
    expect(row?.review_mode).toBe('writing');
    expect(row?.answer_correct).toBe(true);
    expect(row?.submitted_answer).toBe(essay);
    expect(row?.submitted_answer?.length).toBeGreaterThan(3000);
    expect(await coachColumns()).toEqual([{ ai_feedback: null, model_answer: null }]);
  });
});

describe('how long an answer may be', () => {
  const request = (text: string, mode: 'writing' | 'typing') =>
    practiceRequestSchema.safeParse({
      pageId: '00000000-0000-4000-8000-000000000001',
      mode,
      answer: { kind: 'typed', text },
      requestId: 'aaaaaaaa-0000-4000-8000-000000000001',
    });

  it('takes a sentence of up to 6,000 characters in the Writing Challenge, and no more', () => {
    expect(request('x'.repeat(6000), 'writing').success).toBe(true);
    expect(request('x'.repeat(6001), 'writing').success).toBe(false);
  });

  it('keeps every other typed mode to 500 characters', () => {
    expect(request('x'.repeat(500), 'typing').success).toBe(true);
    expect(request('x'.repeat(501), 'typing').success).toBe(false);
    expect(request('x'.repeat(601), 'typing').success).toBe(false);
  });
});

describe('the coach’s note', () => {
  const note = {
    feedback: 'Your sentence is clear. One improvement: add a comma after the opening phrase.',
    modelAnswer: 'She gave a candid account of the loss.',
  };
  const sentence = 'I always stay candid when the answer matters this much.';

  /** The model endpoint as the adapter sees it: a chat reply carrying JSON. */
  function modelReplies(content: string, status = 200) {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('comes back with the verdict, and is stored beside the answer it comments on', async () => {
    const app = withCoach();
    const word = await candid(app);
    const fetchMock = modelReplies(JSON.stringify(note));

    const result = await practised(app, alice, { pageId: word.id, mode: 'writing', answer: { kind: 'typed', text: sentence } });
    expect(result).toMatchObject({
      outcome: 'recorded',
      correct: true,
      typed: 'exact',
      aiFeedback: note.feedback,
      modelAnswer: note.modelAnswer,
    });
    expect(await coachColumns()).toEqual([{ ai_feedback: note.feedback, model_answer: note.modelAnswer }]);

    // The coach was given this sentence to comment on.
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages.find((message) => message.role === 'user')?.content).toContain(sentence);
  });

  it('is not asked for when the sentence is too short to comment on', async () => {
    const app = withCoach();
    const word = await candid(app);
    const fetchMock = modelReplies(JSON.stringify(note));

    const result = await practised(app, alice, { pageId: word.id, mode: 'writing', answer: { kind: 'typed', text: 'Candid, always.' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ correct: true });
    expect(result).not.toHaveProperty('aiFeedback');
    expect(await coachColumns()).toEqual([{ ai_feedback: null, model_answer: null }]);
  });

  it('is not asked for in any other mode', async () => {
    const app = withCoach();
    const word = await candid(app);
    const fetchMock = modelReplies(JSON.stringify(note));

    const result = await practised(app, alice, { pageId: word.id, mode: 'typing', answer: { kind: 'typed', text: 'candid' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('aiFeedback');
    expect(result).not.toHaveProperty('modelAnswer');
  });

  it('fails quietly: the answer still comes back, recorded, without a note', async () => {
    const app = withCoach();
    const word = await candid(app);

    modelReplies('{}', 500);
    const down = await practise(app, alice, { pageId: word.id, mode: 'writing', answer: { kind: 'typed', text: sentence } });
    expect(down.status).toBe(200);
    const downBody = (await down.json()) as Record<string, unknown>;
    expect(downBody).not.toHaveProperty('aiFeedback');
    expect(downBody).not.toHaveProperty('modelAnswer');
    expect(practiceResponseSchema.parse(downBody)).toMatchObject({ outcome: 'recorded', correct: true });

    // A reply that is not the shape asked for is the same story.
    modelReplies('not json at all');
    const broken = await practise(app, alice, { pageId: word.id, mode: 'writing', answer: { kind: 'typed', text: sentence } });
    expect(broken.status).toBe(200);
    const brokenBody = (await broken.json()) as Record<string, unknown>;
    expect(brokenBody).not.toHaveProperty('aiFeedback');
    expect(practiceResponseSchema.parse(brokenBody)).toMatchObject({ correct: true });

    expect(await coachColumns()).toEqual([
      { ai_feedback: null, model_answer: null },
      { ai_feedback: null, model_answer: null },
    ]);
  });
});
