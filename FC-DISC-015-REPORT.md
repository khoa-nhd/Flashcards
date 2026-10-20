# FC-DISC-015 — Discovery & Input: implementation report

## 1. Summary

Discovery & Input is built end to end: Quick Capture, Text Discovery with a
Reading Workspace, Listening Discovery, AI-generated Discovery Content, and
External Content Import, all under the one rule the workstream demanded —
**a word becomes a word only when the learner presses Save**. The feature
ships as database version 19 (additive only), eleven `/api/discovery`
routes plus one guarded fetch route, a stateless AI draft and an
explanation that reuse existing AI infrastructure, eight new UI components
over one new page (`/discover`), a global Alt+K capture dialog, an
in-memory fake mirroring every server rule for the client tests, and four
new server test suites plus one client suite covering journeys A–J.

**Overall outcome: PASS** — implemented, self-verified in development by
every gate the contract named, with exactly two items that cannot be
claimed from this environment: behaviour on a hosted Supabase project
(v19 must be run by the owner) and real-browser verification of audio
playback. Both are contract-classified UNVERIFIED and detailed in
§12. None of the contract's non-negotiables was crossed: nothing was
committed, pushed, deployed, no dependency or paid service was added, and
no learning rule (Review/FSRS/Undo/Practice/mastery/Error Log) was
touched.

## 2. How to see it in the running app

- **Quick capture**: Alt+K (or the button above the sidebar) on any page.
- **Discovery page**: the *Discovery* item in the sidebar → five views in
  the address (`/discover?view=text|read|listen|generate|import`, plus
  `&source=<id>` for an open source), so reload, bookmark and Back all
  behave.
- **Reading**: open any source of the reading kind, select a word.
- **Listening**: open an `.srt`/`.vtt` import (or any transcript source);
  give the tab an audio address to play.
- **Generate**: Discovery → Generate → topic, one saved collection, or a
  word list → *Write a draft* → *Use this reading*.
- **Import**: Discovery → Import → file, paste, or web address.

Requires schema 19. Where the database is older, the routes answer 404 and
the pages say the feature is not available yet — the rest of the app is
unaffected.

## 3. Domain model and schema (G1 — PASS)

`supabase/migrations/20261028090000_discovery.sql` (version 19, additive
only; verified on PGlite suites and on real PostgreSQL 17.6):

- **`discovery_sources`** — one found text: `kind` in
  `text|reading|listening|generated|imported|web|capture`, trimmed title
  (1–200), `origin` (≤400, never content), `content` (≤120,000) with
  `content_kind` `plain|transcript`, `position` jsonb (`offset` for
  reading, `seconds` for listening), `revision`, and a per-account unique
  `request_id` for idempotent creates.
- **`discovery_marks`** — one kept selection: label (1–200), context
  (≤2,000 — the sentence or cue, never the whole source), `char_offset`
  or a `cue_start`/`cue_end` pair (checked equal-or-both-null), note
  (≤600), and `vocabulary_id` + `saved_at` with the check
  `(saved_at is null) = (vocabulary_id is null)` — *marked* and *saved*
  are exclusive states, and the saved state is exactly the explicit-save
  path. A partial unique index keeps one **open** mark per label per
  source; saved marks index to `vocabulary` for the Word-Profile
  back-link. Deleting a source cascades its marks; saved words survive.
  (The vocabulary side is deleted only by trash-soft flows in this app, so
  the FK's `on delete set null` never meets the pair check in practice.)
- **`bump_discovery_source_revision(uuid)`** — owner-checked RPC used by
  title updates only; position writes never bump and never conflict.
- RLS: owner-only `using`/`with check` on both tables, grants to
  `authenticated` only, indexes for the list/marks/back-link queries.

Nothing existing is altered: no table, column, function or policy from
versions 1–18 changes. The server feature-gates on
`app_schema_version() >= 19`; below it, discovery is `null` and the API
answers 404 `not_found` for the feature.

Client contract: `shared/discovery.ts` (kinds, limits, schemas,
`tidyDiscoveryTitle`, `sentenceAround`, `contextWindow`), consumed by the
server routes, the real client and the fake alike.

## 4. API surface

Eleven routes under `/api/discovery` plus the fetch route
(`server/create-app.ts`), all documented with examples in
[docs/discovery.md](docs/discovery.md):

`GET /` (summaries) · `POST /` (create) · `GET /:id` (document) ·
`PATCH /:id` (title with `ifMatch` → 409 `conflict`+`duplicate`, or
position without) · `DELETE /:id` · `GET /marks` (open only) ·
`POST /:id/marks` (mark — never a word) · `POST /marks/:id/save` (the
explicit save: one ordinary vocabulary row via the same writer the Add
form uses, keeping sentence/cue, source title/kind, position and note) ·
`DELETE /marks/:id` (dismiss) · `POST /generate` (stateless draft) ·
`POST /fetch-url` (guarded server-side fetch, **not** rate-gated by
writes since it stores nothing).

- Bodies: discovery routes accept up to **400 KB** (content travels in the
  request), others 96 KB. Every error is a named code (`invalid_request`,
  `not_found`, `conflict`+`duplicate` with the clashing entries at the
  error body's top level, `read_only`, `rate_limited`, `ai_invalid`,
  `not_supported`, `setup_incomplete`) and the pages translate each into
  an actionable sentence.
- `REVIEW_WRITES_ENABLED=false` refuses every discovery write — including
  generate — with 403 `read_only`, and the UI says so without losing the
  learner's text.
- Client: `DiscoveryApi` (13 methods) in `src/lib/api-client.ts`,
  intersected into `AppApi`; reads use the queue timeout, writes the
  action timeout.

## 5. Quick Capture (G2 — PASS)

A dialog over any page (Alt+K with repeat/modifier/IME/contentEditable
guards; a sidebar and a mobile-header button). Accepts a word, phrase,
collocation, idiom or pattern with an optional meaning and note; no AI is
involved. It keeps one standing `capture` source per account (found by
kind, created once). Save now and Mark for later are two distinct presses;
a word already in the bank produces the duplicate offering — *Open the
existing word* or *Keep both words* — and creates nothing until one of the
two is chosen. Success, duplicate, incomplete (button disabled while
empty), failure and read-only states are each named and shown. The dialog
remounts on every opening, so nothing carries over between captures.

## 6. Text Discovery & Reading Workspace (G3 — PASS)

`TextSourcesPanel` lists every source with its origin and what waits in
it, and pastes new texts in. `Reader` opens a source: title, kind, origin,
paragraph navigation (*Paragraph n of m*, Previous/Next, keyboard- and
pointer-free path included), and the text rendered as **one plain-text
node** — imported markup can never act. Selections produce the
`SelectionPanel`: *Explain this word* (see §8), *Save to vocabulary*
(keeping the sentence, the source and the offset; duplicates offer
reuse), *Mark for later* (no word), *Dismiss* (nothing stored), and one
shared note field. Position is persisted on selection and paragraph jump
and restored on the next opening — *Picked up where you left off* — with
loading, missing, empty and error+retry states each saying what happened.
Navigation was not redesigned: the page is added to the existing shell,
and the address carries view and source. Word Profile links back to the
source through `findWordContext` (*Found in …*), which 404s quietly for
words that were typed by hand.

## 7. Listening Discovery (G4 — PASS, with documented limitations)

Listening is first-class: transcript sources open with cue-by-cue
timestamps — press a time to seek, play/pause and a seek bar over the
browser's own `<audio>`, the playing line highlighted, and a speak button
through the browser's own `speechSynthesis` (guarded when absent).
Selections inside a cue carry that cue's `cueStart`/`cueEnd` through
explain and save. The listening position is kept in seconds and resumed on
`loadedmetadata`. A transcript without timestamps still reads and
captures; the panel says why seeking is unavailable.

Deliberate limitations, each stated in the UI and in
[docs/discovery.md](docs/discovery.md): **no transcription exists** (no
speech-to-text, no upload of audio, no new paid service); the audio
address is **session-only** — kept in memory for the tab, never written
back to the source; playback supports only what the browser plays, and an
address that fails says so while the transcript keeps working. A transcript
source is created with its content (the update schema deliberately allows
only title+position), so the manual-transcript path is create/paste or
`.srt`/`.vtt` import.

## 8. AI-generated Discovery Content (G5 — PASS)

Two model features, both off by name without a configured model
(`ai-features.md` documents both, their buckets and their failure states):

- **Explain this word** reuses `POST /api/ai/extract` (Smart Reader's
  route and per-account bucket). The client sends only
  `contextWindow(content, offset, AI_LIMITS.passage)` around the
  selection — never the source, never the library; the example sentence
  shown comes back from the server. Failures (no model, timeout,
  rate-limit, invalid output, read-only) land back on the form with the
  selection intact.
- **Draft a reading** (`POST /api/discovery/generate`) takes exactly one
  of topic / one saved collection / a word list, plus objective and
  length; seeds are resolved server-side and the reply is validated
  against a strict schema (nonsense discarded). The draft is shown as a
  preview with its candidate words as chips; **nothing is stored until
  acceptance**, where it becomes one `generated` source — the candidates
  arrive as marks, never as saved words, the collection is read-only in
  the flow, and no overwrite is possible. Its own bucket of 5/min;
  deterministic model stubs in tests; no live keys anywhere in the
  default suite. No generated audio is produced or promised.

## 9. External Content Import (G6 — PASS)

Three modes behind one rule — *validate, preview, then one press*:

- **File**: extension whitelist (`.txt .md .srt .vtt .html`), NUL-byte
  binary check, 120,000-char cap, empty check; PDF/Office refused by name
  with what-to-do-instead (PDF extraction is not built — documented, not
  faked). `.srt`/`.vtt` (or transcript-shaped text) open as listening.
- **Paste**: same checks, title from the field or the first line.
- **Web address**: `server/web-importer.ts` fetches **server-side** with
  the full SSRF guard — scheme allow-list, DNS resolution before the
  request **and again on every redirect**, loopback/private-range/
  link-local/cloud-metadata refusal, response content-type restricted to
  readable text, size cap and timeouts — then strips script/style/markup
  to plain text. No cookies, no credentials, no auth/paywall bypass; each
  refusal maps to its own actionable message in the panel. The preview
  stores **nothing**; *Open* creates exactly the text seen, as `web`,
  `listening` or `imported`, and only then does a workspace hold it.
  Content is stored and rendered as plain text throughout, so imported
  scripts can never execute. No new dependency or unapproved service was
  used anywhere in the import path.

## 10. Journeys (G7 — PASS, 10/10)

Server: `tests/server/discovery-journeys.test.ts` — one test per journey,
all green. Client: `tests/client/discovery-ui.test.tsx` — 13 tests,
rendering the real `App` over the in-memory fake.

| Journey | Where it is proved |
| --- | --- |
| A capture-phrase | client *"quick capture… saves a typed phrase… on the one press"*; server A |
| B select → explain → save | client *"explains the selection from its sentence alone…"*; server B |
| C mark without saving | client *"marks a selection without saving it, and dismissing…"*; server C |
| D workspace state recovery | client *"remembers where the reader was, and says so…"* (position PATCH + restore on remount); server D |
| E listening capture | client *"seeks by a cue's own time and captures a word with that cue behind it"*; server E |
| F generate from collection | client *"previews the draft, keeps everything untouched, and creates only on acceptance"*; server F |
| G import → preview → workspace | client (paste, file-refusal, URL-preview) three tests; server G |
| H word profile → back to source | client *"…offers the way back"* (*Found in* → back link → panel closes); server H |
| I duplicate reuse | client *"offers the existing word when the phrase is already saved…"*; server I |
| J discovery never touches Review/FSRS/Undo/Practice/mastery/Error Log | server J: learning-state snapshots (`card_states` by `vocabulary_id`, `review_logs`/`study_sessions` by id) around every discovery flow, with the one legitimate delta — an explicit save adds exactly one default-mastery `card_states` row, asserted as such; client *"Opening a source of any kind saves no word by itself"* |

## 11. Tests and gates (G8 — PASS)

Exact commands, all run in this workspace with bounded workers:

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | clean |
| Lint | `npx eslint .` | clean |
| Unit/integration | `npx vitest run --maxWorkers=4` | **93 files, 1990 passed, 3 skipped**, 247.7s |
| Build | `npm run build` | succeeds (only the pre-existing >500 kB chunk warning) |
| Real-PG release suites | `npx vitest run --config tests/pg-release/vitest.config.ts` (local PostgreSQL **17.6** at `127.0.0.1:15432`, `PGREL_PASSWORD` set, instance started for the run and stopped afterwards) | **5 files, 53 passed**, 41.3s |

New suites within that run: `tests/server/discovery-api.test.ts`
(30/30 — ownership, provenance, marks-vs-saved, duplicates, limits,
read-only, version gating), `discovery-ai.test.ts` + `discovery-url.test.ts`
(25 — selection-only prompts asserted from the model's point of view,
invalid-output discard, every SSRF vector: localhost, private ranges,
metadata address, redirect-to-private, bad scheme, wrong content-type,
oversize, timeout; deterministic stubs, no live keys), and
`discovery-journeys.test.ts` (10/10). Client: `discovery-ui.test.tsx`
(13/13). The 3 skips are the pre-existing fixture-gated
`describe.skipIf(latest === undefined)` block in `backup-import.test.ts`,
untouched by this work. v19 pins in `gateway-versions` and `undo-api`
suites are green, and the `tests/database` PGlite suites migrate through
v19.

**One assertion was adapted, none weakened or skipped.**
`tests/client/review-ui.test.tsx` → *"attaches one key listener and
removes it on unmount"* counted the app's window keydown listeners as
exactly one; the Alt+K capture shortcut legitimately makes it two. The
test now measures the shell's listener as its baseline and keeps every
original guarantee — the panel adds its one, re-renders and card changes
add nothing, no listener is removed before unmount, both come off on
unmount, and post-unmount presses never answer.

## 12. Criteria, gaps, and the overall outcome

| Criterion | Status | Basis |
| --- | --- | --- |
| G0 git baseline preserved | **PASS** | HEAD unchanged at `8d76720`; no commit/push/reset/clean/deploy; all 74 pre-existing entries intact (93 entries now = 74 + 19 new files). |
| G1 smallest coherent model, additive migration, version-gated | **PASS** | §3; two tables, one RPC; gated on v19 everywhere. |
| G2 Quick Capture | **PASS** | §5. |
| G3 Text Discovery & Reading Workspace | **PASS** | §6. |
| G4 Listening Discovery | **PASS** | §7 — first-class, with limitations stated in UI and docs, not hidden. |
| G5 AI-generated Discovery Content | **PASS** | §8 — validated, previewed, accepted explicitly; deterministic mocks. |
| G6 External Content Import | **PASS** | §9 — SSRF-guarded, plain-text-only, preview-before-store. |
| G7 Journeys A–J | **PASS** | §10 — 10/10 server, 13 client tests. |
| G8 Tests & gates | **PASS** | §11 — every gate green; one adapted count documented. |
| G9 Docs & this report | **PASS** | [docs/discovery.md](docs/discovery.md) (new), `docs/supabase-schema.md` (v19 row), `docs/ai-features.md` (two features, buckets, file map), `README.md` (tab row + doc link); this single report. |
| Hosted Supabase behaviour / v19-on-hosted | **UNVERIFIED** | No hosted project exists for this work; the owner must run `20261028090000_discovery.sql` and `npm run supabase:verify`. The app gates the feature off until the version reads 19. |
| Real-browser verification (audio playback, speech, scroll restoration visuals) | **UNVERIFIED** | jsdom cannot play audio or measure text rectangles; playback, `speechSynthesis` and scroll maths are guarded and unit-tested at the state level only. |

**Not done, by contract (BLOCKED, not attempted):** committing/pushing,
deploying, running migrations against anything but local instances,
installing dependencies, and any paid service. **Deliberately out of
scope and documented as limitations:** PDF/Office text extraction,
speech-to-text transcription, and generated audio.

**Overall outcome: PASS.** All six directions are implemented with real
workflows over real routes, persistence is explicit and learner-controlled
end to end, import handling is safe by construction (plain text only,
SSRF-guarded fetch, actionable refusals), and every learning invariant is
protected by snapshots. The only unverifiable claims — hosted behaviour
and real-browser media — are named above rather than asserted.
