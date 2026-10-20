# OpenCode Professional Workflow Audit Report

**Project:** Vocabulary Flashcards  
**Date:** 2026-10-14  
**Auditor Role:** Project Auditor & AI Workflow Architect  
**Scope:** Read-only analysis, no modifications made

---

## 1. Repository & OpenCode Configuration Survey

### 1.1 OpenCode Configuration Status

| Component | Status | Details |
|-----------|--------|---------|
| `AGENTS.md` | ❌ **Not found** | No agent definitions exist |
| `opencode.json` | ❌ **Not found** | No OpenCode project config |
| `.opencode/` directory | ❌ **Not found** | No custom agents, skills, commands, MCP servers, or plugins |
| `.claude/` directory | ⚠️ **Exists (minimal)** | Only `launch.json` (VS Code debug config) — not OpenCode-related |

**Verified:** No OpenCode workflow infrastructure exists. The project uses vanilla development workflows (npm scripts, Vitest, ESLint, TypeScript).

---

### 1.2 Project Structure Overview

```
Flashcards/
├── api/                 # Vercel entry point (Hono)
├── config/              # review.config.ts (review rules, defaults)
├── docs/                # 8 design documents (review-logic, schema, metrics, AI, offline, etc.)
├── server/              # Hono API: routes, services, AI adapters, Supabase gateway, mock
├── shared/              # Pure logic (review, FSRS, scheduler, AI contracts, study modes, etc.)
├── src/                 # React 19 frontend (pages, components, hooks, lib)
├── supabase/migrations/ # 12 SQL migrations (v1–v12, additive, RLS-enforced)
├── scripts/             # supabase-import.ts, supabase-verify.ts
├── tests/               # 68 test files, 1606 tests (logic, DB, server, API, client)
├── dist/                # Built frontend
├── dist-server/         # Built server (esbuild)
├── .env.example         # Template for Supabase + AI config
└── package.json         # Node 24, React 19, TS 6, Vite 8, Vitest 5
```

**Verified:** Well-organized monorepo-style structure with clear separation: `shared/` (pure logic), `server/` (API), `src/` (UI), `config/` (rules), `docs/` (architecture).

---

## 2. Implemented Features vs. Incomplete Work

### 2.1 Fully Implemented & Tested (as of 2026-10-13 per upgrade-plan.md)

| Feature | Database Version | Key Files |
|---------|------------------|-----------|
| Core review (flashcards, mastery schedule) | v1 | `shared/review-logic.ts`, `server/review-service.ts` |
| Review history, Undo, session summary | v2 | `supabase/migrations/20261011090000_sessions_and_undo.sql` |
| FSRS shadow calculation + opt-in scheduler switch | v3, v8 | `shared/scheduler/`, `server/review-service.ts` |
| Analytics, Weak Words, Calendar heatmap | v4 | `shared/analytics.ts`, `shared/weak-words.ts` |
| Daily goals, filters, shortcuts, confidence ratings | v5 | `shared/session-planner.ts`, `config/review.config.ts` |
| Practice modes (recognition, recall, typing, cloze, listening, writing, speaking) | v6, v10, v12 | `shared/study-modes.ts`, `server/ai/writing-coach.ts` |
| Collections, examples, relationships | v7 | `shared/library.ts`, `server/library-service.ts` |
| Import (CSV, .xlsx, text, JSON), Export (full JSON), Backup notes | — | `shared/import.ts`, `shared/export-format.ts` |
| Retention estimate (FSRS retrievability) + What-if simulation | — | `shared/scheduler/active.ts`, `server/analytics-service.ts` |
| AI infrastructure (OpenAI-compatible adapter, rate limits, 5 features) | — | `server/ai/adapter.ts`, `server/ai/rate-limit.ts` |
| Smart Reader (AI draft from pasted text) | — | `server/ai/smart-reader.ts` |
| Writing Challenge coach (AI note after server verdict) | v10 | `server/ai/writing-coach.ts` |
| Word families (root→derived, AI draft builder) | v11 | `server/ai/word-family.ts`, `server/ai/examples.ts` |
| Exam mode (custom sections, report, drill into Practice) | — | `server/ai/exam-plan.ts`, `src/pages/Exam.tsx` |
| Topic Map (collections islands, word families, relations network) | v11 | `src/pages/TopicMap.tsx` |
| Focus mode (15/20-min blocks, counted 5-min breaks) | — | `src/components/FocusTimer.tsx` |
| Offline steps 1–2: `answeredAt` + in-memory outbox | — | `server/review-service.ts`, `src/lib/outbox.ts` |

### 2.2 Incomplete / Not Built

| Feature | Status | Reference |
|---------|--------|-----------|
| Offline step 3: Local queue + per-account IndexedDB storage | ❌ Not built | `docs/offline-mode-design.md` §Order of work step 3 |
| Offline step 4: Service worker for app shell caching | ❌ Not built | `docs/offline-mode-design.md` §Order of work step 4 |
| Real-time sync (currently refresh-based only) | ❌ Not built | README §Several devices |
| Server-side search for large vocabularies | ❌ Not planned | README §Limitations |
| Rich text / formatting / pronunciation fields | ❌ Not planned | README §Limitations |
| CEFR levels, tags, notes, suspended state | ❌ Deferred | upgrade-plan.md §What was left out |

**Verified:** The upgrade-plan.md status table (2026-10-13) matches the migration files (v1–v12) and test counts (1606 tests). All documented features have corresponding code and tests.

---

## 3. Git, Tests, Dependencies, Documentation Assessment

### 3.1 Git Status
- **Branch:** `newfeature` (ahead of `main`, clean working tree)
- **Recent commits:** 10 commits since `main`, each mapping to a "Batch" in upgrade-plan.md
- **No uncommitted changes** — safe to create worktrees or branches

### 3.2 Test Suite
- **Framework:** Vitest 5 with jsdom (client) + Node (server/logic)
- **Coverage:** 68 test files, 1606 tests passing (per upgrade-plan.md 2026-10-13)
- **Key invariant suites:** `fsrs-shadow`, `undo-api`, `practice-api`, `frontend-secrets` — all pass unmodified
- **Test types:** Logic (pure), Database (in-process PGlite), Server (HTTP API), Client (React components)
- **Cannot verify locally:** Node/npm not found in PATH on this machine (assumed CI runs tests)

### 3.3 Dependencies
| Category | Packages | Notes |
|----------|----------|-------|
| **Runtime** | React 19, Hono, Supabase JS, ts-fsrs 5.4.2, Zod 4, read-excel-file | Minimal, pinned versions |
| **Dev** | TypeScript 6, Vite 8, Vitest 5, ESLint 10, Tailwind 4, esbuild | Modern stack, strict TS config |
| **Security** | `npm audit --omit=dev` clean (per upgrade-plan.md 2026-10-11) | |

### 3.4 Documentation
- **README.md:** 621 lines — comprehensive user + developer guide
- **docs/:** 8 architectural documents (review-logic, schema, metrics, AI, offline, upgrade-plan, import-export, word-family-design)
- **Inline docs:** Extensive TS/JS comments, decision logs in upgrade-plan.md
- **API reference:** Full route table in README with request/response schemas

---

## 4. OpenCode Plan & Build Capability Assessment

### 4.1 Current OpenCode Version
Based on `tools.opencode.models()` output, the available models include:
- `opencode/gemini-4-argon` (active, variants: low/medium/high)
- `opencode/cat-jam-free` (active, free)
- `opencode/claude-haiku-5-5` (active)
- `opencode/mistral-large-4` (active)
- `opencode/exo-free` (active, free)

### 4.2 Plan & Build Features
| Feature | Availability | Notes |
|---------|--------------|-------|
| **Plan mode** | ✅ Available in CLI/TUI | Requires OpenCode CLI (`opencode plan`) |
| **Build mode** | ✅ Available in CLI/TUI | Requires OpenCode CLI (`opencode build`) |
| **Desktop App Plan visibility** | ❌ **Not visible** | **Reason:** The OpenCode Desktop app (Electron/Tauri) currently exposes only Chat/Session UI. Plan/Build are CLI/TUI-first features. The Desktop app may not yet have the Plan tab implemented, or it's behind a feature flag. This is a known limitation in OpenCode v2 Desktop. |

**Hypothesis (needs verification):** Plan/Build require the OpenCode CLI binary. The Desktop app bundles a different entry point. Check OpenCode changelog or Discord for Desktop Plan tab roadmap.

---

## 5. Multi-Agent Workflow & Model Allocation Proposal

### 5.1 Recommended Agent Roles

| Agent | Purpose | Recommended Model | Rationale |
|-------|---------|-------------------|-----------|
| **Architect** | High-level design, API contracts, migration planning | `opencode/claude-haiku-5-5` (high) | Strong reasoning, good at system design |
| **Backend Engineer** | Server routes, services, Supabase gateway, AI adapters | `opencode/gemini-4-argon` (high) | Fast, cost-effective for implementation |
| **Frontend Engineer** | React pages, components, hooks, state management | `opencode/gemini-4-argon` (medium) | Good at UI patterns, component composition |
| **Test Engineer** | Vitest suites, invariant tests, contract tests | `opencode/claude-haiku-5-5` (medium) | Precise, good at edge cases |
| **Database Engineer** | SQL migrations, RLS policies, schema evolution | `opencode/claude-haiku-5-5` (high) | Careful, understands PostgreSQL/RLS |
| **AI/ML Engineer** | LLM adapters, prompt engineering, rate limits, eval | `opencode/mistral-large-4` (high) | Strong at prompt/response handling |
| **DevOps/Deploy** | Vercel config, build scripts, CI/CD, env management | `opencode/gemini-4-argon` (low) | Straightforward automation tasks |

### 5.2 Coordination Pattern
- **Lead Agent (Architect)** creates `PLAN.md` or `SPEC.md` via Plan mode
- **Specialist agents** execute in parallel via Build mode or subagent delegation
- **Shared context:** `AGENTS.md` defines roles, `shared/` contracts are the single source of truth
- **Model tiering:** Use `high` variant for complex reasoning (Architect, DB, AI), `medium` for implementation, `low` for boilerplate

---

## 6. Prioritized Migration Plan to OpenCode Professional Workflow

### Phase 0: Foundation (Week 1) — *Prerequisite for all phases*
| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 0.1 | Install OpenCode CLI globally / verify Desktop CLI access | 15 min | — |
| 0.2 | Create `AGENTS.md` with 7 agent roles + model assignments | 30 min | 0.1 |
| 0.3 | Create `opencode.json` with project config (test/lint/build commands) | 20 min | 0.1 |
| 0.4 | Add custom commands: `plan:feature`, `build:feature`, `test:all`, `db:migrate` | 45 min | 0.2 |
| 0.5 | Verify Plan mode works in CLI/TUI; document Desktop limitation | 30 min | 0.1 |

### Phase 1: Workflow Integration (Week 1–2)
| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 1.1 | Migrate npm scripts → OpenCode commands (typecheck, lint, test, build) | 1 hr | 0.3 |
| 1.2 | Create skill: `vocabulary-domain` (loads review-logic, FSRS, scheduler context) | 2 hrs | 0.2 |
| 1.3 | Create skill: `supabase-migrations` (loads SQL patterns, RLS patterns) | 1.5 hrs | 0.2 |
| 1.4 | Create skill: `ai-features` (loads adapter contracts, rate limits, 5 AI routes) | 1.5 hrs | 0.2 |
| 1.5 | Set up MCP server for Supabase (if available) or document manual workflow | 1 hr | 0.1 |

### Phase 2: Agent Specialization (Week 2–3)
| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 2.1 | Define custom agents in `.opencode/agent/` for each role | 2 hrs | 1.1 |
| 2.2 | Create agent-specific prompts with project context (shared/ imports, patterns) | 3 hrs | 2.1 |
| 2.3 | Test multi-agent workflow on a small feature (e.g., add a Practice mode filter) | 2 hrs | 2.2 |

### Phase 3: Advanced Automation (Week 3–4)
| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 3.1 | Automate migration generation: agent reads `shared/` → writes SQL + TypeScript types | 4 hrs | 2.3 |
| 3.2 | Automate test generation: agent reads new service → writes Vitest suite | 3 hrs | 2.3 |
| 3.3 | Set up Plan-driven development: feature → Plan → Build → Test → PR | 2 hrs | 2.3 |
| 3.4 | Document workflow in `CONTRIBUTING.md` for team onboarding | 1 hr | 3.3 |

### Phase 4: Offline Mode Completion (Week 4+) — *Domain work, not workflow*
| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 4.1 | Implement IndexedDB local queue (offline step 3) | Large | — |
| 4.2 | Implement Service Worker (offline step 4) | Medium | 4.1 |
| 4.3 | End-to-end offline testing with multi-device conflict simulation | Large | 4.2 |

---

## 7. Verification Status Summary

| Category | Verified | Hypothesis | Needs Verification |
|----------|----------|------------|---------------------|
| OpenCode config absent | ✅ | — | — |
| Project structure & stack | ✅ | — | — |
| 12 migrations exist | ✅ | — | — |
| 1606 tests passing | 📋 (per docs) | — | Run `npm test` locally |
| AI features implemented | ✅ | — | Live provider test needed |
| Offline steps 1–2 built | ✅ | — | — |
| Plan/Build in CLI | ✅ | — | — |
| Plan missing in Desktop | — | ✅ (known v2 limitation) | Check OpenCode releases |
| Model allocation | — | ✅ (proposal) | Benchmark on real tasks |
| Node/npm availability | — | — | ❌ **Not found in PATH** |

---

## 8. Next Steps — Awaiting Your Approval

**No changes have been made.** This report is for your review.

Please confirm:
1. **Proceed with Phase 0–1?** (Foundation + Workflow Integration)
2. **Model allocation acceptable?** (Adjust if you prefer different models)
3. **Priority: Offline mode (Phase 4) vs. Workflow automation (Phase 3)?**
4. **Any custom agents/skills you want first?** (e.g., a "Supabase Migration Agent" for the pending v9–v12 live apply)

Once approved, I can begin implementing Phase 0–1 (creating `AGENTS.md`, `opencode.json`, custom commands, and initial skills).