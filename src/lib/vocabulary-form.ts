/**
 * The Add Vocabulary form's values and rules, shared by the Add page and the
 * dialog that adds a word straight from a chat reply, so a word is typed,
 * checked and saved exactly the same way wherever it is entered.
 */
import { FIELD_LIMITS, type CreateEntryInput } from '../../shared/api.js';
import { isIsoDate } from '../../shared/dates.js';
import type { VocabularyMeta } from './vocabulary-store.js';

export interface FormValues {
  word: string;
  meaning: string;
  definition: string;
  example: string;
  dateAdded: string;
  mastery: string;
  reviewDate: string;
}

export type FormErrors = Partial<Record<keyof FormValues, string>>;

/** The order fields are checked in, so focus can land on the first problem. */
export const FORM_FIELDS = ['word', 'meaning', 'definition', 'example', 'dateAdded', 'mastery', 'reviewDate'] as const;

/** A blank form carrying the defaults a new word would get, so they are visible rather than implied. */
export function blankForm(meta: VocabularyMeta): FormValues {
  return {
    word: '',
    meaning: '',
    definition: '',
    example: '',
    dateAdded: meta.today,
    mastery: String(meta.defaults.mastery),
    reviewDate: meta.defaults.reviewDate === 'today' ? meta.today : '',
  };
}

export function validate(values: FormValues): FormErrors {
  const errors: FormErrors = {};
  const word = values.word.trim();
  if (word === '') errors.word = 'Enter the word you want to add.';
  else if (word.length > FIELD_LIMITS.word) errors.word = `Keep the word under ${FIELD_LIMITS.word} characters.`;
  for (const key of ['meaning', 'definition', 'example'] as const) {
    if (values[key].trim().length > FIELD_LIMITS.text) errors[key] = `Keep this under ${FIELD_LIMITS.text} characters.`;
  }
  if (values.dateAdded === '' || !isIsoDate(values.dateAdded)) errors.dateAdded = 'Choose the date the word was added.';
  const mastery = Number(values.mastery);
  if (values.mastery.trim() === '' || !Number.isInteger(mastery) || mastery < 0 || mastery > 10) {
    errors.mastery = 'Mastery must be a whole number from 0 to 10.';
  }
  if (values.reviewDate !== '' && !isIsoDate(values.reviewDate)) errors.reviewDate = 'Enter a valid date, or leave it empty.';
  return errors;
}

/** The form as one write the vocabulary store can send. */
export function createInputOf(values: FormValues): Omit<CreateEntryInput, 'requestId'> {
  return {
    word: values.word,
    meaning: values.meaning,
    definition: values.definition,
    example: values.example,
    dateAdded: values.dateAdded,
    mastery: Number(values.mastery),
    reviewDate: values.reviewDate === '' ? null : values.reviewDate,
  };
}
