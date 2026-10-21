import { useEffect, useMemo, useState } from 'react';
import { type PracticeResponse, type VocabularyEntry } from '../../shared/api.js';
import { type AiExamPlanResponse } from '../../shared/ai.js';
import {
  EXAM_MODES,
  STUDY_MODE_LABELS,
  buildChoices,
  ineligibility,
  selectForPractice,
  type Choice,
  type PracticeAnswer,
  type PracticeWord,
  type StudyMode,
} from '../../shared/study-modes.js';
import { useApp, useSettings, useVocabulary } from '../app-context.js';
import { useFocusMode } from '../components/AppShell.js';
import { FocusTimer } from '../components/FocusTimer.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Checking, PracticeCard, Verdict } from '../components/PracticeCards.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, PAGE, SECTION_TITLE } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';
import { count } from '../lib/format.js';
import { newRequestId } from '../lib/request-id.js';
import { ROUTES, buildHref, openWord } from '../lib/router.js';
import { speechAvailable } from '../lib/speech.js';

const COUNT_MIN = 1;
const COUNT_MAX = 50;
const SECTION_MINUTES_MAX = 120;
const OVERALL_MINUTES_MAX = 360;
/** More than this and the address for the drill link would outgrow a browser. */
const MAX_DRILL_WORDS = 30;
const MAX_SECTIONS = 6;

const asClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const toPracticeWord = (entry: VocabularyEntry): PracticeWord => ({
  id: entry.id,
  word: entry.word,
  meaning: entry.meaning,
  definition: entry.definition,
  example: entry.example,
});

/** One section as the builder describes it. */
interface Spec {
  id: string;
  mode: StudyMode;
  count: number;
  /** Minutes for this section on its own clock; null means it is counted only by questions. */
  minutes: number | null;
}

/** One answer as it came back from the server, kept for the report. */
interface Answered {
  given: PracticeAnswer;
  result: PracticeResponse;
}

interface SectionRun {
  spec: Spec;
  words: PracticeWord[];
  /** Recognition choices, drawn once per question so a re-render never reshuffles them. */
  choices: Array<Choice[] | null>;
  answers: Array<Answered | null>;
  index: number;
  /** This section's own clock, or null when the section is untimed. */
  secondsLeft: number | null;
  /** The section's clock ran out; its remaining questions count as not answered. */
  locked: boolean;
  /** When the question on screen first appeared, for the answer's recorded duration. */
  shownAt: number;
  checking: boolean;
  result: PracticeResponse | null;
  given: PracticeAnswer | null;
  requestId: string | null;
  durationMs: number;
  error: string | null;
}

interface ExamRun {
  sessionId: string;
  sections: SectionRun[];
  active: number;
  /** The whole exam's clock, or null when no overall limit was set. */
  overallLeft: number | null;
}

/** The reader stepped through every question of the section — it is done, verdicts included. */
const isViewedThrough = (section: SectionRun) => section.index >= section.words.length;

/** What was said for a question, in words the report can print: typed text, or the chosen choice. */
function givenText(section: SectionRun, index: number, answer: Answered): string | null {
  const given = answer.given;
  if (given.kind === 'typed') return given.text;
  if (given.kind === 'choice') {
    return section.choices[index]?.find((choice) => choice.id === given.selectedId)?.text ?? null;
  }
  // Recall is not an exam kind; nothing else can be said.
  return null;
}

/**
 * A test the reviewer builds for themselves: several sections, each a kind of
 * question with its own length and an optional time limit, one optional clock
 * for the whole exam, free movement between the sections, and a report at the
 * end with the missed words to practise. Every answer goes through the same
 * recorded path practice uses: it never changes mastery or a review date.
 */
export function ExamPage() {
  const { api } = useApp();
  const { speechLang } = useSettings();
  const state = useVocabulary();
  // Sitting a test is the other place worth studying without the navigation in the way.
  const focusMode = useFocusMode();
  // Listening sections need the browser to be able to read text aloud. Asked once for the page.
  const [canSpeak] = useState(speechAvailable);

  const [phase, setPhase] = useState<'build' | 'run' | 'report'>('build');
  const [specs, setSpecs] = useState<Spec[]>([{ id: 's1', mode: 'recognition', count: 10, minutes: null }]);
  const [overallMinutes, setOverallMinutes] = useState<number | null>(null);
  const [run, setRun] = useState<ExamRun | null>(null);
  // The AI's suggested structure: a draft with its reason, accepted by pressing
  // "Use this plan" — it never replaces the sections on its own.
  const [plan, setPlan] = useState<AiExamPlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const pool = useMemo(() => state.entries.map(toPracticeWord), [state.entries]);

  /** How many words each section could actually draw from, for the builder's notes. */
  const usableFor = useMemo(() => {
    const byMode = new Map<StudyMode, number>();
    for (const spec of specs) {
      if (byMode.has(spec.mode)) continue;
      byMode.set(spec.mode, pool.filter((word) => ineligibility(spec.mode, word, pool) === null).length);
    }
    return byMode;
  }, [specs, pool]);

  const silentListening = specs.some((spec) => spec.mode === 'listening') && !canSpeak;
  const startable =
    specs.length > 0 && specs.every((spec) => spec.count >= 1 && (usableFor.get(spec.mode) ?? 0) > 0) && !silentListening;

  /** The words a plan is drawn over: the 30 weakest in this pool, weakest first. */
  const planWordIds = () =>
    [...state.entries]
      .sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0) || a.word.localeCompare(b.word))
      .slice(0, 30)
      .map((entry) => entry.id);

  const suggestPlan = async () => {
    const words = planWordIds();
    if (words.length === 0) return;
    setPlanning(true);
    setPlanError(null);
    try {
      setPlan(await api.examPlan({ words }));
    } catch (cause) {
      setPlanError(cause instanceof ApiError ? cause.message : 'Could not ask for a plan.');
    } finally {
      setPlanning(false);
    }
  };

  /** The draft becomes the sections; the reader can still change every field by hand. */
  const applyPlan = (draft: AiExamPlanResponse) => {
    setSpecs(
      draft.sections.map((section) => ({
        id: newRequestId(),
        mode: section.mode,
        count: section.count,
        minutes: section.minutes,
      })),
    );
    setOverallMinutes(null);
    setPlan(null);
    setPlanError(null);
  };

  const start = () => {
    if (!startable) return;
    const sections: SectionRun[] = specs.map((spec) => {
      const { words } = selectForPractice(spec.mode, pool, pool, spec.count, Math.random);
      return {
        spec,
        words,
        choices: words.map((word) => (spec.mode === 'recognition' ? buildChoices(word, pool, Math.random) : null)),
        answers: words.map(() => null),
        index: 0,
        secondsLeft: spec.minutes === null ? null : spec.minutes * 60,
        locked: false,
        shownAt: Date.now(),
        checking: false,
        result: null,
        given: null,
        requestId: null,
        durationMs: 0,
        error: null,
      };
    });
    setRun({ sessionId: newRequestId(), sections, active: 0, overallLeft: overallMinutes === null ? null : overallMinutes * 60 });
    setPhase('run');
  };

  // One tick a second while the exam runs: the whole exam's clock always, and the
  // open section's own clock only while it is open — stepping away pauses that one.
  useEffect(() => {
    if (phase !== 'run') return;
    const id = setInterval(() => {
      setRun((current) => {
        if (current === null) return current;
        const sections = current.sections.map((section, index) =>
          index === current.active && section.secondsLeft !== null && !section.locked && section.secondsLeft > 0
            ? { ...section, secondsLeft: section.secondsLeft - 1 }
            : section,
        );
        const overallLeft = current.overallLeft === null ? null : Math.max(current.overallLeft - 1, 0);
        return { ...current, sections, overallLeft };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  // What a clock reaching zero does is decided here, never inside a state update.
  // Stepping through a section is not one of them: the completion panel waits
  // for its own "See the report", so the reader chooses when to stop.
  useEffect(() => {
    if (phase !== 'run' || run === null) return;
    if (run.overallLeft === 0 || run.sections.every((section) => section.locked)) {
      setPhase('report');
      return;
    }
    const section = run.sections[run.active];
    if (section === undefined) return;
    if (section.secondsLeft === 0 && !section.locked) {
      setRun({
        ...run,
        sections: run.sections.map((item, index) => (index === run.active ? { ...item, locked: true } : item)),
      });
    }
  }, [phase, run]);

  const section = run?.sections[run.active] ?? null;
  const word = section?.words[section.index] ?? null;

  /** Checks one answer; a reply only lands if the section still waits for exactly this one. */
  const send = async (sectionIndex: number, current: SectionRun, given: PracticeAnswer, requestId: string, durationMs: number) => {
    const target = current.words[current.index];
    if (target === undefined) return;
    setRun((latest) => {
      if (latest === null) return latest;
      return {
        ...latest,
        sections: latest.sections.map((item, index) =>
          index === sectionIndex ? { ...item, given, requestId, durationMs, checking: true, error: null } : item,
        ),
      };
    });
    try {
      const result = await api.submitPractice({
        pageId: target.id,
        mode: current.spec.mode,
        answer: given,
        requestId,
        sessionId: `${run?.sessionId}:${sectionIndex}`,
        durationMs,
      });
      setRun((latest) => {
        if (latest === null) return latest;
        return {
          ...latest,
          sections: latest.sections.map((item, index) => {
            // A later answer or a step past this question has taken over: drop the late reply.
            if (index !== sectionIndex || item.requestId !== requestId) return item;
            return {
              ...item,
              checking: false,
              result,
              error: null,
              answers: item.answers.map((existing, i) => (i === item.index ? { given, result } : existing)),
            };
          }),
        };
      });
    } catch (cause) {
      setRun((latest) => {
        if (latest === null) return latest;
        return {
          ...latest,
          sections: latest.sections.map((item, index) => {
            if (index !== sectionIndex || item.requestId !== requestId) return item;
            return {
              ...item,
              checking: false,
              error: cause instanceof ApiError ? cause.message : 'Could not check that answer.',
            };
          }),
        };
      });
    }
  };

  /** Sends what was given for the question on screen, timed from when it first appeared. */
  const onAnswer = (given: PracticeAnswer) => {
    if (run === null || section === null || section.result !== null || section.checking || section.locked) return;
    const elapsed = Math.min(Math.max(Date.now() - section.shownAt, 0), 86_400_000);
    const requestId = newRequestId();
    void send(run.active, section, given, requestId, elapsed);
  };

  /** Steps to the next question; the last one leaves the section read through. */
  const next = () => {
    if (run === null || section === null) return;
    const atEnd = section.index + 1 >= section.words.length;
    setRun({
      ...run,
      sections: run.sections.map((item, index) =>
        index === run.active
          ? {
              ...item,
              index: atEnd ? item.words.length : item.index + 1,
              shownAt: Date.now(),
              given: null,
              requestId: null,
              durationMs: 0,
              checking: false,
              result: null,
              error: null,
            }
          : item,
      ),
    });
  };

  const goToSection = (index: number) => {
    if (run === null) return;
    // The question the reader comes back to starts its measured time from now.
    setRun({
      ...run,
      active: index,
      sections: run.sections.map((item, i) => (i === index ? { ...item, shownAt: Date.now() } : item)),
    });
  };

  // The report is read off the run itself, so a late reply cannot change what was seen.
  const report = useMemo(() => {
    if (run === null) return null;
    const missed: Array<{ word: PracticeWord; sectionLabel: string; given: string | null; expected: string | null }> = [];
    let total = 0;
    let correct = 0;
    const rows = run.sections.map((item, index) => {
      const label = `${index + 1}. ${STUDY_MODE_LABELS[item.spec.mode]}`;
      const sectionCorrect = item.answers.filter((answer) => answer !== null && answer.result.correct).length;
      total += item.words.length;
      correct += sectionCorrect;
      item.words.forEach((missedWord, i) => {
        const answer = item.answers[i];
        if (answer === undefined || answer === null) missed.push({ word: missedWord, sectionLabel: label, given: null, expected: null });
        else if (!answer.result.correct) {
          missed.push({
            word: missedWord,
            sectionLabel: label,
            given: givenText(item, i, answer),
            expected: answer.result.expected,
          });
        }
      });
      return {
        label,
        asked: item.words.length,
        correct: sectionCorrect,
        unanswered: item.answers.filter((answer) => answer === null).length,
      };
    });
    const drillMode = run.sections[0]?.spec.mode ?? 'typing';
    const drillIds = missed.slice(0, MAX_DRILL_WORDS).map((item) => item.word.id);
    return {
      rows,
      total,
      correct,
      missed,
      drillTo: buildHref(ROUTES.practice, { mode: drillMode, source: `missed:${drillIds.join(',')}` }),
    };
  }, [run]);

  const restart = () => {
    setRun(null);
    setPhase('build');
  };

  /** Buttons to the sections still worth visiting, used by both end-of-section panels. */
  const elsewhere = (current: ExamRun) =>
    current.sections.flatMap((item, index) =>
      index !== current.active && !item.locked && !isViewedThrough(item) ? (
        <button key={item.spec.id} type="button" className={`${BUTTON_SECONDARY} self-start`} onClick={() => goToSection(index)}>
          Go to section {index + 1} ({STUDY_MODE_LABELS[item.spec.mode]})
        </button>
      ) : null,
    );

  return (
    <div className={PAGE}>
      <PageHeader
        title="Exam"
        description="A test you build yourself: sections of questions, each with its own length and an optional time limit, and a report at the end. Answers are recorded for your statistics like practice, and never change mastery or review dates."
        actions={
          <>
            <button
              type="button"
              className={`${BUTTON_SECONDARY} aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent`}
              aria-pressed={focusMode.on}
              title="Hide the navigation and show a timer, for sitting the exam without distractions."
              onClick={focusMode.toggle}
            >
              Focus
            </button>
            {focusMode.on && <FocusTimer />}
            {phase === 'run' && (
              <button type="button" className={BUTTON_PRIMARY} onClick={() => setPhase('report')}>
                Finish exam
              </button>
            )}
          </>
        }
      />

      <VocabularyGate state={state}>
        {phase === 'run' && run !== null && section !== null ? (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {/* A section can be left and come back to at any moment; only its own clock pauses. */}
            <div role="group" aria-label="Sections" className="flex flex-wrap items-center gap-2">
              {run.sections.map((item, index) => (
                <button
                  key={item.spec.id}
                  type="button"
                  aria-pressed={index === run.active}
                  onClick={() => goToSection(index)}
                  className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition ${
                    index === run.active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
                  }`}
                >
                  {index + 1}. {STUDY_MODE_LABELS[item.spec.mode]}{' '}
                  {item.answers.filter((answer) => answer !== null && answer.result.correct).length}/{item.words.length}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-sm" role="status">
              {run.overallLeft !== null && (
                <span className="rounded-full border border-line px-2.5 py-1 font-semibold tabular-nums">
                  Overall {asClock(run.overallLeft)}
                </span>
              )}
              {section.secondsLeft !== null && !section.locked && (
                <span className="rounded-full border border-line px-2.5 py-1 font-semibold tabular-nums">
                  This section {asClock(section.secondsLeft)}
                </span>
              )}
              <span className="text-muted">
                {STUDY_MODE_LABELS[section.spec.mode]} · Question {Math.min(section.index + 1, section.words.length)} of{' '}
                {section.words.length}
              </span>
            </div>

            {section.locked ? (
              <div className={`${CARD} flex flex-col gap-3 p-5`}>
                <p className="font-semibold">Time is up for this section</p>
                <p className="text-sm text-muted">
                  {section.answers.filter((answer) => answer === null).length > 0
                    ? `${count(section.answers.filter((answer) => answer === null).length, 'question')} left unanswered.`
                    : 'Every question was answered.'}{' '}
                  Move to another section, or finish for the report.
                </p>
                {elsewhere(run)}
                <button type="button" className={`${BUTTON_PRIMARY} self-start`} onClick={() => setPhase('report')}>
                  See the report
                </button>
              </div>
            ) : isViewedThrough(section) ? (
              <div className={`${CARD} flex flex-col gap-3 p-5`}>
                <p className="font-semibold">
                  Section complete — {section.answers.filter((answer) => answer !== null && answer.result.correct).length} of{' '}
                  {section.words.length} correct.
                </p>
                {elsewhere(run)}
                <button type="button" className={`${BUTTON_PRIMARY} self-start`} onClick={() => setPhase('report')}>
                  See the report
                </button>
              </div>
            ) : word === null ? null : (
              <>
                <PracticeCard
                  key={`${run.sessionId}:${run.active}:${section.index}`}
                  mode={section.spec.mode}
                  word={word}
                  choices={section.choices[section.index] ?? null}
                  result={section.result}
                  given={section.given}
                  checking={section.checking}
                  speechLang={speechLang}
                  onAnswer={onAnswer}
                />
                {section.checking && <Checking />}
                {section.error !== null && (
                  <div role="alert" className="rounded-2xl border border-bad/40 bg-bad-soft p-4 text-bad-ink">
                    <p className="font-semibold">That answer was not checked</p>
                    <p className="mt-1 text-sm">{section.error}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={BUTTON_SECONDARY}
                        onClick={() => {
                          // The same request id, so an answer that did arrive is not recorded twice.
                          if (section.given !== null && section.requestId !== null) {
                            void send(run.active, section, section.given, section.requestId, section.durationMs);
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
                {section.result !== null && (
                  <Verdict
                    mode={section.spec.mode}
                    word={word}
                    result={section.result}
                    last={section.index + 1 >= section.words.length}
                    onNext={next}
                  />
                )}
              </>
            )}
          </div>
        ) : phase === 'report' && run !== null && report !== null ? (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <section className={`${CARD} flex flex-col gap-3 p-5`}>
              <h2 className={SECTION_TITLE}>Report</h2>
              <p className="text-4xl font-semibold tabular-nums">
                {report.correct} / {report.total}
              </p>
              <p className="text-sm text-muted">
                {report.missed.length > 0
                  ? `${count(report.missed.length, 'word')} to look at again below.`
                  : 'Nothing was missed — every answer was correct.'}
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {report.rows.map((row) => (
                  <li key={row.label} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>{row.label}</span>
                    <span className="tabular-nums text-muted">
                      {row.correct}/{row.asked} correct{row.unanswered > 0 ? `, ${row.unanswered} unanswered` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {report.missed.length > 0 && (
              <section className={`${CARD} flex flex-col gap-3 p-5`}>
                <h2 className={SECTION_TITLE}>Missed words</h2>
                <ul className="m-0 flex list-none flex-col divide-y divide-line p-0 text-sm">
                  {report.missed.map((item) => (
                    <li key={`${item.sectionLabel}:${item.word.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <button type="button" onClick={() => openWord(item.word.id)} className="cursor-pointer font-semibold hover:underline">
                        {item.word.word}
                      </button>
                      <span className="text-muted">
                        {item.sectionLabel}
                        {item.given !== null ? ` · you said “${item.given}”` : ''}
                        {item.expected !== null ? ` · expected “${item.expected}”` : ' · not answered'}
                      </span>
                    </li>
                  ))}
                </ul>
                {report.missed.length > MAX_DRILL_WORDS && <p className={HELP}>The drill covers the first {MAX_DRILL_WORDS} of them.</p>}
                <div>
                  <Link to={report.drillTo} className={BUTTON_PRIMARY}>
                    Practise the missed words
                  </Link>
                </div>
              </section>
            )}

            <div>
              <button type="button" className={BUTTON_SECONDARY} onClick={restart}>
                Build another exam
              </button>
            </div>
          </div>
        ) : (
          <div className="flex max-w-2xl flex-col gap-6">
            <section className={`${CARD} flex flex-col gap-4 p-5`} aria-labelledby="exam-setup-title">
              <h2 id="exam-setup-title" className={SECTION_TITLE}>
                Build your exam
              </h2>

              <ul className="m-0 flex list-none flex-col gap-4 p-0">
                {specs.map((spec, index) => {
                  const usable = usableFor.get(spec.mode) ?? 0;
                  return (
                    <li key={spec.id} className="flex flex-col gap-2 rounded-2xl border border-line p-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="flex flex-col gap-1.5">
                          <label htmlFor={`exam-mode-${spec.id}`} className="text-sm font-medium">
                            Section {index + 1}: how
                          </label>
                          <select
                            id={`exam-mode-${spec.id}`}
                            className={INPUT}
                            value={spec.mode}
                            onChange={(event) =>
                              setSpecs((current) =>
                                current.map((item) => (item.id === spec.id ? { ...item, mode: event.target.value as StudyMode } : item)),
                              )
                            }
                          >
                            {EXAM_MODES.map((mode) => (
                              <option key={mode} value={mode} disabled={mode === 'listening' && !canSpeak}>
                                {STUDY_MODE_LABELS[mode]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label htmlFor={`exam-count-${spec.id}`} className="text-sm font-medium">
                            Section {index + 1}: questions
                          </label>
                          <input
                            id={`exam-count-${spec.id}`}
                            type="number"
                            min={COUNT_MIN}
                            max={COUNT_MAX}
                            className={`${INPUT} w-24`}
                            value={spec.count}
                            onChange={(event) =>
                              setSpecs((current) =>
                                current.map((item) =>
                                  item.id === spec.id
                                    ? { ...item, count: clamp(Number(event.target.value) || COUNT_MIN, COUNT_MIN, COUNT_MAX) }
                                    : item,
                                ),
                              )
                            }
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label htmlFor={`exam-minutes-${spec.id}`} className="text-sm font-medium">
                            Section {index + 1}: minutes (optional)
                          </label>
                          <input
                            id={`exam-minutes-${spec.id}`}
                            type="number"
                            min={1}
                            max={SECTION_MINUTES_MAX}
                            placeholder="None"
                            className={`${INPUT} w-28`}
                            value={spec.minutes ?? ''}
                            onChange={(event) =>
                              setSpecs((current) =>
                                current.map((item) =>
                                  item.id === spec.id
                                    ? {
                                        ...item,
                                        minutes:
                                          event.target.value === '' ? null : clamp(Number(event.target.value) || 1, 1, SECTION_MINUTES_MAX),
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </div>
                        {specs.length > 1 && (
                          <button
                            type="button"
                            aria-label={`Remove section ${index + 1}`}
                            className={BUTTON_SECONDARY}
                            onClick={() => setSpecs((current) => current.filter((item) => item.id !== spec.id))}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-muted" role="status">
                        {spec.mode === 'listening' && !canSpeak
                          ? 'This browser cannot read aloud, so a listening section cannot be sat here.'
                          : usable < spec.count
                            ? `Only ${count(usable, 'word')} can be used for ${STUDY_MODE_LABELS[spec.mode].toLowerCase()} — this section will have ${count(usable, 'question')}.`
                            : `${count(usable, 'word')} can be used for ${STUDY_MODE_LABELS[spec.mode].toLowerCase()}.`}
                      </p>
                    </li>
                  );
                })}
              </ul>

              <div>
                <button
                  type="button"
                  className={BUTTON_SECONDARY}
                  disabled={specs.length >= MAX_SECTIONS}
                  onClick={() => setSpecs((current) => [...current, { id: newRequestId(), mode: 'typing', count: 10, minutes: null }])}
                >
                  Add a section
                </button>
              </div>

              <div className="flex flex-col gap-2 border-t border-line pt-4">
                <h3 className="text-sm font-medium">Not sure where to start? Let the AI suggest a structure.</h3>
                <div>
                  <button
                    type="button"
                    className={BUTTON_SECONDARY}
                    disabled={planning || state.entries.length === 0}
                    onClick={() => void suggestPlan()}
                  >
                    {planning ? 'Asking the model…' : 'Suggest a plan (AI)'}
                  </button>
                </div>
                <p className={HELP}>
                  Drawn over your 30 weakest words. The result is only a draft with its reason: use it, change any field
                  by hand, then start when the sections read right.
                </p>
                {plan !== null && (
                  <div className="flex flex-col gap-2 rounded-2xl border border-line p-3">
                    <p className="text-sm font-medium">{plan.reason}</p>
                    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                      {plan.sections.map((section, index) => (
                        <li key={`${section.mode}-${index}`} className="flex flex-wrap items-baseline justify-between gap-2">
                          <span>{STUDY_MODE_LABELS[section.mode]}</span>
                          <span className="text-muted">
                            {count(section.count, 'question')}
                            {section.minutes === null ? ', no clock' : ` · ${count(section.minutes, 'minute')}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={BUTTON_PRIMARY} onClick={() => applyPlan(plan)}>
                        Use this plan
                      </button>
                      <button type="button" className={BUTTON_SECONDARY} onClick={() => setPlan(null)}>
                        Discard
                      </button>
                    </div>
                  </div>
                )}
                {planError !== null && (
                  <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
                    {planError}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="exam-overall" className="text-sm font-medium">
                  Time for the whole exam in minutes (optional)
                </label>
                <input
                  id="exam-overall"
                  type="number"
                  min={1}
                  max={OVERALL_MINUTES_MAX}
                  placeholder="No overall limit"
                  className={`${INPUT} w-40`}
                  value={overallMinutes ?? ''}
                  onChange={(event) =>
                    setOverallMinutes(event.target.value === '' ? null : clamp(Number(event.target.value) || 1, 1, OVERALL_MINUTES_MAX))
                  }
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={BUTTON_PRIMARY} disabled={!startable} onClick={start}>
                  Start the exam
                </button>
                <span className={HELP}>Sections can be left and come back to; only the whole exam's clock never stops.</span>
              </div>
            </section>
          </div>
        )}
      </VocabularyGate>
    </div>
  );
}
