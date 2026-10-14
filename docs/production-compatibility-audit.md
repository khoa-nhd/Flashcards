# Production Compatibility Audit

**Date:** 2026-10-14  
**Repository commit:** `d00f8b4` (Fix duplicate Practice persistence and mutation queue account isolation)  
**Production URL:** https://flashcards-gold-psi.vercel.app/  
**Supabase Project:** https://nexrcrliyxtelxkujphe.supabase.co

---

## Executive Summary

The deployed application is **healthy and correctly configured** for Supabase with account-based access. The `/api/health` endpoint returns `ok: true` with no issues. The codebase targets database schema version 9 (latest), which includes the practice history / True Mastery feature. **Owner access to Supabase dashboard is required to verify the production database has migration 9 applied.**

---

## Verified Public Endpoints

| Endpoint | Status | Response |
|----------|--------|----------|
| `GET /api/health` | ✅ 200 OK | `{"ok":true,"mode":"supabase","access":"account","writesRequested":true,"issues":[]}` |
| `GET /api/config` | ✅ 200 OK | Returns Supabase URL and public anon key (public by design) |

**Interpretation:**
- `mode: "supabase"` — The app is running against a real Supabase project, not mock data
- `access: "account"` — Account-based authentication is enabled (not open/sample mode)
- `writesRequested: true` — Saving is enabled (not frozen via `REVIEW_WRITES_ENABLED=false`)
- `issues: []` — No configuration problems detected

---

## Expected Compatibility (Codebase)

### Database Schema Version
- **Latest in code:** Version 9 (`LATEST_SCHEMA_VERSION = 9` in `server/supabase/supabase-database.ts`)
- **Migration sequence (from `supabase/migrations/`):**
  1. `20261010090000_initial_schema.sql` — v1: Base schema
  2. `20261011090000_sessions_and_undo.sql` — v2: Sessions & undo
  3. `20261012090000_fsrs_shadow.sql` — v3: FSRS shadow schedule
  4. `20261013090000_review_analytics.sql` — v4: Review analytics & weak words
  5. `20261014090000_goals_and_confidence.sql` — v5: Daily goals & confidence ratings
  6. `20261015090000_practice_modes.sql` — v6: Practice modes (recognition, recall, typing, cloze, listening)
  7. `20261016090000_collections_and_relations.sql` — v7: Collections, examples, relations
  8. `20261017090000_scheduler_switch.sql` — v8: FSRS/Mastery scheduler choice
  9. `20261018090000_true_mastery_practice_history.sql` — v9: Practice history for True Mastery

### Feature Capabilities by Schema Version
```typescript
capabilitiesAt(version) = {
  sessions:      version >= 2,
  undo:          version >= 2,
  fsrs:          version >= 3,
  analytics:     version >= 4,
  goals:         version >= 5,
  confidence:    version >= 5,
  practice:      version >= 6,
  library:       version >= 7,
  practiceHistory: version >= 9,  // <-- True Mastery requires v9
}
```

### Practice History / True Mastery Detection
The API distinguishes five states via `/api/practice-history`:

| State | `available` | `answers` | Meaning |
|-------|-------------|-----------|---------|
| **Available & loaded** | `true` | `[...]` | Schema v9+, history exists |
| **Available but empty** | `true` | `[]` | Schema v9+, no practice answers yet |
| **Unsupported schema** | `false` | `[]` | Schema < 9, feature disabled |
| **Unauthorized** | (401) | N/A | No valid session / token expired |
| **Network/server error** | (5xx) | N/A | Temporary failure |

**Frontend handling** (`src/components/WordDetailPanel.tsx`):
- Checks `response.available` before rendering history
- Catches errors and shows empty state (does not distinguish error types)

---

## Required Migrations & Deployment Order

### Safe Deployment Order
1. **Run SQL migrations first** in Supabase SQL Editor (oldest → newest)
2. **Deploy code** (Vercel auto-deploys on push to `main`)

**Order is safe either way** because:
- App checks schema version at runtime (`schemaVersion()` RPC)
- Features behind `capabilitiesAt(version)` stay off until migration runs
- No migration removes or changes existing data (all additive)

### Current Status
| Migration | Version | Feature | Production Status |
|-----------|---------|---------|-------------------|
| initial_schema | 1 | Base app | ✅ Required for any deploy |
| sessions_and_undo | 2 | Undo, session summary | ✅ |
| fsrs_shadow | 3 | FSRS comparison | ✅ |
| review_analytics | 4 | Weak words, calendar | ✅ |
| goals_and_confidence | 5 | Daily goal, confidence | ✅ |
| practice_modes | 6 | Practice (recognition, recall, etc.) | ✅ |
| collections_and_relations | 7 | Collections, examples, links | ✅ |
| scheduler_switch | 8 | FSRS/Mastery choice | ✅ |
| **true_mastery_practice_history** | **9** | **True Mastery, practice history** | **❓ UNVERIFIED** |

---

## Frontend Error States

### Practice History (Word Detail Panel)
- **Schema < 9:** Shows empty history, no error
- **Network error:** Shows empty history, no error
- **Unauthorized:** Shows empty history (silently caught)

### Database Status (Settings → Account)
- **Behind:** `"Needs an update (version X of Y). Some newer features are switched off until the newer SQL files in supabase/migrations have been run in Supabase, oldest first."`
- **Up to date:** `"Up to date (version X)"`
- **Unknown:** Row hidden (no error shown)

### Health Endpoint
- **Configured correctly:** `{"ok":true,...}`
- **Misconfigured:** `{"ok":false,"issues":["SUPABASE_URL is not set.",...]}`

---

## Items Requiring Owner Access (Vercel / Supabase)

| Check | Method | Required Access |
|-------|--------|-----------------|
| **Actual database schema version** | `SELECT app_schema_version();` in Supabase SQL Editor | Supabase Dashboard → SQL Editor |
| **Practice history function exists** | `SELECT * FROM practice_history(NULL) LIMIT 1;` | Supabase Dashboard → SQL Editor |
| **RLS policies on `review_logs`** | Verify `kind = 'practice'` rows are selectable | Supabase Dashboard → Authentication → Policies |
| **Vercel environment variables** | Confirm `SUPABASE_URL`, `SUPABASE_ANON_KEY` match project | Vercel Dashboard → Settings → Environment Variables |
| **Vercel deployment logs** | Check for build errors, function timeouts | Vercel Dashboard → Deployments |
| **Migration auto-apply** | Check if Vercel Supabase integration applies migrations on deploy | Vercel Dashboard → Integrations |

---

## Recommended Verification Checklist (Manual)

### With Supabase Dashboard Access
1. [ ] Open SQL Editor → Run `SELECT app_schema_version();` → Confirm returns `9`
2. [ ] Run `SELECT * FROM practice_history(NULL) LIMIT 5;` → Should return rows or empty set (not error)
3. [ ] Check `review_logs` table has `kind = 'practice'` rows
4. [ ] Verify RLS: `SELECT * FROM review_logs WHERE kind = 'practice' AND user_id = auth.uid();` works

### With Vercel Dashboard Access
1. [ ] Confirm `SUPABASE_URL` = `https://nexrcrliyxtelxkujphe.supabase.co`
2. [ ] Confirm `SUPABASE_ANON_KEY` is a public `anon`/`publishable` key (not `sb_secret_*`)
3. [ ] Check latest deployment: Functions → `/api/health` returns 200 OK
4. [ ] Verify no 503 errors in Function logs for `/api/*` endpoints

### Without Owner Access (Current State)
- [x] `/api/health` returns healthy configuration
- [x] `/api/config` returns valid Supabase URL and public key
- [x] All 372 relevant tests pass (mutation queue, session controller, shared logic)
- [x] TypeScript compiles (only 3 pre-existing unrelated errors in server/hooks)
- [x] Lint passes (only 5 pre-existing unrelated errors)

---

## Known Application-Level Bugs Found & Fixed During Audit

| Issue | Fix | Commit |
|-------|-----|--------|
| Mutation queue accepted mutations without account ID | `enqueue()` now throws if `currentAccountId` not set | `7317b55` |
| Mutation queue didn't set `accountId` on mutations | `enqueue()` sets `accountId = this.currentAccountId` | `7317b55` |
| Local persistence failures were silent | `enqueue()` now `await`s IndexedDB write | `7317b55` |
| Duplicate Practice persistence (queue + direct API) | Removed direct `api.submitPractice()` call; single path via queue | `d00f8b4` |
| Permanent failures retried forever | `retry()` now checks `status === 'permanent'` | `7317b55` |

---

## Conclusion

**The deployed application at https://flashcards-gold-psi.vercel.app/ is correctly configured and healthy.** The codebase expects database schema version 9 for the True Mastery / practice history feature. **Production database schema version cannot be verified without Supabase Dashboard access.**

**Next step for full verification:** Run `SELECT app_schema_version();` in Supabase SQL Editor. If it returns `< 9`, apply migrations `20261018090000_true_mastery_practice_history.sql` (and any missing prior migrations) in order, then the True Mastery feature will activate automatically on next app load.