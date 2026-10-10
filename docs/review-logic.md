# Review logic: what the app does and where each rule comes from

Last updated 2026-10-10.

This document describes the review behaviour the flashcard app preserves.

- The **reading** side (which words are due, in what order, what may be shown)
  was verified against the Notion database itself.
- The **writing** side (what "Nhớ" and "Không nhớ" do) was specified by the
  owner. Notion does not expose button steps, so it could not be read; it was
  checked for consistency against every stored row instead.

## 1. What was inspected

| Source | Result |
| --- | --- |
| Project directory | Empty when work started. Nothing existing to reuse or read. |
| Notion schema | **Read on 2026-10-10** through the API (`npm run notion:inspect`): every property, its type, and every formula. |
| Notion views | **Read**: the stored filter, quick filter and sort of all four views. |
| Notion rows | **Read in aggregate** (43 rows): how mastery and review dates are stored. No vocabulary content was copied anywhere. |
| Button steps | **Cannot be read.** Notion's API returns a button as an empty object. |

Status labels:

- **VERIFIED** — read from Notion itself.
- **STATED** — specified by the owner; not readable from Notion.
- **CONSISTENT** — every stored row fits the stated rule.
- **OPEN** — not yet settled. None of the open items blocks saving.

## 2. Which words are in the queue — VERIFIED

The "Need review" view filters on the formula property **Due for Review**:

```
prop("Mastery") < 10 and (empty(prop("Review Date")) or dateStart(prop("Review Date")) <= today())
```

The app implements exactly this:

| Rule | Status | In the app |
| --- | --- | --- |
| Mastery below 10 | VERIFIED | Mastery 10 or more never enters the queue. Mastery 6 to 9 does, when due. |
| Review Date on or before today | VERIFIED | A word due today is included; a future date is not. |
| Empty Review Date counts as due | VERIFIED | Included, placed after dated words. (No such row exists today.) |
| No duplicates | STATED | De-duplicated by page id. |
| Empty Mastery, or a Mastery that is not a whole number from 0 to 10 | OPEN | Left out of the queue and listed in the app as such, because the schedule counts whole days from the mastery. No such row exists today. |

Checked against live data: for all 43 rows the app's rule and Notion's formula
agree when both use the same "today".

**Why the app does not simply read the formula's value.** Through the API,
Notion evaluates `today()` in UTC. In the Notion app it follows your own clock.
Shortly after midnight on 10 October in Vietnam, the API still reported no
word as due (it was 9 October in UTC), while 14 words were due by your
calendar. The app therefore applies the same rule itself, using
`REVIEW_TIMEZONE` (`Asia/Ho_Chi_Minh`), so it matches what you see in Notion.

A second formula, **Expired**, compares the review date with today as text. It
is not used by any view and the app ignores it.

## 3. Sort order — VERIFIED

"Need review" sorts by **Review Date, ascending**. The app does the same. (The
owner's notes call this sorting "by Due for Review"; that property is the
filter, and Review Date is what the view sorts on.)

Not verifiable: the order of words that share a review date. The app keeps the
order Notion's API returns them in, which may differ from the Notion table.

## 4. What the card may show

Two formula properties implement the mastery rule:

```
Review Definition = if(prop("Mastery") <= 5, prop("Definition"), "")
Review Example    = if(prop("Mastery") <= 5, prop("Example Sentences"), "")
```

| Rule | Status | In the app |
| --- | --- | --- |
| Mastery 0 to 5 shows definition and example | VERIFIED | Shown on the back, after flipping. |
| Mastery 6 to 9 hides them | VERIFIED | Not sent to the browser at all. The app reads the two formula properties, so Notion decides, and the server applies the same threshold a second time. |
| "Vietnamese Meaning" is the answer | OPEN | Shown on the back at every mastery level. The owner's notes do not mention this property. |
| Front of the card | STATED | Word, mastery and how overdue it is. The database has no part-of-speech or pronunciation property. |

Flipping or viewing a card never changes anything in Notion.

## 5. "Nhớ" (Remember) — STATED, CONSISTENT

> Mastery becomes **Mastery + 1**. Review Date becomes **the day of the review
> plus the old Mastery, in calendar days**.

The interval uses the mastery *before* the increment. The owner's examples,
for a review on 10 October:

| Mastery before | Mastery after | Next review |
| ---: | ---: | --- |
| 0 | 1 | 10 October |
| 1 | 2 | 11 October |
| 2 | 3 | 12 October |
| 3 | 4 | 13 October |
| 4 | 5 | 14 October |
| 5 | 6 | 15 October |
| 6 | 7 | 16 October |
| 7 | 8 | 17 October |
| 8 | 9 | 18 October |
| 9 | 10 | 19 October |

These are tests in `tests/shared/review-config.test.ts`.

Evidence from the database: for all 37 rows with mastery 2 or more, Review
Date minus the day the row was last edited equals the mastery minus one, with
no exceptions. That is exactly what this rule produces.

Mastery never exceeds 10. A word that reaches 10 leaves the queue.

## 6. "Không nhớ" (Not remember) — STATED

> Mastery is **unchanged**. Review Date becomes **the day after the review**.

It never lowers or resets mastery and never uses the Remember interval. Only
the Review Date property is written. The six mastery-1 rows in the database
are consistent with this, but would also be consistent with new words simply
being created that way, so this rests on the owner's statement.

## 7. Date arithmetic — VERIFIED for format, STATED for the base

- Every Review Date in the database is date-only (no time, no end date). The
  app writes date-only values.
- "The day of the review" is the calendar day in `REVIEW_TIMEZONE`. A review at
  00:30 on 10 October in Vietnam counts as 10 October although it is still
  9 October in UTC. Days are added on the calendar, never as multiples of 24
  hours, so month ends, year ends and leap days are exact.
- **OPEN: overdue words.** The rule counts from the day you review, not from
  the old Review Date. For a word reviewed on its due date the two are the
  same day, and the stored rows cannot tell them apart. For a word reviewed
  late they differ. The owner's notes describe "the current review date" as
  the base, and that is what the app does. To settle it beyond doubt: give a
  spare word Mastery 3 and a Review Date a week ago, press "Nhớ" in Notion,
  and see whether the new date is today + 3 (as the app assumes) or the old
  date + 3.

## 8. "Hiện đáp án" and "Answer Shown" — OPEN

There is a button "Hiện đáp án" (show answer) and a checkbox "Answer Shown". No
formula refers to the checkbox and it is unchecked on all 43 rows. The app
never reads or writes it. If "Nhớ" and "Không nhớ" untick it in Notion, the
only visible difference is this: a word whose answer you revealed *in Notion*
and then answered *in the app* would keep the tick.

## 9. Property names and types — VERIFIED

| Property | Type | Used by the app |
| --- | --- | --- |
| Word | title | The word. |
| Mastery | number | Read and written. Values today: 1 to 8, whole numbers. |
| Review Date | date | Read and written. All 43 values are date-only. |
| Vietnamese Meaning | text | Back of the card. |
| Review Definition | formula | Back of the card, when Notion leaves it non-empty. |
| Review Example | formula | Back of the card, when Notion leaves it non-empty. |
| Definition, Example Sentences | text | Not read directly; the two formulas above are. |
| Due for Review | formula | Not read; the app applies the same rule (section 2). |
| Expired | formula | Not used. |
| Answer Shown | checkbox | Not used (section 8). |
| Date Added | date | Not used. |
| Nhớ, Không nhớ, Hiện đáp án | button | Cannot be read. |

The app writes **only** Mastery and Review Date, and only whichever of the two
actually changes.

Views: "All Vocabulary" (no filter, Date Added descending), "Mastered Words"
(Mastery = 10, Word ascending), "Need review" (Due for Review is checked,
Review Date ascending), "Date added" (calendar).

## 10. Still open

None of these blocks saving.

1. **Overdue base date** (section 7): one test word settles it.
2. **"Answer Shown"** (section 8): do the answer buttons untick it?
3. **Card layout** (section 4): is "Vietnamese Meaning" the answer to show on
   the back?

## 11. The review session

- The queue is a snapshot taken when the session loads. Each card is shown
  once. A reviewed card never comes back in the same session, even when it is
  still due in Notion (Remember at mastery 0 leaves the review date on the
  same day). It is judged normally the next time the queue is loaded.
- A card must be flipped before any answer (key, swipe or button) is accepted.
- The next card appears only after Notion confirms the save. The server
  compares what Notion stored with what it meant to write, and reports a
  failure if they differ.
- A failed save keeps the card on screen with a retry.
- "Refresh" re-reads the queue and never writes.
- An empty queue says why: nothing due right now, every word mastered, or no
  words at all. Finishing a session is never described as mastering everything.

## 12. How duplicate writes are prevented

Remember increments mastery, so applying one answer twice would corrupt
progress. Notion has no transactions or conditional updates, so:

1. The browser sends the card id and the answer, plus the mastery and review
   date it was showing. Those two values are a precondition only. They are
   never written and never used to calculate anything.
2. The server re-reads the record. If it still matches what the browser saw,
   the server computes the new values from its own read and writes them as
   absolute values (`Mastery = 4`, never "add 1").
3. If the record instead already holds exactly the result of this answer, an
   earlier attempt succeeded and its response was lost. The server reports
   success without writing again. This is what makes Retry safe.
4. If the record changed in any other way, nothing is written and the reviewer
   is told the card changed in Notion.

The owner's notes ask for the browser to send only the id and the action. The
shown state is sent as well because, without it, a server that keeps no memory
between requests cannot tell a retry of a lost request from a fresh answer.

Also in place: both answer controls are inert while a save is pending, a held
or repeated key counts once, and requests for the same card are processed one
at a time.

Remaining limitation: two requests for the same card arriving at two different
server instances at the same moment can both pass step 2. Both would then write
the same absolute values, so the record still ends in the correct state. An
answer retried after midnight in the review time zone is treated as a conflict
rather than recognised as already applied; it is still never applied twice.
