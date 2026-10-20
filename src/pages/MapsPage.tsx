/**
 * Vocabulary maps: the list of the diagrams the learner has drawn, the picker
 * that starts a new one of a chosen kind (by hand, or drafted by the model
 * from a word, a collection or a topic), the personal map drawn live from
 * what they already have, and — behind a `?map=` query, so links and Back
 * work — one map opened for reading and editing.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { pageIdSchema } from '../../shared/api.js';
import {
  CREATABLE_MAP_TYPES,
  VOCAB_MAP_TYPE_HINTS,
  VOCAB_MAP_TYPE_LABELS,
  type CreatableMapType,
  type GenerateMapRequest,
} from '../../shared/vocab-map.js';
import { useApp, useVocabulary } from '../app-context.js';
import { Link } from '../components/Link.js';
import { MapDetail } from '../components/maps/MapDetail.js';
import { PersonalExperience } from '../components/maps/MapExperiences.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, LABEL, SECTION_TITLE } from '../components/ui.js';
import { useRemote } from '../hooks/useRemote.js';
import { ApiError } from '../lib/api-client.js';
import { ROUTES, buildHref, navigate, useLocation } from '../lib/router.js';

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

export function MapsPage() {
  const location = useLocation();
  const mapId = location.query.get('map');
  const onList = () => navigate(ROUTES.maps);

  if (mapId !== null && pageIdSchema.safeParse(mapId).success) {
    return (
      <div className="space-y-4">
        <MapDetail mapId={mapId} onBack={onList} />
      </div>
    );
  }
  if (location.query.get('view') === 'personal') return <PersonalMapView onBack={onList} />;
  return <MapsList onOpen={(id) => navigate(buildHref(ROUTES.maps, { map: id }))} />;
}

// ---------------------------------------------------------------------------
// The list, and starting a new map
// ---------------------------------------------------------------------------

function MapsList({ onOpen }: { onOpen(id: string): void }) {
  const { api } = useApp();
  const vocabulary = useVocabulary();
  const canWrite = vocabulary.meta === null || vocabulary.meta.writesEnabled;
  const remote = useRemote(() => api.fetchMaps(), 'Loading your maps failed.');
  const [creating, setCreating] = useState<'manual' | 'ai' | null>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Vocabulary maps"
        description="Diagrams you draw with your own words: meanings, families, combinations, topics, contrasts, situations and functions. A map keeps your words together — it never changes their schedule."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to={buildHref(ROUTES.maps, { view: 'personal' })} className={BUTTON_SECONDARY}>
              Your vocabulary at a glance
            </Link>
            {canWrite ? (
              <>
                <button
                  type="button"
                  className={BUTTON_PRIMARY}
                  onClick={() => setCreating((value) => (value === 'manual' ? null : 'manual'))}
                >
                  New map
                </button>
                <button
                  type="button"
                  className={BUTTON_SECONDARY}
                  onClick={() => setCreating((value) => (value === 'ai' ? null : 'ai'))}
                >
                  Draft with AI
                </button>
              </>
            ) : null}
          </div>
        }
      />

      {creating === 'manual' && canWrite ? (
        <NewMapForm
          onCancel={() => setCreating(null)}
          onCreate={async (request) => {
            const map = await api.createMap(request);
            setCreating(null);
            onOpen(map.id);
          }}
        />
      ) : creating === 'ai' && canWrite ? (
        <AiDraftForm onCancel={() => setCreating(null)} onOpen={onOpen} />
      ) : null}

      {remote.status === 'loading' ? (
        <p className="flex items-center gap-3 py-8 text-muted">
          <Spinner className="size-5" /> Loading your maps…
        </p>
      ) : remote.status === 'failed' ? (
        <p role="alert" className="text-sm text-bad-ink">
          {remote.error}
        </p>
      ) : remote.data.length === 0 ? (
        <section className={`${CARD} p-6`}>
          <h2 className="font-serif text-xl font-semibold text-ink">Draw your first map</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Eight experiences are waiting, each with its own shape: connect meanings in a semantic map, trace a word
            family from its root, table the combinations of a collocation, group vocabulary by topic, compare close
            expressions side by side, walk through a situation step by step, organise phrases by what you want to do —
            or see everything you already have in the personal map. You can also let AI draft one from a word, a
            collection or a topic; whatever it suggests stays a suggestion until you save it.
          </p>
        </section>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {remote.data.map((map) => (
            <li key={map.id}>
              <button
                type="button"
                className={`${CARD} w-full p-4 text-left hover:border-accent`}
                onClick={() => onOpen(map.id)}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{VOCAB_MAP_TYPE_LABELS[map.type]}</p>
                <p className="mt-1 font-serif text-lg font-semibold text-ink">{map.title}</p>
                {map.description === '' ? null : <p className="mt-1 text-sm text-muted">{map.description}</p>}
                <p className="mt-2 text-xs text-muted">
                  {map.nodeCount} item{map.nodeCount === 1 ? '' : 's'} · {map.edgeCount} relationship
                  {map.edgeCount === 1 ? '' : 's'} · edited {new Date(map.updatedAt).toLocaleDateString()}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewMapForm({
  onCreate,
  onCancel,
}: {
  onCreate(request: { type: CreatableMapType; title: string; description?: string; requestId: string }): Promise<void>;
  onCancel(): void;
}) {
  const [type, setType] = useState<CreatableMapType>('semantic');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        type,
        title: title.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        requestId: newRequestId(),
      });
    } catch (cause) {
      setError(messageOf(cause, 'Creating that map failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={`${CARD} space-y-4 p-4`} onSubmit={submit}>
      <h2 className={SECTION_TITLE}>Start a new map</h2>
      <fieldset>
        <legend className={LABEL}>What kind of map?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {CREATABLE_MAP_TYPES.map((one) => (
            <label
              key={one}
              className={`cursor-pointer rounded-xl border p-3 ${type === one ? 'border-accent bg-accent/5' : 'border-line'}`}
            >
              <input
                type="radio"
                name="map-type"
                className="sr-only"
                value={one}
                checked={type === one}
                onChange={() => setType(one)}
              />
              <span className="block text-sm font-semibold text-ink">{VOCAB_MAP_TYPE_LABELS[one]}</span>
              <span className="mt-1 block text-xs text-muted">{VOCAB_MAP_TYPE_HINTS[one]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className={`${LABEL} block`}>
        Title
        <input
          className={INPUT}
          value={title}
          maxLength={120}
          required
          placeholder="Everyday politeness"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className={`${LABEL} block`}>
        What it is about <span className="text-muted">(optional)</span>
        <input
          className={INPUT}
          value={description}
          maxLength={600}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      {error === null ? null : (
        <p role="alert" className="text-xs font-medium text-bad-ink">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={BUTTON_PRIMARY} disabled={busy || title.trim() === ''}>
          Create map
        </button>
        <button type="button" className={BUTTON_SECONDARY} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className={HELP}>
        Whatever AI drafts into a map later arrives as suggestions; nothing becomes a word without you saving it.
      </p>
    </form>
  );
}

/**
 * The AI drafting picker: what the map should start from — one word, one
 * collection or a topic — and what kind of map it should be. The draft comes
 * back as a real map whose seed words are saved and whose every other label
 * is a suggestion; pressing this button creates nothing but the map itself.
 */
function AiDraftForm({ onOpen, onCancel }: { onOpen(id: string): void; onCancel(): void }) {
  const { api } = useApp();
  const vocabulary = useVocabulary();
  const library = useRemote(() => api.fetchLibrary(), 'Loading your collections failed.');
  const [start, setStart] = useState<'topic' | 'word' | 'collection'>('topic');
  const [type, setType] = useState<CreatableMapType>('semantic');
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [search, setSearch] = useState('');
  const [wordId, setWordId] = useState<string | null>(null);
  const [collectionId, setCollectionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return [];
    return vocabulary.entries
      .filter((entry) => entry.word.toLowerCase().includes(needle) || (entry.meaning ?? '').toLowerCase().includes(needle))
      .slice(0, 8);
  }, [search, vocabulary.entries]);
  const chosenWord = wordId === null ? null : (vocabulary.entries.find((entry) => entry.id === wordId) ?? null);
  const collections = library.status === 'ready' ? library.data.collections : [];
  const ready =
    (start === 'topic' && topic.trim() !== '') ||
    (start === 'word' && wordId !== null) ||
    (start === 'collection' && collectionId !== '');
  const starts: Array<['topic' | 'word' | 'collection', string]> = [
    ['topic', 'A topic'],
    ['word', 'A word of mine'],
    ['collection', 'A collection'],
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const request: GenerateMapRequest = {
        type,
        requestId: newRequestId(),
        ...(title.trim() === '' ? {} : { title: title.trim() }),
        ...(start === 'topic' ? { topic: topic.trim() } : {}),
        ...(start === 'word' && wordId !== null ? { vocabularyId: wordId } : {}),
        ...(start === 'collection' && collectionId !== '' ? { collectionId } : {}),
      };
      const map = await api.generateMap(request);
      onOpen(map.id);
    } catch (cause) {
      setError(messageOf(cause, 'Drafting that map failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={`${CARD} space-y-4 p-4`} onSubmit={submit}>
      <h2 className={SECTION_TITLE}>Draft a map with AI</h2>
      <fieldset>
        <legend className={LABEL}>What should the draft start from?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {starts.map(([value, text]) => (
            <label
              key={value}
              className={`cursor-pointer rounded-xl border px-3 py-2 text-sm ${
                start === value ? 'border-accent bg-accent/5 text-ink' : 'border-line text-muted'
              }`}
            >
              <input
                type="radio"
                name="draft-start"
                className="sr-only"
                value={value}
                checked={start === value}
                onChange={() => setStart(value)}
              />
              {text}
            </label>
          ))}
        </div>
      </fieldset>

      {start === 'topic' ? (
        <label className={`${LABEL} block`}>
          The topic
          <input
            className={INPUT}
            value={topic}
            maxLength={200}
            required
            placeholder="Polite refusals"
            onChange={(event) => setTopic(event.target.value)}
          />
        </label>
      ) : null}

      {start === 'word' ? (
        chosenWord === null ? (
          <>
            <label className={`${LABEL} block`}>
              Which word
              <input
                className={INPUT}
                aria-label="Search your vocabulary for the word to draft from"
                value={search}
                placeholder="Search your words…"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {search.trim() !== '' && matches.length === 0 ? <p className={HELP}>No word of yours matches.</p> : null}
            <ul className="space-y-1">
              {matches.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-ink">{entry.word}</span>
                  {entry.meaning ? <span className="text-muted">— {entry.meaning.slice(0, 40)}</span> : null}
                  <button type="button" className={BUTTON_GHOST} onClick={() => setWordId(entry.id)}>
                    Draft from this
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className={HELP}>
            Drafting from “{chosenWord.word}” — it lands as a saved word on the map.{' '}
            <button type="button" className={BUTTON_GHOST} onClick={() => setWordId(null)}>
              Choose another
            </button>
          </p>
        )
      ) : null}

      {start === 'collection' ? (
        library.status === 'loading' ? (
          <p className="flex items-center gap-3 py-2 text-muted">
            <Spinner className="size-4" /> Loading your collections…
          </p>
        ) : library.status === 'failed' ? (
          <p role="alert" className="text-sm text-bad-ink">
            {library.error}{' '}
            <button type="button" className={BUTTON_GHOST} onClick={library.reload}>
              Try again
            </button>
          </p>
        ) : (
          <label className={`${LABEL} block`}>
            Which collection
            <select className={INPUT} value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
              <option value="">Choose a collection…</option>
              {collections.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name} ({one.wordIds.length} words)
                </option>
              ))}
            </select>
          </label>
        )
      ) : null}

      <label className={`${LABEL} block`}>
        What kind of map?
        <select className={INPUT} value={type} onChange={(event) => setType(event.target.value as CreatableMapType)}>
          {CREATABLE_MAP_TYPES.map((one) => (
            <option key={one} value={one}>
              {VOCAB_MAP_TYPE_LABELS[one]}
            </option>
          ))}
        </select>
      </label>

      <label className={`${LABEL} block`}>
        Title <span className="text-muted">(optional — taken from the seed otherwise)</span>
        <input
          className={INPUT}
          value={title}
          maxLength={120}
          placeholder="Everyday politeness"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      {error === null ? null : (
        <p role="alert" className="text-xs font-medium text-bad-ink">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button type="submit" className={BUTTON_PRIMARY} disabled={busy || !ready}>
          Draft the map
        </button>
        <button type="button" className={BUTTON_SECONDARY} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className={HELP}>
        The words you start from are saved on the map; everything else the model offers arrives as a suggestion and
        becomes a word only when you save it.
      </p>
    </form>
  );
}

/** One request id per press, so a double press cannot make two maps. */
function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// The personal map: read-only, drawn live from the library
// ---------------------------------------------------------------------------

function PersonalMapView({ onBack }: { onBack(): void }) {
  const { api } = useApp();
  const remote = useRemote(() => api.fetchPersonalMap(), 'Drawing your vocabulary at a glance failed.');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Your vocabulary at a glance"
        description="Drawn live from what you already have — words, collections, saved relationships and maps. It is a picture of your library, not a claim about what you have mastered, and opening it changes nothing."
        actions={
          <button type="button" className={BUTTON_GHOST} onClick={onBack}>
            All maps
          </button>
        }
      />
      {remote.status === 'loading' ? (
        <p className="flex items-center gap-3 py-8 text-muted">
          <Spinner className="size-5" /> Drawing your library…
        </p>
      ) : remote.status === 'failed' || remote.data === null ? (
        <p role="alert" className="text-sm text-bad-ink">
          {remote.error}
        </p>
      ) : (
        <PersonalExperience document={remote.data.personal} stats={remote.data.stats} />
      )}
    </div>
  );
}