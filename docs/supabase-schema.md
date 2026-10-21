# Supabase: schema, accounts and security

How the app stores vocabulary in Supabase. The SQL is in
[supabase/migrations](../supabase/migrations); this document explains it. For
how the data got here, see [supabase-migration.md](supabase-migration.md).

## Architecture

```
Browser ── Supabase Auth (email + password, public key) ──► session (access token)
   │
   │  every request: Authorization: Bearer <access token>
   ▼
API server (Hono)
   │  1. verifies the token
   │  2. computes the review result with the unchanged rules engine
   │  3. queries Supabase with the public key + that user's token
   ▼
PostgreSQL ── Row Level Security decides what that user can reach
```

- The browser uses Supabase for **signing in only**. All vocabulary still goes
  through the app's own API, so the review rules stay in one place on the
  server.
- The server holds **no privileged key**. It queries the database as the
  signed-in user, so even a bug in the server cannot read another account's
  rows: the database refuses.
- The server refuses to start in Supabase mode if the configured key is a
  secret / service-role key, because that key would be handed to browsers.

## Versions

The schema grows by SQL files that only add things. Each one raises the number
returned by `public.app_schema_version()` (a database without that function is
version 1). The server reads the number once per instance, re-checks every
minute while the database is behind, and switches features on only when the
database can serve them, so the app and the database can be updated in either
order.

| Version | File | Adds | Turns on |
| --- | --- | --- | --- |
| 1 | `20261010090000_initial_schema.sql` | The four original tables, policies, `apply_review`. | The app. |
| 2 | `20261011090000_sessions_and_undo.sql` | `study_sessions`; `kind`, `session_id`, `undoes_log_id` on `review_logs`; `effective_reviews`; `record_review`, `undo_review`, `session_summary`. | Undo, the end-of-session summary. |
| 3 | `20261012090000_fsrs_shadow.sql` | FSRS columns on `card_states` and `review_logs`; `fsrs_request_retention` on `user_settings`. | FSRS calculated alongside, and its comparison. |
| 4 | `20261013090000_review_analytics.sql` | `review_daily_stats`, `card_review_stats`. | Review activity, history-based weak words. |
| 5 | `20261014090000_goals_and_confidence.sql` | `daily_goal_reviews`, `daily_goal_minutes` on `user_settings`; `confidence` on `review_logs`; `confidence_stats`. | The daily goal, confidence ratings. |
| 6 | `20261015090000_practice_modes.sql` | The `practice` kind of history row; `answer_correct`, `submitted_answer`, `grading` on `review_logs`; `record_practice`, `practice_daily_stats`. | Recording practice in the other study modes. |
| 7 | `20261016090000_collections_and_relations.sql` | `collections`, `collection_items`, `vocabulary_examples`, `vocabulary_relations`; `set_preferred_example`. | Collections, further examples, related words. |
| 8 | `20261017090000_scheduler_switch.sql` | `scheduler` on `user_settings`; `record_review` now stamps the history with the schedule in charge. | Choosing which schedule decides what is due. |
| 9 | `20261018090000_weak_confidence.sql` | `last_confidence` on the `card_review_stats` function (the confidence of the card's latest standing answer). | "Critical misconception" in Weak words. |
| 10 | `20261019090000_writing_mode.sql` | `submitted_answer` up to 6000 characters; `writing` as a history mode; `ai_feedback`, `model_answer` on `review_logs`; `record_practice` reads the two new keys. | The Writing Challenge and its coach note. |
| 11 | `20261020090000_root_derived.sql` | `root_id` on `vocabulary` (a word points at the root it was formed from; self-reference refused, one index) and `update_vocabulary` manages it with the root checked to be the caller's own word. | The word-family panel: the family timeline and the AI family builder. |
| 12 | `20261021090000_speaking_mode.sql` | `review_logs_mode_check` accepts `speaking` alongside the other practice modes. | Speaking practice: the transcript the browser wrote down is recorded under its own name. |
| 18 | `20261027090000_vocabulary_maps.sql` | `vocabulary_maps`, `vocabulary_map_nodes`, `vocabulary_map_edges` — owner-only, with checked kinds and a check that keeps `personal` unstoreable; `bump_vocabulary_map_revision()`; a unique key (`id`, `vocabulary_id`, `user_id`) on `vocabulary_senses` so a sense can only ever point at its own word. | Vocabulary maps (the `/maps` page). |
| 19 | `20261028090000_discovery.sql` | `discovery_sources` (the text, transcript or imported page a learner reads or listens to: kind, title, origin, up to 120,000 characters of plain content, a reading or listening position, a revision and a per-account request id) and `discovery_marks` (one selection kept for later — its label, the sentence or cue around it, where it sat, an optional note; saved into `vocabulary` only by an explicit save, with a check keeping "marked" and "saved" exclusive and one open mark per label per source); `bump_discovery_source_revision()`. | Discovery & Input: quick capture, the reading and listening workspaces, marking for later, generated readings, imports (`/discover`). |

There are no database credentials in the project, so the owner runs each file
in the Supabase SQL Editor. Nothing in versions 2 to 19 alters or removes
existing rows.

If the hosting project is linked to Supabase through Vercel's integration,
these files may also be applied automatically on a deploy of `main`. That is
a property of how the integration is configured, not of this repository, so
treat the version shown in Settings → Connection as the only evidence of what
has been applied.

## Tables

| Table | One row per | Purpose |
| --- | --- | --- |
| `vocabulary` | word | Word, meaning, definition, example, date added, trash marker. |
| `card_states` | word | Current schedule: mastery (0–10) and review date; from version 3 also the FSRS state. |
| `review_logs` | answer or undo | Append-only history of every review and every undo. |
| `study_sessions` | sitting | (Version 2.) One row per queue load that had an answer saved in it. |
| `user_settings` | account | Time zone; from version 3 the FSRS target retention. |
| `collections` | collection | (Version 7.) A named group of words. |
| `collection_items` | word in a collection | (Version 7.) Which word is in which collection; a word can be in several. |
| `vocabulary_examples` | further example | (Version 7.) Extra example sentences for a word, with a source note. |
| `vocabulary_relations` | link between two words | (Version 7.) Synonym, antonym, word family, collocation, related, often confused. |
| `vocabulary_maps` | map | (Version 18.) One diagram: its kind, title, description and revision. |
| `vocabulary_map_nodes` | item on a map | (Version 18.) A saved word (its canonical id, optionally one sense) **or** a suggestion (its own text) — a check refuses both together. |
| `vocabulary_map_edges` | link on a map | (Version 18.) Two items and a kind the map's type accepts, with an optional combination pattern and note. |

Every row carries `user_id`, which defaults to the caller (`auth.uid()`) and
references `auth.users` with `on delete cascade`.

### `vocabulary`

| Column | Notes |
| --- | --- |
| `id` | `uuid`, primary key. |
| `user_id` | Owner. |
| `word` | 1–200 characters. |
| `word_key` | The word normalised for duplicate detection (case, spacing, Unicode form). Computed by the app. |
| `meaning`, `definition`, `example` | Optional text, up to 6,000 characters each. |
| `date_added` | Calendar date chosen by the user. |
| `external_source`, `external_id` | Where an imported word came from (`notion` + the Notion page id). Unique per user, which makes an import repeatable. |
| `request_id` | The submission that created the word. Unique per user, so a repeated request cannot create it twice. |
| `created_at`, `updated_at` | Timestamps. An imported word keeps its original creation time. |
| `deleted_at` | Set when the word is in the trash. |
| `root_id` | (Version 11.) The word this one was formed from (`decide` → `decision`), or empty for a root of its own. A single-column foreign key to `vocabulary(id)` on purpose: a composite key with `on delete set null` would clear the owner too. A word cannot be its own root, and `update_vocabulary` only accepts a root of the caller's own account. |

**Deliberately absent from `vocabulary`:** no item-type column — a word,
phrase, idiom, phrasal verb or expression pattern is all ordinary text in
`word` (the API accepts each shape, pinned by test) — and no tags:
Collections are the only stored grouping. Both are open product scope, not
hidden capabilities.

### `card_states`

| Column | Notes |
| --- | --- |
| `vocabulary_id` | Primary key; with `user_id`, references the word (so a state can never belong to someone else's word). |
| `mastery` | `smallint`, checked 0–10. |
| `review_date` | Next review; empty means "due now". |
| `scheduler` | `mastery_v1`: the rules that decide what is due. |
| `fsrs_*` | Stability, difficulty, due, last review, reps, lapses, state, scheduled days, learning steps, version. Empty at version 1 and 2. From version 3 they are filled **when a word is next reviewed**, in the same statement that saves the mastery and date. A check keeps them all empty or all filled. |

Mastery and the FSRS fields are deliberately separate. **Every saved answer
writes both, each by its own rule, in one statement**; neither is ever derived
from the other. The FSRS state is never made up from a mastery level: a word
has none until its first review after version 3, and that first review starts
it as a new FSRS card.

Which of the two decides what is due is not stored here. It is the account's
choice, in `user_settings.scheduler` (version 8), and it is applied when
reading: under `mastery_v1` a word is due by `review_date`; under `fsrs` a
word with an FSRS state is due on the calendar day `fsrs_due` falls on in the
account's time zone, and a word without one is still due by `review_date`.
Because nothing is rewritten when the choice changes, changing it back reads
the other columns exactly as every answer left them.

Mastery is not part of that choice. It counts the same way and retires a word
at 10 whichever schedule is in charge.

(`card_states.scheduler` is an older, per-word column that has only ever held
`mastery_v1`. Nothing reads it.)

### `review_logs`

`id`, `user_id`, `vocabulary_id`, `request_id`, `action` (`remember` /
`not_remember`), `review_mode` (`flashcard`), `reviewed_at`, `reviewed_on` (the
reviewer's calendar day), `duration_ms`, `mastery_before`, `mastery_after`,
`review_date_before`, `review_date_after`, `scheduler`.

`scheduler` says which schedule was in charge of what was due when the row
was written. It has existed since version 1 and held `mastery_v1`; from
version 8 `record_review` fills it from the account's setting (never from the
request), and an undo row copies it from the answer it takes back.

From version 2: `kind` (`review` or `undo`), `session_id`, `undoes_log_id`.
From version 3: `rating` (1–4, the FSRS grade the answer was mapped to),
`fsrs_before`, `fsrs_after` (the FSRS state either side of the answer, as
JSON), `fsrs_version`. From version 5: `confidence` (1 low, 2 medium, 3 high;
empty when no rating was given), what the reviewer said before seeing the
answer. It is recorded only and decides nothing. From version 6: `kind` may
also be `practice`, and `answer_correct`, `submitted_answer` (what was typed,
up to 500 characters) and `grading` (`self` or `auto`) describe a practice
answer. `review_mode` is held to `flashcard`, `recognition`, `recall`,
`typing`, `cloze` or `listening`. From version 10: `submitted_answer` may be
up to 6000 characters (a written answer is a sentence, not a word),
`review_mode` may also be `writing`, and `ai_feedback` and `model_answer`
keep what a language model said about a written answer — always beside an
answer that was already judged and saved by the app, and always null where no
model is configured.

- **A practice row cannot record a change of schedule.** A check requires
  `mastery_before = mastery_after`, the same review date before and after, no
  FSRS state, and a mode other than `flashcard`. `record_practice` only ever
  reads `card_states`; it has no statement that writes it.
- `effective_reviews` does not include practice, so activity, streaks, the
  daily goal, weak words and calibration go on counting scheduled reviews only.

- Unique on `(user_id, request_id)`: one answer is recorded once.
- Signed-in users can `SELECT` and `INSERT` their own rows. There is no
  `UPDATE` or `DELETE` privilege at all, for anyone using the app.
- **An undo is a row, not a deletion.** It has `kind = 'undo'` and points at
  the answer it takes back (`undoes_log_id`, unique, so an answer is undone at
  most once). The view `effective_reviews` (`security_invoker`) lists the
  answers that still stand; every figure the app shows is computed from it.
- **History starts at the migration.** Notion never recorded individual
  reviews, so none are invented for the imported words.

### `study_sessions`

`id` (chosen by the browser when a queue is loaded), `user_id`, `mode`,
`started_at`, `ended_at`. Created by `record_review` with the first answer of
a sitting. Composite foreign keys tie a log row's session to the same owner.

### `user_settings`

`user_id` (primary key), `time_zone` (IANA name, decides which day is
"today"), `preferences` (`jsonb`, unused so far), timestamps. From version 3:
`fsrs_request_retention` (0.700–0.970, default 0.900), the share of reviews
FSRS aims to have remembered. It affects only the FSRS calculation. From
version 5: `daily_goal_reviews` (1–1000) and `daily_goal_minutes` (1–600),
each empty for no goal of that kind. A goal is compared with saved reviews;
nothing reads it when deciding what is due. From version 8: `scheduler`,
`mastery_v1` (the default) or `fsrs`, checked: which schedule decides when the
account's words are due. A new account, and every account that existed before
the column did, has `mastery_v1`.

Display preferences (table or list view, sort order, reduced motion) are not
stored here. They stay in the browser.

### Collections, further examples, relationships

Version 7. These organise words; none of them is part of a word, its schedule
or its history, and no statement on them touches `vocabulary`, `card_states`
or `review_logs`.

- **`collections`**: `id`, `user_id`, `name` (1–80 characters, trimmed),
  `name_key` (the name compared without regard to case or spacing; unique per
  user). Deleting a collection cascades to its `collection_items` and to
  nothing else.
- **`collection_items`**: `collection_id`, `vocabulary_id`, `user_id`.
  Composite foreign keys tie both ends to the same owner, so a collection
  cannot hold another account's word.
- **`vocabulary_examples`**: `id`, `vocabulary_id`, `sentence` (1–2,000
  characters), `source` (optional, up to 300), `preferred`. A partial unique
  index allows one preferred example per word; `set_preferred_example` moves
  the mark in one transaction. The word's original example stays on
  `vocabulary.example`, which is what the flashcard and Fill in the blank read.
- **`vocabulary_relations`**: `id`, `low_id`, `high_id`, `kind`. Every kind
  reads the same in both directions, so a pair is stored once with the smaller
  id first (`low_id < high_id` is checked). A duplicate and its reverse are
  therefore the same row, refused by the unique constraint. Both ends must be
  the owner's words.

A link, an example or a membership of a word in the trash is kept but not
shown until the word is restored.

### Vocabulary maps

Version 18. Diagrams drawn from words already in the account: organising
tables like the ones above, and equally outside a word's schedule or
history — nothing here reads or writes `card_states` or `review_logs`.

- **`vocabulary_maps`**: `id`, `user_id`, `type` (the seven creatable
  kinds; a check refuses `personal`, which is drawn live on every read and
  stored nowhere), `title`, `description`, `revision`, `request_id` —
  unique per user, so the same creation submitted twice lands once.
- **`vocabulary_map_nodes`**: a saved item carries `vocabulary_id` and an
  optional `sense_id` and **no stored label** — its text is read from the
  word on every read, so renaming a word updates its maps at once. A
  suggestion carries its own `label` and no word id. Both carry `note`,
  `group`, `step` and `x`/`y`. The key (`id`, `user_id`) lets the edges'
  foreign keys refuse another account's item, and the sense reference is
  checked to be a sense of that very word.
- **`vocabulary_map_edges`**: `from_node_id`, `to_node_id`, `kind` (one of
  the stored kinds — a check list), optional `pattern` and `note`
  (a contrast without its note is refused). Two items with a kind are
  stored once (natural uniqueness, in either order of the pair), and an
  item cannot be linked to itself.

Deleting a map removes only its diagram (nodes and links cascade);
deleting a word removes its nodes and links and leaves the map standing.

## Row Level Security

RLS is enabled on every table. Every policy is the same test:
`user_id = auth.uid()`, for the `authenticated` role only.

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `vocabulary` | own | own | own | — |
| `card_states` | own | own | own | — |
| `review_logs` | own | own | — | — |
| `study_sessions` | own | own | own | — |
| `user_settings` | own | own | own | — |
| `collections` | own | own | own | own |
| `collection_items` | own | own | — | own |
| `vocabulary_examples` | own | own | own | own |
| `vocabulary_relations` | own | own | — | own |
| `vocabulary_maps` | own | own | own | own |
| `vocabulary_map_nodes` | own | own | own | own |
| `vocabulary_map_edges` | own | own | own | own |

- **Signed-out visitors (`anon`) have no privileges on anything.**
- **No word, schedule or review can be deleted outright.** Only the
  organising tables above allow deletion: a collection takes only its
  memberships, a map only its diagram, and neither ever touches a word.
  "Delete" on a word in the app sets `deleted_at`,
  and Settings → Deleted words restores it. Rows only go when the account
  itself is deleted (cascade from `auth.users`).
- `user_id` cannot be changed to another user's (the `WITH CHECK` refuses it),
  and composite foreign keys stop a state or a log row from pointing at a word
  owned by someone else.
- The view `vocabulary_cards` (word + state) is `security_invoker`, so it obeys
  the caller's RLS.
- The migration first revokes everything, then grants exactly the table above,
  so it does not depend on the project's default grants.

## Functions

All are `security invoker` (they run as the caller, under RLS) with a fixed
empty `search_path`, executable by `authenticated` only.

| Function | Guarantee |
| --- | --- |
| `create_vocabulary(...)` | Creates the word and its state in one transaction. A repeated `request_id`, or a repeated `external_source` + `external_id`, returns the existing word instead of creating another. |
| `update_vocabulary(id, patch)` | Applies an edit to the word and/or its schedule completely or not at all. Only named fields are accepted. |
| `apply_review(...)` | Saves one answer: updates the state **only if it still equals the state the answer was computed from**, and appends the history row, in one transaction. Returns `applied`, `already_applied` (same `request_id` seen before), `conflict` (state changed meanwhile) or `not_found`. Used while the database is at version 1. |
| `record_review(event)` | (Version 2.) The same guarantees as `apply_review`, taking one JSON document so later versions can add fields. Also creates the sitting's `study_sessions` row and, from version 3, stores the FSRS state with the mastery state in one statement. Adds the outcome `undone` for a request whose answer has since been taken back. From version 8 it reads the account's `scheduler`, records it on the history row, and **refuses an answer that carries no FSRS result while FSRS is in charge**, since saving it would leave the word exactly where FSRS had it. What it writes to `card_states` is unchanged. |
| `undo_review(review_request_id, request_id)` | (Version 2.) Takes back one answer: allowed only if it is the latest standing review of that word **and** the word's state still equals what that answer left. Restores mastery, review date and (version 3) the FSRS state from the values recorded before the answer, and appends the `undo` row, in one transaction. Returns `undone`, `already_undone`, `not_latest`, `conflict` or `not_found`. Repeating the same request changes nothing. |
| `session_summary(session_id)` | (Version 2.) Counts for one sitting: reviewed, remembered, not remembered, first-time and repeat words, time, undone. |
| `review_daily_stats(from, to)` | (Version 4.) One row per day and study mode from the answers that still stand: reviews, remembered, repeat reviews, time. |
| `card_review_stats(since)` | (Version 4.) Per word: reviews, failures, recent reviews and failures, days failed on, last reviewed, last failed, last answer. |
| `confidence_stats(since)` | (Version 5.) Per confidence level: standing answers that carried it, and how many were remembered. |
| `record_practice(event)` | (Version 6.) Appends one practice answer, once per request id, for a live word of the caller's. Returns `recorded`, `already_recorded` or `not_found`. Never updates anything. From version 10 the event may also carry `ai_feedback` and `model_answer`, read only when present. |
| `practice_daily_stats(from, to)` | (Version 6.) Practice answers per day and study mode: answers, correct, time. |
| `bump_vocabulary_map_revision(map_id)` | (Version 18.) Adds one to a map's `revision` and returns it, for a map the caller owns. Under row-level security a blocked call returns one row of NULLs instead of an error, which the server reads as *nothing changed* — a write that somehow slipped past RLS can never report a revision it did not update. |

The new mastery and review date are computed by the API server with the same
rules engine (`shared/review-logic.ts`) and passed to the function as absolute
values. The browser never supplies them. The same holds for the FSRS state:
the server computes it ([`shared/scheduler/fsrs.ts`](../shared/scheduler/fsrs.ts),
the only file that uses the `ts-fsrs` library) and the database only stores
it. If that calculation ever fails while the mastery schedule is in charge,
the answer is still saved by the mastery rules and the failure is logged; a
review is never lost to it. While FSRS is in charge the answer is refused
instead, and can be tried again: an answer saved without its FSRS result
would not move the word at all.

Whether a word is due is checked by the server on every answer against the
schedule in charge. The state an answer is checked against for staleness is
always the mastery state (mastery and review date), under either schedule:
every answer changes it, so it guards both.

## Review behaviour

| Answer | Mastery | Review date |
| --- | --- | --- |
| Remember | + 1, never above 10 | day of review + the **old** mastery, in days |
| Not remember | unchanged | the day after the review |

Queue: mastery below 10 and review date empty or not after today; most overdue
first. Definition and example are hidden above mastery 5. "Today" is the
calendar day in the account's time zone. See [review-logic.md](review-logic.md).

## Several devices

- The database is the single source of truth. Signing in on any device shows
  the same words and the same schedule.
- **Synchronisation is refresh-based, not real-time.** A device re-reads the
  vocabulary when a page asks for it and its copy is over a minute old, when
  you return to the tab, after it saves something itself, and on Refresh /
  Check again. A change made elsewhere is not pushed to an open page.
- **The same card reviewed on two devices:** the first answer to arrive is
  saved. The second device's answer was based on a state that no longer holds,
  so it is refused; that device shows "This card changed on another device"
  and offers to skip it. Nothing is counted twice and no answer overwrites
  another. If both devices gave the *same* answer, the second is simply
  reported as already saved.
- **A lost response:** Retry sends the same request id, and the database
  returns the first result instead of applying the answer again.
- There is no offline mode: an answer given without a connection is not
  queued; the card stays on screen with a Retry.

## Accounts

- Email + password through Supabase Auth: sign up, sign in, sign out (this
  device only), password reset by email, session restored on reload, tokens
  renewed automatically.
- When a token is refused the browser renews it once and repeats the request;
  if it is refused again, the session is ended and the sign-in screen returns
  with an explanation.
- Each signed-in user gets a fresh, separate in-browser state. Nothing loaded
  for one account is kept when another signs in.
- A new account's time zone is taken from the first device it signs in on
  (falling back to `REVIEW_TIMEZONE`, then UTC) and can be changed in Settings.

## What a signed-in user can still do to their own data

RLS protects accounts from each other. It does not stop a user from calling
the Supabase API directly with their own token and editing **their own** rows
(for example, giving themselves mastery 10). For a personal study tool that is
accepted. It cannot affect any other account.

## How this is tested

| What | Where | Runs against |
| --- | --- | --- |
| Schema, privileges, policies, functions | `tests/database/schema.test.ts` | Real PostgreSQL (PGlite) with the migration applied |
| HTTP API in Supabase mode, two accounts, two devices | `tests/server/supabase-api.test.ts` | Same, through the real services |
| Import and reconciliation | `tests/server/backup-import.test.ts` | Same; also the real export when present locally |
| Undo, sessions, a database one version behind | `tests/server/undo-api.test.ts` | Same |
| FSRS alongside: stored atomically, restored by undo, not deciding what is due unless chosen | `tests/server/fsrs-shadow.test.ts`, `tests/shared/fsrs.test.ts` | Same; unit |
| Choosing the schedule in charge: per account, both ways, nothing converted, undo, a database one version behind | `tests/server/scheduler-switch.test.ts`, `tests/shared/scheduler-active.test.ts` | Same; unit |
| The what-if comparison and the calendar's review counts: read-only, own data only | `tests/server/simulation-api.test.ts`, `tests/shared/simulation.test.ts` | Same; unit |
| The gateway asks an older database only for what that database has | `tests/server/gateway-versions.test.ts` | The real gateway, with a recording stand-in for the SDK |
| Import (content only, once per row, per account) and export (read-only, own data only), with round trips | `tests/server/import-export-api.test.ts`, `tests/shared/import.test.ts` | Same; unit |
| Collections, further examples, related words: isolation, constraints, no word ever deleted | `tests/server/library-api.test.ts` | Same |
| Practice modes: judged on the server, recorded once, never moving the schedule | `tests/server/practice-api.test.ts`, `tests/shared/study-modes.test.ts` | Same; unit |
| Daily goal, review filters, confidence ratings, a database one version behind | `tests/server/goals-api.test.ts`, `tests/shared/session-planner.test.ts` | Same; unit |
| Review activity and weak words, per account | `tests/server/analytics-api.test.ts`, `tests/shared/analytics.test.ts`, `tests/shared/weak-words.test.ts` | Same; unit |
| No privileged key in browser code or server settings | `tests/frontend-secrets.test.ts` | The source files |
| Token and configuration handling | `tests/server/supabase-accounts.test.ts` | Unit |
| Sign-in flows, account switching | `tests/client/accounts.test.tsx` | In-memory sign-in service |
| Live project: isolation, idempotent saves, append-only history | `npm run supabase:verify` | **Your Supabase project** |

The only code not run against a database without a real project is the thin
layer that calls the Supabase SDK: `server/supabase/supabase-database.ts` and
`src/lib/supabase-auth.ts`. The API tests go through a mirror of the first
that speaks SQL to the in-process database, so a mistake in the real one would
not show up there. Two things cover that gap: `tests/server/gateway-versions.test.ts`
runs the real gateway against a stand-in that records what it asks for, and
fails if a database at any version would be asked for a table, view or
function it does not have; and `npm run supabase:verify` exercises the real
gateway against the live project.
