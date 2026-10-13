import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { LIBRARY_LIMITS, RELATION_KINDS, RELATION_LABELS, otherEnd, type RelationKind } from '../../shared/library.js';
import { normalizeWord } from '../../shared/text.js';
import { useApp, useLibrary, useVocabulary } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { ROUTES, openWord } from '../lib/router.js';
import { Link } from './Link.js';
import { SemanticGraph } from './SemanticGraph.js';
import { BUTTON_SECONDARY, HELP, INPUT, TEXTAREA } from './ui.js';

const HEADING = 'text-xs font-medium uppercase tracking-[0.12em] text-muted';
const SMALL_BUTTON =
  'cursor-pointer rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-line/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

function Section({ title, error, children }: { title: string; error: string | null; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id={id} className={HEADING}>
        {title}
      </h3>
      {children}
      {error !== null && (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * How a word is organised: the collections it is in, its further examples and
 * the words it is related to. None of this is part of the word itself, and
 * changing it never touches the word's content, mastery or review date.
 */
export function WordExtras({ entry, canWrite }: { entry: VocabularyEntry; canWrite: boolean }) {
  const library = useLibrary();

  if (library.status === 'idle' || library.status === 'loading') {
    return (
      <p role="status" className="border-t border-line pt-4 text-sm text-muted">
        Loading collections and related words…
      </p>
    );
  }
  if (library.status === 'error') {
    return (
      <p role="alert" className="border-t border-line pt-4 text-sm text-bad-ink">
        {library.error}
      </p>
    );
  }
  // Where the database cannot keep any of this yet, the panel simply shows the word.
  if (!library.available) return null;

  return (
    <>
      <Collections entry={entry} canWrite={canWrite} />
      <Examples entry={entry} canWrite={canWrite} />
      <Relations entry={entry} canWrite={canWrite} />
      <Connections entry={entry} />
    </>
  );
}

/**
 * The same links and collections as the sections above, drawn as a diagram.
 * The lists are handed over, so the graph stays a plain view of what is there.
 */
function Connections({ entry }: { entry: VocabularyEntry }) {
  const { collections, relations } = useLibrary();
  const { entries } = useVocabulary();
  return <SemanticGraph focusId={entry.id} relations={relations} collections={collections} words={entries} />;
}

function Collections({ entry, canWrite }: { entry: VocabularyEntry; canWrite: boolean }) {
  const { api, library } = useApp();
  const { collections } = useLibrary();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (collectionId: string, member: boolean) => {
    setBusy(collectionId);
    setError(null);
    try {
      library.putCollection(await api.setMembership(collectionId, entry.id, member));
    } catch (cause) {
      setError(messageOf(cause, 'Could not change the collection.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Collections" error={error}>
      {collections.length === 0 ? (
        <p className="text-sm text-muted">
          No collections yet.{' '}
          <Link to={ROUTES.collections} className="font-medium text-accent hover:underline">
            Create one
          </Link>
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {collections.map((collection) => (
            <li key={collection.id}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={collection.wordIds.includes(entry.id)}
                  disabled={!canWrite || busy !== null}
                  onChange={(event) => void toggle(collection.id, event.target.checked)}
                />
                {collection.name}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Examples({ entry, canWrite }: { entry: VocabularyEntry; canWrite: boolean }) {
  const { api, library } = useApp();
  const { examples } = useLibrary();
  const [sentence, setSentence] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The preferred one first, then in the order they were added.
  const mine = examples
    .filter((example) => example.vocabularyId === entry.id)
    .sort((a, b) => Number(b.preferred) - Number(a.preferred));

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(messageOf(cause, fallback));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (sentence.trim() === '') return;
    void run(async () => {
      library.putExample(await api.addExample(entry.id, { sentence, source: source.trim() === '' ? null : source }));
      setSentence('');
      setSource('');
    }, 'Could not add the example.');
  };

  return (
    <Section title="More examples" error={error}>
      {mine.length === 0 ? (
        <p className="text-sm text-muted">None yet. The example above stays the one shown on the flashcard.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {mine.map((example) => (
            <li key={example.id} className="rounded-xl border border-line px-3 py-2 text-sm">
              <p className="whitespace-pre-wrap wrap-anywhere">{example.sentence}</p>
              {example.source !== null && <p className="mt-0.5 text-xs text-muted">Source: {example.source}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {example.preferred && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Preferred</span>}
                {canWrite && (
                  <>
                    <button
                      type="button"
                      className={SMALL_BUTTON}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          async () => library.putExample(await api.updateExample(example.id, { preferred: !example.preferred })),
                          'Could not change the example.',
                        )
                      }
                    >
                      {example.preferred ? 'Remove the preferred mark' : 'Mark as preferred'}
                    </button>
                    <button
                      type="button"
                      className={SMALL_BUTTON}
                      disabled={busy}
                      aria-label={`Remove the example “${example.sentence.slice(0, 40)}”`}
                      onClick={() =>
                        void run(async () => {
                          await api.deleteExample(example.id);
                          library.removeExample(example.id);
                        }, 'Could not remove the example.')
                      }
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={add} className="flex flex-col gap-2">
          <label className="sr-only" htmlFor="extra-example-sentence">
            Another example sentence
          </label>
          <textarea
            id="extra-example-sentence"
            rows={2}
            className={TEXTAREA}
            placeholder="Another example sentence"
            maxLength={LIBRARY_LIMITS.example}
            value={sentence}
            disabled={busy}
            onChange={(event) => setSentence(event.target.value)}
          />
          <label className="sr-only" htmlFor="extra-example-source">
            Where it is from (optional)
          </label>
          <input
            id="extra-example-source"
            className={INPUT}
            placeholder="Where it is from (optional)"
            maxLength={LIBRARY_LIMITS.source}
            value={source}
            disabled={busy}
            onChange={(event) => setSource(event.target.value)}
          />
          <button type="submit" className={`${BUTTON_SECONDARY} self-start`} disabled={busy || sentence.trim() === ''}>
            Add example
          </button>
        </form>
      )}
    </Section>
  );
}

function Relations({ entry, canWrite }: { entry: VocabularyEntry; canWrite: boolean }) {
  const { api, library } = useApp();
  const { relations } = useLibrary();
  const { entries } = useVocabulary();
  const [kind, setKind] = useState<RelationKind>('synonym');
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  const names = new Map(entries.map((item) => [item.id, item.word]));
  const mine = relations
    .map((relation) => ({ relation, other: otherEnd(relation, entry.id) }))
    .filter((item): item is { relation: (typeof relations)[number]; other: string } => item.other !== null && names.has(item.other));
  const others = entries.filter((item) => item.id !== entry.id);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const wanted = normalizeWord(word);
    if (wanted === '') return;
    // The word has to be one already in the vocabulary: nothing is created or guessed here.
    const matches = others.filter((item) => normalizeWord(item.word) === wanted);
    if (matches.length === 0) {
      setError(`“${word.trim()}” is not in your vocabulary. Add it first, then link it.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      library.putRelation(await api.addRelation(entry.id, (matches[0] as VocabularyEntry).id, kind));
      setWord('');
    } catch (cause) {
      setError(messageOf(cause, 'Could not link the words.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteRelation(id);
      library.removeRelation(id);
    } catch (cause) {
      setError(messageOf(cause, 'Could not remove the link.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Related words" error={error}>
      {mine.length === 0 ? (
        <p className="text-sm text-muted">None yet. Words are only ever linked by you.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {RELATION_KINDS.flatMap((group) =>
            mine
              .filter((item) => item.relation.kind === group)
              .map(({ relation, other }) => (
                <li key={relation.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                  <span className="text-muted">{RELATION_LABELS[relation.kind]}:</span>
                  <button
                    type="button"
                    className="cursor-pointer font-medium text-accent underline-offset-2 hover:underline"
                    onClick={() => openWord(other)}
                  >
                    {names.get(other)}
                  </button>
                  {canWrite && (
                    <button
                      type="button"
                      className={SMALL_BUTTON}
                      disabled={busy}
                      aria-label={`Remove the link to ${names.get(other) ?? 'that word'}`}
                      onClick={() => void remove(relation.id)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              )),
          )}
        </ul>
      )}
      {canWrite && others.length > 0 && (
        <form onSubmit={(event) => void add(event)} className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="sr-only" htmlFor="relation-kind">
                Kind of link
              </label>
              <select
                id="relation-kind"
                className={INPUT}
                value={kind}
                disabled={busy}
                onChange={(event) => setKind(event.target.value as RelationKind)}
              >
                {RELATION_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {RELATION_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="sr-only" htmlFor="relation-word">
                Word to link
              </label>
              <input
                id="relation-word"
                className={INPUT}
                list={listId}
                placeholder="A word in your vocabulary"
                autoComplete="off"
                value={word}
                disabled={busy}
                onChange={(event) => setWord(event.target.value)}
              />
              <datalist id={listId}>
                {others.map((item) => (
                  <option key={item.id} value={item.word} />
                ))}
              </datalist>
            </div>
          </div>
          <button type="submit" className={`${BUTTON_SECONDARY} self-start`} disabled={busy || word.trim() === ''}>
            Link words
          </button>
          <p className={HELP}>A link shows on both words. It does not change either word or when it is reviewed.</p>
        </form>
      )}
    </Section>
  );
}
