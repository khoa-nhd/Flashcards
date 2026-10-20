import { useState } from 'react';
import { useApp, useLibrary } from '../../app-context.js';
import { ApiError } from '../../lib/api-client.js';
import { newRequestId } from '../../lib/request-id.js';
import { Spinner } from '../Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, FIELD_ERROR, HELP, INPUT, LABEL, TEXTAREA } from '../ui.js';
import { failureMessage } from './message.js';

export interface GeneratePanelProps {
  /** The learner pressed “Use this reading”: the source exists, open it. */
  onAccepted(sourceId: string): void;
}

type Draft = {
  title: string;
  text: string;
  suggestions: Array<{ word: string; sentence?: string | null; note?: string | null }>;
};

type StartKind = 'topic' | 'collection' | 'words';

const GUESS_FAILURES: Record<string, string> = {
  not_supported: 'This server has no AI assistance. Write a reading yourself and bring it in through Import — nothing here needs a model.',
  read_only: 'Saving is switched off on this server, so no reading can be drafted.',
  rate_limited: 'Too many drafts just now. Wait a minute and ask again.',
  ai_invalid: 'The model answered with something this app will not use. Ask again, or write the reading yourself.',
};

/**
 * A reading the model drafts and the learner judges: exactly one starting
 * point (a topic, a saved collection, or up to thirty words), a validated
 * preview, and an acceptance that runs the ordinary source creation with
 * the suggested words as marks. Nothing is stored while drafting — not the
 * draft, not a word — and accepting overwrites nothing, because it only
 * ever creates a new source.
 */
export function GeneratePanel({ onAccepted }: GeneratePanelProps) {
  const { api } = useApp();
  const library = useLibrary();
  const [start, setStart] = useState<StartKind>('topic');
  const [topic, setTopic] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [words, setWords] = useState('');
  const [objective, setObjective] = useState('');
  const [short, setShort] = useState(true);
  const [busy, setBusy] = useState<'draft' | 'accept' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);

  const wordList = words
    .split(/[\n,]+/)
    .map((word) => word.trim())
    .filter((word) => word !== '');
  const wordsTooMany = wordList.length > 30;
  const ready =
    (start === 'topic' && topic.trim() !== '') ||
    (start === 'collection' && collectionId !== '') ||
    (start === 'words' && wordList.length > 0 && !wordsTooMany);

  const ask = async () => {
    if (!ready || busy !== null) return;
    setBusy('draft');
    setFailure(null);
    setDraft(null);
    setAccepted(null);
    try {
      const reply = await api.generateDraft({
        topic: start === 'topic' ? topic.trim() : undefined,
        collectionId: start === 'collection' ? collectionId : undefined,
        words: start === 'words' ? wordList : undefined,
        objective: objective.trim() === '' ? undefined : objective.trim(),
        length: short ? 'short' : 'medium',
        requestId: newRequestId(),
      });
      setDraft(reply.draft);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setFailure(GUESS_FAILURES[code] ?? failureMessage(error, 'The reading could not be drafted. Write it yourself and import it.'));
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    if (draft === null || busy !== null) return;
    setBusy('accept');
    setFailure(null);
    try {
      const created = await api.createSource({
        kind: 'generated',
        title: draft.title,
        origin: 'ai',
        content: draft.text,
        suggestions: draft.suggestions.map((suggestion) => ({
          word: suggestion.word,
          sentence: suggestion.sentence ?? undefined,
          note: suggestion.note ?? undefined,
        })),
        requestId: newRequestId(),
      });
      setAccepted(created.id);
      onAccepted(created.id);
    } catch (error) {
      setFailure(failureMessage(error, 'The reading was not kept. Nothing changed — try again.'));
    } finally {
      setBusy(null);
    }
  };

  const radio = (value: StartKind, label: string) => (
    <label key={value} className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="radio"
        name="generate-start"
        value={value}
        checked={start === value}
        onChange={() => {
          setStart(value);
          setFailure(null);
        }}
      />
      {label}
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="What to write from" className={`${CARD} flex flex-col gap-4 p-5`}>
        <div className="flex flex-col gap-2">
          <span className={LABEL}>Write a reading from…</span>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {radio('topic', 'A topic')}
            {radio('collection', 'A saved collection')}
            {radio('words', 'Some words')}
          </div>
        </div>

        {start === 'topic' && (
          <label className="grid gap-1" htmlFor="generate-topic">
            <span className={LABEL}>Topic</span>
            <input
              id="generate-topic"
              className={INPUT}
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="asking for time off, politely"
              maxLength={200}
            />
          </label>
        )}

        {start === 'collection' && (
          <div className="grid gap-1">
            <label className="grid gap-1" htmlFor="generate-collection">
              <span className={LABEL}>Collection</span>
              <select
                id="generate-collection"
                className={INPUT}
                value={collectionId}
                onChange={(event) => setCollectionId(event.target.value)}
              >
                <option value="">
                  {library.collections.length === 0
                    ? 'No collections yet — make one from Collections'
                    : 'Choose a collection…'}
                </option>
                {library.collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name} ({collection.wordIds.length} words)
                  </option>
                ))}
              </select>
            </label>
            <span className={HELP}>The collection is read for its words — drafting never changes it.</span>
          </div>
        )}

        {start === 'words' && (
          <div className="grid gap-1">
            <label className="grid gap-1" htmlFor="generate-words">
              <span className={LABEL}>Words (one per line, up to 30)</span>
              <textarea
                id="generate-words"
                className={TEXTAREA}
                rows={5}
                value={words}
                onChange={(event) => setWords(event.target.value)}
                placeholder={'candid\nlucid\nharbour'}
              />
            </label>
            <span className={HELP}>
              {wordsTooMany ? `That is ${wordList.length} words — 30 at most.` : `${wordList.length} of 30.`}
            </span>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1" htmlFor="generate-objective">
            <span className={LABEL}>What it should help you do (optional)</span>
            <input
              id="generate-objective"
              className={INPUT}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="practice polite requests"
              maxLength={200}
            />
          </label>
          <fieldset className="grid gap-1">
            <legend className={LABEL}>Length</legend>
            <div className="flex gap-4 pt-1 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="generate-length" checked={short} onChange={() => setShort(true)} />
                Short
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="generate-length" checked={!short} onChange={() => setShort(false)} />
                Medium
              </label>
            </div>
          </fieldset>
        </div>

        {failure !== null && (
          <p role="alert" className={FIELD_ERROR}>
            {failure}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={BUTTON_PRIMARY}
            onClick={() => void ask()}
            disabled={!ready || busy !== null}
            aria-busy={busy === 'draft'}
          >
            {busy === 'draft' && <Spinner />}
            Write a draft
          </button>
          <span className={HELP}>Drafts are not stored: nothing exists until you accept the preview.</span>
        </div>
      </section>

      {draft !== null && (
        <section aria-label="Draft preview" className={`${CARD} flex flex-col gap-3 p-5`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Draft — check it before keeping it</h3>
            <button
              type="button"
              className={BUTTON_GHOST}
              onClick={() => {
                setDraft(null);
                setFailure(null);
              }}
              disabled={busy !== null}
            >
              Discard
            </button>
          </div>

          <h4 className="font-serif text-xl font-semibold">{draft.title}</h4>
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line p-4 text-sm leading-relaxed">
            {draft.text}
          </div>

          {draft.suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Worth a look:</span>
              {draft.suggestions.map((suggestion) => (
                <span
                  key={suggestion.word}
                  title={suggestion.note ?? suggestion.sentence ?? undefined}
                  className="rounded-full border border-line px-2 py-0.5 text-xs font-medium"
                >
                  {suggestion.word}
                </span>
              ))}
              <span className={HELP}>They wait as marks — save only the ones you want.</span>
            </div>
          )}

          <p className={HELP}>Keeping it creates a new source. It overwrites nothing and saves no words by itself.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BUTTON_PRIMARY}
              onClick={() => void accept()}
              disabled={busy !== null}
              aria-busy={busy === 'accept'}
            >
              {busy === 'accept' && <Spinner />}
              Use this reading
            </button>
            <button type="button" className={BUTTON_SECONDARY} onClick={() => void ask()} disabled={busy !== null}>
              Write another
            </button>
          </div>
          {accepted !== null && (
            <p role="status" className={HELP}>
              Kept — opening it in the workspace now.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
