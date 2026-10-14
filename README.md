# Vocabulary

A vocabulary learning app with flashcards and spaced review. Your words live
in your own account on Supabase, so they are the same on every device you sign
in on.

| Tab | What it does |
| --- | --- |
| **Dashboard** | What is ready to review, review activity (today, accuracy, streak, time), summary counts, mastery distribution, additions over time, recent words. |
| **Review** | Flashcards: flip, then answer Remember or Not remember. Narrow the queue (weakest, overdue, due today, recently added, one collection). Undo the last answer; a summary of what was saved at the end, with progress against the daily goal. |
| **Practice** | Other ways to work on words: recognition, recall, typing, fill in the blank, and listening (experimental). Recorded for your statistics; never changes mastery or a review date. |
| **Add vocabulary** | Creates a new word, with a duplicate check. **Import a list** brings in many at once from CSV, text, an Excel file or this app's own export, with a preview first. |
| **Vocabulary bank** | Every word: search, filter (also by collection), sort, view details, edit, delete, export. A word's panel also holds its further examples and related words. |
| **Collections** | Your own groupings of words. A word can be in several; deleting a collection never deletes a word. |
| **Calendar** | A month at a glance: words by the day they were added, or saved reviews by the day you did them. |
| **Weak words** | Words that need attention, weakest first, each with the reasons it is listed and a suggested action. Starts a review of just those that are due, or practice with all of them. |
| **Insights** | Reviews per day, accuracy and time per card week by week, accuracy and retention by period, confidence calibration, practice by mode, additions over time, share mastered, busiest days, incomplete entries. |
| **Settings** | Account, time zone, daily goal, review preferences, scheduling (which schedule is in charge, the FSRS comparison and estimate, and a what-if on your saved answers), display preferences, exports, deleted words, connection and database status. |

Reference documents:

- [docs/review-logic.md](docs/review-logic.md) — the review rules and where each comes from.
- [docs/supabase-schema.md](docs/supabase-schema.md) — the database, accounts and security.
- [docs/metrics.md](docs/metrics.md) — the exact definition of every number shown.
- [docs/supabase-migration.md](docs/supabase-migration.md) — the record of the move from Notion to Supabase.
- [docs/import-and-export.md](docs/import-and-export.md) — importing a list, the export format, and backup and recovery.
- [docs/upgrade-plan.md](docs/upgrade-plan.md) — the plan for turning this into a fuller learning system, and how far it has got.
- [docs/offline-mode-design.md](docs/offline-mode-design.md) — what offline review would take. Not built.

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
| Undo the last answer | `U` | The Undo button above the card |
| List the shortcuts | `?` | The keyboard button above the card |

An answer is accepted only after the card has been flipped. The two buttons
under the card do the same as the keys and swipes. These shortcuts are active
on the Review tab only, and never while you are typing in a field. Settings →
Review preferences can add a second pair of answer keys (`J`/`K`, `F`/`J` or
`1`/`2`) and can ask how sure you are before each answer is shown.

| Answer | Mastery | Review date |
| --- | --- | --- |
| Remember | + 1, never above 10 | the day of the review + the **old** mastery in days |
| Not remember | unchanged | the day after the review |

A word is due when its mastery is below 10 and its review date is empty, today
or earlier. The definition and example are hidden above mastery 5. "Today" is
the calendar day in your account's time zone. (If you put FSRS in charge, the
date that decides is FSRS's instead; see Scheduling and FSRS below.)

A review session survives switching tabs: come back and it is where you left
it. A finished session reloads the queue when you return.

**Undo** takes back the most recent saved answer: the word returns to exactly
the mastery and date it had, and the card comes back. It works only while that
answer is still the latest thing that happened to the word (not after a later
review or an edit on another device). The history keeps both the answer and
its undo; nothing is erased.

**At the end of a session** the app shows what was actually saved: remembered
and not remembered, accuracy, time on cards, how many words were new to you,
and how many answers were undone.

**Weakest words only.** The Weak words page can start a review of just the
listed words that are already due (`/review?focus=weak`). It only narrows the
normal queue; it never brings a word forward, and answers are saved by the
same rules.

**A daily goal** (Settings) is a number of reviews, a number of minutes, or
both. It is only ever compared with what you saved: it never hides, reorders
or reschedules a card, and it changes no scheduling setting.

### Practice

The Practice tab asks about your words in other ways. Each mode needs
different things from a word and leaves out the ones that lack them, saying
why.

| Mode | You see | You do | Judged by |
| --- | --- | --- | --- |
| Recognition | The word | Pick its meaning from four of your own | The server |
| Recall | The meaning | Recall the word, then say whether you had it | You |
| Typing | The meaning | Type the word | The server |
| Fill in the blank | Your example with the word left out | Type the word | The server |
| Listening (experimental) | Nothing: the word is read aloud | Type what you hear | The server |

Practice is recorded and reported one mode at a time, and **never changes
mastery, a review date or FSRS**.

Each word also has a **practice mastery** from 0 to 3 in each mode: one point
for every correct practice answer in that mode, never above 3, and unchanged
by a wrong answer. It is shown in the word's panel and after each practice
answer. It is counted from the practice history, kept apart from the review
mastery in the table above, and plays no part in deciding when a word is due. Listening uses the browser's own speech
synthesis: no audio is stored or sent, and how it sounds, or whether a voice
exists for the accent chosen, depends on the device. Where a browser cannot
read text aloud the mode says so and stays off.

### Scheduling and FSRS

Every saved answer moves **two** schedules, each in its own place:

- the **mastery schedule** in the table above, and
- an [FSRS](https://github.com/open-spaced-repetition/ts-fsrs) state (Remember
  counts as "Good", Not remember as "Again"; no same-day steps, no random
  spread).

Only one of them decides what is due, and each account chooses which, in
Settings → Scheduling. **The mastery schedule is in charge unless you change
it.** Because both are kept up to date by every answer whichever is in charge,
changing the choice converts nothing, loses nothing, and can be undone at any
time.

With FSRS in charge:

- A word comes back on the day FSRS works out. Everywhere that says when a
  word is due (the queue, the bank, the dashboard, the day's plan, weak words)
  follows it.
- A word that has not been answered since FSRS started being calculated has no
  FSRS state, and none is made up: it stays on its mastery date until its
  first answer.
- Mastery works exactly as before. It still rises with each Remember, still
  hides the definition above 5, and still retires a word at 10.
- A review date FSRS set cannot be typed over. Mastery can still be corrected.

Settings → Scheduling also shows, before you choose:

- **The two schedules side by side** for the words FSRS has seen.
- **Estimated recall**: FSRS's own figure for the chance you would remember a
  word right now. It is a model's estimate, not a measurement, and is not the
  accuracy on the Insights page. Words answered only once show none.
- **Try it on your saved answers**: replays the answers you actually saved
  through FSRS at any target retention and sets the result next to your
  schedule as it stands. It stores nothing and moves no date. Its one
  forward-looking table is a stated scenario ("if you remembered every word"),
  not a forecast.

### Database updates

New features need new tables and functions. They come as SQL files in
[supabase/migrations](supabase/migrations), to be run **in order, once each**
in the Supabase dashboard (SQL Editor → paste the file → Run):

| File | Database version | Turns on |
| --- | --- | --- |
| `20261010090000_initial_schema.sql` | 1 | The app itself. |
| `20261011090000_sessions_and_undo.sql` | 2 | Undo and the end-of-session summary. |
| `20261012090000_fsrs_shadow.sql` | 3 | The FSRS calculation and comparison. |
| `20261013090000_review_analytics.sql` | 4 | Review activity and history-based weak words. |
| `20261014090000_goals_and_confidence.sql` | 5 | The daily goal and confidence ratings. |
| `20261015090000_practice_modes.sql` | 6 | Recording practice in the other study modes. |
| `20261016090000_collections_and_relations.sql` | 7 | Collections, further examples, related words. |
| `20261017090000_scheduler_switch.sql` | 8 | Choosing which schedule is in charge (FSRS or mastery). Changes nothing until an account chooses FSRS. |

Each file only adds things; none changes or removes existing data. The app
checks the database version and keeps working on an older one, with the newer
features switched off and saying so. Settings → Connection → Database shows
the version found and whether an update is waiting. Run the SQL first, then deploy; either
order is safe.

If the Vercel project is linked to Supabase through Vercel's Supabase
integration, the files in `supabase/migrations` may be applied to the database
automatically when `main` is deployed. Whether that happens depends on how the
integration is set up, so check the version shown in Settings after a deploy
rather than assuming either way.

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
  open it and change them. The section says whether a change is waiting to be
  saved, and a change stays in the save even if you close the section again.
- **Delete** asks for confirmation and moves the word to the trash. An Undo
  appears right after, and **Settings → Deleted words** restores it at any
  later time, with its mastery and dates as they were.
- **Export** downloads all words as CSV or JSON. Exporting only reads.
  Settings → **Export everything** downloads the whole account: words, both
  schedules, the full review history, collections, examples, links and
  settings. See [docs/import-and-export.md](docs/import-and-export.md).

## Importing a list

Add vocabulary → **Import a list**. Paste text or choose a file: CSV or
tab-separated text, a plain list with one word per line, an Excel `.xlsx` file
(first sheet), or a file this app exported. The file is read on your device.
You map the columns, see every row with its status (new, already in your
vocabulary, repeated in the list, cannot be imported), and nothing is added
until you confirm. Duplicates are left out unless you tick them; nothing is
ever merged into an existing word. Imported words start as new words: a
mastery or review date in the file is ignored.

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
  included, has permission to remove a word or edit the review history. Undo
  adds a row saying the answer was taken back; it removes nothing.
- **No privileged key exists anywhere in the app.** A test reads the source to
  keep it that way: browser code may not read the environment, name a secret
  key or import server code.
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
  screen with a Retry. What building one would take is written up in
  [docs/offline-mode-design.md](docs/offline-mode-design.md).

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
  analytics.ts                Review activity from saved answers
  weak-words.ts               Which words need attention, and why
  scheduler/                  FSRS, the rating map, which schedule is in charge, the comparison, the what-if
  study-modes.ts              The practice modes: what each needs and how an answer is judged
  session-planner.ts          The daily goal against what was saved
  library.ts                  Collections, further examples, links between words
  import.ts, export-format.ts Reading a list to import; the account export
  dates.ts, text.ts           Calendar-day arithmetic; word normalisation and search
  api.ts                      Request/response schemas (Zod)
  backup.ts                   The backup file format used by the import
server/
  create-app.ts               Routes, validation, sign-in check, error mapping
  accounts.ts                 What a signed-in request may use
  review-service.ts           Review queue, the safe answer path, undo, practice, the schedule in charge
  analytics-service.ts        Review activity, weak words, the day's plan (read-only but for the goal)
  vocabulary-service.ts       List, create, edit, import, trash, restore
  library-service.ts          Collections, examples and links
  export-service.ts           The account export
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
| `GET /api/review-queue` | Due cards in order, with fields already filtered by mastery. `?focus=weak`, `overdue`, `due_today` or `recent`, or `?collection=<id>`, narrows it; none can add a word that is not due. |
| `POST /api/review-action` | `{ pageId, action, expected, requestId, sessionId?, durationMs?, confidence? }` → `applied`, `already_applied` or `dry_run`. `409` if the word changed. |
| `POST /api/practice` | `{ pageId, mode, answer, requestId, sessionId? }` → the verdict, and the word's practice mastery in that mode once the answer is counted. Judged on the server and recorded as practice; it cannot change mastery or a review date. |
| `GET /api/vocabulary/:id/practice-mastery` | One word's practice mastery in every mode, counted from its recorded practice answers. Read-only. |
| `POST /api/review-undo` | `{ reviewRequestId, requestId }` → the word's restored state. `409` if the answer is no longer the latest for that word. |
| `GET /api/sessions/:id/summary` | What was saved in one sitting. |
| `GET /api/analytics` | Review activity: periods, streak, by mode, per day, and how answers went at each confidence level. Read-only. |
| `GET /api/plan`, `PUT /api/goal` | Today's reviewing against the daily goal; storing the goal `{ reviews, minutes }`. |
| `GET /api/weak-words` | Words that need attention, with reasons. Read-only. |
| `GET /api/scheduler` | Which schedule is in charge, the FSRS comparison, and FSRS's recall estimate per word. Read-only. |
| `PUT /api/scheduler` | `{ scheduler: "mastery_v1" \| "fsrs" }`: puts one schedule in charge. Converts nothing. `409` where the database cannot keep the choice yet. |
| `GET /api/simulation` | `?retention=0.7…0.97` (the account's own when omitted). Replays saved answers through FSRS beside the live mastery schedule. Read-only; stores nothing. |
| `GET /api/review-days` | `?from=&to=` (at most 100 days): saved reviews per day, for the calendar. Read-only. |
| `GET /api/vocabulary` | Every word, with its review state. |
| `GET /api/vocabulary/:id` | One word, read fresh. |
| `POST /api/vocabulary` | Create a word. `409` with the existing entries if it is a duplicate. |
| `POST /api/vocabulary/import` | `{ items }`, up to 50 rows of content. Each is created as a new word, once per row id; duplicates and bad rows are reported per row. |
| `GET /api/export` | Everything the account can read about itself, in one JSON document. Read-only. |
| `PATCH /api/vocabulary/:id` | Edit named fields; `schedule` for mastery and review date. |
| `DELETE /api/vocabulary/:id` | Move a word to the trash. |
| `POST /api/vocabulary/:id/restore` | Take it back out. |
| `GET /api/trash` | Deleted words that can be restored. |
| `GET /api/library` | Collections with their words, further examples, and links between words, in one read. |
| `POST`, `PATCH`, `DELETE /api/collections[/:id]` | Create, rename, delete a collection. Deleting removes the collection and its memberships, never a word. |
| `PUT /api/collections/:id/words/:wordId` | `{ member }`: put a word in a collection or take it out. |
| `POST /api/vocabulary/:id/examples`, `PATCH`, `DELETE /api/examples/:id` | Further example sentences for a word. |
| `POST /api/relations`, `DELETE /api/relations/:id` | `{ fromId, toId, kind }`: link two of your words. Stored once per pair and kind. |
| `GET /api/settings`, `PUT /api/settings` | The account's time zone and FSRS target retention; the database version found. |

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
  recorded individually, so they are not in it, and review activity, streaks,
  weak words, FSRS and the what-if comparison can only see from then on.
- FSRS uses the library's default parameters. They are not fitted to your own
  history, and with a history this short they could not be.
- With FSRS in charge there are still two answer buttons, mastery still
  retires a word at 10, and a word FSRS has not seen stays on its mastery
  date. Those are choices made to change as little as possible; none is the
  only reasonable one.
- FSRS's recall estimate and the what-if comparison are a model's output. The
  app does not measure whether FSRS would make you remember more, and does not
  claim it.
- Only the latest answer can be undone, and only while nothing else has
  happened to that word since.
- Practice never moves a schedule, in any mode. Practice mastery is a count
  of correct answers, not a judgement of how well a word is known: it cannot
  go down, and three lucky recognitions score the same as three typed answers
  would in their own mode.
- Listening depends entirely on the browser's speech synthesis. It was checked
  for what the app asks the browser to say, in tests and in one desktop
  browser; nobody has judged what it sounds like across devices.
- Excel import reads `.xlsx` only (not the older `.xls`), and only the first
  sheet.
- Further examples are for reference: the flashcard and fill in the blank use
  the word's own example.

[docs/upgrade-plan.md](docs/upgrade-plan.md) lists what each stage built and
what it left out.

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
- **You want a copy of everything:** Settings → Export everything (JSON).
- **FSRS is in charge and you want the old behaviour back:** Settings →
  Scheduling → Go back to the mastery schedule. Nothing has to be restored;
  the mastery dates were kept up to date the whole time.
