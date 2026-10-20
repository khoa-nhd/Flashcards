import { useCallback, useEffect, useState } from 'react';
import {
  DISCOVERY_LIMITS,
  tidyDiscoveryTitle,
  type DiscoverySource,
  type DiscoverySourceKind,
} from '../../../shared/discovery.js';
import { useApp } from '../../app-context.js';
import { newRequestId } from '../../lib/request-id.js';
import { Link } from '../Link.js';
import { Spinner } from '../Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, CARD, FIELD_ERROR, HELP, INPUT, LABEL, TEXTAREA } from '../ui.js';
import { onDiscoveryChange } from './changed.js';
import { KIND_LABELS, openHref } from './labels.js';
import { failureMessage } from './message.js';
import { MarksPanel } from './MarksPanel.js';

export interface TextSourcesPanelProps {
  /** Opens a source in its workspace (a transcript listens, everything else reads). */
  onOpen(sourceId: string, kind: DiscoverySourceKind): void;
}

/**
 * Discovery's home: every source with where it came from and what is
 * waiting inside it, a way to paste a new text in, and the marked-for-later
 * list. Opening never saves anything, and pasting creates one text source —
 * never a word.
 */
export function TextSourcesPanel({ onOpen }: TextSourcesPanelProps) {
  const { api } = useApp();
  const [sources, setSources] = useState<DiscoverySource[] | null>(null);
  const [failure, setFailure] = useState('');
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [composeFailure, setComposeFailure] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .listSources()
        .then((loaded) => {
          setSources(loaded);
          setFailure('');
        })
        .catch((error: unknown) => {
          setFailure(failureMessage(error, 'Your texts could not be loaded.'));
          setSources((current) => current ?? []);
        }),
    [api],
  );

  useEffect(() => {
    let current = true;
    api
      .listSources()
      .then((loaded) => {
        if (!current) return;
        setSources(loaded);
        setFailure('');
      })
      .catch((error: unknown) => {
        if (!current) return;
        setFailure(failureMessage(error, 'Your texts could not be loaded.'));
        setSources((existing) => existing ?? []);
      });
    return () => {
      current = false;
    };
  }, [api]);

  // A source opened, created or captured anywhere else is reflected here
  // as soon as the change is announced.
  useEffect(() => onDiscoveryChange(() => void load()), [load]);

  const create = async () => {
    if (busy) return;
    const content = text;
    if (content.trim() === '') {
      setComposeFailure('Paste some text first — a paragraph is enough.');
      return;
    }
    if (content.length > DISCOVERY_LIMITS.content) {
      setComposeFailure(
        `That is ${content.length.toLocaleString('en-US')} characters — one source holds up to ${DISCOVERY_LIMITS.content.toLocaleString('en-US')}. Trim it, or import it in parts.`,
      );
      return;
    }
    const firstLine = content.split('\n').find((line) => line.trim() !== '') ?? '';
    const name = tidyDiscoveryTitle(title) || tidyDiscoveryTitle(firstLine.slice(0, 60)) || 'Untitled text';
    setBusy(true);
    setComposeFailure(null);
    try {
      const created = await api.createSource({
        kind: 'text',
        title: name,
        content,
        origin: 'typed',
        requestId: newRequestId(),
      });
      setComposing(false);
      setTitle('');
      setText('');
      await load();
      onOpen(created.id, created.kind);
    } catch (error) {
      setComposeFailure(failureMessage(error, 'The text was not saved. Nothing changed — try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (sources === null) {
    return (
      <div className={`${CARD} flex items-center gap-3 p-4 text-sm text-muted`} role="status">
        <Spinner className="size-4" />
        Loading your texts…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Your texts" className={`${CARD} flex flex-col gap-3 p-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold tracking-tight">Your texts</h3>
          {!composing && (
            <button
              type="button"
              className={BUTTON_PRIMARY}
              onClick={() => {
                setComposing(true);
                setComposeFailure(null);
              }}
            >
              Paste a new text
            </button>
          )}
        </div>

        {failure !== '' && (
          <p role="alert" className={FIELD_ERROR}>
            {failure}
          </p>
        )}

        {sources.length === 0 && !composing && (
          <p className={HELP}>
            Nothing here yet. Paste a reading, import a file or transcript, or let a draft be written for you — then
            read it here and keep the words you want.
          </p>
        )}

        <ul className="flex flex-col divide-y divide-line">
          {sources.map((source) => (
            <li key={source.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <Link
                  to={openHref(source.id, source.kind)}
                  className="font-medium text-ink underline-offset-2 hover:underline"
                >
                  {source.title}
                </Link>
                <p className="text-xs text-muted">
                  {KIND_LABELS[source.kind]}
                  {source.origin !== '' && ` · ${source.origin}`}
                  {source.markedCount > 0 && ` · ${source.markedCount} marked`}
                  {source.savedCount > 0 && ` · ${source.savedCount} saved`}
                </p>
              </div>
              <button
                type="button"
                className={`${BUTTON_GHOST} h-8 px-2`}
                onClick={() => onOpen(source.id, source.kind)}
              >
                Open
              </button>
            </li>
          ))}
        </ul>

        {composing && (
          <div className="mt-2 grid gap-3 rounded-xl border border-line p-4">
            <label className="grid gap-1" htmlFor="source-title">
              <span className={LABEL}>Title (optional)</span>
              <input
                id="source-title"
                className={INPUT}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Left empty, the first line names it"
                maxLength={200}
              />
            </label>
            <label className="grid gap-1" htmlFor="source-text">
              <span className={LABEL}>The text</span>
              <textarea
                id="source-text"
                className={TEXTAREA}
                rows={8}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Paste an article, a chapter, a few paragraphs…"
                maxLength={DISCOVERY_LIMITS.content}
              />
            </label>
            {composeFailure !== null && (
              <p role="alert" className={FIELD_ERROR}>
                {composeFailure}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BUTTON_PRIMARY}
                onClick={() => void create()}
                disabled={busy || text.trim() === ''}
                aria-busy={busy}
              >
                {busy && <Spinner />}
                Create and read
              </button>
              <button
                type="button"
                className={BUTTON_GHOST}
                onClick={() => {
                  setComposing(false);
                  setComposeFailure(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <MarksPanel />
    </div>
  );
}
