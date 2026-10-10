# Upgrade plan: Personal Vocabulary Learning System

Written 2026-10-10 against commit `fa2ae97`. Each phase ends with working
code, passing tests and an update to this file.

## Status (2026-10-10)

| Phase | State |
| --- | --- |
| 1 Review history, Undo, session summary | **Built.** Database version 2. |
| 2 FSRS | **Stage 1 (calculated alongside) built.** Database version 3. Stage 2 (switching to it) **not built**. |
| 3 Analytics and Weak Words | **Built.** Database version 4. |
| 4 to 8 | Not started. |
| Offline mode | Not built; no design note yet. |

Checked by the automated tests (real PostgreSQL in-process, and the pages in a
simulated browser), by lint, type-check and build, and by hand in a browser
with the sample data. **Not checked against the live Supabase project**: the
three new SQL files have to be run there first, and only the owner can sign
in. `npm run supabase:verify` covers versions 2 to 4 once they are in place
and reports anything the database is not ready for as SKIP.

What the phases left out, deliberately:

- **Phase 2.** No switch to make FSRS decide what is due, and so no single
  `Scheduler` interface over both rule sets, no choice of two or four answer
  buttons, and no replay of saved history into FSRS for words reviewed before
  version 3. These wait for the owner's answers in section 4. Until then FSRS
  changes nothing a reviewer can see outside Settings → Scheduling.
- **Phase 3.** Insights has reviews per day and a table of figures by period,
  not separate trend charts for accuracy and time, and no review heatmap (the
  Calendar still shows additions only).
- **Focused review** only narrows the due queue. Practising a weak word that is
  *not* due needs the "practice" decision in section 4 and is not built.

## 1. Audit: where the app stands

### Baseline (run on 2026-10-10)

| Check | Result |
| --- | --- |
| `npx vitest run` | 699 tests in 29 files, all passing |
| `npx tsc --noEmit`, `npx eslint .` | clean |
| `npm run build` | succeeds |
| Notion at runtime | none; `tests/no-notion.test.ts` keeps it that way |

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
- **No new dependency without a reason.** The only one planned is the FSRS
  library.

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
| **Import** | CSV and pasted text: preview, column mapping, validation, duplicate review, confirmation, then one controlled batch with a report of imported, skipped, duplicate and invalid rows. Nothing is imported before confirmation. Near-duplicates are shown, never merged automatically. |
| **Export** | A documented, versioned JSON of the whole account (words, state, history, collections, relationships, settings) and CSVs. Round-trip tested. |
| **Backup** | A separate written procedure for the database owner; the app says plainly that a user export is not a full database backup. |
| **Excel** | Deferred: it needs an extra library. |

### Phase 8 — Retention estimate and simulation

- The estimate uses the library's own `get_retrievability`, shown only for
  cards with valid FSRS state, labelled as a model estimate.
- The simulator replays **real** saved reviews under both schedulers and
  projects workload. It never writes to live card state and labels every
  assumption.
- With history starting 2026-10-10 the data will be thin at first. The tool
  will say how much more it needs rather than show confident numbers.

### Phase 9 — Final verification and report

Full test run, build, a security pass over every policy, the live check
script, deployment notes, and the final report.

### Deferred: offline mode

Not built. A short design note will cover local storage, an outbox,
idempotent sync, conflict rules and an "unsynced" indicator. The request ids
and conflict checks already in place are the foundation it would need.

## 4. Decisions needed from the owner

None is needed to start Phase 1. The recommended choice is listed first.

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
