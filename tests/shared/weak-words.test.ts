import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEAK_WORD_WEIGHTS,
  rankWeakWords,
  rankWeakWordsByRecall,
  scoreWeakWord,
  type CardHistory,
  type WeakWordInput,
} from '../../shared/weak-words.js';

const TODAY = '2026-10-09';

const history = (overrides: Partial<CardHistory> = {}): CardHistory => ({
  reviews: 4,
  failures: 0,
  recentReviews: 4,
  recentFailures: 0,
  failedDays: 0,
  lastReviewedOn: '2026-10-08',
  lastFailedOn: null,
  lastAction: 'remember',
  ...overrides,
});

const word = (name: string, overrides: Partial<WeakWordInput> = {}): WeakWordInput => ({
  id: name,
  word: name,
  mastery: 3,
  reviewDate: '2026-10-12',
  retired: false,
  meaning: 'nghĩa',
  definition: 'a definition',
  example: 'An example.',
  history: null,
  ...overrides,
});

const score = (input: WeakWordInput) => scoreWeakWord(input, TODAY);

describe('a word with nothing against it', () => {
  it('is not weak', () => {
    expect(score(word('fine'))).toBeNull();
    expect(score(word('reviewed', { history: history() }))).toBeNull();
    expect(score(word('due-today', { reviewDate: TODAY }))).toBeNull();
    expect(score(word('new', { reviewDate: null }))).toBeNull();
  });
});

describe('the reasons', () => {
  it('names repeated forgetting across separate days, counting from the second day', () => {
    expect(score(word('once', { history: history({ failures: 3, failedDays: 1, recentFailures: 0 }) }))).toBeNull();
    const result = score(word('thrice', { history: history({ failures: 3, failedDays: 3, recentFailures: 0 }) }));
    expect(result?.reasons).toEqual([{ code: 'repeated_failures', points: 6, detail: 'Forgotten on 3 separate days.' }]);
  });

  it('names recent failures, up to a cap', () => {
    const one = score(word('one', { history: history({ failures: 1, recentFailures: 1, failedDays: 1 }) }));
    expect(one?.reasons).toEqual([
      { code: 'recent_failures', points: 2, detail: 'Not remembered 1 time in the last 30 days.' },
    ]);
    const many = score(word('many', { history: history({ recentReviews: 20, recentFailures: 7, failedDays: 1 }) }));
    expect(many?.reasons.find((reason) => reason.code === 'recent_failures')?.points).toBe(6);
  });

  it('names low recent accuracy only with enough recent reviews to judge', () => {
    const judged = score(word('judged', { history: history({ recentReviews: 5, recentFailures: 3, failedDays: 1 }) }));
    expect(judged?.reasons.map((reason) => reason.code)).toContain('low_recent_accuracy');
    expect(judged?.reasons.find((reason) => reason.code === 'low_recent_accuracy')?.detail).toBe(
      'Remembered 2 of the last 5 reviews.',
    );
    const tooFew = score(word('too-few', { history: history({ recentReviews: 2, recentFailures: 2, failedDays: 1 }) }));
    expect(tooFew?.reasons.map((reason) => reason.code)).not.toContain('low_recent_accuracy');
  });

  it('names a well-known word that was just forgotten', () => {
    const slipped = score(
      word('slipped', { mastery: 8, history: history({ lastAction: 'not_remember', recentFailures: 1, failedDays: 1 }) }),
    );
    expect(slipped?.reasons.map((reason) => reason.code)).toEqual(['slipped_after_progress', 'recent_failures']);
    expect(slipped?.reasons[0]?.detail).toBe('At mastery 8, but not remembered at the latest review.');
    // The same slip on a word still being learned is not this reason.
    const learning = score(
      word('learning', { mastery: 2, history: history({ lastAction: 'not_remember', recentFailures: 1, failedDays: 1 }) }),
    );
    expect(learning?.reasons.map((reason) => reason.code)).toEqual(['recent_failures']);
  });

  it('names a word that has been due for a long time, more so the longer it waits', () => {
    expect(score(word('six-days', { reviewDate: '2026-10-03' }))).toBeNull();
    expect(score(word('a-week', { reviewDate: '2026-10-02' }))?.reasons).toEqual([
      { code: 'long_overdue', points: 2, detail: 'Due for 7 days.' },
    ]);
    expect(score(word('a-month', { reviewDate: '2026-09-09' }))?.score).toBe(5);
    expect(score(word('a-year', { reviewDate: '2025-10-09' }))?.score).toBe(5);
    // A mastered word is not waiting for anything.
    expect(score(word('mastered', { mastery: 10, retired: true, reviewDate: '2026-01-01' }))).toBeNull();
  });

  it('names missing content, as a small factor', () => {
    expect(score(word('bare', { definition: null, example: null }))?.reasons).toEqual([
      { code: 'incomplete', points: 2, detail: 'Missing definition and example.' },
    ]);
    expect(score(word('barer', { meaning: null, definition: null, example: null }))?.score).toBe(2);
  });
});

describe('how the factors weigh against each other', () => {
  it('ranks a word forgotten on many days above one that slipped once recently', () => {
    const [first, second] = rankWeakWords(
      [
        word('slipped-once', { history: history({ failures: 1, recentFailures: 1, failedDays: 1, lastAction: 'not_remember' }) }),
        word('keeps-slipping', {
          history: history({ reviews: 12, failures: 4, recentReviews: 0, recentFailures: 0, failedDays: 4 }),
        }),
      ],
      TODAY,
    );
    expect(first).toMatchObject({ id: 'keeps-slipping', score: 9, severity: 'high' });
    expect(second).toMatchObject({ id: 'slipped-once', score: 2, severity: 'low' });
  });

  it('never lets missing content alone outrank evidence of forgetting', () => {
    const ranked = rankWeakWords(
      [
        word('incomplete', { meaning: null, definition: null, example: null }),
        word('forgotten-twice', { history: history({ failures: 2, recentFailures: 2, failedDays: 2 }) }),
      ],
      TODAY,
    );
    expect(ranked.map((item) => item.id)).toEqual(['forgotten-twice', 'incomplete']);
  });

  it('adds reasons up and puts the heaviest first', () => {
    const result = score(
      word('everything', {
        mastery: 7,
        reviewDate: '2026-09-25',
        example: null,
        history: history({ reviews: 10, failures: 5, recentReviews: 6, recentFailures: 4, failedDays: 3, lastAction: 'not_remember' }),
      }),
    );
    expect(result?.reasons.map((reason) => [reason.code, reason.points])).toEqual([
      ['repeated_failures', 6],
      ['recent_failures', 6],
      ['low_recent_accuracy', 3],
      ['slipped_after_progress', 3],
      ['long_overdue', 3],
      ['incomplete', 1],
    ]);
    expect(result).toMatchObject({ score: 22, severity: 'high', recent: { reviews: 6, remembered: 2 } });
    expect(result?.action).toBe('Review it now, and add an example that makes it stick.');
  });

  it('grades severity by score', () => {
    const { severity } = DEFAULT_WEAK_WORD_WEIGHTS;
    expect(score(word('low', { example: null }))?.severity).toBe('low');
    expect(score(word('medium', { reviewDate: '2026-09-18' }))).toMatchObject({ score: severity.medium, severity: 'medium' });
    expect(
      score(word('high', { history: history({ failures: 4, failedDays: 4, recentFailures: 0 }) })),
    ).toMatchObject({ score: 9, severity: 'high' });
  });

  it('is configurable: changing a weight changes the score and nothing else', () => {
    const input = word('twice', { history: history({ failures: 2, failedDays: 2, recentFailures: 0 }) });
    expect(scoreWeakWord(input, TODAY)?.score).toBe(3);
    expect(scoreWeakWord(input, TODAY, { ...DEFAULT_WEAK_WORD_WEIGHTS, perRepeatedFailureDay: 10 })?.score).toBe(10);
  });
});

describe('ranking', () => {
  it('leaves out words with nothing against them and breaks ties by word', () => {
    const ranked = rankWeakWords(
      [word('zebra', { example: null }), word('fine'), word('apple', { example: null }), word('mango', { reviewDate: '2026-10-02' })],
      TODAY,
    );
    expect(ranked.map((item) => item.id)).toEqual(['mango', 'apple', 'zebra']);
  });

  it('breaks a tie by lower mastery, then by word, so a missing mastery is not treated as strong', () => {
    const ranked = rankWeakWords(
      [
        word('high', { mastery: 9, example: null }),
        word('none', { mastery: null, example: null }),
        word('low', { mastery: 2, example: null }),
      ],
      TODAY,
    );
    // All score the same for the one missing field; the least mastered comes first.
    expect(ranked.map((item) => item.id)).toEqual(['none', 'low', 'high']);
  });

  it('gives each word an action that follows from its main reason', () => {
    expect(score(word('bare', { example: null }))?.action).toBe('Fill in what is missing so the card can be reviewed properly.');
    expect(score(word('late', { reviewDate: '2026-09-01' }))?.action).toBe('Review it: it has been waiting a long time.');
  });

  it('shows no recent performance for a word with no saved reviews', () => {
    expect(score(word('late', { reviewDate: '2026-09-01' }))?.recent).toBeNull();
  });
});

describe('under FSRS alone', () => {
  // Every one of these has something against it (a missing example), so all are on the list.
  const fsrs = (name: string, recall: number | null, lapses: number, reviewDate: string, mastery = 3) =>
    word(name, { example: null, scale: 'strength', recall, lapses, reviewDate, mastery });
  const order = (inputs: WeakWordInput[]) => rankWeakWordsByRecall(inputs, TODAY).map((item) => item.word);

  it('puts the lowest estimated recall first, whatever the strength level', () => {
    expect(order([fsrs('strong', 0.3, 0, TODAY, 9), fsrs('fresh', 0.95, 0, TODAY, 2), fsrs('middle', 0.6, 0, TODAY, 5)])).toEqual([
      'strong',
      'middle',
      'fresh',
    ]);
  });

  it('breaks a tie by more lapses, then by the longest due, then by word', () => {
    expect(
      order([
        fsrs('b-once', 0.5, 1, '2026-10-05'),
        fsrs('a-twice', 0.5, 2, '2026-10-08'),
        fsrs('c-older', 0.5, 1, '2026-09-20'),
        fsrs('d-same', 0.5, 1, '2026-09-20'),
      ]),
    ).toEqual(['a-twice', 'c-older', 'd-same', 'b-once']);
  });

  it('puts a word FSRS has not seen after every word it has an estimate for', () => {
    expect(order([fsrs('unseen', null, 0, TODAY), fsrs('seen', 0.99, 0, TODAY)])).toEqual(['seen', 'unseen']);
  });

  it('keeps only words with something against them, as before', () => {
    const fine = word('fine', { scale: 'strength', recall: 0.1, lapses: 0 });
    expect(order([fine])).toEqual([]);
  });

  it('speaks of memory strength, not mastery, when a strong word slips', () => {
    const slipped = score(
      word('slipped', { scale: 'strength', mastery: 7, history: history({ lastAction: 'not_remember', recentFailures: 1, failedDays: 1 }) }),
    );
    expect(slipped?.reasons.map((reason) => reason.detail)).toContain('At memory strength 7 of 10, but not remembered at the latest review.');
  });
});
