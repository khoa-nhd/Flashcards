/**
 * The exercise bands on the front of a review card. The matrix here is fixed
 * by the owner (2026-10-13): every cell either names the exercise shown or the
 * plain card, and nothing an exercise decides can ever reach the answer.
 */
import { describe, expect, it } from 'vitest';
import { exerciseFor, type ExerciseCard } from '../../shared/review-exercises.js';

const card = (overrides: Partial<ExerciseCard> = {}): ExerciseCard => ({
  word: 'ephemeral',
  mastery: 4,
  example: 'An ephemeral moment, gone by noon.',
  ...overrides,
});

const both = (overrides: Partial<Parameters<typeof exerciseFor>[1]> = {}) => ({
  enabled: true,
  canSpeak: true,
  ...overrides,
});

describe('the cloze band (mastery 4–5)', () => {
  it('blanks the word out of the card’s own example', () => {
    expect(exerciseFor(card(), both())).toEqual({
      kind: 'cloze',
      before: 'An ',
      after: ' moment, gone by noon.',
      blanked: 'ephemeral',
    });
  });

  it.each([4, 5])('applies at mastery %s', (mastery) => {
    expect(exerciseFor(card({ mastery }), both())?.kind).toBe('cloze');
  });

  it('does not need speech synthesis: a device without it still gets the cloze', () => {
    expect(exerciseFor(card(), both({ canSpeak: false }))?.kind).toBe('cloze');
  });

  it('is the plain card when the word has no example at all', () => {
    expect(exerciseFor(card({ example: null }), both())).toBeNull();
  });

  it('is the plain card when the example does not contain the word whole', () => {
    // An inflected form is not the entry, so blanking it would ask the wrong question.
    expect(exerciseFor(card({ example: 'The ephemera fade quickly.' }), both())).toBeNull();
    expect(exerciseFor(card({ example: 'Nothing to blank here.' }), both())).toBeNull();
  });

  it('blanks the occurrence the entry itself spells, among slash-separated spellings', () => {
    const spaced = exerciseFor(card({ word: 'well known / well-known', example: 'A well known result.' }), both());
    expect(spaced).toMatchObject({ kind: 'cloze', blanked: 'well known' });
    const hyphenated = exerciseFor(card({ word: 'well known / well-known', example: 'A well-known result.' }), both());
    expect(hyphenated).toMatchObject({ kind: 'cloze', blanked: 'well-known' });
  });

  it('never falls through to listening when the cloze cannot be made', () => {
    expect(exerciseFor(card({ example: null }), both())).toBeNull();
  });
});

describe('the listening band (mastery 6–9)', () => {
  it.each([6, 7, 8, 9])('asks for the word at mastery %s when the browser can speak', (mastery) => {
    expect(exerciseFor(card({ mastery }), both())).toEqual({ kind: 'listening' });
  });

  it('does not need the example: the word itself is the question', () => {
    expect(exerciseFor(card({ mastery: 7, example: null }), both())).toEqual({ kind: 'listening' });
  });

  it('is the plain card when the browser cannot read aloud', () => {
    expect(exerciseFor(card({ mastery: 7 }), both({ canSpeak: false }))).toBeNull();
  });
});

describe('the plain card', () => {
  it('is shown below the bands and after them', () => {
    for (const mastery of [1, 2, 3, 10, 11]) {
      expect(exerciseFor(card({ mastery }), both()), `mastery ${mastery}`).toBeNull();
    }
  });

  it('is shown when the mastery is not known', () => {
    expect(exerciseFor(card({ mastery: null }), both())).toBeNull();
  });

  it('is shown for every band when the preference is off', () => {
    for (const mastery of [4, 5, 7, 9]) {
      expect(exerciseFor(card({ mastery }), both({ enabled: false })), `mastery ${mastery}`).toBeNull();
    }
  });
});
