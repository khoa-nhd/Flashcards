import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { FIELD_LIMITS, type CreateEntryInput, type VocabularyEntry } from '../../shared/api.js';
import { isIsoDate } from '../../shared/dates.js';
import { normalizeWord } from '../../shared/text.js';
import { useApp, useVocabulary } from '../app-context.js';
import { MasteryPill, formatDate } from '../components/badges.js';
import { Field, describedBy } from '../components/Field.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { SmartReaderPanel, type Draft } from '../components/SmartReader.js';
import { Spinner } from '../components/Spinner.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, INPUT, PAGE, TEXTAREA } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';
import { newRequestId } from '../lib/request-id.js';
import { ROUTES, buildHref, openWord } from '../lib/router.js';
import type { VocabularyMeta } from '../lib/vocabulary-store.js';

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
  const [tab, setTab] = useState<'manual' | 'reader'>('manual');
  const [prefill, setPrefill] = useState<Draft | null>(null);
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
      <VocabularyGate state={state}>
        {state.meta !== null && (
          <div className="flex flex-col gap-4">
            {/* Two ways to add: the form always works; the reader is only offered
                where the server can actually answer it. */}
            <div className="flex gap-2" role="group" aria-label="How to add a word">
              <button
                type="button"
                className={tab === 'manual' ? BUTTON_SECONDARY : BUTTON_GHOST}
                aria-pressed={tab === 'manual'}
                onClick={() => setTab('manual')}
              >
                By hand
              </button>
              {state.meta.writesEnabled && (
                <button
                  type="button"
                  className={tab === 'reader' ? BUTTON_SECONDARY : BUTTON_GHOST}
                  aria-pressed={tab === 'reader'}
                  onClick={() => setTab('reader')}
                >
                  Smart Reader
                </button>
              )}
            </div>
            {/* Both stay mounted so neither loses what is already in it. */}
            <div hidden={tab !== 'manual'}>
              <AddForm meta={state.meta} entries={state.entries} prefill={prefill} />
            </div>
            {state.meta.writesEnabled && (
              <div hidden={tab !== 'reader'}>
                <SmartReaderPanel
                  onDraft={(draft) => {
                    setPrefill(draft);
                    setTab('manual');
                  }}
                />
              </div>
            )}
          </div>
        )}
      </VocabularyGate>
    </div>
  );
}

function AddForm({
  meta,
  entries,
  prefill,
}: {
  meta: VocabularyMeta;
  entries: VocabularyEntry[];
  /** A draft handed over from the Smart Reader, or null for an empty form. */
  prefill: Draft | null;
}) {
  const { api, vocabulary } = useApp();
  const [values, setValues] = useState<FormValues>(() => blankForm(meta));
  const [errors, setErrors] = useState<FormErrors>({});
  const [quick, setQuick] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Existing words the user must look at before a duplicate is created. */
  const [duplicates, setDuplicates] = useState<VocabularyEntry[] | null>(null);
  const [created, setCreated] = useState<VocabularyEntry | null>(null);

  const wordInput = useRef<HTMLInputElement>(null);
  /** Blocks a second submit in the same tick, before React has re-rendered the disabled button. */
  const submitting = useRef(false);
  /** One id per distinct submission; a retry of the same content reuses it. */
  const requestId = useRef(newRequestId());
  /** The last draft folded in, so arriving twice on the same one changes nothing. */
  const [usedDraft, setUsedDraft] = useState<Draft | null>(null);

  // A draft from the Smart Reader lands here: the ordinary form fills in, ready
  // to be checked and edited like anything typed by hand. Adjusted during
  // render rather than in an effect, so the fields are filled in the same paint.
  if (prefill !== null && prefill !== usedDraft) {
    setUsedDraft(prefill);
    setValues((current) => ({ ...current, ...prefill }));
    setQuick(false);
    setDuplicates(null);
    setFailure(null);
    setErrors((current) => ({ ...current, word: undefined, meaning: undefined, definition: undefined, example: undefined }));
  }

  // A draft is a distinct submission, so it gets its own id — in an effect,
  // where refs belong.
  useEffect(() => {
    if (prefill !== null) requestId.current = newRequestId();
  }, [prefill]);

  // After a save the fields are enabled again; put the cursor back in Word for the next entry.
  useEffect(() => {
    if (created !== null) wordInput.current?.focus();
  }, [created]);

  const change = (key: keyof FormValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setDuplicates(null);
    setFailure(null);
    requestId.current = newRequestId();
  };

  // A live hint from the words already loaded; the server checks again when saving.
  const similar = useMemo(() => {
    const wanted = normalizeWord(values.word);
    return wanted === '' ? [] : entries.filter((entry) => normalizeWord(entry.word) === wanted);
  }, [entries, values.word]);

  const submit = async (allowDuplicate: boolean) => {
    if (submitting.current || !meta.writesEnabled) return;
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

    submitting.current = true;
    setSaving(true);
    setFailure(null);
    setCreated(null);
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
    try {
      const entry = await api.createEntry(input);
      // Only now, with the stored record in hand, is anything shown as saved.
      vocabulary.upsert(entry);
      setCreated(entry);
      setDuplicates(null);
      // Keep the date and starting values for the next word; clear what is specific to this one.
      setValues((current) => ({ ...current, word: '', meaning: '', definition: '', example: '' }));
      requestId.current = newRequestId();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'duplicate') setDuplicates(error.duplicates);
      else setFailure(error instanceof ApiError ? error.message : 'Could not save the word.');
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(false);
  };

  /** In a multi-line field Enter adds a line; Ctrl or Cmd + Enter saves. */
  const submitOnModifiedEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit(false);
    }
  };

  const clear = () => {
    setValues(blankForm(meta));
    setErrors({});
    setDuplicates(null);
    setFailure(null);
    setCreated(null);
    requestId.current = newRequestId();
    wordInput.current?.focus();
  };

  const disabled = saving || !meta.writesEnabled;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
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
              <button type="button" className={BUTTON_SECONDARY} onClick={() => void submit(true)} disabled={disabled}>
                {saving && <Spinner />}
                Add it anyway
              </button>
              <button
                type="button"
                className={BUTTON_GHOST}
                onClick={() => {
                  setDuplicates(null);
                  wordInput.current?.focus();
                }}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {failure !== null && (
          <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
            {failure} Nothing was lost: your entry is still in the form.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={BUTTON_PRIMARY} disabled={disabled} aria-busy={saving}>
            {saving ? <Spinner /> : <Icon name="add" className="size-4" />}
            {saving ? 'Saving…' : 'Add word'}
          </button>
          <button type="button" className={BUTTON_GHOST} onClick={clear} disabled={saving}>
            Clear form
          </button>
          {!quick && <span className="hidden text-xs text-muted keyboard:inline">Ctrl + Enter saves from any field.</span>}
        </div>
      </form>
    </div>
  );
}
