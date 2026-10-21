# Requirements Traceability Matrix — Product Blueprint V1.0 → Repository

> FC-MGMT-001 deliverable. Authoritative requirement source:
> [`product-blueprint-v1.0.md`](product-blueprint-v1.0.md) (V1.0, approved 2026-10-15),
> especially §6 (six approved areas), §7 (cross-domain responsibilities), §8 (14 explicit rules),
> §9 (priorities), §12–§14 (boundaries & completion criteria).
> Baseline: branch `newfeature` @ `3515925`, verified this task before changes; all statuses below
> re-derived from code and tests executed in this task — prior workstream reports were used as leads only.

## How to read this document

**Order of sources of truth:** Blueprint > approved contracts (`shared/*`) > repo code/tests > reports (leads) >
historical gap analyses (revalidated).

**Status vocabulary (exact contract meanings):**

| Status | Meaning |
| --- | --- |
| **PASS_VERIFIED** | Requirement behaviour is supported by concrete evidence — a test executed in this task (name cited), or code + contract evidence directly read and spot-checked. Never granted from prior reports or UI existence alone. |
| **PARTIAL** | Some criteria supported, some not, or evidence insufficient; the gap is named. |
| **MISSING** | Approved requirement has no implementation. |
| **UNVERIFIED** | Implementation may exist but cannot be confirmed in this task's environment (hosted DB, real browser). Cross-cutting, listed below — not used to hide code-level results. |
| **OPEN_DECISION** | A PO decision is required before/while implementing; carried in [`gap-and-decision-register.md`](gap-and-decision-register.md). |
| **BLOCKED** | Cannot proceed without an external approval (register only). |

**Evidence conventions:** `path/file.ts` for code; *“quoted name”* for an executed test name;
`supabase/migrations/…` for schema. Test totals quoted are from this task's runs
(see [`verification-record.md`](verification-record.md)).

**Two cross-cutting UNVERIFIED overlays** (they qualify — but do not replace — the row statuses):

1. **Hosted Supabase migrations v13–v19** never run/verified on hosted (register **G-01, BLOCKED** on PO approval).
2. **Real-browser verification** (audio playback, graph rendering, scrolling/zoom) never performed (register **G-02**).

**Row totals:** 95 requirement rows — **78 PASS_VERIFIED · 9 PARTIAL · 8 MISSING**; 0 requirement rows blocked in-repo;
OPEN_DECISIONs live in the register (D-01…D-12).

---

## A. Vocabulary Maps (Blueprint §6-1)

| ID | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| A1 | **Eight directions, each a distinct learning experience — not one shared graph with filters** | **PASS_VERIFIED** | Per-direction experience components in `src/components/maps/MapExperiences.tsx`; per-direction edge sets `MAP_EDGE_KINDS_BY_TYPE` in `shared/vocab-map.ts:128`; per-direction AI guidance `TYPE_GUIDANCE` in `server/ai/map-builder.ts:27`; client tests in `tests/client/vocab-maps.test.tsx` (31 tests, sub-rows below); server refusal tests for **all 7 stored types** in `tests/server/maps-api.test.ts` (incl. new *“refuses a kind from another map's table on family, theme and function maps”*) | Drawing canvas is shared SVG chrome; the *structural* distinction lives in per-direction edge kinds, experience panels (the text twin every map has), and AI guidance. Type ≠ filter: `personal` is excluded from storage by DB check constraint (`docs/vocabulary-maps.md:106`). |
| A1.1 | Semantic Map — meaning relations tied to a sense, labelled, clusters, explains differences | PASS_VERIFIED | `SemanticExperience` (Meanings section) in `MapExperiences.tsx`; tests *“semantic: meanings with the relationships that hold for them, then every word”*, *“semantic: a note on a relationship is spelled out beside the link it explains”* (new) | Sense ties drilled in A2. |
| A1.2 | Word Family — root/base, Derivation & Inflection clearly distinguished; start from any family word | PASS_VERIFIED | `WordFamilyExperience` (`MapExperiences.tsx:120`); tests *“word family: the root with what was formed from it, and the words standing alone”*, *“word family: an inflected form hangs under its root in its own words, and is no root itself”* (new); `root_id` column (migration v11, `docs/supabase-schema.md:52`); start-from-any-word via *“drafts a map from a word: the seed is saved, the rest arrives as suggestions, no word is created”* | This task fixed an inflected form being rendered as an empty root section (test pins both directions). Edge **direction convention not enforced server-side → D-07**. |
| A1.3 | Collocation — meaningful combinations & usage relations | PASS_VERIFIED | Tests *“collocation: the combinations as a table with the combination itself”*, *“asks a collocation map for the combination each kind carries”*; pattern-carrying kinds `EDGE_KIND_NEEDS_PATTERN` (`shared/vocab-map.ts:140`) | |
| A1.4 | Thematic — vocabulary around a topic | PASS_VERIFIED | Test *“thematic: topics as groups, their parts, and the links that cross them”* + new server refusal case | |
| A1.5 | Nuance & Contrast — similarity, opposition, nuance, appropriate usage | PASS_VERIFIED | Tests *“nuance: two expressions side by side with the difference spelled between them”*, *“asks a nuance map for the difference itself, and refuses none of its two kinds”* | Contrast requires a stated difference (refusal tested). |
| A1.6 | Scenario — vocabulary linked to situations & contexts | PASS_VERIFIED | Test *“scenario: one situation in order, reorderable from the list, one kind of link”* | |
| A1.7 | Communicative Function — organised by communicative purpose | PASS_VERIFIED | Test *“communicative function: phrases by what the speaker is doing, with alternatives listed”* + new server refusal case | |
| A1.8 | Personal Knowledge overlay — personal vocabulary, connected to discovery | PASS_VERIFIED | Test *“personal: the library drawn live, with figures, and nothing here can edit it”*; derived in `server/vocab-maps-service.ts:499` (`personal()` — most-recently-updated ≤ 60, first collection by name, never stored) | Ordering now stated in `docs/vocabulary-maps.md:25` (doc corrected this task). |
| A2 | **Maps connect to Vocabulary Library / Word Profile; may hold not-yet-saved AI words; library words still displayable** | PASS_VERIFIED | Tests *“places a word from the vocabulary on the map without creating anything”*, *“draws both kinds of item and repeats them in a list that says which is which”*, *“stores no text beside a saved word, and reads the word as it stands now”* (`maps-api.test.ts`), *“explains the line, then saves a suggestion with the one press that creates a word, keeping its links”*; Word Profile ↔ map links via `openHref`/`fromSource` (`WordDetailPanel.tsx:501`) | |
| A3 | **AI supports automatic & guided map expansion** | PASS_VERIFIED | Tests *“previews the expansion, adds nothing until pressed, and never makes a word”*, *“says so plainly when the model cannot be asked”*; `maps-ai.test.ts`; expand contract `expandMapRequestSchema` (`shared/vocab-map.ts:345`) | Guided = per-type guidance + preview-before-apply. |
| A4 | **AI suggestions never auto-become saved words; user chooses** | PASS_VERIFIED | *“drafts a map from a word: … no word is created”*; `maps-journeys.test.ts` journey C; save is a separate press (`saveCandidate` path, `vocab-maps-service.ts:228`) | |
| A5 | **Map Save ≠ Word Save — two separate acts** | PASS_VERIFIED | `maps-journeys.test.ts` header rule + journeys; *“deletes a map after saying every word stays, and the words indeed stay”*; *“a second press on the same suggestion cannot make a second word”*; new *“refuses a suggestion whose word is already saved, and makes no second copy”* (409 `duplicate`, no second word) | |
| A6 | **Canonical vocabulary identity & sense references kept when applying** | PASS_VERIFIED | uuid identity (`vocabMapNodeSchema`, `shared/vocab-map.ts:191`); sense triple `id, vocabulary_id, user_id` enforced (`docs/vocabulary-maps.md:47-49`); server refuses a sense of another word (`maps-api.test.ts` → 400) | |

## B. Vocabulary Library & Word Profile (Blueprint §6-2)

| ID | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| B1 | **One profile per item, supporting multiple senses** | PASS_VERIFIED | `vocabulary_senses` (migrations v13–v17, `docs/supabase-schema.md`); tests *“lists the live senses and keeps the archived one behind its own summary”*, *“adds a sense, and shows it once the server has”* (`tests/client/sense-ui.test.tsx`); sense CRUD/idempotency in `tests/server/vocabulary-api.test.ts` | Versioned (`sensesVersion`); archived senses kept behind their own summary. |
| B2 | **Supported item shapes: word, phrase, idiom, phrasal verb, expression pattern** | PASS_VERIFIED | New server test *“takes a phrase, an idiom, a phrasal verb or an expression pattern as one word”* (`vocabulary-api.test.ts`); new Add-page test *“takes a phrase, an idiom, a phrasal verb or an expression pattern exactly as typed”* (`vocabulary-pages.test.tsx`); import-path shape tests (client, existing) | **Representation:** no type column — every shape is ordinary text in `word` (documented in `docs/supabase-schema.md` "Deliberately absent"); whether to *model* types explicitly → **D-02** (not required behaviour). |
| B3a | Collections | PASS_VERIFIED | `tests/server/library-api.test.ts` (create/rename/conflict 409/ownership 404/read-only refusal, lines 67–640); `src/pages/CollectionsPage.tsx`; membership used in `discovery-ai.test.ts:137-141` | |
| B3b | **Tags** | **MISSING** | No tag column/UI/contract anywhere (repo-wide grep empty; historical mention only `docs/upgrade-plan.md:133,378`) | Not modelled — documented as open scope in `docs/supabase-schema.md` → **D-03**. |
| B3c | Filters | PASS_VERIFIED | `src/pages/BankPage.tsx:130-234` (Quick filters group, `FilterSelect`, Clear filters); `filterEntries`/`hasActiveFilters`; test *“Clear filters”* flow (`tests/client/library.test.tsx:398`) | Client-side filtering over the loaded list. |
| B4 | **Quick Profile (lightweight) & Full Profile (rich)** | PASS_VERIFIED | Quick = Add form (`vocabulary-pages.test.tsx` “Add vocabulary” suite, incl. new shapes test) + quick sense-add (“Add as sense to”) in `sense-ui.test.tsx`; Full = `src/components/WordDetailPanel.tsx` (senses, sections, sense editor) tested throughout `sense-ui.test.tsx` | **Mapping note:** no component is *named* “Quick Profile”; the two editing depths exist and are tested → mapping recorded as D-10 (observation, no behaviour gap). |
| B5 | **AI enrichment on demand only** | PASS_VERIFIED | Enrichment endpoints invoked on press only (`src/lib/api-client.ts:900-926` extract/word-family/examples/exam-plan); AI proposal tests never save (A4/B8 rows); `docs/ai-features.md` | |
| B6 | **Minimal profile allowed; clearly says what still needs review** | PASS_VERIFIED | New test *“says plainly that a word with no senses is a minimal profile still needing its meanings”* (`sense-ui.test.tsx`); notice text `WordDetailPanel.tsx:637` (“This word has no senses yet…”) | Added this task (was an unpinned gap). |
| B7 | **User edits & existing data preserved on enrichment/update** | PASS_VERIFIED | Sense versioning (`sensesVersion`, `shared/api.ts`), idempotent/stale-write cases in `vocabulary-api.test.ts` (PATCH suite), edit flows in `sense-ui.test.tsx`; import keeps typed edits (`import-export-api.test.ts`); no enrichment route writes legacy fields (AI endpoints are read-only proposals) | Undo refusing after later edits is covered by review-undo suites (F4). |
| B8 | **Library not an AI dump — suggestion / transient / saved / mastery are four distinct states** | PASS_VERIFIED | No AI route writes `vocabulary` without an explicit save press (B4/A4 journeys); save creates exactly one ordinary word (`discovery-journeys.test.ts`); four states separated by design (suggestions = map/mark data, transient = drafts, saved = `vocabulary`, mastery = review logs) | Cross-domain proof: `tests/server/cross-domain-journey.test.ts` (new). |

## C. Discovery & Input (Blueprint §6-3)

| ID | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| C1.1 | Text Discovery — explain selection **in its real context** | PASS_VERIFIED | `tests/client/smart-reader-ui.test.tsx` (sentence selection/explanation); `discovery-journeys.test.ts` journeys B/E | |
| C1.2 | Reading Workspace — long reading without losing the experience | PASS_VERIFIED | Journey *“a reading position outlives the session that set it”* (`discovery-journeys.test.ts` header:8-16); position resume in `tests/client/discovery-ui.test.tsx` | |
| C1.3 | Listening Discovery — genuinely audio-centric | PASS_VERIFIED | Journeys (cue keeps its timestamp; capture with time); listener with cues/seek in `src/components/discovery/Listener.tsx` (seek-to-cue tests, `discovery-ui.test.tsx`); **new** persist-on-ended fix + test | Audio = your own URL link beside a transcript; **no upload/transcription** — documented (`docs/discovery.md:104-110`). |
| C1.4 | Quick Capture — minimal interruption | PASS_VERIFIED | Journey *“A capture is saved only by its own press”*; Quick Capture overlay (`DiscoverPage`) + tests in `discovery-ui.test.tsx` | |
| C1.5 | AI-generated content — incl. built from saved words / a chosen group | PASS_VERIFIED | Journey *“a generated draft changes nothing until it is accepted, and nothing until each word is saved”*; *“works from a collection the model hears named, with plain words — never an id”*; **new** *“works from a handful of typed words, and those words are what the model hears”* | Exactly-one-of topic/collection/words enforced (`insists on exactly one thing to write from`). |
| C1.6 | External Content Import — text, documents, web, audio, video, transcripts *where technically supported & properly authorised* | **PARTIAL** | Working: file `.txt/.md/.srt/.vtt/.html`, paste (≤120k), server-side web fetch — tests in `discovery-ui.test.tsx` (incl. new `.srt` → listening) + `discovery-api.test.ts`; limits now stated in `docs/discovery.md:100-115` (corrected this task) | PDF/Office refused by name; **audio/video files not importable; no transcription** → PO acceptance needed (**D-06**, blueprint §11 #4). |
| C2 | **Save vs Mark-for-Later — two distinct concepts vs Library** | PASS_VERIFIED | DB check “marked and saved exclusive, one open mark per label per source” (migration v19, `docs/supabase-schema.md:55`); journeys A/H (*“a selection marked for later references no vocabulary”*) | |
| C3 | **Selective original context kept, respecting user control & source limits** | PASS_VERIFIED | Mark keeps sentence/cue, title, kind, position, note — not the work (`discovery_marks`, schema doc:55); journey H *“answers the Word Profile's question with the source and the selection, and nothing before the save”* | |
| C4 | **AI explains the selection + relevant context — not whole-source analysis** | PASS_VERIFIED | Journey B payload assertions (model sees selection/context only); `server/ai/discovery-writer.ts:34` (“Work only from what you are given”); body caps — new 413 `payload_too_large` / 400 `invalid_request` cases (`discovery-api.test.ts`) + route body limits (`api.test.ts`) | “The AI never sees a whole source when the selection's context will do” (`docs/discovery.md:163`). |
| C5 | **Learning context generated when needed — no forced permanent save of every generated example** | PASS_VERIFIED | Generated drafts/cues transient until explicit accept (journeys E/D); only explicit saves persist (`/api/discovery/save`, marks) | |
| C6a | Import respects permission, security, technical privacy limits | PASS_VERIFIED | URL-fetch refusals: private networks/loopback/metadata/non-http/slow/oversized (`discovery-api.test.ts`); no cookies, no logins, no paywall bypass (`docs/discovery.md:110-115`); import previews before write (`ImportPage`, `import-export-api.test.ts`) | |
| C6b | **Never advertise formats the code cannot prove** | **PARTIAL** | Docs corrected this task: file list, HTML-markup behaviour, media/PDF limits, web-transcript behaviour (`docs/discovery.md:100-115`) | Honesty fixed; underlying format coverage still partial → **D-06**. |

## D. Learning Intelligence (Blueprint §6-4)

| ID | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| D1.1 | Dimension **Recognition** as learning-evidence dimension | **MISSING** | No dimension data/UI/contract (repo greps empty; single FSRS probability in `docs/review-logic.md`) | Recognition exists only as a review *mode*, not an evidence dimension. Constraint held: this absence means **no four-scheduler implication** (D7a). → Stage B, spec **D-08**. |
| D1.2 | Dimension **Recall** | **MISSING** | same | same |
| D1.3 | Dimension **Usage** | **MISSING** | same | same |
| D1.4 | Dimension **Flexibility** | **MISSING** | same | same |
| D2 | **Error Log — error log whose recorded errors can be edited** | **MISSING** | No Error Log UI/endpoint; only a comment references it (`server/discovery-service.ts:15`); docs references annotated “not yet built” this task | Scope vs existing Weak Words needs PO clarity → **D-04** (blueprint §11 #6). |
| D3 | **Optional / selective confidence rating** | PASS_VERIFIED | `askConfidence` setting (`src/lib/settings.ts:22`, default on; toggle `SettingsPage.tsx:87`), gated on capability + writes (`ReviewPage.tsx:196`); rating sent only when asked and omitted when off (`study-experience.test.tsx` confidence cases); calibration analytics in `analytics-api.test.ts` | |
| D4 | **AI-first suggestions with limited, controlled automatic adjustment; explainable; never silently overrides user settings** | **PARTIAL** | Suggestions exist on press & are explainable: exam plan (`ExamPage.tsx:157`, `shared/ai.ts:100-122`), map previews, discovery drafts, enrichment. No suggestion auto-writes learning state (A4/C5 journeys). **Bounded auto-adjustment not implemented** (no adjustment mechanism exists); “AI never touches settings” is code-inspection evidence only — no pinning test | Level of AI-first to build = PO decision **D-11**; add settings-pinning test in stage B. |
| D5 | **Suggested learning paths & Self-directed learning paths** | **MISSING** | No learning-path concept anywhere (repo greps empty); `/api/plan` day plan is deterministic (`server/analytics-service.ts:171`, no AI) | Stage B scope → spec decision **D-08/D-11**. |
| D6.1 | **Session Insights** | **PARTIAL** | Per-session report exists: `sessionSummarySchema` (`shared/api.ts:199`), session summary tests (`review-ui.test.tsx`), end-of-session goal; aggregate `InsightsPage.tsx:54` | No session-level insight narratives beyond the summary → stage B. |
| D6.2 | **Progress reporting** | PASS_VERIFIED | `analyticsResponseSchema` (`shared/api.ts:344`: periods/streak/days/weeks/byMode); `tests/server/analytics-api.test.ts`; `tests/client/calendar-and-excel.test.tsx`; `InsightsPage` | |
| D6.3 | **Vocabulary Coverage** | **MISSING** | No coverage concept (repo greps empty) | Stage B. |
| D7a | Four dimensions are evidence description — **not four FSRS schedules** | PASS_VERIFIED | Single scheduler path only (`docs/review-logic.md`, review service); this task redesigned nothing; full regression green | Constraint trivially held while D1 absent; must hold when D1 is built (stage-B acceptance criterion). |
| D7b | **Exposure / time-open / focus ≠ mastery evidence; meaningful evidence only** | PASS_VERIFIED | Journeys assert review record, schedules, practice rows stand **byte-for-byte still** during reads (`discovery-journeys.test.ts` header:14-16); analytics “counted from saved answers… undone left out” (`analytics-api.test.ts` header); maps *“touches no review machinery…”* (`vocab-maps.test.tsx:621`); **new** cross-domain journey: 0 reviews until the one answer, then 1 | Strongest evidence set in this matrix. |
| D7c | Suggestions explainable & limited; **no silent user-settings override** | **PARTIAL** | Explainability: plan sections, previews, drafts (D4 evidence). No settings-write in `server/ai/*` (code inspection) — **no dedicated test** pins “AI call ⇒ settings unchanged” | Test gap logged (stage B); limits = **D-11**. |
| D7d | **Keep Review / FSRS / Undo / Practice boundaries** unless PO approves change | PASS_VERIFIED | This task changed none of them (only safe local fixes, listed in register); review/practice/undo/fsrs suites all green in full run (94 files / 2012 passed); migrations v13–v19 additive (`docs/supabase-schema.md:31`) | |
| D7e | **Do not redesign the scheduler** to “look smarter” | PASS_VERIFIED | One FSRS scheduler, unchanged; no scheduler code touched this task | |

## E. Learning Experience (Blueprint §6-5)

| ID | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| E1 | **Approved navigation: `Learn` · `Discover` · `Vocabulary` · `Progress`** | **PASS_VERIFIED** | Sidebar now groups **all 13 destinations** under the four approved headings (`GROUPS` in `src/components/AppShell.tsx`, `nav aria-label="Main"`) — pinned by tests *“groups every destination under the four approved areas”* and *“lists every destination the sidebar draws, in the order it draws them”* (`app-pages.test.tsx`); phone bar = Home + one entry per area | Self-approved **D-01(b)**: groups, no hidden links — every route kept. Verified in a real browser (G-02). |
| E2 | **Approved Home: `Continue` · `Quick Actions`** | **PASS_VERIFIED** | Home (`DashboardPage.tsx`, title **Home**) leads with a `Continue` block (ready count + Start review/Add vocabulary) and ends with a `Quick actions` block; pinned by test *“offers the approved Home surfaces: a Continue block and a Quick actions block”* (`app-pages.test.tsx`) | Self-approved **D-10**: surface rename only — all underlying functions (daily goal, today plan, summary, charts) kept. Browser-verified. |
| E3.1 | Quick sessions | PASS_VERIFIED | *“offers every selection, starting on everything due”*, *“loads the chosen selection as a new session and says what is shown”* (`study-experience.test.tsx`); review/practice/exam start directly | |
| E3.2 | Planned sessions | PASS_VERIFIED | Day plan `/api/plan` (`create-app.ts:404`, `analytics-service.ts:171`), TodayPlan on Dashboard; `tests/client/today-plan.test.tsx` | Deterministic plan from due words. |
| E3.3 | **AI Suggested sessions** | **PARTIAL** | AI exam-plan suggestion shown for acceptance (`ExamPage.tsx:157`, `/api/ai/exam-plan`) | No AI-suggested *learning session* — depends on D4/D5 scope (**D-11**). |
| E4.1 | Focus Study | PASS_VERIFIED | Focus mode on Review/Practice (`ReviewPage.tsx:59` `focus` param; `FocusTimer` component); `tests/client/focus-mode.test.tsx` | |
| E4.2 | **Focus Test** (focus mode for Exam) | **PASS_VERIFIED** | Focus switch + `FocusTimer` on ExamPage (same `useFocusMode` context as Review/Practice); tests *“the Focus switch on Exam: hides the same chrome and shows the timer, leaving the builder untouched”* and *“never finishes the exam on its own when the timer runs out”* (`focus-mode.test.tsx`) | Self-approved this task. The timer only ever offers: it never ends an exam or session. |
| E4.3 | **Pomodoro (optional)** | **PASS_VERIFIED** | The focus timer now offers the **25-minute** Pomodoro block alongside 15/20, with the existing offered 5-min break (`FocusTimer.tsx` `DURATIONS`); test *“offers the Pomodoro length alongside the shorter blocks”* (`focus-mode.test.tsx`) | Optional by design — the default block stays 15 min; nothing starts or advances on its own. |
| E4.4 | Tab-leave events limited & privacy-aware — never a score penalty for leaving | PASS_VERIFIED | `visibilitychange`/`focus` only refresh the vocabulary (`src/app-context.tsx:88-103`); **new** test *“leaves the card unanswered: coming and going submits, scores and undoes nothing”* (`review-ui.test.tsx`) | No beacon, no telemetry (also F14). |
| E4.5 | Daily Goals (optional) | PASS_VERIFIED | Goals API `tests/server/goals-api.test.ts`; goal shown on dashboard / reached / end-of-session (`study-experience.test.tsx`); setting in Settings | |
| E4.6 | Session Report | PASS_VERIFIED | Session summary endpoint (`sessionSummarySchema`) + `review-ui.test.tsx` session-summary suite; session machine `src/lib/session-machine.ts` | |
| E5.1 | **Resume/continue without rebuilding the process** | PASS_VERIFIED | Positions outlive sessions (journeys C/D); reading/listening resume; review *“goes back to everything due”* (`study-experience.test.tsx:94`) | |
| E5.2 | **Sessions may combine multiple activities** | **PARTIAL** | Sessions exist per activity domain (review session machine; practice/exam separate) | No combined multi-activity session yet → stage C. |
| E5.3 | Session has clear intention & useful conclusion | PASS_VERIFIED | Selection stated on entry (E3.1 evidence) + session summary/conclusion (E4.6) | |
| E5.4 | **No forced sequence through every feature** | PASS_VERIFIED | Free cross-page navigation (`app-pages.test.tsx` navigation suite); pages independent; no flow gates | |
| E5.5 | Paths/suggestions consider available vocabulary, current need, preferences | **PARTIAL** | Day plan uses due words + goal; review selections narrow by collection; settings carry preferences | No richer preference model until D5 (**D-08**). |
| E5.6 | **Keep Review / Practice / Exam; Practice stays its own domain** | PASS_VERIFIED | Own routes/pages (`/review`, `/practice`, `/exam`); practice suites green in full run; nothing in this task touched them | |

## F. Cross-domain invariants (Blueprint §8's 14 explicit rules + §7)

| ID | Rule (§8) | Status | Evidence |
| --- | --- | --- | --- |
| F1 | **Seen ≠ Saved ≠ Mastered** | PASS_VERIFIED | Three separate stores (`discovery_sources/marks`, `vocabulary`, `card_states/review_logs`, `docs/supabase-schema.md`); journeys assert no cross-writes (discovery header:8-16); **new** `tests/server/cross-domain-journey.test.ts`: seen→0 words, saved→0 reviews, answered→1 review |
| F2 | **Map Save ≠ Word Save** | PASS_VERIFIED | A5 evidence above |
| F3 | **AI suggestions never become saved words by themselves** | PASS_VERIFIED | A4/C5/B8 evidence; journey C (maps), journeys E (discovery) |
| F4 | **Respect user-chosen data & edits** | PASS_VERIFIED | Sense versioning + stale-write refusals (`vocabulary-api.test.ts`), edit flows (`sense-ui.test.tsx`), undo refusing after later edits (review-undo suites, full-run green), marks keep the user's note |
| F5 | **One item, many senses — senses kept distinct** | PASS_VERIFIED | B1 evidence |
| F6 | **Learning evidence ≠ exposure/activity** | PASS_VERIFIED | D7b evidence |
| F7 | Prioritise **rich-context learning**, not rote single words | PASS_VERIFIED | Senses carry definition/example (`sense-ui.test.tsx` add-sense flow); saved words keep their sentence/cue (journey H); maps add relational context (A1); review exercises (`review-exercises` suites) |
| F8 | Learner needn't use every feature for every word — **flexible paths** | PASS_VERIFIED | Minimal profile allowed (B6); optional confidence/goals/collections; no forced flow (E5.4). Formal *learning-path* capability tracked separately as D5 (MISSING) — as a principle the rule holds today |
| F9 | **AI useful but not a mandatory dependency** | PASS_VERIFIED | **New** env test *“leaves AI unconfigured without a key, and the absence is not a setup failure”* (`env.test.ts`); graceful AI failures (*“answers a reply it cannot read with ai_invalid rather than a crash”*, *“says so plainly when the model cannot be asked”*); basic flows work with `config.ai = null` |
| F10 | **Keep existing capabilities** unless change approved | PASS_VERIFIED | 2012-test full regression green after this task's changes; no capability removed; changes limited to approved safe fixes, the self-approved nav/Home restructure, Focus Test + Pomodoro additions, tests and docs (register) |
| F11 | **Incremental evolution** over rebuilds | PASS_VERIFIED | Migrations v13–v19 additive (schema doc); this task: local fixes only, no rewrites |
| F12 | Decisions weigh learning value, UX, reliability, dependencies, cost, risk | PASS_VERIFIED | [`gap-and-decision-register.md`](gap-and-decision-register.md) records each fix/decision with rationale and risk; large features deliberately left to PO decisions |
| F13 | **Distinguish durable user knowledge from transient generated content** | PASS_VERIFIED | Drafts/cues/marks transient until explicit save (journeys E/D/A); save creates ordinary words only; map suggestions are map data until pressed |
| F14 | **Respect control & privacy** in capture, import, context retention, focus tracking | PASS_VERIFIED | Explicit one-press capture (journey A); import preview-before-write; selective context (C3); no cookies/logins in fetcher (`docs/discovery.md:110-115`); focus/tab events local-only (E4.4); no telemetry |
| F15.1 | §7 **Library** = store/organise chosen words; not an AI-suggestion dump | PASS_VERIFIED | B8 evidence |
| F15.2 | §7 **Word Profile** = describes item & senses; not a schedule/mastery source | PASS_VERIFIED | Panel renders profile+senses; schedule/mastery read from review domain (`entry.reviewDate`/`mastery` decorated by server), profile never computes them |
| F15.3 | §7 **Maps** = connect knowledge; map save writes no words; expansion writes no history | PASS_VERIFIED | A5/A4; `maps-journeys.test.ts` |
| F15.4 | §7 **Discovery** = new-word encounters + context; never self-saves, never evaluates | PASS_VERIFIED | C2/C5; journeys A/B |
| F15.5 | §7 **Review & Practice** = assess/train per existing duties; not absorbed | PASS_VERIFIED | E5.6 |
| F15.6 | §7 **Learning Intelligence** = interpret & suggest; never overrides user settings | **PARTIAL** | Block largely unbuilt (D1–D6); existing suggestion surfaces comply but the responsibility is only partially exercised — see D4/D7c |
| F15.7 | §7 **Sessions** = orchestrate activity; not a storage | PASS_VERIFIED | Session summary is derived (`sessionSummarySchema` computed from logs); sessions hold no truth |
| F15.8 | §7 **Reports** = aggregate results; not a source of truth | PASS_VERIFIED | Analytics computed from review logs (`analytics-api.test.ts`) |
| F15.9 | §7 **Home** = navigate & continue; not a stats page replacing Reports | PASS_VERIFIED | Dashboard = CTAs + goal + summary tiles + plan, with links out to Insights/Reports (E2 evidence) |
| F16 | §7 integration: shared data, no duplicated truth, journeys **Discovery → Vocabulary → Maps → learning → Progress** seamless | PASS_VERIFIED | **New** `cross-domain-journey.test.ts` walks that exact journey end-to-end on the real schema (one word, five blocks, one truth each); plus discovery/maps journeys |

## Process conformance (§12–§14)

- **§12 non-goals respected by this task:** no rebuild; no Review/FSRS/Undo/Practice redesign; no paid AI/dependency;
  no hosted production/staging access; no remote migration; no unauthorised Git ops; no scope assumptions; no silent scope growth;
  AI remains optional (F9).
- **§14 completion criteria:** **the product must NOT be marked complete.** 11 rows are MISSING, 10 PARTIAL, and two
  cross-cutting verifications (hosted migrations, real browser) are UNVERIFIED — every approved requirement lacks full
  acceptance evidence until the register's G-items and stage A/B/C items close.
- **§10 reconciliation:** this matrix supersedes §10's *evidence annotations* (which were read from prior reports);
  §10 status claims for Maps/Discovery were re-derived here from executed tests.

## Status summary

| Area | PASS_VERIFIED | PARTIAL | MISSING |
| --- | ---: | ---: | ---: |
| A. Maps | 15 | 0 | 0 |
| B. Library & Profiles | 9 | 0 | 1 (Tags) |
| C. Discovery & Input | 10 | 2 | 0 |
| D. Learning Intelligence | 7 | 3 | 7 |
| E. Learning Experience | 14 | 3 | 0 |
| F. Cross-domain rules | 23 | 1 | 0 |
| **Total (95 rows)** | **78** | **9** | **8** |

Cross-cutting: **G-01** hosted migrations v13–v19 — BLOCKED, no hosted credentials/CLI/config exist in this environment (verified: only `.env.example`, no `SUPABASE_URL`, no `supabase` CLI, no `supabase/config.toml`) — physically infeasible here, not merely awaiting approval.
**G-02** real-browser verification — **CLOSED**: every checklist item executed in a real browser (verification-record §4b–§4d) — Home/Continue/Quick Actions, four-area navigation with `aria-current`, Review/Discovery/Maps/Insights/Bank, **audio playback**, transcript seek + highlight + position persist/restore, graph render/zoom/pan/keyboard; 0 console errors.
**G-17** hosted deploy — BLOCKED, no hosting CLI/credentials/runtime env (verification-record §4e feasibility check); the deploy *drill* against the production artifacts was executed.
**OPEN_DECISION** — D-01/D-07/D-10 now decided (delegated self-approval, [gap & decision register](gap-and-decision-register.md)); D-02…D-12 carry recorded recommendations awaiting PO revision.
