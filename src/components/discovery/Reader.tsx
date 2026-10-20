import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DISCOVERY_LIMITS, type DiscoverySourceDocument } from '../../../shared/discovery.js';
import { useApp } from '../../app-context.js';
import { offsetWithin, rangeAt } from '../../lib/text-selection.js';
import { BUTTON_GHOST, BUTTON_SECONDARY, CARD, HELP } from '../ui.js';
import { Spinner } from '../Spinner.js';
import { failureMessage } from './message.js';
import { KIND_LABELS } from './labels.js';
import { SelectionPanel } from './SelectionPanel.js';

/** Where each paragraph begins in the content, so the reader can walk it. */
const paragraphStarts = (content: string): number[] => {
  const starts: number[] = [];
  let cursor = 0;
  for (const piece of content.split(/\n{2,}/)) {
    const at = content.indexOf(piece, cursor);
    if (piece.trim() !== '') starts.push(at);
    cursor = at + piece.length;
  }
  if (starts.length === 0) starts.push(0);
  return starts;
};

const paragraphAt = (starts: number[], offset: number): number => {
  let index = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if ((starts[i] ?? 0) <= offset) index = i;
  }
  return index;
};

/** Scrolls a character offset of the body into view, in whatever scrolls. */
const revealAt = (root: HTMLElement, offset: number) => {
  const range = rangeAt(root, offset);
  // Browsers give a range its rectangle; where there is none, the offset
  // is still restored — only the scroll is skipped.
  if (range === null || typeof range.getBoundingClientRect !== 'function') return;
  const scroller = root.closest('main');
  if (scroller === null) return;
  const rect = range.getBoundingClientRect();
  scroller.scrollTop = Math.max(0, scroller.scrollTop + rect.top - 120);
};

export interface ReaderProps {
  sourceId: string | null;
  /** Goes back to the list of texts, where another source can be picked. */
  onPickAnother(): void;
}

/**
 * The reading workspace: one source, its title, a selection that becomes a
 * mark or a word, and a position that survives leaving the page — saved as
 * the reader moves, restored when they come back. Loading, empty, broken
 * and refused states each say what happened and offer the next step; the
 * content is rendered as plain text, so nothing imported can act.
 */
export function Reader({ sourceId, onPickAnother }: ReaderProps) {
  const { api } = useApp();
  const [doc, setDoc] = useState<DiscoverySourceDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ label: string; offset: number } | null>(null);
  const [restoreAt, setRestoreAt] = useState<number | null>(null);
  const [paragraph, setParagraph] = useState(0);
  const body = useRef<HTMLDivElement>(null);

  const starts = useMemo(() => (doc === null ? [] : paragraphStarts(doc.content)), [doc]);

  const load = useCallback(
    (id: string) =>
      api.fetchSource(id).then((loaded) => {
        setDoc(loaded);
        setLoadError(null);
        return loaded;
      }),
    [api],
  );

  // Opening the source: fetched once per source (the page keys this panel
  // by id), with every later movement of the reader's own.
  useEffect(() => {
    if (sourceId === null) return undefined;
    let current = true;
    load(sourceId)
      .then((loaded) => {
        if (!current) return;
        // Restoring where the reader was, named as well as scrolled to.
        const offset = loaded.position.offset ?? 0;
        if (offset > 0) {
          setRestoreAt(offset);
          setParagraph(paragraphAt(paragraphStarts(loaded.content), offset));
        }
      })
      .catch((error: unknown) => {
        if (current) setLoadError(failureMessage(error, 'That source could not be opened.'));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load, sourceId]);

  // Scrolling to the restored offset is a DOM job, and waits until the
  // text is on the page.
  useEffect(() => {
    if (restoreAt === null || doc === null || body.current === null) return;
    revealAt(body.current, restoreAt);
  }, [restoreAt, doc]);

  const retry = () => {
    if (sourceId === null) return;
    setLoading(true);
    setLoadError(null);
    setDoc(null);
    setSelection(null);
    setRestoreAt(null);
    setParagraph(0);
    void load(sourceId)
      .then((loaded) => {
        const offset = loaded.position.offset ?? 0;
        if (offset > 0) {
          setRestoreAt(offset);
          setParagraph(paragraphAt(paragraphStarts(loaded.content), offset));
        }
      })
      .catch((error: unknown) => {
        setLoadError(failureMessage(error, 'That source could not be opened.'));
      })
      .finally(() => setLoading(false));
  };

  /** Where the reader is now: remembered as they read. */
  const persist = (id: string, offset: number) => {
    void api.updateSource(id, { position: { offset } }).catch(() => undefined);
  };

  const readSelection = () => {
    const root = body.current;
    const active = window.getSelection();
    if (root === null || active === null || active.rangeCount === 0 || active.isCollapsed) {
      setSelection(null);
      return;
    }
    const range = active.getRangeAt(0);
    if (!root.contains(range.startContainer)) {
      setSelection(null);
      return;
    }
    const label = active.toString().trim();
    if (label === '' || label.length > DISCOVERY_LIMITS.label) {
      setSelection(null);
      return;
    }
    const offset = offsetWithin(root, range.startContainer, range.startOffset);
    setSelection({ label, offset });
    setRestoreAt(null);
    setParagraph(paragraphAt(starts, offset));
    if (doc !== null) persist(doc.id, offset);
  };

  const goToParagraph = (next: number) => {
    if (starts.length === 0 || doc === null) return;
    const index = Math.max(0, Math.min(next, starts.length - 1));
    const offset = starts[index] ?? 0;
    setParagraph(index);
    setRestoreAt(null);
    persist(doc.id, offset);
    if (body.current !== null) revealAt(body.current, offset);
  };

  if (sourceId === null) {
    return (
      <section className={`${CARD} flex flex-col gap-3 p-6`}>
        <h2 className="font-serif text-xl font-semibold">Choose a text to read</h2>
        <p className="text-sm text-muted">
          Pick one of your texts, paste a new one, or import a file — then read it here.
        </p>
        <div>
          <button type="button" className={BUTTON_SECONDARY} onClick={onPickAnother}>
            Back to my texts
          </button>
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <div className={`${CARD} flex items-center gap-3 p-6 text-sm text-muted`} role="status">
        <Spinner className="size-5" />
        Opening the source…
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <section className={`${CARD} flex flex-col gap-3 p-6`} role="alert">
        <h2 className="font-serif text-xl font-semibold">That source did not open</h2>
        <p className="text-sm text-muted">{loadError}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON_SECONDARY} onClick={retry}>
            Try again
          </button>
          <button type="button" className={BUTTON_GHOST} onClick={onPickAnother}>
            Back to my texts
          </button>
        </div>
      </section>
    );
  }

  if (doc === null) {
    return (
      <section className={`${CARD} flex flex-col gap-3 p-6`}>
        <h2 className="font-serif text-xl font-semibold">That source is gone</h2>
        <p className="text-sm text-muted">It may have been deleted. Back to your texts to pick another.</p>
        <div>
          <button type="button" className={BUTTON_SECONDARY} onClick={onPickAnother}>
            Back to my texts
          </button>
        </div>
      </section>
    );
  }

  if (doc.content.trim() === '') {
    return (
      <section className={`${CARD} flex flex-col gap-3 p-6`}>
        <h2 className="font-serif text-xl font-semibold">{doc.title}</h2>
        <p className="text-sm text-muted">This source has no text in it yet.</p>
        <div>
          <button type="button" className={BUTTON_SECONDARY} onClick={onPickAnother}>
            Back to my texts
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={`${BUTTON_GHOST} h-8 px-2`} onClick={onPickAnother}>
          ← All texts
        </button>
        <span className="rounded-full border border-line px-2 py-0.5 text-xs font-medium text-muted">
          {KIND_LABELS[doc.kind]}
        </span>
      </div>

      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold tracking-tight">{doc.title}</h2>
        {doc.origin !== '' && <p className="text-xs text-muted">{doc.origin}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm" role="group" aria-label="Paragraph navigation">
          <button
            type="button"
            className={`${BUTTON_SECONDARY} h-8 px-3`}
            onClick={() => goToParagraph(paragraph - 1)}
            disabled={paragraph <= 0}
          >
            ← Previous
          </button>
          <span className="tabular-nums text-muted" role="status">
            Paragraph {Math.min(paragraph + 1, starts.length)} of {starts.length}
          </span>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} h-8 px-3`}
            onClick={() => goToParagraph(paragraph + 1)}
            disabled={paragraph >= starts.length - 1}
          >
            Next →
          </button>
          {restoreAt !== null && <span className="text-xs text-accent">Picked up where you left off.</span>}
        </div>
      </header>

      <p className={HELP}>Select a word in the text to save it, mark it, or ask what it means here.</p>

      <div
        ref={body}
        onMouseUp={readSelection}
        onKeyUp={(event) => {
          if (event.shiftKey || event.key.startsWith('Arrow')) readSelection();
        }}
        className={`${CARD} cursor-text whitespace-pre-wrap p-5 leading-relaxed`}
        data-testid="reader-body"
      >
        {doc.content}
      </div>

      {selection !== null && (
        <SelectionPanel
          key={`${doc.id}:${selection.offset}:${selection.label}`}
          sourceId={doc.id}
          content={doc.content}
          offset={selection.offset}
          label={selection.label}
          onDone={() => {
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </div>
  );
}
