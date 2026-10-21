# Prioritised Execution Roadmap — post FC-MGMT-001

> Sequencing only — **priorities are not commitments** (Blueprint §9). PO keeps final acceptance authority,
> and every stage gate that needs a decision points at the [decision register](gap-and-decision-register.md).
> Requirement IDs refer to the [traceability matrix](requirements-traceability.md).
>
> **Done in FC-MGMT-001 (this task):** navigation restructure to the four approved areas + Home
> `Continue`/`Quick actions` (D-01/D-10 → items C1, C2); Focus Test on Exam + optional 25-min Pomodoro
> block (items C5, C6); word-family edge-direction guidance in the AI prompt (D-07 → item B7);
> real-browser verification of **all** G-02 surfaces (item A2 → done) and a local deploy drill
> against the production artifacts (A1b drill — the hosted deploy itself is G-17, blocked).

## Ordering principles

1. Follow Blueprint §9's approved priority order: vocabulary foundation → Maps & Discovery →
   Learning Intelligence → Learning Experience → cross-domain integration/QA.
2. **Verify before building** — Stage A closes the UNVERIFIED overlays first, because every later “ready” claim rests on them.
3. **Spec & decision before implementation** — items with OPEN_DECISION never start before their decision closes.
4. No schema changes, navigation redesign, Review/FSRS/Undo/Practice changes, paid services, or remote migrations
   without the corresponding approval gate (§12).

---

## Stage A — Finish & verify what is already built (priorities 1–2, “end of the road”)

| # | Item | Closes | Needs | Effort |
| --- | --- | --- | --- | --- |
| A1 | Run & verify migrations **v13–v19 on hosted Supabase**, record checksums/migration state | **G-01** (UNVERIFIED → PASS_VERIFIED) | **PO approval for remote migration** (BLOCKED) | S (once approved) |
| A2 | ~~Real-browser verification pass~~ **DONE** — every G-02 checklist item executed in a real browser this task (verification-record §4b–§4d): audio plays, transcript seek/restore, graph render/zoom/pan/keyboard | **G-02 CLOSED** | — | done |
| A1b | **Deploy to Vercel** (config ready in `vercel.json`; drill executed against the production artifacts) | **G-17** (BLOCKED — needs PO: hosting account/token, hosted Supabase env, AI key; runs after A1) | **PO credentials** | S once supplied |
| A3 | PO walk-through of the traceability matrix (95 rows) + accept/reject the documented limits in D-06 | §14 criterion, **D-06** | PO time | S |
| A4 | Apply PO verdicts from A3 to the matrix/register (statuses only change with new evidence) | maintenance | — | S |

**Stage-A exit:** no UNVERIFIED overlays remain (or they are explicitly accepted in writing by PO).

## Stage B — Learning Intelligence (priority 3, Blueprint's declared next stage)

Gate: **D-08 (spec approval)** first; D-04 and D-05 answered inside that spec.

| # | Item | Matrix ref | Depends on | Effort |
| --- | --- | --- | --- | --- |
| B1 | Approve spec: 4 evidence dimensions (Recognition/Recall/Usage/Flexibility) as *evidence descriptions* — explicitly not new schedulers | D1, D7a | **D-08** | spec S, build L |
| B2 | Error Log (editable) — scope reconciled with Weak Words | D2 | **D-04** | M |
| B3 | Suggested + Self-directed learning paths | D5 | **D-05** | M–L |
| B4 | Session Insights beyond the current session summary | D6.1 | D-08 | M |
| B5 | Vocabulary Coverage view | D6.3 | D-08 | M |
| B6 | Bounded auto-adjustment — *only if* D-11 approves an explicit list; plus the pinning test “AI call ⇒ settings unchanged” | D4, D7c, G-09 | **D-11** | S test / M feature |
| B7 | ~~Resolve edge-direction convention for family maps~~ **DONE** — guidance states direction (D-07); server-side enforcement still optional if hand-drawn maps need it | A1.2 | D-07 decided | S (done) |
| B8 | Regression expansion around new intelligence features (boundary tests: exposure still ≠ mastery) | D7b | B1–B5 | M |

**Stage-B exit criteria (from Blueprint §9):** boundary tests prove Review/FSRS/Undo/Practice untouched;
every suggestion is explainable and user-accepted; no automatic adjustment outside an approved list.

## Stage C — Learning Experience & session orchestration (priority 4)

Gate: ~~D-01 (navigation decision)~~ **decided & implemented (hybrid, D-01(b))**; B-stage insights feed E3.3.

| # | Item | Matrix ref | Depends on | Effort |
| --- | --- | --- | --- | --- |
| C1 | ~~Restructure navigation~~ **DONE** — four approved groups hold all 13 destinations; pinned tests | E1 → PASS | D-01 decided | done |
| C2 | ~~Home: `Continue` + `Quick Actions`~~ **DONE** — Dashboard retitled Home, two blocks, tested | E2 → PASS | D-10 decided | done |
| C3 | AI Suggested sessions (beyond exam plan) | E3.3 | D-11, stage-B insights | M |
| C4 | Combined-activity sessions (if approved) | E5.2 | **D-12** | M |
| C5 | ~~Focus Test (exam focus mode)~~ **DONE** — Focus switch + timer on Exam, tested | E4.2 → PASS | — | done |
| C6 | ~~Pomodoro (optional)~~ **DONE** — 25-min block on the focus timer, tested | E4.3 → PASS | — | done |
| C7 | Preference-aware path/session suggestions | E5.5 | D-05, D-08 | M |

**Stage-C exit (Blueprint §9):** resume/continue works end-to-end; sessions combine activities without a forced
sequence; Review/Practice/Exam untouched.

## Stage D — Cross-domain integration, QA & release verification (priority 5)

| # | Item | Matrix ref | Depends on | Effort |
| --- | --- | --- | --- | --- |
| D-1 | Exhaustive duplicated-source-of-truth sweep (every derived view named & single-sourced) | F15, G-10 | stages B/C partial | M |
| D-2 | Expanded regression suite around new features | F-rows | stage B/C | M |
| D-3 | Documentation audit across older docs (`ai-features`, `review-logic`, `metrics`, README) vs final behaviour | G-16 | stages B/C | S |
| D-4 | Full gate run on target environment (types, lint, suite, build, pg-release, hosted) | §9 stage-D criteria | A1 | S |

## Independent quick wins (can run any time; no stage dependency)

| # | Item | Ref |
| --- | --- | --- |
| Q1 | PO answer on **Tags** (build or explicitly drop) | D-03 |
| Q2 | PO answer on **import limits** (accept documented limits vs approve PDF/transcription work) | D-06 |
| Q3 | PO answer on **item-type modelling** (keep implicit text vs nullable column) | D-02 |
| Q4 | Approve a small measurement set before any KPI becomes an acceptance criterion | D-09, §14 |
| Q5 | Adopt/refresh the browser-verification checklist produced in A2 as a standing release step | G-02 |

## What this task deliberately did NOT schedule

- No rewrite of Review/FSRS/Undo/Practice, no second scheduler, no new AI provider, no paid dependency,
  no schema change before D-02/D-03 — all gated by §12 approval rules. (The D-01 navigation restructure was
  the one deliberate, self-approved exception: it *implements* the already-approved Blueprint §6-5.)
- No dates or velocity promises: effort letters are relative sizing only (S < M < L), not estimates of calendar time.
