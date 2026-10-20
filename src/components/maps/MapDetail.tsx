/**
 * One map, opened: the canvas, the reading that suits its type, and the
 * editor that changes it. Three rules shape everything here.
 *
 * A saved node is a word by its id — its text is read live, so renaming the
 * word updates this map without touching it. A suggestion is visibly a
 * suggestion (dashed, chipped, labelled) and stays map data until the learner
 * presses "Save as a word", which is the one button that creates vocabulary.
 * And nothing on this page can reach a word's schedule, mastery or review
 * history: maps are housekeeping beside the Library, not learning history.
 */
import { useMemo, useState, type FormEvent } from 'react';
import {
  EDGE_KIND_NEEDS_PATTERN,
  MAP_EDGE_KINDS_BY_TYPE,
  MAP_EDGE_LABELS,
  VOCAB_MAP_TYPE_HINTS,
  VOCAB_MAP_TYPE_LABELS,
  type MapEdgeKind,
  type MapSuggestions,
  type VocabMapDocument,
  type VocabMapEdge,
  type VocabMapNode,
} from '../../../shared/vocab-map.js';
import { useApp, useVocabulary } from '../../app-context.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { PageHeader } from '../PageHeader.js';
import { Spinner } from '../Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, LABEL, SECTION_TITLE } from '../ui.js';
import { ApiError } from '../../lib/api-client.js';
import { openWord } from '../../lib/router.js';
import { useRemote } from '../../hooks/useRemote.js';
import { MapCanvas, nodeLabel } from './MapCanvas.js';
import { MapExperience } from './MapExperiences.js';

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

export interface MapDetailProps {
  mapId: string;
  /** Back to the list. */
  onBack(): void;
}

export function MapDetail({ mapId, onBack }: MapDetailProps) {
  const { api, toasts } = useApp();
  const vocabulary = useVocabulary();
  const canWrite = vocabulary.meta === null || vocabulary.meta.writesEnabled;
  const remote = useRemote(() => api.fetchMap(mapId), 'Loading that map failed.');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingExpand, setPendingExpand] = useState<MapSuggestions | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);

  if (remote.status === 'loading') {
    return (
      <div className="flex items-center gap-3 py-16 text-muted">
        <Spinner className="size-5" /> Loading the map…
      </div>
    );
  }
  if (remote.status === 'failed' || remote.data === null) {
    return (
      <div className="space-y-3 py-10">
        <p role="alert" className="text-sm text-bad-ink">
          {remote.error}
        </p>
        <button type="button" className={BUTTON_SECONDARY} onClick={onBack}>
          Back to your maps
        </button>
      </div>
    );
  }

  const document = remote.data;
  const selected = document.nodes.find((node) => node.id === selectedId) ?? null;

  /** Every change reports its refusal, and a stale map is reloaded rather than overwritten. */
  const run = async (change: () => Promise<unknown>, fallback: string, done?: string): Promise<boolean> => {
    try {
      await change();
      if (done !== undefined) toasts.show({ message: done, tone: 'success' });
      return true;
    } catch (error) {
      toasts.show({ message: messageOf(error, fallback), tone: 'error' });
      if (error instanceof ApiError && error.status === 409) remote.reload();
      return false;
    }
  };

  const moveNode = (nodeId: string, x: number, y: number) => {
    void run(
      () => api.saveLayout(mapId, { positions: [{ nodeId, x, y }], ifMatch: document.revision }),
      'Saving where that node sits failed.',
    );
  };

  const removeNode = (node: VocabMapNode) => {
    void run(
      () => api.removeNode(mapId, node.id),
      'Removing that item failed.',
      'Removed from the map. The word itself stays.',
    ).then((removed) => {
      if (removed) remote.reload();
    });
    setSelectedId(null);
  };

  const saveCandidate = (node: VocabMapNode) => {
    void run(
      () => api.saveCandidate(mapId, node.id, { requestId: newRequestId() }),
      'Saving that word failed.',
      'Saved as a word in your vocabulary.',
    ).then((saved) => {
      // The promotion happened on the server: re-read, so the list stops
      // calling it a suggestion at once.
      if (saved) remote.reload();
    });
  };

  const shiftStep = (node: VocabMapNode, direction: -1 | 1) => {
    const next = (node.step ?? 1) + direction;
    if (next < 1) return;
    void run(
      () => api.updateNode(mapId, node.id, { step: next, ifMatch: document.revision }),
      'Reordering the steps failed.',
    ).then((moved) => {
      if (moved) remote.reload();
    });
  };

  const expand = async (apply: boolean) => {
    try {
      const result = await api.expandMap(mapId, { apply, ...(apply ? { requestId: newRequestId() } : {}) });
      if (apply) {
        toasts.show({ message: 'Suggestions added to the map. They are still suggestions — no word was created.', tone: 'success' });
        setPendingExpand(null);
        remote.reload();
      } else {
        setPendingExpand(result.suggestions);
      }
    } catch (error) {
      toasts.show({ message: messageOf(error, 'Asking for suggestions failed.'), tone: 'error' });
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={document.title}
        description={`${VOCAB_MAP_TYPE_LABELS[document.type]} — ${VOCAB_MAP_TYPE_HINTS[document.type]}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BUTTON_GHOST} onClick={onBack}>
              All maps
            </button>
            {canWrite ? (
              <>
                <button type="button" className={BUTTON_SECONDARY} onClick={() => setRenaming(true)}>
                  Rename
                </button>
                {document.type === 'personal' ? null : (
                  <button type="button" className={BUTTON_SECONDARY} onClick={() => void expand(false)}>
                    Expand with AI
                  </button>
                )}
                <button type="button" className={BUTTON_SECONDARY} onClick={() => setConfirmingDelete(true)}>
                  Delete map
                </button>
              </>
            ) : null}
          </div>
        }
      />

      {renaming ? (
        <RenameForm
          initialTitle={document.title}
          initialDescription={document.description}
          onCancel={() => setRenaming(false)}
          onSubmit={async (title, description) => {
            const saved = await run(
              () => api.updateMap(mapId, { title, description, ifMatch: document.revision }),
              'Renaming failed.',
            );
            if (saved) {
              setRenaming(false);
              remote.reload();
            }
          }}
        />
      ) : null}

      {pendingExpand !== null ? (
        <ExpandPreview
          suggestions={pendingExpand}
          onCancel={() => setPendingExpand(null)}
          onApply={() => void expand(true)}
        />
      ) : null}

      <MapCanvas document={document} selectedId={selectedId} onSelect={setSelectedId} onMove={moveNode} />

      {/* The drawing's twin: every node, reachable and pressable without a pointer. */}
      <section className={CARD}>
        <h2 className={`${SECTION_TITLE} px-4 pt-4`}>Everything on this map</h2>
        <ul className="space-y-1 px-4 pb-4 pt-2">
          {document.nodes.length === 0 ? (
            <li className="text-sm text-muted">Nothing yet. Add a word or a suggestion below.</li>
          ) : (
            document.nodes.map((node) => (
              <li key={node.id} className="flex flex-wrap items-center gap-2 text-sm">
                <button
                  type="button"
                  className="font-medium text-ink underline-offset-2 hover:underline"
                  aria-label={`${nodeLabel(node)}${node.kind === 'candidate' ? ', suggestion' : ''}`}
                  onClick={() => setSelectedId(node.id)}
                >
                  {nodeLabel(node)}
                </button>
                <span className="text-xs text-muted">
                  {node.kind === 'candidate'
                    ? 'suggestion'
                    : node.sense !== null
                      ? `one meaning: ${node.sense.meaning ?? 'as recorded'}`
                      : 'saved word'}
                  {node.step !== null ? ` · step ${node.step}` : ''}
                  {node.group !== null ? ` · ${node.group}` : ''}
                </span>
                {selectedId === node.id && canWrite ? (
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    {node.kind === 'saved' && node.vocabularyId !== null ? (
                      <button type="button" className={BUTTON_GHOST} onClick={() => openWord(node.vocabularyId as string)}>
                        Open word
                      </button>
                    ) : null}
                    {node.kind === 'candidate' ? (
                      <button type="button" className={BUTTON_PRIMARY} onClick={() => saveCandidate(node)}>
                        Save as a word
                      </button>
                    ) : null}
                    {document.type === 'scenario' && node.step !== null ? (
                      <>
                        <button type="button" className={BUTTON_GHOST} aria-label={`Move ${nodeLabel(node)} earlier`} onClick={() => shiftStep(node, -1)}>
                          ↑ earlier
                        </button>
                        <button type="button" className={BUTTON_GHOST} aria-label={`Move ${nodeLabel(node)} later`} onClick={() => shiftStep(node, 1)}>
                          ↓ later
                        </button>
                      </>
                    ) : null}
                    <button type="button" className={BUTTON_GHOST} onClick={() => removeNode(node)}>
                      Remove
                    </button>
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </section>

      {selected !== null && selected.kind === 'candidate' ? (
        <p className={HELP}>
          “{nodeLabel(selected)}” is a suggestion on this map, not a word. It becomes one only when you press “Save as a
          word”.
        </p>
      ) : null}

      <section className={CARD}>
        <div className="px-4 pb-4 pt-4">
          <h2 className={SECTION_TITLE}>
            How this map reads: {VOCAB_MAP_TYPE_LABELS[document.type].toLowerCase()}
          </h2>
          <div className="mt-3">
            <MapExperience document={document} onOpenWord={(id) => openWord(id)} />
          </div>
        </div>
      </section>

      {canWrite ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <AddNodeCard document={document} api={api} onDone={remote.reload} onError={(error, fallback) => toasts.show({ message: messageOf(error, fallback), tone: 'error' })} />
          <AddEdgeCard document={document} api={api} onDone={remote.reload} onError={(error, fallback) => toasts.show({ message: messageOf(error, fallback), tone: 'error' })} />
          <RelationshipsCard
            document={document}
            canWrite={canWrite}
            onUpdate={(edgeId, patch) =>
              run(() => api.updateEdge(mapId, edgeId, { ...patch, ifMatch: document.revision }), 'Changing that relationship failed.')
            }
            onRemove={(edgeId) => run(() => api.removeEdge(mapId, edgeId), 'Removing that relationship failed.')}
            onDone={remote.reload}
          />
        </div>
      ) : (
        <p className={HELP}>Saving is switched off, so this map can be read but not changed.</p>
      )}

      {confirmingDelete ? (
        <ConfirmDialog
          title="Delete this map?"
          confirmLabel="Delete map"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            void run(() => api.deleteMap(mapId), 'Deleting that map failed.', 'Map deleted. No word was removed.')
              .then((ok) => {
                if (ok) onBack();
              });
          }}
        >
          <>
            “{document.title}”, its {document.nodes.length} items and its {document.edges.length} relationships are removed.
            Every word on it stays in your vocabulary.
          </>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** One request id per press, so a double press cannot do the work twice. */
function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function RenameForm({
  initialTitle,
  initialDescription,
  onSubmit,
  onCancel,
}: {
  initialTitle: string;
  initialDescription: string;
  onSubmit(title: string, description: string): void;
  onCancel(): void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  return (
    <form
      className={`${CARD} space-y-3 p-4`}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (title.trim() !== '') onSubmit(title.trim(), description.trim());
      }}
    >
      <label className={`${LABEL} block`}>
        Title
        <input className={INPUT} value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className={`${LABEL} block`}>
        What it is about <span className="text-muted">(optional)</span>
        <input className={INPUT} value={description} maxLength={600} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <div className="flex gap-2">
        <button type="submit" className={BUTTON_PRIMARY}>
          Save
        </button>
        <button type="button" className={BUTTON_SECONDARY} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type CardApiProps = {
  document: VocabMapDocument;
  api: ReturnType<typeof useApp>['api'];
  onDone(): void;
  onError(error: unknown, fallback: string): void;
};

/** Adding to the map: a word from the vocabulary, or a suggestion by its text. */
function AddNodeCard({ document, api, onDone, onError }: CardApiProps) {
  const vocabulary = useVocabulary();
  const [search, setSearch] = useState('');
  const [chosenSenses, setChosenSenses] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const onMap = useMemo(() => {
    const ids = new Set<string>();
    for (const node of document.nodes) if (node.vocabularyId !== null) ids.add(node.vocabularyId);
    return ids;
  }, [document.nodes]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return [];
    return vocabulary.entries
      .filter((entry) => !onMap.has(entry.id) && (entry.word.toLowerCase().includes(needle) || (entry.meaning ?? '').toLowerCase().includes(needle)))
      .slice(0, 8);
  }, [search, vocabulary.entries, onMap]);

  const addWord = async (vocabularyId: string) => {
    setBusy(true);
    try {
      await api.addNode(document.id, { kind: 'saved', vocabularyId, ...(chosenSenses[vocabularyId] ? { senseId: chosenSenses[vocabularyId] } : {}) });
      setSearch('');
      onDone();
    } catch (error) {
      onError(error, 'Adding that word failed.');
    } finally {
      setBusy(false);
    }
  };

  const addSuggestion = async (event: FormEvent) => {
    event.preventDefault();
    if (label.trim() === '') return;
    setBusy(true);
    try {
      await api.addNode(document.id, { kind: 'candidate', label: label.trim(), note: note.trim() });
      setLabel('');
      setNote('');
      onDone();
    } catch (error) {
      onError(error, 'Adding that suggestion failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${CARD} space-y-3 p-4`}>
      <h2 className={SECTION_TITLE}>Add a word from your vocabulary</h2>
      <input
        className={INPUT}
        placeholder="Search your words…"
        aria-label="Search your vocabulary to add to the map"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {search.trim() !== '' && matches.length === 0 ? <p className={HELP}>No word of yours matches.</p> : null}
      <ul className="space-y-1">
        {matches.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-ink">{entry.word}</span>
            {entry.meaning ? <span className="text-muted">— {entry.meaning.slice(0, 40)}</span> : null}
            {entry.senses.length > 1 ? (
              <select
                className="h-8 rounded-lg border border-line bg-surface px-2 text-xs"
                aria-label={`Which meaning of ${entry.word} goes on the map`}
                value={chosenSenses[entry.id] ?? ''}
                onChange={(event) => setChosenSenses((current) => ({ ...current, [entry.id]: event.target.value }))}
              >
                <option value="">the whole word</option>
                {entry.senses.map((sense) => (
                  <option key={sense.id} value={sense.id}>
                    {(sense.meaning ?? sense.definition ?? 'one meaning').slice(0, 30)}
                  </option>
                ))}
              </select>
            ) : null}
            <button type="button" className={BUTTON_GHOST} disabled={busy} onClick={() => void addWord(entry.id)}>
              Add
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={addSuggestion} className="space-y-2 border-t border-line pt-3">
        <h2 className={SECTION_TITLE}>Add a suggestion</h2>
        <p className={HELP}>A suggestion is map data, not a word: it becomes one only when you save it on purpose.</p>
        <input
          className={INPUT}
          placeholder="A word to look at later…"
          aria-label="The suggested word"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
        />
        <input
          className={INPUT}
          placeholder="Why it belongs here (optional)"
          aria-label="A note on the suggestion"
          value={note}
          maxLength={600}
          onChange={(event) => setNote(event.target.value)}
        />
        <button type="submit" className={BUTTON_SECONDARY} disabled={busy || label.trim() === ''}>
          Add suggestion
        </button>
      </form>
    </div>
  );
}

/** Connecting two nodes, with only the kinds this map's type accepts. */
function AddEdgeCard({ document, api, onDone, onError }: CardApiProps) {
  const [fromNodeId, setFrom] = useState('');
  const [toNodeId, setTo] = useState('');
  const [kind, setKind] = useState<MapEdgeKind>(MAP_EDGE_KINDS_BY_TYPE[document.type][0] ?? 'related');
  const [pattern, setPattern] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const kinds = MAP_EDGE_KINDS_BY_TYPE[document.type];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (fromNodeId === '' || toNodeId === '') return;
    setBusy(true);
    try {
      await api.addEdge(document.id, {
        fromNodeId,
        toNodeId,
        kind,
        ...(EDGE_KIND_NEEDS_PATTERN.includes(kind) || pattern.trim() !== '' ? { pattern: pattern.trim() } : {}),
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      setFrom('');
      setTo('');
      setPattern('');
      setNote('');
      onDone();
    } catch (error) {
      onError(error, 'Adding that relationship failed.');
    } finally {
      setBusy(false);
    }
  };

  if (document.nodes.length < 2) {
    return (
      <div className={`${CARD} p-4`}>
        <h2 className={SECTION_TITLE}>Connect two items</h2>
        <p className="mt-2 text-sm text-muted">Put at least two things on the map first.</p>
      </div>
    );
  }
  return (
    <form className={`${CARD} space-y-3 p-4`} onSubmit={submit}>
      <h2 className={SECTION_TITLE}>Connect two items</h2>
      <label className={`${LABEL} block`}>
        From
        <select className={INPUT} value={fromNodeId} onChange={(event) => setFrom(event.target.value)} required>
          <option value="">Choose…</option>
          {document.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {nodeLabel(node)}
            </option>
          ))}
        </select>
      </label>
      <label className={`${LABEL} block`}>
        Relationship
        <select className={INPUT} value={kind} onChange={(event) => setKind(event.target.value as MapEdgeKind)}>
          {kinds.map((one) => (
            <option key={one} value={one}>
              {MAP_EDGE_LABELS[one]}
            </option>
          ))}
        </select>
      </label>
      <label className={`${LABEL} block`}>
        To
        <select className={INPUT} value={toNodeId} onChange={(event) => setTo(event.target.value)} required>
          <option value="">Choose…</option>
          {document.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {nodeLabel(node)}
            </option>
          ))}
        </select>
      </label>
      {EDGE_KIND_NEEDS_PATTERN.includes(kind) ? (
        <label className={`${LABEL} block`}>
          The combination <span className="text-muted">(such as “make a decision”)</span>
          <input className={INPUT} value={pattern} maxLength={120} onChange={(event) => setPattern(event.target.value)} required />
        </label>
      ) : null}
      <label className={`${LABEL} block`}>
        {document.type === 'nuance' ? 'The difference' : 'A note'} <span className="text-muted">(optional)</span>
        <input
          className={INPUT}
          value={note}
          maxLength={600}
          onChange={(event) => setNote(event.target.value)}
          required={document.type === 'nuance'}
        />
      </label>
      <button type="submit" className={BUTTON_SECONDARY} disabled={busy}>
        Add relationship
      </button>
    </form>
  );
}

/** Every relationship, with its pattern and note editable and each removable. */
function RelationshipsCard({
  document,
  canWrite,
  onUpdate,
  onRemove,
  onDone,
}: {
  document: VocabMapDocument;
  canWrite: boolean;
  onUpdate(edgeId: string, patch: { pattern?: string; note?: string }): Promise<unknown>;
  onRemove(edgeId: string): Promise<unknown>;
  onDone(): void;
}) {
  const labelIn = (id: string) => {
    const node = document.nodes.find((one) => one.id === id);
    return node === undefined ? '?' : nodeLabel(node);
  };
  if (document.edges.length === 0) {
    return (
      <div className={`${CARD} p-4`}>
        <h2 className={SECTION_TITLE}>Relationships</h2>
        <p className="mt-2 text-sm text-muted">Nothing is connected yet.</p>
      </div>
    );
  }
  return (
    <div className={`${CARD} space-y-3 p-4 lg:col-span-2`}>
      <h2 className={SECTION_TITLE}>Relationships</h2>
      <ul className="space-y-2">
        {document.edges.map((edge: VocabMapEdge) => (
          <li key={edge.id} className="space-y-1.5 rounded-xl border border-line/70 p-2.5">
            <p className="text-sm text-ink">
              <span className="font-medium">{MAP_EDGE_LABELS[edge.kind]}</span>
              {edge.pattern === '' ? null : <span className="text-muted"> “{edge.pattern}”</span>}
              {': '}
              {labelIn(edge.fromNodeId)} → {labelIn(edge.toNodeId)}
              {edge.note === '' ? null : <span className="text-muted"> — {edge.note}</span>}
            </p>
            {canWrite ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-muted">
                  Combination
                  <input
                    className={`${INPUT} mt-0.5`}
                    defaultValue={edge.pattern}
                    maxLength={120}
                    aria-label={`Combination for ${MAP_EDGE_LABELS[edge.kind]}`}
                    onBlur={(event) => {
                      if (event.target.value !== edge.pattern) void onUpdate(edge.id, { pattern: event.target.value }).then(onDone);
                    }}
                  />
                </label>
                <label className="text-xs text-muted">
                  Note
                  <input
                    className={`${INPUT} mt-0.5`}
                    defaultValue={edge.note}
                    maxLength={600}
                    aria-label={`Note for ${MAP_EDGE_LABELS[edge.kind]}`}
                    onBlur={(event) => {
                      if (event.target.value !== edge.note) void onUpdate(edge.id, { note: event.target.value }).then(onDone);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className={BUTTON_GHOST}
                  onClick={() => {
                    void onRemove(edge.id).then(onDone);
                  }}
                >
                  Remove
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the model proposed, before any of it touches the map. */
function ExpandPreview({
  suggestions,
  onApply,
  onCancel,
}: {
  suggestions: MapSuggestions;
  onApply(): void;
  onCancel(): void;
}) {
  return (
    <section className={CARD} aria-label="AI suggestions preview">
      <div className="space-y-3 p-4">
        <h2 className={SECTION_TITLE}>The AI suggests</h2>
        <p className={HELP}>
          These are proposals, not words. Adding them puts suggestions on the map — nothing enters your vocabulary
          without “Save as a word”.
        </p>
        <ul className="space-y-1 text-sm text-ink">
          {suggestions.nodes.map((node) => (
            <li key={node.label}>
              <span className="font-medium">{node.label}</span>
              {node.group === null ? null : <span className="text-muted"> · {node.group}</span>}
              {node.note === '' ? null : <span className="text-muted"> — {node.note}</span>}
            </li>
          ))}
          {suggestions.edges.map((edge) => (
            <li key={`${edge.kind}-${edge.fromLabel}-${edge.toLabel}`} className="text-muted">
              {MAP_EDGE_LABELS[edge.kind]}: {edge.fromLabel} → {edge.toLabel}
              {edge.pattern === '' ? null : ` (“${edge.pattern}”)`}
              {edge.note === '' ? null : ` — ${edge.note}`}
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button type="button" className={BUTTON_PRIMARY} onClick={onApply}>
            Add these to the map
          </button>
          <button type="button" className={BUTTON_SECONDARY} onClick={onCancel}>
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}
