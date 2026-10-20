/**
 * One canvas, drawn with plain SVG and arithmetic — no visualisation library.
 * It draws whatever a map holds: saved words by the text they have right now,
 * suggestions with a dashed edge and a chip so the two can never be confused.
 * Stored positions win; anything the learner has not moved is placed by group,
 * so a map is legible the moment it opens.
 *
 * Pointer users can drag a node somewhere else; the page is told where it
 * landed and saves the layout. The keyboard reaches every node through the
 * list the page repeats below the drawing (the drawing is never the only copy
 * of what it shows), and each node here is also focusable: Enter selects.
 */
import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MAP_EDGE_LABELS, type VocabMapDocument, type VocabMapEdge, type VocabMapNode } from '../../../shared/vocab-map.js';
import { CARD, HELP } from '../ui.js';

/** The drawing's own units; the SVG scales to the page around them. */
export const NODE_W = 150;
export const NODE_H = 56;
const GROUP_GAP_X = 36;
const GROUP_GAP_Y = 18;
const GROUPS_PER_ROW = 4;
const EDGE_PAD = 26;

/** What a node reads as: its own word, or the suggestion's text. */
export function nodeLabel(node: VocabMapNode): string {
  if (node.kind === 'candidate') return node.label ?? '';
  return node.word?.word ?? node.label ?? '(word)';
}

/** Where each node sits: its stored place, or an arithmetic one by group. */
export function layoutNodes(nodes: readonly VocabMapNode[]): Record<string, { x: number; y: number }> {
  const groups = new Map<string, VocabMapNode[]>();
  for (const node of nodes) {
    const key = node.group ?? '';
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const placed: Record<string, { x: number; y: number }> = {};
  let x = 0;
  let y = 0;
  let columnHeight = 0;
  let inRow = 0;
  for (const key of keys) {
    const sorted = [...(groups.get(key) ?? [])];
    // A scenario reads in the order of its steps; anything else in its spelling.
    if (sorted.length > 0 && sorted.every((node) => node.step !== null)) {
      sorted.sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || nodeLabel(a).localeCompare(nodeLabel(b)));
    } else {
      sorted.sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b)));
    }
    sorted.forEach((node, index) => {
      placed[node.id] = { x, y: y + index * (NODE_H + GROUP_GAP_Y) };
    });
    columnHeight = Math.max(columnHeight, sorted.length * (NODE_H + GROUP_GAP_Y));
    x += NODE_W + GROUP_GAP_X;
    inRow += 1;
    if (inRow === GROUPS_PER_ROW) {
      inRow = 0;
      x = 0;
      y += columnHeight + GROUP_GAP_X;
      columnHeight = 0;
    }
  }
  return placed;
}

/** Big enough for everything placed, with a little room around the edge. */
function canvasSize(positions: Record<string, { x: number; y: number }>): { w: number; h: number } {
  let w = 640;
  let h = 320;
  for (const position of Object.values(positions)) {
    w = Math.max(w, position.x + NODE_W + EDGE_PAD);
    h = Math.max(h, position.y + NODE_H + EDGE_PAD);
  }
  return { w, h };
}

export interface MapCanvasProps {
  document: VocabMapDocument;
  /** The node whose actions are showing, if one is chosen. */
  selectedId?: string | null;
  onSelect?: (nodeId: string | null) => void;
  /** Where the learner left a node; the page saves it as the map's layout. */
  onMove?: (nodeId: string, x: number, y: number) => void;
}

export function MapCanvas({ document, selectedId = null, onSelect, onMove }: MapCanvasProps) {
  const arrowId = useId();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  /** Live position while a node is being dragged, before it is saved. */
  const [dragPos, setDragPos] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const drag = useRef<{
    nodeId: string | null;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const positions = useMemo(() => {
    const placed = layoutNodes(document.nodes);
    for (const node of document.nodes) {
      if (node.x !== null && node.y !== null) placed[node.id] = { x: node.x, y: node.y };
    }
    return placed;
  }, [document.nodes]);

  const size = useMemo(() => canvasSize(positions), [positions]);
  const viewBox = { x: pan.x, y: pan.y, w: size.w / zoom, h: size.h / zoom };

  const centerOf = (id: string): { x: number; y: number } | null => {
    const position = dragPos !== null && dragPos.nodeId === id ? dragPos : positions[id];
    return position === undefined ? null : { x: position.x + NODE_W / 2, y: position.y + NODE_H / 2 };
  };

  const startDrag = (event: ReactPointerEvent, node: VocabMapNode) => {
    if (onMove === undefined) return;
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    const position = positions[node.id] ?? { x: 0, y: 0 };
    drag.current = {
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
  };

  const moveDrag = (event: ReactPointerEvent) => {
    const current = drag.current;
    const svg = svgRef.current;
    if (current === null || svg === null) return;
    const rect = svg.getBoundingClientRect();
    const dx = ((event.clientX - current.startClientX) / rect.width) * viewBox.w;
    const dy = ((event.clientY - current.startClientY) / rect.height) * viewBox.h;
    if (!current.moved && Math.hypot(dx, dy) < 3) return;
    current.moved = true;
    if (current.nodeId !== null) {
      const clamp = (value: number) => Math.max(-2000, Math.min(2000, Math.round(value)));
      setDragPos({ nodeId: current.nodeId, x: clamp(current.originX + dx), y: clamp(current.originY + dy) });
    } else {
      setPan({ x: current.originX - dx, y: current.originY - dy });
    }
  };

  const endDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (current === null) return;
    if (current.nodeId !== null) {
      const position = dragPos;
      setDragPos(null);
      if (current.moved && position !== null) onMove?.(position.nodeId, position.x, position.y);
    }
  };

  const startPan = (event: ReactPointerEvent) => {
    if (event.target !== event.currentTarget) return;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.current = {
      nodeId: null,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: pan.x,
      originY: pan.y,
      moved: false,
    };
  };

  const step = zoom < 2 ? 0.25 : 0;
  const stepDown = zoom > 0.5 ? 0.25 : 0;

  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className={HELP}>
          {document.nodes.length === 0
            ? 'Nothing on the map yet.'
            : 'Drag a node to move it. Everything here is also listed below the drawing.'}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Zoom out"
            className="size-8 rounded-lg border border-line text-ink hover:border-muted disabled:opacity-50"
            disabled={stepDown === 0}
            onClick={() => setZoom((value) => Math.max(0.5, value - stepDown))}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            className="size-8 rounded-lg border border-line text-ink hover:border-muted disabled:opacity-50"
            disabled={step === 0}
            onClick={() => setZoom((value) => Math.min(2, value + step))}
          >
            +
          </button>
          <button
            type="button"
            className="h-8 rounded-lg border border-line px-2 text-xs font-medium text-ink hover:border-muted"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            Fit
          </button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="h-72 w-full touch-none bg-paper md:h-96"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Map drawing: ${document.nodes.length} items. A list of everything on the map follows the drawing.`}
        onPointerDown={startPan}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className="fill-muted" />
          </marker>
        </defs>
        {/* Relationships first, so the nodes cover where the lines meet. */}
        {document.edges.map((edge) => (
          <EdgeLine key={edge.id} edge={edge} centerOf={centerOf} arrowId={arrowId} />
        ))}
        {document.nodes.map((node) => {
          const position = dragPos !== null && dragPos.nodeId === node.id ? dragPos : positions[node.id] ?? { x: 0, y: 0 };
          const selected = node.id === selectedId;
          const label = nodeLabel(node);
          return (
            <g
              key={node.id}
              transform={`translate(${position.x} ${position.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${label}${node.kind === 'candidate' ? ' (suggestion, not a saved word)' : ''}`}
              aria-pressed={selected}
              className="cursor-pointer"
              onPointerDown={(event) => startDrag(event, node)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect?.(node.id);
                }
              }}
              onClick={() => onSelect?.(node.id)}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={12}
                className={
                  node.kind === 'candidate'
                    ? 'fill-surface stroke-accent'
                    : 'fill-surface stroke-line'
                }
                strokeWidth={selected ? 2.5 : 1.5}
                strokeDasharray={node.kind === 'candidate' ? '6 4' : undefined}
              />
              <text x={10} y={20} className="fill-ink text-[13px] font-semibold">
                {label.length > 20 ? `${label.slice(0, 19)}…` : label}
              </text>
              <text x={10} y={36} className="fill-muted text-[11px]">
                {node.kind === 'candidate'
                  ? 'Suggestion — not saved'
                  : (node.sense !== null ? `sense: ${node.sense.meaning ?? 'one meaning'}` : node.word?.meaning ?? '').slice(0, 26)}
              </text>
              {node.step !== null ? (
                <text x={NODE_W - 12} y={20} textAnchor="end" className="fill-accent text-[12px] font-bold">
                  {node.step}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** One relationship, with its kind (and pattern) written at the middle. */
function EdgeLine({
  edge,
  centerOf,
  arrowId,
}: {
  edge: VocabMapEdge;
  centerOf: (id: string) => { x: number; y: number } | null;
  arrowId: string;
}) {
  const from = centerOf(edge.fromNodeId);
  const to = centerOf(edge.toNodeId);
  if (from === null || to === null) return null;
  const text = edge.pattern === '' ? MAP_EDGE_LABELS[edge.kind] : `${MAP_EDGE_LABELS[edge.kind]} · ${edge.pattern}`;
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const width = Math.min(160, text.length * 6 + 12);
  const directed = edge.kind === 'step' || edge.kind === 'derivation' || edge.kind === 'hyponym' || edge.kind === 'hypernym';
  return (
    <g aria-hidden="true">
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        className="stroke-muted"
        strokeWidth={1.5}
        markerEnd={directed ? `url(#${arrowId})` : undefined}
      />
      <rect x={mid.x - width / 2} y={mid.y - 10} width={width} height={20} rx={8} className="fill-paper/90" />
      <text x={mid.x} y={mid.y + 4} textAnchor="middle" className="fill-muted text-[10px]">
        {text.length * 6 + 12 > width ? `${text.slice(0, 22)}…` : text}
      </text>
    </g>
  );
}
