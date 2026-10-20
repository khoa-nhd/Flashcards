import { useState } from 'react';
import type { VocabularyEntry } from '../../../shared/api.js';
import { AI_LIMITS } from '../../../shared/ai.js';
import { contextWindow, sentenceAround } from '../../../shared/discovery.js';
import { useApp } from '../../app-context.js';
import { ApiError } from '../../lib/api-client.js';
import { newRequestId } from '../../lib/request-id.js';
import { openWord } from '../../lib/router.js';
import { Spinner } from '../Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, FIELD_ERROR, HELP, INPUT, LABEL } from '../ui.js';
import { announceDiscoveryChange } from './changed.js';
import { explainFailureMessage, failureMessage, isReadOnly } from './message.js';

export interface SelectionPanelProps {
  sourceId: string;
  /** The source's full content — only a window of it is ever sent anywhere. */
  content: string;
  /** Character offset of the selection's start. Omitted for a cue-based selection. */
  offset?: number;
  /** The selected text itself. */
  label: string;
  /** Listening: the cue's window in milliseconds. Both or neither. */
  cueStart?: number;
  cueEnd?: number;
  /** A sentence or cue already known (the listener passes the cue's text). */
  context?: string;
  /** Closes the panel without saving anything — which is what Dismiss means. */
  onDone(): void;
  onSaved?(entry: VocabularyEntry): void;
}

/**
 * What a selected word can become, and only that: an optional AI explanation
 * of this selection in this context, a Save that goes through the ordinary
 * word path, a Mark that keeps the selection without a word, or a Dismiss
 * that persists nothing. Only the window around the selection travels to the
 * server's AI — the source itself never does — and a duplicate is offered
 * for reuse rather than quietly created.
 */
export function SelectionPanel({
  sourceId,
  content,
  offset,
  label,
  cueStart,
  cueEnd,
  context,
  onDone,
  onSaved,
}: SelectionPanelProps) {
  const { api } = useApp();
  const contextText = context ?? (offset !== undefined ? sentenceAround(content, offset) : '');

  const [meaning, setMeaning] = useState('');
  const [definition, setDefinition] = useState('');
  const [note, setNote] = useState('');
  const [explaining, setExplaining] = useState(false);
  const [explainFailure, setExplainFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'mark' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<VocabularyEntry[] | null>(null);
  const [saved, setSaved] = useState<VocabularyEntry | null>(null);
  const [marked, setMarked] = useState(false);
  const [refused, setRefused] = useState(false);

  /** Ask what the selection means — only the window around it is sent. */
  const explain = async () => {
    setExplaining(true);
    setExplainFailure(null);
    try {
      const passage = offset !== undefined ? contextWindow(content, offset, AI_LIMITS.passage) : contextText;
      const result = await api.extractSense({ text: passage, word: label });
      if (result.definition !== null) setDefinition(result.definition);
      if (result.meaning !== null) setMeaning(result.meaning);
    } catch (error) {
      if (isReadOnly(error)) setRefused(true);
      setExplainFailure(explainFailureMessage(error));
    } finally {
      setExplaining(false);
    }
  };

  const save = async (keepBoth = false) => {
    setBusy('save');
    setFailure(null);
    try {
      const reply = await api.saveSelection({
        word: label,
        sourceId,
        meaning: meaning.trim() === '' ? undefined : meaning.trim(),
        definition: definition.trim() === '' ? undefined : definition.trim(),
        note: note.trim() === '' ? undefined : note.trim(),
        offset,
        cueStart,
        cueEnd,
        context: contextText,
        allowDuplicate: keepBoth || undefined,
        requestId: newRequestId(),
      });
      setDuplicate(null);
      setSaved(reply.entry);
      // The Discovery lists may already be open elsewhere on screen.
      announceDiscoveryChange();
      onSaved?.(reply.entry);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'duplicate') {
        setDuplicate(error.duplicates);
      } else {
        if (isReadOnly(error)) setRefused(true);
        setFailure(failureMessage(error, 'The word was not saved. Nothing changed — try again.'));
      }
    } finally {
      setBusy(null);
    }
  };

  const mark = async () => {
    setBusy('mark');
    setFailure(null);
    try {
      await api.markSelection(sourceId, {
        sourceId,
        label,
        context: contextText,
        offset,
        cueStart,
        cueEnd,
        note: note.trim() === '' ? undefined : note.trim(),
        requestId: newRequestId(),
      });
      setMarked(true);
      announceDiscoveryChange();
    } catch (error) {
      if (isReadOnly(error)) setRefused(true);
      setFailure(failureMessage(error, 'The selection was not marked. Nothing changed — try again.'));
    } finally {
      setBusy(null);
    }
  };

  if (saved !== null) {
    return (
      <section aria-label="Saved word" className={`${CARD} flex flex-col gap-3 p-4`} role="status">
        <p className="text-sm font-semibold text-ink">Saved “{saved.word}” to your vocabulary.</p>
        <p className={HELP}>
          Its sentence came along: <span className="text-ink">{contextText || 'no sentence was set'}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON_PRIMARY} onClick={() => openWord(saved.id)}>
            View in Word Profile
          </button>
          <button type="button" className={BUTTON_SECONDARY} onClick={onDone}>
            Keep reading
          </button>
        </div>
      </section>
    );
  }

  if (marked) {
    return (
      <section aria-label="Marked for later" className={`${CARD} flex flex-col gap-3 p-4`} role="status">
        <p className="text-sm font-semibold text-ink">Marked for later — nothing was saved yet.</p>
        <p className={HELP}>The selection and its sentence wait under Discovery → Texts, until you save or dismiss it.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON_SECONDARY} onClick={onDone}>
            Keep reading
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={`Selection: ${label}`} className={`${CARD} flex flex-col gap-3 p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            Selected: <strong className="font-semibold">{label}</strong>
          </p>
          {contextText !== '' && (
            <p className="mt-1 rounded-xl border border-line px-3 py-2 text-sm text-muted">{contextText}</p>
          )}
        </div>
        <button type="button" className={`${BUTTON_GHOST} h-8 shrink-0 px-2`} onClick={onDone}>
          Dismiss
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BUTTON_SECONDARY}
          onClick={() => void explain()}
          disabled={explaining || label.trim() === ''}
          aria-busy={explaining}
        >
          {explaining && <Spinner />}
          Explain this word
        </button>
        <span className={HELP}>Only the sentence around it is ever sent.</span>
      </div>
      {explainFailure !== null && (
        <p role="status" className={HELP}>
          {explainFailure}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1" htmlFor="selection-meaning">
          <span className={LABEL}>Vietnamese meaning</span>
          <input
            id="selection-meaning"
            className={INPUT}
            value={meaning}
            onChange={(event) => setMeaning(event.target.value)}
            placeholder="thẳng thắn"
          />
        </label>
        <label className="grid gap-1" htmlFor="selection-definition">
          <span className={LABEL}>Definition</span>
          <input
            id="selection-definition"
            className={INPUT}
            value={definition}
            onChange={(event) => setDefinition(event.target.value)}
            placeholder="openly direct"
          />
        </label>
      </div>
      <label className="grid gap-1" htmlFor="selection-note">
        <span className={LABEL}>Note (optional)</span>
        <input
          id="selection-note"
          className={INPUT}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Kept with the selection either way"
        />
      </label>

      {duplicate !== null && (
        <div className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink" role="alert">
          <p>
            “{label}” is already in your vocabulary{duplicate.length > 0 && duplicate[0] !== undefined ? ` as “${duplicate[0].word}”` : ''}. Nothing was saved again.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {duplicate[0] !== undefined && (
              <button
                type="button"
                className={BUTTON_SECONDARY}
                onClick={() => {
                  openWord(duplicate[0]!.id);
                  onDone();
                }}
              >
                Open the existing word
              </button>
            )}
            <button type="button" className={BUTTON_PRIMARY} onClick={() => void save(true)} disabled={busy !== null}>
              Keep both words
            </button>
          </div>
        </div>
      )}

      {failure !== null && (
        <p role="alert" className={FIELD_ERROR}>
          {failure}
        </p>
      )}
      {refused && <p className={HELP}>Saving is switched off on this server, so only reading and marking are available.</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON_PRIMARY}
          onClick={() => void save()}
          disabled={busy !== null || refused || label.trim() === ''}
          aria-busy={busy === 'save'}
        >
          {busy === 'save' && <Spinner />}
          Save to vocabulary
        </button>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          onClick={() => void mark()}
          disabled={busy !== null || refused || label.trim() === ''}
          aria-busy={busy === 'mark'}
        >
          {busy === 'mark' && <Spinner />}
          Mark for later
        </button>
        <span className={HELP}>Save creates the word; Mark keeps the selection only.</span>
      </div>
    </section>
  );
}
