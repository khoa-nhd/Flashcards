/**
 * The words a review can be narrowed to, as the reviewer reads them. Everything
 * due and the weakest words are named by the address; the reviewer's own picked
 * words are chosen on the page itself. Either narrowing may take a word before
 * it is due. Whether an answer moves the word is a separate choice, made with
 * the switch beside the card.
 */
import type { ReviewFocus } from '../../shared/api.js';
import { ALL_SCOPE, EARLY_DAYS_DEFAULT, RANDOM_SCOPE, WEAK_SCOPE, early, type ReviewScope } from './review-scope.js';

export interface FocusText {
  /** In the chooser. */
  label: string;
  /** Above the card while reviewing. */
  banner: string;
  /** When the selection holds no cards. Never claims that nothing at all is due. */
  emptyTitle: string;
  emptyDetail: string;
  /** Added to the summary when the session ends. */
  done: string;
}

export const FOCUS_TEXT: Record<ReviewFocus, FocusText> = {
  weak: {
    label: 'Weakest words',
    banner: 'Weakest words only, whether or not they are due.',
    emptyTitle: 'No weak words',
    emptyDetail: 'Nothing is flagged as needing attention right now.',
    done: 'They were your weakest words.',
  },
  early: {
    label: 'Review early',
    banner: 'Words coming up soon, taken before they are due. They count toward the schedule.',
    emptyTitle: 'Nothing coming up soon',
    emptyDetail: 'No word is due in the days chosen. Try reaching further ahead.',
    done: 'They were words coming up soon.',
  },
  random: {
    label: 'Random review',
    banner: 'Words you have studied, at random.',
    emptyTitle: 'Nothing to review at random',
    emptyDetail: 'Study a few words first; they can then come up here.',
    done: 'They were words at random.',
  },
};

/** The reviewer's own picked words. Not a focus: the server is told the ids, not a name. */
export const SELECT_TEXT: FocusText = {
  label: 'Select words',
  banner: 'Words you picked, whether or not they are due.',
  emptyTitle: 'Nothing to review from your picks',
  emptyDetail: 'None of these words can be reviewed right now.',
  done: 'They were the words you picked.',
};

export const EVERYTHING_LABEL = 'Everything due';

/** What the chooser calls the picked-words entry. Not a focus value the server knows. */
export const SELECT_VALUE = 'select';

/**
 * The narrowing an address asks for. Anything unrecognised means everything
 * due: an address kept from an older version still opens something sensible.
 */
export function scopeFromQuery(query: URLSearchParams): ReviewScope {
  const focus = query.get('focus');
  if (focus === 'weak') return WEAK_SCOPE;
  if (focus === 'random') return RANDOM_SCOPE;
  if (focus === 'early') {
    const days = Number(query.get('days') ?? EARLY_DAYS_DEFAULT);
    return early(Number.isFinite(days) ? days : EARLY_DAYS_DEFAULT);
  }
  if (focus === SELECT_VALUE) return { kind: 'selection', ids: [] };
  return ALL_SCOPE;
}
