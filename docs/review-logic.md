# Review logic: what is known, and what still needs confirming

Last updated 2026-10-10.

This document describes the review behaviour the flashcard app must preserve. It
separates what was **stated** by the owner from what has actually been
**verified** against Notion, because at the time of writing nothing has been
verified.

## 1. What was inspected

| Source | Result |
| --- | --- |
| Project directory | Empty when work started: no code, no Git history, no configuration, no documentation. Nothing to reuse and nothing describing the existing system. |
| Notion workspace | **Not inspected.** No Notion credentials or connector were available, so no database, property, formula, view or button was read. |
| Notion API capabilities | Checked against the official SDK (`@notionhq/client` 5.27, API version `2025-09-03`). Property schemas, formula expressions and view filters/sorts are readable. **Button automations are not**: a button property is returned as an empty object, so what the review buttons do can only come from the owner. |

Everything below marked STATED comes from the project brief. It is the owner's
description of their own system and is treated as the specification, but it has
not been compared with Notion.

Status labels:

- **STATED** — described in the brief; implemented as described; not verified.
- **UNCONFIRMED** — not specified or ambiguous. The app uses the provisional
  behaviour listed, which only affects what is *displayed*. Nothing unconfirmed
  can cause a write.
- **BLOCKING** — unknown, and the app refuses to write to Notion until it is
  supplied.

## 2. Which items are in the queue

| Rule | Status | Behaviour in the app |
| --- | --- | --- |
| Items that are due or overdue are included | STATED | Included when the next-review date is on or before today. |
| Items with mastery equal to 10 are excluded | STATED | Excluded, even if overdue. |
| No duplicate cards in one queue | STATED | Records are de-duplicated by page id; the first occurrence wins. |
| An item due exactly today is eligible | UNCONFIRMED | Treated as eligible ("due or overdue"). Configurable: `includeDueToday`. |
| How dates are compared | UNCONFIRMED | By calendar day in the zone set by `REVIEW_TIMEZONE`. A date-time value is placed on that zone's calendar. The existing filter may differ (for example "on or before now"). |
| Items with an empty next-review date | UNCONFIRMED | Excluded. Configurable: `includeMissingDueDate`. |
| Items with an empty mastery | UNCONFIRMED | Excluded, and listed in the app as "left out of this queue" so they are visible. Configurable: `missingMastery`. |
| Any other filter on the existing Review view (status, tags, checkbox…) | UNCONFIRMED | None applied. If the view has more filters, the app's queue will be larger than Notion's. |

## 3. Overdue items

STATED: overdue items stay in the queue until reviewed. The app does nothing
special for them beyond including and ordering them. Whether "Not Remember" on
a long-overdue item leaves it overdue depends on the open question in section 6.

## 4. Sort order

| Rule | Status | Behaviour in the app |
| --- | --- | --- |
| Sorted by due date | STATED | Sorted by next-review date. |
| Direction | UNCONFIRMED | Ascending: most overdue first. Configurable: `sortDirection`. |
| Order of cards sharing a due date | UNCONFIRMED | The order Notion returns them in for that sort; the app's own sort is stable and does not reshuffle ties. |
| Any secondary sort on the existing view | UNCONFIRMED | None applied. |

## 5. Answer visibility

| Rule | Status | Behaviour in the app |
| --- | --- | --- |
| Mastery greater than 5: definition and example are hidden | STATED | The server does not send those fields to the browser at all for such cards. The back of the card says they are hidden at this mastery level. |
| Mastery 5 or less: definition and example are shown | STATED | Shown on the back of the card after flipping. |
| How the existing system hides them (formula properties, a filtered view, something else) | UNCONFIRMED | Unknown. If the database has formula properties that already blank out the text, point the card fields at those properties instead; the app reads formula results. |
| Fields other than definition and example | UNCONFIRMED | Part of speech and pronunciation are assumed to exist and are shown on the front. Any other field is not shown until it is added to `cardFields`. |

Nothing is shown on the front except the word and front metadata. The answer is
not present in the page until the card is first flipped.

## 6. Remember

| Rule | Status |
| --- | --- |
| Applies "the existing mastery update" | **BLOCKING** — the amount is not stated (presumably +1, presumably capped at 10). |
| Sets the next review date by "the existing scheduling rule" | **BLOCKING** — the formula is not stated, nor whether the interval counts from today or from the previous due date. |
| Updates the same properties as the existing button | **BLOCKING** — unknown whether the button also sets anything else (a last-reviewed date, a counter, a status). |

No scheduling formula has been invented. `reviewRules.remember` is `null`, and
while it is `null` the app cannot write.

## 7. Not Remember

| Rule | Status |
| --- | --- |
| Does not increase mastery | STATED ("if the existing implementation does not increase it") |
| Moves the next review date forward by one day | STATED ("if that is what the current implementation confirms") |
| Counted from today, or from the existing due date | **BLOCKING** — these differ for every overdue card. An item due on 1 October and failed on 9 October becomes due on 10 October under one reading and stays overdue (2 October) under the other. |
| Whether mastery is left as is, reduced or reset | **BLOCKING** — the brief only rules out an increase. |
| Other properties updated | **BLOCKING** — unknown. |

`reviewRules.notRemember` is `null` for the same reason.

## 8. When mastery reaches 10

STATED: the item no longer appears in the queue. UNCONFIRMED: whether the
Remember button does anything else at that point (sets a status, clears the
date). The app would only set mastery and the next-review date.

## 9. Reset, refresh and moving to the next card

The brief describes the desired new behaviour (advance automatically after a
successful save). How the existing Notion page behaves after a button press is
not described and was not observed. The app's behaviour:

- The queue is a snapshot taken when the session loads. Each card is shown once.
- After a confirmed save the next card is shown, front side up.
- "Refresh" and "Check for more cards" re-read the queue. They never write.
- A card that is still due after being answered (possible if "Not Remember"
  counts from the old due date) reappears on the next refresh, not in the same
  session.

## 10. Property names and types

**None have been discovered.** The names in `config/review.config.ts` are
placeholders:

| Role | Placeholder name | Expected type | Needed for |
| --- | --- | --- | --- |
| Word | `Word` | title | reading |
| Mastery | `Mastery` | number (a formula or rollup can be read but not written) | reading and writing |
| Next review date | `Next Review` | date (same caveat) | reading and writing |
| Part of speech | `Part of Speech` | any text-like type | card front, optional |
| Pronunciation | `Pronunciation` | any text-like type | card front, optional |
| Definition | `Definition` | any text-like type | card back, optional |
| Example | `Example` | any text-like type | card back, optional |

Wrong names cannot cause damage: the server checks the configuration against
the real schema before serving anything and reports which names are missing,
listing the properties that do exist. `npm run notion:inspect` prints the real
schema, including formula expressions and each view's stored filter and sort.

## 11. What is needed to finish

In order of importance:

1. **What the Remember button does**: each property it edits and the value or
   formula it sets. A screenshot of the button's steps is enough.
2. **What the Not Remember button does**: the same.
3. **A Notion connection**, so the schema, formulas and the Review view's
   filter and sort can be read rather than described: an integration token and
   database id in `.env` (see README), then `npm run notion:inspect`.
4. **The time zone** you review in (`REVIEW_TIMEZONE`).
5. Answers to whatever remains UNCONFIRMED above after step 3, chiefly: empty
   mastery, empty dates, and whether the due-date property stores a time.

## 12. Behaviour that belongs to the new interface, not to the review logic

These are deliberate properties of the app and do not change scheduling:

- A card must be flipped before any answer (key, swipe or button) is accepted.
- The next card appears only after Notion confirms the save.
- A failed save keeps the card on screen with a retry.
- The app writes dates as date-only values (`YYYY-MM-DD`). If the existing
  buttons store a time of day as well, that is a difference to resolve before
  writes are enabled.

## 13. How duplicate writes are prevented

Remember presumably increments mastery, so applying one answer twice would
corrupt progress. Notion has no transactions or conditional updates, so:

1. The browser sends the card id, the answer, and the mastery and due date it
   was showing. Those values are a precondition only; they are never written.
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
