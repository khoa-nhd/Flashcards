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

**Which date "Review Date" is.** Every word carries two: the date the mastery
schedule gives it, and (once it has been answered since FSRS started being
calculated) the moment FSRS has it due. Everything on this page uses the one
under **the schedule in charge**, which is the account's choice in Settings →
Scheduling and is the mastery schedule unless changed:

| Schedule in charge | A word's review date is |
| --- | --- |
| Mastery schedule | Its mastery review date. |
| FSRS | The calendar day, in the account's time zone, that FSRS has it due on; or its mastery review date, if FSRS has not seen the word yet. |

So the states above, the queue, the bank's filters and sort, the day's plan,
the "overdue" part of the weak-word score and the due counts all move together
when the choice changes, and none of them ever mixes the two. Mastered still
means mastery 10 under either. The word list marks a date that FSRS set, and
that date cannot be edited by hand.

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

**Reviews view.** The same grid can show saved reviews instead:

- A day's count is the number of flashcard answers saved on that day and still
  standing, on the reviewer's own calendar day (`reviewed_on`). Answers taken
  back with Undo are not counted; practice is not included.
- Intensity steps: 1–9, 10–24, 25–49, 50 or more. A different scale from
  additions, because reviews come by the dozen.
- Selecting a day shows how many were remembered and how many were not. It
  does not list the words.
- The month total counts the days of that month only, although the grid also
  shows the neighbouring days.
- Needs database version 4. Below that, or if the figures cannot be loaded,
  the page says so rather than showing empty days as fact.

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
that was undone is not counted anywhere. An answer from a sitting where counting
towards mastery was switched off **is** counted here: it was a real attempt, and
only mastery and the schedule were left alone. Nothing is reconstructed for the
time before the app kept a history: a word's mastery is never turned into
pretend past reviews. Needs database version 4; below that the app says the
figures are not available instead of showing zeros.

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

**Week by week** (Insights). Two charts over the last twelve weeks:

| Chart | Each bar |
| --- | --- |
| Accuracy by week | Remembered ÷ all answers saved in that week, as a whole percent. |
| Time per card by week | Time on cards ÷ the answers that reported a time, in that week, in seconds. |

- A week here is **seven days ending on today's weekday**, so the last bar
  always ends today and is a full week. This is deliberately not the Monday to
  Sunday week used for additions, which would leave the newest bar part-filled
  on most days.
- A week with fewer than 5 answers (for time: fewer than 5 timed answers) has
  **no bar**, and its tooltip and table row say "Not enough data" with the
  count. An absent bar is never a zero.
- If no week has enough answers, the accuracy chart is replaced by a sentence
  saying so.
- These are what happened in saved answers. They are not a forecast.

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
- Practice answers (recognition, typing, cloze, listening) now count
  too, both correct and wrong: they feed the recent window, the latest answer
  and the recovery below. A wrong practice answer never adds to "forgotten on
  separate days", so practising hard cannot make a word harder to leave.
- **Recovery.** A word leaves the list once it has shown it is remembered
  again: one point per day (an auto-graded correct answer is a whole point; a
  self-graded one is half, so two in a day make a point), 3 points for a
  Medium or Low word and 4 for a High one. A forgotten answer takes a point
  back; points expire after 30 days. Once a word has recovered, its old
  failures are erased, so a later slip re-enters lightly rather than carrying
  its whole past. The requirement is fixed when the word starts earning, so it
  does not move while the reviewer is working on it. Recovery progress is
  shown on the list and on each card in a weakest-words review; words that
  leave are named at the end of any session, and the page updates on the next
  open. On launch, the last 30 days of saved answers are used, so words that
  already qualify leave at once.
- **Overdue.** A word that has been remembered within the last week is no
  longer held for being overdue; the overdue reason returns if it then goes a
  week without being remembered again.

**Reviewing the weakest words** (`/review?focus=weak`) shows the words on this
list, weakest first, **whether or not they are due**. It can bring a word
forward, so a weak word may be reviewed early. It arrives with counting towards
mastery switched off, so by default an answer here records itself but leaves the
word's mastery, review date and FSRS state alone — the reviewer may switch
counting back on, and then the answer moves the word by exactly the same rules
as any other review. See [Choosing what to review](#choosing-what-to-review) below.

## Daily goal

Set in Settings and kept with the account (database version 5). Worked out in
[`shared/session-planner.ts`](../shared/session-planner.ts).

A goal is a yardstick, never a filter. It does not choose, hide, reorder or
reschedule a word, and it never touches a scheduling parameter. Words left
over when the goal is reached stay due, and the app says so.

| Figure | Definition |
| --- | --- |
| Reviews goal | Answers saved today (not undone) against the target number. |
| Time goal | Time on cards today (the same figure as in Review activity) against the target in minutes. |
| Reached | Every part that is set has been reached. With both set, both are needed. |
| Your pace | Mean time per card over the timed answers of the last 30 days. Used only from 5 timed answers up; below that no pace is assumed. |
| Estimated time for what is due | Words due now × your pace. Not shown without a pace. |
| Answers to reach the goal | The larger of: reviews still needed, and time still needed ÷ your pace (rounded up). Exact for a goal in reviews only; an estimate ("about") when it rests on time. Not shown when a time goal is open and there is no pace. |
| Beyond the goal | Words due now − answers to reach the goal, when that is positive. These words are still in the queue. |

"Today" is the account's calendar day, so progress starts again at local
midnight.

## Choosing what to review

The Review tab offers three choices, and each starts a fresh sitting:

| Choice | Words kept |
| --- | --- |
| Everything due | The whole queue: most overdue first, words with no date last. Cannot bring a word forward. |
| Weakest words | Words on the Weak words list, weakest first, due or not. |
| Select words | Exactly the words ticked in the picker, in the order ticked, due or not. Words at mastery 10 are not offered. |

The last two can take a word before its review date. The picker reuses the
Bank's word list, and a collection can be added to the ticks in one go.

**Counting towards mastery** is one switch in two places — beside the choices
and in Settings → Review — remembered per account and on the device. The choice
does not change which words a sitting holds; changing it mid-sitting applies
from the next card.

| Switch | What an answer does |
| --- | --- |
| On (default) | Mastery and review date move by the usual rules. FSRS advances too. |
| Off | The answer is recorded and counts towards accuracy, the streak and the daily goal, but mastery, the review date and the FSRS state are left exactly as they were. |

"Everything due" always counts, and is always counted when nothing has been
chosen. Weakest words arrives with the switch off; the reviewer may turn it back
on, and that becomes the remembered choice like any other.

## Confidence and calibration

With "Ask how sure I am before showing the answer" switched on (Settings),
each card asks for Low, Medium or High before its answer is shown. The rating
is stored beside the answer (database version 5).

- It is **never** used in place of the answer, and never changes what an
  answer does to mastery or the review date.
- It can only be given before the card's answer has been seen. After a flip,
  or for a card brought back by Undo, none is accepted: it would be hindsight.
- It is optional per card: flipping the card without choosing stores no rating.

Insights shows, for the last 30 days:

| Figure | Definition |
| --- | --- |
| Answers | Saved answers (not undone) that carried this rating. Answers given without a rating are not counted. |
| Remembered | How many of them were "Remember". |
| Share | Remembered ÷ Answers at that level, from 5 answers up; otherwise "Not enough data". |
| Sure but not remembered | High-confidence answers that were "Not remember". A count, not a score. |
| Unsure but remembered | Low-confidence answers that were "Remember". |

## Practice modes

The Practice page offers four further ways to work on a word. They are
**practice**: each answer is recorded (database version 6), and none of them
changes a word's mastery, its review date or its FSRS state. Only the
flashcard review on the Review tab moves the schedule. This is deliberate: the
review rules belong to the owner, and whether another mode should count as a
review is their decision to make, not the app's.

| Mode | Shows | Asks for | Judged by |
| --- | --- | --- | --- |
| Recognition | The word | Its meaning, among four | The server: right when the word's own meaning is chosen. |
| Typing | The meaning | The word, typed | The server, by the rules below. |
| Fill in the blank | Your example sentence with the word taken out | The word, typed | The server, by the same rules. |
| Listening (experimental) | Nothing: the word is read aloud | The word, typed | The server, by the same rules. |

"The meaning" is the Vietnamese meaning where there is one, otherwise the
definition. Every prompt, choice and sentence is your own text; nothing is
generated.

**What a word needs.** A word without what a mode needs is left out of that
mode, and the page says how many and why.

- Recognition, typing: a meaning or a definition. Recognition also
  needs three other words whose meaning reads differently, so that four
  distinct choices can be offered.
- Fill in the blank: an example sentence that contains the word exactly as it
  is entered, as a whole word. An inflected form in the sentence ("alleviated"
  for "alleviate") is not blanked, because the entry would be the wrong answer
  to it. Edit the example to use the word as entered to make it eligible.
- Listening: only the word, since it is read aloud.

**Recognition choices.** The three wrong choices are drawn at random from your
other words and the four are shuffled, so neither which are offered nor where
the right one sits follows a pattern. All four are the same kind of text
(meanings, or definitions), and no two read the same.

**Typed answers.**

| Verdict | When |
| --- | --- |
| Correct | The typed text is the word, ignoring letter case and spacing at the ends or doubled inside. |
| Accepted | The same letters, differing only in the kind of quote or dash, spaces around a hyphen, or punctuation at either end. |
| Not quite | Anything else. A misspelling, a missing accent, or a missing hyphen or space is never accepted. |

An entry written as alternatives separated by a slash ("colour / color")
accepts each of them, because that is your own list. Nothing else is treated
as an alternative.

**Figures** (Insights, "Practice by mode, last 30 days"):

| Figure | Definition |
| --- | --- |
| Answers | Practice answers recorded in that mode. |
| Correct | How many were right. |
| Share | Correct ÷ Answers in that mode, from 5 answers up. |

Modes are never added together or averaged: recognising a meaning and
producing a word are different skills. Practice is not part of Review
activity, streaks, the daily goal, weak words or calibration, all of which
count scheduled reviews only.

**Listening** is typing with a different question: the word is read aloud by
the browser instead of its meaning being shown, and what is typed is judged by
exactly the typed-answer rules above. It needs nothing from an entry but the
word. It is counted under its own name. The app has no audio of its own and
sends nothing anywhere for it; the voice is the device's.

## Practice mastery

Shown in a word's panel ("Practice mastery") and after each practice answer.
The rule is in [`shared/study-modes.ts`](../shared/study-modes.ts)
(`practiceMasteryOf`).

| | |
| --- | --- |
| What it is | For one word and one practice mode, a score from 0 to 3: **one point for every correct practice answer recorded for that word in that mode, stopping at 3.** A wrong answer adds nothing and takes nothing away. |
| Per mode | Recognition, typing, fill in the blank and listening each have their own score for each word. They are never added together. |
| Where it comes from | It is counted from the practice history each time it is shown. It is not a second number stored beside the history, so it cannot disagree with it, an answer sent twice counts once, and practice recorded before the score existed counts too. |
| What it is not | Review mastery. It never decides when a word is due, never hides a definition, never retires a word, and is not read by either schedule. Reviewing a word, or editing its review mastery, does not change it. |
| What changes it | Only a recorded practice answer. It cannot be edited by hand. An answer judged while saving is switched off is not recorded, so it is not counted. |
| When it is shown | Where practice is recorded (database version 6 or later). Elsewhere the section is left out rather than filled with zeros. |

## True Mastery

An evidence-based estimate (0–100) of demonstrated vocabulary knowledge,
computed from **practice history** across all modes. The algorithm is in
[`shared/true-mastery.ts`](../shared/true-mastery.ts) (`calculateTrueMastery`).
It is an **estimate**, not a ground-truth measurement, and the UI labels it as
such.

### What it uses

Only recorded practice answers that are still standing (not undone, not from
technical failures). Each answer provides:

| Field | Meaning |
| --- | --- |
| `correct` | `true` = correct, `false` = incorrect |
| `mode` | One of: recognition, typing, cloze, listening |
| `grading` | `auto` (server-judged). `self` appears only on legacy rows and is not written any more. |
| `reviewedOn` | The reviewer's calendar day (for recency) |
| `reviewedAt` | Full timestamp (for session ordering) |
| `sessionId` | Groups retries so repeated attempts in one sitting don't inflate evidence |

Answers with missing timestamps, future dates, or `grading` not in `{auto, self}`
are excluded. Practice is judged automatically; legacy self-graded rows are no
longer offered or recorded.

### Formula (per word)

For each practice mode `m`, collect its eligible answers `i`. Let:

- `y_i = 1` if correct, `0` if incorrect
- `d_i` = age of attempt `i` in days (from `reviewedOn` to today)
- `h` = recency half-life (default 30 days)

**Recency weight:** `r_i = 2^(-d_i / h)`

**Weighted evidence per mode:**
- `S_m = Σ r_i y_i` (weighted correct)
- `F_m = Σ r_i (1 - y_i)` (weighted incorrect)
- `n_eff,m = Σ r_i` (effective evidence count)

**Beta smoothing** (prior α=2, β=2):
- `P_m = (α + S_m) / (α + β + S_m + F_m)` — smoothed accuracy (0–1)

**Confidence** (evidence-strength heuristic, not a calibrated probability):
- `c_m = n_eff,m / (n_eff,m + k)` with `k = 5`

**Mode weights** (evidence strength defaults):
- Recognition: 0.15, Typing: 0.30, Cloze: 0.25, Listening: 0.10

**Aggregate True Mastery:**
```
T = 100 * (Σ a_m c_m P_m) / (Σ a_m c_m)
```
where `a_m` is the mode weight. Modes with no evidence are **excluded** from the
sum (not treated as zero).

**Session cap:** Within one session, at most the last answer counts, and the
total effective evidence per session is capped at 3 (default), so unlimited
retries cannot create unlimited confidence.

### Evidence coverage

| Level | Condition |
| --- | --- |
| Insufficient data | No practice answers at all, or all filtered out |
| Low evidence | `n_eff ≥ 1` |
| Moderate evidence | `n_eff ≥ 5` AND ≥ 2 modes with evidence |
| High evidence | `n_eff ≥ 15` AND ≥ 3 modes with evidence |

Coverage reflects both **quantity** and **diversity** of practice. A word with
30 typing answers but no other mode gets "Low evidence", not "High".

### What True Mastery is NOT

| Not this | Why |
| --- | --- |
| Review Mastery (0–10) | That is the scheduler's state; True Mastery uses practice evidence only. |
| FSRS Predicted Recall | That estimates recall probability at a moment; True Mastery summarizes demonstrated practice performance. |
| Practice Mastery (0–3 per mode) | That counts correct answers per mode; True Mastery combines modes with recency, smoothing, and confidence. |
| Overdue penalty | Being overdue does not directly lower True Mastery; it only affects review priority. |

### Display

| Element | Meaning |
| --- | --- |
| Score (0–100) | `T` from the formula above; `—` when insufficient data |
| Tier | Excellent (≥90), Strong (≥75), Good (≥60), Developing (≥40), Weak (≥20), New (<20), Unknown (insufficient data) |
| Evidence label | "Insufficient data", "Low evidence", "Moderate evidence", "High evidence" |
| Per-mode breakdown | Accuracy, effective evidence, confidence, weight, correct/incorrect counts, last attempt |

### Limitations

- **Not a calibrated probability.** `T/100` is not the chance of remembering tomorrow.
- **History gaps.** Practice before the database supported it (schema version < 6) is not available. Legacy history without reliable correctness is not fabricated.
- **Listening depends on device speech synthesis.** Quality varies.
- **Thresholds are heuristic.** The coverage tiers and weight defaults are starting points, not validated constants.

### Changing the model

All tunable parameters live in `DEFAULT_TRUE_MASTERY_CONFIG` in
`shared/true-mastery.ts`:

```ts
recencyHalfLifeDays: 30,
priorAlpha: 2,
priorBeta: 2,
confidenceK: 5,
minEvidenceLow: 1,
minEvidenceModerate: 5,
minEvidenceHigh: 15,
minModesModerate: 2,
minModesHigh: 3,
modeWeights: { recognition: 0.15, typing: 0.30, cloze: 0.25, listening: 0.10 },
sessionMaxEffectiveEvidence: 3,
```

Changing them affects all words immediately; no migration is needed because the
model is computed on the fly from raw history.

### Empirical validation protocol

To validate the model against an independent delayed-recall test:

1. Select a cohort of words with **High evidence** True Mastery.
2. After a fixed delay (e.g., 7 days) without review, test recall.
3. Compare True Mastery score bands (e.g., 80–100, 60–80, 40–60, 20–40, 0–20)
   against observed recall rates.
4. Report calibration curves and Brier scores.
5. Iterate weights, half-life, or priors only after such validation.

Until validated, treat True Mastery as a **heuristic for prioritising study**,
not a scientific measurement.

## Estimated recall (FSRS)

Settings → Scheduling, "Estimated recall now", for words FSRS has seen.

| | |
| --- | --- |
| What it is | FSRS's own estimate of the probability that the word would be recalled if it were asked at this moment: the library's `get_retrievability` for the word's stored FSRS state. Nothing is computed by the app. |
| What it is not | A measurement. It is not Accuracy or Retention above, which count what actually happened, and the two are never shown as the same thing. |
| When it is shown | Only for a word with a valid FSRS state that has been answered at least twice since FSRS started being calculated (`MIN_REVIEWS_FOR_ESTIMATE`). Otherwise: "Too early to say". |
| How it is shown | "about N%", a whole percent. |
| What moves it | Time since the last answer, and the stability FSRS has worked out from the answers. The target retention does not: the target decides how far the estimate may fall before the word is due. On the day a word falls due the estimate is, by construction, about the target. |
| Limits | FSRS runs with the library's default parameters, not ones fitted to this reviewer. Two answers are a floor for showing a figure, not a claim that it is accurate. |

## Trying FSRS on the saved answers

Settings → Scheduling, "Try it on your saved answers". Worked out on request by
[`shared/scheduler/simulation.ts`](../shared/scheduler/simulation.ts); it reads
only, stores nothing, and moves no date.

**What goes in.**

- Every live word that mastery has not retired, with its mastery review date
  as it stands.
- The saved flashcard answers that still stand. Left out, and counted on
  screen: answers taken back with Undo (and the undo records), practice
  answers, and answers to words now retired or in the trash.

**The two columns.**

| Column | How it is obtained |
| --- | --- |
| Mastery schedule | The live schedule. Nothing is simulated. |
| FSRS at N% | Each word's saved answers are given to FSRS in order, at the moments they were saved, with Remember as "Good" and Not remember as "Again", at the target retention chosen. The word enters as a new card at its first saved answer. |

At the account's own target this reproduces the FSRS state the app stored at
the time (tested). At another target it shows what FSRS would have arrived at
from the same answers.

**Assumptions, all shown on screen.**

- Nothing is assumed about reviews from before the history began (2026-10-10).
- A word with no saved answer gets no FSRS state. It is shown staying on its
  mastery date, which is also what happens to it if FSRS is put in charge.
- The fewer answers a word has, the rougher its FSRS date.

**The tables.**

| Table | Definition |
| --- | --- |
| When each word next falls due | Each active word counted once, on the day it next falls due under each schedule: today or earlier, the next 7 days, days 8 to 29, later. No future answer is assumed. |
| Reviews in the next 30 days, if you remembered every word | A stated scenario: every review is answered Remember on the day it falls due, and the next date comes from the real rule (mastery: the configured rules; FSRS: the library). Mastery rises and retires words under both. |
| Word by word | The two next dates and the difference in days, soonest by FSRS first, at most 200 words. |

The scenario shows how each schedule **spaces** reviews. It is not a forecast
of workload (forgetting brings words back sooner under both, so real numbers
are higher) and says nothing about how well anything would be remembered. The
app does not test, and does not claim, that either schedule leads to better
retention: that would need a comparison it has no data for.
