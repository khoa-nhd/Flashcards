/**
 * The "Add Word" action under a Vocabulary Expert reply, and the states it can
 * be in after a click: saving, added, a word already in the bank, or a failure
 * with ways out. The form dialog opens from here, and once a word is saved the
 * message is marked so the "Added" state survives a reload.
 */
import { useState, type ReactNode } from 'react';
import type { AiMessage, CreateEntryInput, UpdateEntryInput, VocabularyEntry } from '../../shared/api.js';
import { useApp, useLibrary, useUiLanguage, useVocabulary } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { openWord } from '../lib/router.js';
import { extractVocabularyAnalysis } from '../lib/vocabulary-analysis.js';
import type { ExtractedExample, ExampleRegister } from '../lib/vocabulary-analysis.js';
import { createInputOf, type FormValues } from '../lib/vocabulary-form.js';
import type { WriteResult } from '../lib/vocabulary-store.js';
import { AddWordDialog, type AddWordDraft } from './AddWordDialog.js';
import { MasteryPill, StrengthPill, formatDate } from './badges.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY } from './ui.js';

/**
 * One "Add Word" attempt. It sticks around after it is made, so the status and
 * — when it fails — what to do about it stay on screen.
 */
interface Attempt {
  status: 'saving' | 'added' | 'duplicate' | 'failed';
  /** The word as the reply spells it, for the messages. */
  word: string;
  values: FormValues;
  /** All register-labelled examples parsed from the reply. */
  examples: ExtractedExample[];
  /** The register-labelled examples chosen in the dialog. */
  selectedExamples: ExtractedExample[];
  /** The register chosen as the primary example. */
  primaryRegister: ExampleRegister | null;
  /** What a fresh save would send. */
  input: Omit<CreateEntryInput, 'requestId'>;
  /** Whether a retry repeats the create or the update. */
  kind: 'create' | 'update';
  /** The outbox operation behind this attempt, when it went through the store. */
  operationId: string | null;
  /** The existing word an update targets. */
  target: VocabularyEntry | null;
  /** The stored word, once the database has confirmed it. */
  entry: VocabularyEntry | null;
  duplicates: VocabularyEntry[];
  error: string | null;
}

export interface AddWordActionsProps {
  message: AiMessage;
  conversationId: string;
  /** The word this reply was saved to, from the message's metadata. */
  savedVocabularyId: string | null;
  /** Called once the message is confirmed saved, so the row says so at once. */
  onSaved: (messageId: string, vocabularyId: string) => void;
  /** The Copy button, shown beside the action. */
  children?: ReactNode;
}

export function AddWordActions({ message, conversationId, savedVocabularyId, onSaved, children }: AddWordActionsProps) {
  const { api, vocabulary } = useApp();
  const vocabularyState = useVocabulary();
  const language = useUiLanguage();
  const fsrsOnly = vocabularyState.meta?.fsrsOnly === true;
  const libraryService = useApp().library;
  const library = useLibrary();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [parsedExamples, setParsedExamples] = useState<ExtractedExample[]>([]);
  /** When open: what the dialog shows. Parsing waits for the click, so a long reply costs nothing. */
  const [dialog, setDialog] = useState<AddWordDraft | null>(null);

  const markSaved = (entry: VocabularyEntry) => {
    onSaved(message.id, entry.id);
    // Best effort: the row already says Added; the database copy follows.
    void api.markMessageSaved(conversationId, message.id, entry.id).catch(() => undefined);
  };

  const settleCreate = (attempt: Attempt, outcome: WriteResult) => {
    if (outcome.ok) {
      const entry = outcome.entry;
      if (entry !== null) markSaved(entry);
      setAttempt({ ...attempt, status: 'added', entry, operationId: null, duplicates: [], error: null });
      return;
    }
    if (outcome.code === 'duplicate' && outcome.duplicates.length > 0) {
      setAttempt({ ...attempt, status: 'duplicate', duplicates: outcome.duplicates, error: null });
      return;
    }
    setAttempt({ ...attempt, status: 'failed', error: outcome.message, duplicates: outcome.duplicates });
  };

  const settleUpdate = (attempt: Attempt, outcome: WriteResult) => {
    if (outcome.ok) {
      const entry = outcome.entry ?? attempt.target;
      if (entry !== null) markSaved(entry);
      setAttempt({ ...attempt, status: 'added', entry, operationId: null, duplicates: [], error: null });
      return;
    }
    setAttempt({ ...attempt, status: 'failed', error: outcome.message, duplicates: outcome.duplicates });
  };

  const start = (values: FormValues, selectedExamples: ExtractedExample[] = [], primaryRegister: ExampleRegister | null = null) => {
    setDialog(null);
    setNotice(null);
    const input = createInputOf(values, fsrsOnly);
    const { localId, result } = vocabulary.create(input);
    const attempt: Attempt = {
      status: 'saving',
      kind: 'create',
      word: values.word,
      values,
      examples: parsedExamples,
      selectedExamples,
      primaryRegister,
      input,
      operationId: localId,
      target: null,
      entry: null,
      duplicates: [],
      error: null,
    };
    setAttempt(attempt);
    const furtherSelected = selectedExamples.filter((example) => example.register !== primaryRegister);
    void result.then((outcome) => {
      settleCreate(attempt, outcome);
      if (outcome.ok && outcome.entry !== null) {
        void addFurtherExamples(outcome.entry.id, furtherSelected);
      }
    });
  };

  /** Writes only the text fields onto the existing word, keeping its progress and review dates. */
  const runUpdate = (attempt: Attempt, target: VocabularyEntry) => {
    const input: UpdateEntryInput = {
      meaning: attempt.values.meaning,
      definition: attempt.values.definition,
      example: attempt.values.example,
    };
    const furtherSelected = attempt.selectedExamples.filter((example) => example.register !== attempt.primaryRegister);
    if (vocabulary.getState().entries.some((entry) => entry.id === target.id)) {
      const { operationId, result } = vocabulary.update(target.id, input);
      const next: Attempt = { ...attempt, kind: 'update', status: 'saving', target, operationId, error: null, duplicates: [], examples: attempt.examples, selectedExamples: attempt.selectedExamples, primaryRegister: attempt.primaryRegister };
      setAttempt(next);
      void result.then((outcome) => {
        settleUpdate(next, outcome);
        if (outcome.ok) {
          const entry = outcome.entry ?? target;
          if (entry !== null) void addFurtherExamples(entry.id, furtherSelected);
        }
      });
      return;
    }
    // The word is not in the loaded copy (rare): send the change straight, so nothing is lost.
    const next: Attempt = { ...attempt, kind: 'update', status: 'saving', target, operationId: null, error: null, duplicates: [], examples: attempt.examples, selectedExamples: attempt.selectedExamples, primaryRegister: attempt.primaryRegister };
    setAttempt(next);
    void api.updateEntry(target.id, input).then(
      (entry) => {
        vocabulary.upsert(entry);
        settleUpdate(next, { ok: true, entry });
        void addFurtherExamples(entry.id, furtherSelected);
      },
      (error: unknown) => {
        const failure =
          error instanceof ApiError
            ? { code: error.code, message: error.message, duplicates: error.duplicates }
            : { code: 'unexpected', message: 'Could not save the change.', duplicates: [] };
        settleUpdate(next, { ok: false, ...failure });
      },
    );
  };

  const updateExisting = () => {
    if (attempt === null || attempt.status !== 'duplicate') return;
    const target = attempt.duplicates[0];
    if (target === undefined) return;
    // The refused create is given up before the update: its only way to be sent
    // again is this panel, which now offers the update instead.
    if (attempt.operationId !== null) vocabulary.dismiss(attempt.operationId);
    runUpdate(attempt, target);
  };

  const retry = () => {
    if (attempt === null || attempt.status !== 'failed') return;
    if (attempt.kind === 'update' && attempt.target !== null) {
      if (attempt.operationId !== null) {
        const retrying = vocabulary.retry(attempt.operationId);
        if (retrying !== null) {
          const next: Attempt = { ...attempt, status: 'saving', error: null, selectedExamples: attempt.selectedExamples, primaryRegister: attempt.primaryRegister };
          setAttempt(next);
          void retrying.then((outcome) => {
            settleUpdate(next, outcome);
            if (outcome.ok) {
              const entry = outcome.entry ?? attempt.target;
              if (entry !== null) void addFurtherExamples(entry.id, attempt.selectedExamples.filter((example) => example.register !== attempt.primaryRegister));
            }
          });
          return;
        }
      }
      runUpdate(attempt, attempt.target);
      return;
    }
    const furtherSelected = attempt.selectedExamples.filter((example) => example.register !== attempt.primaryRegister);
    // A create: send the very same write again; its request id keeps it one word.
    if (attempt.operationId !== null) {
      const retrying = vocabulary.retry(attempt.operationId);
      if (retrying !== null) {
        const next: Attempt = { ...attempt, status: 'saving', error: null, selectedExamples: attempt.selectedExamples, primaryRegister: attempt.primaryRegister };
        setAttempt(next);
        void retrying.then((outcome) => {
          settleCreate(next, outcome);
          if (outcome.ok && outcome.entry !== null) void addFurtherExamples(outcome.entry.id, furtherSelected);
        });
        return;
      }
    }
    const { localId, result } = vocabulary.create(attempt.input);
    const next: Attempt = { ...attempt, status: 'saving', error: null, operationId: localId, selectedExamples: attempt.selectedExamples, primaryRegister: attempt.primaryRegister };
    setAttempt(next);
    void result.then((outcome) => {
      settleCreate(next, outcome);
      if (outcome.ok && outcome.entry !== null) void addFurtherExamples(outcome.entry.id, furtherSelected);
    });
  };

  const edit = () => {
    if (attempt === null) return;
    if (attempt.operationId !== null) vocabulary.dismiss(attempt.operationId);
    setAttempt(null);
    // Nothing is typed again: the dialog opens with what was there.
    setDialog({ ...attempt.values, examples: attempt.examples, missing: [] });
  };

  const discard = () => {
    if (attempt !== null && attempt.operationId !== null) vocabulary.dismiss(attempt.operationId);
    setAttempt(null);
    setNotice(null);
  };

  const addFurtherExamples = async (entryId: string, furtherSelected: ExtractedExample[]) => {
    if (furtherSelected.length === 0) return;
    if (!library.available) {
      setNotice('Word saved. Further examples were skipped because the vocabulary bank is not available here.');
      return;
    }
    const canWrite = vocabulary.getState().meta?.writesEnabled === true;
    if (!canWrite) {
      setNotice('Word saved. Further examples were skipped because saving is switched off for this workspace.');
      return;
    }
    const existing = new Set(
      library.examples
        .filter((example) => example.vocabularyId === entryId)
        .map((example) => example.sentence.trim().toLowerCase()),
    );
    const failed: string[] = [];
    let added = 0;
    for (const example of furtherSelected) {
      const sentence = example.sentence.trim();
      if (sentence === '') continue;
      if (existing.has(sentence.toLowerCase())) continue;
      try {
        const created = await api.addExample(entryId, { sentence, source: example.label });
        libraryService.putExample(created);
        existing.add(sentence.toLowerCase());
        added += 1;
      } catch {
        failed.push(example.label);
      }
    }
    if (failed.length > 0) {
      setNotice(`Word saved. Could not add: ${failed.join(', ')}.`);
    } else if (added > 0) {
      setNotice(`Added ${added} further example${added === 1 ? '' : 's'} to the vocabulary bank.`);
    }
  };

  const savedId = savedVocabularyId ?? (attempt?.status === 'added' ? (attempt.entry?.id ?? null) : null);

  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-2">
      {notice !== null && (
        <p role="status" className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-muted">
          {notice}
        </p>
      )}
      {attempt?.status === 'duplicate' && (
        <div role="alert" className="w-full rounded-xl border border-warn-ink/30 bg-warn-soft p-3 text-warn-ink">
          <p className="text-sm font-semibold">“{attempt.word}” is already in your vocabulary</p>
          <ul className="mt-1.5 flex list-none flex-col gap-1 p-0">
            {attempt.duplicates.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
                <button type="button" className="cursor-pointer font-semibold underline" onClick={() => openWord(entry.id)}>
                  {entry.word}
                </button>
                {entry.memory !== undefined ? (
                  <StrengthPill memory={entry.memory} compact language={language} />
                ) : (
                  <MasteryPill mastery={entry.mastery} />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.meaning ?? entry.definition ?? ''}</span>
                <span className="text-xs">added {formatDate(entry.dateAdded, 'short')}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs">
            {fsrsOnly
              ? 'Updating keeps its memory state and schedule; only the meaning, definition and example change.'
              : 'Updating keeps its progress and review dates; only the meaning, definition and example change.'}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" className={BUTTON_SECONDARY} onClick={updateExisting}>
              Update with new information
            </button>
            <button
              type="button"
              className={BUTTON_GHOST}
              onClick={() => {
                const entry = attempt.duplicates[0];
                if (entry) openWord(entry.id);
              }}
            >
              Open entry
            </button>
            <button type="button" className={BUTTON_GHOST} onClick={discard}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {attempt?.status === 'failed' && (
        <div role="alert" className="w-full rounded-xl border border-bad-ink/30 bg-bad-soft p-3 text-bad-ink">
          <p className="text-sm">
            <strong className="font-semibold">{attempt.word}</strong> could not be saved. {attempt.error} Nothing was
            lost: try again without typing it all back.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" className={BUTTON_SECONDARY} onClick={retry}>
              Retry
            </button>
            <button type="button" className={BUTTON_GHOST} onClick={edit}>
              Edit
            </button>
            <button type="button" className={BUTTON_GHOST} onClick={discard}>
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {savedId !== null ? (
          <>
            <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-good-soft px-3 text-xs font-bold text-good-ink">
              <Icon name="check" className="size-3.5" />
              Added
            </span>
            <button
              type="button"
              onClick={() => openWord(vocabulary.resolveId(savedId))}
              className="cursor-pointer rounded-lg px-1.5 py-0.5 text-xs font-semibold text-muted hover:bg-line-strong/50 hover:text-ink"
            >
              View
            </button>
          </>
        ) : attempt?.status === 'saving' ? (
          <span role="status" className="inline-flex h-9 items-center gap-2 rounded-xl bg-accent-soft px-3 text-xs font-semibold text-accent">
            <Spinner className="size-4" />
            Saving…
          </span>
        ) : attempt === null ? (
          <button
            type="button"
            onClick={() => {
              const analysis = extractVocabularyAnalysis(message.content);
              setParsedExamples(analysis.examples);
              setDialog(analysis);
            }}
            className={`${BUTTON_PRIMARY} font-bold`}
          >
            <Icon name="add" className="size-4" />
            Add Word
          </button>
        ) : null}
        {children}
      </div>

      {dialog !== null && (
        <AddWordDialog initial={dialog} onSubmit={start} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
