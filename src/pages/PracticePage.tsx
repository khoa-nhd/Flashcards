import { useEffect, useMemo, useRef, useState } from 'react';
import { RECENTLY_ADDED_DAYS, pageIdSchema, type PracticeResponse, type VocabularyEntry } from '../../shared/api.js';
import { addDays, compareDates } from '../../shared/dates.js';
import {
  EXPERIMENTAL_MODES,
  INELIGIBLE_TEXT,
  STUDY_MODES,
  STUDY_MODE_LABELS,
  STUDY_MODE_SUMMARY,
  answerText,
  buildChoices,
  ineligibility,
  isStudyMode,
  judge,
  selectForPractice,
  type Choice,
  type Ineligible,
  type PracticeAnswer,
  type PracticeWord,
  type StudyMode,
} from '../../shared/study-modes.js';
import { useApp, useLibrary, useSettings, useVocabulary } from '../app-context.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { PracticeCard, Verdict, type PracticeVerdict } from '../components/PracticeCards.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, PAGE, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { usePracticeStats, type WordPracticeStats } from '../hooks/usePracticeStats.js';
import { invalidateAllPracticeHistory } from '../lib/practice-history-cache.js';
import type { PracticePayload } from '../lib/offline/ops.js';
import { count } from '../lib/format.js';
import { formatDate } from '../components/badges.js';
import { startTiming } from '../lib/perf.js';
import { newRequestId } from '../lib/request-id.js';
import { ROUTES, buildHref, openWord, useLocation } from '../lib/router.js';
import { SPEECH_LANGUAGES, speechAvailable, type SpeechLanguage } from '../lib/speech.js';

const SOURCES = ['due', 'weak', 'recent', 'all'] as const;
/** One of the built-in sets, or one collection. */
type Source = (typeof SOURCES)[number] | `collection:${string}`;

const SOURCE_LABELS: Record<(typeof SOURCES)[number], string> = {
  due: 'Words due for review',
  weak: 'Weak words',
  recent: `Added in the last ${RECENTLY_ADDED_DAYS} days`,
  all: 'All words',
};

const LENGTHS = [5, 10, 20, 50] as const;

const isSource = (value: string | null): value is (typeof SOURCES)[number] =>
  SOURCES.includes(value as (typeof SOURCES)[number]);

/** The set of words an address asks for: a collection if it names one, otherwise a built-in set. */
function sourceFromQuery(query: URLSearchParams): Source {
  const collection = query.get('collection');
  if (collection !== null && pageIdSchema.safeParse(collection).success) return `collection:${collection}`;
  const source = query.get('source');
  return isSource(source) ? source : 'due';
}

const toPracticeWord = (entry: VocabularyEntry): PracticeWord => ({
  id: entry.id,
  word: entry.word,
  meaning: entry.meaning,
  definition: entry.definition,
  example: entry.example,
});

interface Outcome {
  word: PracticeWord;
  correct: boolean;
  /** False when the server judged the answer but did not record it. */
  recorded: boolean;
}

interface Run {
  mode: StudyMode;
  sessionId: string;
  words: PracticeWord[];
  /** Recognition choices, drawn once per question so a re-render never reshuffles them. */
  choices: Array<Choice[] | null>;
  index: number;
  shownAt: number;
  given: PracticeAnswer | null;
  requestId: string | null;
  /** How long the question was on screen before it was answered; measured once, so a retry repeats it. */
  durationMs: number;
  /** Judged locally at once, then confirmed by the server's own answer. */
  verdict: PracticeVerdict | null;
  error: string | null;
}

/**
 * Practice in the other study modes. Everything here is recorded for the
 * reviewer's statistics and nothing here changes a word's schedule.
 */
export function PracticePage() {
  const { api, settings: preferences, sync } = useApp();
  const { speechLang } = useSettings();
  const state = useVocabulary();
  const { query } = useLocation();
  // Listening needs the browser to be able to read text aloud. Asked once: it does not change while the page is open.
  const [canSpeak] = useState(speechAvailable);
  const weak = useRemote(api.fetchWeakWords, 'Could not load your weak words.');
  const { statsMap, loading: statsLoading, error: statsError, reload: reloadStats } = usePracticeStats();

  const [mode, setMode] = useState<StudyMode>(() => {
    const requested = query.get('mode');
    return isStudyMode(requested) ? requested : 'recognition';
  });
  const [source, setSource] = useState<Source>(() => sourceFromQuery(query));
  const { collections } = useLibrary();
  const [length, setLength] = useState<number>(10);
  const [run, setRun] = useState<Run | null>(null);
  const [finished, setFinished] = useState<{ mode: StudyMode; outcomes: Outcome[] } | null>(null);
  /** Every answered question's outcome, kept outside `run` so a confirmation still lands after moving on. */
  const outcomes = useRef<Map<number, Outcome>>(new Map());
  /** Where each answer sent to the outbox belongs, so its fate can be applied whenever it comes back. */
  const sent = useRef(new Map<string, { sessionId: string; index: number; word: PracticeWord; correct: boolean }>());
  /** The sitting on screen; a late confirmation from an older one (or a new one) is ignored. */
  const liveSession = useRef<string | null>(null);
  /** The weak list the sitting started from, so any word that left it can be named. */
  const weakBefore = useRef<Map<string, string> | null>(null);
  const [recovered, setRecovered] = useState<readonly string[]>([]);

  // Name any word that left the weak list during the sitting that just ended.
  useEffect(() => {
    if (finished === null) return;
    const before = weakBefore.current;
    if (before === null) return;
    let active = true;
    api
      .fetchWeakWords()
      .then((weak) => {
        if (!active) return;
        const after = new Set(weak.words.map((word) => word.id));
        setRecovered([...before].filter(([id]) => !after.has(id)).map(([, word]) => word));
      })
      .catch(() => setRecovered([]));
    return () => {
      active = false;
    };
  }, [api, finished]);

  const today = state.meta?.today ?? null;
  const fsrsOnly = state.meta?.fsrsOnly === true;
  const pool = useMemo(() => state.entries.map(toPracticeWord), [state.entries]);
  const candidates = useMemo(() => {
    const entries = state.entries.filter((entry) => {
      if (source === 'due') return entry.reviewable;
      if (source === 'recent') {
        if (entry.dateAdded === null || today === null) return false;
        return compareDates(entry.dateAdded, addDays(today, -(RECENTLY_ADDED_DAYS - 1))) >= 0 && compareDates(entry.dateAdded, today) <= 0;
      }
      if (source === 'weak') return weak.data?.words.some((word) => word.id === entry.id) ?? false;
      if (source.startsWith('collection:')) {
        const wanted = source.slice('collection:'.length);
        return collections.find((collection) => collection.id === wanted)?.wordIds.includes(entry.id) ?? false;
      }
      return true;
    });
    return entries.map(toPracticeWord);
  }, [state.entries, source, today, weak.data, collections]);

  // Prioritise words that haven't been practised yet (totalAnswers === 0)
  const sortedCandidates = useMemo(() => {
    return [...candidates].sort((a, b) => {
      const statsA = statsMap.get(a.id);
      const statsB = statsMap.get(b.id);
      const practicedA = statsA && statsA.totalAnswers > 0;
      const practicedB = statsB && statsB.totalAnswers > 0;
      if (!practicedA && practicedB) return -1;
      if (practicedA && !practicedB) return 1;
      return 0;
    });
  }, [candidates, statsMap]);

  // What each mode can use from the chosen words, and why the rest are left out.
  const usable = useMemo(() => {
    const reasons = new Map<Ineligible, number>();
    let ready = 0;
    for (const word of sortedCandidates) {
      const reason = ineligibility(mode, word, pool);
      if (reason === null) ready += 1;
      else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    return { ready, reasons: [...reasons] };
  }, [sortedCandidates, mode, pool]);

  const silent = mode === 'listening' && !canSpeak;

  const start = () => {
    if (silent) return;
    const { words } = selectForPractice(mode, sortedCandidates, pool, length, Math.random);
    if (words.length === 0) return;
    const sessionId = newRequestId();
    setFinished(null);
    weakBefore.current = new Map((weak.data?.words ?? []).map((word) => [word.id, word.word]));
    setRecovered([]);
    outcomes.current = new Map();
    sent.current.clear();
    liveSession.current = sessionId;
    setRun({
      mode,
      sessionId,
      words,
      choices: words.map((word) => (mode === 'recognition' ? buildChoices(word, pool, Math.random) : null)),
      index: 0,
      shownAt: Date.now(),
      given: null,
      requestId: null,
      durationMs: 0,
      verdict: null,
      error: null,
    });
  };

  /** Records a question's outcome, whether or not it is still the one on screen. */
  const rememberOutcome = (index: number, outcome: Outcome) => {
    outcomes.current.set(index, outcome);
    setFinished((latest) => (latest === null ? latest : { ...latest, outcomes: [...outcomes.current.values()] }));
  };

  /**
   * Judges the answer here and shows it at once, then records it in this
   * device's outbox. The verdict comes from the same rules the server judges
   * by, so it never waits for a round trip; the write reaches the server when
   * it can, and its confirmation says what was recorded and how the word's
   * mastery in this mode moved.
   */
  const answer = (current: Run, given: PracticeAnswer, durationMs: number) => {
    const word = current.words[current.index];
    if (word === undefined) return;
    const judged = judge(current.mode, word, given);
    if (judged === null) return;
    // Judged here, from the same rules the server uses: the verdict does not wait.
    const done = startTiming('practice.verdict');
    rememberOutcome(current.index, { word, correct: judged.correct, recorded: state.meta?.writesEnabled !== false });
    const payload: PracticePayload = {
      pageId: word.id,
      mode: current.mode,
      answer: given,
      sessionId: current.sessionId,
      durationMs,
      confidence: null,
    };
    // Recorded before it is sent: the next question never waits on the network.
    const requestId = sync.enqueue({ kind: 'practice', entity: word.id, payload });
    sent.current.set(requestId, {
      sessionId: current.sessionId,
      index: current.index,
      word,
      correct: judged.correct,
    });
    setRun({
      ...current,
      given,
      requestId,
      durationMs,
      verdict: {
        correct: judged.correct,
        typed: judged.typed,
        expected: judged.expected,
        modeMastery: null,
        outcome: 'pending',
      },
      error: null,
    });
    done();
  };

  // What became of every practice answer this page recorded. A confirmation
  // matters even once the next question is up, so it is applied by request id.
  useEffect(
    () =>
      sync.subscribeEvents((event) => {
        if (event.op.kind !== 'practice') return;
        const record = sent.current.get(event.op.id);
        if (record === undefined) return;
        if (event.type === 'settled') {
          sent.current.delete(event.op.id);
          const result = event.value as PracticeResponse | undefined;
          // A recorded answer changes True Mastery, which is computed from this history.
          if (result !== undefined && result.outcome !== 'dry_run') invalidateAllPracticeHistory();
          if (liveSession.current === record.sessionId) {
            rememberOutcome(record.index, {
              word: record.word,
              correct: result?.correct ?? record.correct,
              recorded: result !== undefined && result.outcome !== 'dry_run',
            });
          }
          const confirmed: PracticeVerdict | null =
            result === undefined
              ? null
              : {
                  correct: result.correct,
                  typed: result.typed,
                  expected: result.expected,
                  modeMastery: result.modeMastery,
                  outcome: result.outcome,
                };
          setRun((latest) =>
            latest === null || latest.sessionId !== record.sessionId || latest.requestId !== event.op.id
              ? latest
              : { ...latest, error: null, verdict: confirmed ?? latest.verdict },
          );
        } else if (event.type === 'refused') {
          // Kept in `sent`: a retry still has to know where the answer belongs.
          if (liveSession.current === record.sessionId) {
            rememberOutcome(record.index, { word: record.word, correct: record.correct, recorded: false });
          }
          const message = event.op.lastError ?? 'Could not record that answer.';
          setRun((latest) =>
            latest === null || latest.sessionId !== record.sessionId || latest.requestId !== event.op.id
              ? latest
              : { ...latest, error: message },
          );
        }
      }),
    // The event subscription is long-lived; the remembered helpers only touch refs and setState.
    [sync],
  );

  /** Sends a refused answer again, under the same id, so one that did arrive is never recorded twice. */
  const retry = () => {
    if (run === null || run.requestId === null) return;
    const record = sent.current.get(run.requestId);
    if (record !== undefined) {
      rememberOutcome(record.index, {
        word: record.word,
        correct: record.correct,
        recorded: state.meta?.writesEnabled !== false,
      });
    }
    sync.retry(run.requestId);
    setRun({
      ...run,
      error: null,
      verdict: run.verdict === null ? null : { ...run.verdict, outcome: 'pending' },
    });
  };

  const next = () => {
    if (run === null) return;
    if (run.index + 1 >= run.words.length) {
      liveSession.current = null;
      setFinished({ mode: run.mode, outcomes: [...outcomes.current.values()] });
      setRun(null);
      return;
    }
    setRun({
      ...run,
      index: run.index + 1,
      shownAt: Date.now(),
      given: null,
      requestId: null,
      durationMs: 0,
      verdict: null,
      error: null,
    });
  };

  const word = run?.words[run.index] ?? null;

  return (
    <div className={PAGE}>
      <PageHeader
        title="Practice"
        description={
          fsrsOnly
            ? 'Other ways to work on your words. Practice is recorded for your statistics; it never changes memory strength or when a word is due.'
            : 'Other ways to work on your words. Practice is recorded for your statistics; it never changes mastery or review dates.'
        }
        actions={
          run !== null ? (
            <button
              type="button"
              className={BUTTON_SECONDARY}
              onClick={() => {
                liveSession.current = null;
                setFinished(outcomes.current.size > 0 ? { mode: run.mode, outcomes: [...outcomes.current.values()] } : null);
                setRun(null);
              }}
            >
              End practice
            </button>
          ) : undefined
        }
      />

      <VocabularyGate state={state}>
        {run !== null && word !== null ? (
          <div className="mx-auto flex max-w-xl flex-col gap-4">
            <p className="text-sm text-muted" aria-live="polite">
              {STUDY_MODE_LABELS[run.mode]} · Question {run.index + 1} of {run.words.length}
            </p>
            <PracticeCard
              key={`${run.sessionId}:${run.index}`}
              mode={run.mode}
              word={word}
              choices={run.choices[run.index] ?? null}
              verdict={run.verdict}
              given={run.given}
              speechLang={speechLang}
              onAnswer={(given) => {
                if (run.verdict !== null) return;
                const elapsed = Math.min(Math.max(Date.now() - run.shownAt, 0), 86_400_000);
                answer(run, given, elapsed);
              }}
            />
            {run.error !== null && (
              <div role="alert" className="rounded-2xl border border-bad/40 bg-bad-soft p-4 text-bad-ink">
                <p className="font-semibold">That answer was not saved</p>
                <p className="mt-1 text-sm">{run.error}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={BUTTON_SECONDARY} onClick={retry}>
                    Try again
                  </button>
                  <button type="button" className={BUTTON_SECONDARY} onClick={next}>
                    Skip this question
                  </button>
                </div>
              </div>
            )}
            {run.verdict !== null && (
              <Verdict
                mode={run.mode}
                word={word}
                verdict={run.verdict}
                last={run.index + 1 >= run.words.length}
                onNext={next}
              />
            )}
          </div>
        ) : (
          <div className="flex max-w-2xl flex-col gap-6">
            {finished !== null && <Summary mode={finished.mode} outcomes={finished.outcomes} recovered={recovered} />}

            <section className={`${CARD} flex flex-col gap-4 p-5`} aria-labelledby="practice-setup-title">
              <h2 id="practice-setup-title" className={SECTION_TITLE}>
                {finished === null ? 'Start a practice session' : 'Practise again'}
              </h2>

              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-1 text-sm font-medium">How</legend>
                {STUDY_MODES.map((key) => (
                  <label
                    key={key}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
                      mode === key ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-muted'
                    }`}
                  >
                    <input
                      type="radio"
                      name="practice-mode"
                      className="mt-0.5 size-4 accent-[var(--accent)]"
                      checked={mode === key}
                      onChange={() => setMode(key)}
                    />
                    <span>
                      <span className="font-medium">{STUDY_MODE_LABELS[key]}</span>
                      {EXPERIMENTAL_MODES.includes(key) && (
                        <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                          Experimental
                        </span>
                      )}
                      <span className={`block ${HELP}`}>{STUDY_MODE_SUMMARY[key]}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {mode === 'listening' &&
                (canSpeak ? (
                  <div className="flex flex-col gap-1.5 sm:max-w-xs">
                    <label htmlFor="practice-accent" className="text-sm font-medium">
                      Accent
                    </label>
                    <select
                      id="practice-accent"
                      className={INPUT}
                      value={speechLang}
                      aria-describedby="practice-accent-help"
                      onChange={(event) => preferences.update({ speechLang: event.target.value as SpeechLanguage })}
                    >
                      {SPEECH_LANGUAGES.map(([code, label]) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <p id="practice-accent-help" className={HELP}>
                      The word is read by this browser’s own voice. Nothing is sent anywhere, and no recording is used,
                      so how it sounds depends on your device, which may not have a voice for every accent.
                    </p>
                  </div>
                ) : (
                  <p role="alert" className="rounded-xl border border-line px-4 py-3 text-sm">
                    This browser cannot read text aloud, so Listening is not available here. The other ways to practise
                    work as usual.
                  </p>
                ))}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="practice-source" className="text-sm font-medium">
                    Which words
                  </label>
                  <select
                    id="practice-source"
                    className={INPUT}
                    value={source}
                    onChange={(event) => setSource(event.target.value as Source)}
                  >
                    {SOURCES.map((key) => (
                      <option key={key} value={key} disabled={key === 'weak' && weak.status === 'failed'}>
                        {SOURCE_LABELS[key]}
                        {key === 'weak' && weak.status === 'failed' ? ' (could not be loaded)' : ''}
                      </option>
                    ))}
                    {collections.length > 0 && (
                      <optgroup label="Collections">
                        {collections.map((collection) => (
                          <option key={collection.id} value={`collection:${collection.id}`}>
                            {collection.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="practice-length" className="text-sm font-medium">
                    How many
                  </label>
                  <select
                    id="practice-length"
                    className={INPUT}
                    value={length}
                    onChange={(event) => setLength(Number(event.target.value))}
                  >
                    {LENGTHS.map((value) => (
                      <option key={value} value={value}>
                        Up to {value}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="text-sm" role="status">
                {source === 'weak' && weak.status === 'loading' ? (
                  <p className="text-muted">Loading your weak words...</p>
                ) : (
                  <>
                    <p>
                      <strong className="font-semibold tabular-nums">{usable.ready}</strong> of{' '}
                      <span className="tabular-nums">{count(candidates.length, 'word')}</span> can be used for{' '}
                      {STUDY_MODE_LABELS[mode].toLowerCase()}.
                    </p>
                    {usable.reasons.length > 0 && (
                      <ul className="m-0 mt-1 flex list-disc flex-col gap-0.5 pl-4 text-xs text-muted">
                        {usable.reasons.map(([reason, amount]) => (
                          <li key={reason}>
                            {count(amount, 'word')} left out: {amount === 1 ? 'it' : 'each'} {INELIGIBLE_TEXT[reason]}.
                          </li>
                        ))}
                      </ul>
                    )}
                    {candidates.length === 0 && <p className="mt-1 text-xs text-muted">No words match this choice right now.</p>}
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={BUTTON_PRIMARY} disabled={usable.ready === 0 || silent} onClick={start}>
                  Start
                </button>
                <span className={HELP}>Questions come in a random order. Unpractised words are prioritised.</span>
              </div>
            </section>

            <PracticeStatsTable statsMap={statsMap} loading={statsLoading} error={statsError} onReload={reloadStats} />
          </div>
        )}
      </VocabularyGate>
    </div>
  );
}

function Summary({ mode, outcomes, recovered = [] }: { mode: StudyMode; outcomes: Outcome[]; recovered?: readonly string[] }) {
  const fsrsOnly = useVocabulary().meta?.fsrsOnly === true;
  const correct = outcomes.filter((outcome) => outcome.correct).length;
  const missed = outcomes.filter((outcome) => !outcome.correct);
  const unrecorded = outcomes.filter((outcome) => !outcome.recorded).length;
  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`} aria-label="Practice summary">
      <h2 className="font-serif text-2xl font-semibold">Practice finished</h2>
      <p className="text-sm">
        {STUDY_MODE_LABELS[mode]}: <strong className="font-semibold tabular-nums">{correct}</strong> of{' '}
        <span className="tabular-nums">{count(outcomes.length, 'answer')}</span> correct
        {outcomes.length > 0 && ` (${Math.round((correct / outcomes.length) * 100)}%)`}.
      </p>
      {recovered.length > 0 && (
        <p className="rounded-2xl bg-good-soft px-3 py-2 text-sm text-good-ink">
          {recovered.length === 1
            ? `“${recovered[0]}” has left your weak list.`
            : `${recovered.length} words have left your weak list: ${recovered.join(', ')}.`}
        </p>
      )}
      {missed.length > 0 && (
        <div>
          <p className="text-sm font-medium">To look at again</p>
          <ul className="m-0 mt-1 flex list-none flex-col divide-y divide-line p-0 text-sm">
            {missed.map(({ word }, index) => (
              <li key={`${word.id}:${index}`} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                <button
                  type="button"
                  onClick={() => openWord(word.id)}
                  className="cursor-pointer font-medium underline-offset-2 hover:underline"
                >
                  {word.word}
                </button>
                <span className="text-muted">{answerText(word)?.text ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className={HELP}>
        {unrecorded === 0
          ? fsrsOnly
            ? 'These answers are recorded under Insights. Your memory strength and review schedule are unchanged.'
            : 'These answers are recorded under Insights. Your mastery levels and review dates are unchanged.'
          : `${count(unrecorded, 'answer was', 'answers were')} judged but not recorded: saving is switched off, or the database needs its latest update. ${
              fsrsOnly
                ? 'Your memory strength and review schedule are unchanged.'
                : 'Your mastery levels and review dates are unchanged.'
            }`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to={ROUTES.review} className={BUTTON_SECONDARY}>
          Go to review
        </Link>
        <Link to={buildHref(ROUTES.insights)} className={BUTTON_SECONDARY}>
          See Insights
        </Link>
      </div>
    </section>
  );
}

function PracticeStatsTable({
  statsMap,
  loading,
  error,
  onReload,
}: {
  statsMap: Map<string, WordPracticeStats>;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}) {
  const fsrsOnly = useVocabulary().meta?.fsrsOnly === true;
  if (loading) {
    return (
      <section className={`${CARD} p-5`} aria-label="Practice statistics">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-sm text-muted">Loading practice statistics…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={`${CARD} p-5`} aria-label="Practice statistics">
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-bad-ink">
            {error}
          </p>
          <button type="button" className={BUTTON_SECONDARY} onClick={onReload}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  // Filter to only words with practice data
  const wordsWithPractice = Array.from(statsMap.values()).filter((stats) => stats.totalAnswers > 0);

  if (wordsWithPractice.length === 0) {
    return (
      <section className={`${CARD} p-5`} aria-label="Practice statistics">
        <h3 className={SECTION_TITLE}>Practice statistics per word</h3>
        <p className="mt-3 text-sm text-muted">
          No practice recorded yet. Start a practice session to see statistics here.
        </p>
      </section>
    );
  }

  // Collect all modes used across all words for column headers
  const allModes = new Set<string>();
  for (const stats of wordsWithPractice) {
    for (const mode of stats.modes) {
      allModes.add(mode.mode);
    }
  }
  const modeList = Array.from(allModes).sort();

  return (
    <section className={`${CARD} p-5`} aria-label="Practice statistics">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={SECTION_TITLE}>Practice statistics per word</h3>
        <span className="text-xs text-muted">{wordsWithPractice.length} word{wordsWithPractice.length !== 1 ? 's' : ''} with practice data</span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th scope="col" className="py-1 font-medium sticky left-0 bg-surface z-10 px-3">Word</th>
              {modeList.map((mode) => (
                <th key={mode} scope="col" className="py-1 text-right font-medium px-3">
                  {STUDY_MODE_LABELS[mode as keyof typeof STUDY_MODE_LABELS] ?? mode}
                </th>
              ))}
              <th scope="col" className="py-1 text-right font-medium px-3">Total</th>
              <th scope="col" className="py-1 text-right font-medium px-3">Accuracy</th>
              <th scope="col" className="py-1 text-right font-medium px-3">Last practised</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {wordsWithPractice
              .sort((a, b) => {
                const accuracyA = a.totalAnswers > 0 ? a.totalCorrect / a.totalAnswers : 0;
                const accuracyB = b.totalAnswers > 0 ? b.totalCorrect / b.totalAnswers : 0;
                return accuracyA - accuracyB;
              })
              .map((stats) => (
                <tr key={stats.vocabularyId} className="border-t border-line">
                  <th scope="row" className="py-2 text-left font-medium sticky left-0 bg-surface z-10 px-3">
                    <button
                      type="button"
                      onClick={() => openWord(stats.vocabularyId)}
                      className="cursor-pointer hover:underline"
                    >
                      {stats.word}
                    </button>
                  </th>
                  {modeList.map((mode) => {
                    const modeStat = stats.modes.find((m) => m.mode === mode);
                    if (!modeStat) {
                      return <td key={mode} className="py-2 text-right text-muted px-3">—</td>;
                    }
                    const accuracy = modeStat.total > 0 ? Math.round((modeStat.correct / modeStat.total) * 100) : 0;
                    return (
                      <td key={mode} className="py-2 text-right px-3">
                        <span className="font-medium">{modeStat.correct}</span>
                        <span className="text-muted"> / {modeStat.total}</span>
                        <span className="ml-1 text-xs text-muted">({accuracy}%)</span>
                      </td>
                    );
                  })}
                  <td className="py-2 text-right font-medium px-3">
                    {stats.totalCorrect} / {stats.totalAnswers}
                  </td>
                  <td className="py-2 text-right px-3">
                    {stats.totalAnswers > 0
                      ? `${Math.round((stats.totalCorrect / stats.totalAnswers) * 100)}%`
                      : '—'}
                  </td>
                  <td className="py-2 text-right text-muted px-3">
                    {stats.lastPractisedOn ? formatDate(stats.lastPractisedOn, 'short') : '—'}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted">
        Shows correct / total answers per mode. Click a word to open its details.
        {fsrsOnly
          ? 'Practice score (capped at 3 per mode) is shown in the word detail panel.'
          : 'Practice mastery (capped at 3 per mode) is shown in the word detail panel.'}
      </p>
    </section>
  );
}