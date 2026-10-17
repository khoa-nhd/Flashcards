/**
 * Reading a Vocabulary Expert reply into the four fields a flashcard keeps.
 * The replies follow the pinned format but a model drifts, so the parser is
 * checked against both the format and the ways it can go wrong — and must
 * never guess, merge or truncate what it is not sure of.
 */
import { describe, expect, it } from 'vitest';
import { extractVocabularyAnalysis } from '../../src/lib/vocabulary-analysis.js';

/** A reply in exactly the pinned format. */
const FULL_REPLY = `**proliferation** · noun · /prəˌlɪfəˈreɪʃn/ · C2
- **Meaning (Vietnamese):** sự gia tăng nhanh chóng; sự lan tràn
- **Definition:** a rapid increase in the number or amount of something
- **Examples:**
  1. "The proliferation of fake news worries educators." — Sự lan truyền của tin giả khiến các nhà giáo dục lo lắng.
  2. "Nuclear proliferation remains a global concern." — Phổ biến vũ khí hạt nhân vẫn là mối lo toàn cầu.
- **Collocations:** the proliferation of, nuclear proliferation
- **Synonyms / antonyms:** spread (neutral), surge (sudden)
- **Word family:** proliferate (verb), proliferative (adjective)
- **Usage notes and common mistakes:** Almost always used with "of".`;

describe('a reply in the pinned format', () => {
  it('reads the four fields, and only the four fields', () => {
    expect(extractVocabularyAnalysis(FULL_REPLY)).toEqual({
      word: 'proliferation',
      meaning: 'sự gia tăng nhanh chóng; sự lan tràn',
      definition: 'a rapid increase in the number or amount of something',
      example: 'The proliferation of fake news worries educators.',
      examples: [{ register: 'simple', label: 'Simple', sentence: 'The proliferation of fake news worries educators.' }],
      missing: [],
    });
  });

  it('keeps every meaning line when the senses are listed', () => {
    const reply = `**bank** · noun
- **Meaning (Vietnamese):**
  - bờ sông
  - ngân hàng
- **Definition:** the land alongside a river
- **Examples:**
  1. We sat on the bank. — Chúng tôi ngồi trên bờ sông.`;
    const parsed = extractVocabularyAnalysis(reply);
    expect(parsed.meaning).toBe('bờ sông\nngân hàng');
    expect(parsed.example).toBe('We sat on the bank.');
  });

  it('takes the first example, whole, and drops only its translation', () => {
    for (const separate of [' — ', ' – ', ' → ', ' - ', ' | ', ' : ']) {
      const reply = `**tide** · noun\n- **Examples:**\n  1. The tide is coming in.${separate}Thủy triều đang lên.\n  2. The tide went out. — Thủy triều rút.`;
      expect(extractVocabularyAnalysis(reply).example).toBe('The tide is coming in.');
    }
  });

  it('splits an example whose translation sits on the next line', () => {
    const reply = `**tide** · noun
- **Examples:**
  1. The tide is coming in.
     Thủy triều đang lên.`;
    expect(extractVocabularyAnalysis(reply).example).toBe('The tide is coming in.');
  });

  it('splits an example whose translation simply follows the full stop', () => {
    const reply = `**tide** · noun\n- **Examples:**\n  1. The tide is coming in. Thủy triều đang lên.`;
    expect(extractVocabularyAnalysis(reply).example).toBe('The tide is coming in.');
  });

  it('keeps an example that has no translation at all', () => {
    const reply = `**tide** · noun\n- **Examples:**\n  1. The tide is coming in.`;
    expect(extractVocabularyAnalysis(reply).example).toBe('The tide is coming in.');
  });
});

describe('a reply that drifts from the format', () => {
  it('works without a bold heading, stopping at the first separator', () => {
    const reply = `serendipity /ˌserənˈdɪpəti/ noun B2
- Meaning (Vietnamese): sự tình cờ may mắn
- Definition: finding something good by chance
- Examples:
  1. A serendipity moment changed her life. — Một khoảnh khắc may mắn đã thay đổi cuộc đời cô ấy.`;
    const parsed = extractVocabularyAnalysis(reply);
    expect(parsed.word).toBe('serendipity');
    expect(parsed.meaning).toBe('sự tình cờ may mắn');
    expect(parsed.definition).toBe('finding something good by chance');
    expect(parsed.example).toBe('A serendipity moment changed her life.');
  });

  it('does not take a bold label as the word', () => {
    const reply = `- **Meaning (Vietnamese):** đi bộ
- **Definition:** to move on foot
- **Examples:**\n  1. I walk to work. — Tôi đi bộ đến chỗ làm.`;
    expect(extractVocabularyAnalysis(reply).word).toBe('');
  });

  it('can still find the word when the word itself reads like a label', () => {
    const reply = `**example** · noun · /ɪɡˈzɑːmpl/
- **Meaning (Vietnamese):** ví dụ
- **Definition:** a thing that shows what others are like`;
    expect(extractVocabularyAnalysis(reply).word).toBe('example');
  });

  it('leaves an example empty rather than guessing where English ends', () => {
    const reply = `**tide** · noun\n- **Examples:**\n  1. The tide is coming in Thủy triều đang lên.`;
    expect(extractVocabularyAnalysis(reply).example).toBe('');
  });

  it('leaves the word empty for a reply that is prose, not an analysis', () => {
    const reply = `The word "run" has many meanings, so tell me which one you mean and I will explain it in detail.`;
    const parsed = extractVocabularyAnalysis(reply);
    expect(parsed.word).toBe('');
    expect(parsed.missing).toEqual(['word', 'meaning', 'definition', 'example']);
  });
});

describe('a reply that is missing parts', () => {
  it('lists exactly what was not there, and leaves those fields empty', () => {
    const reply = `**proliferation** · noun
- **Meaning (Vietnamese):** sự gia tăng nhanh chóng
- **Examples:**\n  1. The proliferation of fake news worries educators. — Sự lan truyền của tin giả khiến các nhà giáo dục lo lắng.`;
    const parsed = extractVocabularyAnalysis(reply);
    expect(parsed.definition).toBe('');
    expect(parsed.missing).toEqual(['definition']);
  });

  it('does not join two labelled sections into one field', () => {
    const reply = `**proliferation** · noun
- **Meaning (Vietnamese):** sự gia tăng nhanh chóng
- **Definition:** a rapid increase
- **Examples:**\n  1. The proliferation of fake news worries educators. — Sự lan truyền của tin giả khiến các nhà giáo dục lo lắng.
- **Usage notes and common mistakes:** Almost always used with "of".`;
    const parsed = extractVocabularyAnalysis(reply);
    expect(parsed.meaning).toBe('sự gia tăng nhanh chóng');
    expect(parsed.definition).toBe('a rapid increase');
    expect(parsed.definition).not.toContain('Almost always');
  });

  it('reads nothing at all out of an empty reply', () => {
    expect(extractVocabularyAnalysis('')).toEqual({
      word: '',
      meaning: '',
      definition: '',
      example: '',
      examples: [],
      missing: ['word', 'meaning', 'definition', 'example'],
    });
  });
});
