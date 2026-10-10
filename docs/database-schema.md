# Notion database schema

Read from the live database on 2026-10-10 with `npm run notion:inspect` and a
read-only look at its rows and default template. Nothing here is assumed: a
property that is not in this table does not exist in the database.

- Database: "Vocabulary", with a single data source of the same name.
- Rows at the time of inspection: 43.
- The app never changes this schema. It creates no properties and edits no
  formulas, views, buttons or templates.

## Properties

| Property | Type | What it holds | Used by the app | Editable in the app |
| --- | --- | --- | --- | --- |
| Word | title | The vocabulary word. Never empty; longest is 15 characters. | Everywhere | Yes |
| Vietnamese Meaning | text | The meaning in Vietnamese. | Card back, bank, add form | Yes |
| Definition | text | English definition. | Bank, add form; shown on cards through "Review Definition" | Yes |
| Example Sentences | text | Example usage. | Bank, add form; shown on cards through "Review Example" | Yes |
| Date Added | date | The day the word was added. Date-only on every row; equal to the row's creation day on 42 of 43. | Dashboard, calendar, bank, insights | Yes |
| Mastery | number | Review level, 0 to 10. Values when inspected: 2 to 8, whole numbers. 10 means mastered. | Everywhere | Only through reviewing, or the explicit "Review schedule" section of the word panel |
| Review Date | date | When the word is next due. Date-only on every row. | Review queue, dashboard, bank | Same as Mastery |
| Due for Review | formula | `prop("Mastery") < 10 and (empty(prop("Review Date")) or dateStart(prop("Review Date")) <= today())` | Not read; the app applies the same rule itself (see review-logic.md, section 2) | No (computed) |
| Review Definition | formula | `if(prop("Mastery") <= 5, prop("Definition"), "")` | Card back | No (computed) |
| Review Example | formula | `if(prop("Mastery") <= 5, prop("Example Sentences"), "")` | Card back | No (computed) |
| Expired | formula | `formatDate(prop("Review Date"), "YYYY-MM-DD") <= formatDate(now(), "YYYY-MM-DD")` | Not used | No (computed) |
| Answer Shown | checkbox | Unchecked on every row. Purpose not confirmed. | Not used; never written | No |
| Nhớ | button | "Remember". Steps are not readable through the API. | Reproduced by the Remember answer (review-logic.md, section 5) | — |
| Không nhớ | button | "Not remember". Steps not readable. | Reproduced by the Not remember answer | — |
| Hiện đáp án | button | "Show answer". Steps not readable. | Not used | — |

There are **no** properties for part of speech, pronunciation, synonyms,
antonyms, topic, tags, source or notes, and no relations or rollups. The app
offers no fields for them. Adding any of these would mean creating a new Notion
property, which is left for the owner to decide.

Text in the four text properties is plain on every row today (no bold, links or
line breaks). If a field is given formatting in Notion later, the word panel
warns that editing that field in the app saves it as plain text. Fields that
are not changed in an edit are never rewritten.

## Views

| View | Type | Filter | Sort |
| --- | --- | --- | --- |
| All Vocabulary | table | none | Date Added, descending |
| Mastered Words | table | Mastery = 10 | Word, ascending |
| Need review | table | Due for Review is checked | Review Date, ascending |
| Date added | calendar | none | none |

## Template

The database has one template, "New page", set as the default. Its property
values are:

- Mastery: **1**
- Review Date: empty
- Date Added: empty
- Answer Shown: unchecked
- no page content

This is where the app's defaults for a new word come from
(`newWordDefaults` in `config/review.config.ts`): **Mastery 1 and no Review
Date**, which the "Due for Review" formula treats as due immediately. Both are
shown in the Add form and can be changed per word.

Two things differ from what the feature brief expected, and the database was
followed in both:

- New words start at Mastery **1**, not 0. No row in the database is below 1.
- Date Added is set by the app to today's date in `REVIEW_TIMEZONE`. The
  template leaves it empty, but existing rows carry their creation day, so
  that is the convention the app keeps.

The app writes these values itself rather than asking Notion to apply the
template, so a later change to the template is not picked up automatically;
update `newWordDefaults` if you change it.

## What each operation writes

| Operation | Notion call | Properties written |
| --- | --- | --- |
| Remember / Not remember | update page | Mastery and/or Review Date, whichever changes |
| Add vocabulary | create page in the data source | Word, Mastery, and any of Vietnamese Meaning, Definition, Example Sentences, Date Added, Review Date that were given |
| Edit a word | update page | Only the fields whose value changed |
| Edit the review schedule | update page | Mastery and/or Review Date, only from the explicit schedule section |
| Delete a word | update page (`in_trash: true`) | None; the page moves to Notion's trash and can be restored for 30 days |
| Undo delete | update page (`in_trash: false`) | None |

Every write first confirms that the page is a row of this data source.
Requests naming any other property are rejected before Notion is contacted.

## Permissions the connection needs

| Capability | Needed for |
| --- | --- |
| Read content | Everything |
| Update content | Reviewing, editing, deleting and restoring |
| Insert content | **Adding vocabulary.** Without it Notion refuses the request and the Add form shows "The Notion integration is not allowed to do this." |

No comment or user-information capability is used.

## Not verifiable from outside Notion

- What the three buttons do (see review-logic.md for how the two answer
  buttons were specified).
- Whether the template fills Date Added or Review Date with a dynamic value
  such as "today"; the API reports both as empty.
- Any database automations. None is visible through the API.
