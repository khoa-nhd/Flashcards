# Import, export and backup

Three different things, often confused:

| | What it is | What it is for |
| --- | --- | --- |
| **Import** | Adds new words from a list you supply. | Bringing vocabulary in from a spreadsheet, a file or notes. |
| **Export** | A file with everything your account can read about itself. | A copy to keep, to read elsewhere, or to move words to another account. |
| **Database backup** | A copy of the whole database, made in Supabase. | Recovering from a disaster. Only the project owner can make or restore one. |

An export is **not** a database backup: see [Backup and recovery](#backup-and-recovery).

## Import

Add vocabulary → **Import a list** (`/import`). Nothing is added until the
last step.

1. **The list.** Paste text or choose a file (`.csv`, `.tsv`, `.txt`, `.json`
   or `.xlsx`, up to 5 MB). The file is read in your browser; nothing is
   uploaded yet.
2. **Which column is which.** The app reads the text and guesses the columns.
   You can correct every guess.
3. **Check and confirm.** Every row is shown with what importing would do to
   it. Only then does **Import N words** send anything.
4. **Report.** How many were imported, left out, and refused, with reasons.

### What can be read

| Source | How it is recognised |
| --- | --- |
| Delimited text (CSV and relatives) | A comma, tab, semicolon or vertical bar that splits the rows into the same number of cells. Cells may be wrapped in double quotes, inside which the delimiter, line breaks and doubled quotes (`""`) are literal (RFC 4180). |
| A plain list | No delimiter fits: one word per line, the line taken whole. |
| This app's own exports | The CSV and JSON from the Vocabulary bank and Settings, and the full export described below. |
| An Excel workbook | A file named `.xlsx`. The **first sheet** is read, and the others are named on screen as not read. Text is taken as written, numbers as plain numbers, and a date cell as its calendar day (`YYYY-MM-DD`). Empty rows are dropped. From there it is treated exactly like any other list: the same heading check, column mapping, checks and confirmation. |

Not read: the older `.xls` format (the page says so and suggests saving as
`.xlsx` or CSV), and sheets after the first. A file named `.xlsx` that is not a
workbook is refused with a message, and nothing from it is shown.

The workbook is unpacked on the device by the `read-excel-file` library (MIT),
pinned to one exact version and loaded only when a spreadsheet is chosen. It
never reaches the server: what the server receives is the same rows of text an
import from CSV sends.

Columns are matched by their heading when the first row is one (`Word`,
`Vietnamese Meaning` / `Meaning`, `Definition`, `Example Sentences` /
`Example`, `Date Added`). Without headings the usual order is assumed: word,
meaning, definition, example.

### What is imported, and what is not

Only a word's **content**: the word, its meaning, definition, example and the
date it was added (`YYYY-MM-DD`).

**A mastery level or review date in the file is never read.** An imported
word starts exactly as one added by hand does: at the starting mastery, with
no review date, no review history and no FSRS state. No learning progress is
ever made up from a file. Rows that try to supply a mastery, a review date or
an id are refused by the server.

### Checks

| Status | Meaning | What happens |
| --- | --- | --- |
| New | No word like it exists. | Imported. |
| Already in your vocabulary | The same word exists. | Left out unless you tick it. |
| Repeated in this list | The same word appears on an earlier line. | Left out unless you tick it. |
| Cannot be imported | No word, a value that is too long, or a date not written `YYYY-MM-DD`. | Never imported; the reason is shown. |

**"The same word"** means: equal after trimming, collapsing inner spaces,
Unicode normalisation (NFC) and ignoring letter case. The spelling in your
file is kept as written. Similar words (`candid` and `candidly`) are different
words.

**Nothing is merged.** A duplicate is only pointed out, with the word it
matches. Ticking it adds it as a separate word; the existing word, its
meaning, its mastery and its history are not touched either way.

### How it is sent

Confirmed rows go in requests of up to 25 rows (the server accepts 50), one
after another. Each row is created through the same path as the Add form:
same validation, same defaults, same duplicate check.

- Each row carries its own id. Sending the same rows again, after a lost
  connection or from another device, imports nothing twice.
- Rows are judged one by one, so a bad row costs only itself.
- It is a batch, not one transaction. If the database fails part-way, the
  report says how many were imported and offers to send the rest; the words
  already imported stay.
- At most 2,000 rows at a time.

## Export

| Where | What | Format |
| --- | --- | --- |
| Vocabulary bank, Settings → Backup | Your words with mastery and dates. | CSV, JSON |
| Settings → Backup → **Export everything** | Everything below. | JSON |

Every export only reads. All of them contain your own account's data and
nothing else: the server reads through the same per-account access as the rest
of the app, so the database refuses anything that is not yours.

### The full export

`GET /api/export`. Types: [`shared/export-format.ts`](../shared/export-format.ts).

```json
{
  "format": "vocabulary-flashcards-export",
  "version": 1,
  "exportedAt": "2026-10-11T03:00:00.000Z",
  "settings": { "timeZone": "Asia/Ho_Chi_Minh", "dailyGoal": { "reviews": 20, "minutes": null }, "fsrsRequestRetention": 0.9, "scheduler": "mastery_v1" },
  "counts": { "words": 49, "wordsInTrash": 1, "collections": 2, "examples": 3, "relations": 4, "historyEvents": 120 },
  "vocabulary": [],
  "collections": [],
  "examples": [],
  "relations": [],
  "reviewHistory": []
}
```

| Section | One entry per | Fields |
| --- | --- | --- |
| `vocabulary` | word, the trash included | `id`, `word`, `meaning`, `definition`, `example`, `dateAdded`, `createdAt`, `updatedAt`, `mastery`, `reviewDate` (the mastery schedule, as stored), `fsrs` (the FSRS state kept beside it, or `null` for a word not answered since FSRS started being calculated), `inTrash`, `senses` (every sense: its `id`, `position`, `meaning`, `definition`, `example`, `archived` flag and `version`; an empty array for an export made before this field existed) |
| `collections` | collection | `id`, `name`, `wordIds` |
| `examples` | further example | `id`, `vocabularyId`, `sentence`, `source`, `preferred` |
| `relations` | link between two words | `id`, `kind`, `a`, `b` (order carries no meaning) |
| `reviewHistory` | recorded event, oldest first | `id`, `vocabularyId`, `kind` (`review`, `undo`, `practice`), `action`, `mode`, `reviewedAt`, `reviewedOn`, `durationMs`, `masteryBefore`, `masteryAfter`, `reviewDateBefore`, `reviewDateAfter`, `sessionId`, `undoesId`, `scheduler`, `rating`, `confidence`, `answerCorrect`, `submittedAnswer`, `grading` |

- `settings.scheduler` says which of a word's two schedules decides when it is
  due: `mastery_v1` or `fsrs`. Both `reviewDate` and `fsrs` are exported as
  stored whichever it is, so the export does not depend on the choice. Each
  history event's `scheduler` says which was in charge when it was saved.
- The history is exactly as recorded: an undone answer appears as the answer
  and the `undo` that took it back. To get the answers that still stand, drop
  every `review` that an `undo` names in `undoesId`.
- Collections, examples and links of a word in the trash are not listed until
  the word is restored.
- A field the database is too old to hold is `null` (for example `confidence`
  before database version 5).
- `version` goes up whenever a field is renamed or removed.

### What an export does not contain

- Any other account's data.
- Your sign-in details: no email, password or token.
- The requests ids that make retries safe, or internal bookkeeping.

### Moving words to another account

Export from the first account, sign in to the second, and import the file.
The words arrive with their content; **mastery, review dates and history stay
behind**, and the app has no way to load them from a file. This is deliberate:
a review history that was typed in from a file would not be a record of
reviews.

A word that carries several senses arrives **with all of them**: the import
reads the `senses` field of this app's own JSON export and rebuilds every
sense in order, keeping each archive state, so the profile looks the way it
did at the source. When `senses` is present it is the word's content — the
file's meaning, definition and example beside it are not stored on top, so
nothing is written twice. Two rules hold throughout: a row whose senses
cannot be stored (the database has not had the newest migration, or the file
is malformed) is refused whole rather than imported stripped of them, and
nothing that already exists is changed — sending the same file twice lands
on the same words and senses instead of making them again.

A CSV file, or a JSON export made before senses existed, carries only the
word's shown meaning: one sense comes back, built from the file's meaning,
definition and example. The full JSON export lists every sense, so that is
the file to use for a restore.

This is a **vocabulary-content restore**, not a full-account recovery: words
and their senses come back, starting at the mastery of a newly added word.
Schedules, review history, collections, the goal and every other setting stay
behind — see "Backup and recovery" below for what covers those, which is a
database backup of the whole project, not this file.

## Backup and recovery

This is for the project owner. A user's export does not replace it.

**What a database backup has that an export does not:** every account, the
sign-in records (`auth.users`), the request ids, and the exact rows, so that a
restored database carries on as if nothing had happened.

### Making a backup

Backups are made with Supabase's own tools, not by this app, which holds no
database credentials on purpose.

- **Supabase's own backups.** Look under Dashboard → Database → Backups for
  what your plan keeps. Do not assume there are any: check.
- **Your own dump.** Supabase documents how to dump and restore a project
  with its CLI or with `pg_dump` ("Backup and Restore using the CLI" in the
  Supabase docs). Follow the current version of those instructions rather than
  a command copied from here: the details change, and none of them has been
  tried against this project.

Whichever you use:

- Keep the file somewhere private. It contains every account's data.
- The database password and connection string are secrets. They must never be
  put in this project, in `.env` on a server that serves the app, or in Vercel.
  The app needs only the project URL and the public key.
- **Try a restore once**, into a throwaway project, before you need one. A
  backup that has never been restored is a hope, not a backup. This has not
  been done for this project.

Take a backup before running any new file from `supabase/migrations`, and on
a schedule that matches how much reviewing you could bear to lose.

### Recovering

| What went wrong | What to do |
| --- | --- |
| A word was deleted | Settings → Deleted words → Restore. Nothing is ever removed outright. |
| An answer was wrong | Undo, if it is still the latest for that word; otherwise correct the word's schedule under "Review schedule". The history keeps both. |
| A collection was deleted | Create it again and add the words: the words themselves were never touched. An earlier full export lists which words were in it. |
| The database is lost or corrupted | Restore the latest database backup with Supabase's tools (into the same project, or a new one). If it is a new project, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to its address and public key and redeploy. |
| There is no database backup, only exports | Create a new project, run every file in `supabase/migrations` in order, create your account, and import the export. You get your words back as new words; schedules and history cannot be rebuilt by the app. |

The last row is why an export is not a backup.
