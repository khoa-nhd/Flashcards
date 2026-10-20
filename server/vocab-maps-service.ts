/**
 * Vocabulary Maps: what a map may hold, and the line between a suggestion
 * and a saved word. Every rule here is also visible to the browser through
 * shared/vocab-map.ts, but the server is the one that insists on it.
 *
 * The invariants this service exists to keep:
 *   - a candidate node references no vocabulary, and only the learner's
 *     explicit save turns one into a real word (through the ordinary word
 *     path, with its duplicate check and its request id);
 *   - saved nodes reference canonical ids only — their text is read live, so
 *     renaming a word updates every map it sits in, and a map never keeps a
 *     stale copy of a word it no longer owns;
 *   - nothing here touches a schedule, mastery, review history or practice
 *     evidence: maps are housekeeping, not learning history.
 */
import {
  LIBRARY_RELATION_TO_EDGE,
  MAP_EDGE_KINDS_BY_TYPE,
  VOCAB_MAP_LIMITS,
  edgeKindAllowed,
  edgeKindNeedsNote,
  edgeKindNeedsPattern,
  isMapEdgeKind,
  tidyMapText,
  type AddMapEdgeRequest,
  type AddMapNodeRequest,
  type GenerateMapRequest,
  type MapEdgeKind,
  type MapSuggestions,
  type PersonalMapResponse,
  type UpdateMapEdgeRequest,
  type UpdateMapNodeRequest,
  type VocabMapDocument,
  type VocabMapEdge,
  type VocabMapNode,
  type VocabMapSummary,
  type VocabMapType,
} from '../shared/vocab-map.js';
import type { AiMapDraft } from '../shared/ai.js';
import { HttpError } from './errors.js';
import type { StoredMap, StoredMapEdge, StoredMapNode, VocabMapsStore } from './vocab-maps-store.js';

/** Everything the service needs about words; the store never holds any. */
export interface MapWordSource {
  /** Live words by id, as they stand now. Ids that are not the caller's are simply absent. */
  words(ids: readonly string[]): Promise<Array<{ id: string; word: string; meaning: string | null }>>;
  /** One sense, or null when there is no such sense of the caller's. */
  sense(id: string): Promise<{ id: string; vocabularyId: string; meaning: string | null } | null>;
  /** False when there is no such live word of the caller's. */
  ownsWord(id: string): Promise<boolean>;
  /** Everything the personal map is drawn from: the account's own library, read live. */
  overview(): Promise<{
    words: Array<{ id: string; word: string; meaning: string | null; updatedAt: string }>;
    collections: Array<{ id: string; name: string }>;
    memberships: Array<{ collectionId: string; vocabularyId: string }>;
    relations: Array<{ lowId: string; highId: string; kind: string }>;
    senses: number;
  }>;
  /** Creates one vocabulary entry from a candidate the learner chose to save. */
  saveWord(request: { word: string; requestId: string }): Promise<{ id: string }>;
}

export interface VocabMapsServiceOptions {
  store: VocabMapsStore;
  words: MapWordSource;
  writesRequested: boolean;
  now?: () => Date;
}

/** Kinds that say the same thing whichever way round the edge is drawn. */
const SYMMETRIC_EDGE_KINDS: readonly MapEdgeKind[] = [
  'synonym',
  'antonym',
  'related',
  'confused',
  'collocation',
  'verb_noun',
  'adjective_noun',
  'adverb_adjective',
  'other_pattern',
  'contrast',
  'phrase_variant',
];

export class VocabMapsService {
  private readonly store: VocabMapsStore;
  private readonly words: MapWordSource;
  private readonly writesRequested: boolean;
  private readonly now: () => Date;

  constructor(options: VocabMapsServiceOptions) {
    this.store = options.store;
    this.words = options.words;
    this.writesRequested = options.writesRequested;
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // The map itself
  // -------------------------------------------------------------------------

  async list(): Promise<{ maps: VocabMapSummary[] }> {
    const maps = await this.store.listMaps();
    const summaries = await Promise.all(maps.map((map) => this.summary(map)));
    return { maps: summaries };
  }

  async create(request: { type: VocabMapType; title: string; description?: string; requestId?: string }): Promise<{ map: VocabMapSummary }> {
    this.requireWrites();
    const title = tidyMapText(request.title);
    if (title.length === 0) throw new HttpError(400, 'invalid_request', 'A map needs a title.');
    const created = await this.store.createMap({
      type: request.type,
      title,
      description: request.description === undefined ? '' : tidyMapText(request.description),
      requestId: request.requestId ?? null,
    });
    if (created === 'duplicate') {
      // The same request id again: the map the first one made is the answer.
      const existing = request.requestId === undefined ? null : await this.store.findMapByRequestId(request.requestId);
      if (existing !== null) return { map: await this.summary(existing) };
      throw new HttpError(409, 'conflict', 'That request was already used.');
    }
    return { map: await this.summary(created) };
  }

  async get(id: string): Promise<{ map: VocabMapDocument }> {
    return { map: await this.document(id) };
  }

  async update(
    id: string,
    patch: { title?: string; description?: string; ifMatch?: number },
  ): Promise<{ map: VocabMapSummary }> {
    this.requireWrites();
    const map = await this.requireMap(id);
    this.checkRevision(map, patch.ifMatch);
    const title = patch.title === undefined ? undefined : tidyMapText(patch.title);
    if (title !== undefined && title.length === 0) throw new HttpError(400, 'invalid_request', 'A map needs a title.');
    const updated = await this.store.updateMap(id, {
      title,
      description: patch.description === undefined ? undefined : tidyMapText(patch.description),
    });
    if (updated === null) throw this.notFound('map');
    const bumped = await this.store.bumpMapRevision(id);
    return { map: await this.summary(bumped ?? updated) };
  }

  /** Removes the map, its nodes and its edges. The words it referenced are untouched. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    this.requireWrites();
    await this.requireMap(id);
    await this.store.deleteMap(id);
    return { id, deleted: true };
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  async addNode(mapId: string, request: AddMapNodeRequest): Promise<{ node: VocabMapNode }> {
    this.requireWrites();
    const map = await this.requireMap(mapId);
    const nodes = await this.store.listNodes(mapId);
    if (nodes.length >= VOCAB_MAP_LIMITS.nodes) {
      throw new HttpError(409, 'map_full', `A map may hold up to ${VOCAB_MAP_LIMITS.nodes} nodes.`);
    }
    const input = await this.nodeInput(map, request, nodes);
    if (request.requestId !== undefined) {
      const repeated = await this.store.findNodeByRequestId(mapId, request.requestId);
      if (repeated !== null) return { node: await this.nodeOf(repeated) };
    }
    const created = await this.store.insertNode(input);
    if (created === 'duplicate') {
      // Offered twice: the node that exists is the answer, never a second copy.
      const existing =
        (request.requestId === undefined ? null : await this.store.findNodeByRequestId(mapId, request.requestId)) ??
        (input.kind === 'candidate' && input.label !== null
          ? await this.store.findCandidateByLabel(mapId, input.label)
          : null);
      if (existing !== null) return { node: await this.nodeOf(existing) };
      throw new HttpError(409, 'conflict', 'That node is already on this map.');
    }
    await this.store.bumpMapRevision(mapId);
    return { node: await this.nodeOf(created) };
  }

  async patchNode(mapId: string, nodeId: string, patch: UpdateMapNodeRequest): Promise<{ node: VocabMapNode }> {
    this.requireWrites();
    const map = await this.requireMap(mapId);
    const node = await this.requireNode(mapId, nodeId);
    this.checkRevision(map, patch.ifMatch);
    if (patch.label !== undefined && node.kind !== 'candidate') {
      throw new HttpError(400, 'invalid_request', 'A saved node reads its word live; only a candidate has editable text.');
    }
    const label = patch.label === undefined ? undefined : tidyMapText(patch.label);
    if (label !== undefined && label.length === 0) {
      throw new HttpError(400, 'invalid_request', 'A candidate needs its word.');
    }
    const group = patch.group === undefined || patch.group === null ? patch.group : tidyMapText(patch.group) || null;
    const updated = await this.store.patchNode(mapId, nodeId, {
      label: label === undefined || node.kind !== 'candidate' ? undefined : label,
      note: patch.note === undefined ? undefined : tidyMapText(patch.note),
      group,
      step: patch.step,
    });
    if (updated === null) throw this.notFound('node');
    await this.store.bumpMapRevision(mapId);
    return { node: await this.nodeOf(updated) };
  }

  /** Removes the node and every edge touching it. The word it referenced is untouched. */
  async removeNode(mapId: string, nodeId: string): Promise<{ id: string; deleted: true }> {
    this.requireWrites();
    await this.requireMap(mapId);
    await this.requireNode(mapId, nodeId);
    await this.store.deleteNode(mapId, nodeId);
    await this.store.bumpMapRevision(mapId);
    return { id: nodeId, deleted: true };
  }

  /**
   * The one place a map may create vocabulary: the learner points at a
   * candidate and asks for it to become a real word. It goes through the
   * ordinary word path — duplicate check, request id, defaults — and only
   * then does the node become saved, keeping its place and its edges.
   */
  async saveCandidate(
    mapId: string,
    nodeId: string,
    request: { requestId?: string },
  ): Promise<{ node: VocabMapNode; entryId: string }> {
    this.requireWrites();
    await this.requireMap(mapId);
    const node = await this.requireNode(mapId, nodeId);
    if (node.kind !== 'candidate' || node.label === null) {
      throw new HttpError(400, 'invalid_request', 'Only a suggested node can be saved as a word.');
    }
    // The word path may refuse a duplicate; that refusal reaches the caller unchanged.
    const { id } = await this.words.saveWord({ word: node.label, requestId: request.requestId ?? node.id });
    const promoted = await this.store.promoteNode(mapId, nodeId, id);
    if (promoted === null) throw this.notFound('node');
    await this.store.bumpMapRevision(mapId);
    return { node: await this.nodeOf(promoted), entryId: id };
  }

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  async addEdge(mapId: string, request: AddMapEdgeRequest): Promise<{ edge: VocabMapEdge }> {
    this.requireWrites();
    const map = await this.requireMap(mapId);
    const kind = this.checkEdgeKind(map.type, request);
    const [from, to] = await Promise.all([
      this.requireNode(mapId, request.fromNodeId),
      this.requireNode(mapId, request.toNodeId),
    ]);
    if (from.id === to.id) throw new HttpError(400, 'invalid_request', 'A map cannot link a node to itself.');
    if (map.type === 'scenario' && kind === 'step' && from.step !== null && to.step !== null && from.step >= to.step) {
      throw new HttpError(400, 'invalid_request', 'A step link must point from an earlier step to a later one.');
    }
    const edges = await this.store.listEdges(mapId);
    if (edges.length >= VOCAB_MAP_LIMITS.edges) {
      throw new HttpError(409, 'map_full', `A map may hold up to ${VOCAB_MAP_LIMITS.edges} relationships.`);
    }
    // A symmetric kind drawn the other way round is the same claim: the link that exists is the answer.
    const existing = edges.find(
      (edge) =>
        edge.kind === kind &&
        ((edge.fromNodeId === from.id && edge.toNodeId === to.id) ||
          (isSymmetric(kind) && edge.fromNodeId === to.id && edge.toNodeId === from.id)),
    );
    if (existing !== undefined) return { edge: this.edgeOf(existing) };
    const created = await this.store.insertEdge({
      mapId,
      fromNodeId: from.id,
      toNodeId: to.id,
      kind,
      pattern: tidyMapText(request.pattern ?? ''),
      note: tidyMapText(request.note ?? ''),
    });
    if (created === 'duplicate') {
      const repeated = await this.store.listEdges(mapId);
      const same = repeated.find(
        (edge) => edge.kind === kind && edge.fromNodeId === from.id && edge.toNodeId === to.id,
      );
      if (same !== undefined) return { edge: this.edgeOf(same) };
      throw new HttpError(409, 'conflict', 'That relationship is already on this map.');
    }
    await this.store.bumpMapRevision(mapId);
    return { edge: this.edgeOf(created) };
  }

  async patchEdge(mapId: string, edgeId: string, patch: UpdateMapEdgeRequest): Promise<{ edge: VocabMapEdge }> {
    this.requireWrites();
    const map = await this.requireMap(mapId);
    const edge = (await this.store.listEdges(mapId)).find((candidate) => candidate.id === edgeId);
    if (edge === undefined) throw this.notFound('relationship');
    this.checkRevision(map, patch.ifMatch);
    const pattern = patch.pattern === undefined ? undefined : tidyMapText(patch.pattern);
    if (pattern !== undefined && edgeKindNeedsPattern(edge.kind) && pattern.length === 0) {
      throw new HttpError(400, 'invalid_request', 'This kind of relationship needs the combination it names.');
    }
    const note = patch.note === undefined ? undefined : tidyMapText(patch.note);
    if (note !== undefined && edgeKindNeedsNote(map.type, edge.kind) && note.length === 0) {
      throw new HttpError(400, 'invalid_request', 'A contrast must say what the difference is.');
    }
    const updated = await this.store.patchEdge(mapId, edgeId, { pattern, note });
    if (updated === null) throw this.notFound('relationship');
    await this.store.bumpMapRevision(mapId);
    return { edge: this.edgeOf(updated) };
  }

  async removeEdge(mapId: string, edgeId: string): Promise<{ id: string; deleted: true }> {
    this.requireWrites();
    await this.requireMap(mapId);
    const edge = (await this.store.listEdges(mapId)).find((candidate) => candidate.id === edgeId);
    if (edge === undefined) throw this.notFound('relationship');
    await this.store.deleteEdge(mapId, edgeId);
    await this.store.bumpMapRevision(mapId);
    return { id: edgeId, deleted: true };
  }

  /** Where the learner has left the nodes. One bump, however many moved. */
  async saveLayout(
    mapId: string,
    request: { positions: Array<{ nodeId: string; x: number; y: number }>; ifMatch?: number },
  ): Promise<{ map: VocabMapSummary }> {
    this.requireWrites();
    const map = await this.requireMap(mapId);
    this.checkRevision(map, request.ifMatch);
    for (const position of request.positions) {
      const node = await this.requireNode(mapId, position.nodeId);
      const updated = await this.store.patchNode(mapId, node.id, { x: position.x, y: position.y });
      if (updated === null) throw this.notFound('node');
    }
    const bumped = await this.store.bumpMapRevision(mapId);
    return { map: await this.summary(bumped ?? map) };
  }

  // -------------------------------------------------------------------------
  // AI drafts: generated maps and expansion
  // -------------------------------------------------------------------------

  /** The words an AI map starts from. Everything else the model offers stays a candidate. */
  async seedsFor(request: GenerateMapRequest): Promise<{ words: Array<{ id: string; word: string }>; title: string }> {
    if (request.vocabularyId !== undefined) {
      const [word] = await this.words.words([request.vocabularyId]);
      if (word === undefined) throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
      return { words: [{ id: word.id, word: word.word }], title: word.word };
    }
    if (request.collectionId !== undefined) {
      const overview = await this.words.overview();
      const collection = overview.collections.find((candidate) => candidate.id === request.collectionId);
      if (collection === undefined) throw new HttpError(404, 'not_found', 'That collection is not yours.');
      const memberIds = overview.memberships
        .filter((item) => item.collectionId === collection.id)
        .map((item) => item.vocabularyId);
      const found = await this.words.words(memberIds);
      const byId = new Map(found.map((word) => [word.id, word]));
      const words = memberIds
        .map((id) => byId.get(id))
        .filter((word): word is { id: string; word: string; meaning: string | null } => word !== undefined)
        .map((word) => ({ id: word.id, word: word.word }));
      return { words, title: collection.name };
    }
    return { words: [], title: request.topic === undefined ? 'New map' : tidyMapText(request.topic) };
  }

  /**
   * Builds a map from a model's draft. Seed words land as saved nodes by
   * their canonical id; every other label becomes an candidate; every edge is
   * kept only if its kind suits the map's type and both ends resolve. The
   * model never names an id, so it can never reach a word the learner did
   * not offer. The map takes its name from the seeds' own title — the seed
   * word, the collection's name, or the topic — unless the request names it.
   */
  async createFromDraft(
    request: GenerateMapRequest,
    draft: AiMapDraft,
    seeds: { words: ReadonlyArray<{ id: string; word: string }>; title: string },
  ): Promise<{ map: VocabMapDocument }> {
    this.requireWrites();
    const title = (request.title === undefined ? null : tidyMapText(request.title)) || seeds.title || 'New map';
    const created = await this.store.createMap({
      type: request.type,
      title: title.slice(0, VOCAB_MAP_LIMITS.title),
      description: request.topic === undefined ? '' : `From the topic "${tidyMapText(request.topic)}"`.slice(0, VOCAB_MAP_LIMITS.description),
      requestId: request.requestId ?? null,
    });
    if (created === 'duplicate') {
      const existing = request.requestId === undefined ? null : await this.store.findMapByRequestId(request.requestId);
      if (existing !== null) return { map: await this.document(existing.id) };
      throw new HttpError(409, 'conflict', 'That request was already used.');
    }
    await this.applyDraft(created, draft, seeds.words);
    return { map: await this.document(created.id) };
  }

  /** What a model proposes for an existing map — nothing is written until the learner applies it. */
  async validateSuggestions(document: VocabMapDocument, draft: AiMapDraft): Promise<MapSuggestions> {
    const existingLabels = new Set<string>();
    for (const node of document.nodes) {
      const label = node.kind === 'candidate' ? node.label : node.word?.word;
      if (label !== undefined && label !== null) existingLabels.add(lower(label));
    }
    const nodes: Array<{ label: string; note: string; group: string | null }> = [];
    const seen = new Set(existingLabels);
    for (const raw of draft.nodes) {
      if (nodes.length >= VOCAB_MAP_LIMITS.expandNodes) break;
      const label = tidyMapText(raw.label).slice(0, VOCAB_MAP_LIMITS.label);
      if (label.length === 0 || seen.has(lower(label))) continue;
      seen.add(lower(label));
      nodes.push({
        label,
        note: tidyMapText(raw.note ?? '').slice(0, VOCAB_MAP_LIMITS.note),
        group: raw.group === undefined || raw.group === null ? null : tidyMapText(raw.group).slice(0, VOCAB_MAP_LIMITS.group) || null,
      });
    }
    const edges = this.validEdges(document.type, draft, seen);
    return { nodes, edges: edges.slice(0, VOCAB_MAP_LIMITS.expandEdges) };
  }

  /** Adds validated suggestions to a map as candidate nodes — still not vocabulary. */
  async applySuggestions(mapId: string, suggestions: MapSuggestions): Promise<{ nodes: number; edges: number }> {
    this.requireWrites();
    const map = await this.requireMap(mapId);
    const document = await this.document(mapId);
    const labelToNode = new Map<string, string>();
    for (const node of document.nodes) {
      const label = node.kind === 'candidate' ? node.label : node.word?.word;
      if (label !== undefined && label !== null) labelToNode.set(lower(label), node.id);
    }
    const accepted: VocabMapNode[] = [];
    // Expanding a scenario continues its order where the map leaves off.
    let step = document.nodes.reduce((highest, node) => (node.step !== null && node.step > highest ? node.step : highest), 0);
    const nextStep = (): number | null => (map.type === 'scenario' ? ++step : null);
    for (const suggestion of suggestions.nodes) {
      if (document.nodes.length + accepted.length >= VOCAB_MAP_LIMITS.nodes) break;
      const labelKey = lower(suggestion.label);
      const alreadyThere = labelToNode.get(labelKey);
      if (alreadyThere !== undefined) {
        const node = document.nodes.find((candidate) => candidate.id === alreadyThere);
        if (node !== undefined) accepted.push(node);
        continue;
      }
      const created = await this.store.insertNode({
        mapId,
        kind: 'candidate',
        vocabularyId: null,
        senseId: null,
        label: suggestion.label,
        note: suggestion.note,
        group: suggestion.group,
        step: nextStep(),
        x: null,
        y: null,
        // No per-node request id: pressing apply twice is already harmless,
        // because the same suggestion is recognised by its label and reused.
        requestId: null,
      });
      if (created === 'duplicate') {
        const existing = await this.store.findCandidateByLabel(mapId, suggestion.label);
        if (existing !== null) {
          accepted.push(await this.nodeOf(existing));
          labelToNode.set(labelKey, existing.id);
        }
        continue;
      }
      const node = await this.nodeOf(created);
      accepted.push(node);
      labelToNode.set(labelKey, node.id);
    }
    const edges: VocabMapEdge[] = [];
    for (const suggestion of suggestions.edges) {
      if ((await this.store.listEdges(mapId)).length + edges.length >= VOCAB_MAP_LIMITS.edges) break;
      const fromNodeId = labelToNode.get(lower(suggestion.fromLabel));
      const toNodeId = labelToNode.get(lower(suggestion.toLabel));
      if (fromNodeId === undefined || toNodeId === undefined || fromNodeId === toNodeId) continue;
      const created = await this.store.insertEdge({
        mapId,
        fromNodeId,
        toNodeId,
        kind: suggestion.kind,
        pattern: suggestion.pattern,
        note: suggestion.note,
      });
      if (created !== 'duplicate') edges.push(this.edgeOf(created));
    }
    await this.store.bumpMapRevision(mapId);
    return { nodes: accepted.length, edges: edges.length };
  }

  // -------------------------------------------------------------------------
  // The personal knowledge map: drawn live from what the account already has
  // -------------------------------------------------------------------------

  async personal(): Promise<PersonalMapResponse> {
    const overview = await this.words.overview();
    const maps = await this.store.listMaps();
    const collectionsByWord = new Map<string, string>();
    const nameOf = new Map(overview.collections.map((collection) => [collection.id, collection.name]));
    // One node per word; where it sits is the first of its collections, by name.
    const memberships = [...overview.memberships].sort((a, b) =>
      (nameOf.get(a.collectionId) ?? '').localeCompare(nameOf.get(b.collectionId) ?? ''),
    );
    for (const item of memberships) {
      if (!collectionsByWord.has(item.vocabularyId)) {
        collectionsByWord.set(item.vocabularyId, nameOf.get(item.collectionId) ?? '');
      }
    }
    const words = [...overview.words]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, VOCAB_MAP_LIMITS.nodes);
    const wordIds = new Set(words.map((word) => word.id));
    const nodes: VocabMapNode[] = words.map((word) => ({
      id: `personal-${word.id}`,
      kind: 'saved',
      vocabularyId: word.id,
      senseId: null,
      label: null,
      note: '',
      group: collectionsByWord.get(word.id) ?? null,
      step: null,
      x: null,
      y: null,
      word: { id: word.id, word: word.word, meaning: word.meaning },
      sense: null,
    }));
    const byId = new Map(words.map((word) => [word.id, `personal-${word.id}`]));
    const seen = new Set<string>();
    const edges: VocabMapEdge[] = [];
    for (const relation of overview.relations) {
      if (edges.length >= VOCAB_MAP_LIMITS.edges) break;
      const kind = LIBRARY_RELATION_TO_EDGE[relation.kind];
      const from = byId.get(relation.lowId);
      const to = byId.get(relation.highId);
      if (kind === undefined || from === undefined || to === undefined || !wordIds.has(relation.lowId)) continue;
      const key = [kind, ...[relation.lowId, relation.highId].sort()].join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: `personal-relation-${key}`, fromNodeId: from, toNodeId: to, kind, pattern: '', note: '' });
    }
    const personal: VocabMapDocument = {
      id: 'personal',
      type: 'personal',
      title: 'Your vocabulary at a glance',
      description: `${overview.words.length} words · ${maps.length} maps · ${overview.collections.length} collections · ${overview.relations.length} saved relationships. Drawn live from what you already have; nothing here is a claim about mastery.`,
      revision: 1,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      nodes,
      edges,
    };
    return {
      personal,
      stats: {
        words: overview.words.length,
        maps: maps.length,
        collections: overview.collections.length,
        relations: overview.relations.length,
        senses: overview.senses,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireWrites(): void {
    if (!this.writesRequested) {
      throw new HttpError(
        403,
        'read_only',
        'Saving is switched off, so nothing was changed. Set REVIEW_WRITES_ENABLED=true to allow it.',
      );
    }
  }

  private notFound(what: string): HttpError {
    return new HttpError(404, 'not_found', `That ${what} is not on this map.`);
  }

  private checkRevision(map: StoredMap, ifMatch: number | undefined): void {
    if (ifMatch !== undefined && ifMatch !== map.revision) {
      throw new HttpError(
        409,
        'conflict',
        'This map was changed somewhere else since you opened it. Reload it and put the change on top of the newer one.',
      );
    }
  }

  private async requireMap(id: string): Promise<StoredMap> {
    const map = await this.store.getMap(id);
    if (map === null) throw new HttpError(404, 'not_found', 'That map is not yours.');
    return map;
  }

  private async requireNode(mapId: string, nodeId: string): Promise<StoredMapNode> {
    const node = await this.store.getNode(mapId, nodeId);
    if (node === null) throw this.notFound('node');
    return node;
  }

  private async summary(map: StoredMap): Promise<VocabMapSummary> {
    const [nodes, edges] = await Promise.all([this.store.listNodes(map.id), this.store.listEdges(map.id)]);
    return {
      id: map.id,
      type: map.type,
      title: map.title,
      description: map.description,
      revision: map.revision,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
    };
  }

  /** The whole map, with every saved node's word read live and every sense named. */
  private async document(mapId: string): Promise<VocabMapDocument> {
    const map = await this.requireMap(mapId);
    const [nodes, edges] = await Promise.all([this.store.listNodes(mapId), this.store.listEdges(mapId)]);
    const wordIds = [...new Set(nodes.filter((node) => node.kind === 'saved' && node.vocabularyId !== null).map((node) => node.vocabularyId as string))];
    const senseIds = [...new Set(nodes.map((node) => node.senseId).filter((id): id is string => id !== null))];
    const [foundWords, foundSenses] = await Promise.all([
      this.words.words(wordIds),
      Promise.all(senseIds.map((id) => this.words.sense(id))),
    ]);
    const wordById = new Map(foundWords.map((word) => [word.id, word]));
    const senseById = new Map(foundSenses.filter((sense): sense is NonNullable<typeof sense> => sense !== null).map((sense) => [sense.id, sense]));
    const shaped = await Promise.all(
      nodes.map(async (node) => this.nodeOf(node, wordById, senseById)),
    );
    return {
      id: map.id,
      type: map.type,
      title: map.title,
      description: map.description,
      revision: map.revision,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
      nodes: shaped,
      edges: edges.map((edge) => this.edgeOf(edge)),
    };
  }

  private async nodeOf(
    node: StoredMapNode,
    wordById?: Map<string, { id: string; word: string; meaning: string | null }>,
    senseById?: Map<string, { id: string; vocabularyId: string; meaning: string | null }>,
  ): Promise<VocabMapNode> {
    let word: VocabMapNode['word'] = null;
    let sense: VocabMapNode['sense'] = null;
    if (node.kind === 'saved' && node.vocabularyId !== null) {
      const resolved =
        wordById?.get(node.vocabularyId) ??
        (await this.words.words([node.vocabularyId]))[0] ??
        null;
      word = resolved === null ? null : { id: resolved.id, word: resolved.word, meaning: resolved.meaning };
      if (node.senseId !== null) {
        const resolvedSense = senseById?.get(node.senseId) ?? (await this.words.sense(node.senseId));
        sense = resolvedSense === null ? null : { id: resolvedSense.id, meaning: resolvedSense.meaning };
      }
    }
    return {
      id: node.id,
      kind: node.kind,
      vocabularyId: node.vocabularyId,
      senseId: node.senseId,
      label: node.label,
      note: node.note,
      group: node.group,
      step: node.step,
      x: node.x,
      y: node.y,
      word,
      sense,
    };
  }

  private edgeOf(edge: StoredMapEdge): VocabMapEdge {
    return {
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind,
      pattern: edge.pattern,
      note: edge.note,
    };
  }

  /** The stored shape of a new node, after every check that decides it may exist. */
  private async nodeInput(
    map: StoredMap,
    request: AddMapNodeRequest,
    nodes: StoredMapNode[],
  ): Promise<Omit<StoredMapNode, 'id' | 'createdAt'>> {
    const note = tidyMapText(request.note ?? '').slice(0, VOCAB_MAP_LIMITS.note);
    const group = request.group === undefined || request.group === null ? null : tidyMapText(request.group).slice(0, VOCAB_MAP_LIMITS.group) || null;
    let step = request.step === undefined || request.step === null ? null : request.step;
    if (map.type === 'scenario' && step === null) {
      // The next free step, so a scenario grows in order without being told twice.
      step = nodes.reduce((highest, node) => (node.step !== null && node.step > highest ? node.step : highest), 0) + 1;
    }
    if (request.kind === 'candidate') {
      if (request.vocabularyId !== undefined) {
        throw new HttpError(400, 'invalid_request', 'A suggestion is map data, not a word: it carries no word id.');
      }
      if (request.label === undefined) throw new HttpError(400, 'invalid_request', 'A suggested node needs the word it suggests.');
      const label = tidyMapText(request.label).slice(0, VOCAB_MAP_LIMITS.label);
      if (label.length === 0) throw new HttpError(400, 'invalid_request', 'A suggested node needs the word it suggests.');
      return {
        mapId: map.id,
        kind: 'candidate',
        vocabularyId: null,
        senseId: null,
        label,
        note,
        group,
        step,
        x: null,
        y: null,
        requestId: request.requestId ?? null,
      };
    }
    if (request.vocabularyId === undefined) {
      throw new HttpError(400, 'invalid_request', 'A saved node needs a word from your vocabulary.');
    }
    if (request.label !== undefined) {
      throw new HttpError(400, 'invalid_request', 'A saved node reads its word live; only a candidate has editable text.');
    }
    if (!(await this.words.ownsWord(request.vocabularyId))) {
      throw new HttpError(404, 'not_found', 'That word is not in your vocabulary.');
    }
    if (request.senseId !== undefined) {
      const sense = await this.words.sense(request.senseId);
      if (sense === null || sense.vocabularyId !== request.vocabularyId) {
        throw new HttpError(400, 'invalid_request', 'That sense does not belong to that word.');
      }
    }
    return {
      mapId: map.id,
      kind: 'saved',
      vocabularyId: request.vocabularyId,
      senseId: request.senseId ?? null,
      label: null,
      note,
      group,
      step,
      x: null,
      y: null,
      requestId: request.requestId ?? null,
    };
  }

  /** A relationship kind the map's type accepts, with what that kind demands. */
  private checkEdgeKind(type: VocabMapType, request: AddMapEdgeRequest): MapEdgeKind {
    if (!isMapEdgeKind(request.kind) || !edgeKindAllowed(type, request.kind)) {
      const allowed = MAP_EDGE_KINDS_BY_TYPE[type].join(', ');
      throw new HttpError(400, 'invalid_request', `A ${type} map holds these relationships: ${allowed}.`);
    }
    const pattern = tidyMapText(request.pattern ?? '');
    if (edgeKindNeedsPattern(request.kind) && pattern.length === 0) {
      throw new HttpError(400, 'invalid_request', 'This kind of relationship needs the combination it names, such as "make a decision".');
    }
    const note = tidyMapText(request.note ?? '');
    if (edgeKindNeedsNote(type, request.kind) && note.length === 0) {
      throw new HttpError(400, 'invalid_request', 'A contrast must say what the difference is.');
    }
    return request.kind;
  }

  /** Which of a draft's edges may be stored: the kind must suit the type and both ends must be known labels. */
  private validEdges(
    type: VocabMapType,
    draft: AiMapDraft,
    knownLabels: ReadonlySet<string>,
  ): Array<{ fromLabel: string; toLabel: string; kind: MapEdgeKind; pattern: string; note: string }> {
    const kept: Array<{ fromLabel: string; toLabel: string; kind: MapEdgeKind; pattern: string; note: string }> = [];
    const seen = new Set<string>();
    for (const raw of draft.edges) {
      const fromLabel = tidyMapText(raw.fromLabel);
      const toLabel = tidyMapText(raw.toLabel);
      if (!knownLabels.has(lower(fromLabel)) || !knownLabels.has(lower(toLabel)) || lower(fromLabel) === lower(toLabel)) continue;
      const kind = raw.kind.toLowerCase().trim().replace(/\s+/g, '_');
      if (!isMapEdgeKind(kind) || !edgeKindAllowed(type, kind)) continue;
      const pattern = tidyMapText(raw.pattern ?? '').slice(0, VOCAB_MAP_LIMITS.pattern);
      if (edgeKindNeedsPattern(kind) && pattern.length === 0) continue;
      const note = tidyMapText(raw.note ?? '').slice(0, VOCAB_MAP_LIMITS.note);
      if (edgeKindNeedsNote(type, kind) && note.length === 0) continue;
      const pair = isSymmetric(kind) ? [lower(fromLabel), lower(toLabel)].sort().join(' ') : `${lower(fromLabel)} > ${lower(toLabel)}`;
      const key = `${kind} ${pair}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({ fromLabel, toLabel, kind, pattern, note });
    }
    return kept;
  }

  /**
   * Writes a validated draft into a freshly created map: seed words as
   * saved nodes, every other label as a candidate, every kept edge once.
   */
  private async applyDraft(
    map: StoredMap,
    draft: AiMapDraft,
    seeds: ReadonlyArray<{ id: string; word: string }>,
  ): Promise<void> {
    const labelToNode = new Map<string, string>();
    const savedWords = new Set<string>();
    // A scenario is walked in order: steps run from the first node the draft
    // places, seeds before suggestions, one after the other.
    let step = 0;
    const nextStep = (): number | null => (map.type === 'scenario' ? ++step : null);
    for (const seed of seeds) {
      if (savedWords.has(seed.id)) continue;
      savedWords.add(seed.id);
      const created = await this.store.insertNode({
        mapId: map.id,
        kind: 'saved',
        vocabularyId: seed.id,
        senseId: null,
        label: null,
        note: '',
        group: null,
        step: nextStep(),
        x: null,
        y: null,
        requestId: null,
      });
      if (created !== 'duplicate') labelToNode.set(lower(seed.word), created.id);
      else {
        const existing = [...(await this.store.listNodes(map.id))].find(
          (node) => node.kind === 'saved' && node.vocabularyId === seed.id,
        );
        if (existing !== undefined) labelToNode.set(lower(seed.word), existing.id);
      }
    }
    const seen = new Set(labelToNode.keys());
    let candidates = 0;
    for (const raw of draft.nodes) {
      if (candidates >= VOCAB_MAP_LIMITS.expandNodes) break;
      const label = tidyMapText(raw.label).slice(0, VOCAB_MAP_LIMITS.label);
      if (label.length === 0 || seen.has(lower(label))) continue;
      seen.add(lower(label));
      candidates += 1;
      const created = await this.store.insertNode({
        mapId: map.id,
        kind: 'candidate',
        vocabularyId: null,
        senseId: null,
        label,
        note: tidyMapText(raw.note ?? '').slice(0, VOCAB_MAP_LIMITS.note),
        group: raw.group === undefined || raw.group === null ? null : tidyMapText(raw.group).slice(0, VOCAB_MAP_LIMITS.group) || null,
        step: nextStep(),
        x: null,
        y: null,
        requestId: null,
      });
      if (created !== 'duplicate') labelToNode.set(lower(label), created.id);
    }
    for (const edge of this.validEdges(map.type, draft, seen)) {
      const fromNodeId = labelToNode.get(lower(edge.fromLabel));
      const toNodeId = labelToNode.get(lower(edge.toLabel));
      if (fromNodeId === undefined || toNodeId === undefined || fromNodeId === toNodeId) continue;
      await this.store.insertEdge({
        mapId: map.id,
        fromNodeId,
        toNodeId,
        kind: edge.kind,
        pattern: edge.pattern,
        note: edge.note,
      });
    }
    await this.store.bumpMapRevision(map.id);
  }
}

function lower(value: string): string {
  return value.toLowerCase();
}

function isSymmetric(kind: MapEdgeKind): boolean {
  return SYMMETRIC_EDGE_KINDS.includes(kind);
}
