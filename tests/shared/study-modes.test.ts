import { describe, expect, it } from 'vitest';
import {
  RECOGNITION_OPTIONS,
  STUDY_MODES,
  acceptedSpellings,
  answerText,
  buildChoices,
  buildCloze,
  checkTyped,
  distractorsFor,
  exactForm,
  ineligibility,
  judge,
  looseForm,
  selectForPractice,
  shuffle,
  type PracticeWord,
  type Random,
} from '../../shared/study-modes.js';

const word = (n: number, overrides: Partial<PracticeWord> = {}): PracticeWord => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  word: `word${n}`,
  meaning: `nghĩa ${n}`,
  definition: `definition ${n}`,
  example: `A sentence with word${n} in it.`,
  ...overrides,
});

/** A repeatable source of "random" numbers. */
function seeded(seed: number): Random {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const POOL = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => word(n));

describe('judging a typed answer', () => {
  it('is exact when the letters match, whatever the case or outer spacing', () => {
    for (const typed of ['ephemeral', 'Ephemeral', 'EPHEMERAL', '  ephemeral  ']) {
      expect(checkTyped(typed, 'ephemeral'), typed).toBe('exact');
    }
    expect(checkTyped('take   off', 'take off')).toBe('exact');
  });

  it('is exact across different ways of writing the same accented letter', () => {
    // "é" as one character and as "e" plus a combining accent.
    expect(checkTyped('cafe\u0301', 'caf\u00E9')).toBe('exact');
  });

  it('never accepts a misspelling', () => {
    for (const typed of ['ephemerel', 'ephemera', 'ephemerall', 'ephemeral!x', 'efemeral', 'e phemeral']) {
      expect(checkTyped(typed, 'ephemeral'), typed).toBe('incorrect');
    }
  });

  it('never ignores an accent: a different letter is a different word', () => {
    expect(checkTyped('cafe', 'caf\u00E9')).toBe('incorrect');
    expect(checkTyped('resume', 'résumé')).toBe('incorrect');
  });

  it('counts nothing typed as incorrect, not as a match for anything', () => {
    expect(checkTyped('', 'ephemeral')).toBe('incorrect');
    expect(checkTyped('   ', 'ephemeral')).toBe('incorrect');
  });

  it('accepts as a variant a difference that is not spelling: quotes, dashes, outer punctuation', () => {
    expect(checkTyped("don't", 'don’t')).toBe('variant');
    expect(checkTyped('well - known', 'well-known')).toBe('variant');
    expect(checkTyped('well–known', 'well-known')).toBe('variant');
    expect(checkTyped('ephemeral.', 'ephemeral')).toBe('variant');
    expect(checkTyped('"ephemeral"', 'ephemeral')).toBe('variant');
  });

  it('does not treat a missing hyphen or space as mere punctuation', () => {
    expect(checkTyped('wellknown', 'well-known')).toBe('incorrect');
    expect(checkTyped('well known', 'well-known')).toBe('incorrect');
    expect(checkTyped('takeoff', 'take off')).toBe('incorrect');
  });

  it('accepts each spelling of an entry written as alternatives', () => {
    expect(acceptedSpellings('colour / color')).toEqual(['colour', 'color']);
    expect(checkTyped('color', 'colour / color')).toBe('exact');
    expect(checkTyped('Colour', 'colour / color')).toBe('exact');
    expect(checkTyped('colr', 'colour / color')).toBe('incorrect');
    // The whole entry typed out is not one of its spellings.
    expect(checkTyped('colour / color', 'colour / color')).toBe('incorrect');
  });

  it('treats an entry without a slash as exactly one spelling', () => {
    expect(acceptedSpellings('  take   off ')).toEqual(['take off']);
    expect(acceptedSpellings('and/or')).toEqual(['and', 'or']);
  });

  it('documents the two comparison forms', () => {
    expect(exactForm('  Take   OFF ')).toBe('take off');
    expect(looseForm('“Well – Known!”')).toBe('well-known');
  });
});

describe('what a word needs for each mode', () => {
  it('shows the meaning in preference to the definition', () => {
    expect(answerText(word(1))).toEqual({ kind: 'meaning', text: 'nghĩa 1' });
    expect(answerText(word(1, { meaning: null }))).toEqual({ kind: 'definition', text: 'definition 1' });
    expect(answerText(word(1, { meaning: '   ' }))).toEqual({ kind: 'definition', text: 'definition 1' });
    expect(answerText(word(1, { meaning: null, definition: null }))).toBeNull();
  });

  it('leaves out of every meaning-based mode a word with nothing to show', () => {
    const bare = word(1, { meaning: null, definition: null });
    for (const mode of ['recognition', 'recall', 'typing'] as const) {
      expect(ineligibility(mode, bare, POOL), mode).toBe('no_meaning');
    }
  });

  it('needs three other distinct meanings for a recognition question', () => {
    expect(ineligibility('recognition', word(1), POOL)).toBeNull();
    expect(ineligibility('recognition', word(1), [word(1), word(2), word(3)])).toBe('too_few_choices');
    // Four words, but two share a meaning: only two distinct wrong answers.
    const twins = [word(1), word(2), word(3), word(4, { meaning: 'NGHĨA 3' })];
    expect(ineligibility('recognition', word(1), twins)).toBe('too_few_choices');
  });

  it('needs an example that contains the word for a cloze question', () => {
    expect(ineligibility('cloze', word(1), POOL)).toBeNull();
    expect(ineligibility('cloze', word(1, { example: null }), POOL)).toBe('no_example');
    expect(ineligibility('cloze', word(1, { example: '  ' }), POOL)).toBe('no_example');
    expect(ineligibility('cloze', word(1, { example: 'Nothing relevant here.' }), POOL)).toBe('word_not_in_example');
  });

  it('does not need a meaning for a cloze question, or an example for the others', () => {
    expect(ineligibility('cloze', word(1, { meaning: null, definition: null }), POOL)).toBeNull();
    expect(ineligibility('typing', word(1, { example: null }), POOL)).toBeNull();
    expect(ineligibility('recall', word(1, { example: null }), POOL)).toBeNull();
  });
});

describe('a cloze question', () => {
  it('takes the word out of its own sentence, keeping the rest exactly', () => {
    const cloze = buildCloze(word(1, { word: 'candid', example: 'He gave a candid account of it.' }));
    expect(cloze).toEqual({ before: 'He gave a ', after: ' account of it.', answer: 'candid' });
  });

  it('finds the word whatever its case, and asks for it as the sentence has it', () => {
    expect(buildCloze(word(1, { word: 'candid', example: 'Candid answers are rare.' }))).toEqual({
      before: '',
      after: ' answers are rare.',
      answer: 'Candid',
    });
  });

  it('blanks only the first occurrence', () => {
    const cloze = buildCloze(word(1, { word: 'so', example: 'So it goes, and so on.' }));
    expect(cloze).toMatchObject({ before: '', after: ' it goes, and so on.' });
  });

  it('does not blank part of a longer word, or an inflected form', () => {
    expect(buildCloze(word(1, { word: 'art', example: 'The party started late.' }))).toBeNull();
    expect(buildCloze(word(1, { word: 'alleviate', example: 'It alleviated the pain.' }))).toBeNull();
    expect(buildCloze(word(1, { word: 'café', example: 'They met at the cafés nearby.' }))).toBeNull();
  });

  it('handles phrases, hyphens and punctuation next to the word', () => {
    expect(buildCloze(word(1, { word: 'take off', example: 'The plane will take off, weather permitting.' }))).toMatchObject({
      answer: 'take off',
      after: ', weather permitting.',
    });
    expect(buildCloze(word(1, { word: 'well-known', example: 'A well-known fact.' }))).toMatchObject({ answer: 'well-known' });
    expect(buildCloze(word(1, { word: 'c++', example: 'She writes c++ daily.' }))).toMatchObject({ answer: 'c++' });
  });

  it('uses whichever spelling of the entry the sentence has', () => {
    const entry = word(1, { word: 'colour / color', example: 'What color is it?' });
    expect(buildCloze(entry)).toMatchObject({ answer: 'color', before: 'What ' });
  });

  it('never shows the answer in what is left of the sentence when it occurs once', () => {
    const cloze = buildCloze(word(1, { word: 'candid', example: 'He gave a candid account of it.' }))!;
    expect(`${cloze.before}${cloze.after}`.toLowerCase()).not.toContain('candid');
  });
});

describe('a recognition question', () => {
  it('offers four distinct choices, exactly one of them right', () => {
    const choices = buildChoices(word(1), POOL, seeded(1))!;
    expect(choices).toHaveLength(RECOGNITION_OPTIONS);
    expect(new Set(choices.map((choice) => choice.text)).size).toBe(RECOGNITION_OPTIONS);
    expect(choices.filter((choice) => choice.id === word(1).id)).toEqual([{ id: word(1).id, text: 'nghĩa 1' }]);
  });

  it('never offers two choices that read the same', () => {
    const pool = [
      word(1),
      word(2, { meaning: 'chung' }),
      word(3, { meaning: 'Chung' }),
      word(4, { meaning: ' chung ' }),
      word(5),
      word(6),
    ];
    for (let seed = 1; seed <= 40; seed += 1) {
      const texts = buildChoices(word(1), pool, seeded(seed))!.map((choice) => exactForm(choice.text));
      expect(new Set(texts).size, `seed ${seed}`).toBe(texts.length);
    }
  });

  it('never offers a wrong choice that reads the same as the right one', () => {
    const pool = [word(1), word(2, { meaning: 'NGHĨA 1' }), word(3), word(4), word(5)];
    expect(distractorsFor(word(1), pool).map((choice) => choice.id)).not.toContain(word(2).id);
    for (let seed = 1; seed <= 20; seed += 1) {
      const choices = buildChoices(word(1), pool, seeded(seed))!;
      expect(choices.filter((choice) => exactForm(choice.text) === 'nghĩa 1')).toHaveLength(1);
    }
  });

  it('puts the right answer in every position over time, not in a fixed place', () => {
    const positions = new Set<number>();
    const counts = [0, 0, 0, 0];
    for (let seed = 1; seed <= 400; seed += 1) {
      const index = buildChoices(word(1), POOL, seeded(seed))!.findIndex((choice) => choice.id === word(1).id);
      positions.add(index);
      counts[index] = (counts[index] ?? 0) + 1;
    }
    expect([...positions].sort()).toEqual([0, 1, 2, 3]);
    // Roughly even: no position is strongly favoured.
    for (const count of counts) expect(count).toBeGreaterThan(60);
  });

  it('draws the wrong choices from the whole pool, not always the same three', () => {
    const offered = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      for (const choice of buildChoices(word(1), POOL, seeded(seed))!) offered.add(choice.id);
    }
    expect(offered.size).toBe(POOL.length);
  });

  it('keeps every choice the same kind of text as the right answer', () => {
    // The question's word has only a definition, so definitions are offered, never a meaning.
    const target = word(1, { meaning: null });
    const choices = buildChoices(target, POOL, seeded(3))!;
    expect(choices.every((choice) => choice.text.startsWith('definition'))).toBe(true);
    // A word with no definition cannot supply a wrong definition.
    const pool = [target, ...[2, 3, 4].map((n) => word(n, { definition: null }))];
    expect(buildChoices(target, pool, seeded(3))).toBeNull();
  });

  it('is not made when there are too few distinct wrong answers', () => {
    expect(buildChoices(word(1), [word(1), word(2), word(3)], seeded(1))).toBeNull();
  });
});

describe('shuffling', () => {
  it('keeps every item and leaves its input alone', () => {
    const items = [1, 2, 3, 4, 5, 6];
    const result = shuffle(items, seeded(7));
    expect([...result].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is repeatable from the same source of numbers', () => {
    expect(shuffle([1, 2, 3, 4, 5], seeded(9))).toEqual(shuffle([1, 2, 3, 4, 5], seeded(9)));
  });
});

describe('choosing words for a session', () => {
  it('takes only words the mode can use, and says why each of the others was left out', () => {
    const candidates = [
      word(1),
      word(2, { example: null }),
      word(3, { example: 'No such thing.' }),
      word(4, { meaning: null, definition: null }),
    ];
    const cloze = selectForPractice('cloze', candidates, POOL, 10, seeded(1));
    expect(cloze.words.map((item) => item.id).sort()).toEqual([word(1).id, word(4).id].sort());
    expect(cloze.left.map((item) => [item.word.id, item.reason])).toEqual([
      [word(2).id, 'no_example'],
      [word(3).id, 'word_not_in_example'],
    ]);

    const typing = selectForPractice('typing', candidates, POOL, 10, seeded(1));
    expect(typing.left.map((item) => item.reason)).toEqual(['no_meaning']);
  });

  it('never takes more than was asked for, and never repeats a word', () => {
    const picked = selectForPractice('recall', POOL, POOL, 5, seeded(2)).words;
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((item) => item.id)).size).toBe(5);
    expect(selectForPractice('recall', POOL, POOL, 50, seeded(2)).words).toHaveLength(POOL.length);
    expect(selectForPractice('recall', POOL, POOL, 0, seeded(2)).words).toEqual([]);
  });

  it('does not always start with the same word', () => {
    const firsts = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) firsts.add(selectForPractice('recall', POOL, POOL, 3, seeded(seed)).words[0]!.id);
    expect(firsts.size).toBeGreaterThan(4);
  });

  it('covers every mode', () => {
    for (const mode of STUDY_MODES) expect(selectForPractice(mode, POOL, POOL, 3, seeded(1)).words, mode).toHaveLength(3);
  });
});

describe('judging an answer', () => {
  const candid = word(1, { word: 'candid', meaning: 'thẳng thắn', example: 'He gave a Candid account.' });

  it('takes the reviewer’s word for it in recall, and says so', () => {
    expect(judge('recall', candid, { kind: 'self', correct: true })).toEqual({
      correct: true,
      grading: 'self',
      typed: null,
      submitted: null,
      expected: 'candid',
    });
    expect(judge('recall', candid, { kind: 'self', correct: false })).toMatchObject({ correct: false, grading: 'self' });
  });

  it('marks a recognition choice right only when it is the word’s own meaning', () => {
    expect(judge('recognition', candid, { kind: 'choice', selectedId: candid.id })).toEqual({
      correct: true,
      grading: 'auto',
      typed: null,
      submitted: null,
      expected: 'thẳng thắn',
    });
    expect(judge('recognition', candid, { kind: 'choice', selectedId: word(2).id })).toMatchObject({
      correct: false,
      expected: 'thẳng thắn',
    });
  });

  it('judges typing by the typed text, and records what was typed', () => {
    expect(judge('typing', candid, { kind: 'typed', text: ' Candid ' })).toEqual({
      correct: true,
      grading: 'auto',
      typed: 'exact',
      submitted: 'Candid',
      expected: 'candid',
    });
    expect(judge('typing', candid, { kind: 'typed', text: 'candid.' })).toMatchObject({ correct: true, typed: 'variant' });
    expect(judge('typing', candid, { kind: 'typed', text: 'candit' })).toMatchObject({
      correct: false,
      typed: 'incorrect',
      submitted: 'candit',
    });
  });

  it('judges a cloze answer the same way, and shows the word as the sentence had it', () => {
    expect(judge('cloze', candid, { kind: 'typed', text: 'candid' })).toMatchObject({
      correct: true,
      typed: 'exact',
      expected: 'Candid',
    });
    expect(judge('cloze', candid, { kind: 'typed', text: 'honest' })).toMatchObject({ correct: false, typed: 'incorrect' });
  });

  it('judges listening by the typed word, by the same spelling rules as typing', () => {
    expect(judge('listening', candid, { kind: 'typed', text: ' Candid ' })).toEqual(
      judge('typing', candid, { kind: 'typed', text: ' Candid ' }),
    );
    expect(judge('listening', candid, { kind: 'typed', text: 'candid.' })).toMatchObject({ correct: true, typed: 'variant' });
    expect(judge('listening', candid, { kind: 'typed', text: 'candied' })).toMatchObject({
      correct: false,
      typed: 'incorrect',
      submitted: 'candied',
      expected: 'candid',
    });
  });

  it('needs nothing but the word for listening, where the other modes need more', () => {
    const bare = word(9, { meaning: null, definition: null, example: null });
    expect(ineligibility('listening', bare, [bare])).toBeNull();
    expect(ineligibility('typing', bare, [bare])).toBe('no_meaning');
    expect(judge('listening', bare, { kind: 'typed', text: 'word9' })).toMatchObject({ correct: true, typed: 'exact' });
    // Whether a browser can speak is not something the shared rules know or ask about.
  });

  it('refuses an answer of the wrong kind for the mode', () => {
    expect(judge('listening', candid, { kind: 'self', correct: true })).toBeNull();
    expect(judge('listening', candid, { kind: 'choice', selectedId: candid.id })).toBeNull();
    expect(judge('typing', candid, { kind: 'self', correct: true })).toBeNull();
    expect(judge('recall', candid, { kind: 'typed', text: 'candid' })).toBeNull();
    expect(judge('recognition', candid, { kind: 'typed', text: 'thẳng thắn' })).toBeNull();
    expect(judge('cloze', candid, { kind: 'choice', selectedId: candid.id })).toBeNull();
    expect(judge('writing', candid, { kind: 'self', correct: true })).toBeNull();
    expect(judge('writing', candid, { kind: 'choice', selectedId: candid.id })).toBeNull();
  });

  it('refuses to judge where the word cannot be used in the mode', () => {
    expect(judge('cloze', { ...candid, example: 'No such word here.' }, { kind: 'typed', text: 'candid' })).toBeNull();
    expect(judge('recognition', { ...candid, meaning: null, definition: null }, { kind: 'choice', selectedId: candid.id })).toBeNull();
  });

  it('keeps an over-long typed answer to what the history can hold', () => {
    const judged = judge('typing', candid, { kind: 'typed', text: 'x'.repeat(900) })!;
    expect(judged.submitted).toHaveLength(500);
    expect(judged.correct).toBe(false);
  });
});

describe('the writing challenge', () => {
  const candid = word(1, { word: 'candid', meaning: 'thẳng thắn', example: 'He gave a Candid account.' });

  it('needs nothing but the word itself: no meaning or example is asked for', () => {
    const bare = word(9, { meaning: null, definition: null, example: null });
    expect(ineligibility('writing', bare, [bare])).toBeNull();
    expect(judge('writing', bare, { kind: 'typed', text: 'word9 shows up in this sentence.' })).toMatchObject({
      correct: true,
      typed: 'exact',
    });
  });

  it('is right when the sentence uses the word whole, whatever else it says', () => {
    expect(judge('writing', candid, { kind: 'typed', text: 'A candid answer is the best one.' })).toEqual({
      correct: true,
      grading: 'auto',
      typed: 'exact',
      submitted: 'A candid answer is the best one.',
      expected: 'candid',
    });
    // Case and outer spacing are not spelling.
    expect(judge('writing', candid, { kind: 'typed', text: '  CANDID answers are rare. ' })).toMatchObject({
      correct: true,
      typed: 'exact',
      submitted: 'CANDID answers are rare.',
    });
    // Part of a longer word is not the word, and neither is leaving it out.
    expect(judge('writing', candid, { kind: 'typed', text: 'The candids lined up.' })).toMatchObject({
      correct: false,
      typed: 'incorrect',
    });
    expect(judge('writing', candid, { kind: 'typed', text: 'Nothing else in this sentence.' })).toMatchObject({
      correct: false,
      typed: 'incorrect',
    });
    expect(judge('writing', candid, { kind: 'typed', text: '   ' })).toMatchObject({
      correct: false,
      typed: 'incorrect',
      submitted: '',
    });
  });

  it('accepts each spelling of an entry written as alternatives, as a whole word', () => {
    const entry = word(2, { word: 'colour / color' });
    expect(judge('writing', entry, { kind: 'typed', text: 'What color is the door?' })).toMatchObject({ correct: true, typed: 'exact' });
    expect(judge('writing', entry, { kind: 'typed', text: 'What colour is the door?' })).toMatchObject({ correct: true, typed: 'exact' });
    expect(judge('writing', entry, { kind: 'typed', text: 'A colourful hallway.' })).toMatchObject({ correct: false, typed: 'incorrect' });
  });

  it('takes a phrase for all of the words it is made of, and nothing shorter', () => {
    const entry = word(3, { word: 'take off' });
    expect(judge('writing', entry, { kind: 'typed', text: 'The plane will take off at noon.' })).toMatchObject({ correct: true });
    expect(judge('writing', entry, { kind: 'typed', text: 'Please takeoff your hat.' })).toMatchObject({ correct: false });
  });

  it('forgives a difference that is not spelling, as typing does', () => {
    const entry = word(4, { word: 'don’t' });
    expect(judge('writing', entry, { kind: 'typed', text: "I don't know why." })).toMatchObject({ correct: true, typed: 'exact' });
    // A missing apostrophe is a different word, here as in typing.
    expect(judge('writing', entry, { kind: 'typed', text: 'I dont know why.' })).toMatchObject({ correct: false, typed: 'incorrect' });
  });

  it('keeps the whole sentence for the record, however long', () => {
    const sentence = `A candid answer: ${'and more of it. '.repeat(60)}`.trim();
    expect(sentence.length).toBeGreaterThan(500);
    const judged = judge('writing', candid, { kind: 'typed', text: sentence })!;
    expect(judged.correct).toBe(true);
    expect(judged.submitted).toBe(sentence);
    expect(judged.submitted).toHaveLength(sentence.length);
  });
});

describe('speaking the word aloud', () => {
  it('is graded exactly as typing: the transcript is the answer', () => {
    expect(judge('speaking', word(1), { kind: 'typed', text: ' word1 ' })).toMatchObject({
      correct: true,
      grading: 'auto',
      typed: 'exact',
      submitted: 'word1',
      expected: 'word1',
    });
    expect(judge('speaking', word(1), { kind: 'typed', text: 'word2' })).toMatchObject({ correct: false, typed: 'incorrect' });
  });

  it('accepts nothing but a typed transcript, whatever else is sent', () => {
    expect(judge('speaking', word(1), { kind: 'choice', selectedId: word(1).id })).toBeNull();
    expect(judge('speaking', word(1), { kind: 'self', correct: true })).toBeNull();
  });

  it('needs a meaning to be asked from, and no example', () => {
    expect(ineligibility('speaking', word(1), POOL)).toBeNull();
    expect(ineligibility('speaking', word(1, { meaning: null, definition: null }), POOL)).toBe('no_meaning');
  });

  it('is one of the modes a session can be built from', () => {
    expect(STUDY_MODES).toContain('speaking');
    const { words } = selectForPractice('speaking', POOL, POOL, 3, seeded(7));
    expect(words).toHaveLength(3);
  });
});
