# Moving from Notion to Supabase

This is the runbook for the migration: what is done, what is left, and the
exact steps. For how the Supabase side works, see
[supabase-schema.md](supabase-schema.md).

## Where things stand

**Notion is still the live data source and nothing about it has been changed
or removed.** The Supabase backend is built and tested, but it is switched off
until a Supabase project exists and the checks below pass.

The app picks its data source from `DATA_MODE`, and only from that:

| `DATA_MODE` | Data | Sign-in |
| --- | --- | --- |
| `notion` (today's production) | The Notion database | None / shared passphrase, as before |
| `supabase` | Supabase PostgreSQL | An account per person |
| `mock` | Built-in sample words | None |

There is no automatic fallback in either direction. In `supabase` mode an
incomplete configuration answers `503` with the reason; it never reads Notion
instead.

## The gate

The Notion code may be removed only when every line is ticked.

| # | Condition | Status |
| --- | --- | --- |
| 1 | A Supabase project exists and the migration SQL is applied | **Not done** — needs you (step 1–2) |
| 2 | Sign-in is configured and works | **Not done** — needs the project (step 3–4) |
| 3 | RLS is enabled and tested | Tested locally on real PostgreSQL; **live check not done** (step 5) |
| 4 | The Notion data is imported and reconciles field by field | Proven locally with the real export; **live import not done** (step 6–7) |
| 5 | Review state is preserved | Proven locally with the real export; confirmed live by step 7 |
| 6 | The app reads and writes the migrated data | Proven locally; **live not done** (step 8) |
| 7 | Functionality is tested against Supabase | Local: yes. **Live: not done** (step 8) |
| 8 | A recoverable backup exists | Yes: `backups/notion-export-*.json` on this machine, plus the untouched Notion database |

## What you need

- A Supabase account (the free plan is enough to start).
- About 20 minutes.
- Nothing has to be pasted into source code. Two values go into `.env` and
  into Vercel; both are public by design.

## Steps

### 1. Create the Supabase project

1. https://supabase.com/dashboard → **New project**. Pick a region close to
   you (Singapore for Vietnam). Choose a database password and keep it
   somewhere safe; the app never needs it.
2. Wait until the project is ready.

### 2. Create the tables

Dashboard → **SQL Editor** → **New query**. Paste the whole contents of
[supabase/migrations/20261010090000_initial_schema.sql](../supabase/migrations/20261010090000_initial_schema.sql)
and press **Run**. It should finish with "Success. No rows returned".

It only creates new objects in the `public` schema. Run it once; running it a
second time fails with "already exists" and changes nothing.

(With the Supabase CLI instead: `npx supabase link --project-ref <ref>` then
`npx supabase db push`.)

### 3. Configure sign-in

Dashboard → **Authentication**:

- **Sign In / Providers → Email**: enabled (it is by default). Leave "Confirm
  email" on unless you have a reason not to.
- **URL Configuration**: set **Site URL** to your production address
  (`https://<your-app>.vercel.app`), and add `http://localhost:5173` under
  **Redirect URLs**. Confirmation and password-reset links return to these.

### 4. Point a local copy at the project

Dashboard → **Project Settings → API** (or the **Connect** button). Copy the
**Project URL** and the **anon / publishable** key.

> Do **not** copy the `service_role` / secret key. The app has no use for it
> and refuses to start if it is given one.

In `.env` add:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<the anon or publishable key>
DATA_MODE=supabase
```

Then:

```bash
npm run dev
```

Open http://localhost:5173, choose **Create an account**, use the email
address you want to own your vocabulary, and confirm it from the email. You
should arrive in an empty app. (Your deployed app is unaffected: it still uses
Notion.)

### 5. Check the live project's security

Create two **throwaway** accounts (Dashboard → Authentication → Users → **Add
user**, with "Auto Confirm User" ticked). Then:

```bash
npm run supabase:verify
```

It asks for the two accounts' emails and passwords (or reads
`VERIFY_A_EMAIL`, `VERIFY_A_PASSWORD`, `VERIFY_B_EMAIL`, `VERIFY_B_PASSWORD`).
It must end with:

```
RESULT: isolation, idempotent saving and append-only history hold on this project.
```

It creates one marker word in account A and leaves it in A's trash, because
nothing can remove a row outright. It touches no other data. **If any line
says FAIL, stop here.**

### 6. Freeze Notion and take the final export

Reviews made in Notion after the export would be missing from Supabase, so
stop changes first:

1. In Vercel set `REVIEW_WRITES_ENABLED=false` and redeploy. The deployed app
   becomes read-only. Do not use the buttons in Notion either until the
   switch is done.
2. Leave `.env` as it is. The export always reads Notion, whatever
   `DATA_MODE` says, and it only reads.

```bash
npm run notion:export
```

It writes `backups/notion-export-<time>.json` and prints the word count, a
checksum and the count at each mastery level. The file is git-ignored; it is
your backup, keep it.

### 7. Import and reconcile

Dry run first. It changes nothing:

```bash
npm run supabase:import
```

It asks for the owner account's email and password (or reads
`MIGRATION_EMAIL` / `MIGRATION_PASSWORD`), and prints what it would create.
Then:

```bash
npm run supabase:import -- --apply
```

It must end with:

```
RESULT: every word in the backup is in the account with identical values.
```

That line is printed only when every word in the file is in the account and
word, meaning, definition, example, mastery, review date, date added and
creation time all match. Anything else is listed line by line, and nothing is
overwritten. The import is safe to run again: words already imported are left
alone.

What is carried over: every word with its text, mastery, review date, date
added and original creation time, and the time zone. What is not: individual
past reviews (Notion never recorded them, so the history starts empty) and
Notion page formatting (the current export reports that none of your text
uses any).

### 8. Check the app on the migrated data

With `DATA_MODE=supabase` in `.env`, `npm run dev`, sign in as the owner and
check:

- Dashboard and bank show the same number of words as Notion.
- The Review tab offers the cards you expect; answer one each way and confirm
  the new mastery and date in the bank.
- Add a word, edit it, delete it, restore it from Settings → Deleted words.
- Sign in on a second browser or your phone (against the same local server, or
  after step 9): the same data is there; a card answered on one is refused as
  stale on the other.

### 9. Switch production

In Vercel → Project → Settings → Environment Variables:

| Variable | Value |
| --- | --- |
| `DATA_MODE` | `supabase` |
| `SUPABASE_URL` | the project URL |
| `SUPABASE_ANON_KEY` | the anon / publishable key |
| `REVIEW_WRITES_ENABLED` | remove it, or `true` |

Leave the `NOTION_*` variables in place for now (they are ignored in this
mode, and keep rollback one setting away). Redeploy, then open `/api/health`:
it should report `"mode":"supabase"`, `"access":"account"`, `"ok":true`.

### 10. Remove Notion from the code

After you have used the app on Supabase long enough to trust it, ask for the
final cutover. It is one commit that:

- deletes `server/notion/`, `scripts/inspect-notion.ts`,
  `scripts/export-notion.ts`, the Notion tests and fixtures;
- removes `@notionhq/client` from `package.json`;
- removes the `notion` data mode, the `NOTION_*` settings, the shared
  passphrase gate (`APP_ACCESS_PASSWORD`, `/api/login`) and the Notion wording
  still shown in Notion mode;
- renames the leftover names (`pageId`, the "Notion URL" export column,
  `notionProperties`);
- rewrites the README around Supabase;
- adds a test that fails if the word "notion" reappears in the app's code or
  dependencies.

Then, in your own time: delete the `NOTION_*` variables from Vercel and `.env`
and remove the connection from the Notion database. **Keep the Notion
database itself.** Nothing in this migration deletes it, and it is your
second backup.

## Rolling back

Before step 10, going back is a setting:

1. In Vercel set `DATA_MODE=notion` and `REVIEW_WRITES_ENABLED=true`, redeploy.
2. The app is exactly what it was. Notion was never modified by the migration.

Reviews and words saved in Supabase in between are **not** copied back to
Notion; there is no reverse sync. They stay in Supabase and can be exported
from Settings → Backup. If you roll back after real use, you choose between
re-doing those reviews in Notion or switching forward again.

After step 10, rolling back means reverting that commit and redeploying with
the Notion variables, which is why it waits until you are sure.

## Backups from now on

- `backups/notion-export-*.json`: the pre-migration state. Keep at least the
  final one.
- Settings → Backup in the app: CSV or JSON of everything, any time.
- Supabase's own backups depend on your plan. On the free plan, check the
  current terms: projects that go unused are paused, and automatic backups are
  a paid feature. A monthly JSON export from Settings is a cheap safeguard.

## Verified, and not verified

Verified here, with actual runs:

- The migration SQL applies cleanly to a real PostgreSQL, and its RLS,
  privileges and functions behave as documented (39 tests).
- The full HTTP API in Supabase mode, with two accounts and two devices,
  against that database (62 tests).
- The real export (49 words) imports with every field identical, and the app
  then serves the same review queue, card contents and statuses that the rules
  give for the original data (in `tests/server/backup-import.test.ts`).
- Two exports taken 40 minutes apart have the same checksum.
- Notion mode and sample-data mode behave as before (the existing suite).
- In a real browser: sample-data mode end to end, and the sign-in screen in
  Supabase mode against a placeholder address.

Not verified, because no Supabase project exists yet:

- Anything against hosted Supabase: the SDK calls in
  `server/supabase/supabase-database.ts` and `src/lib/supabase-auth.ts`, real
  sign-up / confirmation / password-reset emails, token renewal over time.
  Steps 4, 5 and 8 are those tests.
- The live import and its reconciliation (step 7).
- Production deployment in Supabase mode (step 9).
