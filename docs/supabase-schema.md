# Supabase: schema, accounts and security

How the app stores vocabulary in Supabase. The SQL is in
[supabase/migrations](../supabase/migrations); this document explains it. For
the steps to move from Notion, see [supabase-migration.md](supabase-migration.md).

## Architecture

```
Browser ── Supabase Auth (email + password, public key) ──► session (access token)
   │
   │  every request: Authorization: Bearer <access token>
   ▼
API server (Hono, the same routes as before)
   │  1. verifies the token
   │  2. computes the review result with the unchanged rules engine
   │  3. queries Supabase with the public key + that user's token
   ▼
PostgreSQL ── Row Level Security decides what that user can reach
```

- The browser uses Supabase for **signing in only**. All vocabulary still goes
  through the app's own API, so the review rules stay in one place on the
  server, exactly as before.
- The server holds **no privileged key**. It queries the database as the
  signed-in user, so even a bug in the server cannot read another account's
  rows: the database refuses.
- The server refuses to start in Supabase mode if the configured key is a
  secret / service-role key, because that key would be handed to browsers.

## Tables

| Table | One row per | Purpose |
| --- | --- | --- |
| `vocabulary` | word | Word, meaning, definition, example, date added, trash marker. |
| `card_states` | word | Current schedule: mastery (0–10) and review date. |
| `review_logs` | answer | Append-only history of every review. |
| `user_settings` | account | Time zone (and room for more). |

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

### `card_states`

| Column | Notes |
| --- | --- |
| `vocabulary_id` | Primary key; with `user_id`, references the word (so a state can never belong to someone else's word). |
| `mastery` | `smallint`, checked 0–10. |
| `review_date` | Next review; empty means "due now". |
| `scheduler` | `mastery_v1`: the current rules. |
| `fsrs_*` | Stability, difficulty, due, last review, reps, lapses, state, version. **All empty.** Reserved for a future scheduler; nothing reads or writes them. |

Mastery and the FSRS fields are deliberately separate. Switching scheduler
later will mean filling the FSRS columns from `review_logs`, not reinterpreting
mastery.

### `review_logs`

`id`, `user_id`, `vocabulary_id`, `request_id`, `action` (`remember` /
`not_remember`), `review_mode` (`flashcard`), `reviewed_at`, `reviewed_on` (the
reviewer's calendar day), `duration_ms`, `mastery_before`, `mastery_after`,
`review_date_before`, `review_date_after`, `scheduler`.

- Unique on `(user_id, request_id)`: one answer is recorded once.
- Signed-in users can `SELECT` and `INSERT` their own rows. There is no
  `UPDATE` or `DELETE` privilege at all, for anyone using the app.
- **History starts at the migration.** Notion never recorded individual
  reviews, so none are invented for the imported words.

### `user_settings`

`user_id` (primary key), `time_zone` (IANA name, decides which day is
"today"), `preferences` (`jsonb`, unused so far), timestamps.

Display preferences (table or list view, sort order, reduced motion) are not
stored here. They stay in the browser, as before.

## Row Level Security

RLS is enabled on all four tables. Every policy is the same test:
`user_id = auth.uid()`, for the `authenticated` role only.

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `vocabulary` | own | own | own | — |
| `card_states` | own | own | own | — |
| `review_logs` | own | own | — | — |
| `user_settings` | own | own | own | — |

- **Signed-out visitors (`anon`) have no privileges on anything.**
- **Nothing can be deleted outright.** "Delete" in the app sets `deleted_at`,
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
| `apply_review(...)` | Saves one answer: updates the state **only if it still equals the state the answer was computed from**, and appends the history row, in one transaction. Returns `applied`, `already_applied` (same `request_id` seen before), `conflict` (state changed meanwhile) or `not_found`. |

The new mastery and review date are computed by the API server with the same
rules engine as before (`shared/review-logic.ts`) and passed to `apply_review`
as absolute values. The browser never supplies them.

## Review behaviour (unchanged)

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
| Token and configuration handling | `tests/server/supabase-accounts.test.ts` | Unit |
| Sign-in flows, account switching | `tests/client/accounts.test.tsx` | In-memory sign-in service |
| Live project: isolation, idempotent saves, append-only history | `npm run supabase:verify` | **Your Supabase project** |

The only code not covered without a real project is the thin layer that calls
the Supabase SDK: `server/supabase/supabase-database.ts` and
`src/lib/supabase-auth.ts`. `npm run supabase:verify` exercises every method of
the first against the live project.
