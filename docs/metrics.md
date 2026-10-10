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
