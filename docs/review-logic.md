# Review logic: what is known, and what still needs confirming

Last updated 2026-10-10.

This document describes the review behaviour the flashcard app must preserve.
The reading side (which words are due, in what order, what may be shown) has
now been verified against the Notion database. The writing side (what the two
answer buttons do) has not, and the app cannot write until it is.

## 1. What was inspected

| Source | Result |
| --- | --- |
| Project directory | Empty when work started. Nothing existing to reuse or read. |
| Notion schema | **Read on 2026-10-10** through the API (`npm run notion:inspect`): every property, its type, and every formula. |
| Notion views | **Read**: the stored filter, quick filter and sort of all four views. |
| Notion rows | **Read in aggregate** (43 rows): how mastery and review dates are stored. No vocabulary content was copied anywhere. |
| Button steps | **Cannot be read.** Notion's API returns a button as an empty object. What "Nhớ", "Không nhớ" and "Hiện đáp án" do can only come from the owner. |

Status labels:

- **VERIFIED** — read from Notion itself.
- **STATED** — from the project brief; not contradicted by anything in Notion.
- **INFERRED** — a pattern in the stored data. Plausible, not proof. Never
  used to write.
- **UNCONFIRMED** — unknown; affects display only.
- **BLOCKING** — unknown, and the app refuses to write until it is supplied.

## 2. Which words are in the queue — VERIFIED

The "Need review" view filters on the formula property **Due for Review**:

```
prop("Mastery") < 10 and (empty(prop("Review Date")) or dateStart(prop("Review Date")) <= today())
```

The app implements exactly this:

| Rule | Status | In the app |
| --- | --- | --- |
| Mastery below 10 | VERIFIED | Mastery 10 or more never enters the queue. |
| Review Date on or before today | VERIFIED | A word due today is included; a future date is not. |
| Empty Review Date counts as due | VERIFIED | Included, placed after dated words. (No such row exists today.) |
| No duplicates | STATED | De-duplicated by page id. |
| Empty Mastery | UNCONFIRMED | Left out and listed in the app as such. No row has an empty Mastery today, so this has no effect yet. |

Checked against live data: for all 43 rows the app's rule and Notion's formula
agree when both use the same "today".

**Why the app does not simply read the formula's value.** Through the API,
Notion evaluates `today()` in UTC. In the Notion app it follows your own clock.
Shortly after midnight on 10 October in Vietnam, the API still reported no
word as due (it was 9 October in UTC), while 14 words were due by your
calendar. The app
therefore applies the same rule itself, using `REVIEW_TIMEZONE`
(`Asia/Ho_Chi_Minh`), so it matches what you see in Notion.

A second formula, **Expired**, compares the review date with today as text. It
is not used by any view and the app ignores it.

## 3. Sort order — VERIFIED

"Need review" sorts by **Review Date, ascending**. The app does the same.

Not verifiable: the order of words that share a review date. The app keeps the
order Notion's API returns them in, which may differ from the order the Notion
table shows.

## 4. What the card may show — VERIFIED for hiding, UNCONFIRMED for layout

Two formula properties implement the mastery rule:

```
Review Definition = if(prop("Mastery") <= 5, prop("Definition"), "")
Review Example    = if(prop("Mastery") <= 5, prop("Example Sentences"), "")
```

| Rule | Status | In the app |
| --- | --- | --- |
| Mastery 5 or less shows definition and example | VERIFIED | Shown on the back. |
| Mastery above 5 hides them | VERIFIED | Not sent to the browser at all. The app reads the two formula properties, so Notion decides, and the server applies the same threshold a second time. |
| "Vietnamese Meaning" is the answer | UNCONFIRMED | Shown on the back at every mastery level. The brief does not mention this property; it is assumed to be what "Hiện đáp án" reveals. |
| Definition and example belong on the back | STATED | On the back, as the brief specifies. Unknown whether Notion shows them before or after "Hiện đáp án". |
| Front of the card | STATED | Word, mastery and how overdue it is. The database has no part-of-speech or pronunciation property. |

## 5. "Nhớ" (Remember) — BLOCKING

Not readable from Notion. What the stored data shows (INFERRED):

| Mastery now | Review Date minus the day the row was last edited | Rows |
| --- | --- | --- |
| 2 | 1 day | 1 |
| 3 | 2 days | 3 |
| 4 | 3 days | 4 |
| 5 | 4 days | 9 |
| 6 | 5 days | 2 |
| 7 | 6 days | 13 |
| 8 | 7 days | 5 |

Every row with mastery 2 or more fits one rule with no exceptions:

> Mastery becomes Mastery + 1, and Review Date becomes **today + (the old
> Mastery) days**.

This is a hypothesis to confirm, not a fact. It also does not show whether the
button changes anything else (for example unchecking "Answer Shown"), or what
it does at mastery 9.

## 6. "Không nhớ" (Not remember) — BLOCKING

STATED in the brief: the date moves forward one day and mastery does not
increase. INFERRED from data: the six rows at mastery 1 have a review date
either on the day they were last edited or one day after, which is consistent
with "Review Date = today + 1, Mastery unchanged" but equally with new words
being created that way. Unknown:

- whether the day is counted from today (the data suggests so) or from the
  old review date;
- whether mastery is left alone, lowered or reset;
- whether anything else is edited.

## 7. "Hiện đáp án" and "Answer Shown" — UNCONFIRMED

There is a button "Hiện đáp án" (show answer) and a checkbox "Answer Shown". No
formula refers to the checkbox and it is unchecked on all 43 rows. Presumably
the button checks it and the answer buttons uncheck it again. If so, the app
should also uncheck it when saving an answer, so the Notion page is left in the
same state either way. The app does not touch it until this is confirmed.

## 8. When mastery reaches 10

VERIFIED: the word leaves the queue (`Mastery < 10`) and appears in the
"Mastered Words" view (`Mastery = 10`). No row is at 9 or 10 yet. Unknown
whether "Nhớ" does anything special at that point.

## 9. Property names and types — VERIFIED

| Property | Type | Used by the app |
| --- | --- | --- |
| Word | title | The word. |
| Mastery | number | Read; written once rules are confirmed. Values today: 1 to 8, whole numbers. |
| Review Date | date | Read; written once rules are confirmed. All 43 values are date-only (no time). |
| Vietnamese Meaning | text | Back of the card. |
| Review Definition | formula | Back of the card, when Notion leaves it non-empty. |
| Review Example | formula | Back of the card, when Notion leaves it non-empty. |
| Definition, Example Sentences | text | Not read directly; the two formulas above are. |
| Due for Review | formula | Not read; the app applies the same rule (section 2). |
| Expired | formula | Not used. |
| Answer Shown | checkbox | Not used yet (section 7). |
| Date Added | date | Not used. |
| Nhớ, Không nhớ, Hiện đáp án | button | Cannot be read. |

Views: "All Vocabulary" (no filter, Date Added descending), "Mastered Words"
(Mastery = 10, Word ascending), "Need review" (Due for Review is checked,
Review Date ascending), "Date added" (calendar).

Because every review date is date-only, the app's date-only writes will match
the existing data.

## 10. What is needed to finish

1. **"Nhớ"**: every step of the button. Is it "Mastery + 1" and "Review Date =
   today + old Mastery days"? Does it edit anything else?
2. **"Không nhớ"**: every step. Is it "Review Date = today + 1 day" with
   Mastery untouched?
3. **"Hiện đáp án"**: what it does, and whether the two answer buttons undo it.
4. **Layout**: is "Vietnamese Meaning" the answer, and should definition and
   example stay on the back?

A screenshot of each button's steps answers 1 to 3.

## 11. Behaviour that belongs to the new interface, not to the review logic

- The queue is a snapshot taken when the session loads; each card is shown
  once. "Refresh" re-reads it and never writes.
- A card must be flipped before any answer (key, swipe or button) is accepted.
- The next card appears only after Notion confirms the save.
- A failed save keeps the card on screen with a retry.

## 12. How duplicate writes are prevented

Remember increments mastery, so applying one answer twice would corrupt
progress. Notion has no transactions or conditional updates, so:

1. The browser sends the card id, the answer, and the mastery and review date
   it was showing. Those values are a precondition only; they are never
   written.
2. The server re-reads the record. If it still matches what the browser saw,
   the server computes the new values from its own read and writes them as
   absolute values (`Mastery = 4`, never "add 1").
3. If the record instead already holds exactly the result of this answer, an
   earlier attempt succeeded and its response was lost. The server reports
   success without writing again. This is what makes Retry safe.
4. If the record changed in any other way, nothing is written and the reviewer
   is told the card changed in Notion.

Remaining limitation: two requests for the same card arriving at two different
server instances at the same moment can both pass step 2. Both would then write
the same absolute values, so the record still ends in the correct state. An
answer retried after midnight in the review time zone is treated as a conflict
rather than recognised as already applied; it is still never applied twice.
