import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CreateEntryInput, VocabularyEntry } from '../../shared/api.js';
import { normalizeWord } from '../../shared/text.js';
import { useApp, useVocabulary } from '../app-context.js';
import { MasteryPill, formatDate } from '../components/badges.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { VocabularyFields } from '../components/VocabularyFields.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, PAGE } from '../components/ui.js';
import { newRequestId } from '../lib/request-id.js';
import { ROUTES, buildHref, openWord } from '../lib/router.js';
import { FORM_FIELDS, blankForm, validate, type FormErrors, type FormValues } from '../lib/vocabulary-form.js';
import type { VocabularyMeta, WriteResult } from '../lib/vocabulary-store.js';

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
      const first = FORM_FIELDS.find((key) => found[key]);
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

        <VocabularyFields
          idPrefix="add"
          values={values}
          errors={errors}
          disabled={disabled}
          quick={quick}
          showSchedule={showSchedule}
          onToggleSchedule={() => setShowSchedule((open) => !open)}
          onChange={change}
          onSubmitModifiedEnter={submitOnModifiedEnter}
          similar={similar}
          hideSimilar={duplicates !== null}
          masteryDefault={meta.defaults.mastery}
          wordInputRef={wordInput}
        />

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
