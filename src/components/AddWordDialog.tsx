/**
 * Adding a word straight from a Vocabulary Expert reply. The dialog opens with
 * the four fields a flashcard keeps — word, Vietnamese meaning, English
 * definition, example — read out of the reply and ready to fix up; everything
 * else the reply said stays in the chat. It saves exactly as the Add page
 * saves, through the same store, validation and duplicate checks.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { normalizeWord } from '../../shared/text.js';
import { useApp, useVocabulary } from '../app-context.js';
import { Icon } from '../components/Icon.js';
import { Spinner } from '../components/Spinner.js';
import { VocabularyFields } from '../components/VocabularyFields.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY } from '../components/ui.js';
import { FORM_FIELDS, validate, type FormErrors, type FormValues } from '../lib/vocabulary-form.js';
import type { ExtractedExample, ExampleRegister, ExtractedField } from '../lib/vocabulary-analysis.js';
import type { VocabularyMeta } from '../lib/vocabulary-store.js';

const FIELD_LABEL: Record<ExtractedField, string> = {
  word: 'the word',
  meaning: 'the Vietnamese meaning',
  definition: 'the English definition',
  example: 'an example sentence',
};

/** What the dialog opens with: the four fields, what to say about missing ones, and any schedule already chosen. */
export interface AddWordDraft {
  word: string;
  meaning: string;
  definition: string;
  example: string;
  /** The register-labelled examples parsed from the reply, when present. */
  examples?: ExtractedExample[];
  /** The fields the reply did not carry, for the notice above the form. */
  missing: ExtractedField[];
  /** Set when a failed attempt is edited, so nothing is typed again. */
  dateAdded?: string;
  mastery?: string;
  reviewDate?: string;
}

export interface AddWordDialogProps {
  /** The four fields read out of the reply, and any it did not carry. */
  initial: AddWordDraft;
  /** Called with the reviewed values; the caller saves them. The selected examples (with edits) and the primary register follow. */
  onSubmit: (values: FormValues, selectedExamples?: ExtractedExample[], primaryRegister?: ExampleRegister | null) => void;
  onClose: () => void;
}

export function AddWordDialog({ initial, onSubmit, onClose }: AddWordDialogProps) {
  const state = useVocabulary();
  const { vocabulary } = useApp();

  return (
    <Modal title="Add this word" onCancel={onClose}>
      {state.meta === null ? (
        <div className="flex flex-col gap-4 py-6">
          {state.status === 'error' ? (
            <>
              <p role="alert" className="text-sm text-bad-ink">
                {state.error?.message ?? 'Could not load your vocabulary.'}
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className={BUTTON_SECONDARY} onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className={BUTTON_PRIMARY} onClick={() => void vocabulary.reload()}>
                  Try again
                </button>
              </div>
            </>
          ) : (
            <p role="status" className="flex items-center justify-center gap-3 py-2 text-sm text-muted">
              <Spinner className="size-5" />
              Loading your vocabulary…
            </p>
          )}
        </div>
      ) : (
        <AddWordForm meta={state.meta} entries={state.entries} initial={initial} onSubmit={onSubmit} onCancel={onClose} />
      )}
    </Modal>
  );
}

function AddWordForm({
  meta,
  entries,
  initial,
  onSubmit,
  onCancel,
}: {
  meta: VocabularyMeta;
  entries: VocabularyEntry[];
  initial: AddWordDraft;
  onSubmit: (values: FormValues, selectedExamples?: ExtractedExample[], primaryRegister?: ExampleRegister | null) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => ({
    word: initial.word,
    meaning: initial.meaning,
    definition: initial.definition,
    example: initial.example,
    dateAdded: initial.dateAdded === undefined || initial.dateAdded === '' ? meta.today : initial.dateAdded,
    mastery: initial.mastery === undefined || initial.mastery === '' ? String(meta.defaults.mastery) : initial.mastery,
    reviewDate:
      initial.reviewDate === undefined ? (meta.defaults.reviewDate === 'today' ? meta.today : '') : initial.reviewDate,
  }));
  const [errors, setErrors] = useState<FormErrors>({});
  const [showSchedule, setShowSchedule] = useState(false);
  const examples = initial.examples ?? [];
  const [selected, setSelected] = useState<Set<ExampleRegister>>(() => new Set());
  const [primary, setPrimary] = useState<ExampleRegister | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>(() =>
    Object.fromEntries(examples.map((example) => [example.register, example.sentence])),
  );

  const toggleExample = (register: ExampleRegister, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(register);
      else next.delete(register);
      return next;
    });
    if (!checked && primary === register) {
      const remaining = [...selected].filter((item) => item !== register);
      setPrimary(remaining.length > 0 ? remaining[0]! : null);
    }
    if (checked && primary === null) setPrimary(register);
  };

  const choosePrimary = (register: ExampleRegister) => {
    if (selected.has(register)) setPrimary(register);
  };

  const wordInput = useRef<HTMLInputElement>(null);
  const disabled = !meta.writesEnabled;

  const change = (key: keyof FormValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const similar = useMemo(() => {
    const wanted = normalizeWord(values.word);
    return wanted === '' ? [] : entries.filter((entry) => normalizeWord(entry.word) === wanted);
  }, [entries, values.word]);

  const missingNote =
    initial.missing.length === 0
      ? null
      : `Could not find ${listOf(initial.missing.map((field) => FIELD_LABEL[field]))} in this reply — fill ${
          initial.missing.length === 1 ? 'it' : 'them'
        } in, or leave ${initial.missing.length === 1 ? 'it' : 'them'} empty.`;

  const submit = () => {
    if (disabled) return;
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Send focus to the first problem so it is announced and easy to fix.
      const first = FORM_FIELDS.find((key) => found[key]);
      if (first === 'mastery' || first === 'reviewDate') setShowSchedule(true);
      // Deferred so a field inside the just-opened settings section exists by then.
      if (first) setTimeout(() => document.getElementById(`addword-${first}`)?.focus(), 0);
      return;
    }
    const selectedExamples = examples
      .filter((example) => selected.has(example.register))
      .map((example) => ({ ...example, sentence: (edited[example.register] ?? example.sentence).trim() }));
    const primarySentence = primary !== null ? (edited[primary] ?? '').trim() : '';
    const submitValues =
      primarySentence === '' ? values : { ...values, example: primarySentence };
    onSubmit(submitValues, selectedExamples, primary);
  };

  const onSubmitForm = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const submitOnModifiedEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  const exampleChooser =
    examples.length > 0 ? (
      <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm font-medium text-ink">Examples from this reply</p>
        <p className="text-xs text-muted">Tick the ones to save. The primary becomes the word’s main example; the rest are saved as further examples.</p>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {examples.map((example) => {
            const checked = selected.has(example.register);
            return (
              <li key={example.register} className="flex flex-col gap-1">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => toggleExample(example.register, event.target.checked)}
                  />
                  <span>{example.label}</span>
                  {checked && (
                    <label className="ml-auto flex items-center gap-1 text-xs font-normal text-muted">
                      <input
                        type="radio"
                        name="primary-example"
                        className="size-3.5 accent-[var(--accent)]"
                        checked={primary === example.register}
                        disabled={disabled}
                        onChange={() => choosePrimary(example.register)}
                      />
                      Primary
                    </label>
                  )}
                </label>
                {checked && (
                  <textarea
                    className="min-h-[3rem] w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink"
                    value={edited[example.register] ?? example.sentence}
                    disabled={disabled}
                    onChange={(event) => setEdited((previous) => ({ ...previous, [example.register]: event.target.value }))}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {selected.size > 0 && (
          <p className="text-xs text-muted">
            Saving: {primary !== null ? 1 : 0} primary
            {selected.size - (primary !== null ? 1 : 0) > 0
              ? ` + ${selected.size - (primary !== null ? 1 : 0)} further`
              : ''}
            .
          </p>
        )}
      </section>
    ) : null;

  return (
    <form onSubmit={onSubmitForm} noValidate className="mt-3 flex flex-col gap-4" aria-label="Add this word">
      <p className="text-sm text-muted">
        Only these fields are saved to your vocabulary; the rest of the reply stays in the chat.
      </p>

      {missingNote !== null && (
        <p className="flex items-start gap-2 rounded-xl border border-warn-ink/30 bg-warn-soft px-3 py-2 text-sm text-warn-ink">
          <Icon name="warning" className="mt-0.5 size-4 shrink-0" />
          <span>{missingNote}</span>
        </p>
      )}

      <VocabularyFields
        idPrefix="addword"
        values={values}
        errors={errors}
        disabled={disabled}
        showSchedule={showSchedule}
        onToggleSchedule={() => setShowSchedule((open) => !open)}
        onChange={change}
        onSubmitModifiedEnter={submitOnModifiedEnter}
        similar={similar}
        masteryDefault={meta.defaults.mastery}
        wordInputRef={wordInput}
        hideExample={examples.length > 0}
        exampleSlot={exampleChooser}
      />

      {disabled && (
        <p className="text-sm text-muted">Saving is switched off for this workspace, so this word cannot be added here.</p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" className={BUTTON_GHOST} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={BUTTON_PRIMARY} disabled={disabled}>
          <Icon name="add" className="size-4" />
          Add to vocabulary
        </button>
      </div>
      <p className="text-right text-xs text-muted keyboard:block">Ctrl + Enter saves from any field.</p>
    </form>
  );
}

/** "a, b and c" — the fields a note lists. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The modal frame, following the pattern of ConfirmDialog. */
function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    // jsdom has no showModal; the dialog is then simply rendered open.
    if (typeof element.showModal === 'function' && !element.open) element.showModal();
    else element.setAttribute('open', '');
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="add-word-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onCancel();
      }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40"
    >
      <div className="max-h-[min(42rem,85vh)] overflow-y-auto p-5">
        <h2 id="add-word-dialog-title" className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
