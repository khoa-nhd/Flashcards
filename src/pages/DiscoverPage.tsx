import { navigate, useLocation } from '../lib/router.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { GeneratePanel } from '../components/discovery/GeneratePanel.js';
import { ImportPanel } from '../components/discovery/ImportPanel.js';
import { Listener } from '../components/discovery/Listener.js';
import { Reader } from '../components/discovery/Reader.js';
import { TextSourcesPanel } from '../components/discovery/TextSourcesPanel.js';
import { discoverHref } from '../components/discovery/labels.js';
import type { DiscoverySourceKind } from '../../shared/discovery.js';

type ViewKey = 'text' | 'read' | 'listen' | 'generate' | 'import';

const VIEWS: ReadonlyArray<{ key: ViewKey; label: string }> = [
  { key: 'text', label: 'Texts' },
  { key: 'read', label: 'Reading' },
  { key: 'listen', label: 'Listening' },
  { key: 'generate', label: 'Generate' },
  { key: 'import', label: 'Import' },
];

const isView = (value: string | null): value is ViewKey =>
  value !== null && VIEWS.some((view) => view.key === value);

/**
 * Discovery & Input: one page with five views, kept in the address so a
 * reload, a bookmark or Back lands where the learner expects. Texts is the
 * home; Reading and Listening are workspaces over one chosen source;
 * Generate drafts a reading and waits for acceptance; Import brings content
 * in by file, paste or address. Nothing on this page saves a word by
 * itself — words appear only where the learner presses Save.
 */
export function DiscoverPage() {
  const location = useLocation();
  const view: ViewKey = isView(location.query.get('view')) ? (location.query.get('view') as ViewKey) : 'text';
  const sourceId = location.query.get('source');

  const openIn = (sourceIdToOpen: string, kind: DiscoverySourceKind) => {
    navigate(discoverHref(kind === 'listening' ? 'listen' : 'read', sourceIdToOpen));
  };

  return (
    <div>
      <PageHeader
        title="Discovery"
        description="Read, listen, import or capture — and keep the words you choose, when you choose them."
      />

      <nav aria-label="Discovery views" className="mb-5 flex flex-wrap gap-1 border-b border-line pb-2">
        {VIEWS.map((entry) => (
          <Link
            key={entry.key}
            to={discoverHref(entry.key, entry.key === 'read' || entry.key === 'listen' ? sourceId : null)}
            aria-current={view === entry.key ? 'page' : undefined}
            className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
              view === entry.key ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-line/40'
            }`}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {view === 'text' && <TextSourcesPanel onOpen={openIn} />}
      {/* Keyed by source: each workspace starts from its own state, never the last one's. */}
      {view === 'read' && (
        <Reader key={sourceId ?? 'none'} sourceId={sourceId} onPickAnother={() => navigate(discoverHref('text'))} />
      )}
      {view === 'listen' && (
        <Listener key={sourceId ?? 'none'} sourceId={sourceId} onPickAnother={() => navigate(discoverHref('text'))} />
      )}
      {view === 'generate' && <GeneratePanel onAccepted={(id) => navigate(discoverHref('read', id))} />}
      {view === 'import' && <ImportPanel onOpened={openIn} />}
    </div>
  );
}
