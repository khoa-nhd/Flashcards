import { useCallback, useEffect, useState } from 'react';
import type { DiscoveryMarkView } from '../../../shared/discovery.js';
import { useApp } from '../../app-context.js';
import { ApiError } from '../../lib/api-client.js';
import { newRequestId } from '../../lib/request-id.js';
import { openWord } from '../../lib/router.js';
import { Link } from '../Link.js';
import { Spinner } from '../Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, FIELD_ERROR, HELP, INPUT } from '../ui.js';
import { onDiscoveryChange } from './changed.js';
import { KIND_LABELS, openHref } from './labels.js';
import { failureMessage, isReadOnly } from './message.js';

/**
 * The “marked for later” list: selections kept as text, each with where it
 * came from. Saving one goes through the mark's own word creation — the
 * word is the selection, whatever a form might otherwise suggest — and
 * dismissing one drops it. A mark that was already saved elsewhere is
 * refused by the server as a conflict, and this says so rather than
 * pretending the dismissal worked.
 */
export function MarksPanel() {
  const { api } = useApp();
  const [marks, setMarks] = useState<DiscoveryMarkView[] | null>(null);
  const [failure, setFailure] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [meaning, setMeaning] = useState('');
  const [notice, setNotice] = useState<{
    markId: string;
    text: string;
    kind: 'saved' | 'failed' | 'duplicate';
    entryId?: string;
  } | null>(null);
  const [refused, setRefused] = useState(false);

  const load = useCallback(
    () =>
      api
        .listMarks()
        .then((loaded) => {
          setMarks(loaded);
          setFailure('');
        })
        .catch((error: unknown) => {
          setFailure(failureMessage(error, 'Your marked words could not be loaded.'));
          setMarks((current) => current ?? []);
        }),
    [api],
  );

  useEffect(() => {
    let current = true;
    api
      .listMarks()
      .then((loaded) => {
        if (!current) return;
        setMarks(loaded);
        setFailure('');
      })
      .catch((error: unknown) => {
        if (!current) return;
        setFailure(failureMessage(error, 'Your marked words could not be loaded.'));
        setMarks((existing) => existing ?? []);
      });
    return () => {
      current = false;
    };
  }, [api]);

  // A capture or save made anywhere else — the dialog, a workspace — is
  // felt here at once: this list never shows yesterday's marks.
  useEffect(() => onDiscoveryChange(() => void load()), [load]);

  const save = async (mark: DiscoveryMarkView) => {
    setBusyId(mark.id);
    setNotice(null);
    try {
      const reply = await api.saveMark(mark.id, {
        meaning: meaning.trim() === '' ? undefined : meaning.trim(),
        requestId: newRequestId(),
      });
      setNotice({ markId: mark.id, text: `Saved “${reply.entry.word}”.`, kind: 'saved', entryId: reply.entry.id });
      setSavingId(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'duplicate') {
        // Reuse is offered, never taken: the duplicate words come back with
        // the refusal, and this panel shows them instead of making a copy.
        const existing = error.duplicates[0];
        setNotice({
          markId: mark.id,
          text:
            existing === undefined
              ? error.message
              : `“${mark.label}” is already in your vocabulary as “${existing.word}”. Nothing was saved again.`,
          kind: 'duplicate',
          entryId: existing?.id,
        });
        setSavingId(null);
      } else {
        if (isReadOnly(error)) setRefused(true);
        setNotice({
          markId: mark.id,
          text: failureMessage(error, 'The word was not saved. Nothing changed.'),
          kind: 'failed',
        });
      }
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (mark: DiscoveryMarkView) => {
    setBusyId(mark.id);
    setNotice(null);
    try {
      await api.dismissMark(mark.id);
      await load();
    } catch (error) {
      if (isReadOnly(error)) setRefused(true);
      setNotice({ markId: mark.id, text: failureMessage(error, 'The selection was not dismissed.'), kind: 'failed' });
      if (error instanceof ApiError && (error.code === 'conflict' || error.code === 'not_found')) await load();
    } finally {
      setBusyId(null);
    }
  };

  if (marks === null) {
    return (
      <div className={`${CARD} flex items-center gap-3 p-4 text-sm text-muted`} role="status">
        <Spinner className="size-4" />
        Loading what you marked…
      </div>
    );
  }

  return (
    <section aria-label="Marked for later" className={`${CARD} flex flex-col gap-3 p-4`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">Marked for later</h3>
        <span className="text-xs text-muted">{marks.length} waiting</span>
      </div>
      {marks.length === 0 && (
        <p className={HELP}>Nothing is waiting. Select something while reading or listening, then “Mark for later”.</p>
      )}
      {notice !== null && (
        <div
          role={notice.kind === 'failed' ? 'alert' : 'status'}
          className={notice.kind === 'failed' ? FIELD_ERROR : HELP}
        >
          <p>{notice.text}</p>
          {(notice.kind === 'saved' || notice.kind === 'duplicate') && notice.entryId !== undefined && (
            <button
              type="button"
              className="mt-1 cursor-pointer font-semibold text-accent underline-offset-2 hover:underline"
              onClick={() => openWord(notice.entryId!)}
            >
              {notice.kind === 'saved' ? 'View in Word Profile' : 'Open the existing word'}
            </button>
          )}
        </div>
      )}
      {failure !== '' && (
        <p role="alert" className={FIELD_ERROR}>
          {failure}
        </p>
      )}
      {refused && <p className={HELP}>Saving is switched off on this server, so marks can only be dismissed there.</p>}

      <ul className="flex flex-col gap-3">
        {marks.map((mark) => (
          <li key={mark.id} className="flex flex-col gap-2 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <strong className="text-sm font-semibold">{mark.label}</strong>
              <Link
                to={openHref(mark.sourceId, mark.sourceKind)}
                className="text-xs font-medium text-accent underline-offset-2 hover:underline"
              >
                {KIND_LABELS[mark.sourceKind]} · {mark.sourceTitle}
              </Link>
            </div>
            {mark.context !== '' && <p className="text-sm text-muted">{mark.context}</p>}
            {mark.note !== '' && <p className="text-xs italic text-muted">Note: {mark.note}</p>}

            {savingId === mark.id ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`meaning-${mark.id}`}>
                  Vietnamese meaning
                </label>
                <input
                  id={`meaning-${mark.id}`}
                  className={`${INPUT} max-w-56`}
                  placeholder="Meaning (optional)"
                  value={meaning}
                  onChange={(event) => setMeaning(event.target.value)}
                />
                <button
                  type="button"
                  className={BUTTON_PRIMARY}
                  onClick={() => void save(mark)}
                  disabled={busyId !== null}
                  aria-busy={busyId === mark.id}
                >
                  {busyId === mark.id && <Spinner />}
                  Save this word
                </button>
                <button type="button" className={BUTTON_GHOST} onClick={() => setSavingId(null)} disabled={busyId !== null}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={BUTTON_SECONDARY}
                  onClick={() => {
                    setMeaning('');
                    setSavingId(mark.id);
                    setNotice(null);
                  }}
                  disabled={busyId !== null || refused}
                >
                  Save…
                </button>
                <button
                  type="button"
                  className={BUTTON_GHOST}
                  onClick={() => void dismiss(mark)}
                  disabled={busyId !== null || refused}
                  aria-busy={busyId === mark.id}
                >
                  {busyId === mark.id && <Spinner />}
                  Dismiss
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
