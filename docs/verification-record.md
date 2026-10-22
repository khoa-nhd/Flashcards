# Verification Record — FC-MGMT-001

> Durable record of what was executed, on which baseline, with which results.
> Companion to [`requirements-traceability.md`](requirements-traceability.md) and
> [`gap-and-decision-register.md`](gap-and-decision-register.md).

## 1. Environment

| Item | Value |
| --- | --- |
| Machine | Windows (win32), Node/npm on `D:\New folder\` |
| Repo | `khoa-nhd/Flashcards`, branch `newfeature` |
| Baseline commit | `3515925`, working tree **clean (0 entries)** at task start; upstream `origin/newfeature` |
| Test runner | Vitest **v5.0.3** (`npx vitest run`) |
| Local PostgreSQL | 17.6 @ `127.0.0.1:15432` (`D:\pgrel012\data`, local-only password) for pg-release |
| Contract constraints honoured | No commit / push / deploy / branch switch / stash / reset / remote migration / hosted access |

## 2. Baseline verification (before any change — all on `3515925`)

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | **exit 0** |
| Lint | `npx eslint .` | **exit 0** |
| Full unit/e2e | `npx vitest run --maxWorkers=4` | **93 files · 1990 passed · 3 skipped · exit 0** |
| Release suite (real PG) | `npx vitest run --config tests/pg-release/vitest.config.ts` | **5 files · 53 passed · exit 0** |

Notes:
- A first full-suite attempt run *concurrently* with tsc/eslint produced 4 worker-startup errors with all 89/89
  executed files passing — classified as **infrastructure contention**, re-run alone → clean baseline above.
  Lesson recorded: never overlap full vitest with other heavy Node processes.
- pg-release started the local PostgreSQL, ran migrations + security/recovery suites, stopped it again.

## 3. Changes made in this task (inventory)

**Product code (7 files — register Part 3):**
- Bug fixes: `src/components/discovery/ImportPanel.tsx` — URL-transcript routes to Listening (F-01);
  `src/components/discovery/Listener.tsx` — `onEnded` persists final position (F-02);
  `src/components/maps/MapExperiences.tsx` — family roots exclude all family-link starts (F-03).
- Self-approved under PO delegation (D-01/D-10/D-07): `src/components/AppShell.tsx` — four-area
  navigation holding all 13 destinations + Home/phone-bar restructure (F-04); `src/pages/DashboardPage.tsx`
  — Home with `Continue` / `Quick actions` blocks (F-04); `src/App.tsx` (page title, 404 link),
  `src/pages/SettingsPage.tsx` (label), `README.md` (tab table).
- Self-approved feature completion: `src/pages/ExamPage.tsx` — Focus switch + FocusTimer (F-05);
  `src/components/FocusTimer.tsx` — 25-min Pomodoro block (F-05); `server/ai/map-builder.ts` —
  word-family edge direction in guidance (F-06).

**Tests (13 modified + 1 new file, +22 tests — register Part 4):**
`tests/client/discovery-ui.test.tsx`, `tests/server/discovery-api.test.ts`, `tests/server/discovery-ai.test.ts`,
`tests/server/maps-api.test.ts`, `tests/client/vocab-maps.test.tsx`, `tests/server/vocabulary-api.test.ts`,
`tests/client/vocabulary-pages.test.tsx`, `tests/client/sense-ui.test.tsx`, `tests/client/app-pages.test.tsx`,
`tests/client/review-ui.test.tsx`, `tests/server/env.test.ts`, `tests/client/focus-mode.test.tsx`,
`tests/server/maps-ai.test.ts`,
**new** `tests/server/cross-domain-journey.test.ts`.
(Also `tests/client/study-experience.test.tsx` / `tests/client/today-plan.test.tsx` describe/comment renames only.)

**Documentation (4 corrected + 4 created + README):**
- Corrected: `docs/product-blueprint-v1.0.md` (typo `mới:_maps` at line 340), `docs/discovery.md` (file/media limits,
  HTML-markup behaviour, web-transcript → listening, Error Log “not yet built”), `docs/vocabulary-maps.md`
  (personal-map ordering precision, Error Log annotation), `docs/supabase-schema.md` (item types & tags explicitly
  not modelled).
- Created: this register's three companion documents + roadmap; all four updated after the self-approved changes.
- `README.md`: Home tab row + metrics comment.

**Untouched by design:** `shared/*` contracts, `supabase/migrations/*`, Review/FSRS/Undo/Practice code,
`package.json`, git history (a final commit of this work was authorised by the PO).

## 4. Post-change verification (final gate — after all edits)

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | **exit 0** |
| Lint | `npx eslint .` | **exit 0** |
| Full suite | `npx vitest run --maxWorkers=4` | **94 files · 2012 passed · 3 skipped · exit 0** (baseline 93/1990 → +1 file, +22 tests, **0 regressions**) |
| Production build | `npm run build` | **exit 0** (client bundle + `dist-server/index.js` 390.4 kB) |

Targeted suites run after their edits (all green):

| Suite | Result |
| --- | --- |
| `discovery-api.test.ts` + `discovery-ai.test.ts` | 42 passed |
| `maps-api.test.ts` | 30 passed |
| `vocab-maps.test.tsx` | 26 passed |
| `vocabulary-api.test.ts` + `vocabulary-pages.test.tsx` + `sense-ui.test.tsx` | 73 passed |
| `env.test.ts` + `review-ui.test.tsx` + `app-pages.test.tsx` | 109 passed |
| `cross-domain-journey.test.ts` (new) | 1 passed (first run) |
| `discovery-ui.test.tsx` | 16 passed |
| `app-pages.test.tsx` (nav/Home restructure) | 39 passed |
| `focus-mode.test.tsx` + `exam-mode.test.tsx` + `maps-ai.test.ts` (Focus Test/Pomodoro/direction) | 31 passed |

**pg-release (post-change):** not re-run after the self-approved changes — none touched a migration,
SQL file, or `tests/pg-release/*`; the baseline run (53/53) remains the valid result for those suites.

### 4b. Real-browser verification session (register G-02, surfaces changed this task)

Dev server (`npm run dev`, `localhost:5173`) + desktop browser, exercised by scripted DOM reads and clicks:

| Checked | Observed |
| --- | --- |
| Home title & structure | `document.title = "Home · Vocabulary"`; `h1 = Home`; headings: Continue, What to do today, Review activity, Progress to mastery, Recently added, Quick actions |
| Continue block | Present with “Ready to review”, Start review → `/review`, Add vocabulary → `/add` |
| Quick actions block | Present: View due today → `/bank?status=due_today`, View overdue, Browse mastered, Added in last 7 days, Weak words → `/weak`, Insights → `/insights` |
| Approved navigation | Sidebar `nav[aria-label="Main"]` has exactly the four groups — Learn (`/review`,`/practice`,`/weak`), Discover (`/discover`,`/maps`,`/map`), Vocabulary (`/add`,`/bank`,`/collections`), Progress (`/insights`,`/calendar`); Home link `aria-current="page"` |
| Navigation really works | Clicked Review → `/review`, `Review · Vocabulary`, flashcard rendered, Review link `aria-current="page"` (group Learn marked) |
| Pages render without errors | `/discover` (Discovery), `/maps` (Vocabulary maps), `/insights` (Insights), `/bank` (Vocabulary bank) — correct h1/title, no `role="alert"` error |

Original G-02 remainder (audio, transcript, graph) — **verified in §4d below**.

### 4c. Real-browser verification — Focus Test & Pomodoro (F-05)

Dev server (`localhost:5173`) + desktop browser, on `/exam`:

| Checked | Observed |
| --- | --- |
| Exam page | `document.title = "Exam · Vocabulary"`; `h1 = Exam`; “Start the exam” present |
| Focus switch | Button present, `aria-pressed=false` → click → `aria-pressed=true` |
| Chrome hides | Both `nav[aria-label="Main"]` (sidebar + phone bar) leave the DOM — 2 → 0 |
| Timer appears | `role="group" aria-label="Focus timer"`; durations **15 min / 20 min / 25 min**; countdown runs |
| Exam unaffected | “Start the exam” still present in focus — the timer never finishes the exam |
| Pomodoro length | Click **25 min** → countdown `25:00`, `aria-pressed=true` on 25, `false` on 15/20 |
| Focus off | Chrome returns (0 → 2 `nav[aria-label="Main"]`), timer removed, builder intact |
| Console | 0 errors |

Word-family edge direction (F-06) is server-side prompt content — verified by the maps-ai test
(§4 targeted suites), not reachable from the browser without an AI key.

### 4d. Real-browser verification — the rest of G-02 (audio, transcript, graph)

Dev server (`localhost:5173`) + desktop browser. Test data created through the API: a Listening source
(5 timestamped SRT cues) and a semantic map with 3 nodes + 1 edge.

| Checked | Observed |
| --- | --- |
| Audio playback | Public MP3 address entered → `paused=false`, `readyState=4`, `currentTime` 0 → 1.38s after 1.5s (playing for real), `error=null` |
| Transcript seek | Click `Seek to 0:15` → `audio.currentTime = 15` exactly |
| Highlight follows time | The 0:15 cue carries `aria-current="true"` + accent background before and after the seek; the active cue switched at once |
| Position persist | Server round-trip: source shows `position: {seconds: 15}` after the seek |
| Position restore | Reload (the address is an input by design, re-entered) → metadata loads → `currentTime = 15` restored from `position.seconds`, correct cue active, `paused = true` — nothing starts on its own |
| Transcript scroll | The container is a plain scrolling `<ol>` — **no auto-scroll feature exists** (by design); scroll is native, and it is the *time* position that is restored (above) |
| Graph render | `/maps?map=<id>` → SVG `role="group"` “Map drawing: 3 items…”, 3 node labels, “Related to” edge row |
| Graph zoom | Zoom in: viewBox `0 0 640 320` → `0 0 512 256`; two Zoom outs → `0 0 853.33 426.67`; Fit → `0 0 640 320` |
| Graph pan | Pointer drag on the canvas background: viewBox x/y `0 0` → `-178.77 -133.33` → `-125.14 -100` (pan follows the drag; synthetic pointers only stubbed `setPointerCapture`, which a real mouse drag exercises natively) |
| Graph keyboard | Focus a node (`tabIndex=0`) + real Enter key → that node `aria-pressed="true"`, the others `false` |
| Console | 0 errors across the session |

### 4e. Deploy drill (production artifacts, local)

Feasibility check first: `vercel.json` exists (Vite → `dist/`, serverless `api/index.ts`, SPA rewrites),
but **no CLI** (`vercel`/`netlify`/`docker` not installed), **no credentials** (`VERCEL_TOKEN`/
`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` not set, no `.vercel/` link) and **no runtime env** (`SUPABASE_URL`/
`SUPABASE_ANON_KEY`/`AI_API_KEY` not set — only `.env.example`). A real deploy is therefore **blocked
on environment**, like G-01; what was executable was drilled against the real build output:

| Drill | Command | Observed |
| --- | --- | --- |
| Self-host production boot (mock data) | `NODE_ENV=production DATA_MODE=mock PORT=8123 node dist-server/index.js` | `GET /` → 200 `text/html` 948 B with the SPA root; `GET /review` → 200 SPA fallback (refresh on any path works); `/assets/index-*.js` → 200 `text/javascript` 761,827 B; `GET /api/vocabulary` → 200 JSON |
| Production with missing Supabase env (the real deploy's day-one state) | `NODE_ENV=production PORT=8124 node dist-server/index.js` (no env) | Boots, serves the SPA; API answers **503** with reasons; startup log prints `setup issue: SUPABASE_URL is not set.` / `SUPABASE_ANON_KEY is not set.` — fail-safe, no crash |

### 4f. Product completeness audit → Settings copy defect (G-18)

A **read-only** product completeness audit (99 requirements + 14 invariants; no files touched
during the audit itself) was delivered 2026-10-22 — result **87 PASS_VERIFIED · 22 PARTIAL ·
4 MISSING · 0 UNVERIFIED**. Its single *confirmed defect* (everything else listed was missing
verification, not broken behaviour) was stale in-app copy, fixed and re-verified in the same task:

| Check | Observed |
| --- | --- |
| Defect | `src/pages/SettingsPage.tsx` said *"Two features can ask an AI model… both features stay off"* while `docs/ai-features.md:3,30` documents **eight** AI features (grep: no test or doc pinned the stale text) |
| Fix | Copy rewritten to the accurate eight-feature description: names all eight, states each request carries only that feature's own payload (never whole library/history/settings/other accounts), keeps the provider-retention warning and the no-key behaviour |
| Browser (`/settings`, real Chrome) | Paragraph reads *"Eight features can ask an AI model for a draft: Smart Reader, the Writing Challenge coach, word families, example sentences, exam plans, vocabulary maps, and Discovery's Explain…"* — "Two features" absent from the DOM; **0 console errors** |
| Gates re-run after all edits | `tsc --noEmit` **0** · `eslint .` **0** · `smart-reader-ui` **5/5** · full suite **94 files / 2012 passed / 3 skipped** |

## 5. Deliberately not verified / not attempted

| Item | Status | Why |
| --- | --- | --- |
| Hosted Supabase migrations v13–v19 | **BLOCKED — physically infeasible here** | Feasibility check this task: no hosted credentials, no `supabase` CLI, no `supabase/config.toml` in the environment (register G-01). Approval alone cannot close it — PO must supply hosted access |
| Real-browser remainder of G-02 (audio, transcript seek/restore, graph zoom/pan/keyboard) | **CLOSED — verified in §4d** | Was carried as the un-exercised half; now executed in a real browser this task |
| Hosted deploy (Vercel, per `vercel.json`) | **BLOCKED — physically infeasible here (G-17)** | Feasibility check (§4e): no CLI, no Vercel credentials, no hosted runtime env. Approval alone cannot close it — PO must supply the account/token and hosted Supabase/AI env; the deploy *drill* against production artifacts was executed (§4e) |
| Paid AI providers / new dependencies | Not evaluated | Approval gate (Blueprint §12) |

## 6. Reproduction commands

```powershell
$env:PATH += ";D:\New folder"
npx tsc --noEmit                 # types
npx eslint .                     # lint
npx vitest run --maxWorkers=4    # full suite (~6 min; run ALONE, never concurrently with tsc/eslint)
npm run build                    # production build
# release suite (starts local PG on :15432 itself):
npx vitest run --config tests/pg-release/vitest.config.ts
# browser session (UI verification of G-02 surfaces):
npm run dev                      # → http://localhost:5173/
```

## 7. Sign-off statement

All four local quality gates (types, lint, full test suite, production build) are **green on the post-change tree**,
and the changed surfaces were verified in a real browser (§4b). Requirement-level results are in the
[traceability matrix](requirements-traceability.md): **78 PASS_VERIFIED · 9 PARTIAL · 8 MISSING** across 95 rows,
with G-01 (hosted migrations) and G-17 (hosted deploy) blocked on environment credentials and G-02's
browser checklist now fully executed (§4b–§4d), plus a local deploy drill against the production
artifacts (§4e). Decisions D-01/D-07/D-10 were
decided and implemented under the PO's delegated self-approval; D-02…D-12 carry recorded recommended outcomes the PO
may revise ([gap register](gap-and-decision-register.md) Part 2). Per Blueprint §14 and the task contract,
**the product is not claimed complete**: every remaining MISSING/PARTIAL row is itemised in the
[gap register](gap-and-decision-register.md) and sequenced in the [roadmap](execution-roadmap.md).
