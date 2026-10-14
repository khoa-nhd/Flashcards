# Upgrade plan: Personal Vocabulary Learning System

Written 2026-10-10 against commit `fa2ae97`. Each phase ends with working
code, passing tests and an update to this file.

## Status (2026-10-13): the second batch — six features and three repairs

Built and verified 2026-10-13. Nothing here changes a review rule: the two
answer buttons, the mastery schedule, the rating map and the practice
invariants are exactly as section 3 describes them.

| Item | State |
| --- | --- |
| **D1** Grade ≠ presentation | **Done.** The rule that presenting a question never changes how it is graded is written into `config/review.config.ts` and [review-logic.md](review-logic.md) §14. |
| **D2** The saving switch everywhere | **Done.** The daily goal, the scheduler choice and account settings now refuse with `read_only` when `REVIEW_WRITES_ENABLED=false`, like every other write. `tests/server/read-only-gate.test.ts`. |
| **D3** Export/import round-trip | **Done** at content level: a full export (trash, collections, goal included) re-imports every word's content, and nothing else crosses — pinned by a new round-trip test. Restoring *progress* from a file stays deliberately out: [import-and-export.md](import-and-export.md) documents that as the database backup's job. |
| **4.6 Focus mode** | **Built.** A Focus toggle on Review and Practice hides the sidebar and navigation and shows a 15/20-minute countdown with pause; running out only says so. `src/components/FocusTimer.tsx`, `tests/client/focus-mode.test.tsx`. |
| **4.5 part 1 — critical misconception** | **Built.** Database version 9: the weak-word history now carries the confidence of a card's latest standing answer, and "Not remember said with very sure" scores 5 as its own reason. Absent (never guessed at) below version 9. |
| **4.3 — challenge cards** | **Built** as presentation only: from mastery 4 the review card's *front* becomes a cloze (4–5) or listening (6–9) exercise; the answer is still the same two buttons, the exercise text is never recorded, and cards without what an exercise needs fall back to the plain card. Setting: "Challenge cards with an exercise", on by default. `shared/review-exercises.ts`. |
| **4.5 part 2 — a guess checks sooner** | **Built.** Remember + low confidence is rated FSRS *Hard* instead of the mapped Good; Not remember stays Again whatever the confidence, and `shared/scheduler/rating-map.ts` is untouched. The mastery schedule never sees confidence. |
| **AI infrastructure** | **Built.** One OpenAI-compatible adapter (`server/ai/adapter.ts`) with named failures, an env-switchable provider (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_TIMEOUT_MS`), per-account rate limits, keys server-side only, and a privacy note in Settings. [ai-features.md](ai-features.md). |
| **4.1 — Smart Reader** | **Built.** Add vocabulary → Smart Reader: pick a word in a pasted reading, get the sentence (always taken from your own text by this server), a suggested definition and meaning. Nothing saves itself; every failure lands back on entering by hand. |
| **4.4 — Writing Challenge** | **Built.** Database version 10 (essays up to 6000 characters, `writing` as a history mode, `ai_feedback`/`model_answer`). A new practice mode judged purely on whether the sentence *uses the word*; where a model is configured, its coaching note and one model sentence are stored beside the already-judged answer and never change it. Without a model the mode works the same with no note. |
| **4.2 phase 1 — connections graph** | **Built.** A hand-rolled SVG bubble diagram under a word's relations in the detail panel: relations and collection-mates, deduplicated, clickable, no new dependency, no AI. Cap of 30 nodes with an accessible full summary. |

### How it was checked (2026-10-13)

| Check | Result |
| --- | --- |
| `npm test` | 1606 tests in 68 files passing, 3 pre-existing skips |
| `npm run typecheck`, `npm run lint` | clean |
| `npm run build` | succeeds (the same pre-existing warning: the main script is over 500 kB) |
| Invariant suites | `fsrs-shadow`, `undo-api`, `practice-api`, `frontend-secrets` pass **unmodified** |

**Still not checked: anything against the live Supabase project.** Database
versions 9 and 10 now join 2 to 8 as SQL files until the owner runs
`npm run supabase:verify`; the app keeps the features that need them switched
off until the version is found, and says so. The AI features were exercised
against a stand-in model endpoint; nobody has yet run them against a real
provider key (free-tier quotas are documented as needing re-verification when
first configured).

Decisions worth remembering, all in the code comments where they bite:

- The exercise in a review card and the coach's note are **guidance only**;
  neither is ever a verdict, a score, or a schedule input.
- The Writing Challenge judges *usage*, not quality — quality belongs to the
  coach note, which can be absent without the mode being broken.
- The connections graph is drawn from your own links and collections only,
  deliberately: AI-suggested links (phase 2) were deferred over hallucination
  risk.
- CEFR labels and Vis.js were dropped from the plan; both were guesses at a
  number or a dependency nobody had stated.

## Status (2026-10-11)

| Phase | State |
| --- | --- |
| 1 Review history, Undo, session summary | **Built.** Database version 2. |
| 2 FSRS | **Built.** Calculated beside the mastery schedule (version 3), and selectable per account as the schedule in charge (version 8). The mastery schedule stays the default. |
| 3 Analytics and Weak Words | **Built.** Database version 4. Week-by-week accuracy and time charts on Insights; reviews per day on the Calendar. |
| 4 Daily goals, filters, shortcuts, confidence | **Built.** Database version 5. |
| 5 Study modes | **Built as practice**: recognition, recall, typing, fill in the blank, and listening (experimental). Database version 6. |
| 6 Collections, examples, relationships | **Built.** Database version 7. |
| 7 Import, export, backup | **Built**: preview-based import of CSV, text, Excel (.xlsx) and the app's own exports; full JSON export; backup and recovery notes. No database change. |
| 8 Retention estimate and simulation | **Built**: FSRS's own recall estimate per word, and a what-if comparison replayed from saved answers. No database change. |
| 9 Final verification | **Done for everything that can be checked without the live project** (below). The live check is the owner's to run. |
| Offline mode | **Not built.** Design note: [offline-mode-design.md](offline-mode-design.md). |

### How it was checked

| Check | Result on 2026-10-11 |
| --- | --- |
| `npm test` | 1512 tests in 58 files, all passing |
| `npm run typecheck`, `npm run lint` | clean |
| `npm run build` | succeeds (one warning: the main script is over 500 kB) |
| `npm audit --omit=dev` | no known vulnerabilities |
| By hand, sample data, one desktop browser | choosing FSRS and going back, the what-if comparison, the recall column, reviews on the Calendar, the weekly charts, listening practice |

The tests run the real SQL files on an in-process PostgreSQL, the HTTP API on
top of it with two accounts, and the pages in a simulated browser.

**Not checked: anything against the live Supabase project.** Development has
no way to sign in to it. Database versions 5 to 8 exist only as SQL files
until they are applied there, and the app keeps every feature that needs them
switched off, and says so, until they are. `npm run supabase:verify`, run by
the owner, checks versions 2 to 8 against the live project with two throwaway
accounts and reports anything the database is not ready for as SKIP. Listening
was checked for what the app asks the browser to say; nobody has judged what
it sounds like, or tried it on a phone.

### What was built differently from the plan below, and what was left out

The plan in sections 3 and 4 is kept as it was written. Where the result
differs, this list is what is true.

- **Which modes move the schedule: none but the flashcard.** The plan had
  recall, typing and cloze moving it. They are practice instead: recorded and
  reported per mode, never changing mastery, a review date or FSRS. Whether a
  typed answer should count as a review is a rule nobody has stated, so it was
  not guessed. Practising a word that is not due (weak or recently added
  words) is covered by the same Practice page.
- **FSRS in charge keeps as much as possible the same.** Two answer buttons
  (Good and Again); no same-day steps; a word FSRS has not seen stays on its
  mastery date until first answered, with no state made up for it; mastery
  still counts and still retires a word at 10. The plan's suggestion that
  "mastered" might become "interval of N days or more" was not taken: it needs
  a number nobody has chosen. FSRS runs with the library's default parameters;
  nothing is fitted to the reviewer's history.
- **No single `Scheduler` interface over both rule sets.** Both schedules are
  written by every answer and one small function decides which date is read
  (`shared/scheduler/active.ts`). That is what makes the choice reversible
  without converting anything.
- **Saved history is not replayed into the stored FSRS state.** Words reviewed
  before version 3 enter FSRS at their next answer. The what-if comparison
  does replay saved answers, but only to show the result; it stores nothing.
- **The simulation projects spacing, not outcomes.** It replays real answers
  and shows next due dates. Its one forward-looking table is a stated scenario
  ("if you remembered every word"). There is no forecast of how many reviews
  will actually be needed and no claim about retention under either schedule.
- **The recall estimate is shown in Settings → Scheduling only**, for words
  answered at least twice. It is not on the dashboard or the bank.
- **Cloze uses the word's own example.** There is no editing of the blank, and
  further examples (Phase 6) are for reference only.
- **Listening uses the browser's speech synthesis.** There is no pronunciation
  audio and no external service.
- **Excel import reads `.xlsx`, first sheet only.** Not `.xls`.
- **The daily goal is a yardstick.** There is no planner that orders or limits
  cards by it. The queue is always the full due queue, narrowed only on
  request.
- **Trends are two weekly charts**, not a set per day, week and month. Weak
  words have no trend over time.
- **No rating-button choice in settings, no "suspended" state, no tags or
  pronunciation fields.**

### Batch 1 of the 2026-10-13 roadmap (2026-10-13)

Four small owner-chosen improvements. No database, AI or dependency changes.

- **Listening is a normal way to practise now.** The "Experimental" tag is gone
  from the Practice page and the README. Replaying, reading slowly and showing
  the word after a miss were already built and tested; the review card's
  listening front gained the slow reading too.
- **A speaker on every card that shows a word**: the review card front, the
  recognition and recall questions, the writing prompt, and the word panel. It
  is the same browser speech synthesis listening uses, in the accent chosen in
  practice settings, and is not shown where the browser has no speech.
- **"Practise these" on Weak Words was already built and tested** — it opens
  Practice with the weak words as the pool. Nothing needed adding.
- **Settings nudges about backups.** Under the download buttons it says when a
  file was last downloaded from this browser, and asks for a fresh copy once
  that is over a week old. The record lives in this browser only.
- **Confidence is asked by default now** (owner decision, metacognition): after
  turning a card, the app asks how sure you were before recording the answer.
  It can still be switched off in Settings, and the tests cover both paths.

### Batch 2 of the 2026-10-13 roadmap (2026-10-13)

Three more owner-chosen improvements. No database, AI or dependency changes.

- **The connections diagram is a mind map now** (`SemanticGraph` rework): the
  word at the centre, one labelled branch per reason (each relation kind,
  each collection) split left and right, and the connected words curving off
  their branch. Still hand-drawn SVG with plain arithmetic; clicking a word
  opens it exactly as before.
- **"What to do today" on the Dashboard**: a small card listing the two or
  three concrete steps for now — review the due cards, practise the
  high-priority weak words, or add new words when nothing is due — each with
  a link straight to the page that does it. It reads figures the page already
  has plus the existing weak-words count, and never orders or limits anything.
- **Focus blocks get a counted rest** (Pomodoro cycle): when a 15/20-minute
  block runs out the timer offers a 5-minute break on its own countdown, and
  the next block starts only on request. Nothing auto-starts or auto-ends.

### Batch 3 of the 2026-10-13 roadmap (2026-10-13)

**A3 — the exam mode.** A new `/exam` page (off the sidebar on purpose,
reached from a card on the Practice page) where the reviewer builds their own
test: sections, each a server-graded mode (recognition, typing, fill in the
blank, listening) with its own number of questions and an optional per-section
minute limit, plus one optional clock for the whole exam. Sections can be left
and returned to while a section's own clock pauses and the overall clock never
stops; a section whose time runs out locks with its unanswered count; the end
report scores every section, lists the missed words with what was said and
what was wanted, and drills them through a new `source=missed:<ids>` address
in Practice (validated ids, capped at 30, same as the report). Every answer
travels the existing recorded `POST /api/practice` path — mastery, review
dates and FSRS untouched, as everywhere else. No preset exams are bundled;
the AI-suggested exam plan stays deferred (owner decision, Đợt 5).

### Batch 4 of the 2026-10-13 roadmap (2026-10-14)

**Word families.** Database version 11: one nullable `root_id` on
`vocabulary` — a word points at the root it was formed from, which a
relation row between two words cannot say because it does not know which
end is the base. Single-column FK on purpose (a composite key with
`on delete set null` would clear the owner too), self-reference refused by
a check, one partial index, and `update_vocabulary` accepts only a root of
the caller's own account. The capability `roots` (version 11) switches the
feature on only where the column exists. A new section in the word panel
shows the family as chips — root → the word → its members, each opening
that word — and, where a model is configured, builds a draft family for
the reader to untick and save: the missing words are created, then each
kept member's `rootId` is set — ordinary writes through the existing
paths, with no content, mastery, review date or FSRS state touched.
Example sentences suggested with the reader's saved collocations land in
the examples section as editable drafts, saved through the ordinary
`addExample` path with the source "AI suggestion". Both AI routes copy the
SmartReader contract end to end: named failures, per-account buckets,
drafts only, refused while saving is frozen. `docs/word-family-design.md`
holds the design; applying v9–v11 to live Supabase stays the owner's
step, and the whole panel stays hidden until the version is found.

## 1. Audit: where the app stands

### Baseline (run on 2026-10-10)

| Check | Result |
| --- | --- |
| `npx vitest run` | 1334 tests in 49 files, all passing |
| `npx tsc --noEmit`, `npx eslint .` | clean |
| `npm run build` | succeeds |
| Notion at runtime | none; `tests/no-notion.test.ts` keeps it that way |

The table above is the starting point, kept for comparison. Where things
stand now is under "Status" at the top.

### Stack

React 19 + TypeScript + Vite + Tailwind (browser), Hono (API, one Vercel
function), Supabase Auth + PostgreSQL with Row Level Security, Zod contracts,
Vitest. npm. No charting library: charts are small in-house SVG components
(`BarChart.tsx`). No offline support.

### What exists

| Area | State |
| --- | --- |
| Review (flashcards, flip, Remember / Not remember, swipe, Space and arrow keys) | Working |
| Add vocabulary, duplicate check, quick add | Working |
| Vocabulary bank (search, filters, sort, edit, trash, restore) | Working |
| Dashboard, Calendar, Insights | Working, computed from **current word state only** |
| Accounts, per-user isolation (RLS), per-user time zone | Working |
| CSV / JSON export of vocabulary | Working (words and current state only) |
| Review history | Table exists and is written; nothing reads it yet |
| Undo, sessions, FSRS, analytics from history, weak words, goals, study modes, collections, import | Not present |

### Current data model

| Table | Holds | Notes |
| --- | --- | --- |
| `vocabulary` | word, meaning, definition, example, date added, trash marker | No tags, pronunciation, notes or multiple examples |
| `card_states` | `mastery` 0–10, `review_date` (calendar date), `scheduler = 'mastery_v1'` | `fsrs_*` columns exist and are all empty |
| `review_logs` | one row per answer: action, mode, time, duration, mastery and date before/after, request id | Append-only: no UPDATE or DELETE privilege for anyone |
| `user_settings` | time zone, unused `preferences` JSON | |

Functions: `create_vocabulary`, `update_vocabulary`, `apply_review`. All
run as the caller under RLS. Nothing can be hard-deleted.

### The review workflow today

1. Browser loads `GET /api/review-queue`: words with mastery < 10 and review
   date empty, today or earlier, earliest first. Definition and example are
   withheld above mastery 5.
2. On an answer the browser sends the word id, the answer, a request id, the
   time on the card, and the state it was showing.
3. The server reads the word, computes the result with `shared/review-logic.ts`,
   and calls `apply_review`, which updates the state **only if it is unchanged
   since it was shown** and appends the history row, in one transaction.
4. A repeated request id returns the first result. A stale answer from another
   device gets `409` and can only be skipped.

**Remember:** mastery + 1 (max 10); review date = day of review + the *old*
mastery in days. **Not remember:** mastery unchanged; review date = next day.
Flipping or viewing changes nothing.

### Dates and time zones

Review dates are calendar dates. "Today" is computed on the server in the
account's stored time zone. Each history row stores both the instant
(`reviewed_at`) and the reviewer's calendar day (`reviewed_on`).

### Is the history genuine?

Yes, but short. It starts on 2026-10-10. The original system never recorded
individual reviews, so none exist before that and none were made up. Every
analytic and simulation in this plan must work with a thin history and say so.

## 2. Ground rules for every phase

- **The legacy schedule is never replaced silently.** FSRS is opt-in per
  account and reversible; the default stays `mastery_v1`.
- **Migrations are additive.** Old code keeps working on the new schema, so
  the order is always: run the SQL, then deploy the code.
- **The owner applies SQL.** There is no database credential in this project
  by design, so each phase ships one SQL file to paste into the Supabase SQL
  Editor, plus a check that it took effect.
- **A schema version marker** (`app_schema_version()`) lets the server gate
  new features until their migration is present. The existing review flow must
  keep working at every version.
- **Everything is tested on a real PostgreSQL** in-process (as today), and the
  live project is checked by the owner with `npm run supabase:verify`, which is
  extended in each phase.
- **No fabricated data:** no invented reviews, FSRS state, relationships or
  example sentences.
- **No new dependency without a reason.** Two were added, each pinned to an
  exact version: `ts-fsrs` (the FSRS calculation, server only) and
  `read-excel-file` (reading `.xlsx` on the device, loaded only when a
  spreadsheet is chosen).

## 3. Phases

### Phase 1 — Review history, Undo, session summary

Most of the reliable-submission requirement is already met (atomic,
idempotent, conflict-checked). This phase adds what is missing.

| | |
| --- | --- |
| **Schema** | `study_sessions` (id, user, started, ended, mode). On `review_logs`: `session_id`, `kind` (`review` or `undo`), `undoes_log_id` (unique). View `effective_reviews` = reviews that were not undone. Function `undo_review`. `app_schema_version()`. RLS and grants for the new table. |
| **Undo rule** | Undo applies to one named review. It succeeds only if that review is the card's most recent one, has not been undone, and the card still holds the state that review left. It restores the previous state and appends an `undo` row, in one transaction. Nothing is deleted. A repeated undo request is a no-op. If another device has reviewed the card since, the undo is refused and says why. |
| **Server** | `ReviewService.undo`, `POST /api/review-undo`, session id passed through `apply_review`, `GET /api/sessions/:id/summary` computed from saved rows. Sample-data backend gets the same behaviour. |
| **Browser** | Undo control for the last answered card (button and a key), session id per review session, summary screen built from the server's numbers: cards reviewed, remembered / not, accuracy, time, first-time versus seen before, with Continue and Finish. |
| **Tests** | Undo: latest only, twice, across two devices, after an edit, another user's review. History stays append-only. Summary excludes undone and unsaved answers. Refresh restores saved state. |
| **Done when** | Every saved answer has a session; Undo is auditable and cannot overwrite newer data; the summary matches the database. |

### Phase 2 — FSRS foundation (shadow first, then opt-in)

Library: **`ts-fsrs` 5.4.2**, MIT licence, Node ≥ 20, no runtime
dependencies, actively maintained. API confirmed from its published README:
`fsrs()`, `createEmptyCard()`, `next(card, now, rating)`, `repeat()`,
`Rating.Again/Hard/Good/Easy`, `State.New/Learning/Review/Relearning`,
`get_retrievability()`, `rollback()`, `reschedule()`, and the parameters
`request_retention`, `maximum_interval`, `enable_fuzz`, `enable_short_term`.
The exact card fields are pinned by a contract test when it is installed. The
library has no "suspended" state; none will be invented.

| | |
| --- | --- |
| **Code** | `shared/scheduler/`: one `Scheduler` interface, the existing rules wrapped unchanged as `mastery_v1`, an FSRS adapter, and an explicit rating map (Remember → Good, Not remember → Again; configurable). Runs on the server only. |
| **Schema** | Missing FSRS card fields on `card_states`; `rating`, FSRS state before/after and scheduler version on `review_logs`; `scheduler`, target retention and rating-button choice on `user_settings`. |
| **Stage 1: shadow** | Each real review computes **both** schedules and saves both atomically. The queue still follows the legacy schedule. Nothing visible changes. |
| **Stage 2: opt-in** | A Settings switch per account, with a comparison first: for each card, the legacy next date beside the FSRS next date, and the expected workload over the coming weeks. Switching back is always possible because the legacy state kept being updated. |
| **Existing cards** | No FSRS state is made up. A card enters FSRS at its first review after shadow mode starts. Until then its legacy date decides when it is due, so nothing becomes due all at once. Cards with real history since 2026-10-10 can be replayed from that history. |
| **Time** | FSRS due is a timestamp; the queue treats a card as due when that falls before the end of today in the account's time zone. |
| **Tests** | New cards, success, failure, repeats, several reviews in a day, time-zone and daylight-saving edges, entry of legacy cards, version change, concurrent submissions, the rating map. |
| **Done when** | Shadow mode runs in production with no behaviour change; an account can opt in and out without losing either schedule. |

### Phase 3 — Analytics and Weak Words

| | |
| --- | --- |
| **Database** | Functions that aggregate inside PostgreSQL, scoped to the caller: per-day totals (reviews, correct, incorrect, time, by mode) and per-card statistics. Index on `(user_id, reviewed_on)`. The browser never downloads the whole history. |
| **Definitions** | Added to `docs/metrics.md`, each with its denominator and window. Accuracy = remembered ÷ answered, over effective reviews in the window. "Retention" is reported only for cards reviewed before, and is labelled observed, never predicted. Below a minimum sample the app shows "not enough data" instead of a percentage. |
| **Screens** | Dashboard: reviews today, accuracy, streak, time. Insights: reviews and additions over time, accuracy and time trends, outcomes by mode, a calendar heatmap. Built with the existing in-house chart components. |
| **Weak words** | `shared/weak-words.ts`: a pure scoring function with documented, configurable weights (repeated failures across sessions weigh more than one recent slip), a stated main reason, recent performance and a suggested action. New Weak Words page and a "Focus on my weakest words" review option. |
| **Tests** | Denominators, empty data, window boundaries, time zones, per-user isolation, scoring order. |

### Phase 4 — Daily goals, filters, shortcuts, confidence

| | |
| --- | --- |
| **Goals** | Time, review count, or both, stored with the account. Progress comes from saved reviews. Reaching the goal never hides overdue cards; the app says when the due workload exceeds the goal. Goals never touch scheduler parameters. |
| **Planner** | `shared/session-planner.ts`: overdue first, then high-risk, with a workload estimate from the user's own average time per review. |
| **Filters** | Due today, overdue, weak, recently added, a collection (Phase 6), a study mode (Phase 5). |
| **Shortcuts** | Help panel, configurable answer keys, Enter, Escape, Undo. The existing guard against firing while typing is kept. |
| **Confidence** | Optional low / medium / high before the reveal, stored separately from correctness; a calibration view shows over- and under-confidence. |

### Phase 5 — Study modes

All modes write the same review event, with mode, correctness, the submitted
answer where there is one, and whether it was self- or auto-graded. Accuracy
is reported per mode, never merged.

| Mode | Notes |
| --- | --- |
| Recognition | Multiple choice. Wrong options come from the user's own other words; needs at least four distinct meanings; order shuffled; no duplicates. |
| Recall (reverse) | Meaning or definition shown, word recalled, self-graded. |
| Typing | `shared/answer-check.ts`: defined rules for case, spacing, punctuation and Unicode. Result is exact, accepted variant, or wrong. Variants are ones the user entered, never guessed. |
| Cloze | Blank a word in a real example. The user confirms or edits the blank. No generated sentences. |
| Listening | Only via the browser's built-in speech, if approved. No paid service. Not claimed to work until tested on real devices. |

A mode that lacks the fields it needs shows what to add instead of a broken
card.

### Phase 6 — Collections, examples, relationships

| | |
| --- | --- |
| **Schema** | `collections`, `collection_items` (many-to-many), `vocabulary_examples` (several per word, one preferred, optional source note), `vocabulary_relations` (synonym, antonym, word family, collocation, related, commonly confused). Ownership enforced by RLS and composite foreign keys; duplicates and reverse pairs handled by a unique rule. |
| **Behaviour** | Deleting a collection removes memberships only, never words. Relationships are entered by the user, never inferred. A related word opens its detail panel. |

### Phase 7 — Import, export, backup

| | |
| --- | --- |
| **Import** | CSV, .xlsx, and pasted text: preview, column mapping, validation, duplicate review, confirmation, then one controlled batch with a report of imported, skipped, duplicate and invalid rows. Nothing is imported before confirmation. Near-duplicates are shown, never merged automatically. |
| **Export** | A documented, versioned JSON of the whole account (words, state, history, collections, relationships, settings) and CSVs. Round-trip tested. |
| **Backup** | A separate written procedure for the database owner; the app says plainly that a user export is not a full database backup. |

### Phase 8 — Retention estimate and simulation

- Show FSRS retrievability only for cards with valid FSRS state, labelled as a
  model estimate, with a minimum number of reviews before any figure appears.
- Simulation: replay real saved reviews under both schedulers and project the
  workload. Read-only, on the server, clearly marked as a projection and with
  its assumptions listed. Never writes to live card state.
- With a history this thin the projections will be rough; the tool is built
  and says so.

### Phase 9 — Final verification and report

Full test run, build, a security pass over every policy, the live check
script, deployment notes, and the final report.

### Deferred: offline mode

Not built. The app has no offline behaviour to preserve. What it would take is
written up in [offline-mode-design.md](offline-mode-design.md): local storage
per account, an outbox, the server change that lets an answer carry the moment
it was given, idempotent synchronisation on the request ids already in place,
the conflict rule (unchanged: a stale answer is not applied), sign-in and
session handling, and how unsaved answers are shown.

## 4. Decisions

These were open when the plan was written. None was answered before the work
was done, so each was settled the way that changes least and invents nothing.
The right-hand column is what was written at the time; **what was actually
done is in "Status" at the top**, and every one of these can be revisited.

| Before | Question | Recommendation |
| --- | --- | --- |
| Phase 2 | How should existing cards enter FSRS? | Start each at its next review with no invented state. Alternative: seed from the current interval, which is an assumption and would be labelled as one. |
| Phase 2 | FSRS has no "mastered and never shown again". Keep retiring at mastery 10? | Under FSRS, cards keep returning at long intervals; the dashboard's "mastered" becomes "interval of N days or more". |
| Phase 2 | Same-day relearning steps? | Off at first, so every interval is a whole number of days, as today. |
| Phase 2 | Two answer buttons or four? | Keep two (mapped to Good and Again); offer four as an account option later. |
| Phase 4 | Reviewing a card that is not due (weak words, recently added) under the legacy schedule | Record it as practice without moving mastery or the date. Under FSRS it counts as a real review. |
| Phase 5 | Which study modes move the schedule? | Flashcard, recall, typing and cloze do; recognition is practice only. |
| Phase 5 | Listening through the browser's built-in speech? | Yes, optional and labelled experimental; otherwise skip the mode. |
| Phase 7 | Excel import? | Defer. |

## 5. Risks

| Risk | Handling |
| --- | --- |
| A migration is not applied before its code is deployed | Additive SQL, schema-version gate, and the core review path tested at every version. |
| Live behaviour cannot be checked by development (RLS, no password) | Owner runs the extended `supabase:verify` after each phase. |
| Changing `apply_review` breaks the running app | New parameters get defaults and the old call shape keeps working; tested against both. |
| FSRS shortens intervals for well-known words when they first enter | Shown in the comparison before opting in; reversible. |
| Thin history makes analytics look precise | Minimum sample sizes and explicit empty states. |
| Scope: ten phases is large | Phases 1–3 come first and each is shippable alone. Later phases can stop at any boundary. |
| Hand-written database types drift from the SQL | A test that the columns the server reads exist in the migrated schema. |

## 6. Order and size

| Phase | Size | Owner action |
| --- | --- | --- |
| 1 Review history, Undo, summary | Medium | Run one SQL file |
| 2 FSRS (shadow, then opt-in) | Large | Run one SQL file; answer the Phase 2 questions |
| 3 Analytics, Weak Words | Large | Run one SQL file |
| 4 Goals, filters, shortcuts, confidence | Medium | Run one SQL file |
| 5 Study modes | Large | Answer the Phase 5 questions |
| 6 Collections, examples, relationships | Medium | Run one SQL file |
| 7 Import, export, backup | Medium | — |
| 8 Estimate and simulation | Medium | — |
| 9 Final verification | Small | Run the live check |
