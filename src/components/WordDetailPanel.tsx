import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FIELD_LIMITS, type UpdateEntryInput, type VocabularyEntry } from '../../shared/api.js';
import { isIsoDate } from '../../shared/dates.js';
import type { DiscoverySourceKind } from '../../shared/discovery.js';
import { useApp, useSettings, useVocabulary } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { MISSING_LABELS, missingFields } from '../lib/bank-query.js';
import { MasteryPill, StatusBadge, formatDate, relativeDay } from './badges.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { openHref } from './discovery/labels.js';
import { Field, describedBy } from './Field.js';
import { Icon } from './Icon.js';
import { Link } from './Link.js';
import { SpeakButton } from './SpeakButton.js';
import { Spinner } from './Spinner.js';
import { WordExtras } from './WordExtras.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT, TEXTAREA } from './ui.js';

export interface WordDetailPanelProps {
  entryId: string;
  onClose: () => void;
}

interface SenseDraft {
  id?: string;
  meaning: string;
  definition: string;
  example: string;
}

interface Draft {
  word: string;
  meaning: string;
  definition: string;
  example: string;
  dateAdded: string;
  mastery: string;
  reviewDate: string;
}

const toDraft = (entry: VocabularyEntry): Draft => ({
  word: entry.word,
  // The shown text: the first sense that is not archived, as the store reports it.
  meaning: entry.meaning ?? '',
  definition: entry.definition ?? '',
  example: entry.example ?? '',
  dateAdded: entry.dateAdded ?? '',
  mastery: entry.mastery === null ? '' : String(entry.mastery),
  reviewDate: entry.reviewDate ?? '',
});

type DraftErrors = Partial<Record<keyof Draft, string>>;

function validate(draft: Draft, scheduleOpen: boolean): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.word.trim() === '') errors.word = 'Enter a word.';
  else if (draft.word.trim().length > FIELD_LIMITS.word) errors.word = `Keep the word under ${FIELD_LIMITS.word} characters.`;
  for (const key of ['meaning', 'definition', 'example'] as const) {
    if (draft[key].trim().length > FIELD_LIMITS.text) errors[key] = `Keep this under ${FIELD_LIMITS.text} characters.`;
  }
  if (draft.dateAdded !== '' && !isIsoDate(draft.dateAdded)) errors.dateAdded = 'Enter a valid date.';
  if (scheduleOpen) {
    const mastery = Number(draft.mastery);
    if (draft.mastery.trim() === '' || !Number.isInteger(mastery) || mastery < 0 || mastery > 10) {
      errors.mastery = 'Mastery must be a whole number from 0 to 10.';
    }
    if (draft.reviewDate !== '' && !isIsoDate(draft.reviewDate)) errors.reviewDate = 'Enter a valid date.';
  }
  return errors;
}

/**
 * Everything stored about one word, with editing and deletion. Opens over the
 * current page; the latest stored values are fetched each time it opens.
 */
export function WordDetailPanel({ entryId, onClose }: WordDetailPanelProps) {
  const { api, vocabulary, toasts } = useApp();
  const { speechLang } = useSettings();
  // Subscribing also loads the vocabulary if this panel was opened from a direct link.
  const loaded = useVocabulary();
  const cached = loaded.entries.find((entry) => entry.id === entryId) ?? null;
  const meta = loaded.meta;
  const canWrite = meta?.writesEnabled ?? false;

  const [entry, setEntry] = useState<VocabularyEntry | null>(cached);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // Where a word was found, when it came from a source: the way back to it.
  const [fromSource, setFromSource] = useState<{ id: string; title: string; kind: DiscoverySourceKind } | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<VocabularyEntry[] | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const closeButton = useRef<HTMLButtonElement>(null);
  const editing = draft !== null;

  // Always show what is stored now, not what was loaded a while ago.
  useEffect(() => {
    let current = true;
    api
      .fetchEntry(entryId)
      .then((latest) => {
        if (!current) return;
        setEntry(latest);
        vocabulary.upsert(latest);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setLoadError(error instanceof ApiError ? error.message : 'Could not load this word.');
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [api, entryId, vocabulary]);

  // A word saved from a source remembers where it was found; one typed in
  // by hand has nothing to show, and that is not an error.
  useEffect(() => {
    let current = true;
    api
      .findWordContext(entryId)
      .then((found) => {
        if (current) setFromSource({ id: found.source.id, title: found.source.title, kind: found.source.kind });
      })
      .catch(() => {
        // Most words have no source; nothing to add.
      });
    return () => {
      current = false;
    };
  }, [api, entryId]);

  // Keep keyboard focus inside the panel when it opens, and give it back afterwards.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // While editing, Escape must not throw away what was typed.
      if (event.key === 'Escape' && !editing && !confirmingDelete) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editing, confirmingDelete, onClose]);

  const startEditing = () => {
    if (entry === null) return;
    setDraft(toDraft(entry));
    setScheduleOpen(false);
    setErrors({});
    setSaveError(null);
    setDuplicateOf(null);
    // One editor at a time: the sense form and the word form do not mix.
    setSenseEditing(false);
    setSenseDraft(null);
    setSenseError(null);
  };

  const change = (key: keyof Draft, value: string) => {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
    setDuplicateOf(null);
  };

  // Sense-related state
  const [senseDraft, setSenseDraft] = useState<SenseDraft | null>(null);
  const [senseEditing, setSenseEditing] = useState(false);
  const [senseSaving, setSenseSaving] = useState(false);
  const [senseError, setSenseError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  const validateSense = (sense: SenseDraft): Partial<Record<keyof SenseDraft, string>> => {
    const errors: Partial<Record<keyof SenseDraft, string>> = {};
    for (const key of ['meaning', 'definition', 'example'] as const) {
      if (sense[key].trim().length > FIELD_LIMITS.text) errors[key] = `Keep this under ${FIELD_LIMITS.text} characters.`;
    }
    if (sense.meaning.trim() === '' && sense.definition.trim() === '' && sense.example.trim() === '') {
      errors.meaning = 'At least one of meaning, definition, or example is required.';
    }
    return errors;
  };

  const startSenseEditing = (index: number) => {
    if (!entry || !entry.senses || entry.senses.length === 0) return;
    const nonArchived = entry.senses.filter(s => !s.archived);
    const sense = nonArchived[index];
    if (!sense) return;
    setSenseDraft({
      id: sense.id,
      meaning: sense.meaning ?? '',
      definition: sense.definition ?? '',
      example: sense.example ?? '',
    });
    setSenseEditing(true);
    setSenseError(null);
  };

  const cancelSenseEditing = () => {
    setSenseEditing(false);
    setSenseDraft(null);
    setSenseError(null);
  };

  const saveSense = async () => {
    if (!entry || !senseDraft || senseSaving) return;
    const errors = validateSense(senseDraft);
    if (Object.keys(errors).length > 0) {
      setSenseError('Please fix the errors above.');
      return;
    }

    setSenseSaving(true);
    setSenseError(null);
    try {
      if (senseDraft.id) {
        // Update existing sense
        const sense = entry.senses!.find(s => s.id === senseDraft.id);
        if (!sense) throw new Error('Sense not found');
        await api.updateEntrySense(sense.id, {
          meaning: senseDraft.meaning || null,
          definition: senseDraft.definition || null,
          example: senseDraft.example || null,
          ifMatch: sense.version,
        });
      } else {
        // Add new sense
        await api.addSense(entry.id, {
          requestId: crypto.randomUUID(),
          meaning: senseDraft.meaning || null,
          definition: senseDraft.definition || null,
          example: senseDraft.example || null,
        });
      }
      // Refresh entry
      const updated = await api.fetchEntry(entry.id);
      setEntry(updated);
      vocabulary.upsert(updated);
      toasts.show({ message: senseDraft.id ? `Updated sense.` : `Added sense.` });
      cancelSenseEditing();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        setSenseError('This sense was modified elsewhere. Please reload and try again.');
      } else {
        setSenseError(error instanceof ApiError ? error.message : 'Could not save the sense.');
      }
    } finally {
      setSenseSaving(false);
    }
  };

  const archiveSense = async (senseId: string, version: number) => {
    if (!entry || senseSaving) return;
    setSenseSaving(true);
    try {
      await api.archiveSense(senseId, { ifMatch: version });
      const updated = await api.fetchEntry(entry.id);
      setEntry(updated);
      vocabulary.upsert(updated);
      toasts.show({ message: 'Sense archived.' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        setSenseError('This sense was modified elsewhere. Please reload and try again.');
      } else {
        setSenseError(error instanceof ApiError ? error.message : 'Could not archive the sense.');
      }
    } finally {
      setSenseSaving(false);
    }
  };

  const restoreSense = async (senseId: string, version: number) => {
    if (!entry || senseSaving) return;
    setSenseSaving(true);
    try {
      await api.restoreSense(senseId, { ifMatch: version });
      const updated = await api.fetchEntry(entry.id);
      setEntry(updated);
      vocabulary.upsert(updated);
      toasts.show({ message: 'Sense restored.' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        setSenseError('This sense was modified elsewhere. Please reload and try again.');
      } else {
        setSenseError(error instanceof ApiError ? error.message : 'Could not restore the sense.');
      }
    } finally {
      setSenseSaving(false);
    }
  };

  const reorderSenses = async (newOrder: string[]) => {
    if (!entry || reordering) return;
    setReordering(true);
    try {
      await api.reorderSenses(entry.id, { senseIds: newOrder, ifMatch: entry.sensesVersion });
      const updated = await api.fetchEntry(entry.id);
      setEntry(updated);
      vocabulary.upsert(updated);
      toasts.show({ message: 'Senses reordered.' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        setSenseError('The sense list was modified elsewhere. Please reload and try again.');
      } else {
        setSenseError(error instanceof ApiError ? error.message : 'Could not reorder senses.');
      }
    } finally {
      setReordering(false);
    }
  };

  const addSense = () => {
    setSenseDraft({ meaning: '', definition: '', example: '' });
    setSenseEditing(true);
    setSenseError(null);
  };

  /** Move one sense up or down the order, swapping it with its neighbour. */
  const moveSense = async (index: number, direction: -1 | 1) => {
    if (!entry) return;
    const live = (entry.senses ?? []).filter((sense) => !sense.archived);
    const target = index + direction;
    if (target < 0 || target >= live.length) return;
    const ids = live.map((sense) => sense.id);
    const swapped = ids[index];
    const other = ids[target];
    if (swapped === undefined || other === undefined) return;
    ids[index] = other;
    ids[target] = swapped;
    await reorderSenses(ids);
  };

  const save = async (allowDuplicate: boolean) => {
    if (entry === null || draft === null || saving) return;
    const found = validate(draft, scheduleOpen);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    // Send only what differs; the server compares again against what is stored.
    const before = toDraft(entry);
    const input: UpdateEntryInput = {};
    if (draft.word !== before.word) input.word = draft.word;
    if (draft.meaning !== before.meaning) input.meaning = draft.meaning;
    if (draft.definition !== before.definition) input.definition = draft.definition;
    if (draft.example !== before.example) input.example = draft.example;
    if (draft.dateAdded !== before.dateAdded) input.dateAdded = draft.dateAdded === '' ? null : draft.dateAdded;
    if (scheduleOpen && (draft.mastery !== before.mastery || draft.reviewDate !== before.reviewDate)) {
      input.schedule = { mastery: Number(draft.mastery), reviewDate: draft.reviewDate === '' ? null : draft.reviewDate };
    }
    if (Object.keys(input).length === 0) {
      setDraft(null);
      return;
    }
    if (allowDuplicate) input.allowDuplicate = true;

    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateEntry(entry.id, input);
      setEntry(updated);
      vocabulary.upsert(updated);
      setDraft(null);
      setDuplicateOf(null);
      toasts.show({ message: `Saved “${updated.word}”.` });
    } catch (error) {
      // The draft stays exactly as typed so nothing has to be entered again.
      if (error instanceof ApiError && error.code === 'duplicate') setDuplicateOf(error.duplicates);
      else setSaveError(error instanceof ApiError ? error.message : 'Could not save the changes.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (entry === null || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteEntry(entry.id);
      vocabulary.remove(entry.id);
      const removed = entry;
      toasts.show({
        message: `Moved “${removed.word}” to the trash.`,
        action: {
          label: 'Undo',
          run: () => {
            api
              .restoreEntry(removed.id)
              .then((restored) => {
                vocabulary.upsert(restored);
                toasts.show({ message: `Restored “${restored.word}”.` });
              })
              .catch((error: unknown) => {
                toasts.show({
                  tone: 'error',
                  message:
                    error instanceof ApiError
                      ? error.message
                      : 'Could not restore the word. It is still in the trash; restore it from Settings.',
                });
              });
          },
        },
      });
      onClose();
    } catch (error) {
      setDeleteError(error instanceof ApiError ? error.message : 'Could not delete the word.');
      setDeleting(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void save(false);
  };

  const missing = entry === null ? [] : missingFields(entry);
  const liveSenses = entry === null ? [] : (entry.senses ?? []).filter((sense) => !sense.archived);
  const archivedSenses = entry === null ? [] : (entry.senses ?? []).filter((sense) => sense.archived);
  const today = meta?.today ?? null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/30"
        aria-hidden="true"
        onClick={() => {
          if (!editing) onClose();
        }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="word-panel-title"
        className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-paper shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
              {editing ? 'Editing word' : 'Word'}
            </p>
            <h2 id="word-panel-title" className="font-serif text-2xl font-semibold tracking-tight wrap-anywhere">
              {entry?.word ?? 'Word'}
            </h2>
            {entry !== null && (
              <div className="mt-1">
                <SpeakButton word={entry.word} lang={speechLang} />
              </div>
            )}
          </div>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={saving}
            className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-line/40 hover:text-ink"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {entry === null && checking && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Loading the word…
            </p>
          )}
          {entry === null && !checking && (
            <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
              {loadError ?? 'This word could not be found.'}
            </p>
          )}

          {entry !== null && !editing && (
            <div className="flex flex-col gap-5">
              {loadError !== null && (
                <p role="alert" className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink">
                  Showing the last loaded values. {loadError}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={entry.reviewStatus} />
                <span className="flex items-center gap-1.5 text-sm text-muted">
                  Mastery <MasteryPill mastery={entry.mastery} />
                </span>
              </div>

              {fromSource !== null && (
                <p className="text-sm text-muted">
                  Found in{' '}
                  <Link
                    to={openHref(fromSource.id, fromSource.kind)}
                    className="font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    {fromSource.title}
                  </Link>
                  — back to the source.
                </p>
              )}

              {/* Senses display */}
              {entry.senses && entry.senses.length > 0 && (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Senses ({liveSenses.length})</h3>
                    {canWrite && !senseEditing && (
                      <button type="button" className={BUTTON_SECONDARY} onClick={addSense} disabled={saving || senseSaving || reordering}>
                        <Icon name="add" className="size-4" /> Add Sense
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col gap-3">
                    {liveSenses.map((sense, index) => (
                      <div key={sense.id} className="relative rounded-xl border border-line p-4">
                        <div className="flex items-start justify-between gap-2">
                          <span className="flex items-center gap-2 text-sm text-muted">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-line text-ink">
                              {index + 1}
                            </span>
                            <span className="font-medium">Sense {index + 1}</span>
                            {sense.archived && <span className="text-xs text-muted">(archived)</span>}
                          </span>
                          {canWrite && !senseEditing && (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                className={BUTTON_GHOST}
                                onClick={() => startSenseEditing(index)}
                                disabled={saving || senseSaving || reordering}
                                aria-label={`Edit sense ${index + 1}`}
                              >
                                <Icon name="edit" className="size-4" />
                              </button>
                              <button
                                type="button"
                                className={BUTTON_GHOST}
                                onClick={() => void moveSense(index, -1)}
                                disabled={saving || senseSaving || reordering || index === 0}
                                aria-label={`Move sense ${index + 1} up`}
                              >
                                <Icon name="left" className="size-4 -rotate-90" />
                              </button>
                              <button
                                type="button"
                                className={BUTTON_GHOST}
                                onClick={() => void moveSense(index, 1)}
                                disabled={saving || senseSaving || reordering || index === liveSenses.length - 1}
                                aria-label={`Move sense ${index + 1} down`}
                              >
                                <Icon name="left" className="size-4 rotate-90" />
                              </button>
                              <button
                                type="button"
                                className={BUTTON_GHOST}
                                onClick={() => archiveSense(sense.id, sense.version)}
                                disabled={saving || senseSaving || reordering}
                                aria-label={`Archive sense ${index + 1}`}
                              >
                                <Icon name="trash" className="size-4" />
                              </button>
                            </div>
                          )}
                        </div>
                        <dl className="mt-3 flex flex-col gap-3">
                          <DetailRow label="Vietnamese meaning" value={sense.meaning} />
                          <DetailRow label="Definition" value={sense.definition} />
                          <DetailRow label="Example sentences" value={sense.example} />
                        </dl>
                      </div>
                    ))}
                  </div>
                  {archivedSenses.length > 0 && (
                    <details className="rounded-xl border border-line">
                      <summary className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted cursor-pointer">
                        <Icon name="trash" className="size-4" />
                        Archived senses ({archivedSenses.length})
                      </summary>
                      <div className="flex flex-col gap-3 p-4 border-t border-line">
                        {archivedSenses.map((sense) => (
                          <div key={sense.id} className="rounded-xl border border-line/50 p-3 bg-muted/20">
                            <div className="flex items-start justify-between gap-2">
                              <span className="flex items-center gap-2 text-sm text-muted">
                                <span className="font-medium">Archived sense</span>
                              </span>
                              {canWrite && !senseEditing && (
                                <button
                                  type="button"
                                  className={BUTTON_GHOST}
                                  onClick={() => restoreSense(sense.id, sense.version)}
                                  disabled={saving || senseSaving || reordering}
                                  aria-label="Restore sense"
                                >
                                  <Icon name="refresh" className="size-4" /> Restore
                                </button>
                              )}
                            </div>
                            <dl className="mt-2 flex flex-col gap-2 text-sm">
                              <div>
                                <dt className="text-muted">Vietnamese meaning</dt>
                                <dd className="m-0 whitespace-pre-line">{sense.meaning ?? 'Not set'}</dd>
                              </div>
                              <div>
                                <dt className="text-muted">Definition</dt>
                                <dd className="m-0 whitespace-pre-line">{sense.definition ?? 'Not set'}</dd>
                              </div>
                              <div>
                                <dt className="text-muted">Example</dt>
                                <dd className="m-0 whitespace-pre-line">{sense.example ?? 'Not set'}</dd>
                              </div>
                            </dl>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* Minimal profile indicator */}
              {(!entry.senses || entry.senses.filter(s => !s.archived).length === 0) && (
                <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink">
                  <Icon name="warning" className="mt-0.5 size-4 shrink-0" />
                  <span>
                    This word has no senses yet. Add a meaning to make it reviewable.
                  </span>
                </p>
              )}

              {/* Legacy fields display for compatibility */}
              {(!entry.senses || entry.senses.length === 0) && (
                <dl className="flex flex-col gap-4">
                  <DetailRow label="Vietnamese meaning" value={entry.meaning} />
                  <DetailRow label="Definition" value={entry.definition} />
                  <DetailRow label="Example sentences" value={entry.example} />
                  <div className="grid grid-cols-2 gap-4">
                    <DetailRow label="Date added" value={entry.dateAdded === null ? null : formatDate(entry.dateAdded)} />
                    <DetailRow
                      label={entry.scheduledBy === 'fsrs' ? 'Review date (set by FSRS)' : 'Review date'}
                      value={
                        entry.reviewDate === null
                          ? null
                          : `${formatDate(entry.reviewDate)}${relativeDay(entry.reviewDate, today) ? ` (${relativeDay(entry.reviewDate, today)})` : ''}`
                      }
                    />
                  </div>
                </dl>
              )}

              {missing.length > 0 && (
                <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink">
                  <Icon name="warning" className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {missing.map((key) => MISSING_LABELS[key]).join('. ')}. This does not stop the word from being
                    reviewed.
                  </span>
                </p>
              )}

              <WordExtras entry={entry} canWrite={canWrite} />
            </div>
          )}

          {entry !== null && draft !== null && (
            <form id="word-edit-form" onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
              <Field id="edit-word" label="Word" required error={errors.word}>
                <input
                  id="edit-word"
                  className={INPUT}
                  value={draft.word}
                  onChange={(event) => change('word', event.target.value)}
                  aria-invalid={errors.word ? true : undefined}
                  aria-describedby={describedBy('edit-word', null, errors.word)}
                  maxLength={FIELD_LIMITS.word}
                  autoComplete="off"
                />
              </Field>
              <Field id="edit-meaning" label="Vietnamese meaning" error={errors.meaning}>
                <textarea
                  id="edit-meaning"
                  rows={2}
                  className={TEXTAREA}
                  value={draft.meaning}
                  onChange={(event) => change('meaning', event.target.value)}
                  aria-describedby={describedBy('edit-meaning', null, errors.meaning)}
                />
              </Field>
              <Field id="edit-definition" label="Definition" error={errors.definition}>
                <textarea
                  id="edit-definition"
                  rows={3}
                  className={TEXTAREA}
                  value={draft.definition}
                  onChange={(event) => change('definition', event.target.value)}
                  aria-describedby={describedBy('edit-definition', null, errors.definition)}
                />
              </Field>
              <Field id="edit-example" label="Example sentences" error={errors.example}>
                <textarea
                  id="edit-example"
                  rows={3}
                  className={TEXTAREA}
                  value={draft.example}
                  onChange={(event) => change('example', event.target.value)}
                  aria-describedby={describedBy('edit-example', null, errors.example)}
                />
              </Field>
              <Field id="edit-date-added" label="Date added" error={errors.dateAdded}>
                <input
                  id="edit-date-added"
                  type="date"
                  className={INPUT}
                  value={draft.dateAdded}
                  onChange={(event) => change('dateAdded', event.target.value)}
                  aria-describedby={describedBy('edit-date-added', null, errors.dateAdded)}
                />
              </Field>

              <div className="rounded-xl border border-line">
                <button
                  type="button"
                  aria-expanded={scheduleOpen}
                  onClick={() => setScheduleOpen((open) => !open)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-medium"
                >
                  <span>Review schedule</span>
                  <span className="text-xs font-normal text-muted">
                    {scheduleOpen ? 'Will be saved' : 'Not changed unless opened'}
                  </span>
                </button>
                {scheduleOpen && (
                  <div className="flex flex-col gap-3 border-t border-line p-3">
                    <p className="text-xs text-muted">
                      Mastery and the review date are normally set by reviewing. Changing them here overrides the
                      schedule for this word.
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <Field id="edit-mastery" label="Mastery" error={errors.mastery}>
                        <input
                          id="edit-mastery"
                          type="number"
                          min={0}
                          max={10}
                          step={1}
                          inputMode="numeric"
                          className={INPUT}
                          value={draft.mastery}
                          onChange={(event) => change('mastery', event.target.value)}
                          aria-describedby={describedBy('edit-mastery', null, errors.mastery)}
                        />
                      </Field>
                      <Field id="edit-review-date" label="Review date" error={errors.reviewDate}>
                        <input
                          id="edit-review-date"
                          type="date"
                          className={INPUT}
                          value={draft.reviewDate}
                          // FSRS works this date out from the answers; there is nothing honest to store for a typed one.
                          disabled={entry.scheduledBy === 'fsrs'}
                          onChange={(event) => change('reviewDate', event.target.value)}
                          aria-describedby={describedBy(
                            'edit-review-date',
                            entry.scheduledBy === 'fsrs' ? true : null,
                            errors.reviewDate,
                          )}
                        />
                      </Field>
                    </div>
                    {entry.scheduledBy === 'fsrs' && (
                      <p id="edit-review-date-hint" className="text-xs text-muted">
                        FSRS sets this word’s review date from your answers, so it cannot be changed by hand. To set
                        dates yourself, go back to the mastery schedule in Settings.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {duplicateOf !== null && (
                <div role="alert" className="rounded-xl border border-warn-ink/30 bg-warn-soft p-3 text-sm text-warn-ink">
                  <p className="font-semibold">Another word is already spelled this way</p>
                  <ul className="mt-1 list-disc pl-5">
                    {duplicateOf.map((other) => (
                      <li key={other.id}>
                        {other.word}
                        {other.meaning ? ` — ${other.meaning}` : ''}
                      </li>
                    ))}
                  </ul>
                  <button type="button" className={`${BUTTON_SECONDARY} mt-3`} onClick={() => void save(true)} disabled={saving}>
                    Save anyway
                  </button>
                </div>
              )}
              {saveError !== null && (
                <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
                  {saveError} Your changes are still here.
                </p>
              )}

            </form>
          )}

          {/* The sense editor belongs to the word view, not to the word form:
              the sense buttons are only reachable while the word is not being edited. */}
          {entry !== null && senseEditing && senseDraft !== null && (
            <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h4 className="font-semibold">{senseDraft.id ? 'Edit Sense' : 'Add Sense'}</h4>
                <button type="button" className={BUTTON_GHOST} onClick={cancelSenseEditing} disabled={senseSaving} aria-label="Cancel">
                  <Icon name="close" className="size-4" />
                </button>
              </div>
              {senseError && (
                <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink mb-3">
                  {senseError}
                </p>
              )}
              <Field id="sense-meaning" label="Vietnamese meaning" error={senseError?.includes('meaning') ? 'Required' : undefined}>
                <textarea
                  id="sense-meaning"
                  rows={2}
                  className={TEXTAREA}
                  value={senseDraft.meaning}
                  onChange={(event) => setSenseDraft(d => d ? { ...d, meaning: event.target.value } : null)}
                  aria-describedby={describedBy('sense-meaning', null, senseError?.includes('meaning') ? 'Required' : undefined)}
                />
              </Field>
              <Field id="sense-definition" label="Definition">
                <textarea
                  id="sense-definition"
                  rows={3}
                  className={TEXTAREA}
                  value={senseDraft.definition}
                  onChange={(event) => setSenseDraft(d => d ? { ...d, definition: event.target.value } : null)}
                />
              </Field>
              <Field id="sense-example" label="Example sentences">
                <textarea
                  id="sense-example"
                  rows={3}
                  className={TEXTAREA}
                  value={senseDraft.example}
                  onChange={(event) => setSenseDraft(d => d ? { ...d, example: event.target.value } : null)}
                />
              </Field>
              <div className="flex flex-wrap gap-2 mt-3">
                <button type="button" className={BUTTON_PRIMARY} onClick={saveSense} disabled={senseSaving}>
                  {senseSaving && <Spinner />}
                  {senseSaving ? 'Saving…' : senseDraft.id ? 'Update Sense' : 'Add Sense'}
                </button>
                <button type="button" className={BUTTON_GHOST} onClick={cancelSenseEditing} disabled={senseSaving}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {entry !== null && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {editing ? (
              <>
                <button type="submit" form="word-edit-form" className={BUTTON_PRIMARY} disabled={saving}>
                  {saving && <Spinner />}
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
                <button type="button" className={BUTTON_GHOST} onClick={() => setDraft(null)} disabled={saving}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className={BUTTON_PRIMARY} onClick={startEditing} disabled={!canWrite}>
                  <Icon name="edit" className="size-4" /> Edit
                </button>
                <button
                  type="button"
                  className={`${BUTTON_GHOST} ml-auto text-bad-ink hover:text-bad-ink`}
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmingDelete(true);
                  }}
                  disabled={!canWrite}
                >
                  <Icon name="trash" className="size-4" /> Delete
                </button>
                {!canWrite && <p className="w-full text-xs text-muted">Saving is switched off, so this word is read-only.</p>}
              </>
            )}
          </div>
        )}
      </aside>

      {confirmingDelete && entry !== null && (
        <ConfirmDialog
          title={`Delete “${entry.word}”?`}
          confirmLabel="Move to trash"
          busy={deleting}
          error={deleteError}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmingDelete(false)}
        >
          <p>
            <strong className="text-ink">{entry.word}</strong>
            {entry.meaning ? ` (${entry.meaning})` : ''} will be moved to the trash, together with its mastery of{' '}
            {entry.mastery ?? '—'}. It can be restored at any time from Settings, under Deleted words.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className={`m-0 whitespace-pre-line wrap-anywhere ${value === null ? 'text-muted' : 'text-ink'}`}>
        {value ?? 'Not set'}
      </dd>
    </div>
  );
}
