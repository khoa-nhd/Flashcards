/**
 * One page, three drawings of the same vocabulary: the collections the reader
 * grouped it into, the families words share through their root, and the links
 * saved between words. A segmented switcher picks the drawing; nothing here
 * writes, moves a schedule or decides anything — every word on every picture
 * opens its panel the way the bank opens it. The pictures themselves live in
 * TopicMaps.tsx; this file is only the page around them.
 */
import { useState } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { useApp, useLibrary, useVocabulary } from '../app-context.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { CollectionsMap, FamiliesMap, RelationsMap } from '../components/TopicMaps.js';
import { VocabularyGate } from '../components/VocabularyGate.js';
import { BUTTON_SECONDARY, CARD, PAGE } from '../components/ui.js';
import type { LibraryState } from '../lib/library-store.js';
import { ROUTES } from '../lib/router.js';

type View = 'collections' | 'families' | 'relations';

const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'collections', label: 'Collections' },
  { id: 'families', label: 'Word families' },
  { id: 'relations', label: 'Relations' },
];

export function MapPage() {
  const vocabulary = useVocabulary();
  const library = useLibrary();
  const [view, setView] = useState<View>('collections');
  const rootsReady = vocabulary.meta?.capabilities.roots === true;

  return (
    <div className={PAGE}>
      <PageHeader
        title="Topic map"
        description="Three ways your words group themselves: the collections you made, the families words share through their root, and the links you saved. Nothing here changes a word — every word opens its panel."
      />
      <VocabularyGate state={vocabulary}>
        {vocabulary.entries.length === 0 ? (
          <p className="text-sm text-muted">There are no words to map yet.</p>
        ) : (
          <>
            <div
              role="group"
              aria-label="Which map to draw"
              className="mb-4 flex w-fit flex-wrap gap-1 rounded-2xl border border-line p-1"
            >
              {VIEWS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={view === item.id}
                  onClick={() => setView(item.id)}
                  className={`rounded-xl px-3 py-1.5 text-sm font-medium transition ${
                    view === item.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className={`${CARD} flex flex-col gap-3 p-5`}>
              {view === 'families' ? (
                <FamiliesMap entries={vocabulary.entries} rootsReady={rootsReady} />
              ) : (
                <LibraryMap view={view} entries={vocabulary.entries} library={library} />
              )}
            </div>
          </>
        )}
      </VocabularyGate>
    </div>
  );
}

/** The two drawings that need the account's collections or relations, with the shared loading, failure and too-old states first. */
function LibraryMap({
  view,
  entries,
  library,
}: {
  view: 'collections' | 'relations';
  entries: VocabularyEntry[];
  library: LibraryState;
}) {
  const { library: store } = useApp();

  if (library.status === 'idle' || library.status === 'loading') {
    return (
      <p role="status" className="flex items-center gap-3 text-sm text-muted">
        <Spinner className="size-5" />
        Loading your collections…
      </p>
    );
  }
  if (library.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-sm text-bad-ink">
          {library.error}
        </p>
        <button type="button" className={BUTTON_SECONDARY} onClick={() => void store.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (!library.available) {
    return (
      <p className="text-sm text-muted">
        Collections and relations can be kept once the database has its latest update.{' '}
        <Link to={ROUTES.settings} className="font-medium text-accent hover:underline">
          See Settings
        </Link>
      </p>
    );
  }
  return view === 'collections' ? (
    <CollectionsMap entries={entries} collections={library.collections} />
  ) : (
    <RelationsMap entries={entries} relations={library.relations} />
  );
}
