/**
 * The ways a review can be narrowed, as the reviewer reads them. Every one
 * selects among words that are already due, except `weak`, which may also
 * bring a weak word forward.
 */
import { RECENTLY_ADDED_DAYS, reviewFocusSchema, type ReviewFocus } from '../../shared/api.js';

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
  overdue: {
    label: 'Overdue only',
    banner: 'Overdue words only.',
    emptyTitle: 'Nothing is overdue',
    emptyDetail: 'No word is past its review date.',
    done: 'They were the words past their review date.',
  },
  due_today: {
    label: 'Due today only',
    banner: 'Words due today only.',
    emptyTitle: 'Nothing is dated today',
    emptyDetail: 'No word has today as its review date.',
    done: 'They were the words dated today.',
  },
  recent: {
    label: 'Recently added',
    banner: `Words added in the last ${RECENTLY_ADDED_DAYS} days only, from those due now.`,
    emptyTitle: 'No recent words are due',
    emptyDetail: `None of the words added in the last ${RECENTLY_ADDED_DAYS} days is due for review right now.`,
    done: `They were the due words added in the last ${RECENTLY_ADDED_DAYS} days.`,
  },
};

export const EVERYTHING_LABEL = 'Everything due';

/** The selection an address asks for; anything unrecognised means everything due. */
export function focusFromQuery(query: URLSearchParams): ReviewFocus | null {
  const parsed = reviewFocusSchema.safeParse(query.get('focus'));
  return parsed.success ? parsed.data : null;
}
