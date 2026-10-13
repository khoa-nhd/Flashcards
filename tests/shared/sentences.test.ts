/**
 * The sentence the Smart Reader takes as a word's example: the one the reader
 * highlighted the word in, exactly as written there.
 */
import { describe, expect, it } from 'vitest';
import { sentenceContaining } from '../../shared/sentences.js';

const PASSAGE = `The minister gave a candid account of the failure.
Why did he stay so candid? "Candidly," she said, "it was obvious."
Candid is a word I keep. Then, candidly speaking, we moved on.`;

describe('the sentence around a word', () => {
  it('takes the sentence the word is in, boundaries included', () => {
    expect(sentenceContaining(PASSAGE, 'candid')).toBe('The minister gave a candid account of the failure.');
    // A question mark is a boundary too: the sentence holding "obvious" begins after it.
    expect(sentenceContaining(PASSAGE, 'obvious')).toBe('"Candidly," she said, "it was obvious."');
  });

  it('matches the phrase, not just any word order', () => {
    expect(sentenceContaining('She spoke candidly speaking. Then candid speaking began.', 'candid speaking')).toBe(
      'Then candid speaking began.',
    );
  });

  it('is blind to case at the match, and keeps it in the sentence', () => {
    expect(sentenceContaining('The minister was Candid that day.', 'candid')).toBe('The minister was Candid that day.');
  });

  it('does not match a word inside a longer one', () => {
    expect(sentenceContaining('This is noncandid behaviour.', 'candid')).toBeNull();
    expect(sentenceContaining('The candid ones stay.', 'candidly')).toBeNull();
  });

  it('takes the last sentence before and the first at or after the word', () => {
    expect(sentenceContaining('One. Two, the candid three. Four.', 'candid')).toBe('Two, the candid three.');
  });

  it('returns null when the word is not there, or nothing was asked for', () => {
    expect(sentenceContaining(PASSAGE, 'serendipity')).toBeNull();
    expect(sentenceContaining(PASSAGE, '')).toBeNull();
  });

  it('collapses line breaks, so a pasted passage still reads as one sentence', () => {
    expect(sentenceContaining('A candid\n  account,\nand more.', 'candid')).toBe('A candid account, and more.');
  });
});
