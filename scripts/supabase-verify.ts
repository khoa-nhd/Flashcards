/**
 * Checks a real Supabase project from the outside, the way the app and an
 * attacker would reach it: `npm run supabase:verify`.
 *
 * It needs two ordinary accounts (VERIFY_A_EMAIL / VERIFY_A_PASSWORD and
 * VERIFY_B_EMAIL / VERIFY_B_PASSWORD, or it asks). Account A must be a
 * throwaway: the check creates one marker word in it and leaves that word in
 * A's trash, because nothing — this script included — is able to remove a row
 * outright. Account B is only used to try to reach A's data; nothing is
 * created or changed in it, so it can be a real account. Using your own
 * account as B also proves the thing that matters most: that the throwaway
 * cannot see a single one of your words.
 *
 * It proves, against the live database:
 *   - a visitor who is not signed in can read and write nothing;
 *   - account B cannot see or change anything of account A's;
 *   - a review is saved once, however often it is sent, and a second device's
 *     stale answer is refused;
 *   - history cannot be edited or deleted, and words cannot be removed outright;
 *   - where the database has the newer versions: Undo, sessions, the FSRS state
 *     saved alongside, and review statistics, each closed to the other account.
 *     Parts the database is not ready for are reported as SKIP, not as passing.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LATEST_SCHEMA_VERSION, fsrsOfCard, fsrsStateToRow } from '../server/supabase/supabase-database.js';
import { calendarDateInTimeZone } from '../shared/dates.js';
import { FSRS_ENGINE, FSRS_RATINGS, fsrsReview } from '../shared/scheduler/fsrs.js';
import { createAnonymousClient, readProjectConfig, signIn } from './lib/supabase-session.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const results: Array<{ ok: boolean; name: string; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
}

interface Outcome {
  rows: unknown[];
  error: { code?: string; message?: string } | null;
}

/** Runs a query and reports what came back without ever throwing. */
async function attempt(query: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>): Promise<Outcome> {
  try {
    const { data, error } = await query;
    return { rows: Array.isArray(data) ? data : data === null || data === undefined ? [] : [data], error };
  } catch (error) {
    return { rows: [], error: { message: error instanceof Error ? error.message : 'threw' } };
  }
}

const refused = (outcome: Outcome) => outcome.error !== null;
const nothing = (outcome: Outcome) => outcome.rows.length === 0;

async function main(): Promise<number> {
  const project = readProjectConfig();
  console.log(`Project: ${project.url}\n`);

  // ---- 1. A visitor who is not signed in ----
  const anon = createAnonymousClient(project) as unknown as SupabaseClient;
  for (const table of ['vocabulary', 'card_states', 'review_logs', 'user_settings', 'vocabulary_cards']) {
    const read = await attempt(anon.from(table).select('*').limit(1));
    check(`signed-out visitor cannot read ${table}`, nothing(read) && refused(read), `${read.rows.length} rows, error ${read.error?.code ?? 'none'}`);
  }
  const anonCreate = await attempt(anon.rpc('create_vocabulary', { p_word: 'x', p_word_key: 'x', p_mastery: 1 }));
  check('signed-out visitor cannot create a word', refused(anonCreate), 'the call succeeded');
  const anonInsert = await attempt(anon.from('vocabulary').insert({ word: 'x', word_key: 'x' }).select('id'));
  check('signed-out visitor cannot insert a row', refused(anonInsert) && nothing(anonInsert), 'the insert succeeded');

  // ---- 2. Two ordinary accounts ----
  console.log('\nTwo accounts are needed. A must be a throwaway: one marker word is created in it.');
  console.log('B is only used to try to reach A’s data; nothing is created or changed in B, so it may be your own.\n');
  const a = await signIn(project, 'VERIFY_A_EMAIL', 'VERIFY_A_PASSWORD', 'A (throwaway test account)');
  const b = await signIn(project, 'VERIFY_B_EMAIL', 'VERIFY_B_PASSWORD', 'B (any other account)');
  if (a.userId === b.userId) throw new Error('The two accounts are the same one. Two different accounts are needed.');
  const rawA = a.client as unknown as SupabaseClient;
  const rawB = b.client as unknown as SupabaseClient;
  console.log(`\nAccount A: ${a.email}\nAccount B: ${b.email}\n`);

  // Whatever each account already holds, every row it can see must be its own.
  for (const [name, raw, owner] of [['A', rawA, a.userId], ['B', rawB, b.userId]] as const) {
    for (const table of ['vocabulary', 'card_states', 'review_logs', 'user_settings', 'vocabulary_cards']) {
      const visible = await attempt(raw.from(table).select('user_id').limit(5000));
      const foreign = visible.rows.filter((row) => (row as { user_id: string }).user_id !== owner).length;
      check(
        `account ${name} sees only its own rows in ${table} (${visible.rows.length} visible)`,
        visible.error === null && foreign === 0,
        visible.error ? `error ${visible.error.code ?? visible.error.message}` : `${foreign} rows belong to someone else`,
      );
    }
  }

  const today = calendarDateInTimeZone(new Date(), 'UTC');
  const marker = `zz-isolation-check-${randomUUID().slice(0, 8)}`;
  const markerRequest = randomUUID();
  const markerCard = {
    word: marker,
    wordKey: marker,
    mastery: 3,
    meaning: 'created by supabase:verify',
    definition: null,
    example: null,
    dateAdded: today,
    reviewDate: today,
  };
  const created = await a.database.createCard({ ...markerCard, requestId: markerRequest });
  check('account A can create a word', created.created);
  const id = created.id;

  try {
    const mine = await a.database.getCard(id);
    check('account A reads its own word back', mine?.word === marker && mine.mastery === 3 && mine.review_date === today);

    // Every read the app makes, once, against the live API.
    check('the word is in A’s list', (await a.database.listCards()).some((card) => card.id === id));
    check('the word is in A’s review queue query', (await a.database.listDueCards(today, 10)).some((card) => card.id === id));
    check('it is not in the queue query once past the retirement level', !(await a.database.listDueCards(today, 3)).some((card) => card.id === id));
    check('the word is found by its normalised spelling', (await a.database.findCardsByWordKey(marker)).some((card) => card.id === id));
    check('the word is found by the request that created it', (await a.database.findCardByRequestId(markerRequest))?.id === id);
    check('creating it again with the same request returns the same word', (await a.database.createCard({ ...markerCard, requestId: markerRequest })).id === id);
    check('counting words works', (await a.database.countCards()) >= 1 && (await a.database.countCards({ masteryBelow: 4 })) >= 1);
    check('a time zone is stored for A', (await a.database.ensureTimeZone('UTC')) === ((await a.database.getTimeZone()) ?? ''));
    check('an edit is saved', (await a.database.updateCard(id, { example: 'edited by supabase:verify' })) && (await a.database.getCard(id))?.example === 'edited by supabase:verify');
    check('an edit of an unknown field is refused', await a.database.updateCard(id, { user_id: b.userId } as never).then(() => false, () => true));

    // ---- 3. Account B against account A's word ----
    check('account B cannot read A’s word through the app', (await b.database.getCard(id)) === null);
    check('account B’s list does not contain A’s word', !(await b.database.listCards()).some((card) => card.id === id));
    for (const [table, column] of [['vocabulary', 'id'], ['card_states', 'vocabulary_id'], ['review_logs', 'vocabulary_id'], ['vocabulary_cards', 'id']] as const) {
      const read = await attempt(rawB.from(table).select('*').eq(column, id));
      check(`account B cannot read A’s row in ${table}`, nothing(read), `${read.rows.length} rows`);
    }
    const settings = await attempt(rawB.from('user_settings').select('user_id'));
    check(
      'account B sees only its own settings',
      settings.rows.every((row) => (row as { user_id: string }).user_id === b.userId),
    );

    const rename = await attempt(rawB.from('vocabulary').update({ word: 'taken' }).eq('id', id).select('id'));
    check('account B cannot rename A’s word', nothing(rename));
    const trash = await attempt(rawB.from('vocabulary').update({ deleted_at: new Date().toISOString() }).eq('id', id).select('id'));
    check('account B cannot trash A’s word', nothing(trash));
    const boost = await attempt(rawB.from('card_states').update({ mastery: 10 }).eq('vocabulary_id', id).select('vocabulary_id'));
    check('account B cannot change A’s mastery', nothing(boost));
    check('account B cannot edit A’s word through the edit function', !(await b.database.updateCard(id, { word: 'taken' })));
    const stolen = await b.database.applyReview({
      id,
      requestId: randomUUID(),
      action: 'remember',
      expectedMastery: 3,
      expectedReviewDate: today,
      newMastery: 4,
      newReviewDate: today,
      reviewedOn: today,
      durationMs: null,
    });
    check('account B cannot review A’s word', stolen.outcome === 'not_found', stolen.outcome);
    const forged = await attempt(rawB.from('vocabulary').insert({ user_id: a.userId, word: 'forged', word_key: 'forged' }).select('id'));
    check('account B cannot write a row under A’s user id', refused(forged) && nothing(forged));
    const planted = await attempt(
      rawB.from('review_logs').insert({
        vocabulary_id: id,
        request_id: randomUUID(),
        action: 'remember',
        reviewed_on: today,
        mastery_before: 3,
        mastery_after: 4,
      }).select('id'),
    );
    check('account B cannot add history to A’s word', refused(planted) && nothing(planted));

    const untouched = await a.database.getCard(id);
    check('A’s word is unchanged after all of that', untouched?.word === marker && untouched.mastery === 3 && untouched.review_date === today && untouched.deleted_at === null);

    // ---- 4. Saving a review: once, atomically ----
    const requestId = randomUUID();
    const tomorrow = calendarDateInTimeZone(new Date(Date.now() + 86_400_000), 'UTC');
    const review = {
      id,
      requestId,
      action: 'remember',
      expectedMastery: 3,
      expectedReviewDate: today,
      newMastery: 4,
      newReviewDate: tomorrow,
      reviewedOn: today,
      durationMs: 1200,
    };
    const first = await a.database.applyReview(review);
    check('a review is saved', first.outcome === 'applied' && first.mastery === 4 && first.review_date === tomorrow, first.outcome);
    const retry = await a.database.applyReview(review);
    check('the same review sent again is not applied twice', retry.outcome === 'already_applied' && retry.mastery === 4, retry.outcome);
    const stale = await a.database.applyReview({ ...review, requestId: randomUUID(), action: 'not_remember', newMastery: 3 });
    check('a second device’s stale answer is refused', stale.outcome === 'conflict', stale.outcome);
    const history = await attempt(rawA.from('review_logs').select('id, mastery_before, mastery_after').eq('vocabulary_id', id));
    check('exactly one history row was written', history.rows.length === 1, `${history.rows.length} rows`);
    const recorded = await a.database.findReviewByRequestId(requestId);
    check('the saved review can be looked up by its request id', recorded?.mastery === 4 && recorded.reviewDate === tomorrow);
    check('B cannot look up A’s review by its request id', (await b.database.findReviewByRequestId(requestId)) === null);

    // ---- 4b. Sessions and Undo (from schema version 2) ----
    const version = await a.database.schemaVersion();
    console.log(`\nDatabase schema version ${version}; this app can use up to ${LATEST_SCHEMA_VERSION}.`);
    if (version < 2) {
      console.log('SKIP  sessions and Undo: needs database version 2. Run the newer SQL files in supabase/migrations, oldest first.');
    } else {
      const sessionId = randomUUID();
      const second = {
        ...review,
        requestId: randomUUID(),
        expectedMastery: 4,
        expectedReviewDate: tomorrow,
        newMastery: 5,
        newReviewDate: tomorrow,
        sessionId,
      };
      const saved = await a.database.recordReview(second);
      check('an answer is saved as part of a session', saved.outcome === 'applied' && saved.mastery === 5, saved.outcome);
      const mineSummary = await a.database.sessionSummary(sessionId);
      check('the session summary counts it', mineSummary?.reviewed === 1 && mineSummary.remembered === 1);
      check('account B cannot see A’s session', (await b.database.sessionSummary(sessionId)) === null);
      const foreignUndo = await b.database.undoReview({ reviewRequestId: second.requestId, requestId: randomUUID() });
      check('account B cannot undo A’s answer', foreignUndo.outcome === 'not_found', foreignUndo.outcome);
      const olderUndo = await a.database.undoReview({ reviewRequestId: requestId, requestId: randomUUID() });
      check('an answer with a newer one after it cannot be undone', olderUndo.outcome === 'not_latest', olderUndo.outcome);

      const undoId = randomUUID();
      const undoneNow = await a.database.undoReview({ reviewRequestId: second.requestId, requestId: undoId });
      check('the latest answer can be undone', undoneNow.outcome === 'undone' && undoneNow.mastery === 4, undoneNow.outcome);
      const undoneAgain = await a.database.undoReview({ reviewRequestId: second.requestId, requestId: undoId });
      check('undoing it again changes nothing', undoneAgain.outcome === 'already_undone', undoneAgain.outcome);
      const replay = await a.database.recordReview(second);
      check('an undone answer is not saved again by a late retry', replay.outcome === 'undone', replay.outcome);
      const afterUndo = await a.database.sessionSummary(sessionId);
      check('the summary no longer counts it, and records the undo', afterUndo?.reviewed === 0 && afterUndo.undone === 1);
      const trail = await attempt(rawA.from('review_logs').select('kind').eq('vocabulary_id', id));
      const kinds = trail.rows.map((row) => (row as { kind: string }).kind).sort().join(',');
      check('the history keeps both answers and the undo', kinds === 'review,review,undo', kinds);
    }

    // ---- 4c. FSRS stored alongside (from schema version 3) ----
    if (version < 3) {
      console.log('SKIP  FSRS alongside the mastery schedule: needs database version 3.');
    } else {
      const after = fsrsReview(null, FSRS_RATINGS.good, new Date());
      const third = {
        ...review,
        requestId: randomUUID(),
        expectedMastery: 4,
        expectedReviewDate: tomorrow,
        newMastery: 5,
        newReviewDate: tomorrow,
        sessionId: randomUUID(),
        fsrs: { rating: FSRS_RATINGS.good, version: FSRS_ENGINE, before: null, after: fsrsStateToRow(after, FSRS_ENGINE) },
      };
      const savedWithFsrs = await a.database.recordReview(third);
      check('an answer is saved together with its FSRS state', savedWithFsrs.outcome === 'applied', savedWithFsrs.outcome);
      const scheduled = await a.database.getCard(id);
      const stored = scheduled === null ? null : fsrsOfCard(scheduled);
      check(
        'the FSRS state is stored beside the mastery schedule, which still sets the review date',
        scheduled?.mastery === 5 &&
          scheduled.review_date === tomorrow &&
          stored !== null &&
          Math.abs(stored.state.stability - after.stability) < 0.001,
      );
      check('account B cannot see that state', (await b.database.getCard(id)) === null);
      const undoneFsrs = await a.database.undoReview({ reviewRequestId: third.requestId, requestId: randomUUID() });
      const restored = await a.database.getCard(id);
      check(
        'undoing that answer restores the mastery schedule and removes the FSRS state it added',
        undoneFsrs.outcome === 'undone' && restored?.mastery === 4 && restored !== null && fsrsOfCard(restored) === null,
        undoneFsrs.outcome,
      );
    }

    // ---- 4d. Review statistics (from schema version 4) ----
    if (version < 4) {
      console.log('SKIP  review statistics: needs database version 4.');
    } else {
      const mine = (await a.database.cardReviewStats(today)).find((row) => row.vocabulary_id === id);
      check(
        'A’s statistics count the one answer that stands, and none that were undone',
        mine?.reviews === 1 && mine.failures === 0 && mine.last_action === 'remember',
        mine === undefined ? 'no row for the word' : `${mine.reviews} reviews`,
      );
      const daily = await a.database.reviewDailyStats(today, today);
      check('A’s daily figures include today', daily.reduce((total, row) => total + row.reviews, 0) >= 1);
      check(
        'account B’s statistics do not include A’s word',
        !(await b.database.cardReviewStats(today)).some((row) => row.vocabulary_id === id),
      );
      const strangerStats = await attempt(anon.rpc('review_daily_stats', { p_from: today, p_to: today }));
      check('a signed-out visitor cannot read review statistics', refused(strangerStats) && nothing(strangerStats));
    }

    // ---- 4e. Daily goal and confidence ratings (from schema version 5) ----
    if (version < 5) {
      console.log('SKIP  daily goal and confidence ratings: needs database version 5.');
    } else {
      const mineBefore = (await a.database.getSettings())?.dailyGoal ?? { reviews: null, minutes: null };
      const theirsBefore = (await b.database.getSettings())?.dailyGoal ?? null;
      const goal = await a.database.saveDailyGoal({ reviews: 7, minutes: 3 });
      check('account A can keep a daily goal', goal.reviews === 7 && goal.minutes === 3);
      const theirsAfter = (await b.database.getSettings())?.dailyGoal ?? null;
      check('account B’s own goal is untouched by it', JSON.stringify(theirsAfter) === JSON.stringify(theirsBefore));
      const outOfRange = await attempt(rawA.from('user_settings').update({ daily_goal_reviews: 0 }).eq('user_id', a.userId).select('user_id'));
      check('a goal outside its limits is refused by the database', refused(outOfRange) && nothing(outOfRange));
      const unmoved = await a.database.getCard(id);
      check('setting a goal changed no word', unmoved?.mastery === 4 && unmoved.review_date === tomorrow);
      // Put A's goal back as it was found.
      await a.database.saveDailyGoal(mineBefore);

      const ratedAt = async () => (await a.database.confidenceStats(today)).find((row) => row.confidence === 3)?.reviews ?? 0;
      const ratedBefore = await ratedAt();
      const sure = {
        ...review,
        requestId: randomUUID(),
        expectedMastery: 4,
        expectedReviewDate: tomorrow,
        newMastery: 5,
        newReviewDate: tomorrow,
        sessionId: randomUUID(),
        confidence: 3,
      };
      const savedSure = await a.database.recordReview(sure);
      check('an answer is saved with its confidence rating', savedSure.outcome === 'applied' && savedSure.mastery === 5, savedSure.outcome);
      check('the rating is counted for A', (await ratedAt()) === ratedBefore + 1);
      const undoneSure = await a.database.undoReview({ reviewRequestId: sure.requestId, requestId: randomUUID() });
      check(
        'undoing that answer takes its rating out of the count and restores the word',
        undoneSure.outcome === 'undone' && undoneSure.mastery === 4 && (await ratedAt()) === ratedBefore,
        undoneSure.outcome,
      );
      const strangerRatings = await attempt(anon.rpc('confidence_stats', { p_since: today }));
      check('a signed-out visitor cannot read confidence statistics', refused(strangerRatings) && nothing(strangerRatings));
    }

    // ---- 4f. Practice (from schema version 6) ----
    if (version < 6) {
      console.log('SKIP  practice in other study modes: needs database version 6.');
    } else {
      const practiceId = randomUUID();
      const practice = {
        id,
        requestId: practiceId,
        sessionId: randomUUID(),
        mode: 'typing',
        correct: false,
        grading: 'auto' as const,
        submitted: 'supabase-verify',
        reviewedOn: today,
        durationMs: 900,
        confidence: null,
      };
      check('a practice answer is recorded', (await a.database.recordPractice(practice)) === 'recorded');
      check('the same practice answer sent again is not recorded twice', (await a.database.recordPractice(practice)) === 'already_recorded');
      const afterPractice = await a.database.getCard(id);
      check(
        'practice left the word’s mastery and review date exactly as they were',
        afterPractice?.mastery === 4 && afterPractice.review_date === tomorrow,
      );
      check(
        'account B cannot record practice against A’s word',
        (await b.database.recordPractice({ ...practice, requestId: randomUUID(), sessionId: null })) === 'not_found',
      );
      const mineToday = (await a.database.practiceDailyStats(today, today)).reduce((total, row) => total + row.answers, 0);
      check('A’s practice figures include it', mineToday >= 1);

      // Practice mastery is counted from correct practice answers, so a wrong one must not appear in the count.
      const correctBefore = (await a.database.listCorrectPracticeModes(id)).filter((mode) => mode === 'typing').length;
      check('a wrong practice answer adds nothing to the word’s practice mastery', correctBefore === 0, `${correctBefore} counted`);
      const right = { ...practice, requestId: randomUUID(), correct: true };
      await a.database.recordPractice(right);
      await a.database.recordPractice(right);
      const correctAfter = (await a.database.listCorrectPracticeModes(id)).filter((mode) => mode === 'typing').length;
      check('a correct one adds exactly one, however often it is sent', correctAfter === 1, `${correctAfter} counted`);
      check('account B sees none of A’s practice when counting', (await b.database.listCorrectPracticeModes(id)).length === 0);
      const reviewsAfterPractice = (await a.database.cardReviewStats(today)).find((row) => row.vocabulary_id === id);
      check('practice is not counted as a review', reviewsAfterPractice?.reviews === 1, `${reviewsAfterPractice?.reviews ?? 0} reviews`);
      const forgedPractice = await attempt(
        rawA.from('review_logs').insert({
          vocabulary_id: id,
          request_id: randomUUID(),
          kind: 'practice',
          action: 'remember',
          review_mode: 'typing',
          reviewed_on: today,
          answer_correct: true,
          grading: 'auto',
          mastery_before: 4,
          mastery_after: 9,
        } as never),
      );
      check('a practice row that claims a change of mastery is refused by the database', refused(forgedPractice));
      const strangerPractice = await attempt(anon.rpc('practice_daily_stats', { p_from: today, p_to: today }));
      check('a signed-out visitor cannot read practice figures', refused(strangerPractice) && nothing(strangerPractice));
    }

    // ---- 4g. Collections, further examples, relationships (from schema version 7) ----
    if (version < 7) {
      console.log('SKIP  collections, examples and related words: needs database version 7.');
    } else {
      const collectionName = `zz-verify-${randomUUID().slice(0, 8)}`;
      const made = await a.database.insertCollection(collectionName, collectionName);
      if (made === 'duplicate') {
        check('account A can create a collection', false, 'the name was already taken');
      } else {
        check('account A can create a collection', made.name === collectionName);
        check('a second collection with the same name is refused', (await a.database.insertCollection(collectionName, collectionName)) === 'duplicate');
        check('account A can put its word in the collection', await a.database.addCollectionItem(made.id, id));
        check('account B cannot put anything in A’s collection', !(await b.database.addCollectionItem(made.id, id)));
        check('account B cannot see A’s collection', !(await b.database.listCollections()).some((row) => row.id === made.id));
        check('account B cannot rename A’s collection', (await b.database.renameCollection(made.id, 'taken', 'taken')) === null);
        check('account B cannot delete A’s collection', !(await b.database.deleteCollection(made.id)));

        const extra = await a.database.insertExample(id, 'Added by supabase:verify.', null);
        check('account A can add a further example to its word', extra !== null);
        check('account B cannot add an example to A’s word', (await b.database.insertExample(id, 'x', null)) === null);
        if (extra !== null) {
          check('account B cannot read, edit or remove A’s example', (await b.database.getExample(extra.id)) === null && !(await b.database.deleteExample(extra.id)));
          check('account A can remove its example', await a.database.deleteExample(extra.id));
        }
        check('a word cannot be linked to itself or to a word that is not there', (await a.database.insertRelation(id, randomUUID(), 'related').catch(() => null)) === null);

        check('account A can delete its collection', await a.database.deleteCollection(made.id));
        const kept = await a.database.getCard(id);
        check(
          'deleting the collection left the word exactly as it was',
          kept !== null && kept.deleted_at === null && kept.mastery === 4 && kept.review_date === tomorrow,
        );
      }
      for (const table of ['collections', 'collection_items', 'vocabulary_examples', 'vocabulary_relations']) {
        const read = await attempt(anon.from(table).select('*').limit(1));
        check(`signed-out visitor cannot read ${table}`, nothing(read) && refused(read));
      }
    }

    // ---- 4h. Choosing which schedule is in charge (from schema version 8) ----
    if (version < 8) {
      console.log('SKIP  choosing between the mastery schedule and FSRS: needs database version 8.');
    } else {
      const mineBefore = (await a.database.getSettings())?.scheduler ?? 'mastery_v1';
      const theirsBefore = (await b.database.getSettings())?.scheduler ?? null;
      const wordBefore = await a.database.getCard(id);
      try {
        check('account A can put FSRS in charge', (await a.database.saveScheduler('fsrs')) === 'fsrs');
        check('account B’s own choice is untouched by it', ((await b.database.getSettings())?.scheduler ?? null) === theirsBefore);
        const taken = await attempt(rawB.from('user_settings').update({ scheduler: 'mastery_v1' }).eq('user_id', a.userId).select('user_id'));
        check('account B cannot change A’s choice', nothing(taken) && (await a.database.getSettings())?.scheduler === 'fsrs');
        const unknown = await attempt(rawA.from('user_settings').update({ scheduler: 'other' }).eq('user_id', a.userId).select('user_id'));
        check('a schedule the app does not have is refused by the database', refused(unknown) && nothing(unknown));

        // With FSRS in charge an answer that carries no FSRS result must not be saved.
        const bare = await attempt(
          rawA.rpc('record_review', {
            p_event: {
              vocabulary_id: id,
              request_id: randomUUID(),
              action: 'remember',
              expected_mastery: wordBefore?.mastery ?? 4,
              expected_review_date: wordBefore?.review_date ?? null,
              new_mastery: (wordBefore?.mastery ?? 4) + 1,
              new_review_date: tomorrow,
              reviewed_on: today,
            },
          }),
        );
        check('with FSRS in charge, an answer without its FSRS result is refused', refused(bare) && nothing(bare));
        check('account A can go back to the mastery schedule', (await a.database.saveScheduler('mastery_v1')) === 'mastery_v1');
        const wordAfter = await a.database.getCard(id);
        check(
          'changing the schedule, both ways, changed nothing stored for the word',
          wordAfter !== null &&
            wordBefore !== null &&
            wordAfter.mastery === wordBefore.mastery &&
            wordAfter.review_date === wordBefore.review_date &&
            wordAfter.fsrs_due === wordBefore.fsrs_due,
        );
      } finally {
        // Put A's choice back as it was found, whatever happened above.
        await a.database.saveScheduler(mineBefore).catch(() => undefined);
      }
    }

    // ---- 5. History and rows cannot be destroyed ----
    const editLog = await attempt(rawA.from('review_logs').update({ mastery_after: 9 }).eq('vocabulary_id', id).select('id'));
    check('history cannot be edited, even by its owner', refused(editLog) && nothing(editLog));
    const dropLog = await attempt(rawA.from('review_logs').delete().eq('vocabulary_id', id).select('id'));
    check('history cannot be deleted, even by its owner', refused(dropLog) && nothing(dropLog));
    const dropWord = await attempt(rawA.from('vocabulary').delete().eq('id', id).select('id'));
    check('a word cannot be removed outright', refused(dropWord) && nothing(dropWord));
    check('the word and its history are still there', (await a.database.getCard(id)) !== null);

    // ---- 6. The trash ----
    check('the word can be trashed', await a.database.setCardTrashed(id, true));
    check('a trashed word leaves the list and appears in the trash', !(await a.database.listCards()).some((card) => card.id === id) && (await a.database.listTrashedCards()).some((card) => card.id === id));
    check('a trashed word can be restored with its state', (await a.database.setCardTrashed(id, false)) && (await a.database.getCard(id))?.mastery === 4);
  } finally {
    // The only clean-up that exists: the trash.
    const trashed = await a.database.setCardTrashed(id, true).catch(() => false);
    const inTrash = trashed || (await a.database.getCard(id).catch(() => null))?.deleted_at != null;
    console.log(`\nMarker word "${marker}" ${inTrash ? 'is in' : 'could NOT be moved to'} account A’s trash.`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  if (failed.length > 0) console.log('RESULT: FAILED. Do not cut over until every check passes.');
  else console.log('RESULT: isolation, idempotent saving and append-only history hold on this project.');
  return failed.length === 0 ? 0 : 3;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'The check could not run.');
    process.exitCode = 1;
  },
);
