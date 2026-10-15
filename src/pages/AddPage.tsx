import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { FIELD_LIMITS, type CreateEntryInput, type VocabularyEntry } from '../../shared/api.js';
import { isIsoDate } from '../../shared/dates.js';
import { normalizeWord } from '../../shared/text.js';
import { useApp, useVocabulary } from '../app-context.js';
import { MasteryPill, formatDate } from '../components/badges.js';
import { Field, describedBy } from '../components/Field.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, INPUT, PAGE, TEXTAREA } from '../components/ui.js';
import { newRequestId } from '../lib/request-id.js';
import { ROUTES, buildHref, openWord } from '../lib/router.js';
import type { VocabularyMeta, WriteResult } from '../lib/vocabulary-store.js';

interface FormValues {
  word: string;
  meaning: string;
  definition: string;
  example: string;
  dateAdded: string;
  mastery: string;
  reviewDate: string;
}

type FormErrors = Partial<Record<keyof FormValues, string>>;

/** A blank form carrying the defaults a new word would get, so they are visible rather than implied. */
function blankForm(meta: VocabularyMeta): FormValues {
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

function validate(values: FormValues): FormErrors {
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

export function AddPage() {
  const state = useVocabulary();
  return (
    <div className={PAGE}>
      <PageHeader
        title="Add vocabulary"
        description="Create a new word in your vocabulary."
        actions={
          <Link to={ROUTES.import} className={BUTTON_SECONDARY}>
            Import a list
          </Link>
        }
      />
      <VocabularyGate state={state}>{state.meta !== null && <AddForm meta={state.meta} entries={state.entries} />}</VocabularyGate>
    </div>
  );
}

/**
 * One submission. It is kept around after it is made so the word, its status
 * and — when it fails — what to do about it stay on screen without the form
 * being blocked while the database is answering.
 */
interface Attempt {
  /** The temporary id the optimistic entry carries until the server answers. */
  localId: string;
  /** Identifies this submission, so sending it again cannot create a second word. */
  requestId: string;
  word: string;
  input: CreateEntryInput;
  quick: boolean;
  status: 'saving' | 'saved' | 'failed';
  error: string | null;
  /** Existing words, when the server refused this as a duplicate. */
  duplicates: VocabularyEntry[];
  /** The stored record, once the server has confirmed it. */
  entry: VocabularyEntry | null;
}

function AddForm({ meta, entries }: { meta: VocabularyMeta; entries: VocabularyEntry[] }) {
  const { vocabulary } = useApp();
  const [values, setValues] = useState<FormValues>(() => blankForm(meta));
  const [errors, setErrors] = useState<FormErrors>({});
  const [quick, setQuick] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  /** Submissions shown under the form: still saving, just saved, or failed. */
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  /** Existing words the user must look at before a duplicate is created here. */
  const [duplicates, setDuplicates] = useState<VocabularyEntry[] | null>(null);

  const wordInput = useRef<HTMLInputElement>(null);
  /** The submission already on its way, so a repeated click does not make a second word. */
  const sending = useRef<string | null>(null);
  /** One id per distinct submission; a retry of the same content reuses it. */
  const requestId = useRef(newRequestId());

  const change = (key: keyof FormValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setDuplicates(null);
    requestId.current = newRequestId();
  };

  // A live hint from the words already loaded; the server checks again when saving.
  const similar = useMemo(() => {
    const wanted = normalizeWord(values.word);
    return wanted === '' ? [] : entries.filter((entry) => normalizeWord(entry.word) === wanted);
  }, [entries, values.word]);

  const patchAttempt = (localId: string, patch: Partial<Attempt>) => {
    setAttempts((list) => list.map((attempt) => (attempt.localId === localId ? { ...attempt, ...patch } : attempt)));
  };

  const settleAttempt = (localId: string, result: WriteResult) => {
    patchAttempt(
      localId,
      result.ok
        ? { status: 'saved', entry: result.entry, error: null, duplicates: [] }
        : { status: 'failed', error: result.message, duplicates: result.duplicates },
    );
  };

  const submit = (allowDuplicate: boolean) => {
    if (!meta.writesEnabled) return;
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Send focus to the first problem so it is announced and easy to fix.
      const first = (['word', 'meaning', 'definition', 'example', 'dateAdded', 'mastery', 'reviewDate'] as const).find(
        (key) => found[key],
      );
      if (first === 'mastery' || first === 'reviewDate') setShowSchedule(true);
      // Deferred so a field inside the just-opened settings section exists by then.
      if (first) setTimeout(() => document.getElementById(`add-${first}`)?.focus(), 0);
      return;
    }
    if (!allowDuplicate && similar.length > 0) {
      setDuplicates(similar);
      return;
    }
    // The same content is already on its way; a second click or Enter changes nothing.
    if (sending.current === requestId.current) return;
    sending.current = requestId.current;

    const input: CreateEntryInput = {
      word: values.word,
      meaning: values.meaning,
      definition: quick ? undefined : values.definition,
      example: quick ? undefined : values.example,
      dateAdded: values.dateAdded,
      mastery: Number(values.mastery),
      reviewDate: values.reviewDate === '' ? null : values.reviewDate,
      allowDuplicate: allowDuplicate || undefined,
      requestId: requestId.current,
    };
    // The word appears at once; the database is told behind that.
    const { localId, result } = vocabulary.create(input);
    setAttempts((list) =>
      [
        ...list,
        {
          localId,
          requestId: input.requestId ?? requestId.current,
          word: input.word,
          input,
          quick,
          status: 'saving' as const,
          error: null,
          duplicates: [],
          entry: null,
        },
      ].slice(-6),
    );
    setDuplicates(null);
    // The form is ready for the next word without waiting for the save.
    setValues((current) => ({ ...current, word: '', meaning: '', definition: '', example: '' }));
    void result.then((outcome) => settleAttempt(localId, outcome));
    wordInput.current?.focus();
  };

  /** Sends a failed submission again, either as it was or with the duplicate allowed. */
  const resend = (attempt: Attempt, allowDuplicate = false) => {
    setDuplicates(null);
    if (allowDuplicate) {
      vocabulary.dismiss(attempt.localId);
      const input: CreateEntryInput = { ...attempt.input, allowDuplicate: true };
      const { localId, result } = vocabulary.create(input);
      patchAttempt(attempt.localId, { localId, input, status: 'saving', error: null, duplicates: [] });
      void result.then((outcome) => settleAttempt(localId, outcome));
      return;
    }
    const retrying = vocabulary.retry(attempt.localId);
    if (retrying === null) {
      // The write is no longer known (the page was reloaded); send it afresh under the same id.
      const { localId, result } = vocabulary.create(attempt.input);
      patchAttempt(attempt.localId, { localId, status: 'saving', error: null, duplicates: [] });
      void result.then((outcome) => settleAttempt(localId, outcome));
      return;
    }
    patchAttempt(attempt.localId, { status: 'saving', error: null, duplicates: [] });
    void retrying.then((outcome) => settleAttempt(attempt.localId, outcome));
  };

  /** Puts a failed submission back in the form, so its values need not be typed again. */
  const editAttempt = (attempt: Attempt) => {
    vocabulary.dismiss(attempt.localId);
    setAttempts((list) => list.filter((item) => item.localId !== attempt.localId));
    setValues({
      word: attempt.input.word,
      meaning: attempt.input.meaning ?? '',
      definition: attempt.input.definition ?? '',
      example: attempt.input.example ?? '',
      dateAdded: attempt.input.dateAdded ?? meta.today,
      mastery: String(attempt.input.mastery ?? meta.defaults.mastery),
      reviewDate: attempt.input.reviewDate ?? '',
    });
    setQuick(attempt.quick);
    setDuplicates(null);
    requestId.current = attempt.requestId;
    sending.current = null;
    wordInput.current?.focus();
  };

  const dismissAttempt = (attempt: Attempt) => {
    vocabulary.dismiss(attempt.localId);
    setAttempts((list) => list.filter((item) => item.localId !== attempt.localId));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(false);
  };

  /** In a multi-line field Enter adds a line; Ctrl or Cmd + Enter saves. */
  const submitOnModifiedEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit(false);
    }
  };

  const clear = () => {
    for (const attempt of attempts) if (attempt.status === 'failed') vocabulary.dismiss(attempt.localId);
    setAttempts((list) => list.filter((attempt) => attempt.status !== 'failed'));
    setValues(blankForm(meta));
    setErrors({});
    setDuplicates(null);
    requestId.current = newRequestId();
    sending.current = null;
    wordInput.current?.focus();
  };

  const savingAttempts = attempts.filter((attempt) => attempt.status === 'saving');
  const failedAttempts = attempts.filter((attempt) => attempt.status === 'failed');
  const created = [...attempts].reverse().find((attempt) => attempt.status === 'saved' && attempt.entry !== null)?.entry ?? null;
  const disabled = !meta.writesEnabled;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {savingAttempts.length > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3 text-sm text-muted"
        >
          <Spinner className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">
            Saving <strong className="font-semibold text-ink">{savingAttempts.map((attempt) => attempt.word).join(', ')}</strong>…
            The form is ready for the next word.
          </p>
        </div>
      )}

      {created !== null && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-good/40 bg-good-soft px-4 py-3 text-good-ink">
          <Icon name="check" className="size-5 shrink-0" />
          <p className="min-w-0 flex-1 text-sm">
            <strong className="font-semibold">{created.word}</strong>{' '}
            {meta.mode === 'mock' ? 'was added to the sample data.' : 'was added to your vocabulary.'} The form is
            ready for the next word.
          </p>
          <button type="button" className="cursor-pointer text-sm font-semibold underline" onClick={() => openWord(created.id)}>
            View
          </button>
          <Link to={buildHref(ROUTES.bank, { from: created.dateAdded, to: created.dateAdded })} className="text-sm font-semibold underline">
            Open in bank
          </Link>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className={`${CARD} flex flex-col gap-4 p-5`} aria-label="Add vocabulary">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {quick ? 'Quick add: word and meaning only. Press Enter to save.' : 'Only the word is required.'}
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={quick}
              onChange={(event) => setQuick(event.target.checked)}
            />
            Quick add
          </label>
        </div>

        <Field id="add-word" label="Word" required error={errors.word}>
          <input
            ref={wordInput}
            id="add-word"
            className={INPUT}
            value={values.word}
            onChange={(event) => change('word', event.target.value)}
            placeholder="e.g. serendipity"
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck
            maxLength={FIELD_LIMITS.word}
            aria-required="true"
            aria-invalid={errors.word ? true : undefined}
            aria-describedby={describedBy('add-word', null, errors.word)}
            disabled={disabled}
          />
        </Field>

        {similar.length > 0 && duplicates === null && (
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
          <Field id="add-meaning" label="Vietnamese meaning" error={errors.meaning}>
            <input
              id="add-meaning"
              className={INPUT}
              value={values.meaning}
              onChange={(event) => change('meaning', event.target.value)}
              placeholder="Nghĩa tiếng Việt"
              autoComplete="off"
              aria-describedby={describedBy('add-meaning', null, errors.meaning)}
              disabled={disabled}
            />
          </Field>
        ) : (
          <>
            <Field id="add-meaning" label="Vietnamese meaning" error={errors.meaning}>
              <textarea
                id="add-meaning"
                rows={2}
                className={TEXTAREA}
                value={values.meaning}
                onChange={(event) => change('meaning', event.target.value)}
                onKeyDown={submitOnModifiedEnter}
                placeholder="Nghĩa tiếng Việt"
                aria-describedby={describedBy('add-meaning', null, errors.meaning)}
                disabled={disabled}
              />
            </Field>
            <Field
              id="add-definition"
              label="Definition"
              hint="In English. Shown on the card while the word's mastery is 5 or lower."
              error={errors.definition}
            >
              <textarea
                id="add-definition"
                rows={3}
                className={TEXTAREA}
                value={values.definition}
                onChange={(event) => change('definition', event.target.value)}
                onKeyDown={submitOnModifiedEnter}
                placeholder="What the word means"
                aria-describedby={describedBy('add-definition', true, errors.definition)}
                disabled={disabled}
              />
            </Field>
            <Field id="add-example" label="Example sentences" error={errors.example}>
              <textarea
                id="add-example"
                rows={3}
                className={TEXTAREA}
                value={values.example}
                onChange={(event) => change('example', event.target.value)}
                onKeyDown={submitOnModifiedEnter}
                placeholder="A sentence that uses the word"
                aria-describedby={describedBy('add-example', null, errors.example)}
                disabled={disabled}
              />
            </Field>
            <Field id="add-dateAdded" label="Date added" error={errors.dateAdded}>
              <input
                id="add-dateAdded"
                type="date"
                className={`${INPUT} sm:max-w-56`}
                value={values.dateAdded}
                onChange={(event) => change('dateAdded', event.target.value)}
                aria-describedby={describedBy('add-dateAdded', null, errors.dateAdded)}
                disabled={disabled}
              />
            </Field>
          </>
        )}

        <div className="rounded-xl border border-line">
          <button
            type="button"
            aria-expanded={showSchedule}
            onClick={() => setShowSchedule((open) => !open)}
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
              <Field
                id="add-mastery"
                label="Mastery"
                hint={`New words start at ${meta.defaults.mastery}.`}
                error={errors.mastery}
              >
                <input
                  id="add-mastery"
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  inputMode="numeric"
                  className={INPUT}
                  value={values.mastery}
                  onChange={(event) => change('mastery', event.target.value)}
                  aria-describedby={describedBy('add-mastery', true, errors.mastery)}
                  disabled={disabled}
                />
              </Field>
              <Field
                id="add-reviewDate"
                label="Review date"
                hint="Leave empty to have the word due for review immediately."
                error={errors.reviewDate}
              >
                <input
                  id="add-reviewDate"
                  type="date"
                  className={INPUT}
                  value={values.reviewDate}
                  onChange={(event) => change('reviewDate', event.target.value)}
                  aria-describedby={describedBy('add-reviewDate', true, errors.reviewDate)}
                  disabled={disabled}
                />
              </Field>
            </div>
          )}
        </div>

        {duplicates !== null && (
          <div role="alert" className="rounded-xl border border-warn-ink/30 bg-warn-soft p-4 text-warn-ink">
            <p className="font-semibold">This word may already be in your vocabulary</p>
            <ul className="mt-2 flex list-none flex-col gap-2 p-0">
              {duplicates.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <button type="button" className="cursor-pointer font-semibold underline" onClick={() => openWord(entry.id)}>
                    {entry.word}
                  </button>
                  <MasteryPill mastery={entry.mastery} />
                  <span className="min-w-0 flex-1 truncate">{entry.meaning ?? entry.definition ?? ''}</span>
                  <span className="text-xs">added {formatDate(entry.dateAdded, 'short')}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={BUTTON_SECONDARY} onClick={() => submit(true)} disabled={disabled}>
                Add it anyway
              </button>
              <button
                type="button"
                className={BUTTON_GHOST}
                onClick={() => {
                  setDuplicates(null);
                  wordInput.current?.focus();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {failedAttempts.map((attempt) => (
          <div key={attempt.localId} role="alert" className="rounded-xl border border-bad-ink/30 bg-bad-soft p-4 text-bad-ink">
            {attempt.duplicates.length > 0 ? (
              <>
                <p className="font-semibold">
                  <strong className="font-semibold">{attempt.word}</strong> may already be in your vocabulary
                </p>
                <ul className="mt-2 flex list-none flex-col gap-2 p-0">
                  {attempt.duplicates.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <button type="button" className="cursor-pointer font-semibold underline" onClick={() => openWord(entry.id)}>
                        {entry.word}
                      </button>
                      <MasteryPill mastery={entry.mastery} />
                      <span className="min-w-0 flex-1 truncate">{entry.meaning ?? entry.definition ?? ''}</span>
                      <span className="text-xs">added {formatDate(entry.dateAdded, 'short')}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={BUTTON_SECONDARY} onClick={() => resend(attempt, true)} disabled={disabled}>
                    Add it anyway
                  </button>
                  <button type="button" className={BUTTON_GHOST} onClick={() => dismissAttempt(attempt)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  <strong className="font-semibold">{attempt.word}</strong> could not be saved. {attempt.error}{' '}
                  Nothing was lost: try again without typing it all back.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={BUTTON_SECONDARY} onClick={() => resend(attempt)} disabled={disabled}>
                    Retry
                  </button>
                  <button type="button" className={BUTTON_GHOST} onClick={() => editAttempt(attempt)}>
                    Edit
                  </button>
                  <button type="button" className={BUTTON_GHOST} onClick={() => dismissAttempt(attempt)}>
                    Discard
                  </button>
                </div>
              </>
            )}
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={BUTTON_PRIMARY} disabled={disabled}>
            <Icon name="add" className="size-4" />
            Add word
          </button>
          <button type="button" className={BUTTON_GHOST} onClick={clear}>
            Clear form
          </button>
          {!quick && <span className="hidden text-xs text-muted keyboard:inline">Ctrl + Enter saves from any field.</span>}
        </div>
      </form>
    </div>
  );
}
