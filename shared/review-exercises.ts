/**
 * How a review card's front may be presented as an exercise instead of the
 * plain card, for words the reviewer already knows reasonably well. Pure
 * presentation: the owner's rule (2026-10-13, see config/review.config.ts and
 * docs/review-logic.md section 14) is that how a question is PRESENTED never
 * changes how it is GRADED. The answer is still the reviewer's own Remember /
 * Not remember; what gets typed into an exercise is local to the screen and is
 * never sent, saved or judged for the schedule.
 *
 * Nothing here is generated text: the cloze is the reviewer's own example
 * sentence with their own word taken out of it (the same helper the cloze
 * practice mode uses), and listening reads the word with the browser's own
 * speech synthesis. A card that lacks what an exercise needs shows the plain
 * card instead of dropping the question.
 */
import { buildCloze } from './study-modes.js';

/** The band edges, fixed by the owner. Between them the front becomes an exercise. */
const CLOZE_MIN_MASTERY = 4;
const CLOZE_MAX_MASTERY = 5;
const LISTENING_MIN_MASTERY = 6;
const LISTENING_MAX_MASTERY = 9;

/**
 * What a review card carries that an exercise can be drawn from. `example` is
 * what the server sent: the mastery rule withholds it above 5, and a word may
 * simply have none, so it is null when there is nothing to blank.
 */
export interface ExerciseCard {
  word: string;
  /** Null for a card whose mastery is not known; such a card is never an exercise. */
  mastery: number | null;
  example: string | null;
}

export type Exercise =
  /**
   * The example sentence with the word taken out. `before` and `after` are the
   * text either side of the blank; `blanked` is the exact text removed, which
   * is what a correct fill-in would spell.
   */
  | { kind: 'cloze'; before: string; after: string; blanked: string }
  /** The word is read aloud by the browser; the reviewer types what they hear. */
  | { kind: 'listening' };

export interface ExerciseOptions {
  /** The "Challenge cards" preference: off, and every card is plain. */
  enabled: boolean;
  /** Whether this browser can read the word aloud at all. */
  canSpeak: boolean;
}

/**
 * The exercise to show in front of `card`, or null for the plain card.
 *
 * The bands are fixed, and each falls back to the plain card on its own terms:
 *   mastery 4–5   cloze from the card's example; a missing or unusable example
 *                 (the word does not appear in it whole) is the plain card —
 *                 it never falls through to listening.
 *   mastery 6–9   listening; without speech synthesis, the plain card.
 *   anything else mastery unknown, below 4, or 10 and above: the plain card.
 * The preference, when off, ends the question before any of that.
 */
export function exerciseFor(card: ExerciseCard, options: ExerciseOptions): Exercise | null {
  if (!options.enabled || card.mastery === null) return null;
  if (card.mastery >= CLOZE_MIN_MASTERY && card.mastery <= CLOZE_MAX_MASTERY) {
    if (card.example === null) return null;
    // buildCloze takes a practice word; an exercise only ever needs the word and its example.
    const cloze = buildCloze({ id: '', word: card.word, meaning: null, definition: null, example: card.example });
    if (cloze === null) return null;
    return { kind: 'cloze', before: cloze.before, after: cloze.after, blanked: cloze.answer };
  }
  if (card.mastery >= LISTENING_MIN_MASTERY && card.mastery <= LISTENING_MAX_MASTERY && options.canSpeak) {
    return { kind: 'listening' };
  }
  return null;
}
