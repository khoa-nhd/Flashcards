/**
 * Which word a word was formed from, and the family around it.
 *
 * Three halves, all organisation and never content: a timeline of what is
 * already there (the root above, the members below, as chips that open each
 * word), a draft the AI suggests and the reader reviews — untick a member,
 * save — before any word is created or pointed at its root, and example
 * sentences suggested with the collocations the reader has saved. Every
 * write afterwards is ordinary: create the words missing from the bank,
 * then set each member's rootId, or save a checked sentence as one more
 * example. Nothing here touches a word's content, mastery or review date,
 * and without a store that keeps rootId (schema version 11) the panel is
 * simply not shown.
 */
import { useState } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { LIBRARY_LIMITS, otherEnd } from '../../shared/library.js';
import { normalizeWord } from '../../shared/text.js';
import { useApp, useLibrary, useVocabulary } from '../app-context.js';
import { ApiError } from '../lib/api-client.js';
import { newRequestId } from '../lib/request-id.js';
import { openWord } from '../lib/router.js';
import { BUTTON_SECONDARY, HELP, TEXTAREA } from './ui.js';

const HEADING = 'text-xs font-medium uppercase tracking-[0.12em] text-muted';
const SMALL_BUTTON =
  'cursor-pointer rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-line/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

export function WordFamily({ entry, canWrite }: { entry: VocabularyEntry; canWrite: boolean }) {
  const { meta } = useVocabulary();
  // A store whose migration has not reached version 11 never sends rootId;
  // the whole panel stays out of the way rather than half-working.
  if (meta?.capabilities.roots !== true) return null;
  return (
    <>
      <FamilyTimeline entry={entry} />
      {canWrite && <FamilyBuilder entry={entry} />}
    </>
  );
}

/** The chain as chips: root → the word on screen → its members. Opens each word. */
function FamilyTimeline({ entry }: { entry: VocabularyEntry }) {
  const { entries } = useVocabulary();
  const root = entry.rootId === null ? null : (entries.find((item) => item.id === entry.rootId) ?? null);
  const children = entries.filter((item) => item.rootId === entry.id).sort((a, b) => a.word.localeCompare(b.word));
  if (root === null && children.length === 0) return null;

  const chip = (word: string, id: string, current: boolean) =>
    current ? (
      <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">{word}</span>
    ) : (
      <button
        type="button"
        className="cursor-pointer rounded-full border border-line px-2 py-0.5 text-xs font-medium text-ink hover:border-accent hover:text-accent"
        onClick={() => openWord(id)}
      >
        {word}
      </button>
    );

  const arrow = <span className="text-muted">→</span>;

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className={HEADING}>Word family</h3>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {root !== null && (
          <>
            {chip(root.word, root.id, false)}
            {arrow}
          </>
        )}
        {chip(entry.word, entry.id, true)}
        {children.map((child) => (
          <span key={child.id} className="flex items-center gap-x-2">
            {arrow}
            {chip(child.word, child.id, false)}
          </span>
        ))}
      </p>
    </section>
  );
}

/** One row of the draft family: what the model suggested and where it already is. */
interface DraftMember {
  word: string;
  gloss: string | null;
  root: boolean;
  checked: boolean;
  /** The id of the word already in the bank, or null for one that would be added. */
  entryId: string | null;
}

/**
 * The AI's draft family as a review table. The model names the members and
 * the root; the reader unticks what does not belong. Saving creates the
 * missing words and points every kept member at the root — a member's
 * rootId is that pointer, and the root itself keeps none.
 */
function FamilyBuilder({ entry }: { entry: VocabularyEntry }) {
  const { api, vocabulary } = useApp();
  const { entries } = useVocabulary();
  const [draft, setDraft] = useState<DraftMember[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const build = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const { family } = await api.wordFamily({ word: entry.word, meaning: entry.meaning, definition: entry.definition });
      const byWord = new Map(entries.map((item) => [normalizeWord(item.word), item.id]));
      const seen = new Set<string>();
      const rows = family.filter((member) => {
        const key = normalizeWord(member.word);
        if (key === '' || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // A model that marks no member as the root would leave every link
      // pointing nowhere; the word on screen, or the first row, stands in.
      const hasRoot = rows.some((member) => member.root);
      const standing = rows.findIndex((member) => normalizeWord(member.word) === normalizeWord(entry.word));
      setDraft(
        rows.map((member, index) => ({
          word: member.word,
          gloss: member.gloss,
          root: member.root || (!hasRoot && index === (standing === -1 ? 0 : standing)),
          checked: true,
          entryId: byWord.get(normalizeWord(member.word)) ?? null,
        })),
      );
    } catch (cause) {
      setError(messageOf(cause, 'Could not ask for the word family.'));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const failures: string[] = [];
    let added = 0;
    let linked = 0;
    // 1. Every checked member must exist before anything can point at it.
    const ids = new Map<number, string>();
    for (const [index, member] of draft.entries()) {
      if (!member.checked) continue;
      if (member.entryId !== null) {
        ids.set(index, member.entryId);
        continue;
      }
      try {
        const created = await api.createEntry({
          word: member.word,
          meaning: member.gloss ?? undefined,
          requestId: newRequestId(),
        });
        vocabulary.upsert(created);
        ids.set(index, created.id);
        added += 1;
      } catch (cause) {
        failures.push(`“${member.word}”: ${messageOf(cause, 'could not be added.')}`);
      }
    }
    // 2. Point every kept member at the root; the root itself becomes a root
    // of its own. When the root never arrived, the others are left alone
    // rather than made roots by accident.
    const rootIndex = draft.findIndex((member) => member.root);
    const rootId = ids.get(rootIndex) ?? null;
    for (const [index, member] of draft.entries()) {
      if (!member.checked || !ids.has(index)) continue;
      const nextRootId = index === rootIndex ? null : rootId;
      if (nextRootId === null && index !== rootIndex) continue;
      if ((entries.find((item) => item.id === ids.get(index))?.rootId ?? null) === nextRootId) continue;
      try {
        vocabulary.upsert(await api.updateEntry(ids.get(index) as string, { rootId: nextRootId }));
        linked += 1;
      } catch (cause) {
        failures.push(`“${member.word}”: ${messageOf(cause, 'could not be linked.')}`);
      }
    }
    setBusy(false);
    setDraft(null);
    await vocabulary.reload();
    if (failures.length > 0) setError(failures.join(' '));
    else setSaved(`${added} added, ${linked} linked.`);
  };

  const toggle = (index: number, checked: boolean) =>
    setDraft((current) => current?.map((row, i) => (i === index ? { ...row, checked } : row)) ?? null);

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className={HEADING}>Build the word family</h3>
      <p className="text-sm text-muted">
        Words formed from one root, kept together. The AI suggests the family; untick what does not belong, then save.
      </p>
      {draft === null ? (
        <button type="button" className={`${BUTTON_SECONDARY} self-start`} disabled={busy} onClick={() => void build()}>
          {busy ? 'Asking the model…' : 'Build the word family (AI)'}
        </button>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {draft.map((member, index) => (
              <li
                key={member.word}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={member.checked}
                  disabled={busy || member.root}
                  aria-label={`Keep ${member.word} in the family`}
                  onChange={(event) => toggle(index, event.target.checked)}
                />
                <span className="font-medium">{member.word}</span>
                {member.root && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">root</span>
                )}
                <span className="wrap-anywhere text-muted">{member.gloss ?? '—'}</span>
                <span className="ml-auto text-xs text-muted">{member.entryId === null ? 'new' : 'in your bank'}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={() => void save()}>
              Save the family
            </button>
            <button type="button" className={SMALL_BUTTON} disabled={busy} onClick={() => setDraft(null)}>
              Discard
            </button>
          </div>
        </>
      )}
      {saved !== null && (
        <p role="status" className="text-sm text-muted">
          {saved}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Example sentences the model suggests, shown as drafts inside the word's
 * examples. The collocations already saved for the word go along with the
 * request, so the sentences show the phrases the reader is actually
 * studying; each sentence can be edited, and only the checked ones are
 * saved — through the ordinary examples path, as drafts the reader has read.
 */
export function AiExamples({ entry, canWrite }: { entry: VocabularyEntry; canWrite: boolean }) {
  const { api, library } = useApp();
  const { relations } = useLibrary();
  const { entries } = useVocabulary();
  const [draft, setDraft] = useState<Array<{ sentence: string; uses: string | null; checked: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const names = new Map(entries.map((item) => [item.id, item.word]));
  const collocations = relations
    .filter((relation) => relation.kind === 'collocation')
    .map((relation) => otherEnd(relation, entry.id))
    .filter((id): id is string => id !== null)
    .map((id) => names.get(id))
    .filter((word): word is string => word !== undefined)
    .slice(0, 10);

  const suggest = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const reply = await api.suggestExamples({
        word: entry.word,
        meaning: entry.meaning,
        definition: entry.definition,
        example: entry.example,
        collocations,
      });
      setDraft(reply.examples.map((row) => ({ ...row, checked: true })));
    } catch (cause) {
      setError(messageOf(cause, 'Could not ask for example sentences.'));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    const failures: string[] = [];
    let added = 0;
    for (const row of draft) {
      if (!row.checked || row.sentence.trim() === '') continue;
      try {
        library.putExample(await api.addExample(entry.id, { sentence: row.sentence, source: 'AI suggestion' }));
        added += 1;
      } catch (cause) {
        failures.push(messageOf(cause, 'A sentence could not be saved.'));
      }
    }
    setBusy(false);
    setDraft([]);
    if (failures.length > 0) setError(failures.join(' '));
    else setSaved(`${added} ${added === 1 ? 'sentence' : 'sentences'} saved.`);
  };

  if (!canWrite) return null;
  return (
    <div className="flex flex-col gap-2">
      <button type="button" className={SMALL_BUTTON} disabled={busy} onClick={() => void suggest()}>
        {busy ? 'Asking the model…' : 'Suggest example sentences (AI)'}
      </button>
      <p className={HELP}>
        {collocations.length > 0
          ? `The sentences will show these in use: ${collocations.join(', ')}.`
          : 'This word has no saved collocations yet, so the sentences will be general ones.'}
      </p>
      {draft.map((row, index) => (
        <div key={index} className="flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-[var(--accent)]"
            checked={row.checked}
            disabled={busy}
            aria-label={`Save the suggested sentence “${row.sentence.slice(0, 40)}”`}
            onChange={(event) =>
              setDraft((current) =>
                current.map((item, i) => (i === index ? { ...item, checked: event.target.checked } : item)),
              )
            }
          />
          <div className="flex flex-1 flex-col gap-1">
            <textarea
              rows={2}
              className={TEXTAREA}
              maxLength={LIBRARY_LIMITS.example}
              aria-label="Suggested example sentence"
              value={row.sentence}
              disabled={busy}
              onChange={(event) =>
                setDraft((current) =>
                  current.map((item, i) => (i === index ? { ...item, sentence: event.target.value } : item)),
                )
              }
            />
            {row.uses !== null && <span className="text-xs text-muted">Uses: {row.uses}</span>}
          </div>
        </div>
      ))}
      {draft.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={() => void save()}>
            Save the checked sentences
          </button>
          <button type="button" className={SMALL_BUTTON} disabled={busy} onClick={() => setDraft([])}>
            Discard
          </button>
        </div>
      )}
      {saved !== null && (
        <p role="status" className="text-sm text-muted">
          {saved}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {error}
        </p>
      )}
    </div>
  );
}
