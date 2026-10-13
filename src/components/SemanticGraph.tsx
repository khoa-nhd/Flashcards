/**
 * The word's connections drawn as a mind map: the word at the centre, one
 * labelled branch per reason (each relation kind, each collection), and the
 * connected words hanging off their branch. The branches split left and right
 * of the centre and the leaves curve out from their chip, the way a hand-drawn
 * map grows — placed with plain arithmetic rather than a force simulation.
 * Only what the owner already entered is shown, and everything is drawn by
 * hand so the bundle and the behaviour stay simple.
 */
import { useId } from 'react';
import type { VocabularyEntry } from '../../shared/api.js';
import { RELATION_LABELS, otherEnd, type Collection, type Relation } from '../../shared/library.js';
import { openWord } from '../lib/router.js';

/** The map stops here; past it the drawing says how many words were left out. */
const MAX_NODES = 30;
/** The drawing's own units: it scales to the panel, which is about 410px wide. */
const WIDTH = 520;
const MIN_HEIGHT = 300;
const CX = WIDTH / 2;
/** How far out from the centre a branch chip sits, and where its words begin. */
const KIND_X = 100;
const LEAF_X = 150;
/** One word per row; the map grows taller, never wider. */
const ROW = 22;
const NODE_FONT = 12;
const KIND_FONT = 11;
/** The same section heading style the rest of the word detail uses. */
const HEADING = 'text-xs font-medium uppercase tracking-[0.12em] text-muted';

/** One connected word: it may carry several reasons, shown under the first one found. */
interface GraphNode {
  id: string;
  word: string;
  /** Relation kinds and collection names, in the order they were found. */
  labels: string[];
}

/** One branch of the map: a labelled chip with its words. */
interface Branch {
  label: string;
  leaves: GraphNode[];
}

/** Trims text to what the drawing has room for; the text summary keeps it whole. */
function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Every word connected to the focus word, deduplicated: a word that is both a
 * relation and a collection-mate is one leaf under the first reason found, and
 * carries both in its labels for the text summary. Words no longer in the
 * vocabulary are skipped, as the Related words list does.
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

/** Groups the leaves under their first label, in the order the labels were found. */
function branchesOf(nodes: GraphNode[]): Branch[] {
  const byLabel = new Map<string, Branch>();
  for (const node of nodes) {
    const label = node.labels[0] ?? '';
    const found = byLabel.get(label);
    if (found === undefined) byLabel.set(label, { label, leaves: [node] });
    else found.leaves.push(node);
  }
  return [...byLabel.values()];
}

/**
 * Splits the branches between the two sides, keeping the sides about the same
 * height: each branch in turn joins whichever side is currently the shorter.
 */
function sidesOf(branches: Branch[]): { left: Branch[]; right: Branch[] } {
  const left: Branch[] = [];
  const right: Branch[] = [];
  let leftRows = 0;
  let rightRows = 0;
  for (const branch of branches) {
    if (leftRows <= rightRows) {
      left.push(branch);
      leftRows += branch.leaves.length;
    } else {
      right.push(branch);
      rightRows += branch.leaves.length;
    }
  }
  return { left, right };
}

export interface SemanticGraphProps {
  /** The word at the centre of the map. */
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

  // With nothing to draw, say so in a line: an empty map would claim a structure that is not there.
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

  const { left, right } = sidesOf(branchesOf(shown));
  const rows = (side: Branch[]) => side.reduce((total, branch) => total + branch.leaves.length, 0);
  const height = Math.max(MIN_HEIGHT, Math.max(rows(left), rows(right)) * ROW + 60);
  const cy = height / 2;
  // Words begin just past their chip and keep the room out to the edge of the drawing.
  const wordChars = Math.max(6, Math.floor((WIDTH / 2 - LEAF_X - 8) / (NODE_FONT * 0.55)));

  // The picture carries all of this in words for a screen reader, in full.
  const summary =
    `Connections for ${focusWord}: ${nodes.map((node) => `${node.word} (${node.labels.join(', ')})`).join('; ')}.` +
    (hidden > 0 ? ` ${shown.length} of ${nodes.length} shown.` : '');

  /** Lays one side out: branches stacked from the vertical centre, leaves within. */
  const layout = (side: Branch[], sign: 1 | -1) => {
    let y = cy - (rows(side) * ROW) / 2;
    return side.map((branch) => {
      const firstY = y;
      const leaves = branch.leaves.map((leaf) => {
        const leafY = y + ROW / 2;
        y += ROW;
        return { leaf, y: leafY };
      });
      const chipY = (firstY + y) / 2;
      return { branch, sign, chipY, leaves };
    });
  };

  const sides = [
    { branches: layout(left, -1), sign: -1 as const },
    { branches: layout(right, 1), sign: 1 as const },
  ];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id={headingId} className={HEADING}>
        Connections
      </h3>
      <p className="sr-only">{summary}</p>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} className="h-auto w-full">
        {sides.map(({ branches, sign }) =>
          branches.map(({ branch, chipY, leaves }) => {
            const chipX = CX + sign * KIND_X;
            const chipHalf = Math.min(72, branch.label.length * 5.6 + 12);
            const leafX = CX + sign * LEAF_X;
            return (
              <g key={branch.label}>
                <g aria-hidden="true">
                  <line x1={CX + sign * 60} y1={cy} x2={chipX - sign * chipHalf} y2={chipY} strokeWidth={1.5} className="stroke-muted/60" />
                  <rect
                    x={chipX - chipHalf}
                    y={chipY - 10}
                    width={chipHalf * 2}
                    height={20}
                    rx={10}
                    strokeWidth={1.5}
                    className="fill-line/50 stroke-line"
                  />
                  <text x={chipX} y={chipY} textAnchor="middle" dominantBaseline="central" fontSize={KIND_FONT} className="fill-muted">
                    {fit(branch.label, 16)}
                  </text>
                  {leaves.map(({ leaf, y }) => (
                    <path
                      key={`edge-${leaf.id}`}
                      // Curved, so a branch fans out the way a drawn one does.
                      d={`M ${chipX + sign * chipHalf} ${chipY} Q ${CX + sign * (KIND_X + LEAF_X) / 2} ${y} ${leafX - sign * 8} ${y}`}
                      fill="none"
                      strokeWidth={1.5}
                      className="stroke-muted/50"
                    />
                  ))}
                </g>
                {leaves.map(({ leaf, y }) => (
                  <g
                    key={leaf.id}
                    role="button"
                    tabIndex={0}
                    aria-label={leaf.word}
                    className="group cursor-pointer"
                    onClick={() => openWord(leaf.id)}
                    onKeyDown={(event) => {
                      // Enter and Space are what a keyboard offers a button.
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openWord(leaf.id);
                      }
                    }}
                  >
                    <text
                      x={leafX}
                      y={y}
                      textAnchor={sign > 0 ? 'start' : 'end'}
                      dominantBaseline="central"
                      fontSize={NODE_FONT}
                      paintOrder="stroke"
                      strokeWidth={3}
                      className="fill-ink stroke-paper underline decoration-transparent group-hover:decoration-current"
                    >
                      {fit(leaf.word, wordChars)}
                    </text>
                  </g>
                ))}
              </g>
            );
          }),
        )}
        {/* The centre is the word already open, so it is drawn but not read out again. */}
        <g aria-hidden="true">
          <rect
            x={CX - 60}
            y={cy - 18}
            width={120}
            height={36}
            rx={12}
            strokeWidth={1.5}
            className="fill-accent-soft stroke-accent"
          />
          <text x={CX} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={13} className="fill-ink font-medium">
            {fit(focusWord, 15)}
          </text>
        </g>
      </svg>
      {hidden > 0 && <p className="text-xs text-muted">+{hidden} more not shown.</p>}
    </section>
  );
}
