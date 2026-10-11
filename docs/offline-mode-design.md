# Offline mode: a design note

**Status: not built.** The app needs a connection for everything. With no
connection the queue cannot load, and an answer that cannot be sent stays on
screen with *Try again* until it can. Nothing is kept on the device between
visits except display preferences. This note is what building offline review
would take; none of it exists.

## What "offline" would have to mean

Review the cards that were due when the device last had a connection, without
one, and have every answer saved exactly once when it returns. Adding,
editing, importing and practice stay online-only: they are not what gets done
on a train, and each would bring its own conflicts.

It must never mean an answer that looks saved and is not. That is the failure
this design is built around.

## What is already in place

| Needed for offline | Present today |
| --- | --- |
| An answer can be sent twice safely | Yes. Every answer carries a request id made in the browser; the database saves it once and answers a repeat with the first result. |
| A stale answer cannot overwrite a newer one | Yes. An answer names the state it was given against (mastery and review date); the database refuses it if the word has moved on (`409`, with the current state). |
| Every answer is its own record | Yes. The history is append-only. |
| The reviewer's own day is recorded | Partly. The server stamps the day from its own clock when the answer arrives. Offline, that is the wrong day (see below). |

## What would have to be built

### 1. Local storage

IndexedDB, in one database per signed-in account (named with the account id),
holding:

- **The queue as last loaded**: the cards, and the "today" and time zone they
  were loaded for.
- **The outbox**: answers given and not yet confirmed by the server.

This puts vocabulary on the device, unencrypted, where today nothing is. It
must be cleared on sign-out and never read by another account on the same
browser. On a shared computer that is a real change in what the app leaves
behind, and it should be something the owner switches on, not a default.

### 2. An outbox of pending answers

One entry per answer: the request id, the word, the answer, the state it was
given against, the time on the card, the session id, the confidence rating if
any, **and the moment it was answered** (instant and the reviewer's calendar
day). Entries are sent oldest first, one at a time. An entry leaves the outbox
only when the server has confirmed it or definitively refused it.

A card answered offline leaves the local queue, as it does online. It is not
offered again on that device until the outbox has drained and the queue has
been reloaded.

### 3. The answer's own date

This is the part that needs a server change, and the reason offline is not
just a client feature.

Today the server works out the result from *its* "today": Remember at mastery
3 means "due three days after the day the answer arrived". An answer given on
Monday and synced on Wednesday would be scheduled from Wednesday, recorded as
reviewed on Wednesday, and counted in Wednesday's statistics and streak. FSRS
would likewise be told the review happened on Wednesday.

So the request needs an optional `answeredAt`, and the server has to:

- accept it only within limits (not in the future beyond a small clock
  tolerance; not older than a set number of days, after which the entry is
  refused and shown to the reviewer rather than applied);
- use it, instead of its own clock, for the result, the recorded day and the
  FSRS calculation;
- still check that the word was due on that day.

That changes `ReviewService.submitAction`, `record_review` and their tests.
The rules themselves (`shared/review-logic.ts`) do not change: they already
take the day as an argument.

### 4. Idempotent synchronisation

Sending an outbox entry is the request the app already makes, with the same
request id every time it is tried. The outcomes, all of which exist today:

| Server says | Meaning | Outbox entry |
| --- | --- | --- |
| `applied` or `already_applied` | Saved, now or on an earlier try | Removed |
| `409` with the current state | The word changed since the card was loaded | Removed, and listed for the reviewer (see 5) |
| `404` | The word is gone | Removed, and listed |
| `401` | The session has expired | Kept; syncing stops until sign-in |
| Network error, timeout, `5xx` | Unknown | Kept; tried again later, with growing waits |

A `dry_run` reply (saving switched off on the server) must not be treated as
saved: the entry is removed and the reviewer is told nothing was recorded.

### 5. Conflicts between devices

The existing rule stays, unchanged: **an answer given against a state the word
no longer has is not applied.** There is no "keep mine". Forcing a stale
answer through would count one sitting twice, which is exactly what the state
check exists to prevent.

So a refused entry is not an error to resolve but a fact to report: "3 answers
given offline were not saved, because those words were reviewed on another
device first", with the words named. They reappear in the queue if they are
still due.

Two answers to the same word in one offline sitting cannot happen: the card
leaves the queue after the first.

### 6. Undo

Undo offline would mean removing an entry from the outbox before it is sent,
which is safe, and nothing more. Undoing an answer that has already been
synced still needs the server.

### 7. Sign-in and sessions

- The access token is short-lived and is refreshed online. Offline, it will
  expire; syncing then waits for the reviewer to be signed in again. Outbox
  entries are kept across that.
- Entries are only ever sent as the account they were recorded under. If a
  different account signs in on the browser, the previous account's database
  is left alone (and can be cleared), never merged.
- Signing out with a non-empty outbox asks first: syncing needs the session
  that is about to end.
- No password, token or key is stored by this feature. The session stays where
  the Supabase client already keeps it.

### 8. Saying what has not been saved

- A count of pending answers, always visible while it is not zero, in words:
  "4 answers waiting to be saved".
- The completion screen separates "saved" from "waiting to be saved". Today's
  rule, that nothing unsaved is counted as saved, carries over.
- The summary, statistics, streak and goal come from the server, so they do
  not include pending answers, and say so while there are any.
- A way to see the outbox and to discard an entry on purpose.

### 9. The app shell

A service worker that caches the built files, so the app opens without a
connection at all. Without it, "offline" only covers losing the connection
after the page has loaded.

## What it would not do

- Show words that became due while offline: the queue is the one that was
  loaded. A week offline is one sitting, not seven.
- Run both schedules on the device. The schedule in charge is applied by the
  server when the answer arrives.
- Guarantee anything if the browser clears its storage. Pending answers are
  lost with it, and the note in the interface has to say so.

## Order of work

1. `answeredAt` on the server, with its limits and tests. Useful on its own:
   it also fixes the answer that is given at 23:59 and arrives at 00:01.
2. The outbox, with the pending count, for answers that fail to send while the
   page is open. No local queue yet. This is the smallest honest step.
3. The local queue and per-account storage, behind a setting.
4. The service worker.

Each step is usable without the next.

## Open questions for the owner

- Is keeping vocabulary on the device acceptable, and on which devices?
- How old may an offline answer be and still be applied? A day is safe. A week
  starts to stretch what "reviewed on Monday" means for a schedule.
- Is losing pending answers when browser data is cleared acceptable, given the
  warning?
