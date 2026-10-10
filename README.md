# Vocabulary

A vocabulary learning app with flashcards and spaced review. Your words live
in your own account on Supabase, so they are the same on every device you sign
in on.

| Tab | What it does |
| --- | --- |
| **Dashboard** | What is ready to review, summary counts, mastery distribution, additions over time, recent words. |
| **Review** | Flashcards: flip, then answer Remember or Not remember. |
| **Add vocabulary** | Creates a new word, with a duplicate check. |
| **Vocabulary bank** | Every word: search, filter, sort, view details, edit, delete, export. |
| **Calendar** | Words by the day they were added. |
| **Insights** | Additions by day, week and month, share mastered, busiest days, incomplete entries. |
| **Settings** | Account, time zone, display preferences, backup export, deleted words, connection status. |

Reference documents:

- [docs/review-logic.md](docs/review-logic.md) — the review rules and where each comes from.
- [docs/supabase-schema.md](docs/supabase-schema.md) — the database, accounts and security.
- [docs/metrics.md](docs/metrics.md) — the exact definition of every number shown.
- [docs/supabase-migration.md](docs/supabase-migration.md) — the record of the move from Notion to Supabase.

## Try it with sample data

Requires Node.js 24 (24.15 or newer).

```bash
npm install
```

```bash
npm run dev:mock
```

Open http://localhost:5174. This uses a dozen built-in sample words kept in
memory. It needs no account and contacts nothing, whatever is in `.env`.
Adding, editing and deleting all work and are forgotten when the server stops.

In Windows PowerShell, if `npm` is blocked by the script execution policy, use
`npm.cmd` instead (for example `npm.cmd run dev:mock`).

## Reviewing

| Action | Keyboard | Touch |
| --- | --- | --- |
| Flip the card | `Space` | Tap the card |
| Not remember | `←` | Swipe left |
| Remember | `→` | Swipe right |

An answer is accepted only after the card has been flipped. The two buttons
under the card do the same as the keys and swipes. These shortcuts are active
on the Review tab only.

| Answer | Mastery | Review date |
| --- | --- | --- |
| Remember | + 1, never above 10 | the day of the review + the **old** mastery in days |
| Not remember | unchanged | the day after the review |

A word is due when its mastery is below 10 and its review date is empty, today
or earlier. The definition and example are hidden above mastery 5. "Today" is
the calendar day in your account's time zone.

A review session survives switching tabs: come back and it is where you left
it. A finished session reloads the queue when you return.

## Set up your own copy

### 1. Create a Supabase project

1. https://supabase.com/dashboard → **New project**. Pick a region near you.
2. **SQL Editor → New query**: paste the whole of
   [supabase/migrations/20261010090000_initial_schema.sql](supabase/migrations/20261010090000_initial_schema.sql)
   and press **Run**. Run it once.
3. **Authentication → URL Configuration**: set **Site URL** to the address the
   app will be served from, and add `http://localhost:5173` under **Redirect
   URLs**. Confirmation and password-reset emails link back to these.

### 2. Configure

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | The **publishable** key (`sb_publishable_…`), or the older `anon` key. Found under Project Settings → API Keys. `SUPABASE_PUBLISHABLE_KEY` is accepted as another name for it. |
| `DATA_MODE` | Optional. `supabase` or `mock`. Empty means Supabase in a deployment or when `SUPABASE_URL` is set, sample data otherwise. |
| `REVIEW_TIMEZONE` | Optional. The zone a new account starts with if its browser reports none. |
| `REVIEW_WRITES_ENABLED` | Optional. Exactly `false` freezes all changes; anything else leaves saving on. |

Both Supabase values are public by design: the server hands them to the
browser. **Never use the secret / `service_role` key.** The server refuses to
start with one, and no part of the app needs it. `.env` is git-ignored.

### 3. Run it

```bash
npm run dev
```

Open http://localhost:5173, choose **Create an account**, and confirm the
email if your project asks for it.

## Accounts

- Email and password, through Supabase Auth: create an account, sign in, sign
  out, reset a forgotten password by email.
- You stay signed in across reloads. Signing out affects only the device you
  do it on.
- Each account has its own words, review progress and time zone. Nobody can
  see or change another account's data; the database enforces this itself
  (Row Level Security), independently of the app.
- To keep a deployment to yourself, create your account and then turn off
  **Allow new users to sign up** in Supabase under Authentication → Sign In /
  Providers.

## Adding vocabulary

- Only the word is required. Vietnamese meaning, definition, example sentences
  and date added are optional.
- A new word starts at **mastery 1 with no review date**, so it is due for
  review immediately. Both values are shown under "Starting review settings"
  and can be changed per word.
- Date added defaults to today in your time zone.
- Before saving, the word is compared with your existing ones, ignoring case
  and spacing. A match shows the existing entry and asks whether to cancel or
  add it anyway. Nothing is merged or discarded automatically.
- **Quick add** reduces the form to word and meaning; Enter saves and returns
  the cursor to the word field. In the full form, Ctrl + Enter saves from any
  field.
- Success is shown only after the server has confirmed the new word.

## Vocabulary bank

- **Search** matches the word, meaning, definition and example,
  case-insensitively and on partial text.
- **Filters**: review status, mastery level, date added range, missing fields.
  One-click presets cover the common ones.
- **Sort** by word, date added, review date or mastery, either direction.
- **Views**: table or compact list. Results are paged.
- Filters, sorting and the open word are kept in the address, so a view can be
  bookmarked and the Back button works.
- **Details**: click a word to see everything stored about it.
- **Edit**: only the fields you change are written. Mastery and the review date
  are in a separate "Review schedule" section and are left alone unless you
  open it.
- **Delete** asks for confirmation and moves the word to the trash. An Undo
  appears right after, and **Settings → Deleted words** restores it at any
  later time, with its mastery and dates as they were.
- **Export** downloads all words as CSV or JSON. Exporting only reads.

## How it protects your data

- **Accounts are isolated by the database.** Every row belongs to one account
  and Row Level Security checks every read and write. The server queries as
  the signed-in user with the public key, so even a bug in the server cannot
  reach another account's rows.
- **The browser never decides a result.** It sends the word, the answer, and
  the state it was showing. The server computes the new mastery and date from
  its own read; a request that tries to supply them is rejected.
- **An answer is saved exactly once.** The new state and its history row are
  written in one transaction, only if the word has not changed since it was
  shown, and a repeated request is recognised by its id. Retrying is always
  safe.
- **A word cannot be created twice by a repeated request**, for the same
  reason.
- **Only what changed is written.** Editing a definition cannot touch mastery
  or the review date.
- **Nothing is deleted outright.** Delete means the trash; no one, the app
  included, has permission to remove a word or edit the review history.
- **Every write is confirmed.** The app shows success only when the server has
  returned the stored record.
- **Automated tests never touch a real project.** They run the real schema on
  an in-process PostgreSQL.

## Several devices

Sign in with the same account on each device. The data is the same everywhere.

- Synchronisation is **refresh-based, not real-time**: a device re-reads your
  words when a page asks for them and its copy is over a minute old, when you
  return to the tab, after it saves something itself, and on Refresh.
- If you answer the same card on two devices, the first answer is saved. The
  second device is told the card changed on another device and offers to skip
  it. Nothing is counted twice.
- There is no offline mode. An answer given without a connection stays on
  screen with a Retry.

## Deploying

### Vercel

`vercel.json` builds the frontend with Vite, routes `/api/*` to one Node
function (`api/index.ts`) and serves the app for every other address so deep
links work.

1. In Vercel choose **Add New → Project** and import the GitHub repository.
   Keep the detected **Vite** preset and the default build settings.
2. Add the environment variables `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. Deploy, then open `/api/health` and confirm `"ok": true` and
   `"mode": "supabase"`.
4. In Supabase, set **Authentication → URL Configuration → Site URL** to the
   deployed address.
5. Environment variable changes apply to new deployments only: **Deployments →
   ⋯ → Redeploy**. Every push to `main` also deploys.

To show the app with sample data only, set `DATA_MODE=mock`.

### Self-hosted

```bash
npm run build
```

```bash
npm start
```

`npm start` serves the built frontend and the API from one Node process on
`PORT` (default 8787). Set `NODE_ENV=production` and the variables above in
the environment, and put it behind HTTPS.

## Project layout

```
config/review.config.ts     The review rules and new-word defaults
shared/                     Pure logic used by browser and server
  review-logic.ts             Eligibility, ordering, visibility, answers
  vocabulary-status.ts        A word's review state, from the same rules
  metrics.ts                  Dashboard, insights and calendar numbers
  dates.ts, text.ts           Calendar-day arithmetic; word normalisation and search
  api.ts                      Request/response schemas (Zod)
  backup.ts                   The backup file format used by the import
server/
  create-app.ts               Routes, validation, sign-in check, error mapping
  accounts.ts                 What a signed-in request may use
  review-service.ts           Review queue and the safe answer path
  vocabulary-service.ts       List, create, edit, trash, restore
  supabase/                   Database gateway, repository, account sessions, backup import
  mock/                       Sample words and illustrative rules
  index.ts                    Node entry (self-hosting)
api/index.ts                Vercel entry
supabase/migrations/        Schema, Row Level Security policies and functions (SQL)
src/                        React interface
  App.tsx, app-context.tsx    Start-up, sign-in, routing, shared session and vocabulary
  pages/                      One file per tab
  components/                 Flashcard, charts, word panel, sign-in, navigation
  lib/                        Router, API client, sign-in, stores, bank query, export
  hooks/                      Keyboard shortcuts, swipe detection
scripts/                    supabase-import, supabase-verify
tests/                      Vitest: logic, database, server, API, pages
docs/                       Review logic, schema and security, metric definitions
```

### API

Every route except the first two needs `Authorization: Bearer <access token>`.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Configuration status. Public; contains no secrets. |
| `GET /api/config` | Public. How to sign in: the project address and public key. |
| `GET /api/review-queue` | Due cards in order, with fields already filtered by mastery. |
| `POST /api/review-action` | `{ pageId, action, expected, requestId }` → `applied`, `already_applied` or `dry_run`. `409` if the word changed. |
| `GET /api/vocabulary` | Every word, with its review state. |
| `GET /api/vocabulary/:id` | One word, read fresh. |
| `POST /api/vocabulary` | Create a word. `409` with the existing entries if it is a duplicate. |
| `PATCH /api/vocabulary/:id` | Edit named fields; `schedule` for mastery and review date. |
| `DELETE /api/vocabulary/:id` | Move a word to the trash. |
| `POST /api/vocabulary/:id/restore` | Take it back out. |
| `GET /api/trash` | Deleted words that can be restored. |
| `GET /api/settings`, `PUT /api/settings` | The account's time zone. |

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | The app on http://localhost:5173, using `.env` (your real Supabase project if configured) |
| `npm run dev:mock` | The app on http://localhost:5174 with sample data only |
| `npm test` | All tests |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm run build` | Type-check, build frontend and server |
| `npm run supabase:verify` | Checks a live project from outside: isolation between two accounts, single saving, append-only history |
| `npm run supabase:import` | Dry run of importing a backup file into an account; `-- --apply` to do it |

## Limitations

- Sync is refresh-based, not real-time, and there is no offline mode.
- The whole vocabulary is loaded at once and searched in the browser. That is
  comfortable into the low thousands of words; beyond that it would need
  server-side search.
- Text is plain: no bold, links or other formatting.
- There are no fields for part of speech, pronunciation, tags, topic or notes.
- Display preferences are stored per browser, not per account.
- Duplicate detection can be beaten by two simultaneous submissions of the
  same word from two devices; the bank then shows both.
- A signed-in user can change their own data directly through the Supabase
  API, bypassing the review rules. They cannot touch anyone else's.
- The review history starts on 2026-10-10. Earlier reviews were never
  recorded individually, so they are not in it.
- The scheduling is the mastery-based rule above. Columns for a future FSRS
  scheduler exist in the database but nothing uses them yet.

## If something goes wrong

- **A word was deleted by mistake:** Settings → Deleted words → Restore.
- **A word got the wrong value:** open it in the bank and correct it under
  "Review schedule". The review history (`review_logs` in Supabase) shows what
  each answer changed.
- **You want to stop all changes immediately:** set
  `REVIEW_WRITES_ENABLED=false` and restart or redeploy.
- **You are signed out unexpectedly:** sign in again. If it keeps happening,
  check `/api/health` and the Supabase project's status.
- **The public key may have been swapped for a secret one:** the server
  refuses to start and `/api/health` says why. Replace it with the publishable
  key and rotate the secret key in Supabase.
- **You want a copy of everything:** Settings → Backup → Export JSON.
