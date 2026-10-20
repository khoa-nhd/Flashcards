# FC-VERIFY-006 — Vocabulary Foundation Verification & Stabilization

**Task type:** BUILD (restricted verification/correction) · **Branch:** `newfeature` · **HEAD:** `8d76720` (unchanged, zero commits)
**Date:** 2026-10-16 · **Scope:** audit/verify/repair the FC-IMPL-005 multi-sense vocabulary implementation in the local working tree
**Overall result: READY FOR TECHNICAL REVIEW** — one declared UNVERIFIED class (simultaneous-transaction properties, environment-impossible locally) and one disclosed open gap (secondary senses not re-imported, recommendation in §8).

Statuses: **PASS** / **FAIL** / **BLOCKED** / **UNVERIFIED**.

---

## 1. Executive Summary

FC-VERIFY-006 began from a working tree holding the uncommitted FC-IMPL-005 implementation with **270 type-error lines, 4 failing schema tests, and several critical defects**. Through audit + repair + test execution, every requirement that can be verified in this environment is now proven by execution — never by code reading:

| Gate | Start | Final (all commands exit 0 unless noted) |
|---|---|---|
| Typecheck (`npx tsc --noEmit`) | 270 error lines | **0 errors, exit 0** |
| Lint (`npx eslint .`) | — | **exit 0** |
| Full suite (`npx vitest run`) | 1707 passed, **4 failed** | **80 files, 1735 passed, 3 skipped, 0 failed, exit 0** |
| Build (`npm run build`) | not run | **exit 0** |
| Schema/RLS (`tests/database/schema.test.ts`) | 4 failed | **44 passed** |
| New: sense API on real schema (`tests/server/senses-api.test.ts`) | — | **15 passed** |
| New: sense UI (`tests/client/sense-ui.test.tsx`) | — | **9 passed** |

Critical defects found and corrected: a **dropped cross-account root-ownership validation** in the rewritten `update_vocabulary`, a **stale-sense conflict reported as 503 instead of 409**, a **DELETE path on senses that contradicts "archive, never delete"**, plus the FC-IMPL-005 defect backlog (unreachable sense editor, missing idempotency column/index, missing version-bump trigger, archived senses invisible, route shadowing, missing validations, mock/test-double gaps).

Not proven here (§7): **genuine simultaneous-transaction properties** — the local database is PGlite (single connection); all DB/HTTP tests are sequential. Deployment to hosted Supabase was out of charter (`supabase db push` not run). One open functional gap (import restores only the first sense) is disclosed in §8 for a Tech Lead decision, with the user-facing docs already corrected.

## 2. Environment Findings

- **Shell/OS:** Windows + PowerShell. Node **v24.22.0** and npm **11.19.1** live in `D:\New folder\` and are *not* on PATH; every command used the per-command workaround `$env:PATH += ";D:\New folder"` with `;` separators (never `&&` after PATH mutation). No PATH was altered persistently.
- **No Docker, no Supabase CLI, no hosted project, no remote DB access** (also forbidden by charter). Remote `supabase db push` / remote `db reset` **not run**.
- **Local database: PGlite** (`tests/helpers/test-database.ts`) — PostgreSQL compiled to WebAssembly, in-process, **single connection**. It applies **all 13 project migrations verbatim** (`readMigrations()` length = `LATEST_SCHEMA_VERSION` = 13) plus a Supabase platform stub: roles `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()` read from `request.jwt.claims`.
  - Consequence: migration validity, backfill, view projection, functions, triggers and **RLS execute for real** (`security_invoker` views, policies, privileges) → verifiable.
  - Consequence: **two transactions cannot run at the same instant** → G1 concurrency proof impossible → §7.
- **Stack:** React 19 + TypeScript strict + Vite + Tailwind; Hono API server; Vitest **5.0.3**; Supabase RLS with composite FKs; **no CI/CD** in the repo.
- **3 skipped tests** (pre-existing): `tests/server/backup-import.test.ts` → `describe.skipIf(latest === undefined)` — requires a local `backups/` fixture directory that is not part of the repository. Unrelated to senses; documented, not silently ignored.
- npm scripts available: `build`, `typecheck` (= `tsc --noEmit`), `lint` (= `eslint .`), `test` (= `vitest run`).

## 3. Git Diff Audit

- **HEAD `8d76720` unchanged; zero commits, no push/reset/clean/stash.** No dependency installs or upgrades; no secrets printed; no live/staging DB touched — charter respected.
- Diff (uncommitted, `git diff --stat`): **20 files changed, +1760 / −28**. Untracked: `supabase/migrations/20261022090000_vocabulary_senses.sql` (the v13 migration), `tests/server/senses-api.test.ts`, `tests/client/sense-ui.test.tsx` (both new in FC-VERIFY-006), and pre-existing `OPENCODE_AUDIT_REPORT.md` (not mine, untouched). This report file itself is new.
- The diff = **FC-IMPL-005 implementation + FC-VERIFY-006 corrections**, by area:

| Area | Files | Nature of changes |
|---|---|---|
| Shared contracts | `shared/api.ts`, `shared/vocabulary.ts`, `shared/export-format.ts` | sense schemas/types (add/update/reorder/archive/restore, `addSenseResponse`, `senseSchema`, `expectSensesVersion`), `capabilities.senses`, export `senses` field |
| Database | `supabase/migrations/20261022090000_vocabulary_senses.sql`, `server/supabase/database.types.ts` | v13 migration (table, indexes incl. `(user_id, request_id)` idempotency index, bump trigger, view, `create/update_vocabulary`, sense ops, RLS) |
| Server — database | `server/supabase/supabase-database.ts`, `supabase-repository.ts` | sense methods, sense row/column mapping, `toDatabaseError` P0003→conflict, `capabilitiesAt(≥13)` |
| Server — app | `server/vocabulary-service.ts`, `server/create-app.ts`, `server/vocabulary-catalog.ts` | sense operation validations/locks/404s/409s, routes (+ `/senses/order` before `/senses/:senseId`), `conflict`→409 |
| Server — mock | `server/mock/mock-repository.ts`, `server/export-service.ts` | full in-memory sense ops, stale-version 409, export senses |
| Client | `src/components/WordDetailPanel.tsx`, `src/pages/AddPage.tsx`, `src/lib/api-client.ts` | sense editor block, legacy Draft fields restored, add-as-sense, sense API methods |
| Tests | `tests/database/schema.test.ts`, `tests/helpers/{fake-catalog,fake-api,pg-vocabulary-database}.ts`, `tests/shared/import.test.ts`, + 2 new files | RLS/policy/privilege assertions, sense-capable test doubles, 24 new tests |
| Docs | `docs/import-and-export.md` | export fields table lists `senses`; import limitation stated |
- **No unrelated edits**: no config/tooling/CI changes, no package.json/lockfile changes, no changes to unrelated features.

## 4. Critical Defects Found

Severity: **C** = critical (correctness/isolation/contract), **H** = high, **M** = medium.

| # | Sev | Defect | How it was found |
|---|---|---|---|
| D-01 | **C** | FC-IMPL-005's `update_vocabulary` rewrite **silently dropped the v12 root-ownership check** (`root word not found`, P0002): a word could be linked to **another account's word as root** (data-isolation hole). Self-root remained only via CHECK. | `tests/database/schema.test.ts` failed: expected rejection, got `[{ok:true}]` |
| D-02 | **C** | **Stale-sense conflict reported as an outage**: `expectSensesVersion` mismatch raises P0003, but `toDatabaseError` had no P0003 branch → `unavailable` → **503 "database unavailable"**; mock/fake modes threw plain `Error` → **500**. Contract requires a conflict response. | Code audit during verification (error-path tracing) |
| D-03 | **H** | `vocabulary_senses` had an **UPDATE/INSERT/DELETE policy + DELETE grant**, contradicting FC-ADR-004 (*a sense is never deleted, only archived*): a client could hard-delete senses directly. | Policy-list audit vs. migration SQL |
| D-04 | **H** | **Archived senses were invisible**: the view/list hid archived rows → archive looked like deletion and restore could not find its sense. | Migration read + restore-path analysis |
| D-05 | **H** | **Idempotency column/index missing**: no `request_id` on `vocabulary_senses`, no partial unique index → a retried add could create a second sense. | Migration read vs. API contract |
| D-06 | **H** | **No version-bump trigger** on `vocabulary_senses` → `senses_version` never advanced → optimistic locking (`ifMatch`, `expectSensesVersion`, reorder guard) could not work. | Migration read |
| D-07 | **H** | **WordDetailPanel sense editor unreachable**: sense form nested inside the word-edit form while its buttons only render in view mode; Draft had lost the legacy fields (`meaning`/`definition`/`example`); duplicated `saveError` block; **invalid icon names** (`"plus"`, `"archive"`, `"rotate-ccw"` not in `Icon.tsx`); Move up/Down unwired. | Component audit + typecheck/lint |
| D-08 | **H** | Service gaps → 500s: **no 404 existence check** in `addSense`/`reorderSenses` (unknown word → 500), no `MAX_SENSES` (25) cap, no empty-sense 400, no exact live-set check on reorder; `/senses/:senseId` registered before `/senses/order` (route shadowing). | Route/service audit |
| D-09 | **M** | **`listSenses` returned 200 with `[]` for foreign/unknown words** while `getSense` correctly 404'd — inconsistent RLS surface. | New RLS test authored during verification |
| D-10 | **M** | Test-double gaps: mock repo, in-memory catalog, and the PG test double lacked sense operations (`TS18048` etc.) → the suite could not exercise the feature at all. | First full-suite run |
| D-11 | **M** | **Export lacked no data, but nothing proved it**: export carried `senses` with no test, and `docs/import-and-export.md` didn't list the field. Import gap: a full export re-imported into another account restores **only the first sense** (row pipeline reads four content fields) — by-design architecture, now documented (§8, R-1). | Export/import round-trip audit during verification |

## 5. Corrections Made

All corrections are local, task-related, and uncommitted in the working tree.

| Defect | Correction | Proof |
|---|---|---|
| D-01 | Restored root-ownership validation in `update_vocabulary` (`P0002 'root word not found'`, own-account lookup; self-root still CHECK `23514`) | `schema.test.ts` 44/44 incl. the previously failing root tests |
| D-02 | `DatabaseFailure += 'conflict'`; `toDatabaseError`: P0003 → `conflict`; `databaseErrorToHttp`: `conflict` → **409**; mock-repository & fake-catalog throw `HttpError(409,'conflict')` | `senses-api.test.ts`: stale `expectSensesVersion` → **409 `conflict`**; stale reorder → 409; full suite green |
| D-03 | **Dropped the senses DELETE policy and DELETE grant**; only hard delete is the cascade from the word itself (runs without a policy) | `schema.test.ts` policy list + privilege loops: authenticated has select/insert/update, **no delete**, anon denied |
| D-04 | View includes archived senses (ordered by position); `listSenses` includes archived everywhere (UI filters); restore places the sense at **max position + 1** in one transaction | `senses-api.test.ts`: archive keeps the row, projection follows first live sense, restore → position 2 |
| D-05 | Added `request_id uuid` + partial unique index `(user_id, request_id) WHERE request_id IS NOT NULL`; service derives/forwards request ids; PG double retries on `UNIQUE_VIOLATION` | `senses-api.test.ts` "lands once when the same add is retried": 201→200, `created:false`, same id, exactly 2 senses |
| D-06 | AFTER INSERT/UPDATE/DELETE trigger `vocabulary_senses_bump_version()` bumps `vocabulary.senses_version`; reorder = two-phase (+1000 shift, then live → 0..n-1) inside **one transaction** | Version assertions across create/add/archive/restore/reorder in `senses-api.test.ts` (1→2→3→4→5 sequence verified) |
| D-07 | Sense editor moved out of the word-edit form (own block + view-mode sibling); Draft restored to legacy fields; `startEditing` cancels sense editing; `liveSenses`/`archivedSenses` derived; Move up/Down wired via `reorderSenses`; icons corrected to the valid set; duplicate `saveError` removed | `sense-ui.test.tsx` 9/9 (list/add/edit/move/archive/restore) + `vocabulary-pages.test.tsx` word-form tests green |
| D-08 | Existence checks (404) in `addSense`/`reorderSenses`/`listSenses`; `MAX_SENSES=25` → 400; empty sense → 400; reorder validates **exact live-set equality** → 400 (service) and DB guard; route order fixed; POST returns `{ sense, created }` (201/200) | `senses-api.test.ts`: 404 unknown word, 400 empty, 400 incomplete/foreign order, 400 26th sense, 409 stale |
| D-09 | `listSenses` now requires the word to exist → 404 | `senses-api.test.ts` RLS test: all six cross-account calls → 404 |
| D-10 | Sense-capable doubles: mock-repository (locks + `senseRequests`), fake-catalog/fake-api (in-memory `SenseOperations`), PG double (`7 real-SQL sense methods`, transactional reorder, request-id idempotency, CAS case-when null semantics); `database.types.ts` additive | Full suite 1735 passed |
| D-11 | Added export test (every sense incl. archived leaves via `/api/export`); updated `docs/import-and-export.md` (field table + honest import-limitation note); **import gap escalated, not silently fixed** (§8 R-1) | `senses-api.test.ts` "carries every sense… out through the export" |
| — | `shared/api.ts` re-exported `Sense` + zod-inferred request/response types for the client | `tsc --noEmit` = 0 |

## 6. Tests Executed and Results

Exact commands (PATH workaround applied per command), exit codes, and summaries — in execution order:

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npx tsc --noEmit` (=`npm run typecheck`) — baseline | ≠0 | 270 error lines (starting state) |
| 2 | `npm test` (full) — baseline | ≠0 | 1707 passed, **4 failed** (`tests/database/schema.test.ts`) |
| 3 | `npx vitest run tests/database/schema.test.ts` — after fixes | **0** | **44 passed** (RLS exact lists, policy lists, privilege loops incl. anon & no-DELETE, root-ownership restore) |
| 4 | `npx tsc --noEmit` — after all corrections | **0** | **0 errors** |
| 5 | `npx eslint .` (=`npm run lint`) | **0** | **0 problems** |
| 6 | `npx vitest run tests/server/senses-api.test.ts` (new) | **0** | **15 passed** |
| 7 | `npx vitest run` (full, first green) | **0** | 79 files, **1725 passed, 3 skipped, 0 failed** |
| 8 | `npm run build` (vite + esbuild server bundle) | **0** | built; one pre-existing chunk-size warning (cosmetic) |
| 9 | `npx vitest run tests/client/sense-ui.test.tsx` (new) — first run | ≠0 | 3 failed — **test-authoring defect** (shared mutable fixture mutated by the fake server across tests); fixed with per-test copies |
| 10 | `npx vitest run tests/client/sense-ui.test.tsx` — after fix | **0** | **9 passed** |
| 11 | `npx tsc --noEmit` + `npx eslint .` — final | **0 / 0** | 0 errors / 0 problems |
| 12 | `npx vitest run` (full, final) | **0** | **80 files, 1735 passed, 3 skipped, 0 failed** |
| 13 | `npm run build` — final (after all changes) | **0** | built |

**Sequential vs. genuine concurrency — explicit statement.** Every HTTP/DB test in this suite is **sequential**: each request is awaited and asserted before the next begins. They prove *sequential* behavior: validation rules, version CAS negatives (stale writer gets 409), request-id idempotency (UNIQUE-violation retry), RLS refusals, projection and backfill. They do **not** prove that two transactions running at the same instant are serialised — see §7. No PASS anywhere in this report is claimed from code reading; each PASS names a command or test that executed.

**Skips:** the 3 skipped tests are the pre-existing fixture-gated backup describe (needs an absent local `backups/` directory); recorded, not counted as passes.

## 7. Unverified Requirements

| ID | Requirement / property | Status | Why |
|---|---|---|---|
| **G1** | **Simultaneous-transaction properties**: two writers at the same instant — race on `senses_version` CAS, lock contention (`sense:{id}` / `sense-op:{senseId}`), trigger + reorder under concurrency, idempotency under parallel duplicate requests | **UNVERIFIED** | The local DB (PGlite) is **single-connection**: concurrent transactions are impossible to schedule. What *is* verified: sequential stale-writer rejection (409), sequential idempotent retry (201→200 same id), per-row CAS, unique index behavior. Locks are code-reviewed only. |
| U2 | **Hosted-Supabase execution**: `supabase db push` of the v13 migration, behavior through real PostgREST pooling, real `auth.uid()` JWT path | **BLOCKED** (by charter + environment) | No remote DB access, no CLI/hosted project in this environment; forbidden by task charter. The migration itself is proven by being applied verbatim on PGlite. |
| U3 | **Real-browser end-to-end behavior** | **UNVERIFIED** (pre-existing) | The repo has no browser/E2E harness; UI evidence is jsdom component tests (`sense-ui.test.tsx`, `vocabulary-pages.test.tsx`). Not introduced by FC-IMPL-005. |

## 8. Remaining Risks

| # | Risk | Severity | Note / recommendation |
|---|---|---|---|
| **R-1** | **Open gap (not fixed under this charter):** a full account export *carries* every sense, but **import restores only the first sense** — moving words to another account or rebuilding from an export loses secondary senses. Cause: the import row-pipeline (CSV/JSON text → four content fields) has no place for sub-records; fixing it needs a design decision (dedicated export-restore path vs. extending the row pipeline), i.e. architecture work forbidden in FC-VERIFY-006. | **High** for the two documented workflows (move-account, disaster recovery); zero impact on normal use and same-account operation | **Decision needed from Tech Lead/PO**: follow-up task to import senses (with derived deterministic request-ids for idempotency + schema-version gating), or accept and keep the limitation documented. `docs/import-and-export.md` already states the behavior truthfully; a test asserts the export side. |
| R-2 | **PostgREST atomicity on real Supabase**: the PG test double runs multi-step operations (reorder, restore) in one real transaction; on hosted Supabase some paths span several PostgREST statements and are atomic only per statement (RPCs are single statements). | Medium | Verify reorder/restore under failure injection on a staging project (part of U2) |
| R-3 | Restore/add at `max position + 1` can race another insert → `unique (vocabulary_id, position)` violation → surfaces as 400. | Low | Same G1 class; acceptable because the operation is retryable and idempotent |
| R-4 | The bump trigger advances `senses_version` on *legacy text edits* too → a sense-client holding a stale version meets a conservative 409. | Low (by design) | Correct (conflict rather than lost write); clients re-read on 409 |
| R-5 | PGlite ≠ hosted Postgres: platform stub (`auth.uid()` from `request.jwt.claims`), no pooler, same PG core. | Medium | Covered by U2 |
| R-6 | `server/supabase/database.types.ts` was hand-edited additively for the new table/fields; regenerating from a real project is authoritative. | Low | Regenerate during deploy prep |
| R-7 | jsdom component tests don't prove cross-browser rendering of the sense editor. | Low | Optional smoke pass in a real browser during review |

## 9. Acceptance Matrix

Footnote † = PASS on **sequential** evidence; the simultaneous-transaction class for this behavior is **UNVERIFIED** (G1).

| # | Behavior | Status | Evidence (executed) |
|---|---|---|---|
| 1 | Minimal profile (word + meaning only) creates one primary sense; bare word creates none | **PASS** | `senses-api.test.ts`: "shows the sense the word was created with…" (1 sense, version 1, `sensesVersion` 1), "gives a word created without content no senses, until the first edit gives it one" |
| 2 | Add / edit sense | **PASS** † | `senses-api.test.ts`: "adds a sense at the end and moves the version on", "updates a sense, and refuses a change still made against the old version", "leaves out what it was not asked to change, and clears a field given null"; `sense-ui.test.tsx`: "adds a sense, and shows it once the server has", "edits a sense against its version…" |
| 3 | Stable sense IDs (never re-created) | **PASS** † | Same id across retried add ("lands once…"); id asserted unchanged across edit/archive/restore (`senses-api.test.ts`, `sense-ui.test.tsx` targets `sense-a` throughout) |
| 4 | Reorder | **PASS** † | `senses-api.test.ts`: "reorders the live senses, packs the archived ones behind, and refuses a wrong or stale order" (200 apply; 400 incomplete; 400 foreign id; 409 stale `ifMatch`); `sense-ui.test.tsx`: "moves a sense down the order, swapping it with its neighbour" (`senseIds` + `ifMatch: sensesVersion`) |
| 5 | Archive / restore (nothing lost) | **PASS** † | `senses-api.test.ts`: "archives a sense without losing it, and the shown meaning follows the first live one" (row kept, projection follows, archived edit → 409, re-archive → 409, restore → position 2); `sense-ui.test.tsx`: archive + restore flows |
| 6 | Duplicate save safety | **PASS** † | `senses-api.test.ts`: retried add with same `requestId` → 200/`created:false`/same id; `vocabulary-pages.test.tsx` cancel/allow-duplicate flows; `import-export-api.test.ts`: "imports nothing twice when the same batch is sent again" |
| 7 | Quick vs full profile | **PASS** | `sense-ui.test.tsx`: "quick add sends only the word and the meaning" (definition/example `undefined`), duplicate-as-sense from both client-side and server-side detection; full-profile field delivery covered by `vocabulary-pages.test.tsx` word-form tests (green) |
| 8 | Primary-sense compatibility (legacy → first sense) | **PASS** | `senses-api.test.ts`: "writes an edit of the shown meaning through to the first live sense" (sense version 1→2, `sensesVersion` → 3); create/meaning backfill on **upgrade from schema 12** ("gains the senses its words already carried, once the migration is run"); import round-trips green (`import-export-api.test.ts`, `tests/shared/import.test.ts`) |
| 9 | Idempotency | **PASS** † | Request-id unique index + retry behavior (`senses-api.test.ts` "lands once…"; PG double retries on `UNIQUE_VIOLATION`); import/create idempotency suites green |
| 10 | Conflict responses | **PASS** † | 409 `conflict` for: stale sense `ifMatch`, stale reorder `ifMatch`, stale `expectSensesVersion` (P0003 → 409 mapping), edit/re-archive of an archived sense; 409 `not_supported` behind schema 12; 409 `duplicate` flows green |
| 11 | RLS isolation | **PASS** | `senses-api.test.ts`: "keeps one account's senses out of another's reach" (entry read, list, add, edit, archive, reorder, direct sense read → all **404** for the other account); `schema.test.ts` 44/44: RLS enabled on `vocabulary_senses`, exact policy set, authenticated select/insert/update **without DELETE**, anon denied |
| 12 | Import / export | **PASS** ¹ | Export carries **every sense incl. archived** (`senses-api.test.ts`: "carries every sense… out through the export"); CSV/JSON/backup import behavior unchanged and green (`import-export-api.test.ts`, `backup-import.test.ts`, `shared/import.test.ts`). ¹ **Disclosed gap R-1**: import into *another* account restores the first sense only — documented in `docs/import-and-export.md`, decision requested |
| 13 | Review / FSRS / Undo regression | **PASS** | Full suite green incl. `tests/server/undo-api.test.ts`, `tests/server/fsrs-shadow.test.ts`, `tests/shared/fsrs.test.ts`, `tests/shared/review-logic.test.ts`, `tests/server/review-service*.test.ts` — within the final **1735 passed / 0 failed** |
| 14 | Practice regression | **PASS** | Full suite green incl. `tests/server/practice-api.test.ts`, `tests/server/writing-practice-api.test.ts`, `tests/client/practice.test.tsx` — within the final **1735 passed / 0 failed** |

**Summary:** 14 PASS (12 † sequential-evidence), 0 FAIL, 0 BLOCKED; cross-cutting **G1 = UNVERIFIED**; open gap **R-1** disclosed.

## 10. Recommendation

**READY FOR TECHNICAL REVIEW.**

All requirements verifiable in this environment have passed by execution (typecheck 0, lint 0, 1735 tests passed / 0 failed across 80 files, build 0, 24 new tests, 44/44 schema & RLS tests). The only UNVERIFIED class (G1, simultaneous transactions) is **environment-impossible locally by tooling** (PGlite single connection), not a skipped check — it must be proven on a staging Supabase project where two real sessions can contend.

For the reviewer:

1. **Read the migration** `supabase/migrations/20261022090000_vocabulary_senses.sql` first — it carries the highest-value corrections (root validation, trigger, request-id index, archived-visible view, single write path, no DELETE policy).
2. **Decide R-1** (import restores only the first sense): schedule a follow-up task or accept the documented limitation.
3. **Plan a staging pass** for U2/R-2: run the migration against a real Supabase project and exercise reorder/restore under connection-pool concurrency (this is also the G1 closure plan).
4. All work is **uncommitted by charter** — committing, pushing, and deploying remain Tech Lead/PO actions after acceptance. This report (`FC-VERIFY-006-REPORT.md`) is delivered for FC-VERIFY-006 acceptance; FC-VERIFY-006 stops here.
