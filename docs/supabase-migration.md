# The move from Notion to Supabase

A record of how the app's data moved from a Notion database to Supabase on
2026-10-10, what was checked, and what is left for the owner. For how the
Supabase side works, see [supabase-schema.md](supabase-schema.md).

## Outcome

- The app keeps all vocabulary in Supabase, with an account per person.
- The Notion integration is gone from the code: its backend, its SDK, its
  settings, its scripts, the shared-passphrase gate that protected it, and
  every mention of it in the interface. `tests/no-notion.test.ts` fails if any
  of it comes back.
- **The Notion database itself was never modified and is not deleted.** It
  holds the vocabulary as it was at the moment of the export, and remains a
  second backup for as long as the owner keeps it.

## What was done, in order

| Step | Done by | Result |
| --- | --- | --- |
| Supabase backend built behind a switch, Notion still live | Development | Schema, accounts, API and tests; nothing changed for the running app |
| Read-only export of every Notion row to `backups/` | Development | 49 words; three exports hours apart had the same checksum |
| Supabase project created; migration SQL run | Owner | Confirmed from outside: all tables exist and refuse signed-out visitors |
| Owner's account created and signed in locally | Owner | Empty app shown under the owner's account |
| Import of the export into that account | Owner (`supabase:import --apply`) | Owner reported 49 words in the app |
| Security check with a second account | Owner (`supabase:verify`) | Owner reported it done |
| Production switched to Supabase on Vercel | Owner | Owner reported the deployed app working |
| Notion code removed | Development, at the owner's request | This repository as it is now |

## What was verified, and how

Verified by development, with actual runs:

- The migration SQL applies cleanly to a real PostgreSQL, and its Row Level
  Security, privileges and functions behave as documented
  (`tests/database/schema.test.ts`).
- The whole HTTP API on that database, with two accounts and two devices
  (`tests/server/supabase-api.test.ts`).
- **The real export imports with every field identical**, and the app then
  serves the same review queue, card contents and statuses that the rules give
  for the original data (`tests/server/backup-import.test.ts`, which uses the
  real export file when it is present on the machine).
- Token verification, including forged, expired and malformed tokens
  (`tests/server/supabase-verifier.test.ts`).
- Against the live project, from outside and without signing in: the project
  answers, accepts the public key, and refuses a signed-out visitor on every
  table.
- In a real browser: the sample-data app end to end, and the sign-in screen
  against the live project.

Reported by the owner, not seen by development:

- The final line of the import (`RESULT: every word in the backup is in the
  account with identical values.`).
- The final line of the security check (`RESULT: isolation, idempotent saving
  and append-only history hold on this project.`).
- That the deployed app shows the 49 words and works.

Development cannot read the owner's rows (that is what Row Level Security is
for) and never had the owner's password, so these could only be confirmed by
the owner. Both checks can be repeated at any time; see below.

Not carried over, by design:

- **Individual past reviews.** Notion kept only the current mastery and review
  date of each word, so there was no history to bring. The review history in
  Supabase starts on 2026-10-10.
- **Text formatting.** The export reported that none of the text used any.

## Repeating the checks

Both commands only need the project's public settings in `.env` and ask for
account details on the terminal. Neither can overwrite anything.

Compare the account with the export, field by field (a dry run; changes
nothing):

```bash
npm run supabase:import
```

Words reviewed or edited since the import are listed as `DIFFERENT`. That is
correct: they have moved on since the export. `missing from the account`
should be `0`.

Check isolation on the live project:

```bash
npm run supabase:verify
```

Account A must be a throwaway (one marker word is left in its trash); account
B can be your own, and nothing in it is created or changed. It must end with
`RESULT: isolation, idempotent saving and append-only history hold on this
project.`

## Backups

- `backups/notion-export-*.json` on the owner's machine: the vocabulary as it
  was at the move. Git-ignored; keep at least one copy somewhere safe.
- The Notion database: untouched, a second copy of the same state.
- From now on: **Settings → Backup → Export JSON** in the app, whenever you
  like. Supabase's own backups depend on the plan; on the free plan, check the
  current terms, because unused projects are paused and automatic backups are
  a paid feature.

To restore the pre-move state into an account that has lost words, run the
import with `--apply`: it creates only what is missing and overwrites nothing.

## Going back

The Notion backend no longer exists in the code, so there is no setting that
switches back. Going back would mean checking out the commit before the
removal (`git log` shows it as "Remove the Notion integration") and deploying
that with the old settings. Reviews made in Supabase since the move would not
be in Notion; there was never a reverse sync.

## Left for the owner

None of these is urgent, and none can be done from the code.

1. Delete the `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `NOTION_DATA_SOURCE_ID`,
   `APP_ACCESS_PASSWORD` and `ALLOW_UNAUTHENTICATED_ACCESS` variables from
   Vercel and from the local `.env`. They are ignored now.
2. In Notion, remove the connection from the vocabulary database (or delete
   the integration) so its secret stops working.
3. Keep the Notion database for as long as you want a second backup. Do not
   review with its buttons any more: nothing there reaches the app.
4. Decide whether strangers may create accounts: Supabase → Authentication →
   Sign In / Providers → **Allow new users to sign up**.
