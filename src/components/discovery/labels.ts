import type { DiscoverySourceKind } from '../../../shared/discovery.js';
import { ROUTES, buildHref } from '../../lib/router.js';

/** What each kind of source is called on screen. */
export const KIND_LABELS: Record<DiscoverySourceKind, string> = {
  text: 'Text',
  reading: 'Reading',
  listening: 'Listening',
  generated: 'Generated',
  imported: 'Imported',
  web: 'Web page',
  capture: 'Captures',
};

/** The workspace a source opens in: transcripts listen, everything else reads. */
export function openHref(sourceId: string, kind: DiscoverySourceKind): string {
  return buildHref(ROUTES.discover, { view: kind === 'listening' ? 'listen' : 'read', source: sourceId });
}

/** The address of a Discovery view, with its source. */
export function discoverHref(view: 'text' | 'read' | 'listen' | 'generate' | 'import', source?: string | null): string {
  return buildHref(ROUTES.discover, {
    view: view === 'text' ? null : view,
    source: source ?? null,
  });
}
