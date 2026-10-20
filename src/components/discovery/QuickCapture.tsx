import { useEffect, useRef, useState } from 'react';
import type { VocabularyEntry } from '../../../shared/api.js';
import { useApp } from '../../app-context.js';
import type { AppApi } from '../../lib/api-client.js';
import { ApiError } from '../../lib/api-client.js';
import { newRequestId } from '../../lib/request-id.js';
import { openWord } from '../../lib/router.js';
import { Spinner } from '../Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_ERROR, HELP, INPUT, LABEL } from '../ui.js';
import { announceDiscoveryChange } from './changed.js';
import { failureMessage, isReadOnly } from './message.js';

/**
 * The standing home of quick captures: one `capture` source, looked up by
 * its kind or made on first use. Marks live there as text — a capture is
 * never a word until its own Save.
 */
async function captureSource(api: AppApi): Promise<string> {
  const sources = await api.listSources();
  const standing = sources.find((source) => source.kind === 'capture');
  if (standing !== undefined) return standing.id;
  const created = await api.createSource({
    kind: 'capture',
    title: 'Quick captures',
    content: '',
    origin: 'typed',
    requestId: newRequestId(),
  });
  return created.id;
}

export interface QuickCaptureProps {
  open: boolean;
  onClose(): void;
}

type Outcome =
  | { kind: 'idle' }
  | { kind: 'saved'; entry: VocabularyEntry }
  | { kind: 'marked' }
  | { kind: 'duplicate'; existing: VocabularyEntry[] };

/**
 * Quick Capture: a word, phrase, collocation, idiom or pattern taken down
 * from anywhere in the app. Save runs the ordinary word path — with the
 * duplicate offered for reuse, never a silent second copy — and Mark keeps
 * only the selection, with no vocabulary created at all. No AI is involved
 * or needed.
 */
export function QuickCapture({ open, onClose }: QuickCaptureProps) {
  // Every opening starts from nothing: the dialog is mounted fresh each
  // time, so no state carries over from the last capture.
  if (!open) return null;
  return <CaptureDialog onClose={onClose} />;
}

function CaptureDialog({ onClose }: { onClose(): void }) {
  const { api } = useApp();
  const [phrase, setPhrase] = useState('');
  const [meaning, setMeaning] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'save' | 'mark' | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // Escape closes the dialog, unless a request is on its way.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy === null) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Focus is given once the dialog is on screen.
  useEffect(() => {
    field.current?.focus();
  }, []);

  const trimPhrase = phrase.trim();

  const save = async (keepBoth = false) => {
    if (trimPhrase === '' || busy !== null) return;
    setBusy('save');
    setFailure(null);
    try {
      const sourceId = await captureSource(api);
      const reply = await api.saveSelection({
        word: trimPhrase,
        sourceId,
        meaning: meaning.trim() === '' ? undefined : meaning.trim(),
        note: note.trim() === '' ? undefined : note.trim(),
        allowDuplicate: keepBoth || undefined,
        requestId: newRequestId(),
      });
      setOutcome({ kind: 'saved', entry: reply.entry });
      // The Discovery lists may already be open elsewhere on screen.
      announceDiscoveryChange();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'duplicate') {
        setOutcome({ kind: 'duplicate', existing: error.duplicates });
      } else {
        if (isReadOnly(error)) setRefused(true);
        setFailure(failureMessage(error, 'The capture was not saved. Nothing changed — try again.'));
      }
    } finally {
      setBusy(null);
    }
  };

  const mark = async () => {
    if (trimPhrase === '' || busy !== null) return;
    setBusy('mark');
    setFailure(null);
    try {
      const sourceId = await captureSource(api);
      await api.markSelection(sourceId, {
        sourceId,
        label: trimPhrase,
        context: '',
        note: note.trim() === '' ? undefined : note.trim(),
        requestId: newRequestId(),
      });
      setOutcome({ kind: 'marked' });
      announceDiscoveryChange();
    } catch (error) {
      if (isReadOnly(error)) setRefused(true);
      setFailure(failureMessage(error, 'The capture was not marked. Nothing changed — try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-ink/40 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && busy === null) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="quick-capture-title" className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="quick-capture-title" className="font-serif text-xl font-semibold">
            Quick capture
          </h2>
          <button type="button" className={`${BUTTON_GHOST} h-8 px-2`} onClick={onClose} disabled={busy !== null}>
            Close
          </button>
        </div>

        {outcome.kind === 'idle' && (
          <div className="grid gap-4">
            <label className="grid gap-1" htmlFor="quick-phrase">
              <span className={LABEL}>Word, phrase, collocation or pattern</span>
              <input
                ref={field}
                id="quick-phrase"
                className={INPUT}
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                placeholder="call it a day"
                maxLength={200}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                }}
              />
            </label>
            <label className="grid gap-1" htmlFor="quick-meaning">
              <span className={LABEL}>Meaning (optional)</span>
              <input
                id="quick-meaning"
                className={INPUT}
                value={meaning}
                onChange={(event) => setMeaning(event.target.value)}
                placeholder="ngừng làm việc"
              />
            </label>
            <label className="grid gap-1" htmlFor="quick-note">
              <span className={LABEL}>Note (optional)</span>
              <input
                id="quick-note"
                className={INPUT}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="from today's meeting"
              />
            </label>

            {trimPhrase === '' && <p className={HELP}>Type something first — a whole phrase is welcome.</p>}
            {failure !== null && (
              <p role="alert" className={FIELD_ERROR}>
                {failure}
              </p>
            )}
            {refused && <p className={HELP}>Saving is switched off on this server.</p>}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BUTTON_PRIMARY}
                onClick={() => void save()}
                disabled={trimPhrase === '' || busy !== null || refused}
                aria-busy={busy === 'save'}
              >
                {busy === 'save' && <Spinner />}
                Save now
              </button>
              <button
                type="button"
                className={BUTTON_SECONDARY}
                onClick={() => void mark()}
                disabled={trimPhrase === '' || busy !== null || refused}
                aria-busy={busy === 'mark'}
              >
                {busy === 'mark' && <Spinner />}
                Mark for later
              </button>
            </div>
            <p className={HELP}>
              Save creates the word now. Mark keeps the phrase with no word yet — you decide later.
            </p>
          </div>
        )}

        {outcome.kind === 'saved' && (
          <div className="grid gap-4" role="status">
            <p className="text-sm font-semibold text-ink">Saved “{outcome.entry.word}” to your vocabulary.</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BUTTON_PRIMARY}
                onClick={() => {
                  openWord(outcome.entry.id);
                  onClose();
                }}
              >
                View in Word Profile
              </button>
              <button
                type="button"
                className={BUTTON_SECONDARY}
                onClick={() => {
                  setOutcome({ kind: 'idle' });
                  setPhrase('');
                  setMeaning('');
                  setNote('');
                  field.current?.focus();
                }}
              >
                Capture another
              </button>
              <button type="button" className={BUTTON_GHOST} onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {outcome.kind === 'marked' && (
          <div className="grid gap-4" role="status">
            <p className="text-sm font-semibold text-ink">Marked for later — nothing was saved.</p>
            <p className={HELP}>The phrase waits under Discovery → Texts until you save or dismiss it.</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BUTTON_PRIMARY}
                onClick={() => {
                  setOutcome({ kind: 'idle' });
                  setPhrase('');
                  setMeaning('');
                  setNote('');
                  field.current?.focus();
                }}
              >
                Capture another
              </button>
              <button type="button" className={BUTTON_GHOST} onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {outcome.kind === 'duplicate' && (
          <div className="grid gap-4" role="alert">
            <p className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-ink">
              “{trimPhrase}” is already in your vocabulary
              {outcome.existing[0] !== undefined ? ` as “${outcome.existing[0].word}”` : ''}. Nothing was saved again.
            </p>
            <div className="flex flex-wrap gap-2">
              {outcome.existing[0] !== undefined && (
                <button
                  type="button"
                  className={BUTTON_PRIMARY}
                  onClick={() => {
                    openWord(outcome.existing[0]!.id);
                    onClose();
                  }}
                >
                  Open the existing word
                </button>
              )}
              <button type="button" className={BUTTON_SECONDARY} onClick={() => void save(true)} disabled={busy !== null}>
                Keep both words
              </button>
              <button
                type="button"
                className={BUTTON_GHOST}
                onClick={() => {
                  setOutcome({ kind: 'idle' });
                  field.current?.focus();
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
