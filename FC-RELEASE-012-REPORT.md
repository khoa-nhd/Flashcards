# FC-RELEASE-012 — Local PostgreSQL Release Gate

Validation of the Vocabulary Foundation on genuine local PostgreSQL: the real
migration sequence end to end, true multi-connection concurrency, database-level
security including the direct-table write review, fault injection and recovery,
and the project's regression gates. No production deployment is authorized or
performed by this gate.

Status of each section reflects the runs recorded in section G. Exactly one
final recommendation appears in section H.

---

## A. Environment and the isolated instance (gate G0)

**Host.** Windows 11 Pro (10.0.26200), 16 GB RAM, Node v24.22.0, npm 11.19.1.
Disk: work and instance on `D:` (≈79 GB free at start).

**Instance.** There was no PostgreSQL on this machine — no binaries, no
service, no listening ports (5432/5433/15432/6432/8080 all free). A dedicated,
user-scoped, portable instance was provisioned:

| Item | Value |
| --- | --- |
| Server | PostgreSQL **17.6**, x86_64-windows (msvc build), `postgres (PostgreSQL) 17.6` |
| Source | `@embedded-postgres/windows-x64@17.6.0-beta.15` under `D:\pgrel012\tools\node_modules\…\native\` (npm, `--no-save`; package `pg-symlinks.json` empty — blocked install script was a no-op) |
| Data | `D:\pgrel012\data` (`initdb -U rel012_admin -A scram-sha-256 -E UTF8 --locale=C`, password file `D:\pgrel012\pwfile.txt`, non-production) |
| Listen | `127.0.0.1:15432` **only** — verified by `pg_stat_activity`-side `listen_addresses`, by the connection itself, and by `Get-NetTCPConnection` showing a single loopback listener |
| `pg_hba.conf` | `local`/`host … 127.0.0.1/32`/`::1/128` all `scram-sha-256`; no `trust`, no `0.0.0.0/0` (read back via `pg_hba_file_rules`) |
| Process | started detached (`Start-Process`), **never** a Windows service; no admin rights, no global PATH change, no firewall changes, no other software installed |
| Tuning | test-only: `fsync=off`, `synchronous_commit=off`, `full_page_writes=off`, `shared_buffers=64MB`, `max_connections=25`, `logging_collector=on` — safe because the whole cluster is disposable |
| Verified | `select version()` → `PostgreSQL 17.6 on x86_64-windows` over a real TCP connection as `rel012_admin` |

**Isolation and safety decisions.**
- The instance is private to this task: loopback-only, its own port, its own
  directory tree, its own roles. It shares nothing with any hosted project.
- **No remote Supabase project was contacted, and no production credential or
  endpoint was used anywhere.** All data in this gate is synthetic.
- The release harness may only create or drop databases whose names start with
  `rel012_` (enforced in code); every test database is created fresh, dropped
  with `DROP DATABASE … WITH (FORCE)`, and never touches anything else.
- PGlite (the in-process PostgreSQL used by the existing suite) was **not**
  substituted for any multi-connection result in this report. The existing
  PGlite suite runs as its own regression gate (section G), never as proof of
  simultaneous-transaction behavior.

## B. What was verified, and how (method)

**Harness** — `tests/helpers/pg-release-database.ts` (new). It speaks to the
instance over loopback with `node-postgres`, **one TCP connection per session**,
so two sessions are two genuine backends:

- *Platform stub*, idempotent for a shared cluster: `anon` / `authenticated` /
  `service_role` roles (all `NOLOGIN`; `service_role` `BYPASSRLS`), the `auth`
  schema with `auth.users` and `auth.uid()` reading `request.jwt.claims` —
  the same surface the PGlite harness stubs, so both suites exercise the same
  migrations and policies.
- *Identities*: `db.as(userId, work)` / `db.asAnon(work)` open a transaction,
  `set_config('request.jwt.claims', …, true)` and `SET LOCAL ROLE` — mirroring
  the hosted request path (one transaction per request, claims read inside).
- *Concurrency primitives*: `db.open(identity)` returns an independent session
  with explicit `begin`/`commit`/`rollback`; an owner-level inspector session
  watches `pg_stat_activity` and `pg_locks`; `waitUntilBlocked` is the
  synchronization point (a test only proceeds once the waiting backend is
  observed parked on a lock); every wait is bounded (`lock_timeout`, and a
  `withTimeout` guard that cancels and fails the test rather than hanging).
- *Migration applier*: the repository's real files from `supabase/migrations/`,
  in `sort()` order, with `applyMigrations(to)` for the upgrade path.

**Suites** — `tests/pg-release/*.pgtest.ts`, run by
`npm run test:pgrelease` (its own vitest config; the default `npm test` does
not collect these files and stays green without any instance).

**Known limits of this gate** (contract): the hosted PostgREST/auth path, the
remote migration application, and hosted simultaneous-transaction behavior are
**UNVERIFIED** here — this gate validates the database layer and the migration
artifacts on real PostgreSQL 17.6, locally, with the hosted-specific request
surface faithfully stubbed.

## C. Migration verification (gate G1)

`tests/pg-release/migrations.pgtest.ts` — **8 tests, green**. Every statement
below ran against a fresh database built only by the repository's migration
files, in order.

- **Ordering.** The sequence is built **stepwise on separate databases** —
  up to version 13, then 14, then 15, then the latest — and at every boundary
  `app_schema_version()` equals exactly that version, so each file depends
  only on its predecessors and the function reports what actually ran
  (ending at **16**).
- **Fresh install surface.** The newest code's dependencies all exist as
  created by migrations alone: the functions (`create_vocabulary`,
  `create_vocabulary_with_senses`, `add/update/archive/restore/reorder/
  resume_vocabulary_sense`, `update_vocabulary`, `apply_review`,
  `record_review`, `app_schema_version`, …), exactly the two views
  (`effective_reviews`, `vocabulary_cards` with its `fsrs_due` column), all
  **eight triggers** with their before/after direction (projection sync,
  `senses_version` bump, touch times), the senses-table indexes (per-vocabulary
  position uniqueness, request-id uniqueness `WHERE request_id IS NOT NULL`),
  and RLS **enabled on every table** — all read from the catalogs (`pg_proc`,
  `pg_class`, `pg_trigger`, `pg_index`), not assumed.
- **Grants and RLS.** The sense calls (`add`, `update`, `resume`) are
  executable by `authenticated` and not by `anon`; the table keeps its
  `SELECT`/`INSERT`/`UPDATE` grants for the signed-in role, so refusals are
  policy-bound. The senses table carries **exactly five policies** — version
  13's permissive insert/select/update trio plus the **two v16 restrictive
  guards** (`vocabulary_senses_insert_guard`, `vocabulary_senses_update_guard`)
  — read from `pg_policies`, with each guard's condition asserted to contain
  the `deleted_at` liveness term and the `app.sense_recovery` escape hatch, so
  an accidental weakening fails the gate.
- **Upgrade from a pre-v13 database.** A schema-12 shape (words without
  senses, old column layout) upgrades through the full sequence: **every word,
  id and review row is preserved**, the v13 backfill gives each word its
  senses, and the projection (word columns ↔ first live sense) agrees
  afterwards.
- **Compatibility, both directions.** The version-12 code paths run against
  the newest schema: creating through the legacy call, and a repeated
  submission id answering with the word that already landed, exactly as v12
  relied on. In the other direction, **new code against an older schema**
  asks `capabilitiesAt` and is told what that schema cannot do — then the
  suite steps through every version v1…v8 and asserts each capability
  predicate matches the catalog's actual object presence at that version
  (sessions→`study_sessions`, undo→`review_logs.undoes_log_id`, fsrs→
  `fsrs_due`, analytics→`review_daily_stats`, goals→`daily_goal_minutes`,
  confidence, practice, library→`collections`, roots→`root_id`,
  senses→`vocabulary_senses` + `add_vocabulary_sense`).

## D. Security verification, including the direct-table write review (gate G3)

### D.1 The finding this gate had to close

FC-RC-FIX-011 left one documented residual: row-level security asked only
*whose* sense row it was, not *which word it belonged to* — so a direct table
write could reach past the calls. Measured on schema 15 against the real
instance (probe run, before any correction):

| Probe (all as the account itself) | Schema 15 answer |
| --- | --- |
| P1 — direct content edit on own **trashed** word's sense | **succeeded** (bypass confirmed) |
| P2 — direct insert of a sense into own **trashed** word | **succeeded** (bypass confirmed) |
| P3 — direct delete of own sense row | refused (`42501` — no permissive delete policy since v13) |
| P4 — direct insert attaching a new sense row to **another account's** word | refused (`23503` — the foreign key is checked through the row-level policies) |
| P5 — direct content edit of another account's sense | refused (0 rows — permissive policy filters) |
| P6 — anonymous direct insert | refused (`42501`) |

### D.2 The correction (schema version 16)

`supabase/migrations/20261025090000_senses_integrity_guard.sql` adds two
**restrictive** policies on `vocabulary_senses` (INSERT and UPDATE guards) —
conditions added on top of version 13's permissive policies, nothing removed:

- the row's word must belong to the account making the statement, and
- that word must be live — unless the statement is `resume_vocabulary_sense`,
  which announces itself with the transaction-local setting
  `app.sense_recovery=on` that it sets for its own transaction only. A table
  write cannot carry that setting; no granted function sets it except resume.
  `LATEST_SCHEMA_VERSION` is now **16**; the PGlite-visible surface is
  unchanged (policies and the recovery GUC live in the database).

Post-correction probe (same database shape, schema 16): P1 affects **0 rows**
(row-level filtering), P2 and P4 refuse by name (`vocabulary_senses_insert_guard`),
P3/P5/P6 unchanged. `tests/pg-release/security.pgtest.ts` verifies the full
matrix after the fix; `tests/pg-release/migrations.pgtest.ts` pins the five
policies and their guard conditions in the catalog.

### D.3 What remains open by design (documented, tested)

- A direct INSERT on the account's **own live** word still succeeds: the
  contract keeps the table usable for the legacy (schema-13) write path; the
  guard binds identity and liveness, not the choice of path.
- The table privileges are granted deliberately: since version 13,
  `authenticated` holds `SELECT`/`INSERT`/`UPDATE` on `vocabulary_senses`
  while `DELETE` is withheld at the grant level (hence no delete policy was
  ever needed), and `anon` holds nothing at all. The insert/update refusals
  therefore come from policies, not from missing grants — verified
  explicitly, so a refusal can never be mistaken for a provisioning error.
- The `service_role` bypass exists (bypasses RLS as an owner-level door) but
  **no client of the application connects as it** — the server's connection
  code was checked (single anon-key usage; `service_role` never referenced).
- `anon`/`authenticated` are `NOLOGIN`: no person can open a session as them,
  so the recovery setting is only reachable through the granted calls — the
  DB-level enforceability the contract requires. The hosted PostgREST surface
  itself stays UNVERIFIED (contract note).

## E. Concurrency verification (gate G2)

`tests/pg-release/concurrency.pgtest.ts` — **13 tests across C1–C8, green.**

**How the overlap is made and proved.** Every scenario follows one schedule,
built so that a sequential run could not produce the observed state:

1. Each actor is an **independent session** — its own TCP connection and its
   own backend: each session reports its own `pg_backend_pid()`, and the
   inspector then observes **that pid** in `pg_stat_activity`. Two actors per
   scenario, three in the C8 queue.
2. The holder begins and performs an **uncommitted write that takes the
   word's lock**.
3. The waiter begins the conflicting statement; the test waits, **bounded**,
   until the inspector session sees that backend **parked on the lock**
   (`waitUntilBlocked` → `pg_state = 'waiting'` with the lock wait). If the
   wait never materialises the test fails — the overlap is the assertion,
   not a comment.
4. Only then does the holder commit; both outcomes are collected as settled
   results (`settlesAs`), each bounded by `withTimeout(10s)` so nothing hangs,
   with `lock_timeout 8s` as a second bound inside every session.

Connection state is inspected directly: `locksHeld` reads `pg_locks` for the
holder's pid during the wait.

**What each scenario found:**

- **C1 — two edits to one sense.** Exactly one lands; the second answers the
  stale-version conflict (`P0003`) after having been observed blocked.
- **C2 — add interleaved with reorder.** A reorder that had seen the world
  before the add is refused rather than writing through it, and every sense
  survives **exactly once**; a reorder that arrives second sees the landed
  add and proceeds.
- **C3 — restore interleaved with add.** Identities and ordering stay stable
  whichever write lands first.
- **C4 — archive interleaved with edit.** The edit whose version the archive
  moved is rejected (`P0003`).
- **C5 — the same request id sent twice, at once.** One sense is created and
  **both** attempts are answered with it (the unique index fires, the loser
  looks up and names the winner); the same request id aimed at a different
  word is answered with the duplicate error and still only one sense exists.
- **C6 — legacy edit interleaved with a sense edit.** The competing sense edit
  is rejected by the version check, or lands second — in **both orders** the
  word's legacy projection and its senses tell one story afterwards.
- **C7 — import retry interleaved with a user edit.** The retry cannot
  overwrite an edit that landed first, and cannot bring back a word the user
  has thrown away since (the word stays trashed; the retry only completes its
  own rows).
- **C8 — contention and deadlock.** With **three** backends, one holder and two
  different calls (reorder, restore) queued behind the word lock — both seen
  blocked in `pg_stat_activity` before the commit — **every waiter completes
  within its timeout**: the reorder answers stale-version, the restore lands
  (final state: three senses, three distinct positions, the archived one back
  among the live). In the deliberate lock-order inversion, PostgreSQL reports
  `40P01` on **exactly one** side, that transaction rolls back whole, and
  nothing partial is ever committed (the word's projection still reads as the
  seed left it).

## F. Fault injection and recovery (gate G4)

`tests/pg-release/recovery.pgtest.ts` — **8 tests, green.** Faults are
injected as **triggers on the tables inside the real calls** (`before`/
`after insert|update`, raising `P0001`), so each failure lands in the middle
of a genuine operation; every test then asserts the state a user would find
afterwards. Triggers are dropped after each test.

**A failed statement leaves nothing behind:**

- A **reorder dying mid-flight** returns every sense to its original
  position and leaves `senses_version` where it was — no half-applied order.
- A **legacy edit dying on the sense's half** leaves the word's meaning and
  its first live sense both at the original value — the projection never
  diverges, not even transiently visible.
- An **initial import dying among its senses** leaves **no word and no
  sense** — `create_vocabulary_with_senses` is one statement and fails as
  one (checked by request id, by word key and by the sense bodies).
- A **sense call failing over review history** leaves the card's mastery and
  every review-log row exactly as they were.
- After any failed write, the **readers still agree** with the senses (word
  columns ↔ first live sense).

**An interrupted import:**

- The documented intermediate state (word landed, senses not) **finishes on
  the retry**, each sense under its own request id; **the whole file arriving
  again changes nothing** — every row lands on the sense it already made
  (`created = false`), no sense doubles.
- The retry **does not overwrite what the user changed since**: the user's
  later edit survives a re-arrival of the unchanged file.
- After the word was **thrown away**, the retry still completes its own rows
  through `resume_vocabulary_sense` (the recovery call, and only it), honours
  the archived flag the file carried, and **never brings the word back**
  (still trashed; exactly the live/archived split the file describes).

## G. Gates, commands, and exit codes (gate G5)

Every gate run to completion on this machine; commands exactly as executed:

| # | Command | Exit code | Result |
| --- | --- | --- | --- |
| 1 | `npx tsc --noEmit` | **0** | no type errors |
| 2 | `npx eslint .` | **0** | 0 errors, 0 warnings |
| 3 | `npx vitest run` (default config, PGlite suites) | **0** | 83 files, **1811 passed, 3 skipped** (1814), 194 s |
| 4 | `npm run build` (`typecheck` + `vite build` + `build:server`) | **0** | bundles written; only the known >500 kB chunk notice |
| 5 | `$env:PGREL_PASSWORD = 'rel012-local-only-pw'; npm run test:pgrelease` (instance from section A running) | **0** | 4 files, **42 passed** (G1 8, G2 13, G3 13, G4 8), 28 s |

Notes:

- The `.pgtest.ts` suites are only collected by their own config (gate 5);
  gate 3's output contains **zero** `.pgtest` files — the default suite needs
  no PostgreSQL instance, so ordinary development is never gated on this
  report's infrastructure.
- Gate 5 was **iterated while the suites were built** — the recorded clean
  run above is the last of several. Earlier runs found and fixed defects in
  the tests themselves: missing commits after successful waiters, a wrong
  final `senses_version` expectation, an update aimed at the word id instead
  of the sense id, expectations that ignored v13's deliberate `DELETE`-grant
  withholding and `anon`'s lack of table privileges, and a helper select
  missing the `id` column. All fixed; the final run (after the type/lint
  fixes below) is clean: 42/42, exit 0.
- During gate 1/2 iterations, type and lint defects in the new harness were
  fixed: a helper made generic, an unused variable removed, a wrapped error
  given `cause`, and the Vitest-4-removed `poolOptions` replaced with the
  top-level `fileParallelism: false` + `maxWorkers: 1` (behaviour unchanged:
  one file at a time).
- PGlite was used **only** as the regression gate (#3) — never as evidence
  for G1–G4, which all ran against the real PostgreSQL 17.6 instance.

## H. Findings, limits, recommendation

**Findings.**

1. **One real defect found and closed by this gate** — the direct-table write
   bypass on trashed words (section D). It existed on schema 15 with
   enforceable before/after probes; the corrective migration
   `supabase/migrations/20261025090000_senses_integrity_guard.sql` (schema
   16) closes it with restrictive policies, verified after the fact by the
   same probes and by gate G3 (13/13 green).
2. **No other gate-blocking defect.** Migrations (G1), true concurrency
   (G2), security matrix (G3) and fault/recovery (G4) all pass with the
   behaviours the contract specifies.
3. The corrective migration is **additive**: restrictive policies only —
   nothing revoked, no call signature changed, `LATEST_SCHEMA_VERSION` 15→16,
   PGlite-visible behaviour unchanged (gate 3 stayed green through the fix).

**Limits (contract scope).**

- **UNVERIFIED by contract:** the hosted PostgREST/auth request path, remote
  migration application, and simultaneous-transaction behaviour on hosted
  PostgreSQL. This gate proves the database layer and migration artifacts on
  a real local PostgreSQL 17.6 with the hosted request surface stubbed at the
  transaction/claims boundary.
- The local instance is **test-tuned** (fsync off etc.) and disposable — a
  correctness environment, not a production posture; it listens on loopback
  only with scram authentication, and was stopped at the end of the gate.
- Intentionally open, tested behaviour: a direct INSERT on the account's own
  **live** word remains possible (v13's compatibility surface), and
  `service_role` retains the bypass door that no application client uses.

**Final recommendation:** **LOCAL POSTGRESQL RELEASE GATE PASSED.**

(No deployment, commit, push, or remote migration was performed; technical
review by the Technical Lead and acceptance by the Product Owner remain
outside this gate.)
