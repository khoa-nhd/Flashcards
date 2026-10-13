import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { PracticeResponse } from '../../shared/api.js';
import {
  answerText,
  buildCloze,
  type Choice,
  type PracticeAnswer,
  type PracticeWord,
  type StudyMode,
} from '../../shared/study-modes.js';
import { ListenPrompt } from './ListenPrompt.js';
import { SpeakButton } from './SpeakButton.js';
import { Spinner } from './Spinner.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT } from './ui.js';

export interface PracticeCardProps {
  mode: StudyMode;
  word: PracticeWord;
  /** The choices for a recognition question, already drawn and shuffled. */
  choices: Choice[] | null;
  /** The server's verdict, once it has answered. Until then the card is still being asked. */
  result: PracticeResponse | null;
  /** The answer that was sent, kept so the card can show what was chosen. */
  given: PracticeAnswer | null;
  /** The answer is on its way to the server. */
  checking: boolean;
  onAnswer: (answer: PracticeAnswer) => void;
  /** The accent the word is read in, for listening. */
  speechLang?: string;
}

const PROMPT = 'rounded-3xl border border-line bg-surface px-6 py-8 text-center shadow-[0_1px_2px_rgb(0_0_0/0.04)]';
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

function Recognition({ word, choices, result, given, checking, onAnswer, speechLang = 'en-US' }: PracticeCardProps) {
  const options = choices ?? [];
  const answered = result !== null;
  const chosen = given?.kind === 'choice' ? given.selectedId : null;
  useKeys((key) => {
    const index = ['1', '2', '3', '4'].indexOf(key);
    const option = options[index];
    if (option === undefined) return false;
    onAnswer({ kind: 'choice', selectedId: option.id });
    return true;
  }, !answered && !checking);

  return (
    <div className="flex flex-col gap-4">
      <div className={PROMPT}>
        <Label>Word</Label>
        <p className="mt-2 font-serif text-3xl font-semibold">{word.word}</p>
        <div className="mt-2 flex justify-center">
          <SpeakButton word={word.word} lang={speechLang} />
        </div>
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
              disabled={answered || checking}
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

function Recall({ word, result, checking, onAnswer, speechLang = 'en-US' }: PracticeCardProps) {
  const [shown, setShown] = useState(false);
  const answered = result !== null;
  useKeys((key) => {
    if (!shown) {
      if (key !== ' ') return false;
      setShown(true);
      return true;
    }
    if (key === 'ArrowRight') onAnswer({ kind: 'self', correct: true });
    else if (key === 'ArrowLeft') onAnswer({ kind: 'self', correct: false });
    else return false;
    return true;
  }, !answered && !checking);

  return (
    <div className="flex flex-col gap-4">
      <MeaningPrompt word={word} />
      {!shown ? (
        <button type="button" autoFocus className={BUTTON_PRIMARY} onClick={() => setShown(true)}>
          Show the word
        </button>
      ) : (
        <>
          <div className={PROMPT}>
            <Label>Word</Label>
            <p className="mt-2 font-serif text-3xl font-semibold">{word.word}</p>
            <div className="mt-2 flex justify-center">
              <SpeakButton word={word.word} lang={speechLang} />
            </div>
          </div>
          {!answered && (
            <div role="group" aria-label="Did you recall it?" className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={checking}
                aria-keyshortcuts="ArrowLeft"
                onClick={() => onAnswer({ kind: 'self', correct: false })}
                className="flex h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl border border-bad/35 bg-bad-soft text-base font-semibold text-bad-ink hover:border-bad disabled:opacity-60"
              >
                <kbd aria-hidden="true" className={KEY_HINT}>
                  ←
                </kbd>
                I did not have it
              </button>
              <button
                type="button"
                disabled={checking}
                aria-keyshortcuts="ArrowRight"
                onClick={() => onAnswer({ kind: 'self', correct: true })}
                className="flex h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl border border-good/35 bg-good-soft text-base font-semibold text-good-ink hover:border-good disabled:opacity-60"
              >
                I had it
                <kbd aria-hidden="true" className={KEY_HINT}>
                  →
                </kbd>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Typed({ mode, word, result, given, checking, onAnswer, speechLang = 'en-US' }: PracticeCardProps) {
  const [text, setText] = useState('');
  const answered = result !== null;
  const cloze = mode === 'cloze' ? buildCloze(word) : null;
  const submitted = given?.kind === 'typed' ? given.text : text;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (answered || checking || text.trim() === '') return;
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
                answered ? (result.correct ? 'border-good text-good-ink' : 'border-bad text-bad-ink') : 'border-muted'
              }`}
            >
              {answered ? result.expected : <span className="sr-only">blank</span>}
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
          disabled={checking}
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
          <button type="submit" className={`${BUTTON_PRIMARY} h-12`} disabled={checking || text.trim() === ''}>
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
  if (props.mode === 'recall') return <Recall {...props} />;
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
  result: PracticeResponse;
  last: boolean;
  onNext: () => void;
}

/** What the server said about the answer, and the way on. Focus lands on the button so Enter continues. */
export function Verdict({ mode, word, result, last, onNext }: VerdictProps) {
  const headline =
    result.typed !== null
      ? TYPED_TEXT[result.typed]
      : mode === 'recall'
        ? result.correct
          ? 'Marked as recalled.'
          : 'Marked as not recalled.'
        : result.correct
          ? 'Correct.'
          : 'Not quite.';
  // For recognition the right choice is already marked above; elsewhere a miss shows the answer.
  const answer = !result.correct && mode !== 'recognition' && mode !== 'recall' ? result.expected : null;
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${
        result.correct ? 'border-good/40 bg-good-soft text-good-ink' : 'border-bad/40 bg-bad-soft text-bad-ink'
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
        {result.outcome === 'dry_run' && <p className="mt-0.5 text-xs">Not recorded.</p>}
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
