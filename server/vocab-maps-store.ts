import type { MapNodeKind, MapEdgeKind, VocabMapType } from '../shared/vocab-map.js';

export interface StoredMap {
  id: string;
  type: VocabMapType;
  title: string;
  description: string;
  revision: number;
  requestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMapNode {
  id: string;
  mapId: string;
  kind: MapNodeKind;
  vocabularyId: string | null;
  senseId: string | null;
  /** Candidates only. A saved node's text is read from its word, never stored. */
  label: string | null;
  note: string;
  group: string | null;
  step: number | null;
  x: number | null;
  y: number | null;
  requestId: string | null;
  createdAt: string;
}

export interface StoredMapEdge {
  id: string;
  mapId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: MapEdgeKind;
  pattern: string;
  note: string;
  createdAt: string;
}

/**
 * Where one account's maps are kept. It stores what it is given; the rules
 * (which kinds a type accepts, what a candidate may carry) live in
 * VocabMapsService, against the same shared lists the browser uses.
 */
export interface VocabMapsStore {
  /** False where the store has nowhere to keep any of this; the endpoints then say the database is behind. */
  readonly available: boolean;

  /** `duplicate`: the account already created a map with this request id. */
  createMap(input: {
    type: VocabMapType;
    title: string;
    description: string;
    requestId: string | null;
  }): Promise<StoredMap | 'duplicate'>;
  findMapByRequestId(requestId: string): Promise<StoredMap | null>;
  /** `null`: no such map of the caller's. */
  getMap(id: string): Promise<StoredMap | null>;
  /** Every map of the caller's, most recently touched first. */
  listMaps(): Promise<StoredMap[]>;
  updateMap(id: string, patch: { title?: string; description?: string }): Promise<StoredMap | null>;
  /** One structural change recorded: the revision moves on by one. */
  bumpMapRevision(id: string): Promise<StoredMap | null>;
  /** Removes the map, its nodes and its edges. Never a word. */
  deleteMap(id: string): Promise<boolean>;

  listNodes(mapId: string): Promise<StoredMapNode[]>;
  getNode(mapId: string, id: string): Promise<StoredMapNode | null>;
  /**
   * `duplicate`: the map already has a node from this request id, or a
   * candidate with this exact label — however many times it is offered.
   */
  insertNode(node: Omit<StoredMapNode, 'id' | 'createdAt'>): Promise<StoredMapNode | 'duplicate'>;
  findNodeByRequestId(mapId: string, requestId: string): Promise<StoredMapNode | null>;
  findCandidateByLabel(mapId: string, label: string): Promise<StoredMapNode | null>;
  patchNode(mapId: string, id: string, patch: { label?: string; note?: string; group?: string | null; step?: number | null; x?: number | null; y?: number | null }): Promise<StoredMapNode | null>;
  /** Turns a candidate into a saved node pointing at a real word. The one way a node changes kind. */
  promoteNode(mapId: string, id: string, vocabularyId: string): Promise<StoredMapNode | null>;
  /** Takes the node's edges with it. Never a word. */
  deleteNode(mapId: string, id: string): Promise<boolean>;

  listEdges(mapId: string): Promise<StoredMapEdge[]>;
  /** `duplicate`: the same link, in the same direction, of the same kind already exists — that one is returned. */
  insertEdge(edge: Omit<StoredMapEdge, 'id' | 'createdAt'>): Promise<StoredMapEdge | 'duplicate'>;
  patchEdge(mapId: string, id: string, patch: { pattern?: string; note?: string }): Promise<StoredMapEdge | null>;
  deleteEdge(mapId: string, id: string): Promise<boolean>;
}

const unavailable = (): never => {
  throw new Error('This store cannot keep vocabulary maps.');
};

/** For a store whose schema has no room for any of this yet (before schema version 18). */
export const NO_MAPS_STORE: VocabMapsStore = {
  available: false,
  createMap: async () => unavailable(),
  findMapByRequestId: async () => null,
  getMap: async () => null,
  listMaps: async () => [],
  updateMap: async () => unavailable(),
  bumpMapRevision: async () => null,
  deleteMap: async () => false,
  listNodes: async () => [],
  getNode: async () => null,
  insertNode: async () => unavailable(),
  findNodeByRequestId: async () => null,
  findCandidateByLabel: async () => null,
  patchNode: async () => unavailable(),
  promoteNode: async () => null,
  deleteNode: async () => false,
  listEdges: async () => [],
  insertEdge: async () => unavailable(),
  patchEdge: async () => unavailable(),
  deleteEdge: async () => false,
};

/**
 * Everything in memory, for the built-in sample data. The foreign keys of
 * the real store are enforced by the service, which checks words through the
 * catalog it is given.
 */
export function createMemoryVocabMapsStore(now: () => Date = () => new Date()): VocabMapsStore {
  const maps = new Map<string, StoredMap>();
  const nodes = new Map<string, StoredMapNode>();
  const edges = new Map<string, StoredMapEdge>();
  let counter = 0;
  const nextId = () => `00000000-0000-4000-b000-${String((counter += 1)).padStart(12, '0')}`;
  const stamp = () => now().toISOString();
  /** The database refuses a second row with the same request id; so does this. */
  const requestTaken = (mapId: string, requestId: string | null): boolean =>
    requestId !== null && [...nodes.values()].some((node) => node.mapId === mapId && node.requestId === requestId);

  return {
    available: true,

    async createMap(input) {
      if (input.requestId !== null && [...maps.values()].some((map) => map.requestId === input.requestId)) return 'duplicate';
      const created: StoredMap = {
        id: nextId(),
        type: input.type,
        title: input.title,
        description: input.description,
        revision: 1,
        requestId: input.requestId,
        createdAt: stamp(),
        updatedAt: stamp(),
      };
      maps.set(created.id, created);
      return { ...created };
    },

    async findMapByRequestId(requestId) {
      const found = [...maps.values()].find((map) => map.requestId === requestId);
      return found === undefined ? null : { ...found };
    },

    async getMap(id) {
      const found = maps.get(id);
      return found === undefined ? null : { ...found };
    },

    async listMaps() {
      return [...maps.values()]
        .sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt)))
        .map((map) => ({ ...map }));
    },

    async updateMap(id, patch) {
      const found = maps.get(id);
      if (found === undefined) return null;
      if (patch.title !== undefined) found.title = patch.title;
      if (patch.description !== undefined) found.description = patch.description;
      found.updatedAt = stamp();
      return { ...found };
    },

    async bumpMapRevision(id) {
      const found = maps.get(id);
      if (found === undefined) return null;
      found.revision += 1;
      found.updatedAt = stamp();
      return { ...found };
    },

    async deleteMap(id) {
      if (!maps.delete(id)) return false;
      for (const node of [...nodes.values()]) if (node.mapId === id) nodes.delete(node.id);
      for (const edge of [...edges.values()]) if (edge.mapId === id) edges.delete(edge.id);
      return true;
    },

    async listNodes(mapId) {
      return [...nodes.values()]
        .filter((node) => node.mapId === mapId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((node) => ({ ...node }));
    },

    async getNode(mapId, id) {
      const found = nodes.get(id);
      return found === undefined || found.mapId !== mapId ? null : { ...found };
    },

    async insertNode(input) {
      const existing = [...nodes.values()].find(
        (node) =>
          node.mapId === input.mapId &&
          ((input.requestId !== null && node.requestId === input.requestId) ||
            (input.kind === 'candidate' && node.kind === 'candidate' && node.label === input.label) ||
            (input.kind === 'saved' &&
              node.kind === 'saved' &&
              node.vocabularyId === input.vocabularyId &&
              node.senseId === input.senseId)),
      );
      if (existing !== undefined) return 'duplicate';
      if (input.requestId !== null && requestTaken(input.mapId, input.requestId)) return 'duplicate';
      const created: StoredMapNode = { ...input, id: nextId(), createdAt: stamp() };
      nodes.set(created.id, created);
      return { ...created };
    },

    async findNodeByRequestId(mapId, requestId) {
      const found = [...nodes.values()].find((node) => node.mapId === mapId && node.requestId === requestId);
      return found === undefined ? null : { ...found };
    },

    async findCandidateByLabel(mapId, label) {
      const found = [...nodes.values()].find(
        (node) => node.mapId === mapId && node.kind === 'candidate' && node.label === label,
      );
      return found === undefined ? null : { ...found };
    },

    async patchNode(mapId, id, patch) {
      const found = nodes.get(id);
      if (found === undefined || found.mapId !== mapId) return null;
      if (patch.label !== undefined) found.label = patch.label;
      if (patch.note !== undefined) found.note = patch.note;
      if (patch.group !== undefined) found.group = patch.group;
      if (patch.step !== undefined) found.step = patch.step;
      if (patch.x !== undefined) found.x = patch.x;
      if (patch.y !== undefined) found.y = patch.y;
      return { ...found };
    },

    async promoteNode(mapId, id, vocabularyId) {
      const found = nodes.get(id);
      if (found === undefined || found.mapId !== mapId) return null;
      found.kind = 'saved';
      found.vocabularyId = vocabularyId;
      found.label = null;
      return { ...found };
    },

    async deleteNode(mapId, id) {
      const found = nodes.get(id);
      if (found === undefined || found.mapId !== mapId) return false;
      nodes.delete(id);
      for (const edge of [...edges.values()]) {
        if (edge.mapId === mapId && (edge.fromNodeId === id || edge.toNodeId === id)) edges.delete(edge.id);
      }
      return true;
    },

    async listEdges(mapId) {
      return [...edges.values()]
        .filter((edge) => edge.mapId === mapId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((edge) => ({ ...edge }));
    },

    async insertEdge(input) {
      const existing = [...edges.values()].find(
        (edge) =>
          edge.mapId === input.mapId &&
          edge.fromNodeId === input.fromNodeId &&
          edge.toNodeId === input.toNodeId &&
          edge.kind === input.kind,
      );
      if (existing !== undefined) return 'duplicate';
      const created: StoredMapEdge = { ...input, id: nextId(), createdAt: stamp() };
      edges.set(created.id, created);
      return { ...created };
    },

    async patchEdge(mapId, id, patch) {
      const found = edges.get(id);
      if (found === undefined || found.mapId !== mapId) return null;
      if (patch.pattern !== undefined) found.pattern = patch.pattern;
      if (patch.note !== undefined) found.note = patch.note;
      return { ...found };
    },

    async deleteEdge(mapId, id) {
      const found = edges.get(id);
      if (found === undefined || found.mapId !== mapId) return false;
      edges.delete(id);
      return true;
    },
  };
}
