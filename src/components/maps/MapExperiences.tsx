/**
 * The eight learning experiences. Each map type renders its own way, because
 * a collocation is a table of combinations and a scenario is a timeline — a
 * different title on the same drawing would not be a different experience.
 * Every panel is a second, text-shaped copy of what the canvas draws, so the
 * picture is never the only way to read a map.
 */
import { MAP_EDGE_LABELS, type VocabMapDocument, type VocabMapEdge, type VocabMapNode } from '../../../shared/vocab-map.js';
import { HELP, SECTION_TITLE } from '../ui.js';
import { nodeLabel } from './MapCanvas.js';

export interface ExperienceProps {
  document: VocabMapDocument;
  /** Opens a saved word's panel. Candidates cannot be opened — they are not words yet. */
  onOpenWord?: (vocabularyId: string) => void;
}

const nodeOf = (document: VocabMapDocument, id: string): VocabMapNode | undefined =>
  document.nodes.find((node) => node.id === id);

const labelIn = (document: VocabMapDocument, id: string): string => {
  const node = nodeOf(document, id);
  return node === undefined ? '?' : nodeLabel(node);
};

/** A word as a pressable chip; a suggestion reads as itself, not as a word. */
function WordChip({
  node,
  onOpenWord,
}: {
  node: VocabMapNode;
  onOpenWord?: (vocabularyId: string) => void;
}) {
  if (node.kind === 'candidate' || node.vocabularyId === null) {
    return (
      <span className="rounded-full border border-dashed border-accent px-2.5 py-0.5 text-xs font-medium text-ink">
        {nodeLabel(node)} <span className="text-muted">(suggestion)</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-ink hover:border-accent"
      onClick={() => onOpenWord?.(node.vocabularyId as string)}
    >
      {nodeLabel(node)}
    </button>
  );
}

/** One relationship, spelled out: kind · from → to, with pattern and note. */
function EdgeSentence({ document, edge }: { document: VocabMapDocument; edge: VocabMapEdge }) {
  return (
    <li className="text-sm text-ink">
      <span className="font-medium">{MAP_EDGE_LABELS[edge.kind]}</span>
      {edge.pattern === '' ? null : <span className="text-muted"> “{edge.pattern}”</span>}
      {': '}
      {labelIn(document, edge.fromNodeId)} → {labelIn(document, edge.toNodeId)}
      {edge.note === '' ? null : <span className="text-muted"> — {edge.note}</span>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Semantic relationships: meaning links, tied to the sense that holds them
// ---------------------------------------------------------------------------

export function SemanticExperience({ document, onOpenWord }: ExperienceProps) {
  const kinds = [...new Set(document.edges.map((edge) => edge.kind))];
  const senseNodes = document.nodes.filter((node) => node.sense !== null);
  return (
    <div className="space-y-4">
      {senseNodes.length > 0 ? (
        <section>
          <h3 className={SECTION_TITLE}>Meanings on this map</h3>
          <p className={HELP}>A relationship between two of these holds for that meaning, not for every meaning of the word.</p>
          <ul className="mt-2 space-y-1">
            {senseNodes.map((node) => (
              <li key={node.id} className="text-sm text-ink">
                <span className="font-medium">{nodeLabel(node)}</span>
                {node.sense?.meaning === null || node.sense?.meaning === undefined ? null : (
                  <span className="text-muted"> — {node.sense.meaning}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {kinds.map((kind) => {
        const edges = document.edges.filter((edge) => edge.kind === kind);
        if (edges.length === 0) return null;
        return (
          <section key={kind}>
            <h3 className={SECTION_TITLE}>{MAP_EDGE_LABELS[kind]}</h3>
            <ul className="mt-2 space-y-1">
              {edges.map((edge) => (
                <EdgeSentence key={edge.id} document={document} edge={edge} />
              ))}
            </ul>
          </section>
        );
      })}
      <section>
        <h3 className={SECTION_TITLE}>Words on this map</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {document.nodes.map((node) => (
            <WordChip key={node.id} node={node} onOpenWord={onOpenWord} />
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Word family: which end of the family is the root, and who formed from it
// ---------------------------------------------------------------------------

export function WordFamilyExperience({ document, onOpenWord }: ExperienceProps) {
  const familyKinds = new Set(['derivation', 'inflection', 'related_form']);
  const familyEdges = document.edges.filter((edge) => familyKinds.has(edge.kind));
  // A family link reads "form → root": what was derived or inflected sits at
  // the start of each link, so a root is a node no family link starts from —
  // an inflected form is shown beneath its root, never as a root of its own.
  // A word no family link touches at all is a family of its own.
  const formed = new Set(familyEdges.map((edge) => edge.fromNodeId));
  const roots = document.nodes.filter((node) => !formed.has(node.id));
  const standalone = roots.filter(
    (root) => !familyEdges.some((edge) => edge.fromNodeId === root.id || edge.toNodeId === root.id),
  );
  const withFamily = roots.filter((root) => !standalone.includes(root));
  const childrenOf = (rootId: string) => familyEdges.filter((edge) => edge.toNodeId === rootId);

  if (document.edges.length === 0) {
    return <p className={HELP}>No family links yet. Connect a derived word to its root from the editor below.</p>;
  }
  return (
    <div className="space-y-4">
      <p className={HELP}>
        Every root below is a word other words were formed from. “Derived from” shows how a word was built;
        “inflected form” shows the same word in another shape.
      </p>
      {withFamily.map((root) => (
        <section key={root.id}>
          <h3 className={SECTION_TITLE}>
            Root: {nodeLabel(root)}
            {root.word?.meaning ? <span className="font-normal text-muted"> — {root.word.meaning}</span> : null}
          </h3>
          <ul className="mt-2 space-y-1.5 pl-1">
            {childrenOf(root.id).map((edge) => (
              <li key={edge.id} className="text-sm text-ink">
                <span className="text-muted">└─ {MAP_EDGE_LABELS[edge.kind]}: </span>
                <span className="font-medium">{labelIn(document, edge.fromNodeId)}</span>
                {edge.note === '' ? null : <span className="text-muted"> — {edge.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {standalone.length > 0 ? (
        <section>
          <h3 className={SECTION_TITLE}>On their own</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {standalone.map((node) => (
              <WordChip key={node.id} node={node} onOpenWord={onOpenWord} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collocations: the combinations themselves, with an example each
// ---------------------------------------------------------------------------

export function CollocationExperience({ document, onOpenWord }: ExperienceProps) {
  if (document.edges.length === 0) {
    return <p className={HELP}>No combinations yet. Every collocation edge carries the pair itself as its pattern.</p>;
  }
  return (
    <div className="space-y-4">
      <p className={HELP}>Words that naturally go together, by the shape of the combination.</p>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th className="py-1.5 font-medium">Kind</th>
            <th className="py-1.5 font-medium">Words</th>
            <th className="py-1.5 font-medium">Combination</th>
            <th className="py-1.5 font-medium">Note</th>
          </tr>
        </thead>
        <tbody>
          {document.edges.map((edge) => (
            <tr key={edge.id} className="border-b border-line/60 text-ink">
              <td className="py-2 pr-3 align-top text-xs text-muted">{MAP_EDGE_LABELS[edge.kind]}</td>
              <td className="py-2 pr-3 align-top">
                <WordChip node={nodeOf(document, edge.fromNodeId) as VocabMapNode} onOpenWord={onOpenWord} />{' '}
                +{' '}
                <WordChip node={nodeOf(document, edge.toNodeId) as VocabMapNode} onOpenWord={onOpenWord} />
              </td>
              <td className="py-2 pr-3 align-top font-medium">{edge.pattern === '' ? '—' : `“${edge.pattern}”`}</td>
              <td className="py-2 align-top text-muted">{edge.note === '' ? '—' : edge.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thematic: topic and subtopic islands, with the links across them
// ---------------------------------------------------------------------------

export function ThematicExperience({ document, onOpenWord }: ExperienceProps) {
  const groups = new Map<string, VocabMapNode[]>();
  for (const node of document.nodes) {
    const key = node.group ?? '';
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const subtopics = document.edges.filter((edge) => edge.kind === 'subtopic');
  const crossTopic = document.edges.filter((edge) => {
    const from = nodeOf(document, edge.fromNodeId);
    const to = nodeOf(document, edge.toNodeId);
    return from !== undefined && to !== undefined && (from.group ?? '') !== (to.group ?? '');
  });
  return (
    <div className="space-y-4">
      <p className={HELP}>Vocabulary grouped by topic. Words linked across topics are listed at the end.</p>
      {keys.map((key) => (
        <section key={key === '' ? '__none' : key}>
          <h3 className={SECTION_TITLE}>{key === '' ? 'No single topic' : key}</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {(groups.get(key) ?? []).map((node) => (
              <WordChip key={node.id} node={node} onOpenWord={onOpenWord} />
            ))}
          </div>
        </section>
      ))}
      {subtopics.length > 0 ? (
        <section>
          <h3 className={SECTION_TITLE}>Topics and their parts</h3>
          <ul className="mt-2 space-y-1">
            {subtopics.map((edge) => (
              <EdgeSentence key={edge.id} document={document} edge={edge} />
            ))}
          </ul>
        </section>
      ) : null}
      {crossTopic.length > 0 ? (
        <section>
          <h3 className={SECTION_TITLE}>Across topics</h3>
          <ul className="mt-2 space-y-1">
            {crossTopic.map((edge) => (
              <EdgeSentence key={edge.id} document={document} edge={edge} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nuance & contrast: close expressions side by side, with the difference
// ---------------------------------------------------------------------------

export function NuanceExperience({ document, onOpenWord }: ExperienceProps) {
  const contrasts = document.edges.filter((edge) => edge.kind === 'contrast');
  const associated = document.edges.filter((edge) => edge.kind !== 'contrast');
  if (contrasts.length === 0) {
    return (
      <p className={HELP}>
        No comparisons yet. A contrast needs both words and a note saying what the difference is — register, intensity,
        connotation or usage.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <p className={HELP}>Close expressions, side by side. The line between them is the actual difference.</p>
      {contrasts.map((edge) => {
        const from = nodeOf(document, edge.fromNodeId);
        const to = nodeOf(document, edge.toNodeId);
        if (from === undefined || to === undefined) return null;
        return (
          <section key={edge.id} className={CARD_SOFT}>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
              <NuanceWord node={from} onOpenWord={onOpenWord} />
              <div className="flex max-w-40 flex-col items-center justify-center gap-1 text-center">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">differs in</span>
                <p className="text-sm font-medium text-ink">{edge.note === '' ? MAP_EDGE_LABELS.contrast : edge.note}</p>
              </div>
              <NuanceWord node={to} onOpenWord={onOpenWord} />
            </div>
          </section>
        );
      })}
      {associated.length > 0 ? (
        <section>
          <h3 className={SECTION_TITLE}>Merely associated</h3>
          <ul className="mt-2 space-y-1">
            {associated.map((edge) => (
              <EdgeSentence key={edge.id} document={document} edge={edge} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const CARD_SOFT = 'rounded-2xl border border-line bg-paper/60 p-4';

function NuanceWord({
  node,
  onOpenWord,
}: {
  node: VocabMapNode;
  onOpenWord?: (vocabularyId: string) => void;
}) {
  return (
    <div>
      <WordChip node={node} onOpenWord={onOpenWord} />
      <p className="mt-2 text-sm text-muted">{node.word?.meaning ?? 'No meaning on file yet.'}</p>
      {node.note === '' ? null : <p className={HELP}>Usage note: {node.note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenario: one situation, walked through in order
// ---------------------------------------------------------------------------

export function ScenarioExperience({ document, onOpenWord }: ExperienceProps) {
  const steps = [...document.nodes].sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || nodeLabel(a).localeCompare(nodeLabel(b)));
  if (steps.length === 0) return <p className={HELP}>No steps yet. Each node added to a scenario takes the next step.</p>;
  return (
    <div className="space-y-4">
      <p className={HELP}>The situation in order, from the first step to the last. Steps can be reordered from the map below.</p>
      <ol className="space-y-3">
        {steps.map((node, index) => (
          <li key={node.id} className="flex gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-white dark:text-paper"
            >
              {node.step ?? index + 1}
            </span>
            <div>
              <WordChip node={node} onOpenWord={onOpenWord} />
              {node.group === null ? null : <span className="ml-2 text-xs text-muted">{node.group}</span>}
              {node.note === '' ? null : <p className="mt-1 text-sm text-muted">{node.note}</p>}
            </div>
          </li>
        ))}
      </ol>
      <section>
        <h3 className={SECTION_TITLE}>The order of the steps</h3>
        <ul className="mt-2 space-y-1">
          {document.edges
            .filter((edge) => edge.kind === 'step')
            .map((edge) => (
              <EdgeSentence key={edge.id} document={document} edge={edge} />
            ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Communicative function: phrases grouped by what the speaker is doing
// ---------------------------------------------------------------------------

export function FunctionExperience({ document, onOpenWord }: ExperienceProps) {
  const intentions = new Map<string, VocabMapNode[]>();
  for (const node of document.nodes) {
    const key = node.group ?? 'General';
    const list = intentions.get(key) ?? [];
    list.push(node);
    intentions.set(key, list);
  }
  const variantsOf = (nodeId: string) =>
    document.edges.filter((edge) => edge.kind === 'phrase_variant' && (edge.fromNodeId === nodeId || edge.toNodeId === nodeId));
  return (
    <div className="space-y-4">
      <p className={HELP}>Phrases grouped by what the speaker wants to do. Alternatives to the same phrase are listed with it.</p>
      {[...intentions.keys()].sort().map((intention) => (
        <section key={intention}>
          <h3 className={SECTION_TITLE}>{intention}</h3>
          <ul className="mt-2 space-y-2">
            {(intentions.get(intention) ?? []).map((node) => (
              <li key={node.id} className={CARD_SOFT}>
                <WordChip node={node} onOpenWord={onOpenWord} />
                {node.note === '' ? null : <p className="mt-1 text-sm text-muted">{node.note}</p>}
                {variantsOf(node.id).map((edge) => {
                  const otherId = edge.fromNodeId === node.id ? edge.toNodeId : edge.fromNodeId;
                  const other = nodeOf(document, otherId);
                  return other === undefined ? null : (
                    <p key={edge.id} className="mt-1 text-xs text-muted">
                      also: {nodeLabel(other)}
                    </p>
                  );
                })}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Personal knowledge: what the account already has, drawn live
// ---------------------------------------------------------------------------

export interface PersonalExperienceProps extends ExperienceProps {
  stats: { words: number; maps: number; collections: number; relations: number; senses: number };
}

export function PersonalExperience({ document, stats, onOpenWord }: PersonalExperienceProps) {
  const groups = new Map<string, VocabMapNode[]>();
  for (const node of document.nodes) {
    const key = node.group ?? 'Not in a collection';
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(
          [
            ['Words', stats.words],
            ['Maps', stats.maps],
            ['Collections', stats.collections],
            ['Relationships', stats.relations],
            ['Meanings recorded', stats.senses],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className={CARD_SOFT}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="font-serif text-2xl font-semibold text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <p className={HELP}>{document.description}</p>
      {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, nodes]) => (
        <section key={key}>
          <h3 className={SECTION_TITLE}>{key}</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {nodes.map((node) => (
              <WordChip key={node.id} node={node} onOpenWord={onOpenWord} />
            ))}
          </div>
        </section>
      ))}
      <section>
        <h3 className={SECTION_TITLE}>Saved relationships</h3>
        {document.edges.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing is linked yet. Relationships you save in the Library appear here.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {document.edges.map((edge) => (
              <EdgeSentence key={edge.id} document={document} edge={edge} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One switch the detail page uses
// ---------------------------------------------------------------------------

export function MapExperience(props: ExperienceProps & { stats?: PersonalExperienceProps['stats'] }) {
  const { document } = props;
  switch (document.type) {
    case 'semantic':
      return <SemanticExperience {...props} />;
    case 'word_family':
      return <WordFamilyExperience {...props} />;
    case 'collocation':
      return <CollocationExperience {...props} />;
    case 'thematic':
      return <ThematicExperience {...props} />;
    case 'nuance':
      return <NuanceExperience {...props} />;
    case 'scenario':
      return <ScenarioExperience {...props} />;
    case 'function':
      return <FunctionExperience {...props} />;
    case 'personal':
      return <PersonalExperience {...props} stats={props.stats ?? { words: 0, maps: 0, collections: 0, relations: 0, senses: 0 }} />;
  }
}

export { WordChip, EdgeSentence, nodeOf, labelIn };
