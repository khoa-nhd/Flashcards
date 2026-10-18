/**
 * The fields of the Add Vocabulary form, shared by the Add page and the
 * "Add Word" dialog in chat. Both show the same words, hints and schedule
 * section, so a word entered either way looks the same as it is typed.
 */
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { FIELD_LIMITS, type VocabularyEntry } from '../../shared/api.js';
import { formatDate } from './badges.js';
import { Field, describedBy } from './Field.js';
import { Icon } from './Icon.js';
import { INPUT, TEXTAREA } from './ui.js';
import { openWord } from '../lib/router.js';
import type { FormErrors, FormValues } from '../lib/vocabulary-form.js';

export interface VocabularyFieldsProps {
  /** Prefixes the control ids, so two forms on one screen never clash. */
  idPrefix: string;
  values: FormValues;
  errors: FormErrors;
  disabled?: boolean;
  /** Quick add: word and meaning only, with the meaning on a single line. */
  quick?: boolean;
  showSchedule: boolean;
  onToggleSchedule: () => void;
  onChange: (key: keyof FormValues, value: string) => void;
  /** In a multi-line field Enter adds a line; Ctrl or Cmd + Enter submits. */
  onSubmitModifiedEnter?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** A live hint from the words already loaded; the server checks again when saving. */
  similar?: VocabularyEntry[];
  /** Hides the hint while the duplicate panel below the form is shown. */
  hideSimilar?: boolean;
  /** What a new word's mastery starts at, shown under the mastery field. */
  masteryDefault: number;
  wordInputRef?: Ref<HTMLInputElement>;
  /** Hides the "Example sentences" field (used where examples are chosen instead). */
  hideExample?: boolean;
  /** Rendered in place of the "Example sentences" field. */
  exampleSlot?: ReactNode;
}

export function VocabularyFields({
  idPrefix,
  values,
  errors,
  disabled = false,
  quick = false,
  showSchedule,
  onToggleSchedule,
  onChange,
  onSubmitModifiedEnter,
  similar = [],
  hideSimilar = false,
  masteryDefault,
  wordInputRef,
  hideExample = false,
  exampleSlot,
}: VocabularyFieldsProps) {
  const id = (field: string) => `${idPrefix}-${field}`;

  return (
    <>
      <Field id={id('word')} label="Word" required error={errors.word}>
        <input
          ref={wordInputRef}
          id={id('word')}
          className={INPUT}
          value={values.word}
          onChange={(event) => onChange('word', event.target.value)}
          placeholder="e.g. serendipity"
          autoFocus
          autoComplete="off"
          autoCapitalize="none"
          spellCheck
          maxLength={FIELD_LIMITS.word}
          aria-required="true"
          aria-invalid={errors.word ? true : undefined}
          aria-describedby={describedBy(id('word'), null, errors.word)}
          disabled={disabled}
        />
      </Field>

      {similar.length > 0 && !hideSimilar && (
        <p className="-mt-2 flex items-start gap-2 text-sm text-warn-ink">
          <Icon name="warning" className="mt-0.5 size-4 shrink-0" />
          <span>
            Already in your vocabulary:{' '}
            <button type="button" className="cursor-pointer font-semibold underline" onClick={() => openWord(similar[0]!.id)}>
              {similar[0]!.word}
            </button>
            {similar.length > 1 ? ` and ${similar.length - 1} more` : ''}.
          </span>
        </p>
      )}

      {quick ? (
        <Field id={id('meaning')} label="Vietnamese meaning" error={errors.meaning}>
          <input
            id={id('meaning')}
            className={INPUT}
            value={values.meaning}
            onChange={(event) => onChange('meaning', event.target.value)}
            placeholder="Nghĩa tiếng Việt"
            autoComplete="off"
            aria-describedby={describedBy(id('meaning'), null, errors.meaning)}
            disabled={disabled}
          />
        </Field>
      ) : (
        <>
          <Field id={id('meaning')} label="Vietnamese meaning" error={errors.meaning}>
            <textarea
              id={id('meaning')}
              rows={2}
              className={TEXTAREA}
              value={values.meaning}
              onChange={(event) => onChange('meaning', event.target.value)}
              onKeyDown={onSubmitModifiedEnter}
              placeholder="Nghĩa tiếng Việt"
              aria-describedby={describedBy(id('meaning'), null, errors.meaning)}
              disabled={disabled}
            />
          </Field>
          <Field
            id={id('definition')}
            label="Definition"
            hint="In English. Shown on the card while the word's mastery is 5 or lower."
            error={errors.definition}
          >
            <textarea
              id={id('definition')}
              rows={3}
              className={TEXTAREA}
              value={values.definition}
              onChange={(event) => onChange('definition', event.target.value)}
              onKeyDown={onSubmitModifiedEnter}
              placeholder="What the word means"
              aria-describedby={describedBy(id('definition'), true, errors.definition)}
              disabled={disabled}
            />
          </Field>
          {!hideExample && (
            <Field id={id('example')} label="Example sentences" error={errors.example}>
              <textarea
                id={id('example')}
                rows={3}
                className={TEXTAREA}
                value={values.example}
                onChange={(event) => onChange('example', event.target.value)}
                onKeyDown={onSubmitModifiedEnter}
                placeholder="A sentence that uses the word"
                aria-describedby={describedBy(id('example'), null, errors.example)}
                disabled={disabled}
              />
            </Field>
          )}
          {exampleSlot}
          <Field id={id('dateAdded')} label="Date added" error={errors.dateAdded}>
            <input
              id={id('dateAdded')}
              type="date"
              className={`${INPUT} sm:max-w-56`}
              value={values.dateAdded}
              onChange={(event) => onChange('dateAdded', event.target.value)}
              aria-describedby={describedBy(id('dateAdded'), null, errors.dateAdded)}
              disabled={disabled}
            />
          </Field>
        </>
      )}

      <div className="rounded-xl border border-line">
        <button
          type="button"
          aria-expanded={showSchedule}
          onClick={onToggleSchedule}
          className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm font-medium"
        >
          <span>Starting review settings</span>
          <span className="text-xs font-normal text-muted">
            Mastery {values.mastery || '—'} ·{' '}
            {values.reviewDate === '' ? 'no review date (due right away)' : `first review ${formatDate(values.reviewDate, 'short')}`}
          </span>
        </button>
        {showSchedule && (
          <div className="grid gap-3 border-t border-line p-3 sm:grid-cols-2">
            <Field id={id('mastery')} label="Mastery" hint={`New words start at ${masteryDefault}.`} error={errors.mastery}>
              <input
                id={id('mastery')}
                type="number"
                min={0}
                max={10}
                step={1}
                inputMode="numeric"
                className={INPUT}
                value={values.mastery}
                onChange={(event) => onChange('mastery', event.target.value)}
                aria-describedby={describedBy(id('mastery'), true, errors.mastery)}
                disabled={disabled}
              />
            </Field>
            <Field
              id={id('reviewDate')}
              label="Review date"
              hint="Leave empty to have the word due for review immediately."
              error={errors.reviewDate}
            >
              <input
                id={id('reviewDate')}
                type="date"
                className={INPUT}
                value={values.reviewDate}
                onChange={(event) => onChange('reviewDate', event.target.value)}
                aria-describedby={describedBy(id('reviewDate'), true, errors.reviewDate)}
                disabled={disabled}
              />
            </Field>
          </div>
        )}
      </div>
    </>
  );
}
