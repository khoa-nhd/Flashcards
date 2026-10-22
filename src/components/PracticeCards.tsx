import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { PracticeResponse } from '../../shared/api.js';
import { useVocabulary } from '../app-context.js';
import {
  PRACTICE_MASTERY_MAX,
  STUDY_MODE_LABELS,
  answerText,
  buildCloze,
  type Choice,
  type PracticeAnswer,
  type PracticeWord,
  type StudyMode,
  type TypedResult,
} from '../../shared/study-modes.js';
import { ListenPrompt } from './ListenPrompt.js';
import { Spinner } from './Spinner.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT } from './ui.js';

/**
 * What the card shows about an answer. It is built as soon as the answer is
 * given, from the same rules the server judges by (the modes are deterministic
 * or self-reported), so feedback never waits for a round trip. The server's
 * answer then confirms it: `outcome` is `pending` until it does, and the
 * recorded mastery is only known once it has.
 */
export interface PracticeVerdict {
  correct: boolean;
  typed: TypedResult | null;
  expected: string;
  /** `null` until the server confirms; then the recorded mastery for this word and mode. */
  modeMastery: number | null;
  /** `'pending'` while the answer is on its way; then what the server did with it. */
  outcome: PracticeResponse['outcome'] | 'pending';
}

export interface PracticeCardProps {
  mode: StudyMode;
  word: PracticeWord;
  /** The choices for a recognition question, already drawn and shuffled. */
  choices: Choice[] | null;
  /** The verdict for this question; shown as soon as it is known, before it is saved. */
  verdict: PracticeVerdict | null;
  /** The answer that was sent, kept so the card can show what was chosen. */
  given: PracticeAnswer | null;
  onAnswer: (answer: PracticeAnswer) => void;
  /** The accent the word is read in, for listening. */
  speechLang?: string;
}

const PROMPT = 'rounded-2xl border border-line bg-surface px-6 py-8 text-center shadow-[0_30px_70px_-45px_rgba(0,0,0,0.9)]';
const KEY_HINT = 'hidden rounded border border-current/30 px-1.5 text-xs keyboard:inline';

const typing = (target: EventTarget | null) =>
  target instanceof Element && target.closest('input, textarea, select, [contenteditable]') !== null;

/** Calls `handler` for plain key presses that are not aimed at a field. */
function useKeys(handler: (key: string) => boolean, active: boolean): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (typing(event.target)) return;
      if (latest.current(event.key)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);
}

function Label({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{children}</p>;
}

/** What the reviewer is shown in the modes that start from a meaning. */
function MeaningPrompt({ word }: { word: PracticeWord }) {
  const shown = answerText(word);
  return (
    <div className={PROMPT}>
      <Label>{shown?.kind === 'definition' ? 'Definition' : 'Meaning'}</Label>
      <p className="mt-2 font-serif text-2xl font-semibold">{shown?.text}</p>
      {/* A second clue only where it is a different kind of text from the one above. */}
      {shown?.kind === 'meaning' && word.definition !== null && (
        <p className="mt-3 text-sm text-muted">{word.definition}</p>
      )}
    </div>
  );
}

function Recognition({ word, choices, verdict, given, onAnswer }: PracticeCardProps) {
  const options = choices ?? [];
  const answered = verdict !== null;
  const chosen = given?.kind === 'choice' ? given.selectedId : null;
  useKeys((key) => {
    const index = ['1', '2', '3', '4'].indexOf(key);
    const option = options[index];
    if (option === undefined) return false;
    onAnswer({ kind: 'choice', selectedId: option.id });
    return true;
  }, !answered);

  return (
    <div className="flex flex-col gap-4">
      <div className={PROMPT}>
        <Label>Word</Label>
        <p className="mt-2 font-serif text-3xl font-semibold">{word.word}</p>
      </div>
      <div role="group" aria-label="Choose the meaning" className="flex flex-col gap-2">
        {options.map((option, index) => {
          // Nothing marks the right answer until one has been given.
          const right = answered && option.id === word.id;
          const wrong = answered && option.id === chosen && !right;
          return (
            <button
              key={option.id}
              type="button"
              disabled={answered}
              aria-keyshortcuts={String(index + 1)}
              aria-pressed={option.id === chosen}
              onClick={() => onAnswer({ kind: 'choice', selectedId: option.id })}
              className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2 text-left text-sm font-medium transition disabled:cursor-default ${
                right
                  ? 'border-good bg-good-soft text-good-ink'
                  : wrong
                    ? 'border-bad bg-bad-soft text-bad-ink'
                    : 'border-line bg-surface hover:border-muted disabled:opacity-60'
              }`}
            >
              <kbd aria-hidden="true" className={KEY_HINT}>
                {index + 1}
              </kbd>
              <span className="flex-1">{option.text}</span>
              {right && <span className="text-xs font-semibold">Correct answer</span>}
              {wrong && <span className="text-xs font-semibold">Your choice</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Typed({ mode, word, verdict, given, onAnswer, speechLang = 'en-US' }: PracticeCardProps) {
  const [text, setText] = useState('');
  const answered = verdict !== null;
  const cloze = mode === 'cloze' ? buildCloze(word) : null;
  const submitted = given?.kind === 'typed' ? given.text : text;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (answered || text.trim() === '') return;
    onAnswer({ kind: 'typed', text });
  };

  return (
    <div className="flex flex-col gap-4">
      {mode === 'listening' ? (
        <ListenPrompt text={word.word} lang={speechLang} answered={answered} />
      ) : cloze === null ? (
        <MeaningPrompt word={word} />
      ) : (
        <div className={PROMPT}>
          <Label>Fill in the blank</Label>
          <p className="mt-3 text-lg leading-relaxed">
            {cloze.before}
            <span
              className={`mx-1 inline-block min-w-16 border-b-2 px-1 font-semibold ${
                answered ? (verdict.correct ? 'border-good text-good-ink' : 'border-bad text-bad-ink') : 'border-muted'
              }`}
            >
              {answered ? verdict.expected : <span className="sr-only">blank</span>}
              {!answered && <span aria-hidden="true">&nbsp;</span>}
            </span>
            {cloze.after}
          </p>
          {answerText(word) !== null && <p className="mt-3 text-sm text-muted">{answerText(word)?.text}</p>}
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="practice-answer">
          Your answer
        </label>
        <input
          id="practice-answer"
          className={`${INPUT} h-12 text-base`}
          value={answered ? submitted : text}
          readOnly={answered}
          autoFocus
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={500}
          placeholder="Type the word"
          onChange={(event) => setText(event.target.value)}
        />
        {!answered && (
          <button type="submit" className={`${BUTTON_PRIMARY} h-12`} disabled={text.trim() === ''}>
            Check
          </button>
        )}
      </form>
    </div>
  );
}

/** One practice question, in whichever mode. It shows the verdict it is given; it never decides one itself. */
export function PracticeCard(props: PracticeCardProps) {
  if (props.mode === 'recognition') return <Recognition {...props} />;
  return <Typed {...props} />;
}

const TYPED_TEXT = {
  exact: 'Correct.',
  variant: 'Accepted: the same word, written slightly differently.',
  incorrect: 'Not quite.',
} as const;

export interface VerdictProps {
  mode: StudyMode;
  word: PracticeWord;
  verdict: PracticeVerdict;
  last: boolean;
  onNext: () => void;
}

/**
 * What the answer was, and the way on. The verdict is shown from the local
 * rules the moment the answer is given; a small line says whether the server
 * has confirmed it yet. Focus lands on the button so Enter continues.
 */
export function Verdict({ mode, word, verdict, last, onNext }: VerdictProps) {
  const fsrsOnly = useVocabulary().meta?.fsrsOnly === true;
  const headline = verdict.typed !== null ? TYPED_TEXT[verdict.typed] : verdict.correct ? 'Correct.' : 'Not quite.';
  // For recognition the right choice is already marked above; elsewhere a miss shows the answer.
  const answer = !verdict.correct && mode !== 'recognition' ? verdict.expected : null;
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${
        verdict.correct ? 'border-good/40 bg-good-soft text-good-ink' : 'border-bad/40 bg-bad-soft text-bad-ink'
      }`}
    >
      <div className="min-w-0">
        <p className="font-semibold">{headline}</p>
        {answer !== null && (
          <p className="mt-0.5 text-sm">
            The answer is <strong className="font-semibold">{answer}</strong>
            {mode === 'cloze' && answer.toLowerCase() !== word.word.toLowerCase() ? ` (${word.word})` : ''}.
          </p>
        )}
        {verdict.outcome !== 'pending' && verdict.modeMastery !== null && (
          <p className="mt-0.5 text-xs">
            {STUDY_MODE_LABELS[mode]} {fsrsOnly ? 'practice score' : 'mastery'} for this word: {verdict.modeMastery} of{' '}
            {PRACTICE_MASTERY_MAX}.
          </p>
        )}
        {verdict.outcome === 'dry_run' && <p className="mt-0.5 text-xs">Not recorded.</p>}
        {verdict.outcome === 'pending' && <p className="mt-0.5 text-xs">Saving…</p>}
      </div>
      <button type="button" autoFocus className={BUTTON_SECONDARY} onClick={onNext}>
        {last ? 'Finish' : 'Next'}
      </button>
    </div>
  );
}

export function Checking() {
  return (
    <p role="status" className="flex items-center justify-center gap-2 text-sm text-muted">
      <Spinner /> Checking…
    </p>
  );
}
