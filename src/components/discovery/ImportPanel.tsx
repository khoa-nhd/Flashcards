import { useState } from 'react';
import { DISCOVERY_LIMITS, tidyDiscoveryTitle, type DiscoverySourceKind } from '../../../shared/discovery.js';
import { looksLikeTranscript } from '../../lib/transcript.js';
import { useApp } from '../../app-context.js';
import { ApiError } from '../../lib/api-client.js';
import { newRequestId } from '../../lib/request-id.js';
import { Spinner } from '../Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, CARD, FIELD_ERROR, HELP, INPUT, LABEL, TEXTAREA } from '../ui.js';
import { KIND_LABELS } from './labels.js';
import { failureMessage } from './message.js';

export interface ImportPanelProps {
  /** The learner opened the preview: a real source now exists in its workspace. */
  onOpened(sourceId: string, kind: DiscoverySourceKind): void;
}

type Mode = 'file' | 'paste' | 'url';

interface Preview {
  title: string;
  content: string;
  origin: string;
  transcript: boolean;
  source: Mode;
}

const ACCEPTED = ['.txt', '.md', '.markdown', '.srt', '.vtt', '.html', '.htm'] as const;

const URL_FAILURES: Record<string, string> = {
  url_blocked:
    'That address points at a private network or somewhere this app refuses to fetch. Copy the page into Paste instead.',
  unsupported_media_type:
    'That address is not a readable text page (perhaps a PDF or a file). Copy the text into Paste instead.',
  content_too_large: 'That page is larger than one source may hold. Bring in an excerpt instead.',
  upstream_timeout: 'The address did not answer in time. Try again, or paste the text instead.',
  upstream_unreachable: 'The address could not be reached. Check the link, or paste the text instead.',
  timeout: 'That address did not answer in time. Paste the text instead.',
};

/**
 * Bringing content in, one step at a time: choose (file, paste, address),
 * validate what it is, preview it as plain text, then open it in the
 * workspace its kind deserves — a transcript listens, everything else
 * reads. Nothing is stored before the final press, imported text is never
 * executed or rendered as markup, and every refusal says what to do next.
 */
export function ImportPanel({ onOpened }: ImportPanelProps) {
  const { api } = useApp();
  const [mode, setMode] = useState<Mode>('file');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'url' | 'open' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reset = () => {
    setPreview(null);
    setFailure(null);
  };

  const previewContent = (content: string, meta: Omit<Preview, 'content'>) => {
    if (content.trim() === '') {
      setFailure('There is no text to read — the file or field was empty.');
      return;
    }
    if (content.includes('\u0000')) {
      setFailure('That content is binary, not plain text, so it was not imported.');
      return;
    }
    if (content.length > DISCOVERY_LIMITS.content) {
      setFailure(
        `Too large: ${content.length.toLocaleString('en-US')} characters. Keep a source under ${DISCOVERY_LIMITS.content.toLocaleString('en-US')} — import an excerpt.`,
      );
      return;
    }
    setFailure(null);
    setPreview({ ...meta, content });
  };

  const onFile = async (file: File | null) => {
    setPreview(null);
    setFailure(null);
    if (file === null) return;
    const lower = file.name.toLowerCase();
    const extension = ACCEPTED.find((suffix) => lower.endsWith(suffix));
    if (extension === undefined) {
      setFailure(
        `“${file.name}” is not a text file this app can read. Try .txt, .md, .srt, .vtt or .html — PDF and Office files are not read here; copy their text into Paste.`,
      );
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setFailure('That file could not be read. Check it and try again.');
      return;
    }
    const base = file.name.replace(/\.[^.]+$/, '');
    previewContent(text, {
      title: tidyDiscoveryTitle(base) || 'Imported text',
      origin: file.name,
      transcript: extension === '.srt' || extension === '.vtt' || looksLikeTranscript(text),
      source: 'file',
    });
  };

  const showPastePreview = () => {
    const firstLine = pasteText.split('\n').find((line) => line.trim() !== '') ?? '';
    const title = tidyDiscoveryTitle(pasteTitle) || tidyDiscoveryTitle(firstLine.slice(0, 60)) || 'Pasted text';
    previewContent(pasteText, {
      title,
      origin: 'pasted',
      transcript: looksLikeTranscript(pasteText),
      source: 'paste',
    });
  };

  const fetchPage = async () => {
    if (busy !== null) return;
    setBusy('url');
    setPreview(null);
    setFailure(null);
    try {
      const page = await api.fetchUrl(url.trim());
      setPreview({
        title: page.title || 'Fetched page',
        content: page.text,
        origin: page.origin,
        // A transcript stays a transcript however it arrives: by address, file or paste.
        transcript: looksLikeTranscript(page.text),
        source: 'url',
      });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setFailure(URL_FAILURES[code] ?? failureMessage(error, 'The page could not be fetched. Paste the text instead.'));
    } finally {
      setBusy(null);
    }
  };

  const open = async () => {
    if (preview === null || busy !== null) return;
    setBusy('open');
    setFailure(null);
    try {
      const kind: DiscoverySourceKind = preview.transcript ? 'listening' : preview.source === 'url' ? 'web' : 'imported';
      const created = await api.createSource({
        kind,
        title: preview.title,
        origin: preview.origin,
        content: preview.content,
        contentKind: preview.transcript ? 'transcript' : 'plain',
        requestId: newRequestId(),
      });
      onOpened(created.id, kind);
    } catch (error) {
      setFailure(failureMessage(error, 'It was not opened. Nothing was saved — try again.'));
    } finally {
      setBusy(null);
    }
  };

  const tab = (value: Mode, label: string) => (
    <button
      key={value}
      type="button"
      className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
        mode === value ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-line/40'
      }`}
      aria-pressed={mode === value}
      onClick={() => {
        setMode(value);
        reset();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Bring content in" className={`${CARD} flex flex-col gap-4 p-5`}>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="How to bring content in">
          {tab('file', 'From a file')}
          {tab('paste', 'Paste text')}
          {tab('url', 'From a web address')}
        </div>

        {mode === 'file' && (
          <div className="grid gap-1">
            <label className="grid gap-1">
              <span className={LABEL}>Choose a text file</span>
              <input
                type="file"
                accept=".txt,.md,.markdown,.srt,.vtt,.html,.htm,text/plain"
                className="text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-xl file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-sm file:font-semibold"
                onChange={(event) => {
                  void onFile(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </label>
            <span className={HELP}>
              .txt and .md read as text; .srt and .vtt open as a listening transcript. PDF and Office files are not read
              here — copy their text into Paste.
            </span>
          </div>
        )}

        {mode === 'paste' && (
          <div className="grid gap-3">
            <label className="grid gap-1" htmlFor="import-title">
              <span className={LABEL}>Title (optional)</span>
              <input
                id="import-title"
                className={INPUT}
                value={pasteTitle}
                onChange={(event) => setPasteTitle(event.target.value)}
                placeholder="Left empty, the first line names it"
                maxLength={200}
              />
            </label>
            <div className="grid gap-1">
              <label className="grid gap-1" htmlFor="import-text">
                <span className={LABEL}>The text</span>
                <textarea
                  id="import-text"
                  className={TEXTAREA}
                  rows={8}
                  value={pasteText}
                  onChange={(event) => setPasteText(event.target.value)}
                  placeholder="Paste an article, a chapter, a transcript…"
                  maxLength={DISCOVERY_LIMITS.content}
                />
              </label>
              <span className={HELP}>
                {pasteText.length.toLocaleString('en-US')} / {DISCOVERY_LIMITS.content.toLocaleString('en-US')}{' '}
                characters
              </span>
            </div>
            <div>
              <button
                type="button"
                className={BUTTON_PRIMARY}
                onClick={showPastePreview}
                disabled={pasteText.trim() === ''}
              >
                Preview it
              </button>
            </div>
          </div>
        )}

        {mode === 'url' && (
          <div className="grid gap-3">
            <div className="grid gap-1">
              <label className="grid gap-1" htmlFor="import-url">
                <span className={LABEL}>Web address</span>
                <input
                  id="import-url"
                  className={INPUT}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/article"
                  inputMode="url"
                />
              </label>
              <span className={HELP}>
                Fetched server-side as plain text: scripts and styles are stripped before anything is shown, and
                addresses inside private networks are refused.
              </span>
            </div>
            <div>
              <button
                type="button"
                className={BUTTON_PRIMARY}
                onClick={() => void fetchPage()}
                disabled={url.trim().length < 4 || busy !== null}
                aria-busy={busy === 'url'}
              >
                {busy === 'url' && <Spinner />}
                Fetch a preview
              </button>
            </div>
          </div>
        )}

        {failure !== null && (
          <p role="alert" className={FIELD_ERROR}>
            {failure}
          </p>
        )}
      </section>

      {preview !== null && (
        <section aria-label="Preview" className={`${CARD} flex flex-col gap-3 p-5`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Preview — nothing is saved yet</h3>
            <span className="rounded-full border border-line px-2 py-0.5 text-xs font-medium text-muted">
              {preview.transcript ? 'Transcript' : preview.source === 'url' ? 'Web page' : 'Text'}
            </span>
          </div>
          <h4 className="font-serif text-xl font-semibold">{preview.title}</h4>
          {preview.origin !== 'pasted' && <p className="text-xs text-muted">{preview.origin}</p>}
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line p-4 text-sm leading-relaxed">
            {preview.content}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON_PRIMARY}
              onClick={() => void open()}
              disabled={busy !== null}
              aria-busy={busy === 'open'}
            >
              {busy === 'open' && <Spinner />}
              Open in the {preview.transcript ? 'listening' : 'reading'} workspace
            </button>
            <button type="button" className={BUTTON_GHOST} onClick={reset} disabled={busy !== null}>
              Discard
            </button>
            <span className={HELP}>
              Opens as {preview.transcript ? 'a transcript to listen with' : 'a text to read'} — you choose words
              inside it.
            </span>
          </div>
          <p className={HELP}>
            Opening stores exactly this text as one source (
            {preview.transcript ? KIND_LABELS.listening : KIND_LABELS.imported}
            {preview.source === 'url' ? ` / ${KIND_LABELS.web}` : ''}). Your vocabulary is untouched until you save
            a word inside it.
          </p>
        </section>
      )}
    </div>
  );
}
