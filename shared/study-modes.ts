/**
 * The practice modes: what each one shows, what it needs from a word, and how
 * an answer is judged. Pure functions, used by the browser to build a session
 * and by the server to judge what was sent.
 *
 * Practice never changes a word's schedule. These modes measure different
 * skills (recognising a meaning is easier than producing the word), so their
 * results are recorded and reported separately and never merged.
 *
 * Nothing here is generated: every prompt, option and sentence is the
 * reviewer's own text. A word that lacks what a mode needs is left out of that
 * mode, with a reason that says what to add.
 */

export const STUDY_MODES = ['recognition', 'recall', 'typing', 'cloze', 'listening'] as const;
export type StudyMode = (typeof STUDY_MODES)[number];

export const STUDY_MODE_LABELS: Record<StudyMode, string> = {
  recognition: 'Recognition',
  recall: 'Recall',
  typing: 'Typing',
  cloze: 'Fill in the blank',
  listening: 'Listening',
};

export const STUDY_MODE_SUMMARY: Record<StudyMode, string> = {
  recognition: 'See the word, pick its meaning from four.',
  recall: 'See the meaning, recall the word, then say whether you had it.',
  typing: 'See the meaning, type the word.',
  cloze: 'See your example sentence with the word left out, type the word.',
  listening: 'Hear the word read aloud by your browser, type what you hear.',
};

/**
 * Modes that depend on something outside the app. Listening has the browser
 * read the word aloud; how that sounds, and whether it works at all, depends
 * on the device, so the mode is offered as an experiment and says so.
 */
export const EXPERIMENTAL_MODES: readonly StudyMode[] = ['listening'];

/**
 * The most a word's practice mastery in one mode can reach. Lower than the
 * review mastery ceiling: practice is a lighter signal, and a mode is finished
 * after a few correct answers rather than a long run of them.
 */
export const PRACTICE_MASTERY_MAX = 3;

/**
 * A word's practice mastery in one mode: one point for every correct practice
 * answer recorded for it in that mode, up to the ceiling. A wrong answer adds
 * nothing and takes nothing away.
 *
 * It is a count of what is already in the practice history, not a second
 * number kept beside it, so it cannot drift from the answers it stands for
 * and an answer sent twice still counts once. It is separate from review
 * mastery and from every schedule: nothing reads it to decide when a word is
 * due.
 */
export function practiceMasteryOf(correctAnswers: number): number {
  if (!Number.isFinite(correctAnswers) || correctAnswers <= 0) return 0;
  return Math.min(PRACTICE_MASTERY_MAX, Math.floor(correctAnswers));
}

/** How many choices a recognition question offers. */
export const RECOGNITION_OPTIONS = 4;

export interface PracticeWord {
  id: string;
  word: string;
  meaning: string | null;
  definition: string | null;
  example: string | null;
}

// ---- Text ----

/** Unicode-normalised, trimmed, inner whitespace collapsed. Case is kept. */
const tidy = (text: string): string => text.normalize('NFC').trim().replace(/\s+/g, ' ');

/**
 * The form two answers are compared in for an **exact** match: tidied, and
 * without regard to letter case. Nothing else is forgiven.
 */
export const exactForm = (text: string): string => tidy(text).toLowerCase();

/**
 * The form used for an **accepted variant**: as `exactForm`, and also blind to
 * differences that are not spelling: curly or straight quotes, the kind of
 * dash, and punctuation at either end or doubled spaces around hyphens.
 * Letters and accents are never altered, so a misspelling never passes.
 */
export function looseForm(text: string): string {
  return exactForm(text)
    .replace(/[\u2018\u2019\u02BC`]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/^[\s.,;:!?"'()[\]]+|[\s.,;:!?"'()[\]]+$/g, '');
}

/**
 * The spellings a word entry accepts. An entry written as alternatives
 * separated by a slash ("colour / color") accepts each of them: that is the
 * reviewer's own list, not a guess. Anything else is one spelling.
 */
export function acceptedSpellings(word: string): string[] {
  const parts = tidy(word)
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length === 0 ? [tidy(word)] : [...new Set(parts)];
}

export type TypedResult = 'exact' | 'variant' | 'incorrect';

/**
 * Judges a typed answer against a word.
 *  - `exact`: one of the accepted spellings, ignoring letter case.
 *  - `variant`: the same letters, differing only in punctuation, quotes or dashes.
 *  - `incorrect`: anything else, including any misspelling.
 */
export function checkTyped(input: string, word: string): TypedResult {
  const spellings = acceptedSpellings(word);
  const typed = exactForm(input);
  if (typed === '') return 'incorrect';
  if (spellings.some((spelling) => exactForm(spelling) === typed)) return 'exact';
  const loose = looseForm(input);
  if (loose !== '' && spellings.some((spelling) => looseForm(spelling) === loose)) return 'variant';
  return 'incorrect';
}

// ---- What each mode needs ----

/** The text a word is "answered" with in the modes that show or ask for a meaning. */
export function answerText(word: PracticeWord): { kind: 'meaning' | 'definition'; text: string } | null {
  if (word.meaning !== null && tidy(word.meaning) !== '') return { kind: 'meaning', text: tidy(word.meaning) };
  if (word.definition !== null && tidy(word.definition) !== '') return { kind: 'definition', text: tidy(word.definition) };
  return null;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Cloze {
  /** The sentence before and after the blank. */
  before: string;
  after: string;
  /** The exact text that was taken out: what a correct answer has to be. */
  answer: string;
}

/**
 * Takes the word out of its example sentence. Only a whole-word occurrence of
 * the word exactly as it is entered (or of one of its slash-separated
 * spellings) is used, so the answer asked for is always the entry itself; an
 * inflected form in the sentence is not blanked, because the entry would then
 * be the wrong answer to it. `null` when the sentence does not contain the word.
 */
export function buildCloze(word: PracticeWord): Cloze | null {
  if (word.example === null) return null;
  const sentence = word.example.normalize('NFC');
  let best: { index: number; length: number } | null = null;
  for (const spelling of acceptedSpellings(word.word)) {
    // Letters, marks and digits on either side would make it part of a longer word.
    const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRegExp(spelling)}(?![\\p{L}\\p{M}\\p{N}])`, 'iu');
    const match = pattern.exec(sentence);
    if (match !== null && (best === null || match.index < best.index)) {
      best = { index: match.index, length: match[0].length };
    }
  }
  if (best === null) return null;
  return {
    before: sentence.slice(0, best.index),
    after: sentence.slice(best.index + best.length),
    answer: sentence.slice(best.index, best.index + best.length),
  };
}

export type Ineligible = 'no_meaning' | 'no_example' | 'word_not_in_example' | 'too_few_choices';

export const INELIGIBLE_TEXT: Record<Ineligible, string> = {
  no_meaning: 'needs a meaning or a definition',
  no_example: 'needs an example sentence',
  word_not_in_example: 'needs an example sentence that contains the word exactly as it is written',
  too_few_choices: `needs at least ${RECOGNITION_OPTIONS - 1} other words with a different meaning to choose between`,
};

/**
 * Why a word cannot be used in a mode, or `null` when it can. `pool` is every
 * word that could supply the wrong choices in a recognition question.
 */
export function ineligibility(mode: StudyMode, word: PracticeWord, pool: readonly PracticeWord[]): Ineligible | null {
  // Listening asks only for the word itself, which every entry has. Whether this browser can
  // read it aloud is not a property of the word, and is the page's to find out.
  if (mode === 'listening') return null;
  if (mode === 'cloze') {
    if (word.example === null || tidy(word.example) === '') return 'no_example';
    return buildCloze(word) === null ? 'word_not_in_example' : null;
  }
  const answer = answerText(word);
  if (answer === null) return 'no_meaning';
  if (mode === 'recognition' && distractorsFor(word, pool).length < RECOGNITION_OPTIONS - 1) return 'too_few_choices';
  return null;
}

// ---- Recognition ----

export interface Choice {
  /** The word this text belongs to. Choosing the question's own word is the right answer. */
  id: string;
  text: string;
}

/**
 * Other words whose answer could be offered as a wrong choice: the same kind
 * of text as the right answer (so its language or length does not give it
 * away), and different from it and from each other once case and spacing are
 * ignored, so no two choices read the same.
 */
export function distractorsFor(word: PracticeWord, pool: readonly PracticeWord[]): Choice[] {
  const answer = answerText(word);
  if (answer === null) return [];
  const seen = new Set([exactForm(answer.text)]);
  const choices: Choice[] = [];
  for (const other of pool) {
    if (other.id === word.id) continue;
    const text = answer.kind === 'meaning' ? other.meaning : other.definition;
    if (text === null) continue;
    const form = exactForm(text);
    if (form === '' || seen.has(form)) continue;
    seen.add(form);
    choices.push({ id: other.id, text: tidy(text) });
  }
  return choices;
}

/** A source of numbers in [0, 1). `Math.random` in use; a fixed sequence in tests. */
export type Random = () => number;

/** A fair shuffle (Fisher–Yates) that leaves its input alone. */
export function shuffle<T>(items: readonly T[], random: Random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}

/**
 * The choices for one recognition question: the right answer and three wrong
 * ones drawn at random, in random order, so neither which ones are offered nor
 * where the right one sits follows any pattern. `null` when there are too few
 * distinct wrong answers.
 */
export function buildChoices(word: PracticeWord, pool: readonly PracticeWord[], random: Random): Choice[] | null {
  const answer = answerText(word);
  const wrong = distractorsFor(word, pool);
  if (answer === null || wrong.length < RECOGNITION_OPTIONS - 1) return null;
  const picked = shuffle(wrong, random).slice(0, RECOGNITION_OPTIONS - 1);
  return shuffle([{ id: word.id, text: answer.text }, ...picked], random);
}

// ---- A practice session ----

export interface PracticeSelection {
  /** The words to practise, in the order they will be shown. */
  words: PracticeWord[];
  /** Words that were left out, and why, so nothing is dropped silently. */
  left: Array<{ word: PracticeWord; reason: Ineligible }>;
}

/**
 * Picks up to `count` words for a session, in random order, from those the
 * mode can use. `candidates` are the words asked for; `pool` is the whole
 * vocabulary, which recognition draws its wrong choices from.
 */
export function selectForPractice(
  mode: StudyMode,
  candidates: readonly PracticeWord[],
  pool: readonly PracticeWord[],
  count: number,
  random: Random,
): PracticeSelection {
  const usable: PracticeWord[] = [];
  const left: PracticeSelection['left'] = [];
  for (const word of candidates) {
    const reason = ineligibility(mode, word, pool);
    if (reason === null) usable.push(word);
    else left.push({ word, reason });
  }
  return { words: shuffle(usable, random).slice(0, Math.max(0, count)), left };
}

// ---- Judging an answer ----

/** What the reviewer did, in the form each mode produces. */
export type PracticeAnswer =
  /** Recall: the reviewer says whether they had it. */
  | { kind: 'self'; correct: boolean }
  /** Recognition: the word whose meaning was chosen. */
  | { kind: 'choice'; selectedId: string }
  /** Typing, cloze and listening. */
  | { kind: 'typed'; text: string };

export const ANSWER_KIND: Record<StudyMode, PracticeAnswer['kind']> = {
  recognition: 'choice',
  recall: 'self',
  typing: 'typed',
  cloze: 'typed',
  listening: 'typed',
};

export interface Judgement {
  correct: boolean;
  grading: 'self' | 'auto';
  /** For typed answers: how it matched. */
  typed: TypedResult | null;
  /** What was typed, tidied, for the record. */
  submitted: string | null;
  /** What the right answer was: shown after answering. */
  expected: string;
}

/**
 * Judges one answer. Returns `null` when the answer is not the kind the mode
 * takes, or the word cannot be used in the mode at all (for cloze: its example
 * no longer contains it).
 */
export function judge(mode: StudyMode, word: PracticeWord, answer: PracticeAnswer): Judgement | null {
  if (answer.kind !== ANSWER_KIND[mode]) return null;
  if (answer.kind === 'self') {
    return { correct: answer.correct, grading: 'self', typed: null, submitted: null, expected: tidy(word.word) };
  }
  if (answer.kind === 'choice') {
    const right = answerText(word);
    if (right === null) return null;
    return { correct: answer.selectedId === word.id, grading: 'auto', typed: null, submitted: null, expected: right.text };
  }
  const submitted = tidy(answer.text).slice(0, 500);
  if (mode === 'cloze') {
    const cloze = buildCloze(word);
    if (cloze === null) return null;
    // The blank holds one particular spelling of the entry; any accepted spelling of the entry fills it.
    const typed = checkTyped(answer.text, word.word);
    return { correct: typed !== 'incorrect', grading: 'auto', typed, submitted, expected: cloze.answer };
  }
  // Typing and listening: the word itself, by the same spelling rules. Only the prompt differs.
  const typed = checkTyped(answer.text, word.word);
  return { correct: typed !== 'incorrect', grading: 'auto', typed, submitted, expected: tidy(word.word) };
}
