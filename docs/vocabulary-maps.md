# Vocabulary maps: eight ways to draw your words

Vocabulary maps are diagrams you draw with your own vocabulary: meanings,
families, combinations, topics, contrasts, situations, communicative
functions — plus the personal map, which is drawn live from your library
and stored as nothing at all. A map lives at **Vocabulary maps** in the
navigation (route `/maps`; one map opens behind `?map=<id>`, the personal
view behind `?view=personal`). The older *Topic maps* page (route `/map`)
is a separate, read-only feature and is untouched by this one.

Seven kinds can be created; the eighth — personal knowledge — is never
created, only derived.

## The eight experiences

| Kind | What makes it its own experience, not a recoloured copy |
| --- | --- |
| **Semantic relationships** | Links are tied to the sense they hold for: a relationship can be pinned to one meaning of a polysemous word, and the panel lists *Meanings on this map* separately from *Words on this map*. |
| **Word family** | Drawn as rooted families: the root with what was formed from it hanging beneath it (`└─ Derived from: …`), and words with no family standing alone under *On their own*. |
| **Collocations** | Read as a table — Kind, Words, Combination, Note — where the combination itself (the pattern you store with the link) is a first-class column, not free text buried in a note. |
| **Thematic** | Words carry group labels; the panel groups them under topic headings, separates *Topics and their parts* from *Across topics*, and shows which words carry no group yet. |
| **Nuance & contrast** | Two expressions side by side with their meanings and the difference spelled out between them; a contrast link *insists* on that note. |
| **Scenario** | One situation walked through in order: nodes carry a step number, the panel reads as an ordered list, and reordering is an ordinary list action (move earlier / move later), not a drag. |
| **Communicative function** | Phrases grouped under what the speaker is trying to do (apologising, refusing, …); variants of one intention are listed as *also: …* under the phrase. |
| **Personal knowledge** | Never stored. Every visit recomputes it from your library: up to 60 of your words, grouped by collection, with the relationships you have drawn among them, plus counts. |

Everything is drawn on a hand-rolled SVG canvas — no charting library —
with zoom and pan, a full keyboard path, and an *Everything on this map*
list beside the drawing: every item is reachable from either.

## The lines this feature never crosses

- **Saving a map saves no vocabulary.** Creating, renaming, moving,
  linking, correcting and deleting maps touch only map tables. The single
  call that creates a word from a map is *save this suggestion*
  (`POST /api/maps/:id/nodes/:nodeId/save`), pressed deliberately by the
  learner.
- **A suggestion is not a word.** A candidate node carries its own text
  (`label`) and no `vocabularyId`; a saved node carries its
  `vocabularyId` (and optionally one sense) and *no stored label* — its
  text is read live from your vocabulary on every render. Renaming a word
  elsewhere updates its maps instantly, with no map revision and no copy
  to drift. The API refuses the blurred shapes explicitly (400): a
  candidate with a `vocabularyId`, or a saved node with a `label`.
- **Canonical ids and sense identity are kept.** The same word in two
  maps is the same id in both; there is no duplication to place a word
  anywhere. A sense is referenced by its own id and can never point at a
  different word (the database enforces the triple `id, vocabulary_id,
  user_id`).
- **Looking never learns.** No map route reads or writes FSRS state,
  mastery, review dates, practice results or the Error Log. Reading the
  list, a document, the personal view or an unapplied AI expansion leaves
  the word's entry, the card state and the review history byte-identical
  (Journey E asserts exactly that).
- **The AI proposes, you add.** `Expand with AI` first runs with
  `apply: false` — suggestions come back as a preview that changes
  nothing. Only *Add these to the map* applies them, and even then each
  suggestion becomes a **candidate**, never a word, and links you drew
  yourself are never overwritten (dedupe by label on apply).

## Starting a map

- **By hand** — *New map*: pick one of the seven kinds, give it a title
  (the button stays off until you do), and it opens empty.
- **Drafted by the model** — *Draft with AI*: choose what it starts from
  (a topic you type, one word you search for, or a collection), pick the
  kind, optionally name it. Your seed lands as a saved word by its own
  canonical id; every other label the model offers arrives as a
  suggestion. Drafting a map creates a map — never a word.

## AI assistance

Both routes share the one adapter, the strict `aiMapDraftSchema` and a
process-wide token bucket of 5 requests, one refilled per minute
(`MAPS_AI_RATE`). The model is asked for **labels, never ids**, and sees
only what you offered: the seeds/topic for a draft, your map's word
labels for an expansion.

| Route | What leaves this server | What comes back |
| --- | --- | --- |
| `POST /api/maps/generate` | The map kind, your topic and/or the seed word(s) (the one word you picked, or your collection's names). | Word labels and links; the service vets them kind by kind, drops what does not suit the map or cannot be resolved, saves seeds by id and keeps everything else a candidate. |
| `POST /api/maps/:id/expand` | Your map's word labels (and groups/notes as stored). | Suggestions validated the same way; with `apply: false` they are only proposed. |

Failures are named states mapped to HTTP by `withAiErrors`
(`server/create-app.ts`): rate-limited → 429, invalid output → 502
`ai_invalid`, not configured → 409, otherwise 503. The page keeps the
form, says what happened, and everything remains possible by hand. With
no `AI_API_KEY` both routes simply answer that way — see
[AI features](ai-features.md) for configuration.

## Read-only accounts

With `REVIEW_WRITES_ENABLED=false` every map **read** still answers
(list, document, personal view, unapplied expansion), and every **write**
is refused with `403 read_only` — creating a map, adding or moving nodes,
layout, saving a suggestion, renaming, deleting, generating and applying
expansions alike. This is Journey I.

## Storage (schema v18)

Migration `supabase/migrations/20261027090000_vocabulary_maps.sql`, all
additive — schema versions 13–17 and every earlier feature are untouched:

| Table | Holds |
| --- | --- |
| `vocabulary_maps` | One row per stored map: owner, type (a check constraint excludes `personal`), title, description, revision. Idempotent creation is keyed on `(user_id, request_id)`. |
| `vocabulary_map_nodes` | Saved nodes (word id, optional sense id, note, group, step, position) and candidates (label, note, group, step, position) — never both. Composite FK `id, user_id` stops a node from pointing at another account's word. |
| `vocabulary_map_edges` | Two node ids plus a kind from the 18 stored kinds (per-type allowed sets live in `MAP_EDGE_KINDS_BY_TYPE`), optional pattern and note. Natural uniqueness makes a repeated link a no-op. |

- Every structural change bumps `revision` through the
  `bump_vocabulary_map_revision()` RPC; writes carry the revision they
  read (`If-Match`) and a stale hand gets `409 conflict`. When row-level
  security blocks the bump, the function returns one row of all-NULLs —
  the code treats that as "nothing changed".
- Row-level security: owner-only policies on all three tables, granted to
  `authenticated` only; `anon` can select nothing and cannot execute the
  RPC.
- Deleting a map keeps every word (nodes and edges cascade away);
  deleting a word removes only its nodes and edges, never the map.
- Below schema 18 the app reports the feature as unavailable
  (`503 setup_incomplete`) rather than failing halfway.

**Hosted caveat:** all of the above is verified on isolated local
databases (PGlite for the schema suites, a local PostgreSQL instance for
the release suite). Applying the migration to a hosted Supabase project
has not been performed and is not claimed here.

## API surface

| Method & path | Purpose |
| --- | --- |
| `GET /api/maps` · `POST /api/maps` | List; create (idempotent by `requestId`). |
| `GET/PATCH/DELETE /api/maps/:id` | One map: read, rename (`If-Match`), delete (words stay). |
| `GET /api/maps/personal` | The derived personal map + stats; nothing stored. |
| `POST /api/maps/generate` | An AI draft; seeds saved, the rest candidates. |
| `POST /api/maps/:id/expand` | Propose (`apply:false`) or add candidates (`apply:true`). |
| `POST/PATCH/DELETE /api/maps/:id/nodes…` | Place a word or suggestion, correct it, remove it. |
| `POST /api/maps/:id/nodes/:nodeId/save` | **The one call that turns a suggestion into a word.** |
| `POST/PATCH/DELETE /api/maps/:id/edges…` | Connect two items, correct the link, remove it. |
| `PUT /api/maps/:id/layout` | Positions, checked against the revision. |

## Where things live

```
shared/vocab-map.ts          the contract: 8 types, 18 edge kinds, per-type
                             allowed sets, limits, Zod schemas
shared/ai.ts                 aiMapDraftSchema — what a draft must look like
supabase/migrations/20261027090000_vocabulary_maps.sql
                             schema v18: tables, checks, RLS, bump RPC
server/vocab-maps-service.ts the service: the save line, personal derivation,
                             suggestion validation/application, seeds
server/ai/map-builder.ts     drafting and expanding with the model
server/create-app.ts         the routes, plus withAiErrors mapping
server/supabase/…            store methods (schema 18) and database.types
src/pages/MapsPage.tsx       the list, the two ways in, the personal view
src/components/maps/MapCanvas.tsx      the drawing: SVG, zoom/pan, keyboard
src/components/maps/MapExperiences.tsx the seven stored experiences + personal
src/components/maps/MapDetail.tsx      one map: header, list twin, editors
src/lib/api-client.ts        VocabularyMapsApi
tests/helpers/fake-api.ts    the in-memory maps store for client tests
```

## Tests

- `tests/client/vocab-maps.test.tsx` — the whole page as the learner
  meets it: both ways in, the saved/suggestion line, one experience per
  kind (all eight), the AI preview, rename/delete, read-only, and that no
  route asks for a review queue (24 tests).
- `tests/server/maps-api.test.ts` — every kind, ownership, live word
  text, the save line, edge validation, layout/`If-Match`, idempotency,
  deletes, read-only (28 tests).
- `tests/server/maps-ai.test.ts` — drafting and expanding with a stubbed
  model: labels not ids, vetted output, seeds saved, no silent
  overwrite (13 tests).
- `tests/server/maps-journeys.test.ts` — the nine integration journeys
  A–I, whole-path (9 tests).
- `tests/database/maps-schema.test.ts` + pins in
  `tests/database/schema.test.ts` — grants, RLS, check constraints,
  cascade and RPC behaviour (15 + updates).
- `tests/pg-release/migrations.pgtest.ts` — the same migration on a real
  PostgreSQL instance.
