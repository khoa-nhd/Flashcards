/**
 * The account's vocabulary drawn three ways: the collections the reader
 * grouped it into, the families words share through their root, and the
 * links saved between words. Nothing is inferred — only what was entered is
 * drawn — and everything is placed with plain arithmetic rather than a force
 * simulation, the same as the connection diagram in a word's panel, so the
 * bundle and the behaviour stay simple. Every word opens its panel the way
 * the bank opens it, and the whole picture is repeated in words for a screen
 * reader: the drawing is never the only copy of what it shows.
 */
import type { VocabularyEntry } from '../../shared/api.js';
import { RELATION_KINDS, RELATION_LABELS, type Collection, type Relation, type RelationKind } from '../../shared/library.js';
import { count } from '../lib/format.js';
import { ROUTES, openWord } from '../lib/router.js';
import { Link } from './Link.js';

/** What one drawing may show; past it the picture says how much was left out. */
const MAX_ISLANDS = 12;
const MAX_ISLAND_WORDS = 12;
const MAX_LINKED_NODES = 60;

/** The drawing's own units: every canvas is 900 wide and scales to the page. */
const CANVAS = 900;
const ISLAND_W = 280;
const ISLAND_GAP = 20;
const ISLAND_PAD = 14;
const ISLAND_COLS = 3;
const HEADER_H = 36;
const CELL_H = 26;
const FONT = 12;
const TITLE_FONT = 13;
const LINK_COLS_MAX = 6;
const LINK_CELL_H = 36;
const LINK_PAD = 12;
const NODE_W = 130;
const NODE_H = 26;

const EMPTY_TEXT = 'text-sm text-muted';

/** How each kind of link counts in a line of totals: short, and in the plural. */
const KIND_COUNTS: Record<RelationKind, [one: string, many: string]> = {
  synonym: ['synonym', 'synonyms'],
  antonym: ['antonym', 'antonyms'],
  word_family: ['word family', 'word families'],
  collocation: ['collocation', 'collocations'],
  related: ['related word', 'related words'],
  confused: ['often confused pair', 'often confused pairs'],
};

/** Trims text to what the drawing has room for; the text summary keeps it whole. */
function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** The width available to the text inside one island column. */
const cellChars = (width: number) => Math.max(4, Math.floor((width - 6) / (FONT * 0.55)));

/** A word as a pressable label: Enter and Space are what a keyboard offers. */
function PressableText({
  word,
  x,
  y,
  chars,
  anchor = 'middle',
  accent = false,
}: {
  word: { id: string; word: string };
  x: number;
  y: number;
  chars: number;
  anchor?: 'start' | 'middle';
  accent?: boolean;
}) {
  const open = () => openWord(word.id);
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={word.word}
      className="group cursor-pointer"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <text
        x={x}
        y={y}
        textAnchor={anchor}
        dominantBaseline="central"
        fontSize={FONT}
        paintOrder="stroke"
        strokeWidth={3}
        className={
          accent
            ? 'fill-accent stroke-paper font-medium underline decoration-transparent group-hover:decoration-current'
            : 'fill-ink stroke-paper underline decoration-transparent group-hover:decoration-current'
        }
      >
        {fit(word.word, chars)}
      </text>
    </g>
  );
}

/** One island of words: a labelled area with its words in rows inside. */
interface Island {
  id: string;
  /** The island's title: a collection name, or the root word of a family. */
  label: string;
  /** Beside the title: how many words the island holds, whole and uncapped. */
  note: string;
  /** When the title is itself a word (a family root), pressing it opens that word. */
  labelId?: string;
  words: Array<{ id: string; word: string; accent?: boolean }>;
}

/** Lays the islands out three to a row: fixed arithmetic, the same data the same picture. */
function islandCells(islands: Island[]) {
  const shown = islands.slice(0, MAX_ISLANDS).map((island, index) => {
    const words = island.words.slice(0, MAX_ISLAND_WORDS);
    const rows = Math.max(1, Math.ceil(words.length / ISLAND_COLS));
    return {
      island,
      words,
      row: Math.floor(index / ISLAND_COLS),
      x: ISLAND_GAP / 2 + (index % ISLAND_COLS) * (ISLAND_W + ISLAND_GAP),
      height: HEADER_H + rows * CELL_H + ISLAND_PAD / 2,
    };
  });
  // Each row starts below the tallest island above it.
  const tops = new Map<number, number>();
  let next = ISLAND_GAP / 2;
  const lastRow = shown.reduce((last, cell) => Math.max(last, cell.row), 0);
  for (let row = 0; row <= lastRow; row += 1) {
    tops.set(row, next);
    const tallest = shown.filter((cell) => cell.row === row).reduce((max, cell) => Math.max(max, cell.height), 0);
    next += tallest + ISLAND_GAP;
  }
  return { cells: shown, tops, height: next };
}

/** The islands drawn, with their full text summary and their counts in words. */
function Islands({ islands, what, counts }: { islands: Island[]; what: string; counts: string }) {
  const { cells, tops, height } = islandCells(islands);
  const drawn = cells.reduce((total, cell) => total + cell.words.length, 0);
  const all = islands.reduce((total, island) => total + island.words.length, 0);
  const hidden = all - drawn;
  // The picture carries all of it in words for a screen reader, in full.
  const summary =
    `${what}: ${islands.map((island) => `${island.label} — ${island.words.map((word) => word.word).join(', ')}`).join('; ')}.` +
    (hidden > 0 ? ` ${drawn} of ${all} words shown.` : '');
  const chars = cellChars((ISLAND_W - 2 * ISLAND_PAD) / ISLAND_COLS);

  return (
    <section aria-label={what} className="flex flex-col gap-2">
      <p className="sr-only">{summary}</p>
      <svg viewBox={`0 0 ${CANVAS} ${height}`} className="h-auto w-full">
        {cells.map(({ island, words, x, row }) => {
          const top = tops.get(row) ?? 0;
          const islandHeight = HEADER_H + Math.max(1, Math.ceil(words.length / ISLAND_COLS)) * CELL_H + ISLAND_PAD / 2;
          const title = (
            <text x={x + ISLAND_PAD} y={top + 21} fontSize={TITLE_FONT} className="fill-ink font-medium">
              {fit(island.label, 24)}
            </text>
          );
          return (
            <g key={island.id}>
              <rect
                x={x}
                y={top}
                width={ISLAND_W}
                height={islandHeight}
                rx={14}
                strokeWidth={1.5}
                className="fill-line/30 stroke-line"
                aria-hidden="true"
              />
              <text x={x + ISLAND_W - ISLAND_PAD} y={top + 21} textAnchor="end" fontSize={11} className="fill-muted" aria-hidden="true">
                {island.note}
              </text>
              {island.labelId === undefined ? (
                <g aria-hidden="true">{title}</g>
              ) : (
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={island.label}
                  className="cursor-pointer"
                  onClick={() => openWord(island.labelId ?? '')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openWord(island.labelId ?? '');
                    }
                  }}
                >
                  <text x={x + ISLAND_PAD} y={top + 21} fontSize={TITLE_FONT} className="fill-accent font-medium">
                    {fit(island.label, 24)}
                  </text>
                </g>
              )}
              {words.map((word, index) => (
                <PressableText
                  key={word.id}
                  word={word}
                  x={x + ISLAND_PAD + (index % ISLAND_COLS) * ((ISLAND_W - 2 * ISLAND_PAD) / ISLAND_COLS) + (ISLAND_W - 2 * ISLAND_PAD) / ISLAND_COLS / 2}
                  y={top + HEADER_H + Math.floor(index / ISLAND_COLS) * CELL_H + CELL_H / 2}
                  chars={chars}
                  accent={word.accent === true}
                />
              ))}
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-muted">
        {counts}
        {hidden > 0 ? ` · +${hidden} more not shown.` : ''}
      </p>
    </section>
  );
}

const Empty = ({ text }: { text: string }) => <p className={EMPTY_TEXT}>{text}</p>;

/**
 * The collections as islands: each collection's words around its name, and
 * every word in no collection gathered under one plain island of its own —
 * so the map accounts for the whole vocabulary, not only the organised part.
 */
export function CollectionsMap({ entries, collections }: { entries: VocabularyEntry[]; collections: Collection[] }) {
  const live = new Map(entries.map((entry) => [entry.id, entry.word]));
  const byWord = (left: { word: string }, right: { word: string }) => left.word.localeCompare(right.word);
  const claimed = new Set<string>();
  const islands: Island[] = collections.map((collection) => {
    const words = collection.wordIds
      .filter((id) => live.has(id))
      .map((id) => ({ id, word: live.get(id) ?? id }))
      .sort(byWord);
    for (const word of words) claimed.add(word.id);
    return { id: collection.id, label: collection.name, note: count(words.length, 'word'), words };
  });
  const loose = entries
    .filter((entry) => !claimed.has(entry.id))
    .map((entry) => ({ id: entry.id, word: entry.word }))
    .sort(byWord);
  if (loose.length > 0) islands.push({ id: 'loose', label: 'No collection', note: count(loose.length, 'word'), words: loose });
  if (islands.length === 0) return <Empty text="No collections yet — group words from the Collections page." />;

  const counts = `${count(collections.length, 'collection')} · ${count(entries.length - loose.length, 'word')} grouped · ${count(
    loose.length,
    'word',
  )} without a collection`;
  return <Islands islands={islands} what="Collections map" counts={counts} />;
}

/**
 * Every stored word family: the root as a pressable island title, its
 * derived words inside, and a word that derived from a member accented as a
 * sub-root. A word with no root and nothing pointing at it is counted, not
 * drawn — a map of families is not a list of every word.
 */
export function FamiliesMap({ entries, rootsReady }: { entries: VocabularyEntry[]; rootsReady: boolean }) {
  if (!rootsReady) {
    return (
      <p className={EMPTY_TEXT}>
        Word families can be kept once the database has its latest update.{' '}
        <Link to={ROUTES.settings} className="font-medium text-accent hover:underline">
          See Settings
        </Link>
      </p>
    );
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  /** Words other words were formed from: drawn accented inside their own family. */
  const subRoots = new Set(entries.flatMap((entry) => (entry.rootId === null ? [] : [entry.rootId])));
  const groups = new Map<string, VocabularyEntry[]>();
  for (const entry of entries) {
    const key = entry.rootId ?? entry.id;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }

  const islands: Island[] = [];
  let alone = 0;
  for (const [key, group] of groups) {
    const root = byId.get(key);
    // One word on its own is a word on its own; a lone pointer at a removed
    // root still shows, so a family never vanishes silently behind the trash.
    const orphaned = group.length === 1 && group[0]!.rootId !== null;
    if (group.length < 2 && !orphaned) {
      alone += 1;
      continue;
    }
    const members = group.filter((entry) => entry.id !== key);
    islands.push({
      id: key,
      label: root?.word ?? 'A removed root',
      labelId: root?.id,
      note: count(members.length, 'word'),
      words: members.map((entry) => ({ id: entry.id, word: entry.word, accent: subRoots.has(entry.id) })),
    });
  }
  islands.sort((left, right) => left.label.localeCompare(right.label));
  if (islands.length === 0) return <Empty text="No word families yet — open a word and build its family from its panel." />;

  const counts = `${count(islands.length, 'family')} · ${count(alone, 'word')} not in a family`;
  return <Islands islands={islands} what="Word families map" counts={counts} />;
}

/**
 * The saved relations as a network: words in a grid, links drawn between
 * them as curves, placed by arithmetic over the alphabet — readable at any
 * size and always the same picture for the same links.
 */
export function RelationsMap({ entries, relations }: { entries: VocabularyEntry[]; relations: Relation[] }) {
  const live = new Map(entries.map((entry) => [entry.id, entry.word]));
  const byWord = (left: { word: string }, right: { word: string }) => left.word.localeCompare(right.word);
  const edges = relations.filter((relation) => live.has(relation.a) && live.has(relation.b));
  const linked = new Set(edges.flatMap((relation) => [relation.a, relation.b]));
  const nodes = [...linked]
    .map((id) => ({ id, word: live.get(id) ?? id }))
    .sort(byWord);
  if (nodes.length === 0) return <Empty text="No related words yet — link words from a word's detail." />;

  const shown = nodes.slice(0, MAX_LINKED_NODES);
  const shownIds = new Set(shown.map((node) => node.id));
  const shownEdges = edges.filter((relation) => shownIds.has(relation.a) && shownIds.has(relation.b));
  const columns = Math.min(LINK_COLS_MAX, Math.max(1, Math.ceil(Math.sqrt(shown.length * 1.8))));
  const rows = Math.ceil(shown.length / columns);
  const cellW = (CANVAS - 2 * LINK_PAD) / columns;
  const nodeW = Math.min(NODE_W, cellW - 12);
  const centerOf = (index: number) => ({
    x: LINK_PAD + (index % columns) * cellW + cellW / 2,
    y: LINK_PAD + Math.floor(index / columns) * LINK_CELL_H + LINK_CELL_H / 2,
  });
  const centers = shown.map((_, index) => centerOf(index));
  const index = new Map(shown.map((node, position) => [node.id, position]));
  const wordOf = (id: string) => live.get(id) ?? id;

  const hidden = nodes.length - shown.length;
  const summary =
    `Relations map: ${edges
      .map((relation) => `${wordOf(relation.a)} — ${wordOf(relation.b)} (${RELATION_LABELS[relation.kind]})`)
      .join('; ')}.` + (hidden > 0 ? ` ${shown.length} of ${nodes.length} words shown.` : '');
  const kinds = RELATION_KINDS.map((kind) => ({ kind, number: edges.filter((relation) => relation.kind === kind).length })).filter(
    (item) => item.number > 0,
  );
  const counts =
    `${count(edges.length, 'relation')} across ${count(nodes.length, 'word')}` +
    (kinds.length > 0 ? ` (${kinds.map((item) => count(item.number, ...KIND_COUNTS[item.kind])).join(', ')})` : '');
  const nodeChars = Math.max(4, Math.floor((nodeW - 14) / (FONT * 0.55)));

  return (
    <section aria-label="Relations map" className="flex flex-col gap-2">
      <p className="sr-only">{summary}</p>
      <svg viewBox={`0 0 ${CANVAS} ${rows * LINK_CELL_H + 2 * LINK_PAD}`} className="h-auto w-full">
        {/* The links first, so no line is drawn over the words it joins. */}
        <g aria-hidden="true">
          {shownEdges.map((relation) => {
            const from = centers[index.get(relation.a) ?? 0]!;
            const to = centers[index.get(relation.b) ?? 0]!;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length = Math.hypot(dx, dy) || 1;
            // Curved a little to one side, so two links rarely sit on top of each other.
            const bend = Math.min(40, length * 0.15);
            const midX = (from.x + to.x) / 2 + (-dy / length) * bend;
            const midY = (from.y + to.y) / 2 + (dx / length) * bend;
            return (
              <path
                key={relation.id}
                d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
                fill="none"
                strokeWidth={1.5}
                className="stroke-muted/50"
              />
            );
          })}
        </g>
        {shown.map((node, position) => {
          const { x, y } = centers[position]!;
          const open = () => openWord(node.id);
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={node.word}
              className="group cursor-pointer"
              onClick={open}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  open();
                }
              }}
            >
              <rect
                x={x - nodeW / 2}
                y={y - NODE_H / 2}
                width={nodeW}
                height={NODE_H}
                rx={10}
                strokeWidth={1.5}
                className="fill-line/40 stroke-line group-hover:stroke-muted"
              />
              <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={FONT} className="fill-ink">
                {fit(node.word, nodeChars)}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-muted">
        {counts}
        {hidden > 0 ? ` · +${hidden} more not shown.` : ''}
      </p>
    </section>
  );
}
