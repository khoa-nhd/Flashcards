# Discovery & Input: finding words where they are actually met

Reading, listening, a draft written for you, a page or file brought in — the
words you keep from any of them arrive in the same bank as words typed by
hand, with the same schedules and the same panel. The one rule that governs
every part of Discovery is short:

> **A word becomes a word only when you press Save.**

Reading a source never saves anything. Asking the model what a word means
never saves anything. Accepting a draft never saves a word. Importing a page
never saves a word. Until your own press, everything is text on screen — and
the same press of *Mark for later* keeps a selection without making a word at
all.

Discovery needs database version 19 (`supabase/migrations/
20261028090000_discovery.sql`). Where the database is older, the pages say
so and the rest of the app carries on unchanged — see
[the schema's version rules](supabase-schema.md).

## Where it lives

| Place | What it is |
| --- | --- |
| **Quick capture** (Alt+K, or the button over the sidebar) | A dialog over any page: a word, phrase, collocation, idiom or pattern, with an optional meaning and note. Save it now, or mark it for later. It needs no AI and no open source. |
| **Discovery → Texts** | Home: every source you have — pasted, imported, fetched, generated, captured — with where it came from and what waits inside it, plus the *Marked for later* list. |
| **Discovery → Reading** | The reading workspace over one source: paragraph navigation, your place remembered, selections that explain, save or mark. |
| **Discovery → Listening** | The listening workspace: a transcript with its cues, an optional audio link that is yours for the tab, seeks that land on a line, words captured with their time. |
| **Discovery → Generate** | A draft reading written from a topic, one saved collection, or a list of words — previewed on screen, stored only when you accept it. |
| **Discovery → Import** | Content brought in by file, paste or web address: validated, previewed as plain text, then opened in the workspace its kind deserves. |

The page keeps its view and its open source in the address
(`/discover?view=read&source=…`), so a reload or a bookmark lands where you
expect, and Back behaves.

## Reading

A source opens with its title and where it came from. The text itself is
rendered as plain text — never as markup — so a pasted or imported script
can never act. Select a word and its panel offers:

- **Explain this word** — sends only the word and a window of its own source
  around the selection (the picked sentence is what usually travels; the
  model never sees the whole source). The answer fills the form; nothing is
  stored until you save. Without a configured model the button says so, and
  the rest of the panel works by hand.
- **Save to vocabulary** — the ordinary word path, keeping the sentence the
  word was found in as its example, and remembering the source, the kind and
  the character offset beside it. A word already in your bank is offered for
  reuse instead of being created twice.
- **Mark for later** — the selection stays as text (label, sentence, note,
  position) with **no word created**.
- **Dismiss** — the selection is put back, with nothing stored anywhere.

Where you are in a text is saved as you read — on a selection, on a
paragraph jump — and the next opening says *Picked up where you left off*
and scrolls back. Paragraph navigation (Previous / Next, with a *Paragraph n
of m* count) works without a pointer.

## Listening

A listening source is a transcript. `.srt` and `.vtt` files arrive with
their timestamps; a pasted transcript reads like text until times are part
of it. With timestamps, each line shows its time: press the time to seek,
select words inside the line to capture them with that line's cue, and the
playing line lights up.

- **Audio is optional and yours.** You give the tab an address your browser
  can play; it is kept in memory for that tab only and never written back to
  the source or sent anywhere. The browser's own player does the playing —
  nothing is uploaded from your device.
- **Where you stopped listening** is remembered in seconds and resumed on
  the next open.
- **A transcript without timestamps** still reads and captures; selections
  keep their sentence instead of a time, and the panel says why seeking is
  not available.
- **Nothing is transcribed.** There is no speech-to-text, no upload of your
  audio, and no new paid service: an address that will not play says so
  plainly and the transcript keeps working underneath.

## What AI is asked, and what it may never see

Two Discovery features can use a model (both off, by name, without one —
see [AI features](ai-features.md)):

- **Explain this word** goes through the same route and the same per-account
  bucket as Smart Reader. The request carries the word and a bounded window
  of the source taken around your selection — never the source, never your
  library.
- **Draft a reading** carries the start you chose — a topic, the words of
  one collection, or the words you typed — plus the optional objective and
  length. The reply is validated against a strict schema like every other
  model reply; nonsense is discarded before you see it.

Accepting a draft creates **one source** whose text you can read like any
import, with its candidate words waiting as *marks* inside it — accepting a
draft saves no word, changes no collection, and overwrites nothing. There is
no generated audio anywhere in this feature, and none is promised.

## Import

Three ways in, one preview, one press:

- **File** — `.txt`, `.md`, `.srt`, `.vtt` and `.html`, read as plain text.
  Binary content and files this app does not read (PDF, Office) are refused
  by name, with what-to-do-instead. PDF extraction is not built; copy its
  text into Paste.
- **Paste** — up to 120,000 characters, titled by you or by its first line;
  a transcript shape is recognised and opens as listening.
- **Web address** — fetched **server-side as plain text**: scripts, styles
  and markup are stripped before anything is shown, and the fetch refuses
  private networks, loopback, cloud-metadata addresses, non-http schemes,
  redirects that land there, oversized bodies, slow upstreams and anything
  that is not readable text. No cookies, no logins, no paywall bypass — if
  the page needs you, copy it into Paste.

Nothing is stored at the preview: **Open** creates exactly the text you saw,
as one source of the right kind (a transcript listens, everything else
reads), and your vocabulary is untouched until you save a word inside it.

## A mark is not a word

The *Marked for later* list gathers every open mark, each with where it came
from. From there you can save it — typing or confirming its meaning — open
the source back at that place, or dismiss it. One label can be open once per
source; a second attempt offers the mark that already waits. Saving a mark
keeps the same selective context as saving a selection: the sentence or cue,
the source's title and kind, the position, your note — never the whole
imported work, and never as anything but plain text.

A word saved from a source remembers where it was found: the word's panel
shows *Found in …* with the way back.

## The routes

Everything sits under `/api/discovery` (schema 19; older databases answer
404 for the feature, and the pages say so):

| Route | Does |
| --- | --- |
| `GET /api/discovery` | The account's sources, newest first. |
| `POST /api/discovery` | Creates one source (text, listening, generated, imported, web, capture). |
| `GET /api/discovery/context?vocabularyId=…` | Where a saved word was found — the link back from a word's panel. |
| `GET /api/discovery/:id` | One source as a document, with its marks. |
| `PATCH /api/discovery/:id` | The title (revision-checked: a stale title is refused with 409) or the reading/listening position (never conflicts). |
| `DELETE /api/discovery/:id` | Removes a source; its saved words are untouched. |
| `GET /api/discovery/marks` | The open (unsaved) marks. |
| `POST /api/discovery/:id/marks` | Keeps a selection as a mark — no word. |
| `POST /api/discovery/marks/:id/save` | The explicit save: one ordinary word, with its context. |
| `DELETE /api/discovery/marks/:id` | Dismisses a mark. |
| `POST /api/discovery/generate` | A draft reading (AI, stateless: nothing stored). |
| `POST /api/discovery/fetch-url` | The guarded server-side fetch for the Import preview. |

Writes honour the frozen-saving switch (`REVIEW_WRITES_ENABLED=false`
answers 403 `read_only`, and the pages say so without losing your text).

## The lines it never crosses

- **Nothing is ever saved automatically.** Every word comes from an explicit
  Save press — in the dialog, the workspace or the marks list.
- **Save and Mark stay distinct**, and a mark carries its source with it
  wherever it is listed.
- **The AI never sees a whole source** when the selection's context will do,
  and never your library, history or another account's data.
- **Selective context, never whole works**: a saved word keeps its sentence
  or cue, the source's title and kind, its position and your note — the
  source itself stays a source.
- **Discovery never touches learning.** It writes no review, no FSRS state,
  no mastery, no practice, no exam, no Error Log entry, and nothing that
  Undo could reach. An explicit save creates one ordinary word, exactly as
  if it had been typed into Add vocabulary.
- **Imported content cannot act.** It is stored and shown as plain text;
  scripts are never executed, and fetched pages arrive with their markup
  already stripped.

## Limits

One source holds up to 120,000 characters of content and a 200-character
title; a mark keeps up to 2,000 characters of context and 600 of note;
Discovery requests may be up to 400 KB (the content travels in the request
itself). These are enforced in the shared contract
(`shared/discovery.ts`), checked again by the database, and named in the
error the page shows.
