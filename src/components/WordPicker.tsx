/**
 * Choosing the words to review, when the reviewer wants a set of their own.
 *
 * The list is the same vocabulary the bank shows, read with the same search, so
 * it reaches every live word without a new endpoint. It is ordered by mastery,
 * lowest first, so the words that need the most work come first. Mastered words
 * are left out rather than shown unusable: the schedule would drop them from the
 * queue anyway. The order words are ticked in is the order they will be reviewed
 * in, and the ticked list shows exactly that. Shift-clicking ticks a whole range
 * from the last word clicked.
 *
 * Starting a review with no connection is not possible — the queue is worked out
 * by the server — so this screen waits for the same read the bank does and says
 * so when it cannot be reached.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { useLibrary, useUiLanguage, useVocabulary } from '../app-context.js';
import { MasteryPill, StrengthPill } from './badges.js';
import { Spinner } from './Spinner.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT } from './ui.js';

/** How many words the list shows at a time; the rest arrive as it is scrolled past. */
const PAGE_SIZE = 50;

export interface WordPickerProps {
  /** Words to start with: a collection in the address, or the picks of the sitting already running. */
  initialIds: readonly string[];
  onStart(ids: string[]): void;
  onClose(): void;
}

const isMastered = (entry: VocabularyEntry): boolean => entry.reviewStatus === 'mastered';

const matches = (entry: VocabularyEntry, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [entry.word, entry.meaning, entry.definition, entry.example].some(
    (field) => field !== null && field.toLowerCase().includes(needle),
  );
};

export function WordPicker({ initialIds, onStart, onClose }: WordPickerProps) {
  const vocabulary = useVocabulary();
  const { status, entries } = vocabulary;
  const language = useUiLanguage();
  const fsrsOnly = vocabulary.meta?.fsrsOnly === true;
  const { collections, status: libraryStatus } = useLibrary();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [ticked, setTicked] = useState<string[]>(() => [...initialIds]);
  /** The last word clicked without Shift: a Shift-click ticks everything from here to there. */
  const anchor = useRef<string | null>(null);
  /** Set once the starting words have been applied, so a later collection read cannot overwrite a choice. */
  const seeded = useRef(initialIds.length > 0);

  // A collection in the address may arrive after the first draw: it is read from the account.
  useEffect(() => {
    if (seeded.current || initialIds.length === 0) return;
    seeded.current = true;
    setTicked((current) => [...current, ...initialIds.filter((id) => !current.includes(id))]);
  }, [initialIds]);

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const hidden = useMemo(() => (fsrsOnly ? 0 : entries.filter(isMastered).length), [entries, fsrsOnly]);
  // Under FSRS nothing retires, so every unarchived word can be picked. Lowest
  // memory strength first; the legacy schedule still uses mastery.
  const choices = useMemo(
    () =>
      entries
        .filter((entry) => (fsrsOnly ? entry.suspended !== true : !isMastered(entry)))
        .sort((a, b) =>
          fsrsOnly
            ? (a.memory?.level ?? 0) - (b.memory?.level ?? 0)
            : (a.mastery ?? 0) - (b.mastery ?? 0),
        ),
    [entries, fsrsOnly],
  );
  const found = useMemo(() => choices.filter((entry) => matches(entry, query)), [choices, query]);
  const visible = found.slice(0, shown);
  const tickedSet = new Set(ticked);

  const toggle = (id: string, extend = false) => {
    const to = visible.findIndex((entry) => entry.id === id);
    const from = extend && anchor.current !== null ? visible.findIndex((entry) => entry.id === anchor.current) : -1;
    if (from !== -1 && to !== -1) {
      const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((entry) => entry.id);
      setTicked((current) => {
        // A Shift-click on a ticked word takes the range out; on an unticked one it adds the range.
        if (current.includes(id)) return current.filter((each) => !range.includes(each));
        return [...current, ...range.filter((each) => !current.includes(each))];
      });
      return;
    }
    anchor.current = id;
    setTicked((current) => (current.includes(id) ? current.filter((each) => each !== id) : [...current, id]));
  };

  const addCollection = (collectionId: string) => {
    const collection = collections.find((each) => each.id === collectionId);
    if (collection === undefined) return;
    seeded.current = true;
    anchor.current = null;
    setTicked((current) => [...current, ...collection.wordIds.filter((id) => !current.includes(id))]);
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col gap-3 px-4 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-2xl font-semibold">Select words</h2>
        <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
          Cancel
        </button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="pick-search">
          Search your vocabulary
        </label>
        <input
          id="pick-search"
          className={INPUT}
          type="search"
          placeholder="Search by word or meaning"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setShown(PAGE_SIZE);
            anchor.current = null;
          }}
        />
        {collections.length > 0 && (
          <>
            <label className="sr-only" htmlFor="pick-collection">
              Add a collection
            </label>
            <select
              id="pick-collection"
              className={`${INPUT} sm:max-w-[12rem]`}
              value=""
              disabled={libraryStatus === 'loading'}
              onChange={(event) => {
                addCollection(event.target.value);
                event.currentTarget.value = '';
              }}
            >
              <option value="">Add a collection…</option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <p className={HELP}>
        {fsrsOnly ? 'Lowest memory strength first.' : 'Lowest mastery first.'} Shift-click to tick a whole range.
      </p>

      <div className={`${CARD} min-h-0 flex-1 overflow-y-auto`}>
        {status === 'loading' || status === 'idle' ? (
          <div role="status" className="flex items-center justify-center gap-3 p-6 text-muted">
            <Spinner className="size-5" />
            Loading your vocabulary…
          </div>
        ) : status === 'error' ? (
          <p role="alert" className="p-6 text-center text-muted">
            Your vocabulary could not be loaded, so there is nothing to choose from.
          </p>
        ) : found.length === 0 ? (
          <p className="p-6 text-center text-muted">
            {choices.length === 0
              ? fsrsOnly
                ? 'There are no words to pick yet.'
                : 'There are no words left to pick.'
              : 'No word matches that search.'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {visible.map((entry) => (
              <li key={entry.id}>
                <label className="flex cursor-pointer select-none items-center gap-3 px-3 py-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--accent)]"
                    checked={tickedSet.has(entry.id)}
                    onChange={(event) =>
                      toggle(entry.id, (event.nativeEvent as MouseEvent).shiftKey === true)
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{entry.word}</span>
                    {entry.meaning !== null && <span className="block truncate text-muted">{entry.meaning}</span>}
                  </span>
                  {fsrsOnly && entry.memory !== undefined ? (
                    <StrengthPill memory={entry.memory} compact language={language} />
                  ) : (
                    <MasteryPill mastery={entry.mastery} />
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}
        {visible.length < found.length && (
          <div className="border-t border-line p-3 text-center">
            <button type="button" className={BUTTON_SECONDARY} onClick={() => setShown((current) => current + PAGE_SIZE)}>
              Show more ({found.length - visible.length} left)
            </button>
          </div>
        )}
      </div>

      {(hidden > 0 || ticked.length > 0) && (
        <div className="flex flex-col gap-2">
          {ticked.length > 0 && (
            <div className={`${CARD} flex flex-wrap items-center gap-2 p-3`}>
              <span className={`${HELP} w-full`}>
                Reviewing in this order. Ticking a word again moves it to the end.
              </span>
              <ol className="flex flex-wrap gap-2">
                {ticked.map((id, at) => (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      title="Take this word out of the selection"
                      className="flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-xs font-medium text-ink"
                    >
                      <span className="tabular-nums text-muted">{at + 1}</span>
                      {byId.get(id)?.word ?? 'Word'}
                      <span aria-hidden="true" className="text-muted">
                        ×
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {hidden > 0 && (
            <p className={HELP}>
              {hidden === 1 ? '1 mastered word is not listed' : `${hidden} mastered words are not listed`}. Nothing can
              bring a mastered word back into review.
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        disabled={ticked.length === 0}
        onClick={() => onStart(ticked)}
        className={`${BUTTON_PRIMARY} h-12 w-full rounded-2xl`}
      >
        {ticked.length === 0
          ? 'Pick at least one word'
          : `Review ${ticked.length} ${ticked.length === 1 ? 'word' : 'words'}`}
      </button>
    </div>
  );
}
