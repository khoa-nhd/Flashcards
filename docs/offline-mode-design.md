# Offline mode: how it works

**Status: built.** Review answers, practice answers and vocabulary changes are
recorded on the device first and sent to the server whenever they can be. The
app keeps working without a connection, and nothing that looks saved is ever
dropped on the floor. Everything is either confirmed by the server or shown to
the reviewer as refused, with a Retry and a Dismiss.

This note describes what was built, not a plan. The plan that preceded it is in
the git history.

## The one model

Every change — a review answer, a practice answer, a word added, edited or
deleted — becomes one **operation** in a durable **outbox** on the device. The
operation carries its own id (a UUID made in the browser), the account it
belongs to, the entity it is about, its payload, and when it was made. Nothing
is written anywhere else: what is on screen is the last confirmed server state
with the outstanding operations folded over it, so:

- one code path works the same online and offline;
- a retry can never apply an operation twice, because the request id
  identifies it to the server, which answers a repeat with its first result;
- what is shown survives a reload, because the outbox is the truth.

The outbox lives in `src/lib/offline/storage.ts` (IndexedDB, one database per
account; a memory store is used when there is none). The engine that drains it
is `src/lib/offline/sync-engine.ts`. The folding rules are pure functions in
`src/lib/offline/ops.ts`.

## Sending, and when it happens

- An operation is **stored before it is sent**. Nothing exists only in memory
  on its way to the server.
- Sending is serial — one request in flight — and operations about the same
  entity keep their order. Skipping ahead could apply an edit to a word that
  the server has not created yet.
- The engine is woken at start-up, when the browser comes online, when the tab
  becomes visible, and shortly after anything is recorded. `navigator.onLine`
  is only a hint: sending is driven by what actually happens to each request.
- **Transport failures and 5xx** are retried with capped exponential backoff
  and jitter. A 401 pauses sending for a minute; the session can come back.
- **Refusals** (4xx other than 401/408/429) are final for that operation: it
  moves to `failed`, stops where it is, and is reported to the person, who can
  retry it (under the same request id) or dismiss it.
- Nothing is ever silently discarded. An operation leaves the outbox only when
  the server has confirmed it, or because the person dismissed it.

## Review answers

The review session (`src/lib/session-controller.ts`, machine in
`session-machine.ts`) records each answer in the outbox and moves to the next
card **in the same tick**. There is no submission lock and no wait for the
database: A → B → C → D all work while the first three are still on their way.
The rules:

- An answer is accepted only after the card is flipped (and not while an Undo
  is in flight). Rapid clicks, key presses or swipes cannot record twice:
  the machine moves the card on as the answer is recorded.
- Each answer carries the state the card was shown in (mastery and review
  date); the server refuses an answer given against a state the word no
  longer has. There is no "keep mine": a stale answer is a fact to report,
  not a conflict to resolve.
- Answers carry `answeredAt` — the instant the answer was given, from the
  browser's clock. The server accepts it within a day of its own clock and no
  more than 30 days back, and uses it for the recorded day, the schedule and
  FSRS. An answer given on Monday and sent on Wednesday counts on Monday.
- The sitting in progress is written to the device (snapshot, kept 7 days),
  so a reload without a connection resumes exactly where it stopped: same
  cards, same place, same answers still waiting.
- Answers the server refuses are listed **beside** the current card with
  Retry and Dismiss; the session never stops for them. A refused answer that
  predates this sitting (a reload, another tab) is adopted back into the list
  when a fresh queue loads, so it is never stuck with only a counter to show
  for it.
- Answer counts (the tally, the completion screen) count only what has been
  confirmed; waiting answers are excluded and shown as saving.

## Practice answers

`src/pages/PracticePage.tsx` judges each answer locally with the same rules
the server uses (`shared/study-modes.ts`) and records it in the outbox. The
verdict shows at once; the confirmation (what was recorded, and the word's
practice mastery in that mode) appears when the server answers. A refused
answer shows the verdict with Retry and Skip; a lost connection retries
silently. A dry run (saving switched off on the server) is shown as "Not
recorded" and counted as such in the summary — never as saved.

## Vocabulary changes

`src/lib/vocabulary-store.ts` folds the outbox over the last read:

- **Add** shows the word at once, sends it behind the form, and the "was
  added" confirmation appears when the server has named the real record. A
  temporary id names the word until then; the id map is kept on the device
  so a reload can still resolve it.
- **Edit** applies the change at once and sends only the fields that differ.
  A refusal puts the stored values back and reopens the draft — nothing has
  to be typed again.
- **Delete** takes the word out of the list at once. The Undo toast appears
  when the delete has been confirmed, and calls the server's restore then. A
  refusal returns the word to the list with a Retry.
- A new write to a word **supersedes** an earlier refused write to the same
  word: both carry absolute values, and the refused one changed nothing on
  screen — without this, a refused edit would block every later write to that
  word.
- A refused delete or create is reported where it was made (the word's panel,
  the add form) rather than in a global list, because the draft or the toast
  is what Retry needs.

## Reads without a connection

- `src/lib/offline/cached-api.ts` wraps the read-only API calls: every
  successful read is kept on the device, and **only** a failure to reach the
  server is answered from the copy. Reads that depend on the reviewer's day
  (settings, plan, analytics, weak words, review days) are only ever answered
  from a copy taken today; the rest (library, a word, practice history,
  trash) are kept for up to a week.
- The review queue is cached separately (with the day it was fetched for),
  and answers already in the outbox are taken out of a restored queue.
- The vocabulary list is the last read plus the folded outbox; it is re-read
  in the background when it is stale, and a read that cannot reach the server
  keeps showing what is stored.
- A refusal (4xx) is never answered from a copy: only "the server was not
  reached" is.

## Accounts, storage and privacy

- The outbox, the caches and the id map are scoped by account id; one
  account's copy is never used for another.
- No token, password or key is stored by any of this. The session stays where
  the Supabase client already keeps it; syncing under an uncertain identity
  never happens — operations are only ever sent as the account they were
  recorded under.
- Signing out asks first when anything is waiting or refused; clearing the
  device's saved data in Settings is refused while anything is outstanding.
- Guest (sample-data) mode stays memory-only: no offline persistence for the
  guest account.

## The app shell

`public/sw.js` is a small hand-written service worker: navigation requests
are network-first with a cached shell as fallback; hashed assets are
cache-first (they never change); `/api/*` is never cached. It is registered
only when the built `index.html` says `app-mode: production` (the `%MODE%`
placeholder), so development and tests never see it.

## What is not offline

- Importing a list, AI Chat, account-settings writes, and the library writes
  (collections, further examples, relations) need a connection.
- FSRS state is not projected locally: a card whose FSRS schedule is in charge
  shows the dates the server sent until the answers sync.
- Guest mode keeps nothing between visits.
- Multi-tab use is safe against duplicates (idempotent ids) but not merged:
  each tab's view is its own; the outbox is shared.
- Background Sync (sending with the tab closed) is not used.
- Restoring a word from the trash needs a connection.
- The queue shows the cards that were due when it was last fetched. Words
  that became due while offline are not invented on the device.

## Feature coverage

| Feature | Offline |
| --- | --- |
| Review: answer, swipe/keyboard, next card | **Full** (recorded locally, sent when possible) |
| Review: Undo | Full when online; the answers themselves never need the connection |
| Review: resume after reload | **Full** (snapshot ≤7 days) |
| Practice: all modes, local verdict, results | **Full** (answers recorded locally) |
| Vocabulary bank: view, search, filter, sort | **Full** (last read + folded writes) |
| Vocabulary: add, edit, delete | **Full** (outbox, per-word retry) |
| Vocabulary bank: word details | Full from cache; a refused read falls back to the cached word |
| Weak words, dashboard summary, insights numbers | Partial: shown from today's cached read; may be stale |
| Calendar / review days | Partial: today's cached read |
| Collections, further examples, relations: view | Partial (cached library read) |
| Collections, examples, relations: change | **Not offline** |
| Import / Export | Not offline (needs the connection) |
| AI Chat | Not offline |
| Account settings, sign-in | Not offline |
| Trash: view | Cached (≤7 days); Restore needs a connection |
| App shell (open the app at all) | Full (service worker in production builds) |
| Guest/sample-data mode | Works, memory-only: nothing survives a reload |

## Where it lives

```
src/lib/offline/storage.ts      Outbox and key-value storage (IndexedDB / memory)
src/lib/offline/ops.ts          Payload types and the pure folding rules
src/lib/offline/sync-engine.ts  The pump: store, claim, send, back off, report
src/lib/offline/send.ts         One operation → one API request, field by field
src/lib/offline/cached-api.ts   Reads that survive a lost connection
src/lib/offline/service-worker.ts  Registers public/sw.js when the build says production
public/sw.js                    The service worker itself
src/lib/session-controller.ts   Review answers through the outbox, snapshot resume
src/lib/session-machine.ts      The session's own transitions
src/lib/vocabulary-store.ts     Vocabulary writes through the outbox, folded over reads
```

The types, the storage and the engine have their own suites
(`tests/client/sync-engine.test.ts`, `vocabulary-store.test.ts`,
`session-controller.test.ts`, `cached-reads.test.ts`); the screens are covered
through the real app (`review-ui`, `study-experience`, `vocabulary-pages`,
`practice`, `app-pages`, `review-activity`).
