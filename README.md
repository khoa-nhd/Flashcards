# Vocabulary Review

A flashcard interface for an existing Notion vocabulary database. One word at a
time: flip it, answer **Remember** or **Not remember**, and the result is saved
back to Notion. Notion stays the source of truth; this app only replaces the
review screen.

> **Current state:** the app reads the real review queue from Notion, using the
> same rule and order as the "Need review" view. It is a **read-only preview**:
> it will not write until what the "Nhớ" and "Không nhớ" buttons do has been
> confirmed. See [docs/review-logic.md](docs/review-logic.md) for what has been
> verified and what is still needed.

## Try it now (sample data, no Notion)

Requires Node.js 24 (24.15 or newer).

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. With no Notion key configured the app serves a
dozen built-in sample words, marked **Sample data** in the header. Answers
change only an in-memory copy and use illustrative rules, not yours.

| Action | Keyboard | Touch |
| --- | --- | --- |
| Flip the card | `Space` | Tap the card |
| Not remember | `←` | Swipe left |
| Remember | `→` | Swipe right |

An answer is accepted only after the card has been flipped. The two buttons
under the card do the same as the keys and swipes.

## Connect it to Notion

### 1. Create a connection with the least access it needs

1. In Notion open **Developer tools → Connections → New connection** (also
   reachable at https://www.notion.so/profile/integrations) and choose
   **API token**. OAuth is for apps other people sign in to.
2. Under its capabilities, enable **Read content** and **Update content** only.
   Leave *Insert content*, comments and user information off. The app never
   creates pages, deletes anything, or changes the database schema.
3. Give the connection access to the vocabulary database and nothing else:
   open the database as a full page, then `•••` → **Connections** → add it.
   Until this is done the API reports the database as "not found".

### 2. Configure

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
| --- | --- |
| `NOTION_API_KEY` | The integration secret. Server-side only. |
| `NOTION_DATABASE_ID` | The 32-character id in the database URL. |
| `NOTION_DATA_SOURCE_ID` | Only if the database has more than one data source. |
| `REVIEW_TIMEZONE` | IANA zone deciding which day is "today", e.g. `Asia/Ho_Chi_Minh`. Required. |
| `REVIEW_WRITES_ENABLED` | Leave `false` until the queue has been verified. |
| `APP_ACCESS_PASSWORD` | Passphrase for the app. Required when deployed. |

`.env` is git-ignored. The key is read only by the server; nothing in the
browser bundle contains it (Vite exposes only `VITE_`-prefixed variables, and
this project defines none).

This project uses Notion API version `2025-09-03`, in which rows live in a
*data source* inside a database. The server resolves the data source from the
database id automatically.

### 3. Inspect the real schema

```bash
npm run notion:inspect
```

This is read-only. It prints every property with its type and formula, each
view's stored filter and sort, and whether the names in
`config/review.config.ts` match. It cannot show what the review buttons do;
Notion does not expose button steps through its API.

In Windows PowerShell, if `npm` is blocked by the script execution policy, use
`npm.cmd` instead (for example `npm.cmd run notion:inspect`).

### 4. Verify the queue in read-only mode

Run `npm run dev` with `REVIEW_WRITES_ENABLED=false`. The header shows
**Preview · not saving**. Compare the cards and their order with your Notion
Review view. In this mode each answer is still validated against the live
record, but nothing is written.

### 5. Enable saving

1. Fill in `remember` and `notRemember` in `config/review.config.ts` with the
   exact behaviour of your buttons.
2. Replace the "keeps writes locked" test in
   `tests/shared/review-config.test.ts` with before/after cases for your
   schedule, and run `npm test`.
3. Point the app at a **duplicate** of the database first (Notion: `•••` →
   Duplicate, then add the integration to the duplicate's Connections), set
   `REVIEW_WRITES_ENABLED=true`, and review a few cards. Compare each result
   with what the original buttons produce.
4. Switch `NOTION_DATABASE_ID` to the real database.

Until step 1 is done the server ignores `REVIEW_WRITES_ENABLED=true`.

## How it protects your data

- **Notion is read fresh for every answer.** The browser's copy of mastery and
  due date is used only to detect that the record changed; it is never written.
- **Writes are absolute values**, limited to the mastery and next-review
  properties, and only the ones that actually change.
- **An answer cannot be applied twice.** If a response is lost and you press
  Retry, the server sees the record already holds the result and writes
  nothing. See section 13 of the review-logic document.
- **A card changed in Notion mid-session is not overwritten.** You are told,
  and can skip it or reload.
- **The next card appears only after Notion confirms the save.** A failure
  keeps the card on screen.
- **The request body is validated and closed.** The action endpoint accepts a
  page id, one of two actions and the expected state; any other field is
  rejected. The page must be a live row of the configured database.
- **Automated tests never contact Notion.** They run against hand-built
  payloads and an in-memory store.

Nothing in this project deletes properties, edits the schema, bulk-updates
records, or touches your existing Notion buttons and views. They keep working
alongside the app and remain the fallback.

## Keeping the app private

A deployed copy can change your Notion data, so an unguessable URL is not
protection. Choose at least one:

- **Built-in passphrase** — set `APP_ACCESS_PASSWORD`. You enter it once per
  device; the server issues an `HttpOnly`, `SameSite=Strict`, `Secure` cookie
  valid for 30 days. Changing the passphrase signs every device out. Failed
  attempts are throttled, but the throttle is in memory, so use a long
  passphrase. Requires HTTPS, which Vercel provides.
- **Platform access control** — Vercel Deployment Protection, Cloudflare
  Access, Tailscale or similar, in front of the app. If you rely on this
  alone, set `ALLOW_UNAUTHENTICATED_ACCESS=true`.
- **Local only** — run it on your own machine and do not expose the port.

In production the server refuses to serve the queue if neither a passphrase
nor the explicit opt-out is configured.

## Deploying

### Vercel

`vercel.json` builds the frontend with Vite and routes `/api/*` to one Node
function (`api/index.ts`).

1. In Vercel choose **Add New → Project** and import the GitHub repository.
   Keep the detected **Vite** preset and the default build settings.
2. Before deploying, add environment variables (all environments):
   - `APP_ACCESS_PASSWORD` — a long passphrase. Without it the API answers
     `503` on purpose.
   - For a first deployment without Notion, `DATA_MODE` = `mock`. The app then
     serves the sample words, which proves the deployment works.
3. Deploy, then open `/api/health` and confirm `"ok": true`.
4. When the Notion steps above are done, remove `DATA_MODE` and add
   `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `REVIEW_TIMEZONE` and
   `REVIEW_WRITES_ENABLED` = `false`. Mark the key and the passphrase as
   **Sensitive**.
5. Environment variable changes apply to new deployments only: **Deployments →
   ⋯ → Redeploy**. Every push to `main` also deploys.

The build was run locally with the Vercel CLI (`vercel build`) and the function
it produced was loaded and called successfully. It has not yet been exercised
on Vercel's own infrastructure. If the function fails there, the self-hosted
build below is the fully tested path.

### Self-hosted (tested)

```bash
npm run build
```

```bash
npm start
```

`npm start` serves the built frontend and the API from one Node process on
`PORT` (default 8787). Set `NODE_ENV=production` and the variables above in
the environment. Put it behind HTTPS; the session cookie is `Secure`.

### Opening it from Notion

Add the deployed URL to your Review page as a **link or bookmark** (`/bookmark`)
and open it in the browser; on a phone, add it to the home screen. Embedding
the app inside a Notion page (`/embed`) is not recommended: browsers treat an
embedded site as third-party, so the sign-in cookie is not sent and keyboard
shortcuts only work after clicking inside the frame.

## Project layout

```
config/review.config.ts   Property names and review rules for YOUR database
shared/                   Pure logic used by browser and server
  review-logic.ts           Eligibility, ordering, visibility, actions, reconciliation
  dates.ts                  Calendar-date arithmetic and time zones
  api.ts                    Request/response schemas (Zod)
server/                   The only code that sees the Notion key
  create-app.ts             Routes, validation, access control, error mapping
  review-service.ts         Queue building and the safe write path
  notion/                   SDK wrapper, mappers, pagination, repository
  mock/                     Sample words and illustrative rules
  index.ts                  Node entry (self-hosting)
api/index.ts              Vercel entry
src/                      React interface
  lib/session-machine.ts    Session state machine (pure)
  lib/session-controller.ts Loading and saving around the machine
  hooks/                    Keyboard shortcuts, swipe detection
  components/               Flashcard, controls, progress, screens
scripts/inspect-notion.ts Read-only schema and view inspection
tests/                    Vitest: logic, server, API, interaction
docs/review-logic.md      The review behaviour and its open questions
```

### API

| Route | Purpose |
| --- | --- |
| `GET /api/review-queue` | Due cards in order, with fields already filtered by mastery. |
| `POST /api/review-action` | `{ pageId, action, expected }` → `applied`, `already_applied` or `dry_run`. `409` if the record changed. |
| `GET /api/health` | Configuration status. Public; contains no secrets or schema detail. |
| `POST /api/login`, `POST /api/logout` | Passphrase session. |

### Session states

`loading` → `ready` (front) ⇄ `flipped` → `saving` → `ready` (next card) or
`completed`. A failed save goes to `error`, from which you can retry or return
to the card. Events that are not valid in the current state are ignored, which
is what prevents double submission and answering an unflipped card.

Swipe distance and tap tolerance are set in `src/config.ts`.

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Frontend and API on http://localhost:5173 |
| `npm test` | All tests |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm run build` | Type-check, build frontend and server |
| `npm run notion:inspect` | Read-only look at the Notion schema and views |

## Limitations

- The review rules for your database are not configured yet, so against Notion
  the app is a read-only preview.
- Each answer makes two Notion requests (read, then write) and waits for both,
  so advancing takes roughly as long as Notion takes to respond.
- Dates are written as date-only values, which is how every review date in
  the database is stored today.
- Words that share a review date may appear in a different order than in the
  Notion table.
- A session is a snapshot. Words that become due, or that are edited in
  Notion, appear after Refresh.
- Notion allows about three requests per second. The SDK retries rate-limited
  requests automatically; a very large backlog of due words loads in pages of
  100.
- There is one shared passphrase and no user accounts. This is a single-owner
  tool.

## If something goes wrong

- **A card got the wrong mastery or date:** open the page in Notion → `•••` →
  **Version history** to see or restore the earlier values (how far back it
  goes depends on your Notion plan), or correct the two properties by hand.
  The app changes nothing else.
- **You want to stop all writes immediately:** set
  `REVIEW_WRITES_ENABLED=false` and restart, or remove the integration from
  the database's Connections in Notion.
- **The key may have leaked:** regenerate the integration secret in Notion and
  update the environment variable.
- **The app is unavailable:** review in Notion as before. Nothing about the
  original workflow has been changed.
