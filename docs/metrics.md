# Metric definitions

Every number on the Dashboard, Insights and Calendar pages is computed in
[`shared/metrics.ts`](../shared/metrics.ts) from the same records the
Vocabulary Bank lists. Review states come from
[`shared/vocabulary-status.ts`](../shared/vocabulary-status.ts), which uses the
same rules object as the review queue, so "due" here always matches what the
Review tab shows.

## Dates

- "Today" is the calendar day in `REVIEW_TIMEZONE`, the same day the review
  queue uses.
- A week runs **Monday to Sunday**.
- Date Added and Review Date are compared as calendar days, never as instants,
  so nothing shifts by a day because of UTC.
- A date-time value, if one ever appears, is placed on the calendar of
  `REVIEW_TIMEZONE`.

## Review state

Each word is in exactly one state.

| State | Definition |
| --- | --- |
| Mastered | Mastery is 10 (or above). |
| Overdue | Not mastered, and Review Date is before today. |
| Due today | Not mastered, and Review Date is today. |
| No review date | Not mastered, and Review Date is empty. Such a word is in the review queue. |
| Upcoming | Not mastered, and Review Date is after today. |
| Needs a mastery | Mastery is empty or not a whole number from 0 to 10. Not reviewable. |

## Summary cards

| Card | Definition |
| --- | --- |
| Total vocabulary | Every record. Equals Mastered + Learning + "Needs a mastery". |
| Mastered | State is Mastered. |
| Learning | Mastery from 0 to 9. Equals Due today + Overdue + Upcoming + No review date. |
| Due today | State is Due today. Never includes overdue words. |
| Overdue | State is Overdue. |
| Upcoming | State is Upcoming. Never includes words that are already due. |
| Added today | Date Added is today. |
| Added this week | Date Added is in the current Monday-to-Sunday week. |
| Ready to review | Words in the review queue right now: Overdue + Due today + No review date. The same count as the Review tab's queue. |

Words with no review date, with no usable mastery, or with no Date Added are
reported in a note under the cards whenever there are any, so no word is
silently left out of or folded into another figure.

## Charts

| Chart | Definition |
| --- | --- |
| Words at each mastery level | One bar per level from 0 to 10. Words with an empty or out-of-range mastery are counted in a note, not as level 0. |
| Words added per day / week / month | Count of words by Date Added in each period. A period with no bar had no additions; periods are never skipped. Words without a Date Added are not counted and the note says how many. |
| Progress to mastery | Mastered ÷ Total. |

Every chart can be switched to a table of the same numbers.

## Insights

| Figure | Definition |
| --- | --- |
| Share mastered / learning | Count ÷ Total, rounded to a whole percent. |
| Days with the most additions | Days ranked by number of words with that Date Added; ties go to the more recent day. |
| Incomplete entries | Words whose Vietnamese Meaning, Definition or Example Sentences is empty. A statement about the record, not about how well the word is known; it never affects reviewing. |

## Calendar

- A day's count is the number of words whose Date Added is that day.
- Intensity steps: 1, 2–3, 4–6, 7 or more. The count is always printed too.
- Words without a Date Added are listed in a note and placed on no day.
- The calendar shows when words were **added**. It is not a review schedule.

## Vocabulary Bank filters

| Filter | Definition |
| --- | --- |
| Due today, Overdue, Upcoming, No review date | The review state above. |
| Completed (mastered) | State is Mastered, i.e. Mastery = 10. |
| Learning | Any state except Mastered and "Needs a mastery". |
| Mastery | Exactly that level. |
| Added from / to | Date Added within the range, both ends included. Words without a Date Added never match. |
| Recently added | Date Added within today and the six days before it. |
| Missing meaning / definition / example | That field is empty. |
| Search | Case-insensitive partial match on Word, Vietnamese Meaning, Definition and Example Sentences. |

Filtering and sorting in the bank never change the review queue or its order.

## Review activity

Shown on the Dashboard ("Review activity") and in Insights. Computed in
[`shared/analytics.ts`](../shared/analytics.ts) from rows the database
aggregates per day (`review_daily_stats`).

**What is counted.** Only answers that were saved and still stand. An answer
that was undone is not counted anywhere. Nothing is reconstructed for the time
before the app kept a history: a word's mastery is never turned into pretend
past reviews. Needs database version 4; below that the app says the figures are
not available instead of showing zeros.

**Days.** A review belongs to the reviewer's calendar day at the moment it was
saved (`reviewed_on`), in the account's time zone. The figures look back 90
days.

| Figure | Definition |
| --- | --- |
| Reviews | Number of saved answers in the period. |
| Remembered / Not remembered | Saved answers of each kind. |
| Accuracy | Remembered ÷ all answers in the period. |
| Retention | Remembered ÷ answers, counting only answers to a word that had been reviewed at least once before. First encounters are left out because they test nothing that was retained. This is what happened; it is **not** a prediction of future recall. |
| Time on cards | Sum of the time between a card appearing and its answer, over the answers that reported a time. |
| Time per card | Time on cards ÷ the number of answers that reported a time. |
| Days reviewed | Days in the period with at least one saved answer. |
| Streak | Days in a row with at least one saved answer, ending today, or ending yesterday when today has none yet (so a streak is not "lost" at midnight, only after a full day without a review). |
| Longest streak | The longest such run within the 90 days in view. A longer run further back is not known to this figure. |
| By study mode | Reviews and accuracy for each mode over the last 30 days. Modes test different skills and are never merged into one percentage. Shown once there is more than one mode. |

Periods: **Today**; **Last 7 days** and **Last 30 days**, each ending today and
including it.

**Small samples.** A percentage (accuracy, retention) is given only from 5
answers up (`MIN_SAMPLE`); with fewer the app shows "Not enough data" and the
counts. Five is a floor against "100% (1 of 1)", not a claim of statistical
confidence.

## Weak words

The Weak words page lists words with something against them, weakest first.
Scoring is in [`shared/weak-words.ts`](../shared/weak-words.ts): a pure
function with its weights in one table, and every point attributed to a named
reason that is shown beside the word.

| Reason | Points | When |
| --- | --- | --- |
| Forgotten repeatedly | 3 per day, up to 12 | For each separate day the word was forgotten on, from the second such day (up to five days counted). |
| Recent misses | 2 each, up to 6 | "Not remember" answers in the last 30 days. |
| Low recent accuracy | 3 | At least 3 reviews in the last 30 days and fewer than 60% remembered. |
| Slipped after progress | 3 | Mastery 6 or higher, and the latest answer was "Not remember". |
| Long overdue | 2, plus 1 per further week, up to 5 | Review date 7 or more days in the past (not for mastered words). |
| Incomplete | 1 per field, up to 2 | Meaning, definition or example is empty. |

- **Priority:** High from 8 points, Medium from 4, otherwise Low.
- The **main reason** is the one with the most points, and it picks the
  suggested action.
- "Recent" is the last 30 days. History counts only answers that still stand.
- A word with no points is not listed. A word that was never reviewed can only
  be listed for being long overdue or incomplete; nothing is guessed about how
  well it is known.
- Where the database keeps no review history yet (below version 4), only the
  last two reasons can apply, and the page says so.
- At most 100 words are sent; the page says when there are more.

**Reviewing the weakest words** (`/review?focus=weak`) shows the words on this
list that are **already due**, weakest first. It narrows the normal queue and
never widens it: no word is reviewed early, and answers are saved by exactly
the same rules as any other review.
