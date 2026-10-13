/**
 * The word's connections drawn as a small bubble diagram: the word at the
 * centre, one bubble per related word or collection-mate around it. Only what
 * the owner already entered is shown — their own relations and their own
 * collections — and the ring is placed with plain trigonometry rather than a
 * force simulation. These graphs are personal and small (a handful to thirty
 * words), so a hand-rolled drawing keeps the bundle and the behaviour simple.
 */
import { useId } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { RELATION_LABELS, otherEnd, type Collection, type Relation } from '../../shared/library.js';
import { openWord } from '../lib/router.js';

/** The ring stops here; past it the drawing says how many words were left out. */
const MAX_NODES = 30;
/** Spokes are labelled only while there is room to read them all. */
const MAX_LABELLED_EDGES = 8;
/** The drawing's own units: it scales to the panel, which is about 410px wide. */
const WIDTH = 440;
const HEIGHT = 300;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const NODE_FONT = 11;
const EDGE_FONT = 10;
/** The same section heading style the rest of the word detail uses. */
const HEADING = 'text-xs font-medium uppercase tracking-[0.12em] text-muted';

/** One connected word: a single bubble carrying every reason it is connected. */
interface GraphNode {
  id: string;
  word: string;
  /** Relation kinds and collection names, in the order they were found. */
  labels: string[];
}

/** Trims text to what the drawing has room for; the text summary keeps it whole. */
function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Every word connected to the focus word, deduplicated: a word that is both a
 * relation and a collection-mate is one bubble carrying both labels. Words no
 * longer in the vocabulary are skipped, as the Related words list does.
 */
function connectedTo(
  focusId: string,
  relations: Relation[],
  collections: Collection[],
  words: Array<Pick<VocabularyEntry, 'id' | 'word'>>,
): { focus: string; nodes: GraphNode[] } {
  const names = new Map(words.map((item) => [item.id, item.word]));
  const byId = new Map<string, GraphNode>();
  const add = (id: string, label: string) => {
    if (id === focusId || !names.has(id)) return;
    const found = byId.get(id);
    if (found === undefined) byId.set(id, { id, word: names.get(id) ?? id, labels: [label] });
    else if (!found.labels.includes(label)) found.labels.push(label);
  };
  for (const relation of relations) {
    const other = otherEnd(relation, focusId);
    if (other !== null) add(other, RELATION_LABELS[relation.kind]);
  }
  for (const collection of collections) {
    if (!collection.wordIds.includes(focusId)) continue;
    for (const id of collection.wordIds) add(id, collection.name);
  }
  // Alphabetical, so the same data always draws the same picture.
  const nodes = [...byId.values()].sort((left, right) => left.word.localeCompare(right.word));
  return { focus: names.get(focusId) ?? '', nodes };
}

export interface SemanticGraphProps {
  /** The word at the centre of the diagram. */
  focusId: string;
  relations: Relation[];
  collections: Collection[];
  /** The vocabulary, to give every id its word; ids missing from it are skipped. */
  words: Array<Pick<VocabularyEntry, 'id' | 'word'>>;
}

export function SemanticGraph({ focusId, relations, collections, words }: SemanticGraphProps) {
  const headingId = useId();
  const { focus, nodes } = connectedTo(focusId, relations, collections, words);
  const shown = nodes.slice(0, MAX_NODES);
  const hidden = nodes.length - shown.length;
  const focusWord = focus === '' ? 'this word' : focus;

  // With nothing to draw, say so in a line: an empty ring would claim a structure that is not there.
  if (nodes.length === 0) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 id={headingId} className={HEADING}>
          Connections
        </h3>
        <p className="text-sm text-muted">No connections yet — link words from this word's detail.</p>
      </section>
    );
  }

  const count = shown.length;
  // The ring opens up as bubbles are added so that neighbours never touch.
  const rx = count <= 6 ? 100 : count <= 12 ? 120 : count <= 20 ? 132 : 140;
  const ry = count <= 6 ? 92 : count <= 12 ? 100 : 108;
  const bubble = count <= 12 ? 10 : 9;
  // Words sit beside their bubble, away from the centre, so they are trimmed to the room
  // at the ring's widest point: half the width, minus the ring, the bubble and its gap.
  const wordChars = Math.max(6, Math.min(12, Math.floor((210 - rx - bubble) / (NODE_FONT * 0.55))));
  const labelled = count <= MAX_LABELLED_EDGES;
  const focusWidth = Math.min(150, Math.max(56, Math.round(focusWord.length * 7.2) + 26));

  const points = shown.map((node, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = CX + rx * cos;
    const y = CY + ry * sin;
    // Side bubbles take a horizontal label; the few near the top and bottom have room
    // above and below instead. In a dense ring those alternate sides, so two words
    // lying on the same line never push their labels onto one another.
    const side = cos >= 0.25 ? 1 : cos <= -0.25 ? -1 : 0;
    const swapped = count > 12 && index % 2 === 1;
    const away = sin < 0 ? -1 : 1;
    const anchor: 'start' | 'middle' | 'end' = side === 0 ? 'middle' : side > 0 ? 'start' : 'end';
    return {
      node,
      x,
      y,
      labelX: side === 0 ? x : x + side * (bubble + 6),
      labelY: side === 0 ? y + (swapped ? -away : away) * (swapped ? 24 : 16) : y,
      anchor,
      // Three quarters out: clear of the centre bubble, still inside the ring.
      edgeX: CX + (x - CX) * 0.75,
      edgeY: CY + (y - CY) * 0.75,
    };
  });

  // The picture carries all of this in words for a screen reader, in full.
  const summary =
    `Connections for ${focusWord}: ${nodes.map((node) => `${node.word} (${node.labels.join(', ')})`).join('; ')}.` +
    (hidden > 0 ? ` ${count} of ${nodes.length} shown.` : '');

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id={headingId} className={HEADING}>
        Connections
      </h3>
      <p className="sr-only">{summary}</p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full">
        <g aria-hidden="true">
          {points.map((point) => (
            <line
              key={point.node.id}
              x1={CX}
              y1={CY}
              x2={point.x}
              y2={point.y}
              strokeWidth={1.5}
              className="stroke-muted/60"
            />
          ))}
        </g>
        {points.map((point) => (
          <g
            key={point.node.id}
            role="button"
            tabIndex={0}
            aria-label={point.node.word}
            className="group cursor-pointer"
            onClick={() => openWord(point.node.id)}
            onKeyDown={(event) => {
              // Enter and Space are what a keyboard offers a button.
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openWord(point.node.id);
              }
            }}
          >
            <circle
              cx={point.x}
              cy={point.y}
              r={bubble}
              strokeWidth={1.5}
              className="fill-surface stroke-line transition-colors group-hover:fill-accent-soft"
            />
            <text
              x={point.labelX}
              y={point.labelY}
              textAnchor={point.anchor}
              dominantBaseline="central"
              fontSize={NODE_FONT}
              paintOrder="stroke"
              strokeWidth={3}
              className="fill-ink stroke-paper"
            >
              {fit(point.node.word, wordChars)}
            </text>
          </g>
        ))}
        {/* The centre is the word already open, so it is drawn but not read out again. */}
        <g aria-hidden="true">
          <rect
            x={CX - focusWidth / 2}
            y={CY - 18}
            width={focusWidth}
            height={36}
            rx={12}
            strokeWidth={1.5}
            className="fill-accent-soft stroke-accent"
          />
          <text
            x={CX}
            y={CY}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={13}
            className="fill-ink font-medium"
          >
            {fit(focusWord, 17)}
          </text>
          {labelled &&
            points.map((point) => (
              <text
                key={point.node.id}
                x={point.edgeX}
                y={point.edgeY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={EDGE_FONT}
                paintOrder="stroke"
                strokeWidth={3}
                className="fill-muted stroke-paper"
              >
                {fit(point.node.labels.join(', '), 20)}
              </text>
            ))}
        </g>
      </svg>
      {hidden > 0 && <p className="text-xs text-muted">+{hidden} more not shown.</p>}
    </section>
  );
}
