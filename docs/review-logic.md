# Review logic: what the app does and where each rule comes from

Last updated 2026-10-10.

This document describes how reviewing works. The rules were not designed for
this app: they were carried over, unchanged, from the owner's original
vocabulary system (a Notion database with "Nhớ" and "Không nhớ" buttons), which
the app used until the data moved to Supabase on 2026-10-10.

- The **reading** side (which words are due, in what order, what may be shown)
  was read from that system's own formulas and views.
- The **writing** side (what each answer does) was specified by the owner, and
  checked for consistency against every stored word.

The rules live in one place, [config/review.config.ts](../config/review.config.ts),
and are applied by one engine, `shared/review-logic.ts`, on the server.

Status labels:

- **VERIFIED** — read from the original system itself.
- **STATED** — specified by the owner.
- **CONSISTENT** — every stored word fitted the stated rule.
- **OPEN** — not yet settled. None of the open items blocks saving.

## 1. Where the rules were read from

| Source | Result |
| --- | --- |
| Original schema and formulas | **Read on 2026-10-10**: every property, its type, and every formula. |
| Original views | **Read**: the stored filter and sort of each view. |
| Original rows | **Read in aggregate**: how mastery and review dates were stored. |
| The two answer buttons | **Could not be read**; their behaviour was stated by the owner. |

## 2. Which words are in the queue — VERIFIED

The original "Need review" view filtered on this formula:

```
Mastery < 10 and (Review Date is empty or Review Date <= today)
```

The app implements exactly this:

| Rule | Status | In the app |
| --- | --- | --- |
| Mastery below 10 | VERIFIED | Mastery 10 never enters the queue. Mastery 6 to 9 does, when due. |
| Review date on or before today | VERIFIED | A word due today is included; a future date is not. |
| Empty review date counts as due | VERIFIED | Included, placed after dated words. A newly added word starts this way. |
| No duplicates | STATED | Each word is one row with one id. |
| Mastery outside 0 to 10 | — | Cannot be stored: the database rejects it. |

**"Today" is the calendar day in the account's own time zone**, never the
server's. Each account stores its time zone (Settings), so every device agrees
on what is due. The original system got this wrong when read from outside:
it evaluated "today" in UTC, so shortly after midnight in Vietnam nothing was
reported as due while 14 words were due by the owner's calendar. That is why
the app applies the rule itself with an explicit time zone.

## 3. Sort order — VERIFIED

Due words are ordered by **review date, earliest first**. Words that share a
review date keep the order in which they were created.

## 4. What the card may show

| Rule | Status | In the app |
| --- | --- | --- |
| Mastery 0 to 5 shows definition and example | VERIFIED | Shown on the back, after flipping. |
| Mastery 6 to 9 hides them | VERIFIED | Not sent to the browser at all. |
| The Vietnamese meaning is the answer | OPEN | Shown on the back at every mastery level. The owner's notes did not say. |
| Front of the card | STATED | Word, mastery and how overdue it is. |

Flipping or viewing a card never changes anything.

## 5. "Nhớ" (Remember) — STATED, CONSISTENT

> Mastery becomes **mastery + 1**. The review date becomes **the day of the
> review plus the old mastery, in calendar days**.

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

These are tests in `tests/shared/review-config.test.ts`, and the same answers
are checked end to end against the real database schema in
`tests/server/supabase-api.test.ts`.

Evidence from the original data: for every word with mastery 2 or more, the
review date minus the day the word was last changed equalled the mastery minus
one, with no exceptions. That is exactly what this rule produces.

Mastery never exceeds 10. A word that reaches 10 leaves the queue.

## 6. "Không nhớ" (Not remember) — STATED

> Mastery is **unchanged**. The review date becomes **the day after the review**.

It never lowers or resets mastery and never uses the Remember interval.

## 7. Date arithmetic

- Review dates are calendar dates, with no time of day.
- "The day of the review" is the calendar day in the account's time zone. A
  review at 00:30 on 10 October in Vietnam counts as 10 October although it is
  still 9 October in UTC. Days are added on the calendar, never as multiples of
  24 hours, so month ends, year ends and leap days are exact.
- **OPEN: overdue words.** The rule counts from the day you review, not from
  the old review date. For a word reviewed on its due date the two are the same
  day, and the original data could not tell them apart. For a word reviewed
  late they differ. The owner's notes describe "the current review date" as
  the base, and that is what the app does.

## 8. A new word

A word added in the app starts at **mastery 1 with no review date** (VERIFIED:
that is what the original new-word template set), so it is due at once. Both
can be changed per word in the Add form.

## 9. What is stored

A review answer changes **only** the word's mastery and review date, and
appends one row to the review history. See
[supabase-schema.md](supabase-schema.md) for the tables.

Past reviews made before 2026-10-10 are not in the history: the original
system kept only the current mastery and date, so there was nothing to bring
over, and none were made up.

## 10. Still open

None of these blocks saving.

1. **Overdue base date** (section 7).
2. **Card layout** (section 4): is the Vietnamese meaning the answer to show on
   the back?

## 11. The review session

- The queue is a snapshot taken when the session loads. Each card is shown
  once. A reviewed card never comes back in the same session, even when it is
  still due by the rule (Remember at mastery 0 leaves the review date on the
  same day). It is judged normally the next time the queue is loaded.
- A card must be flipped before any answer (key, swipe or button) is accepted.
- The next card appears only after the server confirms the save.
- A failed save keeps the card on screen with a retry.
- "Refresh" re-reads the queue and never writes.
- An empty queue says why: nothing due right now, every word mastered, or no
  words at all. Finishing a session is never described as mastering everything.

## 12. How an answer is saved exactly once

Remember increments mastery, so applying one answer twice would corrupt
progress.

1. The browser sends the word's id, the answer, an id for this one answer, and
   the mastery and review date it was showing. Those two values are a
   precondition only. They are never written and never used to calculate
   anything.
2. The server reads the word and computes the new mastery and date from its
   own read, as absolute values (`mastery = 4`, never "add 1").
3. The database saves them **only if the word still holds the state they were
   computed from**, and appends the history row, in one transaction. Either
   both happen or neither does.
4. A repeated answer id returns the first result instead of applying the
   answer again. This is what makes Retry safe, on any device, at any later
   time.
5. If the word changed in the meantime (for example, the card was answered on
   another device), nothing is written and the reviewer is told the card
   changed; they can skip it.

Also in place: both answer controls are inert while a save is pending, and a
held or repeated key counts once.

The browser never supplies the new mastery or date. A request that tries to
is rejected.
