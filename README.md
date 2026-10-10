# Vocabulary

A vocabulary learning app on top of an existing Notion database. Notion stays
the source of truth; this app reads from it and writes back to it.

| Tab | What it does |
| --- | --- |
| **Dashboard** | What is ready to review, summary counts, mastery distribution, additions over time, recent words. |
| **Review** | Flashcards: flip, then answer Remember or Not remember. Saves the same changes as the "Nhớ" and "Không nhớ" buttons in Notion. |
| **Add vocabulary** | Creates a new word in Notion, with a duplicate check. |
| **Vocabulary bank** | Every word: search, filter, sort, view details, edit, delete, export. |
| **Calendar** | Words by the day they were added. |
| **Insights** | Additions by day, week and month, share mastered, busiest days, incomplete entries. |
| **Settings** | Display preferences, backup export, connection status. |

Reference documents:

- [docs/database-schema.md](docs/database-schema.md) — the actual Notion schema and what each operation writes.
- [docs/review-logic.md](docs/review-logic.md) — the review rules and where each comes from.
- [docs/metrics.md](docs/metrics.md) — the exact definition of every number shown.

## Try it with sample data

Requires Node.js 24 (24.15 or newer).

```bash
npm install
```

```bash
npm run dev:mock
```

Open http://localhost:5174. This always uses a dozen built-in sample words kept
in memory and never contacts Notion, whatever is in `.env`. Adding, editing and
deleting all work and are forgotten when the server stops.

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

| Answer | Mastery | Review Date |
| --- | --- | --- |
| Remember ("Nhớ") | + 1, never above 10 | the day of the review + the **old** mastery in days |
| Not remember ("Không nhớ") | unchanged | the day after the review |

A review session survives switching tabs: come back and it is where you left
it. A finished session reloads the queue when you return.

## Connect it to Notion

### 1. Create a connection

1. In Notion open **Developer tools → Connections → New connection** (also
   reachable at https://www.notion.so/profile/integrations) and choose
   **API token**. OAuth is for apps other people sign in to.
2. Enable these capabilities and no others:

   | Capability | Needed for |
   | --- | --- |
   | Read content | Everything |
   | Update content | Reviewing, editing, deleting and restoring words |
   | Insert content | Adding vocabulary |

   Leave comments and user information off.
3. Give the connection access to the vocabulary database and nothing else:
   open the database as a full page, then `•••` → **Connections** → add it.
   Until this is done the API reports the database as "not found".

### 2. Configure

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
| --- | --- |
| `NOTION_API_KEY` | The connection's secret. Server-side only. |
| `NOTION_DATABASE_ID` | The 32-character id in the database URL. |
| `NOTION_DATA_SOURCE_ID` | Only if the database has more than one data source. |
| `REVIEW_TIMEZONE` | IANA zone deciding which day is "today", e.g. `Asia/Ho_Chi_Minh`. Required. |
| `REVIEW_WRITES_ENABLED` | `true` lets the app change Notion (reviews, new words, edits, deletes). Anything else makes it read-only. |
| `APP_ACCESS_PASSWORD` | Optional passphrase for the app. See "Keeping the app private". |
| `ALLOW_UNAUTHENTICATED_ACCESS` | `true` to run a deployed app with no passphrase. |

`.env` is git-ignored. The key is read only by the server; nothing in the
browser bundle contains it (Vite exposes only `VITE_`-prefixed variables, and
this project defines none).

This project uses Notion API version `2025-09-03`, in which rows live in a
*data source* inside a database. The server resolves the data source from the
database id automatically.

### 3. Check the schema

```bash
npm run notion:inspect
```

This is read-only. It prints every property with its type and formula, each
view's stored filter and sort, and whether the names in
`config/review.config.ts` match the database. It cannot show what Notion
buttons do; Notion does not expose button steps through its API.

### 4. Run it

```bash
npm run dev
```

Open http://localhost:5173. With `REVIEW_WRITES_ENABLED=false` every page works
but nothing can be changed; the pages say so. Set it to `true` to save.

## Adding vocabulary

- Only the word is required. Vietnamese meaning, definition, example sentences
  and date added are optional.
- A new word starts at **Mastery 1 with no review date**, as the database's own
  "New page" template does, so it is due for review immediately. Both values
  are shown under "Starting review settings" and can be changed per word.
- Date added defaults to today in `REVIEW_TIMEZONE`.
- Before saving, the word is compared with existing ones, ignoring case and
  spacing. A match shows the existing entry and asks whether to cancel or add
  it anyway. Nothing is merged or discarded automatically.
- **Quick add** reduces the form to word and meaning; Enter saves and returns
  the cursor to the word field. In the full form, Ctrl + Enter saves from any
  field.
- Success is shown only after Notion has confirmed the new record.

Duplicate detection is not atomic. Two devices adding the same word at the same
moment can both succeed; the bank will then show both.

## Vocabulary bank

- **Search** matches the word, meaning, definition and example,
  case-insensitively and on partial text.
- **Filters**: review status, mastery level, date added range, missing fields.
  One-click presets cover the common ones.
- **Sort** by word, date added, review date or mastery, either direction.
- **Views**: table or compact list. Results are paged.
- Filters, sorting and the open word are kept in the address, so a view can be
  bookmarked and the Back button works.
- **Details**: click a word to see everything stored about it, with a link to
  the page in Notion.
- **Edit**: only the fields you change are written. Mastery and the review date
  are in a separate "Review schedule" section and are left alone unless you
  open it.
- **Delete** asks for confirmation and moves the page to Notion's trash, where
  it can be restored for 30 days. An Undo appears right after.
- **Export** downloads all words as CSV or JSON. Exporting only reads.

## How it protects your data

- **Notion is read fresh for every review answer.** The browser's copy of
  mastery and due date is used only to detect that the record changed; it is
  never written.
- **Writes are limited to known properties**: Word, Vietnamese Meaning,
  Definition, Example Sentences, Date Added, Mastery and Review Date. A request
  naming anything else is rejected before Notion is contacted.
- **Only what changed is written.** Editing a definition cannot touch mastery
  or the review date.
- **An answer cannot be applied twice.** If a response is lost and you press
  Retry, the server sees the record already holds the result and writes
  nothing.
- **A word cannot be created twice by a repeated request.** Each submission
  carries an id; sending it again returns the record already made.
- **Every write is confirmed.** The app shows success only when Notion has
  returned the stored record.
- **Pages outside the vocabulary database are refused**, for reading, editing
  and deleting alike.
- **Nothing is hard-deleted.** Delete means Notion's trash.
- **Automated tests never contact Notion.** They run against hand-built
  payloads and in-memory stores.

The app never edits the database schema, formulas, views, buttons or templates,
and never bulk-updates records. The existing Notion views and buttons keep
working alongside it.

## Keeping the app private

A deployed copy can add, edit and trash words in your Notion database, so
decide deliberately who can reach it.

- **No protection** — set `ALLOW_UNAUTHENTICATED_ACCESS=true` and leave
  `APP_ACCESS_PASSWORD` empty. Anyone who has or guesses the address can use
  the app as you do. Requests from other websites are still refused, and
  deleted words remain recoverable from Notion's trash.
- **Built-in passphrase** — set `APP_ACCESS_PASSWORD`. You enter it once per
  device; the server issues an `HttpOnly`, `SameSite=Strict`, `Secure` cookie
  valid for 30 days. Requires HTTPS.
- **Platform access control** — Vercel Deployment Protection, Cloudflare
  Access, Tailscale or similar in front of the app, together with
  `ALLOW_UNAUTHENTICATED_ACCESS=true`.
- **Local only** — run it on your own machine and do not expose the port.

In production the server refuses to serve anything if neither a passphrase nor
the explicit opt-out is set, so an unprotected deployment is always a choice.

## Deploying

### Vercel

`vercel.json` builds the frontend with Vite, routes `/api/*` to one Node
function (`api/index.ts`) and serves the app for every other address so deep
links work.

1. In Vercel choose **Add New → Project** and import the GitHub repository.
   Keep the detected **Vite** preset and the default build settings.
2. Add environment variables (all environments): `NOTION_API_KEY`,
   `NOTION_DATABASE_ID`, `REVIEW_TIMEZONE`, `REVIEW_WRITES_ENABLED`, and either
   `APP_ACCESS_PASSWORD` or `ALLOW_UNAUTHENTICATED_ACCESS=true`. Mark the key
   as **Sensitive**.
3. Deploy, then open `/api/health` and confirm `"ok": true`.
4. Environment variable changes apply to new deployments only: **Deployments →
   ⋯ → Redeploy**. Every push to `main` also deploys.

To see the app working before connecting Notion, set `DATA_MODE=mock`.

### Self-hosted

```bash
npm run build
```

```bash
npm start
```

`npm start` serves the built frontend and the API from one Node process on
`PORT` (default 8787). Set `NODE_ENV=production` and the variables above in
the environment. Put it behind HTTPS if you use the passphrase.

### Opening it from Notion

Add the deployed URL to a Notion page as a **link or bookmark** (`/bookmark`)
and open it in the browser; on a phone, add it to the home screen. Embedding
the app inside a Notion page (`/embed`) is not recommended: browsers treat an
embedded site as third-party, so a passphrase cookie is not sent and keyboard
shortcuts only work after clicking inside the frame.

## Project layout

```
config/review.config.ts     Property names, review rules, new-word defaults
shared/                     Pure logic used by browser and server
  review-logic.ts             Eligibility, ordering, visibility, answers, reconciliation
  vocabulary-status.ts        A word's review state, from the same rules
  metrics.ts                  Dashboard, insights and calendar numbers
  dates.ts, text.ts           Calendar-day arithmetic; word normalisation and search
  api.ts                      Request/response schemas (Zod)
server/                     The only code that sees the Notion key
  create-app.ts               Routes, validation, access control, error mapping
  review-service.ts           Review queue and the safe answer path
  vocabulary-service.ts       List, create, edit, trash, restore
  notion/                     SDK wrapper, mappers, pagination, repository
  mock/                       Sample words and illustrative rules
  index.ts                    Node entry (self-hosting)
api/index.ts                Vercel entry
src/                        React interface
  App.tsx, app-context.tsx    Shell, routing, shared session and vocabulary
  pages/                      One file per tab
  components/                 Flashcard, charts, word panel, form fields, navigation
  lib/                        Router, API client, stores, bank query, export
  hooks/                      Keyboard shortcuts, swipe detection
scripts/inspect-notion.ts   Read-only schema and view inspection
tests/                      Vitest: logic, server, API, pages
docs/                       Schema, review logic, metric definitions
```

### API

| Route | Purpose |
| --- | --- |
| `GET /api/review-queue` | Due cards in order, with fields already filtered by mastery. |
| `POST /api/review-action` | `{ pageId, action, expected }` → `applied`, `already_applied` or `dry_run`. `409` if the record changed. |
| `GET /api/vocabulary` | Every word, with its review state. |
| `GET /api/vocabulary/:id` | One word, read fresh from Notion. |
| `POST /api/vocabulary` | Create a word. `409` with the existing entries if it is a duplicate. |
| `PATCH /api/vocabulary/:id` | Edit named fields; `schedule` for mastery and review date. |
| `DELETE /api/vocabulary/:id` | Move a word to Notion's trash. |
| `POST /api/vocabulary/:id/restore` | Take it back out. |
| `GET /api/health` | Configuration status. Public; contains no secrets or schema detail. |
| `POST /api/login`, `POST /api/logout` | Passphrase session, when one is configured. |

### How data stays in step

The browser keeps one copy of the vocabulary, shared by every tab, so moving
between tabs does not refetch the database. It is re-read in the background
when it is more than a minute old, after a review answer has been saved, and
on Refresh. A word that was just added, edited or deleted is updated in that
copy from the record Notion returned, so every tab shows it at once. Review
data is never cached between sessions.

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | The app on http://localhost:5173, using `.env` (real Notion if configured) |
| `npm run dev:mock` | The app on http://localhost:5174 with sample data only |
| `npm test` | All tests |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm run build` | Type-check, build frontend and server |
| `npm run notion:inspect` | Read-only look at the Notion schema and views |

## Limitations

- What the Notion buttons do cannot be read through Notion's API. The review
  rules come from the owner and match every stored row; two details are still
  open (docs/review-logic.md, section 10).
- The database has no part of speech, pronunciation, tags, topic, notes or
  similar properties, so the app has no fields for them.
- Text is edited as plain text. A field with formatting in Notion loses it if
  that field is changed in the app; the word panel warns when this applies.
- The whole vocabulary is loaded at once (about one Notion request per 100
  words) and searched in the browser. That is comfortable into the low
  thousands of words; beyond that it would need server-side search.
- Each review answer makes two Notion requests and waits for both.
- Words that share a review date may appear in a different order than in the
  Notion table.
- Duplicate detection can be beaten by two simultaneous submissions.
- Preferences are stored per browser, not synced.
- There are no user accounts. This is a single-owner tool.

## If something goes wrong

- **A word got the wrong value:** open the page in Notion → `•••` → **Version
  history** to see or restore earlier values (how far back depends on your
  Notion plan), or correct it by hand.
- **A word was deleted by mistake:** restore it from Notion's trash within 30
  days.
- **Adding fails with "not allowed to do this":** the connection lacks the
  *Insert content* capability.
- **You want to stop all changes immediately:** set
  `REVIEW_WRITES_ENABLED=false` and restart or redeploy, or remove the
  connection from the database in Notion.
- **The key may have leaked:** regenerate the connection's secret in Notion and
  update the environment variable.
- **The app is unavailable:** use Notion as before. Nothing about the original
  database, views or buttons has been changed.
