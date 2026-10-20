# FC-RC-FIX-009 — Vocabulary Foundation: Review-Blocking Defect Corrections (RC-001…RC-004)

**Task type:** Correct four review-flagged release-blocking defects in the existing Vocabulary Foundation, then verify
**Mode:** Build / Restricted — local repository modifications and isolated verification only
**Branch / HEAD:** `newfeature` / `8d76720ab0cc21771602574a9aa161d5dcbd9e15` (unchanged; **zero commits made**)
**Date:** 2026-10-16
**Preceded by:** FC-IMPL-005 → FC-VERIFY-006 → FC-HARDEN-007 (`FC-HARDEN-007-REPORT.md`) → FC-RC-008 (`FC-RC-008-REVIEW-PACKAGE.zip`), all preserved uncommitted
**Scope discipline:** corrections only — no feature rewrite, no new Blueprint features, no deploys/commits/pushes; stops after verification and awaits Technical Lead review + Product Owner acceptance

---

## A. Executive Summary

All four release-blocking defects reported at review are **corrected in the existing implementation and verified
locally**. The corrections live almost entirely in **one new additive migration** plus the wiring of the existing
store/service layers to it; no existing function was dropped or altered in place.

### Defects closed

1. **RC-001 — reorder was not DB-atomic (CLOSED).** The hosted store read the version, read the senses, then issued
   one `UPDATE` request *per row* from the application: version check and mutations were separate round trips, so a
   failure mid-loop or a concurrent writer could leave positions half-moved. Now `reorder_vocabulary_senses(uuid,
   jsonb, integer)` performs claim → version check → set check → all moves **as one statement** (one transaction);
   any refusal or failure leaves every position exactly as it was — proven by a poison-trigger rollback test.
2. **RC-002 — primary-sense / legacy-column drift (CLOSED).** Sense operations wrote only `vocabulary_senses` while
   `public.vocabulary.meaning/definition/example` were written only by the legacy `update_vocabulary`, so after any
   sense edit the two disagreed. Now a `vocabulary_senses_sync_content()` trigger derives the three columns from the
   **first live sense** on every sense insert/update/delete (guarded by `is distinct from`, no churn), with a
   one-off reconciliation of existing rows. The senses table is the enforceable source of truth; both read paths
   agree by construction.
3. **RC-003 — partial-import exposure (CLOSED).** Import created a bare word first and its senses afterwards in
   separate calls; a failure between them left a word with zero senses and a stopped report that did not name the
   row. Now `create_vocabulary_with_senses(…, p_senses jsonb)` writes word + card state + every sense **in one
   transaction** (word's own content is nulled when senses are given — "senses are the content" is enforced at the
   DB), the post-create sense pass still runs (idempotent dedup, archive flags, completion of earlier interrupted
   runs), and the stopped report names the interrupted row and the retry contract.
4. **RC-004 — app-level-lock concurrency limits (CLOSED).** Ordering guarantees relied on a per-process mutex and
   app-side `max(position)+1` computation (TOCTOU across instances; races surfaced as `23505` → 503). Now every
   sensitive operation claims the **word row** (`select … for update`) inside the database before checking or
   writing: add/restore/reorder all position under the claim, and `unique (vocabulary_id, position)` remains the
   final backstop. The remaining serialization gap (genuinely simultaneous transactions) is recorded **UNVERIFIED**,
   see §G.

### Verification at a glance

| Gate | Result |
|---|---|
| G0 baseline verified, nothing discarded | **PASS** (`D:\rcfix_g0_baseline.txt`: 81 files, 1759 passed, 3 skipped @ `8d76720`) |
| G1 atomic reorder (transaction, refusal, rollback) | **PASS** — `tests/database/atomic-sense-ops.test.ts` (17 tests) |
| G2 enforceable source of truth + legacy matrix | **PASS** — legacy-column tests + `tests/database/legacy-code-compat.test.ts` (6 tests) + `senses-api`/`schema` suites |
| G3 import failure-injection matrix | **PASS** — 7 new tests in `tests/server/import-senses.test.ts` |
| G4 tsc / eslint / vitest / build | **PASS** — 0 / 0 / **83 files, 1793 passed, 3 skipped, 0 failed** / build OK |
| G5 report | this document — recommendation **READY** (§H) |

### Remaining issues

- **UNVERIFIED:** genuinely simultaneous-transaction behaviour — the local store is a single-connection PGlite
  (`db.as` serialises sessions); no `psql`/`pg_ctl`/`docker`/Postgres service exists locally and CP-3 (install
  infrastructure) was not requested. Sequential-collision coverage is complete and passing; overlapping-transaction
  coverage needs a real PostgreSQL run (CP-2/staging).
- **BLOCKED by contract:** push of migration `20261023090000` to hosted Supabase (CP-2/CP-5) and real-browser E2E
  (CP-3) — neither attempted. **The fix is therefore not live anywhere outside this working tree.**
- **Not locally executable:** the PostgREST gateway in front of the four functions. The `.rpc` calls are typed in
  `database.types.ts`, unknown named arguments are never sent at older schemas, and SQLSTATE propagation is the
  proven v13 pattern (`update_vocabulary`'s `P0003` → `stale` → 409 is already in production code), but the gateway
  hop itself was not re-executed locally.
- Cosmetic only: the pre-existing Vite chunk-size warning (present in the FC-VERIFY-006 baseline).

### Locally release-ready?

**Yes — READY FOR TECHNICAL REVIEW** (§H), scoped to local verification exactly as FC-HARDEN-007 was. The external
blocks (hosted push, real-PostgreSQL concurrency run, browser E2E) remain under their CP gates and are unchanged by
this task.

---

## B. Repository Changes

### Baseline (G0)

- Branch `newfeature`, HEAD `8d76720`, working tree already carrying all prior deliverables (uncommitted).
- Baseline log: `D:\rcfix_g0_baseline.txt` — **81 test files, 1759 passed, 3 skipped** (the 3 skips are the
  pre-existing fixture-gated backup-import skips), exit 0. Nothing was discarded at any point.

### Working-tree summary (end of task)

- HEAD unchanged (`8d76720`), **zero commits**, zero pushes, zero resets/cleans. All prior reports and the FC-RC-008
  review package remain in place.
- Final verification run: **83 test files, 1793 passed, 3 skipped, 0 failed** (1796 total; +34 vs baseline =
  30 new tests + the 4 tests of the schema-14 block that `gateway-versions` gains automatically from the version
  bump).
- Added by **this task**:

| File | Purpose |
|---|---|
| `supabase/migrations/20261023090000_atomic_sense_ops.sql` | v14: four functions, sync trigger, reconciliation, grants, `app_schema_version() = 14` |
| `tests/database/atomic-sense-ops.test.ts` | 17 tests: reorder atomicity/rollback/refusals, add/restore under claim, legacy-column sync, `create_vocabulary_with_senses` |
| `tests/database/legacy-code-compat.test.ts` | 6 tests: version-12 code executed on the newest schema |
| `FC-RC-FIX-009-REPORT.md` | this report |

- Modified by **this task** (targeted edits only):

| File | Change |
|---|---|
| `server/supabase/supabase-database.ts` | `LATEST_SCHEMA_VERSION = 14`; `NewCard.senses`; `createCard` routes to `create_vocabulary_with_senses` when senses are present; `createSense`/`reorderSenses`/`restoreSense` become single `.rpc` calls with `P0002 → not_found`, `P0003 → stale` mapping; guards on those three raised to `< 14` |
| `server/supabase/database.types.ts` | typed `Functions` entries for the four new RPCs |
| `server/supabase/supabase-repository.ts` | `capabilitiesAt`: `senses >= 14`; `createEntry` passes `senses` through |
| `server/vocabulary-catalog.ts` | `NewEntry.senses?` (optional atomicity hint) |
| `server/vocabulary-service.ts` | `create(request, senses?)`; `importBatch` carries derived-sense ids into the row's own write **and always** runs the completion pass; stopped message names the row and the retry contract |
| `shared/api.ts` | `stopped` comment corrected: the row at `index` *was* attempted; the rows after it were not |
| `tests/helpers/pg-vocabulary-database.ts` | PGlite double mirrors the store: same four calls, same guards, same error mapping |
| `tests/helpers/fake-catalog.ts` | drops the `senses` field it cannot honour (fillSenses creates them, as before) |
| `tests/database/schema.test.ts` | one test setup corrected (see §E) |
| `tests/server/import-senses.test.ts` | +7 tests: 6 failure-injection, 1 schema-13 refusal |

- **Untouched by design:** `server/mock/mock-repository.ts` never reads `NewEntry.senses` (the field is ignored
  there by construction); Review/FSRS/Undo/Practice logic, API routes' shapes, and every prior report/package are
  unchanged.

---

## C. Execution Gates

### G0 — Baseline verification: **PASS**

Baseline captured before any change (`D:\rcfix_g0_baseline.txt`, 1759 passed / 3 skipped, exit 0). All prior
work preserved; HEAD untouched.

### G1 — Atomic reorder: **PASS**

`reorder_vocabulary_senses(p_vocabulary_id, p_sense_ids, p_expected_version)` — one statement: claim the word row
(`for update`, ownership + `deleted_at is null`) → version check (`P0003` → 409 stale) → live-sense set check
(length + distinct + no nulls + all live, else `22023` → 400 invalid) → lift positions by +1000 → place live senses
by the order sent → pack archived behind, in their relative order. Executed tests (all on the local isolated
database):

- `moves the live senses into the order sent, packs the archived behind, and keeps identities` — ids, archive
  state, versions and content unchanged; only positions moved.
- `rolls every position back when one move inside it fails` — a poison trigger fired mid-function leaves **every**
  position exactly as it was (full rollback).
- `refuses an order that omits a sense, repeats one, or names another word's` → `22023`/400, positions unchanged.
- `refuses another account's word, a word in the trash, and a caller who is not signed in` → `P0002`/RLS/`28000`
  (ownership and soft-delete enforced inside the function).
- `refuses a reorder whose version is current but whose list missed a sense added in between` → stale-style
  refusal, not a routed-around write.
- Restore under claim: `brings a sense back past the others and refuses a version that has moved on`,
  `refuses a restore of another account's sense`, `a restore that lands between reading and reordering is refused,
  not routed around`.
- RC-004 evidence: the app-level mutex is no longer load-bearing — position selection happens under the DB claim
  (`add_vocabulary_sense`: `max+1` computed after `for update`), and the FC-HARDEN-007 sequential-collision suite
  (add-vs-reorder, restore-vs-add, archive-vs-update both directions, legacy-vs-sense edit) still passes unchanged.

### G2 — Enforceable source of truth: **PASS**

The senses table is the source; the three legacy columns are a **trigger-maintained projection of the first live
sense** (all archived → `NULL`s), reconciled once for existing rows, and every writer either goes through the new
functions or fires the trigger. The contract's matrix, all executed:

| Required test | Where it runs |
|---|---|
| Legacy PATCH on the primary | `schema.test.ts > update_vocabulary` (6 tests in the 44-test file); `legacy-code-compat > edits content through update_vocabulary…` (base table, view **and** first live sense all agree afterwards) |
| New API primary-sense edit | `senses-api.test.ts > updates a sense…` (+ stale 409, 404) |
| Archive of the primary | `senses-api.test.ts > archives a sense without losing it, and the shown meaning follows the first live one` (archives `senses[0]`, view meaning follows) |
| Restore of the primary | same test restores that primary sense; `refuses a restore captured before the archive, then accepts one and keeps adding behind it` (stale → accept → add behind) |
| Reorder of the primary | `senses-api.test.ts > reorders the live senses, packs the archived ones behind, and refuses a wrong or stale order`; `atomic-sense-ops` moves-the-live-senses test |
| View read after each operation | `atomic-sense-ops > stays with the view after an archive, a restore, a reorder, a legacy edit and a sense edit`; `agrees across every read path an older reader has` |
| Legacy DB-path read (`public.vocabulary`) | same tests via `legacyColumns()`; `leaves a word whose senses are all archived showing nothing, columns and view alike` |
| **Old app code on the new schema, executed** | `legacy-code-compat.test.ts`: twelve-positional-arg `create_vocabulary`; request-id repeat; `update_vocabulary` text patch; trash/restore through `vocabulary` itself; `cardColumns(12)` view reads (live and trashed lists, as v12 selected them); a word rearranged by the newer endpoints read by the old reader; cross-account view isolation |

Compatibility notes: `create_vocabulary`/`update_vocabulary` signatures untouched; `cardColumns(12)` (the exact v12
select list) returns every column old code asked for; `readMigrations()` length and `LATEST_SCHEMA_VERSION` agree
by construction (14); `gateway-versions.test.ts` runs the whole gateway request set against **every** schema
catalogue 1…14.

### G3 — Import failure-injection matrix: **PASS**

New tests in `tests/server/import-senses.test.ts` (failures injected through the existing `wrap` seam):

| Injected failure | Assertion |
|---|---|
| `createCard` fails on row 2 of 3 | rows 0 done, **row 1 named**, `stopped.index = 1`, message contains "incomplete" + retry contract; row 1 absent entirely; retry → `already_imported, imported, imported`, no doubles |
| `createSense` fails on a fresh senses-row | the interrupted word exists **with all senses it named** (pre-fix this is the RC-003 bare-word symptom); retry → `already_imported`, one word |
| `archiveSense` fails | both senses stored, only the archive flag missing; retry lands the flag, no duplicates |
| failure, then the owner adds their own sense before retrying | owner's sense keeps its place at the end; the file's rows complete around it; nothing overwritten |
| failure, then the owner edits an imported sense, then retries | the owner's edit survives the retry |
| duplicate request id, different payload | `already_imported`, the first import's senses untouched, no second word |
| schema-13 database with current code | sense endpoint → `409 not_supported`; senses-carrying import row → `invalid`, word not half-made |

Plus the DB-level atomicity tests: `writes the word, its card state and every sense in one call`,
`leaves no word, no card state and no senses when one sense cannot be stored` (transaction rollback), and
`answers a repeated request id with the word that landed, and does not rewrite its senses` (dedup across the
atomic path).

### G4 — Local gates: **PASS**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx eslint .` | 0 problems |
| `npx vitest run` | **83 files, 1793 passed, 3 skipped, 0 failed** |
| `npm run build` | vite client build + esbuild server bundle OK (pre-existing chunk-size warning only) |

- **Isolated local database:** every test creates its own PGlite database from `supabase/migrations` (test
  helpers only); no remote database was touched.
- **Negative tests:** foreign account, trashed word, anonymous caller, stale version (pre- and post-move), set
  violations (omitted / repeated / foreign / null sense ids), list-vs-store mismatch, unknown import row fields,
  repeated-id different payload, schema-12 and schema-13 refusals.
- **PGlite vs real PostgreSQL — stated plainly:** PGlite *is* PostgreSQL (ElectrumPG/WASM) — SQL, plpgsql, triggers,
  `raise … using errcode`, `select … for update`, unique indexes and RLS all behave as in PostgreSQL, and every
  function/test above **was executed** against it. What PGlite cannot provide here is (a) a second concurrent
  connection — sessions are serialised, so overlapping-transaction behaviour is **UNVERIFIED**, and (b) the
  PostgREST gateway hop in front of the functions — **not locally executed** (see §A/§G). Sequential collision
  coverage (two calls one after the other) is complete; simultaneous coverage is not claimed.

### G5 — Report: **PASS** (this document)

---

## D. Verification Evidence

### Defect → inspection → fix → tests

| # | What the old code did (G0 inspection) | What runs now | Pinned by |
|---|---|---|---|
| RC-001 | hosted `reorderSenses`: separate `select senses_version`, separate full read of senses, then one `UPDATE` HTTP request per row (each its own transaction) — no single transaction covered check + moves; `+1000` lifting could be observed half-done by another reader | one `rpc('reorder_vocabulary_senses', …)` / `select public.reorder_vocabulary_senses(…)` call; claim → checks → moves in one statement | poison-trigger rollback test; moves/identities test; 3 refusal tests; stale tests (pre/post) |
| RC-002 | `add/update/archive/restore/reorder` wrote only `vocabulary_senses`; `vocabulary.meaning/definition/example` updated only by `update_vocabulary` — after a sense op the base table and view showed stale text | `vocabulary_senses_sync_content()` trigger (first live sense → three columns, `is distinct from` guard) + one-off reconciliation | legacy-columns describe (3 tests), `legacy-code-compat` rearranged-word test, `schema.test.ts` update suite, full `senses-api` |
| RC-003 | `importBatch`: `createEntry` (bare word) → later `fillSenses` (N inserts); failure between them = word with zero senses; stopped message generic | `create_vocabulary_with_senses` writes word+state+senses in one transaction; derived-sense ids identical on both passes; completion pass always runs; stopped message names row + retry contract | G3 matrix (6 failure tests) + DB rollback/dedup tests |
| RC-004 | per-process `KeyedMutex`; `max(position)+1` read then insert app-side; races turned into `23505 → 503` instead of being prevented; no DB-side claim | every function claims the word row `for update` first (ownership/soft-delete per operation); positions chosen under the claim; `unique (vocabulary_id, position)` backstop | add-under-claim tests; restore-under-claim tests; FC-HARDEN-007 collision suite (still green); G3 owner-intervention test |

### Error mapping (unchanged externally, new sources)

| SQLSTATE | Source | Store result | HTTP |
|---|---|---|---|
| `P0003` | version check inside reorder/restore | `'stale'` | 409 conflict (service message) |
| `P0002` | word/sense not found or not this account | `'not_found'` (reorder/restore), `DatabaseError('invalid')` (add) | 404 / 400 |
| `22023` | set check in reorder, unknown field | `toDatabaseError → invalid` | 400 |
| `23505` | backstop unique index | `toDatabaseError` (conflict) | 409 |
| `40P01` | deadlock detected (see §G R-5) | `toDatabaseError → unavailable` | 503 explicit |

### Concurrency evidence

- Sequential collisions: FC-HARDEN-007's five collision tests + this task's claim tests — **all passing**.
- Simultaneous transactions: **not executable locally** (single connection) → UNVERIFIED, §G R-2.

---

## E. Safety Assessment

- **Stop conditions honoured.** No hosted/staging data touched; **no remote migration pushed** (CP-2/CP-5
  BLOCKED); **no PostgreSQL/Docker/dependency installed** (CP-3 not requested); **no destructive schema change**
  (v14 is additive: `create or replace` functions, one trigger, grant statements, version bump — no column/table
  dropped or retyped); **no Review/FSRS/Undo/Practice changes**; **no API shape change** (same routes, same
  response schemas; only a new optional field on an internal type and one corrected comment); **no commit, push,
  reset, clean, or deploy**.
- **Local authorization used:** one additive migration correction + local Vocabulary-Foundation tests, exactly as
  granted.
- **One pre-existing test setup corrected (disclosed).** `schema.test.ts > update_vocabulary` seeded a word's
  meaning by writing the *base columns only* — creating precisely the drift RC-002 now forbids — and expected a
  later patch to preserve it. The setup now gives the word its content through its first sense (the way the app
  stores it). **No assertion was weakened**: the test still proves "writes only the keys given"; it now proves it
  on a word that is internally consistent. Every other assertion in the file is unchanged.
- **Behaviour change to disclose to Product:** a database still at schema 13 now has its sense endpoints refused
  (`409 not_supported`) instead of being served by code that would drift — tested at `migrations: 13`. Words,
  legacy edits and everything older than senses are unaffected. Rationale: partial support was the defect.
- **Data safety:** the reconciliation UPDATE only rewrites the three legacy columns to what the senses already
  say; it cannot lose content (the senses are the content) and does not touch schedules, review state, FSRS or
  undo history. Function/trigger changes are replaceable by re-running an earlier migration state — no irreversible
  step is baked in.

---

## F. Acceptance Matrix

| Contract item | Status | Evidence |
|---|---|---|
| G0 baseline verified; no work discarded | **PASS** | `D:\rcfix_g0_baseline.txt`; HEAD `8d76720`; all prior files present |
| G1 reorder: one transaction, version + mutation together | **PASS** | `reorder_vocabulary_senses` single statement; poison-trigger rollback test |
| G1 ownership + soft-delete enforced inside the function | **PASS** | foreign-account / trashed / anonymous refusal tests |
| G1 identities, archived senses, positions preserved | **PASS** | moves/identities test (ids, versions, content, archive state asserted) |
| G1 stale version → explicit conflict | **PASS** | `P0003 → 'stale' → 409` tests (reorder + restore) |
| G2 source-of-truth enforceable (trigger + reconciliation) | **PASS** | legacy-columns describe; all-read-paths test; all-archived test |
| G2 legacy PATCH, new API edit, archive/restore/reorder of primary, view, legacy DB read | **PASS** | matrix in §C-G2 |
| G2 old-code/new-DB executed | **PASS** | `legacy-code-compat.test.ts` (6 executed tests) |
| G2 IDs, Review/FSRS/Undo preserved | **PASS** | id-stability tests; Review/FSRS/Undo suites untouched and green |
| G3 failure-injection matrix; no mistaken partial success | **PASS** | 6 injected-failure tests + DB transaction tests (§C-G3) |
| G3 minimal correction / architecture checkpoint respected | **PASS** | single additive migration; no architecture change |
| G4 tsc / eslint / vitest / build | **PASS** | §C-G4 numbers |
| G4 isolated local DB; negative tests | **PASS** | per-test PGlite DBs; negative list in §C-G4 |
| G4 PGlite-sequential vs real-PostgreSQL distinguished | **PASS** | §C-G4 statement; §G R-1/R-2 |
| G5 report, 9 sections, READY/PARTIAL-BLOCKED/FAILED | **PASS** | this document |
| Stop after corrections and verification | **PASS** | no deploys/commits/pushes; awaiting TL review + PO acceptance |
| FC-RC-008 package preserved | **PASS** | `FC-RC-008-REVIEW-PACKAGE.zip` + all prior reports unchanged |
| FC-HARDEN-007 statuses/CP conditions respected | **PASS** | CP-1…CP-5 untouched; BLOCKED/UNVERIFIED items carried forward unchanged |

---

## G. Risk Register

| ID | Risk | Severity | Status |
|---|---|---|---|
| R-1 | v14 functions proven on PGlite (real PostgreSQL/WASM) but never on hosted/managed PostgreSQL; subtle planner/RLS/grant differences possible | Medium | **UNVERIFIED locally** / push BLOCKED (CP-2/CP-5) |
| R-2 | Simultaneous-transaction races (overlapping connections) not executed — local store is single-connection | Medium | **UNVERIFIED** — needs real PostgreSQL run (carried from FC-HARDEN-007) |
| R-3 | The fix exists only in the working tree; migration never pushed, nothing deployed | Medium | **BLOCKED** (CP-2/CP-5) — deliberate |
| R-4 | PostgREST hop (`.rpc`, SQLSTATE propagation, `p_senses` arg shape) not re-executed locally; typed + precedent-based | Medium | **UNVERIFIED** locally — precedent: v13 `P0003` handling already in production code |
| R-5 | Deadlock window: app-layer archive/update take sense-row→word locks while the new functions take word→sense. PostgreSQL detects (`40P01`), one side aborts → mapped to explicit 503, nothing corrupted; all *required* pairs (Add/Reorder, Restore/Reorder) are word-first functions so they cannot deadlock with each other | Low | **Accepted & documented** |
| R-6 | Schema-13 databases now refuse sense work (behaviour change from the v13-era code) — intended, tested, needs Product visibility | Low | Documented (§E) |
| R-7 | Real-browser E2E of the import/restore UI flows not run | Low | **BLOCKED** (CP-3) — carried from FC-HARDEN-007 |
| R-8 | No deployment/rollback drill performed | Low | **BLOCKED** by task rules |

### External verification checklist (for the reviewer)

1. Push `supabase/migrations/20261023090000_atomic_sense_ops.sql` to a staging Supabase, confirm
   `app_schema_version() = 14` and the four functions exist with `execute` for `authenticated` only (CP-2).
2. Run the sense concurrency suite against real PostgreSQL with ≥2 connections (closes R-1/R-2).
3. Exercise one `.rpc`-based add/reorder/restore through PostgREST and confirm `error.code` carries `P0003`/`P0002`
   (closes R-4).
4. Browser pass: import a senses-carrying file, kill the connection mid-run, confirm the stopped report and retry
   (closes R-7).

---

## H. Final Recommendation

# READY FOR TECHNICAL REVIEW

All four release-blocking defects (RC-001…RC-004) are corrected in the existing implementation, every gate that
local infrastructure can execute passes with recorded evidence (G0–G4 **PASS**; final run: `tsc` 0, `eslint` 0,
vitest **1793 passed / 3 skipped / 0 failed**, build OK), and no boundary was crossed: zero commits, zero pushes,
no remote migration, no installed infrastructure, no destructive schema change.

The recommendation is explicitly **local** readiness: R-1/R-2 (real-PostgreSQL and simultaneous-transaction
behaviour), R-3/R-4 (hosted push and PostgREST hop), and R-7/R-8 (browser E2E, deployment) remain outside this
task's authorised scope and are listed for the Technical Lead's review and the Product Owner's acceptance — as
were their counterparts in FC-HARDEN-007.
