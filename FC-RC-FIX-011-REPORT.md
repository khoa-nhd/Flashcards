# FC-RC-FIX-011 — Data-safety corrections for trashed vocabulary, import completion and legacy-projection protection

**Contract:** FC-RC-FIX-011 (response to the FC-RC-010 independent review, items RC-011-A/B/C)
**Branch / base:** `newfeature` @ `8d76720`, nothing committed — all work is in the working tree, as required
**Date:** 2026-10-17
**Verdict of this report:** **READY** — for Technical Lead review and Product Owner acceptance. Deployment of migration v15, hosted migration push, real-browser E2E and git commit/push remain blocked by contract (CP-3/CP-5) and are listed as such.

---

## 1. What the review found, and what was done

| Review item | Finding (as validated against the code) | Verdict | Where the proof is |
|---|---|---|---|
| **RC-011-A** — trashed-vocabulary exposure in DB operations | `add_vocabulary_sense` (v14) claimed the word with **no** `deleted_at` filter, and `restore_vocabulary_sense` (v14) had **no** trash check at all: the ordinary sense calls would write into a word the owner had thrown away; the refusal lived only in the service for some paths. `update`/`archive` ran as bare table updates with no trash condition. | **FIXED at the database level.** From schema 15, every ordinary sense mutation — add, update, archive, restore, reorder, and the legacy whole-word edit (v13) — refuses a trashed word *inside the database* (P0002, the same answer a missing word gets), not only in the service. One narrow, named exception remains by design: `resume_vocabulary_sense` (see below). | Migration `20261024090000_sense_trash_safety.sql`; tests: `atomic-sense-ops.test.ts` ("a word in the trash…", "update_vocabulary_sense and archive_vocabulary_sense…"), `senses-api.test.ts` ("a word in the trash: every sense operation refuses it"), `import-senses.test.ts` (trashed-word retry) |
| **RC-011-B** — multi-step import completion | Per-row completion was two calls (`createSense`, then a separate `archiveSense` for the file's archive flag), and the archive result was **discarded** — a failed archive left the sense stored without its flag while the import still reported the row as imported. | **RESOLVED.** Each imported row is now **one database call**: `resume_vocabulary_sense` adds the sense under its request id and sets the file's archive flag in the same statement, so the "stored but unflagged" state cannot occur on schema 15. On a schema-14 database the old pair of statements is kept for compatibility, but the archive result is now **verified**; if the flag did not land, the call throws, the row is reported *stopped* (retryable), never fully successful. Content is never rewritten by the completion call — an owner's edit made after an interrupted run survives the rest of the import. | `server/vocabulary-service.ts` (`fillSenses`), `server/supabase/supabase-database.ts` (`createSense`), tests: `import-senses.test.ts` (7 failure/interruption tests, incl. the re-pointed archive-failure injections) |
| **RC-011-C** — legacy projection / trigger regression protection | No regression was found; the risk was the absence of regression tests pinning the v13/v14 invariants once sense writes moved. | **PROTECTED.** No migration touches the v13 legacy projection or the v14 sync trigger. New tests pin: a legacy edit changes only the first live sense (secondaries byte-identical, versions unchanged); the senses version moves **exactly once** per sense change (add / edit / resume-archive / legacy edit — a trigger feeding back on itself would move it further or not finish); a legacy edit commits whole or not at all (poison-trigger injection: no content, no projection, no schedule half-written). Old-code-on-new-schema behaviour kept: `legacy-code-compat.test.ts` (6 tests) passes unchanged on v15. | `atomic-sense-ops.test.ts` ("the legacy edit, its triggers, and the way they commit"); existing projection tests (v14) still pass |

### The authorized recovery mechanism (G1's "narrow, backward-compatible" requirement)

`resume_vocabulary_sense(p_vocabulary_id, p_meaning, p_definition, p_example, p_request_id, p_archived boolean default false) returns table (id uuid, created boolean)` — new in v15, and the **only** call in the system allowed to write senses on a trashed word. It is narrow on purpose:

- it claims the word for its **owner** whatever its state (ownership is the same `user_id = auth.uid()` check as everywhere; another account's word answers P0002; unsigned callers are refused);
- from that claim it can do exactly two things: **add** the sense whose request id has not landed yet (at the end of the order, with the archive flag in the same statement when the file carries one), or **set the archive flag** on the sense the same request id already owns (idempotent — never unarchives, never moves, never rewrites content);
- it never touches the word row, never reaches anyone else's rows, and cannot be used to edit stored content — a retried import **lands on the same senses instead of doubling them**, and a word edited after an interrupted run keeps the edit.

`create_vocabulary`'s request-id dedup deliberately still returns **trashed** words on retry (unchanged), so a retry reaches the same word and the completion call finishes it there rather than creating a second copy.

---

## 2. Migration changed (additive only)

**New:** `supabase/migrations/20261024090000_sense_trash_safety.sql` (377 lines). `app_schema_version()` → **15**. No column, table, signature or route changes.

| Object | Change |
|---|---|
| `app_schema_version()` | `select 15` (was 14) |
| `add_vocabulary_sense(uuid,text,text,text,uuid)` | CREATE OR REPLACE — the word claim gains `and v.deleted_at is null`; same signature, same request-id dedup, same answers (P0002 missing/foreign/trashed, P0003 never — dedup returns `created=false`). Comment updated: import completion goes through `resume_vocabulary_sense`. |
| `restore_vocabulary_sense(uuid,integer)` | CREATE OR REPLACE — the word claim gains `and v.deleted_at is null`; same signature and CAS (P0002 / P0003) otherwise. |
| `update_vocabulary_sense(uuid,integer,jsonb)` | **NEW** — takes over the edit that ran as a bare table update. Sense lookup (P0002), word claim that must be **live** (P0002), CAS on version + `archived_at is null` (else P0002-not-there / P0003-stale, exactly the old answers). `p_changes` presence semantics mirror `update_vocabulary(p_patch jsonb)`: a field absent is left as it is, a field present with `null` is cleared. |
| `archive_vocabulary_sense(uuid,integer)` | **NEW** — same skeleton; moves only the flag and the version; the sense keeps its identity, content and position. |
| `resume_vocabulary_sense(uuid,text,text,text,uuid,boolean) returns table(id uuid, created boolean)` | **NEW** — the import's completion call (see §1). Mirrors v14's claim → dedup → position → insert → `unique_violation` re-lookup structure. |
| Privileges | All three new functions: `revoke all … from anon, authenticated, public; grant execute … to authenticated` — the exact v14 pattern. |

Lock ordering: from schema 15 every path that changes senses claims the **word first, then the sense** (update and archive moved under the claim with the new functions), which also removes the app-layer "sense-row first" window that FC-RC-FIX-009 had documented as risk R-5 — on schema-15 databases only; schema-14 keeps the old statements byte-for-byte.

---

## 3. Server / store / service changes

| File | Change |
|---|---|
| `server/supabase/supabase-database.ts` | `LATEST_SCHEMA_VERSION = 15`. New exported `SenseWriteOptions { resume?, archived? }`; `VocabularyDatabase.createSense` accepts it. `createSense`: schema ≥ 15 with `resume` → `resume_vocabulary_sense` (carrying `p_archived`); schema 14 with `resume` → the v14 pair (`add_vocabulary_sense`, then the version-guarded direct flag update) **plus verification** — if the flag did not land and is still missing, it throws `DatabaseError('conflict', …)` instead of reporting success. `updateSense` / `archiveSense`: schema ≥ 15 → the new RPCs with `P0002 → 'not_found'` / `P0003 → 'stale'` (service maps these to 404 / 409 as before, so no API change); schema < 15 → the exact v13 statements as today. |
| `server/supabase/database.types.ts` | Functions map += `update_vocabulary_sense`, `archive_vocabulary_sense`, `resume_vocabulary_sense` (hosted client call sites typed). |
| `server/supabase/supabase-repository.ts` | `createSense` passes `options` through (previously dropped → would have broken the import path). |
| `server/vocabulary-catalog.ts` | `SenseOperations.createSense` gains the optional `options` parameter (+ doc). Implementations with fewer parameters remain assignable. |
| `server/vocabulary-service.ts` | `fillSenses`: each row is now **one** `store.createSense(entry.id, {…, requestId: derivedRequestId(row) }, { resume: true, archived: sense.archived === true })` — the separate `archiveSense` call and its discarded result are gone. A thrown failure still propagates to `importBatch`'s catch → row reported *stopped*, never fully successful. Doc comment updated. |
| `server/mock/mock-repository.ts`, `tests/helpers/fake-catalog.ts` | In-memory stores honour `options.archived` on create and on the dedup-hit path (archive-if-requested, never unarchive), keeping demo/fake behaviour in step with the real store. |
| `tests/helpers/pg-vocabulary-database.ts` | PGlite mirror: `createSense` resume branch + schema-14 fallback with the same verification; `updateSense`/`archiveSense` v15 RPC branches with the same error mapping. |

**Not changed:** routes, request/response schemas, `capabilitiesAt` (senses remains `>= 14`; v15 adds no capability flag — the new behaviour is gated on the schema version inside the store), the v13 legacy projection and its triggers, `create_vocabulary_with_senses` (fresh imports keep the word+senses-atomic creation; per-row completion is now 1 call, which is the RC-011-B improvement).

### Compatibility matrix

| Code / schema | Behaviour |
|---|---|
| new code + schema **15** | Full behaviour: DB-level trash refusal on every sense mutation; one-call completion; new RPCs. |
| new code + schema **14** | Byte-for-byte today's behaviour (add/restore as v14; update/archive as v13 statements); completion = old pair + verification (stricter reporting only). The DB-level trash refusal for add/restore/update/archive arrives with the migration — this is the backward-compatible trade-off. |
| new code + schema **13 / 12** | Unchanged gates: senses work refused (`not_supported` 409 / row-level `invalid`), as pinned by the schema-12/13 tests. |
| old code + schema **15** | Unchanged: every pre-existing function signature is intact; the extra RPCs are simply unused; the old direct-table statements still run (RLS unchanged) — `legacy-code-compat.test.ts` passes. |
| API surface | Unchanged (no route, schema or status-code change). |

### Documented residual (by design)

A user holding the anon key and their own JWT can still reach their **own** rows through PostgREST's table endpoints directly (RLS permits self-owned rows), bypassing the app's refusal for update/archive on a trashed word. This boundary is deliberate: any RLS/trigger-level trash guard on `vocabulary_senses` row writes would also block the authorized recovery path (which must archive imported senses over a trashed word), so the guard lives in the function bodies, which the recovery call does not use. Cross-account access remains refused at RLS everywhere. On the supported app path, every sense mutation is refused at both the service and (from schema 15) the database layer.

---

## 4. Tests

**10 new regression tests** (all pass):

| # | Test | Covers |
|---|---|---|
| 1 | `atomic-sense-ops` › refuses an add and a restore on a trashed word, and takes them again once it is back | G1 DB refusal + identity/order preserved |
| 2 | `atomic-sense-ops` › refuses an edit and an archive through their calls, and takes them again once it is back | G1 DB refusal for the two former bare updates |
| 3 | `atomic-sense-ops` › lets resume_vocabulary_sense finish a trashed word's senses, and nobody else reaches it | the named exception; dedup; flag lands; content never rewritten; foreign P0002; unsigned RLS-denied; senses_version exactly +2 |
| 4 | `atomic-sense-ops` › edits only the fields sent, and archives keeping identity, content and position | update/archive parity with the old statements (absent field kept, null cleared) |
| 5 | `atomic-sense-ops` › refuses a sense that is not there, another account's, a version that has moved on, an archived sense, and a word in the trash | G1 cross-account + stale + trashed, all four calls |
| 6 | `atomic-sense-ops` › changes only the first live sense when the shown text is edited, leaving the others exactly as they were | G3 legacy edit, secondaries byte-identical |
| 7 | `atomic-sense-ops` › moves the senses version exactly once for each change to the senses | G3 trigger-recursion invariant across add/edit/resume/legacy |
| 8 | `atomic-sense-ops` › commits a legacy edit whole, or not at all | G3 poison-injection rollback (no partial content, projection or schedule) |
| 9 | `senses-api` › a word in the trash: every sense operation refuses it | API-level refusal of add/edit/archive/restore/reorder/list (404) until the word is restored, then the same calls land |
| 10 | `import-senses` › finishes a word that was moved to the trash before the retry, and never a second copy | **G2 scenario 8 (was uncovered):** bare word created → trashed → same row resent → `already_imported` on the same word, senses (incl. an archived one) completed on the trashed word via the authorized call, no second copy, ordinary addSense 404s on it, restore returns everything to ordinary |

**3 existing tests re-pointed** (scenario preserved, comments updated): the two failure-injection wrappers that used to fail `archiveSense` now fail the **completion call carrying the file's archive flag** (`createSense` with `options.archived === true`) — the same interruption point, now one call earlier; the third wrapper forwards `options` instead of dropping it. Their assertions (partial state after the failed run, retry lands the flag, owner's added sense kept) are unchanged and still pass.

**G2's 10 required scenarios → tests** (existing 22 + new #10):

| Scenario | Test(s) |
|---|---|
| 1 Import with several senses | "lands on the same words and the same senses…"; "brings back every sense of a word, each with its own content" |
| 2 Failure right after creation | "says which row was interrupted when its word could not be written…" |
| 3 Failure during completion | "leaves the interrupted row's word complete with its senses…"; "reports a failure while an imported sense is archived…" (re-pointed) |
| 4 Retry after partial completion | "finishes a run that stopped between the word and its senses…"; both retry tests |
| 5 Retry, identical id + payload | "lands on the same words and the same senses instead of doubling them" |
| 6 Identical id + different payload | "does not let a repeated row with a different body rewrite…"; `atomic-sense-ops` "answers a repeated request id with the word that landed…" |
| 7 Retry after user edit | "keeps an owner's edit when the same file is sent again"; "keeps a sense the owner added after a failed run" |
| 8 Retry after the word is trashed | **new test #10** |
| 9 Imported archived senses | "keeps archived senses flagged…"; new test #10 (archived sense over a trashed word); resume assertions in test #3 |
| 10 Cross-account / malformed | "restores only into the account that imported"; "refuses each bad row on its own…"; "spots an unusable sense in the file itself"; atomic tests #3/#5 |

---

## 5. G4 gates — commands, exit codes, final counts

Node `D:\New folder\node.exe` v24.22.0, npm 11.19.1 (same as baseline).

| Command | Result | Exit |
|---|---|---|
| `npx tsc --noEmit` | clean (first run found 4 `archived` vs `archived_at` errors in the new code — fixed; re-run clean) | 0 |
| `npx eslint .` | clean | 0 |
| `npx vitest run tests/database/atomic-sense-ops.test.ts tests/server/senses-api.test.ts tests/server/import-senses.test.ts` | 70 passed (first run: 2 failures — my two new word-restore calls lacked `method: 'POST'`; fixed) | 0 |
| `npx vitest run` (attempt 1) | transient worker-pool anomaly, same shape as the G0 baseline's first run: 80 files / 1688 passed / 3 spawn-timeout errors | 1 |
| `npx vitest run` (attempt 2, clean) | **83 files passed; 1807 passed, 3 skipped, 0 failed** | 0 |
| `npx vitest run tests/server/gateway-versions.test.ts` | 63 passed (delta attribution, see below) | 0 |
| `npm run build` | client build + server bundle produced (pre-existing 500 kB chunk warning only) | 0 |

**Final counts:** 83 test files, **1807 passed, 3 skipped, 0 failed** — baseline was 83 files / 1793 passed / 3 skipped (captured in G0, `D:\rcfix011_g0_baseline.txt`). The **+14** delta is fully accounted for: **+10** new FC-RC-FIX-011 tests (table above) and **+4** from `gateway-versions.test.ts`, which runs its suite once per schema version (`describe.each(… LATEST_SCHEMA_VERSION …)`, 4 tests per version; 14 → 15 versions).

Both the baseline and this fix's full-suite runs showed the same transient first-run anomaly (worker spawn timeouts under ~80 isolated workers); a clean re-run passed in both cases. Known pre-existing noise: the Vite chunk-size warning and one `Not implemented: navigation to another Document` line.

---

## 6. Scope compliance and unverified items

**Compliance:** no remote Supabase access, no hosted migration push, no production/staging access, no dependency installs, no destructive cleanup, no commit/push/reset/clean, no deployment. Only local migrations and isolated test data (fresh PGlite per test file, users wiped per test). PGlite executes the real SQL — triggers, plpgsql, RLS genuinely run — but it is **one connection**: every claim here is about a single statement's atomicity and the checks inside it, **never** about two transactions committing at the same instant. Nothing in this report should be read as simultaneous-transaction proof.

**Unverified (carried, not claimed):**

1. **Real hosted PostgreSQL + PostgREST behaviour** — the new and changed RPC arguments, and SQLSTATE propagation through the `.rpc` hop (P0002/P0003 → 404/409), are proven only against PGlite.
2. **Simultaneous transactions / two server instances** — sequential-collision coverage only (per contract CP-3: no local PostgreSQL/Docker services).
3. **Real-browser E2E** — blocked by contract.
4. **The v15 migration has not been applied to any hosted environment** — deploy drill and schema-verification there remain open.

**Remaining blockers (contractual):** applying migration v15 anywhere; commit/push; deployment; Technical Lead review; Product Owner acceptance. The work stops here as instructed.

**Risk register (carried + new):** R-1 real-PG UNVERIFIED · R-2 concurrency UNVERIFIED · R-3 fix not deployed · R-4 PostgREST hop UNVERIFIED · R-5 deadlock window — **closed on schema-15 paths** (word→sense ordering everywhere; remains only for schema-14 fallbacks) · R-6 schema-13 databases refuse sense work at the service (pre-existing, unchanged) · R-7 browser E2E blocked · R-8 no deploy drill · R-9 self-owned direct-table writes on a trashed word bypass the app guard (documented residual, §3; cross-account remains RLS-refused).

---

## 7. Git diff summary

- Branch `newfeature` @ `8d76720`; **nothing committed** (per CP-5). Working tree vs HEAD: **24 modified files, +2382 / −78** (cumulative — includes the still-uncommitted FC-RC-FIX-009-era work) plus untracked: prior reports/review ZIPs, `server/request-id.ts`, migrations 13/14 and the new v15 migration, and the four sense test files.
- **FC-RC-FIX-011 delta (this task):**
  - `supabase/migrations/20261024090000_sense_trash_safety.sql` — **new**, 377 lines
  - `server/supabase/supabase-database.ts`, `server/supabase/database.types.ts`, `server/supabase/supabase-repository.ts`
  - `server/vocabulary-catalog.ts`, `server/vocabulary-service.ts`, `server/mock/mock-repository.ts`
  - `tests/helpers/pg-vocabulary-database.ts`, `tests/helpers/fake-catalog.ts`
  - `tests/database/atomic-sense-ops.test.ts` (+ helpers, +8 tests), `tests/server/senses-api.test.ts` (+1 test), `tests/server/import-senses.test.ts` (+1 test, 3 wrappers re-pointed)

---

## 8. Recommendation

**READY.** All three review items are addressed by narrow, additive, backward-compatible corrections; the database — not only the service — now refuses trashed-vocabulary writes for every ordinary sense mutation, the import's completion path is a single, idempotent, ownership-scoped call that also refuses to report a partial row as fully successful, and the legacy projection/trigger behaviour is pinned by regression tests. All four gates pass (tsc, eslint, vitest 83 files / 1807 passed / 3 skipped / 0 failed, build). The unverified items above (real PostgreSQL/PostgREST, simultaneous transactions, browser E2E, deployment) are contractually out of scope for this task and are carried forward for the Technical Lead's review and the Product Owner's acceptance decision.
