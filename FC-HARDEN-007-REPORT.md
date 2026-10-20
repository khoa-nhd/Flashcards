# FC-HARDEN-007 — Vocabulary Foundation: Data Integrity & Release Hardening

**Task type:** Large Implementation + Verification + Correction
**Mode:** Build / Restricted — local repository modifications and isolated verification only
**Branch / HEAD:** `newfeature` / `8d76720ab0cc21771602574a9aa161d5dcbd9e15` (unchanged; **zero commits made**)
**Date:** 2026-10-16
**Preceded by:** FC-IMPL-005 (implementation) and FC-VERIFY-006 (verification, `FC-VERIFY-006-REPORT.md`)

---

## A. Executive Summary

### Delivered

1. **R-1 CLOSED — multi-sense export/restore (Scope A / G1).** The supported restore path
   (account export → Import page → `POST /api/vocabulary/import`) now carries **every sense
   of every word**: content, order, and archive state. The design extends the *existing*
   import path rather than adding a second one (no duplicate mutation paths, no second
   source of truth), makes each sense's request id deterministic from the row's id (retries
   and interrupted runs land on the same records), refuses a sensed row **whole** if the
   database cannot store senses or the file is malformed (never imports a word stripped of
   its senses), and never overwrites anything that already exists. Documented as a
   **vocabulary-content restore**, explicitly not a full-account recovery.
2. **Concurrency hardening (Scope B / G2).** Five new sequential-collision tests close every
   gap in the contract's list (different-sense edits, add-vs-reorder, archive-vs-update both
   directions, restore-vs-add, legacy whole-word edit vs sense edit), on top of the existing
   idempotency/stale/RLS tests. Local environment was **determined not to hold a genuine
   multi-connection PostgreSQL** (no `psql`/`pg_ctl`/`initdb`/`docker`/`podman`, no Postgres
   service, no listener on 127.0.0.1:5432 or 54321) — so **simultaneous-transaction safety is
   recorded UNVERIFIED**, not claimed. Installing infrastructure would need CP-3 approval and
   was not requested.
3. **Migration and compatibility audit (Scope C).** New executed tests: backfill reaches
   **trashed** rows; sensed import refused on a pre-v13 database while legacy import still
   works; v12→v13 upgrade on a populated store. Old-code/new-db verified by inspection of
   the migration (additive column with default; view keeps all 23 prior columns with names,
   types and positions and appends 2; `create_vocabulary`/`update_vocabulary` parameter
   lists unchanged). Review/FSRS/Undo/Practice files untouched.
4. **All 8 user journeys verified (Scope D)** on the existing jsdom infrastructure — two of
   them by new tests (export→restore round trip through the UI; conflict feedback for both
   sense edits and word saves). **No testing framework installed.**
5. **Docs corrected:** `docs/import-and-export.md` now describes the real behavior (all
   senses restored; CSV/legacy = leading sense only; content-only boundary; no-silent-
   overwrite rules), replacing the R-1 limitation note.

### Remaining issues

- **UNVERIFIED:** simultaneous-transaction (truly overlapping) race behavior — local store
  is single-connection; needs a real Postgres run (approval CP-2/staging).
- **BLOCKED by contract:** migration push to hosted Supabase (CP-2/CP-5) and real-browser
  E2E (CP-3) — neither attempted.
- Cosmetic only: one pre-existing Vite chunk-size warning (present in FC-VERIFY-006 baseline).

### Locally release-ready?

**Yes — READY FOR TECHNICAL REVIEW.** Every acceptance criterion that local infrastructure
can execute passes with recorded evidence. This is *local* readiness only; see §H.

---

## B. Repository Changes

### Baseline

- Branch `newfeature`, HEAD `8d76720` — **same at start and end; `git log` shows no new commits.**
- At entry: 20 modified files (+1760/−28) from FC-IMPL-005/FC-VERIFY-006, plus untracked
  `FC-VERIFY-006-REPORT.md`, pre-existing `OPENCODE_AUDIT_REPORT.md`, the v13 migration and
  three test files. **All preserved, none overwritten.**

### Working-tree summary (end of task)

```
24 files changed, 2007 insertions(+), 38 deletions(-)   (git diff --shortstat; tracked files)
```

Tracked-file delta attributable to FC-HARDEN-007: **+247 / −10** across
`shared/api.ts`, `shared/import.ts`, `server/vocabulary-service.ts`, `src/pages/ImportPage.tsx`,
`docs/import-and-export.md`, `tests/client/import.test.tsx`, `tests/client/vocabulary-pages.test.tsx`,
`tests/server/senses-api.test.ts`, `tests/client/sense-ui.test.tsx`.

**Files created by this task**

| File | Purpose |
|---|---|
| `server/request-id.ts` | `derivedRequestId(parent, label)` — deterministic uuid-v5-shaped child ids (sha1) for senses inside one import row |
| `tests/server/import-senses.test.ts` | G1 round-trip suite (15 tests) |
| `FC-HARDEN-007-REPORT.md` | This report |

**Files newly modified by this task** (on top of the FC-VERIFY-006 set): `shared/import.ts`,
`src/pages/ImportPage.tsx`, `tests/client/import.test.tsx`, `tests/client/vocabulary-pages.test.tsx`
(plus edits inside previously modified `shared/api.ts`, `server/vocabulary-service.ts`,
`docs/import-and-export.md` and the two untracked FC-VERIFY test files).

**Pre-existing work confirmed intact:** `FC-VERIFY-006-REPORT.md` and `OPENCODE_AUDIT_REPORT.md`
unchanged; migration `20261022090000_vocabulary_senses.sql` unchanged by this task (audited only).

---

## C. Execution Gates

### G0 — Baseline verification: **PASS**

- `git branch --show-current` → `newfeature`; `git rev-parse HEAD` → `8d76720…` — unchanged.
- Node/npm verified at the reported location: `D:\New folder\node.exe` **v24.22.0**,
  `npm.ps1` **11.19.1** (used via `$env:PATH += ";D:\New folder"` for every command).
- Baseline independently reproduced (previously agent-reported only): `npx vitest run`
  → **exit 0 — 80 files, 1735 passed, 3 skipped** (log: `D:\harden_g0_baseline.txt`).
  The 3 skips are the pre-existing fixture-gated backup-import describe (needs a local
  `backups/` directory), unchanged before and after.
- Environment probed for G2: `Get-Command pg_ctl,initdb,psql,docker,podman` → none found;
  `Get-Service *postgres*` → none; `Test-NetConnection 127.0.0.1 -Port 5432` → False;
  port 54321 → False. **No genuine multi-connection PostgreSQL is available locally.**

### G1 — Data Portability: **PASS**

Gate rule satisfied: *an executed round-trip test demonstrates secondary senses survive
restoration* — 15 tests in `tests/server/import-senses.test.ts`, all green in the final run.

**Design (extend, don't duplicate):**

1. **Wire format** — `importItemSchema` gains optional `senses` (strict per-sense schema;
   `MAX_SENSES` moved to `shared/api.ts` as the single source of truth). Additive; every
   existing request shape still validates.
2. **One mutation path** — `VocabularyService.importBatch` (the existing import endpoint)
   now, for a row carrying senses: creates the word **without** content (the senses *are*
   the content — the row's four content fields are not stored twice), then creates each
   sense in order under `derivedRequestId(rowRequestId, "sense:N")`, inside the same
   `sense:<id>` lock the editor uses, and archives exactly those flagged `archived`
   (never un-archives, never updates an existing sense).
3. **Idempotency & crash continuation** — vocabulary `unique(user_id, request_id)` plus
   senses `unique(user_id, request_id)` and the deterministic derived ids mean a resent
   batch lands on the same rows; a run interrupted between word and senses completes on
   retry instead of doubling (both proven by test).
4. **Capability gate** — a sensed row on a pre-v13 database is refused **whole**
   (`invalid` + clear message, word not created), never imported stripped of senses.
   Rows without senses import on v12 exactly as before.
5. **Client pipeline** — `parseImportText` carries `senses` per row from this app's own
   JSON export (record metadata `id`/`position`/`version` stripped — they belong to the
   source account; the four restorable fields passed as written so the server's strict
   schema rejects junk), `toImportRows`/`checkRows`/`ImportPage.toItems` pass them through,
   `rowProblem` checks them in the browser before anything is sent, and the preview shows
   “· N senses”.
6. **Boundary** — content-only: mastery, review dates, history, collections and settings are
   not accepted from a file (unchanged, deliberate). The Notion/backup system is untouched.
   Documented in `docs/import-and-export.md` (“vocabulary-content restore, not a full-account
   recovery”; CSV and pre-sense JSON = leading sense only).

**Corrections made during G1 (in scope):** parser stripped export metadata (v1 — rows were
wrongly rejected as strict-schema violations); test-side fixes only afterwards (PATCH vs POST
on the order endpoint; case-insensitive word count; trashed-row read via rows not the live view).

### G2 — Concurrency Hardening: **PASS (with one explicitly UNVERIFIED element)**

- **Environment determination (contract requirement):** no Postgres client binaries
  (`psql`, `pg_ctl`, `initdb`), no `docker`/`podman`, no Postgres Windows service, no
  listener on 127.0.0.1:5432/54321. The test store is PGlite, **in-process and
  single-connection** — genuinely simultaneous transactions cannot be produced. Installing
  PostgreSQL/Docker would require CP-3 approval → **not requested**.
- **Contract's scenario list → executed coverage** (all in `tests/server/senses-api.test.ts`,
  21/21 green; sequential by design, stated as such):

  | Scenario | Evidence |
  |---|---|
  | Add Sense idempotency | existing “lands once when the same add is retried with the same request id” |
  | Same-sense concurrent edits | existing “updates a sense, and refuses a change still made against the old version” (stale → 409 `conflict`) |
  | Different-sense edits | **new** “edits two different senses without either disturbing the other” |
  | Add vs reorder | **new** “refuses a reorder captured before an add, and accepts the current version” |
  | Archive vs update | **new** both directions: stale archive after edit → 409; stale edit after archive → 409; archived sense not editable even at current version |
  | Restore vs add | **new** “refuses a restore captured before the archive, then accepts one and keeps adding behind it” (restore-to-end, then append) |
  | Legacy primary-field vs sense update | existing write-through test + **new** “refuses a sense edit written against the version a whole-word edit has moved on from” |
  | Concurrent retries & version conflicts | existing add-retry idempotency, `expectSensesVersion` conflict, P0003→409 mapping + import-batch retry tests (G1) |

- **Coherence audit:** single write path (HTTP operation endpoints) unchanged; CAS via
  `version` in the SQL `WHERE`; `unique (vocabulary_id, position)`; `unique (user_id, request_id)`
  on both tables; entry-level `senses_version`; service lock `sense:<id>` shared by editor
  and import fill. No duplicate mutation paths introduced.
- **UNVERIFIED:** properties that require two transactions overlapping in time. Not claimed
  from sequential tests, per contract.

### G3 — Full Regression: **PASS**

Order: targeted → full → typecheck → lint → build; all task-related failures fixed inside
scope (one, in G3 itself: a type-only cast in `shared/import.ts`, TS2345).

### G4 — Release Readiness Assessment: **PASS**

This report is the review handoff (§§ D–H). **It is not deployment authorization.**

---

## D. Verification Evidence

Exact commands (run from the repository root with `D:\New folder` on PATH), exit codes and outcomes:

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npx vitest run` (G0 baseline) | 0 | 80 files — **1735 passed, 3 skipped**, 174.5s |
| 2 | `npx tsc --noEmit` (post-implementation) | 0 | 0 errors |
| 3 | `npx vitest run tests/server/import-senses.test.ts` | 1→1→**0** | run 1: 9 failed (parser passed export metadata into strict schema, +3 test bugs); run 2: 2 failed (test bugs: POST vs PATCH reorder, case filter, trashed read); run 3: **15/15 passed** |
| 4 | `npx vitest run tests/server/senses-api.test.ts` | 1→**0** | run 1: 2 failed (restore-to-end position expectation, migrate-twice on shared store); run 2: **21/21 passed** (15 existing + 5 collision + 1 trashed-backfill) |
| 5 | `npx vitest run tests/client/import.test.tsx tests/client/sense-ui.test.tsx` | 1→**0** | run 1: 1 failed (ambiguous `Cancel` query); run 2: **36/36 passed** |
| 6 | `npx vitest run tests/client/vocabulary-pages.test.tsx` | 0 | **38/38 passed** (incl. new word-save conflict test) |
| 7 | `npx vitest run` (G3 targeted, 8 suites) | 0 | 8 files — **182 passed, 3 skipped** |
| 8 | `npx vitest run` (G3 full) | 0 | 81 files — **1758 passed, 3 skipped** |
| 9 | `npx tsc --noEmit` (G3) | 2→**0** | 1 error `TS2345 shared/import.ts:178` found and fixed (type-only cast, runtime unchanged) |
| 10 | `npx eslint .` (G3, both runs) | 0 | clean |
| 11 | `npm run build` (G3) | 2→**0** | run 1 failed only at the typecheck gate (#9); after fix: `vite build` + `esbuild server/index.js` 253.3kb OK, one pre-existing cosmetic chunk warning |
| 12 | **`npx vitest run` (FINAL)** | **0** | **81 files — 1759 passed, 3 skipped, 0 failed**, 157s |
| 13 | **`npx tsc --noEmit` (FINAL)** | **0** | 0 errors |
| 14 | **`npx eslint .` (FINAL)** | **0** | clean |
| 15 | **`npm run build` (FINAL)** | **0** | typecheck + client bundle + server bundle OK |

Test accounting: baseline **1735 → 1759 = +24 new tests**
(15 import-senses + 6 senses-api + 1 import journey + 1 sense-ui journey + 1 vocabulary-pages journey).
Skips stay at the pre-existing 3 (fixture-gated backup-import).

Logs: `D:\harden_g0_baseline.txt`, `D:\g1_run1-3.txt`, `D:\g2_run1-2.txt`,
`D:\scopeD_run1-2.txt`, `D:\g3_targeted.txt`, `D:\g3_full.txt`, `D:\journey8b.txt`,
`D:\final_vitest.txt`, `D:\final_build.txt`.

### §10 Verification Requirements — all **executed** (not asserted from code)

| # | Requirement | Status | Executed evidence |
|---|---|---|---|
| 1 | Export and restore one sense | **PASS** | import-senses: “brings back a word with a single sense exactly as it was stored, as content” |
| 2 | Export and restore multiple senses | **PASS** | “brings back every sense of a word, each with its own content” (3 senses, content + counts) |
| 3 | Preserve sense ordering | **PASS** | “keeps an order the owner changed, not the order the senses were added in” (reorder → export → restore keeps sequence) |
| 4 | Preserve archived senses | **PASS** | “keeps archived senses flagged, and the first live sense as the shown meaning” |
| 5 | Minimal-profile round-trip | **PASS** | “round-trips the minimal profiles: a bare word and a word with one field” |
| 6 | Legacy export/import compatibility | **PASS** | “reads a JSON export made before senses existed…”; “reads the CSV export, which carries only the shown meaning of each word”; v12 refusal test (legacy rows still import) |
| 7 | Malformed input rejection | **PASS** | “refuses each bad row on its own and writes none of it” (unknown field / oversize / 26 senses / wrong types → `invalid`, word never created); browser-side “spots an unusable sense in the file itself” |
| 8 | Duplicate restoration retry | **PASS** | “lands a second run of the same items on the same senses instead of doubling them”; “finishes a run that stopped between the word and its senses” |
| 9 | Restoration into overlapping vocabulary | **PASS** | “leaves an overlapping word untouched, and a chosen duplicate becomes its own copy” (ids/versions unchanged; forced copy gets its own senses) |
| 10 | Stale same-sense update | **PASS** | senses-api “updates a sense, and refuses a change still made against the old version” → 409 `conflict` |
| 11 | Add/reorder conflict | **PASS** | senses-api **new** “refuses a reorder captured before an add, and accepts the current version” |
| 12 | Archive/update conflict | **PASS** | senses-api **new** “refuses an archive captured before the edit, and an edit captured before the archive” |
| 13 | Legacy primary-sense update | **PASS** | senses-api “writes an edit of the shown meaning through to the first live sense” + **new** stale-sense-edit-after-word-edit test |
| 14 | Cross-account access rejection | **PASS** | import-senses “restores only into the account that imported…” (404 cross-reads) + existing “keeps one account’s senses out of another’s reach” |
| 15 | Trashed vocabulary compatibility | **PASS** | import-senses “brings a trashed word’s senses back with its content, as a live word” + **new** migration test “gives a word already in the trash its senses too” (backfill on soft-deleted rows, read from the table itself) |
| 16 | Review, FSRS, Undo, Practice regression | **PASS** | FINAL full suite 1759 passed / 0 failed; none of their files touched by this task’s diff |

### Scope D — the 8 user journeys (existing jsdom infrastructure; nothing installed)

| # | Journey | Status | Evidence |
|---|---|---|---|
| 1 | Save a minimal word | **PASS** | `vocabulary-pages.test.tsx` (green in final run) |
| 2 | Add multiple senses | **PASS** | `sense-ui.test.tsx` “adds a sense, and shows it once the server has” |
| 3 | Edit senses | **PASS** | `sense-ui.test.tsx` “edits a sense against its version…” + new conflict test |
| 4 | Reorder senses | **PASS** | `sense-ui.test.tsx` “moves a sense down the order…” |
| 5 | Archive and restore senses | **PASS** | `sense-ui.test.tsx` “archives a sense without losing it” + server restore tests |
| 6 | Duplicate word → add as sense | **PASS** | `sense-ui.test.tsx` “a duplicate only the server knows about is also offered as a sense” |
| 7 | Export multi-sense data and restore it | **PASS** | **new** `import.test.tsx` “sends every sense home again: export, preview, confirm, send” — real export button → downloaded JSON → pasted preview (“2 senses” shown) → confirmed send carries ordered senses with archive flags, and **not** the source ids/versions |
| 8 | Stale edit → clear conflict, newer change preserved | **PASS** | **new** `sense-ui.test.tsx` (sense 409 → “This sense was modified elsewhere…”, one attempt, no refresh, draft not written) + **new** `vocabulary-pages.test.tsx` (word save 409 → clear message, form keeps draft, word unchanged after cancel) + API-level `expectSensesVersion` conflict tests |

---

## E. Safety Assessment

- **RLS and account isolation — holds (executed).** New `vocabulary_senses` table:
  `user_id default auth.uid()`, RLS enabled, FK cascade, `grant select/insert/update` only.
  Cross-account reads/writes → 404 (existing + new tests); restore writes only under the
  importing owner (new test reads the source account after and finds it untouched, and the
  copy unreadable from the source).
- **Data preservation — holds (executed).** Overlap test: existing senses/ids/versions
  byte-identical after a restore attempt; trash test: trashed rows keep their senses while
  a copy is restored elsewhere; malformed rows never create half a word; `fillSenses` only
  adds and only archives when flagged (never updates or un-archives existing senses), so an
  edit made after an interrupted import survives the rest of it.
- **Mutation idempotency — holds (executed).** `unique (user_id, request_id)` on both
  vocabulary and senses; derived child ids are deterministic per row; batch retry →
  `already_imported` with identical sense ids and unchanged `senses_version`; interrupted-run
  continuation proven.
- **Concurrency — sequential matrix PASS; simultaneous transactions UNVERIFIED** (single-DB
  connection locally; see G2). Sequential tests are not presented as proof of overlap safety.
- **Legacy compatibility — holds (executed + inspected).** Pre-sense JSON and CSV restore to
  a single leading sense (documented); pre-v13 database: senses off, sense operations 409
  `not_supported`, sensed rows refused whole, legacy rows import; v12→v13 upgrade on a
  populated store (including trash) backfills correctly. Old-code/new-db: migration adds
  `vocabulary.senses_version` with default (no rewrite), creates a new table/indexes/RLS,
  replaces `vocabulary_cards` keeping all 23 prior columns in place and appending
  `senses_version, senses`, and keeps `create_vocabulary` / `update_vocabulary` parameter
  lists identical — old clients bind unchanged.
- **Migration safety — additive only (inspected).** No `drop` in v13; backfill is an `insert`
  over existing rows; no production/staging database touched; `supabase db push` **not run**.
- **Recovery limitations (stated, not hidden).** (1) File import restores *content only* —
  schedules, history, collections and settings require a database backup (project-owner
  duty, documented in `docs/import-and-export.md`, never drilled in this repo).
  (2) Concurrent-transaction behavior needs a real Postgres run. (3) A v13 codebase pointed
  at a pre-v13 database refuses sensed rows loudly per row — it never degrades silently.

---

## F. Acceptance Matrix

### A. Data Portability

| Criterion | Status | Basis |
|---|---|---|
| Multi-sense vocabulary restored via a supported, documented path | **PASS** | §10 #1–2, journey 7, docs §“Moving words to another account” |
| Secondary senses survive export/restore | **PASS** | §10 #2 (executed round trip — G1 gate rule) |
| Sense ordering and archive state preserved | **PASS** | §10 #3–4 |
| Legacy formats remain compatible | **PASS** | §10 #5–6 + v12 tests |

### B. Data Safety

| Criterion | Status | Basis |
|---|---|---|
| No silent data loss (restore, retry, reorder, archive/restore, conflicting edits) | **PASS** | §10 #7–12; E §data preservation |
| Existing user edits preserved | **PASS** | overlap test (ids/versions unchanged); fillSenses additive-only |
| Ownership and RLS enforced | **PASS** | §10 #14 + existing RLS tests |

### C. Compatibility

| Criterion | Status | Basis |
|---|---|---|
| Existing vocabulary records remain usable | **PASS** | full suite; upgrade tests on populated v12 store |
| Old/new schema compatibility verified where supported | **PASS** | new-code/old-db **executed** (v12 tests); old-code/new-db **verified by inspection** of the additive migration (no second code checkout exists locally to execute that direction — noted as the basis) |
| Review, FSRS, Undo, Practice semantics unchanged | **PASS** | files untouched; FINAL suite 1759/0 failed |

### D. Quality

| Criterion | Status | Basis |
|---|---|---|
| Relevant automated tests pass | **PASS** | targeted 8 suites, 182 passed (evidence D-7) |
| Full test suite passes | **PASS** | **81 files, 1759 passed, 3 skipped, 0 failed** (D-12) |
| Typecheck passes | **PASS** | `npx tsc --noEmit` exit 0 (D-13) |
| Lint passes | **PASS** | `npx eslint .` exit 0 (D-14) |
| Build passes | **PASS** | `npm run build` exit 0 (D-15) |

### E. Execution Boundaries

| Criterion | Status | Basis |
|---|---|---|
| No unauthorized remote database access | **PASS** | no remote DB commands issued; no credentials used |
| No unapproved software/dependency installation | **PASS** | `package.json` untouched; no installs; no Docker/Postgres (CP-3 not requested) |
| No deployment or Git mutations outside the contract | **PASS** | HEAD `8d76720` unchanged, **0 commits**, no push/reset/clean/deploy |

### F. Evidence

| Criterion | Status | Basis |
|---|---|---|
| Simultaneous-transaction, hosted Supabase, browser E2E gaps explicitly recorded | **PASS** | recorded in §G as UNVERIFIED / BLOCKED below |
| Code presence is not treated as evidence | **PASS** | every PASS above names an executed test and its run |

---

## G. Risk Register

| ID | Severity | Remaining uncertainty | Mitigation | Approval needed |
|---|---|---|---|---|
| **R-1** | — | **CLOSED this task** (was High): import restored only the first sense | Implemented + 15 executed round-trip tests + docs rewritten | — |
| **R-2** | Medium | Behavior under genuinely overlapping transactions is untested (single-connection local store) | Sequential collision matrix; DB-enforced CAS/unique constraints; single write path; request-id idempotency | Run against real Postgres/staging: **CP-2** |
| **R-3** | Medium | Migration has never been applied to a hosted database | Additive-only by inspection; executed upgrades on populated local stores incl. trash; capability gating refuses safely | `supabase db push`: **CP-2 / CP-5** |
| **R-4** | Low | Real-browser rendering/E2E not executed | All 8 journeys executed in jsdom with the existing infrastructure | Browser framework install: **CP-3** |
| **R-5** | Info | Restore-to-end leaves a position gap (position 0 free after restoring the first sense later) | By design; `unique(vocabulary_id, position)` holds; reorder repacks | — |
| **R-6** | Info | On a pre-v13 database a sensed row is refused (`invalid`) rather than imported | Deliberate; clear per-row message; legacy rows unaffected; capability flag surfaced in Settings → Connection | — |
| **R-7** | Low | Full-database backup/restore has never been drilled for this project | Documented as project-owner duty in `docs/import-and-export.md` (“a backup that has never been restored is a hope”) | Owner action, outside this task |

### External verification checklist (deliverable 6)

1. Apply v13 migration to hosted Supabase in a throwaway project first; verify upgrade on a
   copy of real data (CP-2).
2. Run the automated suite (or at least the sense/import suites) against that hosted
   database — clears R-2/R-3 and the UNVERIFIED concurrent-transaction item (CP-2).
3. Real-browser pass of the 8 journeys — export → import round trip especially (CP-3).
4. Supabase CLI `pg_dump`/restore drill per `docs/import-and-export.md` (project owner).
5. Tech Lead review of the design decisions in §C-G1 (senses-as-content rule; derived
   request ids; whole-row refusal on old schema).

---

## H. Final Recommendation

# READY FOR TECHNICAL REVIEW

**Locally release-ready: YES.** All five gates G0–G4 completed: data portability implemented
and proven by executed round trips (R-1 closed), concurrency hardened as far as a
single-connection store honestly allows (the rest recorded UNVERIFIED), migration/compatibility
audited with new executed tests plus a documented inspection of the old-code/new-db direction,
all 8 user journeys verified on existing infrastructure, and the full quality gate green
(**1759 passed / 3 skipped / 0 failed**, typecheck 0, lint 0, build 0) on an unchanged HEAD
with zero commits.

**Production deployment readiness: NO — and not claimed.** Deploying requires, in order:
Technical Lead review of this work, Product Owner acceptance, the migration push and staging
verification (CP-2/CP-5), and optionally a browser E2E pass (CP-3). No migration was pushed,
no environment installed, no commit, push, reset or clean was performed, and no pre-existing
report or uncommitted work was overwritten.

*Await Technical Lead review and Product Owner acceptance.*
