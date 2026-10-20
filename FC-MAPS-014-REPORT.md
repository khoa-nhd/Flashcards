# FC-MAPS-014 — Vocabulary Maps: final report

Workstream: the Vocabulary Maps feature (eight map experiences) — domain
model, additive migration, backend/API, editor/viewer, eight experiences,
AI generation and expansion, tests, documentation. Executed autonomously on
branch `newfeature` @ `8d76720` with no intermediate reports, as required.

**Overall outcome: PASS**

---

## What was delivered

- **Domain contract** `shared/vocab-map.ts`: 8 map types (7 creatable,
  `personal` derived-only), 18 stored edge kinds with per-type allowed
  sets, pattern/note requirements, limits, and every Zod schema;
  `shared/ai.ts` gained `aiMapDraftSchema`.
- **Migration** `supabase/migrations/20261027090000_vocabulary_maps.sql`
  (schema **v18**, additive): `vocabulary_maps`, `vocabulary_map_nodes`,
  `vocabulary_map_edges` — owner-only RLS, grants to `authenticated` only,
  check constraints (no stored `personal`, saved/candidate exclusivity,
  edge kinds, self-edge refusal, contrast note), `bump_vocabulary_map_revision()`
  RPC, and a unique `(id, vocabulary_id, user_id)` key on `vocabulary_senses`.
  `LATEST_SCHEMA_VERSION` 18; below 18 the app answers
  `503 setup_incomplete` instead of failing halfway.
- **Backend**: `server/vocab-maps-service.ts`, `server/vocab-maps-store.ts`,
  `server/supabase/supabase-maps.ts` (19 store methods), accounts/bootstrap
  wiring, `server/ai/map-builder.ts`, and all routes in
  `server/create-app.ts` — Zod-validated, ownership-checked, idempotent by
  `(user_id, request_id)`, `If-Match` revisions with `409 conflict`,
  `withAiErrors()` mapping rate-limited→429, invalid output→502
  `ai_invalid`, not configured→409, else→503.
- **Frontend**: route `/maps` (`?map=`, `?view=personal`); `MapsPage`
  (list, hand-drawn creation, **Draft with AI** picker over a word /
  collection / topic, personal view), `MapCanvas.tsx` (hand-rolled SVG,
  zoom/pan, keyboard, no new dependency), `MapDetail.tsx` (header, the
  *Everything on this map* list twin, add/edit/remove, rename, delete),
  `MapExperiences.tsx` (all eight experiences), `api-client`
  `VocabularyMapsApi` (17 methods), AppShell nav item. The pre-existing
  Topic map (`/map`) is untouched and read-only.
- **Fake API**: in-memory maps store with 17 methods, live word read,
  `maps?` fixture option, read-only `list` option — mirrors the server's
  seed/title behaviour.
- **Tests** (all new): client 24, server maps-api 28, server maps-ai 13,
  journeys 9, database maps-schema 15, plus maps pins in
  `tests/database/schema.test.ts`, `tests/server/gateway-versions.test.ts`
  and `tests/pg-release/migrations.pgtest.ts`.
- **Documentation**: `docs/vocabulary-maps.md` (new), plus integration in
  `docs/ai-features.md` (sixth AI feature, its bucket), `README.md`
  (feature row, section, docs bullet, API rows) and
  `docs/supabase-schema.md` (v18 row, three tables, RLS rows, the bump
  function).

## Phase status (exactly one status per phase)

| Phase | Status | Evidence |
| --- | --- | --- |
| G0 baseline audit | **PASS** | Branch `newfeature` @ `8d76720`; 48 pre-existing uncommitted entries verified present before and after (73 total entries now = 48 preserved + this workstream's files). No commit, stash, reset or clean at any point. |
| G1 domain model + migration | **PASS** | `shared/vocab-map.ts`, `shared/ai.ts`, v18 migration; schema pins (`tests/database/schema.test.ts`, `maps-schema.test.ts`, pg-release) all green. |
| G2 backend/API | **PASS** | `maps-api.test.ts` 28/28: ownership, idempotency, `If-Match`, no unintended vocabulary creation, all types. |
| G3 reusable viewer/editor | **PASS** | `vocab-maps.test.tsx` (saved-vs-candidate rendering, zoom/pan group, keyboard-reachable list, `main`-scoped page, read-only mode); no new dependency added. |
| G4 eight experiences | **PASS** | One client test per type (table below) + type-specific server validation tests. |
| G5 AI integration | **PASS** | `maps-ai.test.ts` 13/13 (stubbed model, no live key: labels-not-ids, schema-vetted output, seeds saved by canonical id, no silent overwrite, idempotent apply, failure codes); client draft/preview tests; Journey D. |
| G6 integration journeys A–I | **PASS** | `maps-journeys.test.ts` 9/9 (table below). |
| G7 tests + self-correction | **PASS** | `npx tsc --noEmit` clean; `npx eslint .` clean; `npx vitest run` **88 files, 1908 passed, 3 skipped (pre-existing)**; `npm run build` OK; PGlite schema suites green; isolated real PostgreSQL `npm run test:pgrelease` **53/53**. No assertion was weakened during self-correction (log below). |
| G8 lifecycle verification + documentation | **PASS** | Lifecycle covered by Journeys C/H (create → draw → rename → save → delete) and read-only Journey I; four documentation files as listed above; guard tests re-run after doc edits (`frontend-secrets`, `no-notion`: 12/12). |
| G9 single final report | **PASS** | This file — the only report of this workstream. |

## Integration journeys A–I → automated evidence

All in `tests/server/maps-journeys.test.ts` (9/9), each a whole-path
story rather than a unit:

| Journey | Test | Status |
| --- | --- | --- |
| A — every kind from nothing | `opens each of the seven kinds empty and listed, and draws the eighth live without storing it` | **PASS** |
| B — draw, close, return | `keeps words, suggestions, groups, links and positions through a full close-and-return` | **PASS** |
| C — Save Map ≠ Save Word | `walks a map from creation through deletion with the word list changed only by the save press` | **PASS** |
| D — the model drafts and expands | `lands seeds saved and labels as candidates, previews without changing, applies without overwriting, twice` | **PASS** |
| E — looking never learns | `reads lists, documents, the personal view and an unapplied expansion without touching a schedule` | **PASS** |
| F — two accounts | `lists, reads, writes, saves and deletes only its own, and leaves the first untouched` | **PASS** |
| G — retries and races | `creates once for a repeated request id, refuses an outdated change, and lets it in after a re-read` | **PASS** |
| H — words move, maps follow | `walks one word through rename, promotion and diagram deletion with the links intact throughout` | **PASS** |
| I — read-only account | `answers every read and refuses every write, including the model’s` | **PASS** |

## Invariants → evidence

| Invariant | Evidence | Status |
| --- | --- | --- |
| Save Map ≠ Save Word | Journey C; `maps-api` ("refuses the shapes that would blur the line", delete-keeps-words); client save-press test (store grows by exactly one only on `Save as a word`) | **PASS** |
| AI stays candidates until saved | Journey D; `maps-ai` (seeds saved by id, everything else candidate, apply dedupes by label, user edges kept); client preview test (preview changes nothing; apply adds a suggestion, store unchanged) | **PASS** |
| Canonical ids / sense identity, no duplication | `maps-api` (cross-account node refused, sense pinned to its word); schema tests (sense triple key, composite FK refusal 23503) | **PASS** |
| Map persistence independent of word text | `maps-api` "stores no text beside a saved word, and reads the word as it stands now"; Journey H (rename updates live, revision unmoved) | **PASS** |
| No viewing/expansion alters FSRS/mastery/review/Practice/Error Log | Journey E: word entry, `card_states` rows and `review_logs` count byte-identical after list/document/personal/expand-preview reads; client: no review queue is fetched on any map route | **PASS** |
| Schema v13–v18, Library, Review/Undo/FSRS/Practice preserved | Migration additive only; `schema.test.ts`, legacy-compat, full suite 88 files green; pg-release 53/53 on real PostgreSQL | **PASS** |
| Ownership, no cross-account refs | Journeys F; `maps-api` cross-account tests; RLS owner policies (schema tests + anon 42501 probes) | **PASS** |
| Idempotency | Journey G; `maps-api` repeat-creation and natural edge uniqueness | **PASS** |

## One automated test per map type (minimum)

| Type | Automated test(s) | Status |
| --- | --- | --- |
| Semantic | client `semantic: meanings with the relationships that hold for them…`; sense-pinning in `maps-api` | **PASS** |
| Word family | client `word family: the root with what was formed from it, and the words standing alone` | **PASS** |
| Collocation | client `collocation: the combinations as a table…`; `maps-api` "stores a collocation as the combination itself, and insists on one" | **PASS** |
| Thematic | client `thematic: topics as groups, their parts, and the links that cross them` | **PASS** |
| Nuance & contrast | client `nuance: two expressions side by side…`; `maps-api` "insists a contrast has its note" | **PASS** |
| Scenario | client `scenario: one situation in order, reorderable from the list, one kind of link`; `maps-api` scenario-steps test | **PASS** |
| Communicative function | client `communicative function: phrases by what the speaker is doing…` | **PASS** |
| Personal knowledge | client `personal: the library drawn live…`; `maps-api` "has no way to store a personal map"; Journey A (no stored row) | **PASS** |

## Gates (exact commands, final state)

| Gate | Result | Status |
| --- | --- | --- |
| `npx tsc --noEmit` | no output (clean) | **PASS** |
| `npx eslint .` | no output (clean) | **PASS** |
| `npx vitest run` (full suite) | 88 files, **1908 passed, 3 skipped** (skips pre-existing), 331 s | **PASS** |
| `npm run build` | client + server bundles built; only the pre-existing >500 kB chunk warning | **PASS** |
| PGlite schema suites (no instance needed) | `schema.test.ts` + `maps-schema.test.ts` + legacy/atomic suites green | **PASS** |
| Isolated real PostgreSQL (`D:\pgrel012`, local only) | `npm run test:pgrelease` → **53/53** | **PASS** |
| `npx vitest run tests/frontend-secrets.test.ts tests/no-notion.test.ts` (after doc edits) | 12/12 | **PASS** |

Environment note: a single uncapped default `npx vitest run` stalled once
in worker spawning (no test failure; 25-minute tool timeout with zero
output). The same full suite completed deterministically with
`--maxWorkers=4` and in three independent batches (448 / 761 / 702 tests),
all green. Known, harmless noise: the Vite >500 kB chunk warning and
jsdom's `Not implemented: navigation to another Document` log.

## Self-correction log (no assertions weakened)

Fixes made while tests were red or review found a defect — none involved
relaxing a test expectation to make it pass (test-side corrections are
labelled):

1. `withAiErrors()` wrapping both AI routes so every model failure maps to
   a named HTTP status instead of leaking `AiError`.
2. `nodeInput` refuses the blurred shapes explicitly (400): a candidate
   carrying a `vocabularyId`, a saved node carrying a `label`.
3. Migration: `unique (id, user_id)` on nodes for the edges' composite FK;
   `vocabulary_senses` triple key; `personal` excluded by check.
4. `personal()` returns nodes with exactly the strict schema fields.
5. `applySuggestions` label-based dedupe (uuid/request-id bug removed).
6. `createFromDraft` takes `seeds: { words, title }` so the title follows
   the seed word/collection/topic.
7. Expand route captures `const type = map.type` so type narrowing
   survives into the callback.
8. `MapDetail`: `removeNode`, `saveCandidate`, `shiftStep` reload the view
   after writing (it previously stayed stale).
9. `MapExperiences`: word-family roots computed from the link's starting
   endpoint — the root set previously mapped the wrong end, hiding real
   roots (client test `word family: the root…` proves the fix).
10. `MapDetail`: the AI preview closes once applied.
11. Fake API: `generateMap` mirrors `seedsFor` (collection seeds, title
    from seed/collection/topic); `documentOf` computes counts and reads
    saved-node text live.
12. PGlite harness: `bumpVocabMap` safe-parses the RPC's all-NULL no-op row
    and returns null (mirrors the hosted store); test asserts
    `blocked.id === null`.
13. Test-side only: client tests scope page headings to `main` (the shell
    renders its own `h1`); the combined editor test split in two (two
    renders collided); journey layout/`If-Match` reads taken fresh, save
    expects 201, preview and rename-revision baselines captured at the
    right moment; pg-release pin gained the `vocabulary_maps_touch`
    trigger row.

## Checkpoints CP-1 … CP-5

None was triggered; no stop occurred.

- **CP-1 (architecture)**: none — the v18 additive design was the
  sanctioned approach; no existing component was replaced.
- **CP-2 (real data)**: none — tests use PGlite, an isolated local
  PostgreSQL instance, fixtures and stubs only; no real user data.
- **CP-3 (external services)**: none — the model is a stubbed `fetch` in
  tests; no live key, no paid call, no dependency installed (package.json
  untouched by this workstream).
- **CP-4 (learning ownership)**: none — Journey E proves map reads leave
  FSRS/mastery/review evidence byte-identical; no scheduler, Practice or
  Error-Log semantics were changed.
- **CP-5 (repo safety)**: none — no commit, push, reset, clean, deploy or
  remote migration; the 48 pre-existing uncommitted entries are preserved.

## BLOCKED / UNVERIFIED by contract

- **BLOCKED** (contract prohibitions, not attempted): git commit/push,
  `git reset --hard`/`git clean`, deploy, remote/staging/production
  migrations (Supabase), unauthorized dependency installs.
- **UNVERIFIED** (local-only evidence): applying the v18 migration to a
  hosted Supabase project; hosted RLS/grant behaviour; any
  hosted-compatibility claim — the suite ran on PGlite and a local
  PostgreSQL 15432 instance only. Real-browser performance outside jsdom
  was not measured.

## Repository state

- Branch `newfeature` @ `8d76720`, **no commits, no stashes**; everything
  uncommitted, as handed over.
- This workstream's files (untracked or modified, alongside all
  pre-existing work): `shared/vocab-map.ts`, `shared/ai.ts`,
  `supabase/migrations/20261027090000_vocabulary_maps.sql`,
  `server/vocab-maps-service.ts`, `server/vocab-maps-store.ts`,
  `server/supabase/supabase-maps.ts`, `server/ai/map-builder.ts`,
  `server/create-app.ts` (routes + `withAiErrors`), `src/pages/MapsPage.tsx`,
  `src/components/maps/` (canvas, experiences, detail), `src/lib/api-client.ts`,
  `src/App.tsx`, `src/components/AppShell.tsx`, `src/lib/router.ts`,
  `tests/client/vocab-maps.test.tsx`, `tests/server/maps-api.test.ts`,
  `tests/server/maps-ai.test.ts`, `tests/server/maps-journeys.test.ts`,
  `tests/database/maps-schema.test.ts`, pins in `tests/database/schema.test.ts`,
  `tests/server/gateway-versions.test.ts`, `tests/pg-release/migrations.pgtest.ts`,
  `tests/helpers/fake-api.ts`, `tests/helpers/pg-vocabulary-database.ts`,
  `docs/vocabulary-maps.md` + the four documentation integrations,
  and this report.

Documentation debt noted, not taken over: `docs/supabase-schema.md`'s
Versions table had no rows for versions 13–17 before this workstream
(those migrations belong to the senses/security workstreams); only the
v18 row was added here.

---

This is the single deliverable of FC-MAPS-014. The workstream ends here;
no next workstream was started.
