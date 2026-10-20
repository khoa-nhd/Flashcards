# FC-SEC-013 — Verify and Secure the Sense Recovery Boundary

**Verdict: the original security claim was DISPROVEN on schema 16. It is corrected in
schema 17 and the correction is verified.** Final status at the end of this report.

Test evidence for every claim below was produced on the isolated local PostgreSQL 17.6
instance from FC-RELEASE-012 (`D:\pgrel012`, port 15432, loopback, scram, synthetic data
only), reusing the multi-connection harness `tests/helpers/pg-release-database.ts`.
Transcripts: `D:\pgrel012\work\sec013-g1-run2.txt` (first reproduction),
`D:\pgrel012\work\sec013-g1-run3.txt` (schema-16 reproduction re-run under the corrected
harness, see section D.3), `D:\pgrel012\work\sec013-g3-run3.txt` and
`D:\pgrel012\work\sec013-pg-full3.txt` (regression runs). No hosted Supabase was
contacted; nothing was committed, pushed or deployed; the instance is stopped again.

---

## A — Baseline and inspection (G0)

What schema 16 (`20261025090000_senses_integrity_guard.sql`) put in place:

1. Two **restrictive** policies on `public.vocabulary_senses`
   (`vocabulary_senses_insert_guard`, `vocabulary_senses_update_guard`, both `TO authenticated`).
   A row is reachable only if the word behind it belongs to `auth.uid()` **and**
   `(v.deleted_at is null or current_setting('app.sense_recovery', true) = 'on')`.
2. `public.resume_vocabulary_sense(uuid, text, text, text, uuid, boolean)` —
   `SECURITY INVOKER`, `set search_path = ''`, execute granted to `authenticated`
   only. After its own checks it called
   `perform set_config('app.sense_recovery', 'on', true)` so the restrictive guards
   would let it write into a trashed word.

The file's own header made the claim FC-SEC-013 questions: the setting is
"announced" by the call, and "a table write cannot carry that setting, so the
exception travels with that call and nowhere else". The question under test: does
the exception depend on anything a caller cannot forge?

## B — Reproduction on schema 16 (G1) — the claim is DISPROVEN

Environment: a fresh database with migrations pinned to the first 16 files
(schema 16 exactly), two independent identities — user A and user B — each on its
own connection, `current_user = authenticated`, session user
`rel012_authenticator` (non-superuser, section D.3). Every probe ran in its own
transaction and was rolled back; only the synthetic seed (steps 1–2) committed,
and the database was dropped afterwards.

**Step 1** — A creates an entry:

```
SQL>     select id from public.create_vocabulary('boundary-test','nghĩa gốc',3,...)
RESULT> {"id":"ac897a2c-db8f-4c11-a710-06f8a30c49c7"}
```

**Step 2** — A moves it to Trash (direct table update, the supported v12 path):

```
SQL>     update public.vocabulary set deleted_at = now() where id = 'ac897a2c-…' returning deleted_at
RESULT> {"deleted_at":"2026-10-17T10:53:05.212Z"}
state after step 2: {"senses":1,"meanings":"nghĩa gốc","deleted":true}
```

**Step 3** — ordinary direct writes, no context: refused, as designed.

```
STEP 3a  SQL> insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, version, request_id)
              values ('438a3062-…', 'ac897a2c-…', 9, 'DIRECT-SPOOF', 1, gen_random_uuid())
         RESULT> REFUSED code=42501 :: new row violates row-level security policy
                 "vocabulary_senses_insert_guard" for table "vocabulary_senses"

STEP 3b  SQL> update public.vocabulary_senses set meaning = 'DIRECT-SPOOF'
              where vocabulary_id = 'ac897a2c-…' and archived_at is null
         RESULT> executed; rows=[]   (matched nothing — verification select still reads
                 {"meaning":"nghĩa gốc","matched":"1"})
```

**Steps 4–5** — user A raises the custom setting inside its own transaction, then
repeats the writes. **Both spellings work; both writes land.**

```
STEP 4+5a  SQL> select set_config('app.sense_recovery', 'on', true) as set_to
             RESULT> executed; rows=[{"set_to":"on"}]
             SQL> insert … 'DIRECT-SPOOF' …
             RESULT> executed; rows=[]          ← INSERT LANDED
             SQL> select meaning, count(*) over () as matched …
             RESULT> [{"meaning":"nghĩa gốc","matched":"2"},
                      {"meaning":"DIRECT-SPOOF","matched":"2"}]

STEP 4+5b  SQL> select set_config('app.sense_recovery', 'on', true) …
             SQL> update public.vocabulary_senses set meaning = 'DIRECT-SPOOF' …
             RESULT> executed; rows=[]          ← UPDATE LANDED
             verification> [{"meaning":"DIRECT-SPOOF","matched":"1"}]   ← meaning rewritten

STEP 4c+5c SQL> set local app.sense_recovery = 'on'
             SQL> insert … 'DIRECT-SPOOF' …
             RESULT> executed; rows=[]          ← LANDED again
```

**Step 6** — user B, in its own session, with no spoofing, stays outside A's
records — this part of the design was never in doubt and held:

```
6a  B reads A's senses              → executed; rows=[]            (sees nothing)
6b  B direct INSERT into A's word   → REFUSED code=42501 (guard)
6c  B direct UPDATE of A's senses   → executed; rows=[]            (matched nothing)
6d  B calls add_vocabulary_sense    → REFUSED code=P0002 :: word not found
6e  B calls resume_vocabulary_sense → REFUSED code=P0002 :: word not found
```

**Anchors** (both identities, from inside the probe transactions):

```
{"current_user_":"authenticated","session_user_":"rel012_authenticator",
 "privileged":false,"roles_granted":"none"}
```

and the rule as it stood, read from the catalog:

```
vocabulary_senses_insert_guard  INSERT  (EXISTS (SELECT 1 FROM vocabulary v
    WHERE ((v.id = vocabulary_senses.vocabulary_id) AND (v.user_id = auth.uid())
    AND ((v.deleted_at IS NULL) OR (current_setting('app.sense_recovery'::text, true) = 'on'::text)))))
```

**Step 7** — after every rollback, the committed state is exactly the seed:
1 sense, original meaning, word still trashed.

**G1 verdict: the original security claim is DISPROVEN.** On schema 16, any
session running SQL as `authenticated` could raise `app.sense_recovery` itself —
a custom GUC needs no privilege to set — and then insert into or rewrite the
senses of its own trashed word directly, bypassing every call. Measured three
ways (two settings spellings × insert/update). Notably this did **not** leak
across accounts: the spoof only ever reached rows the attacker already owned
(the permissive policies still bound `user_id = auth.uid()`).

## C — Root cause

The v16 guard confused **a value** with **an authority**. `current_setting('app.sense_recovery')`
is caller-controlled by design: `SET` / `set_config` on custom settings is free to
every role. The v16 rationale ("no granted function sets it except resume") was true
of *functions* but irrelevant at the database layer, because the caller does not need
a function — they can set the GUC directly. A restrictive policy whose exception is a
settable value is not an exception at all.

## D — Correction (G2)

### D.1 The mechanism: a role, not a value

PostgreSQL can only anchor authority in things a caller cannot forge: **roles and
ownership**. Schema 17
(`supabase/migrations/20261026090000_sense_recovery_role.sql`, additive) does:

1. **A dedicated recovery role**, `app_sense_recovery`: `nologin`, without superuser /
   createrole / createdb / replication / bypassrls, **granted to nobody**, owning no
   table. It is the only `current_user` the guards' exception recognises.
2. **The guards restated** — same conditions, the exception swapped:
   `… and (v.deleted_at is null or current_user = 'app_sense_recovery')` — and the
   guards now also apply `TO authenticated, app_sense_recovery`, so even inside the
   call, the word must belong to the account the request's claims carry.
3. **`resume_vocabulary_sense` becomes `SECURITY DEFINER` owned by that role**
   (`search_path` pinned to `''`), body unchanged except that it no longer raises the
   setting: its authority is its owner. Execute stays `authenticated`-only.
4. **Permissive policies for the role**, mirroring v13's conditions (`user_id =
   (select auth.uid())`): `vocabulary` select+update (the word claim and the
   projection/bump triggers), `vocabulary_senses` select+insert+update. No delete
   anywhere — matching v13's withheld DELETE.
5. **Grants the body needs**: usage on schemas `public` and `auth`, execute on
   `auth.uid()`, select+update on `vocabulary`, select+insert+update on
   `vocabulary_senses`.
6. `app_schema_version()` → 17. `LATEST_SCHEMA_VERSION` bumped to 17.

`current_user` cannot be set, raised, claimed or configured; the only way to become
the role is to execute a function it owns. The membership that would open it is held
by nobody — the migration grants it to nobody, and role membership can only be added
by an explicit `GRANT … TO` (operational guardrail, section H).

### D.2 Audit of the definer (as G2 requires)

| Question | Answer, verified in G3 |
| --- | --- |
| Who owns it? | `app_sense_recovery` — `nologin`, no superuser/createrole/bypassrls/replication attributes, member of no role, owner of no table. Checked from `pg_roles` / `pg_auth_members` / `pg_proc` in `migrations.pgtest.ts`. |
| `search_path`? | Pinned to `''`; the body names only `pg_catalog` objects and schema-qualified ones (`auth.uid`, `public.*`). |
| Execute grants? | `authenticated` only. Verified: `has_function_privilege` → authenticated `true`, anon `false`, service_role `false`. |
| Does RLS still apply to it? | Yes — the role is not a table owner and has no BYPASSRLS, so its statements are subject to both the permissive policies (rows of the claims' account only) and both restrictive guards (word must belong to that account). The ownership check binds even inside the call. |
| What can misuse of the role ever touch? | Only rows of the account whose claims the request carries, and only through statements made while executing `resume_vocabulary_sense` — whose own checks (signed in, word is the account's, request id dedup) still run. |

### D.3 The harness had to be corrected first (evidence integrity)

The first G3 run showed `set role app_sense_recovery` **succeeding**. Investigation
(kept as evidence) showed why: `SET ROLE` is checked against the **session user**, and
the FC-RELEASE-012 harness connected every session as the superuser
`rel012_admin` — from a superuser session any role switch succeeds, including to
`service_role`. That is an artifact of the test environment, not of the schema:
hosted PostgREST connects as the non-superuser `authenticator` (a member of
`anon`/`authenticated` only). The harness now matches the hosted path: identity
sessions connect as `rel012_authenticator` (`login`, password from `PGREL_PASSWORD`,
memberships `anon`+`authenticated` only, nothing else); owner-level sessions
(admin, migrations, inspector) keep the owner connection. Under the corrected
session user, measured:

```
set role anon                 → OK        (legitimate member chain, as hosted)
set role service_role         → FAIL 42501 permission denied to set role
set role app_sense_recovery   → FAIL 42501 permission denied to set role
pg_auth_members touching app_sense_recovery: none (authenticated is member of nothing)
```

### D.4 Before / after, same probes

| Probe (as user A, own trashed word) | Schema 16 | Schema 17 |
| --- | --- | --- |
| `set_config('app.sense_recovery','on',true)` + direct INSERT | **landed** (row visible) | REFUSED `42501` `vocabulary_senses_insert_guard` |
| `set_config(…)` + direct UPDATE | **meaning rewritten** | executed, matched nothing, meaning unchanged |
| `set local app.sense_recovery = 'on'` + direct INSERT | **landed** | REFUSED `42501` (guard) |
| `set role app_sense_recovery` | (n/a — role not wired) | REFUSED `42501`; session stays `authenticated`; write still refused |
| Direct INSERT/UPDATE, no context | refused | refused (unchanged) |
| User B against A's records | refused / invisible | refused / invisible (unchanged) |

No policy in the database reads any custom setting anymore
(`select count(*) from pg_policies where qual/with_check like '%current_setting%'` → 0).

### D.5 Breaking-change judgement

No Product Owner stop was required, per the contract: the fix changes **no supported
direct-table privilege**. `authenticated` keeps SELECT/INSERT/UPDATE on
`vocabulary_senses` (DELETE still withheld) and keeps writing its own **live** words
directly — verified in G3 ("the ordinary direct writes exactly as version 13 set
them"). What the change removes is only the *spoofable* exception, which was never a
documented privilege but the vulnerability itself. All call signatures, answers and
the legacy paths are unchanged. The mechanism is additive: one role, extra policies,
one function's security mode, one new migration.

## E — Migration and compatibility impact

- New migration `20261026090000_sense_recovery_role.sql` (v17, additive; v16 left in
  place as history). `LATEST_SCHEMA_VERSION` = 17; migration count and version stay
  in step (17 files / 17). Capability-detection predicates unchanged — no app-gate
  or repository change beyond the version constant.
- Legacy application compatibility: verified live — v12 `create_vocabulary` with
  repeat-submission dedup, `update_vocabulary` patching, projection kept in step.
- Import recovery: interrupted import completes, retry on a trashed word works,
  the archived flag still archives, request-id idempotency unchanged, the word
  stays trashed.
- Hosted caveats (for when remote migration is authorized, still UNVERIFIED here):
  the migration needs a role-creation-capable role (standard for a migration
  runner) and the ability to grant on schema `auth` / `auth.uid()` for the
  definer — the same grants the stub provides locally. Nothing else in it is
  host-specific.
- `FC-RELEASE-012-REPORT.md` section D.2's statement that "a table write cannot
  carry that setting" is **superseded** by this report; the earlier report stands
  for everything else it measured.

## F — Regression verification (G3)

Seven areas, all in the new suite `tests/pg-release/recovery-boundary.pgtest.ts`
(11 tests), each probe in its own transaction, always rolled back:

1. **Unauthorized recovery-context spoofing** — both settings spellings refused by
   the named guard; the update direction matches nothing; `set role` refused with
   the session unchanged (savepoint proof); no policy reads any setting; the
   recovery role has zero membership edges; execute granted to `authenticated`
   alone.
2. **Legitimate interrupted-import recovery** — word-without-senses completed via
   the call; the projection trigger runs inside the definer path (shown word
   columns follow the new sense); repeat of the same request lands nothing.
3. **Retried import on a trashed word** — new sense created on the trashed word;
   the retry carrying the row's own request id archives it instead; the word
   stays trashed; another account's identical call is `P0002`.
4. **Cross-account isolation** — B, even with the setting raised, reads nothing of
   A's, matches nothing on update, and is refused insert (guard) and both calls
   (`P0002`).
5. **Ordinary sense operations** — live-word direct insert/update succeed,
   direct delete refused `42501` (privilege withheld), answers unchanged.
6. **Legacy application compatibility** — v12 create with repeat-submission dedup,
   `update_vocabulary` patch, projection in step.
7. **Concurrency and rollback** — two independent sessions resume the same trashed
   word with the same request id: the second is observed parked on the word's lock
   in `pg_stat_activity`, completes after the first commits, and exactly one row
   results; a recovery rolled back mid-transaction leaves senses, projection and
   `senses_version` exactly as before.

Gates, exact commands and exit codes (local PostgreSQL 17.6 up, `PGREL_PASSWORD` set):

| Gate | Command | Result | Exit |
| --- | --- | --- | --- |
| PostgreSQL release suite (5 files) | `npm run test:pgrelease` | **53 passed** (migrations 8, concurrency 13, security 13, recovery 8, recovery-boundary 11) | 0 |
| Full application tests | `npx vitest run` | 83 files, **1815 passed**, 3 skipped, 182 s | 0 |
| Typecheck | `npx tsc --noEmit` | clean | 0 |
| Lint | `npx eslint .` | clean | 0 |
| Build | `npm run build` | built in 651 ms (known baseline chunk-size warning) | 0 |

The spoof was **not** marked passable on attempt: every spoof attempt now fails
(42501 / 0 rows / 42501 on role switch), and the passing gate conditions on that.

Changed or added for G2/G3 (all uncommitted, tree otherwise preserved):

- `supabase/migrations/20261026090000_sense_recovery_role.sql` — new (v17).
- `server/supabase/supabase-database.ts` — `LATEST_SCHEMA_VERSION` 16 → 17.
- `tests/helpers/pg-release-database.ts` — identity sessions connect as the
  non-superuser `rel012_authenticator` (hosted-shaped session user).
- `tests/pg-release/recovery-boundary.pgtest.ts` — new suite (11 tests).
- `tests/pg-release/migrations.pgtest.ts` — policy pins updated to the v17 posture
  (8 policies, guard condition, roles, role attributes, definer owner).
- `tests/pg-release/security.pgtest.ts` — one rationale comment corrected (it still
  cited the disproven claim).
- `tests/database/schema.test.ts` — policy snapshot updated to the v17 posture.

## G — Remaining release blockers

1. **Hosted path stays UNVERIFIED by contract** — PostgREST/auth behaviour, remote
   migration application (including the v17 role creation and the `auth`-schema
   grants), and hosted simultaneous-transaction behaviour were not exercised and
   must not be claimed.
2. **Operational guardrail (named, not a defect):** the recovery role's safety
   rests on it having no members. Never `GRANT app_sense_recovery TO …` for
   `authenticated`, `anon` or any client-reachable role; no database object can
   prevent such a grant, so it belongs in review discipline.
3. **`service_role` remains the owner's door** (BYPASSRLS, NOLOGIN, no client
   connects as it) — unchanged posture from FC-RELEASE-012, documented, not
   widened by this change.
4. This gate itself supersedes FC-RELEASE-012's claim about the recovery setting
   (section E); the earlier report is not amended.

---

## Final status

# SECURITY GATE PASSED

The v16 bypass was real, was reproduced on genuine local PostgreSQL with synthetic
data, and is closed by schema 17 with a database-enforced, role-based mechanism that
no caller-settable value can enable. Legitimate recovery, idempotency, ownership,
archived senses, legacy compatibility, concurrency and rollback all hold; the full
gate set passes. Hosted verification remains outstanding by contract, not by finding.
