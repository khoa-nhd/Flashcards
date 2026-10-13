import { useRef, useState, type KeyboardEvent, type MouseEventHandler } from 'react';
import { AI_LIMITS } from '../../shared/ai.js';
import { useApp } from '../app-context.js';
import { Icon } from '../components/Icon.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, TEXTAREA } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';

/** What the reader can carry from here into the add form. */
export interface Draft {
  word: string;
  meaning: string;
  definition: string;
  example: string;
}

interface Suggestion {
  word: string;
  sentence: string;
  definition: string | null;
  meaning: string | null;
}

/**
 * Smart Reader: paste a reading, pick a word, and get a draft for the card —
 * the sentence the word sits in (taken from the reader's own text by the
 * server), plus a suggested definition and Vietnamese meaning. Nothing is
 * saved here: "Use in the form" hands the draft to the ordinary add form,
 * where it is checked and edited like anything typed by hand. Every failure
 * — no AI on the server, rate limit, timeout, nonsense reply — lands back on
 * "fill it in yourself", never on an empty screen with no way forward.
 */
export function SmartReaderPanel({ onDraft }: { onDraft: (draft: Draft) => void }) {
  const { api } = useApp();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** True once the server has said it cannot help: stop offering the button. */
  const [unsupported, setUnsupported] = useState(false);
  const passage = useRef<HTMLTextAreaElement>(null);

  /** Whatever is selected right now is the word being asked about. */
  const readSelection = () => {
    const field = passage.current;
    if (field === null) return;
    const word = field.value.slice(field.selectionStart, field.selectionEnd).trim();
    setPicked(word === '' || word.length > AI_LIMITS.word ? null : word);
  };

  const onMouseUp: MouseEventHandler<HTMLTextAreaElement> = readSelection;
  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift + arrows extend a selection; every other key press re-reads it.
    if (event.shiftKey || event.key.startsWith('Arrow')) readSelection();
  };

  const suggest = async () => {
    if (picked === null || busy) return;
    setBusy(true);
    setFailure(null);
    setSuggestion(null);
    try {
      const result = await api.extractSense({ text, word: picked });
      setSuggestion({ word: picked, ...result });
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'not_supported' || error.code === 'read_only')) {
        setUnsupported(true);
        setFailure('This server has no AI assistance. Paste the text and fill the card in by hand.');
      } else if (error instanceof ApiError && error.code === 'invalid_request') {
        // The word was not in the text: the reader's own mistake to fix.
        setFailure(error.message);
      } else {
        setFailure(
          error instanceof ApiError ? `${error.message} Fill the card in by hand.` : 'The suggestion could not be loaded. Fill the card in by hand.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Paste a reading" className={`${CARD} flex flex-col gap-3 p-5`}>
        <p className="text-sm text-muted">
          Paste an article, then select (highlight) a new word in it. Only the sentence around the word is ever sent —
          to this server, and from there to the AI provider (see Settings → AI assistance). The rest of your text
          stays in this browser.
        </p>
        <label htmlFor="reader-passage" className="text-sm font-medium">
          Your reading
        </label>
        <textarea
          ref={passage}
          id="reader-passage"
          rows={8}
          className={TEXTAREA}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPicked(null);
          }}
          onMouseUp={onMouseUp}
          onKeyUp={onKeyUp}
          placeholder="Paste the article here, then select a word in it."
          maxLength={AI_LIMITS.passage}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm" role="status">
            {picked === null ? (
              <span className="text-muted">Select a word in the text above.</span>
            ) : (
              <>
                Selected: <strong className="font-semibold">{picked}</strong>
              </>
            )}
          </p>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => void suggest()}
            disabled={picked === null || busy || unsupported || text.trim() === ''}
            aria-busy={busy}
          >
            {busy && <Spinner />}
            Suggest for this word
          </button>
        </div>
        {failure !== null && (
          <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
            {failure}
          </p>
        )}
      </section>

      {suggestion !== null && (
        <section aria-label="Suggested card" className={`${CARD} flex flex-col gap-3 p-5`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Suggested card — check it before saving</h2>
            <button
              type="button"
              className={BUTTON_GHOST}
              onClick={() => {
                setSuggestion(null);
                passage.current?.focus();
              }}
              disabled={busy}
            >
              Discard
            </button>
          </div>
          <p className="rounded-xl border border-line px-3 py-2 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Sentence from your text</span>
            <span className="mt-1 block">{suggestion.sentence}</span>
          </p>
          <dl className="grid gap-1 text-sm">
            <dt className="font-semibold">Definition{suggestion.definition === null ? ' — not sure, please write it' : ''}</dt>
            <dd className="text-muted">{suggestion.definition ?? '—'}</dd>
            <dt className="font-semibold">Vietnamese meaning{suggestion.meaning === null ? ' — not sure, please write it' : ''}</dt>
            <dd className="text-muted">{suggestion.meaning ?? '—'}</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON_PRIMARY}
              onClick={() =>
                onDraft({
                  word: suggestion.word,
                  meaning: suggestion.meaning ?? '',
                  definition: suggestion.definition ?? '',
                  example: suggestion.sentence,
                })
              }
            >
              <Icon name="add" className="size-4" />
              Use in the form
            </button>
            <span className="text-xs text-muted">You can edit everything before saving.</span>
          </div>
        </section>
      )}

      <p className="text-xs text-muted">
        {unsupported
          ? 'Suggestions are unavailable here; the form takes everything you type.'
          : 'Suggestions come from an AI model and can be wrong. The sentence is always your own text; check both fields before saving.'}
      </p>
    </div>
  );
}
