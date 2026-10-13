import { useMemo, useRef, useState, type FormEvent } from 'react';
import { RECENTLY_ADDED_DAYS, TYPED_ANSWER_LIMITS, pageIdSchema, type PracticeResponse, type VocabularyEntry } from '../../shared/api.js';
import { addDays, compareDates } from '../../shared/dates.js';
import {
  INELIGIBLE_TEXT,
  STUDY_MODES,
  STUDY_MODE_LABELS,
  STUDY_MODE_SUMMARY,
  answerText,
  buildChoices,
  ineligibility,
  selectForPractice,
  type Choice,
  type Ineligible,
  type PracticeAnswer,
  type PracticeWord,
  type StudyMode,
} from '../../shared/study-modes.js';
import { useApp, useLibrary, useSettings, useVocabulary } from '../app-context.js';
import { useFocusMode } from '../components/AppShell.js';
import { FocusTimer } from '../components/FocusTimer.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Checking, PracticeCard, Verdict } from '../components/PracticeCards.js';
import { SpeakButton } from '../components/SpeakButton.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, PAGE, SECTION_TITLE, TEXTAREA } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { count } from '../lib/format.js';
import { newRequestId } from '../lib/request-id.js';
import { ROUTES, buildHref, openWord, useLocation } from '../lib/router.js';
import { SPEECH_LANGUAGES, speechAvailable, type SpeechLanguage } from '../lib/speech.js';

const SOURCES = ['due', 'weak', 'recent', 'all'] as const;
/** One of the built-in sets, one collection, or the words missed in an exam. */
type Source = (typeof SOURCES)[number] | `collection:${string}` | `missed:${string}`;
/** Same ceiling the exam report uses, so a drill address fits in a browser. */
const MAX_MISSED = 30;

const SOURCE_LABELS: Record<(typeof SOURCES)[number], string> = {
  due: 'Words due for review',
  weak: 'Weak words',
  recent: `Added in the last ${RECENTLY_ADDED_DAYS} days`,
  all: 'All words',
};

const LENGTHS = [5, 10, 20, 50] as const;

const isMode = (value: string | null): value is StudyMode => STUDY_MODES.includes(value as StudyMode);
const isSource = (value: string | null): value is (typeof SOURCES)[number] =>
  SOURCES.includes(value as (typeof SOURCES)[number]);

/** The set of words an address asks for: a collection if it names one, otherwise a built-in set. */
function sourceFromQuery(query: URLSearchParams): Source {
  const collection = query.get('collection');
  if (collection !== null && pageIdSchema.safeParse(collection).success) return `collection:${collection}`;
  const source = query.get('source');
  if (source !== null && source.startsWith('missed:')) {
    // The exam report's drill: a list of word ids, kept only if at least one is a real id.
    const ids = source
      .slice('missed:'.length)
      .split(',')
      .filter((id) => pageIdSchema.safeParse(id).success)
      .slice(0, MAX_MISSED);
    if (ids.length > 0) return `missed:${ids.join(',')}`;
  }
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
  checking: boolean;
  result: PracticeResponse | null;
  error: string | null;
  outcomes: Outcome[];
}

/**
 * Practice in the other study modes. Everything here is recorded for the
 * reviewer's statistics and nothing here changes a word's schedule.
 */
export function PracticePage() {
  const { api, settings: preferences } = useApp();
  const { speechLang } = useSettings();
  const focusMode = useFocusMode();
  const state = useVocabulary();
  const { query } = useLocation();
  // Listening needs the browser to be able to read text aloud. Asked once: it does not change while the page is open.
  const [canSpeak] = useState(speechAvailable);
  const weak = useRemote(api.fetchWeakWords, 'Could not load your weak words.');

  const [mode, setMode] = useState<StudyMode>(() => (isMode(query.get('mode')) ? (query.get('mode') as StudyMode) : 'recognition'));
  const [source, setSource] = useState<Source>(() => sourceFromQuery(query));
  const { collections } = useLibrary();
  const [length, setLength] = useState<number>(10);
  const [run, setRun] = useState<Run | null>(null);
  const [finished, setFinished] = useState<{ mode: StudyMode; outcomes: Outcome[] } | null>(null);
  /** Names the question an answer was sent for, so a late reply cannot land on a later one. */
  const asked = useRef('');

  const today = state.meta?.today ?? null;
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
      if (source.startsWith('missed:')) {
        const wanted = new Set(source.slice('missed:'.length).split(','));
        return wanted.has(entry.id);
      }
      return true;
    });
    return entries.map(toPracticeWord);
  }, [state.entries, source, today, weak.data, collections]);

  // What each mode can use from the chosen words, and why the rest are left out.
  const usable = useMemo(() => {
    const reasons = new Map<Ineligible, number>();
    let ready = 0;
    for (const word of candidates) {
      const reason = ineligibility(mode, word, pool);
      if (reason === null) ready += 1;
      else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    return { ready, reasons: [...reasons] };
  }, [candidates, mode, pool]);

  const silent = mode === 'listening' && !canSpeak;

  const start = () => {
    if (silent) return;
    const { words } = selectForPractice(mode, candidates, pool, length, Math.random);
    if (words.length === 0) return;
    setFinished(null);
    setRun({
      mode,
      sessionId: newRequestId(),
      words,
      choices: words.map((word) => (mode === 'recognition' ? buildChoices(word, pool, Math.random) : null)),
      index: 0,
      shownAt: Date.now(),
      given: null,
      requestId: null,
      durationMs: 0,
      checking: false,
      result: null,
      error: null,
      outcomes: [],
    });
  };

  const send = async (current: Run, given: PracticeAnswer, requestId: string, durationMs: number) => {
    const word = current.words[current.index];
    if (word === undefined) return;
    const ticket = `${current.sessionId}:${current.index}:${requestId}`;
    asked.current = ticket;
    const sending = { ...current, given, requestId, durationMs };
    setRun({ ...sending, checking: true, error: null });
    try {
      const result = await api.submitPractice({
        pageId: word.id,
        mode: current.mode,
        answer: given,
        requestId,
        sessionId: current.sessionId,
        durationMs,
      });
      if (asked.current !== ticket) return;
      setRun({
        ...sending,
        checking: false,
        result,
        error: null,
        outcomes: [...current.outcomes, { word, correct: result.correct, recorded: result.outcome !== 'dry_run' }],
      });
    } catch (cause) {
      if (asked.current !== ticket) return;
      setRun({
        ...sending,
        checking: false,
        error: cause instanceof ApiError ? cause.message : 'Could not check that answer.',
      });
    }
  };

  const next = () => {
    if (run === null) return;
    asked.current = '';
    if (run.index + 1 >= run.words.length) {
      setFinished({ mode: run.mode, outcomes: run.outcomes });
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
      checking: false,
      result: null,
      error: null,
    });
  };

  const word = run?.words[run.index] ?? null;

  /** Sends what was given for the question on screen, timed from when it first appeared. */
  const onAnswer = (given: PracticeAnswer) => {
    if (run === null || run.result !== null || run.checking) return;
    const elapsed = Math.min(Math.max(Date.now() - run.shownAt, 0), 86_400_000);
    void send(run, given, newRequestId(), elapsed);
  };

  return (
    <div className={PAGE}>
      <PageHeader
        title="Practice"
        description="Other ways to work on your words. Practice is recorded for your statistics; it never changes mastery or review dates."
        actions={
          <>
            <button
              type="button"
              className={`${BUTTON_SECONDARY} aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent`}
              aria-pressed={focusMode.on}
              title="Hide the navigation and show a timer, for studying without distractions."
              onClick={focusMode.toggle}
            >
              Focus
            </button>
            {focusMode.on && <FocusTimer />}
            {run !== null && (
              <button
                type="button"
                className={BUTTON_SECONDARY}
                onClick={() => {
                  asked.current = '';
                  setFinished(run.outcomes.length > 0 ? { mode: run.mode, outcomes: run.outcomes } : null);
                  setRun(null);
                }}
              >
                End practice
              </button>
            )}
          </>
        }
      />

      <VocabularyGate state={state}>
        {run !== null && word !== null ? (
          <div className="mx-auto flex max-w-xl flex-col gap-4">
            <p className="text-sm text-muted" aria-live="polite">
              {STUDY_MODE_LABELS[run.mode]} · Question {run.index + 1} of {run.words.length}
            </p>
            {run.mode === 'writing' ? (
              <WritingCard
                key={`${run.sessionId}:${run.index}`}
                word={word}
                result={run.result}
                given={run.given}
                checking={run.checking}
                onAnswer={onAnswer}
                speechLang={speechLang}
              />
            ) : (
              <PracticeCard
                key={`${run.sessionId}:${run.index}`}
                mode={run.mode}
                word={word}
                choices={run.choices[run.index] ?? null}
                result={run.result}
                given={run.given}
                checking={run.checking}
                speechLang={speechLang}
                onAnswer={onAnswer}
              />
            )}
            {run.checking && <Checking />}
            {run.error !== null && (
              <div role="alert" className="rounded-2xl border border-bad/40 bg-bad-soft p-4 text-bad-ink">
                <p className="font-semibold">That answer was not checked</p>
                <p className="mt-1 text-sm">{run.error}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={BUTTON_SECONDARY}
                    onClick={() => {
                      // The same request, id included, so an answer that did arrive is not recorded twice.
                      if (run.given !== null && run.requestId !== null) {
                        void send(run, run.given, run.requestId, run.durationMs);
                      }
                    }}
                  >
                    Try again
                  </button>
                  <button type="button" className={BUTTON_SECONDARY} onClick={next}>
                    Skip this question
                  </button>
                </div>
              </div>
            )}
            {run.result !== null && (
              <Verdict mode={run.mode} word={word} result={run.result} last={run.index + 1 >= run.words.length} onNext={next} />
            )}
            {run.mode === 'writing' && run.result !== null && <CoachNote result={run.result} />}
          </div>
        ) : (
          <div className="flex max-w-2xl flex-col gap-6">
            {finished !== null && <Summary mode={finished.mode} outcomes={finished.outcomes} />}

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
                    {source.startsWith('missed:') && <option value={source}>Words you missed in an exam</option>}
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
                  <p className="text-muted">Loading your weak words…</p>
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
                <span className={HELP}>Questions come in a random order.</span>
              </div>
            </section>

            <section className={`${CARD} flex flex-col gap-3 p-5`} aria-labelledby="practice-exam-title">
              <h2 id="practice-exam-title" className={SECTION_TITLE}>
                Exam practice
              </h2>
              <p className="text-sm text-muted">
                Put several sections together — a way of asking, a length, and optionally a time limit each — and sit the
                whole thing as one test with a report at the end.
              </p>
              <div>
                <Link to={ROUTES.exam} className={BUTTON_SECONDARY}>
                  Build an exam
                </Link>
              </div>
            </section>
          </div>
        )}
      </VocabularyGate>
    </div>
  );
}

/** The card a question is shown on, as the practice cards draw it. */
const PROMPT = 'rounded-3xl border border-line bg-surface px-6 py-8 text-center shadow-[0_1px_2px_rgb(0_0_0/0.04)]';
const PROMPT_LABEL = 'text-xs font-semibold uppercase tracking-[0.12em] text-muted';

interface WritingCardProps {
  word: PracticeWord;
  /** The server's verdict, once it has answered. Until then the card is still being asked. */
  result: PracticeResponse | null;
  /** The answer that was sent, kept so the card can show the sentence as it was judged. */
  given: PracticeAnswer | null;
  /** The answer is on its way to the server. */
  checking: boolean;
  onAnswer: (answer: PracticeAnswer) => void;
  /** The accent the word is read in, the same setting listening uses. */
  speechLang?: string;
}

/**
 * The Writing Challenge's editor: a whole sentence rather than one word.
 * Only this page builds it; the shared practice card stays a single line,
 * and the verdict below still comes from the server.
 */
function WritingCard({ word, result, given, checking, onAnswer, speechLang = 'en-US' }: WritingCardProps) {
  const [text, setText] = useState('');
  const answered = result !== null;
  const shown = given?.kind === 'typed' ? given.text : text;
  const meaning = answerText(word)?.text ?? null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Something written, not just spaces: that is what "checked" means here too.
    if (answered || checking || text.trim() === '') return;
    onAnswer({ kind: 'typed', text });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className={PROMPT}>
        <p className={PROMPT_LABEL}>Word</p>
        <p className="mt-2 font-serif text-3xl font-semibold">{word.word}</p>
        <div className="mt-2 flex justify-center">
          <SpeakButton word={word.word} lang={speechLang} />
        </div>
        {meaning !== null && <p className="mt-3 text-sm text-muted">{meaning}</p>}
        {word.example !== null && <p className="mt-3 text-sm text-muted">{word.example}</p>}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor="practice-writing" className="text-sm font-medium">
          Your sentence
        </label>
        <textarea
          id="practice-writing"
          className={TEXTAREA}
          value={shown}
          readOnly={answered}
          disabled={checking}
          autoFocus
          maxLength={TYPED_ANSWER_LIMITS.writing}
          placeholder={`Write a sentence using “${word.word}”.`}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={HELP} aria-live="polite">
            {shown.length} of {TYPED_ANSWER_LIMITS.writing} characters
          </p>
          {!answered && (
            <button type="submit" className={BUTTON_PRIMARY} disabled={checking || text.trim() === ''}>
              Submit
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * The Writing Challenge's coach note, under the verdict. It is extra guidance
 * only: the verdict above already stands, whether the coach answered or not.
 */
function CoachNote({ result }: { result: PracticeResponse }) {
  const feedback = result.aiFeedback ?? null;
  const modelAnswer = result.modelAnswer ?? null;
  if (feedback === null && modelAnswer === null) {
    return <p className={HELP}>No coach note this time — check it yourself.</p>;
  }
  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`} aria-label="Coach feedback">
      {feedback !== null && (
        <div>
          <h3 className={SECTION_TITLE}>Coach feedback</h3>
          <p className="mt-1.5 text-sm">{feedback}</p>
        </div>
      )}
      {modelAnswer !== null && (
        <div>
          <h3 className={SECTION_TITLE}>Model answer</h3>
          <p className="mt-1.5 text-sm">{modelAnswer}</p>
        </div>
      )}
    </section>
  );
}

function Summary({ mode, outcomes }: { mode: StudyMode; outcomes: Outcome[] }) {
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
          ? 'These answers are recorded under Insights. Your mastery levels and review dates are unchanged.'
          : `${count(unrecorded, 'answer was', 'answers were')} judged but not recorded: saving is switched off, or the database needs its latest update. Your mastery levels and review dates are unchanged.`}
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
