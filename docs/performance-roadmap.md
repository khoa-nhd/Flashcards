# Performance roadmap

A deep dive on the stack as it actually is, with the numbers measured on this
machine, the code paths that cost the most, and a phased plan. Nothing here is
guessed: every "today" figure has the command that produced it.

## 0. What the stack really is

```
Browser ──HTTPS──▶ Node (Hono)  ──HTTPS──▶ Supabase PostgREST ──▶ Postgres (RLS)
   │                  │
   │                  ├─ serves the built app (dist/) in production — no CDN, no gzip
   │                  └─ one Supabase client, one repo, one service set per request
   └──HTTPS──▶ Supabase Auth (GoTrue)  ← sign-in, token refresh, session
```

Three consequences that shape everything below:

1. **The Node process is both the API and the static file server.** Every asset
   request costs a Node request. There is no Nginx, no Cloudflare, no
   compression (`server/index.ts`, `server/create-app.ts`).
2. **Each `/api/*` request is a proxy to a second machine.** TTFB = Node work
   (~2 ms) + Postgres RTT + PostgREST work. If the Node host and the Supabase
   project are in different regions, that RTT is paid *per query* — this app
   makes 1–3 queries per screen.
3. **The browser talks to two origins**: the app's own `/api` and the Supabase
   Auth origin. Both need to be warm (TLS/DNS) before the first screen.

## 1. Measured today

| Thing | Value | How |
| --- | --- | --- |
| Main JS bundle | **965.1 kB raw / 276.8 kB gzip** | `npm run build` |
| Auth chunk (lazy, loads after `/api/config`) | 217.0 kB / 56.1 kB gzip | `npm run build` |
| CSS | 68.8 kB / 13.2 kB gzip | `npm run build` |
| Fonts emitted | 20 files: 132 kB woff2 + 156 kB woff | `du -ch dist/assets/*.woff2` |
| Compression on the wire | **none** — 965,128 B JS sent with `Accept-Encoding: gzip, br` | `curl -D - -H 'Accept-Encoding: gzip, br' …/assets/index-*.js` |
| Cache headers on `/` and `/assets/*` | **none** (`last-modified` only, no `cache-control`, no `etag`) | `curl -D -` |
| Node overhead, `/api/config` | **1.8 ms avg, 12 ms max** (20 requests, local) | `curl -w '%{time_starttransfer}'` loop |
| `/api/vocabulary` payload | 5.5 kB, uncompressed | `curl -H 'Accept-Encoding: gzip'` |
| `npm start` without `NODE_ENV=production` | serves **no** frontend (404 on `/`, API only) | observed |

Everything else that users feel is the Supabase round trip and the client
waterfall, both addressed below.

## 2. Phase 0 — the four quick wins (≈1 day, no architecture change)

### 2.1 Compression (the single biggest byte win)

`hono/compress` is already a dependency, unused:

```ts
// server/create-app.ts
import { compress } from 'hono/compress';

const app = new Hono<AppEnv>();
app.use('*', compress());          // before every route
```

That alone turns 965 kB into ~277 kB for the bundle and ~1/4 for JSON. gzip is
what Hono does; **brotli should be done at the edge** (Nginx §3.1, Cloudflare
§3.2), where the compressed copy can be cached. Do not compress `/api/ai/…`
streams — see §3.4.

Benchmark: `curl -s -o /dev/null -w '%{size_download} %{time_total}\n' -H
'Accept-Encoding: gzip' http://host/assets/index-*.js` before/after, and check
`content-encoding: gzip` in the response headers.

### 2.2 Long-lived caching for hashed assets, revalidation for the shell

```ts
// server/index.ts — keep the existing shape, add the headers
const HASHED = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|svg)$/;

const assets = serveStatic({
  root: './dist',
  onFound: (path, c) => {
    const immutable = HASHED.test(path);
    c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});
```

The `serveStatic` in `@hono/node-server` already sends `Last-Modified`, so a
revalidated shell costs a 304 rather than a re-download. It has a
`precompressed: true` option that serves `file.js.br` / `file.js.gz` when the
request allows it — pair it with a build step that writes those files
(`vite-plugin-compression`) if Nginx is not in front.

`index.html` and `/sw.js` must stay revalidated (`no-cache`), or a deploy is
invisible to the service worker.

### 2.3 Stop loading a 217 kB auth chunk after a network round trip

`src/App.tsx` (`Boot`) awaits `/api/config`, *then* dynamically imports
`supabase-auth`. Both are needed before the first screen, and the import is a
local file: start it now.

```ts
const [config, authModule] = await Promise.all([
  loadConfig(),
  import('./lib/supabase-auth.js'),   // fetched in parallel with the config request
]);
```

Better still: list it as a module preload in `index.html` so the download starts
with the main bundle. Keep the dynamic import for the "open mode" (no accounts).

### 2.4 Preconnect to the Supabase Auth origin

The browser opens TLS to `https://<project>.supabase.co` on the first sign-in
check. Inject it at build time from the public URL (`VITE_SUPABASE_URL`) — never
hard-code it:

```html
<!-- src/index.html -->
<link rel="preconnect" href="%VITE_SUPABASE_URL%" crossorigin />
<link rel="dns-prefetch" href="%VITE_SUPABASE_URL%" />
```

`tests/frontend-secrets.test.ts` enforces that the browser only sees the public
key; a preconnect to the public origin is consistent with that.

## 3. TTFB and the server

### 3.1 Take static off Node: Nginx in front

Node should only answer `/api/*`. Nginx owns TLS, HTTP/2, HTTP/3 and the file
system:

```nginx
# /etc/nginx/conf.d/vocabulary.conf  (nginx ≥ 1.25.4, quic-enabled build for HTTP/3)
server {
    listen 443 ssl;
    http2 on;
    listen 443 quic reuseport;            # HTTP/3
    ssl_certificate     /etc/ssl/fullchain.pem;
    ssl_certificate_key /etc/ssl/privkey.pem;
    add_header Alt-Svc 'h3=":443"; ma=86400' always;

    root /srv/vocabulary/dist;
    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;

    # Brotli (nginx-module-brotli) with gzip fallback.
    brotli on;
    brotli_comp_level 5;
    brotli_types text/html text/css application/javascript application/json image/svg+xml;
    gzip on;
    gzip_comp_level 5;
    gzip_types text/html text/css application/javascript application/json image/svg+xml;

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location = /index.html { add_header Cache-Control "no-cache"; }
    location = /sw.js      { add_header Cache-Control "no-cache"; }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # Never cache an account's API response at this layer.
        add_header Cache-Control "no-store" always;
    }

    location / { try_files $uri /index.html; }
}
```

Then run Node as `NODE_ENV=production HOST=127.0.0.1 PORT=3000 npm start` and
leave `serveStatic` only as a fallback for machines without Nginx. (Note the
footgun observed above: without `NODE_ENV=production` the built app is not
served at all.)

### 3.2 Edge cache: Cloudflare (or CloudFront) in front of everything

- **DNS proxy on**, TLS "Full (strict)".
- Cache rule: `URI path starts with /assets/` → Eligible, Edge TTL 1 year,
  Browser TTL "respect origin".
- Cache rule: `URI path equals /` or `/index.html` → Edge TTL 60 s, Browser TTL
  `no-cache`, **stale-while-revalidate 1 day**. The HTML is public; the data is
  not.
- Bypass cache for `/api/*` and `/sw.js`.
- Cache purge on deploy (the HTML names new hashed assets, so a 60 s TTL is
  already safe; purge makes it instant).
- Enable Brotli + HTTP/3 in the dashboard; Cloudflare negotiates h3 for the
  browsers that support it, and compresses the HTML/JS even if Node did not.
- Optional: Cloudflare "Cache Reserve"/Tiered Cache so the 240 kB bundle is
  served from the PoP, not from the origin.

### 3.3 Put Node in the Supabase region, and cut round trips

This is the largest TTFB item and it is pure arithmetic: one API call does
`auth.getClaims` (cached JWKS, local), `getSettings` (cached 30 s in
`supabase-accounts.ts`), then 1–3 PostgREST calls. At 80–150 ms cross-region
RTT, three calls are ~300–450 ms of pure waiting per screen. Co-locate the
Node host with the Supabase project (`aws-1-ap-southeast-1` → same region) and
the same traffic becomes ~5–15 ms per call.

Measure it before and after from the Node host:

```bash
curl -s -o /dev/null -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  "https://<project>.supabase.co/rest/v1/" -H "apikey: $PUBLIC_KEY"
```

### 3.4 Full-page caching — where it genuinely helps

- **`/api/config`** is static per process (`server/create-app.ts`): give it
  `Cache-Control: public, max-age=300, stale-while-revalidate=86400`; it is the
  first request of every page load, so a cache hit removes one round trip from
  cold start entirely. The body is the same for every visitor (mode, auth mode,
  the *public* Supabase URL and key), so there is nothing to vary. Set the
  header **in the route handler**: the `no-store` middleware above it sets the
  header before `next()`, and a handler can override it. Keep `/api/health` at
  ~10 s if it is cached at all — it reports setup issues.
- **Read endpoints that are expensive and user-scoped** (`/api/vocabulary`,
  `/api/library`, `/api/analytics`, `/api/review-days`) are the candidates for a
  small server-side response cache keyed by `(account, endpoint, query)` with a
  5–10 s TTL plus explicit invalidation on writes. `LibraryService` and
  `AnalyticsService` are pure reads over the account's rows, so a TTL of a few
  seconds cannot show stale data that matters (the app already treats reads as
  eventual — see `withCachedReads`).
- **Do not** put Varnish/FastCGI in front of `/api/*`: responses are
  per-account and `no-store` by design. The worthwhile cache is the *data* cache
  in §5, not a page cache.
- **SSR at the edge is not a fit** for this app: it is a signed-in, offline-first
  SPA whose first screen already renders from IndexedDB. Moving rendering to the
  edge would add a network dependency to a path that currently works offline.

## 4. Database

### 4.1 What the schema already does well

Indexes were added with each migration, one per hot access path:
`card_states (user_id, review_date) where mastery < 10`,
`vocabulary (user_id, created_at) where deleted_at is null`,
`review_logs (user_id, reviewed_at desc)`, `ai_messages (conversation_id,
created_at)`, the FSRS-only `card_states (user_id, due_on)`, the gacha PKs and
`unique (user_id, request_id)`. Most apps at this stage are missing these; this
one is not.

### 4.2 Find what is actually slow first

```sql
-- Top statements by total time (Supabase: Database → Extensions → pg_stat_statements)
select calls,
       round(total_exec_time::numeric, 1) as total_ms,
       round(mean_exec_time::numeric, 2) as mean_ms,
       round((100 * total_exec_time / sum(total_exec_time) over ())::numeric, 1) as pct,
       left(query, 90) as query
from pg_stat_statements
order by total_exec_time desc
limit 20;

-- Tables being scanned instead of indexed
select relname, seq_scan, idx_scan,
       round(100.0 * seq_scan / nullif(seq_scan + idx_scan, 0), 1) as seq_pct
from pg_stat_user_tables
where seq_scan + idx_scan > 0
order by seq_pct desc
limit 20;

-- Indexes nobody uses (drop candidates; keep the ones enforcing constraints)
select relname as table, indexrelname as index, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where idx_scan = 0 and schemaname = 'public'
order by pg_relation_size(indexrelid) desc;
```

### 4.3 EXPLAIN ANALYZE, with the account's own RLS context

RLS changes plans: a query without `auth.uid()` is not the query production
runs. Reproduce it in the SQL editor:

```sql
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', '<user-uuid>', 'role', 'authenticated')::text, true);
set local role authenticated;

explain (analyze, buffers, verbose)
select id, word, review_date, due_on, revision
from public.card_states
where user_id = (select auth.uid()) and mastery < 10
order by review_date
limit 200;
rollback;
```

What to look for, in order:

| Symptom in the plan | Meaning | Fix |
| --- | --- | --- |
| `Seq Scan on card_states` with `Rows Removed by Filter` large | wrong index, or a function on the column (`coalesce(due_on, review_date)`) | expression index, or split the predicate |
| `Index Scan` but `actual rows=… loops=500` | N+1 inside a function | set-based rewrite |
| `Sort` with `external merge Disk` | sort not covered by the index | add the sort column to the index |
| `Buffers: shared read=…` high on a warm run | table bloat | `vacuum (analyze)` / check autovacuum |

For SQL functions (`apply_gacha_open`, `record_review`, `session_summary`), run
the body with `explain analyze` on the statements inside, not on the call.

### 4.4 Likely missing indexes (verify with 4.2/4.3 before adding)

```sql
-- RLS always filters by user, then the collection: the existing index is (user_id) only.
create index concurrently if not exists collection_items_user_collection_idx
  on public.collection_items (user_id, collection_id);

-- vocabulary_relations indexes high_id but not low_id; relations are read both ways.
create index concurrently if not exists vocabulary_relations_user_low_idx
  on public.vocabulary_relations (user_id, low_id);

-- Only if the chest page ever lists history: the unique key is (user_id, request_id).
create index concurrently if not exists gacha_opens_user_time_idx
  on public.gacha_opens (user_id, opened_at desc);
```

Each of these costs write throughput; add them one at a time and re-run 4.2
afterwards, dropping anything whose `idx_scan` stays at 0 for a week.

### 4.5 The real N+1s in this codebase

1. **Import** — `server/supabase/backup-import.ts:120` loops over `plan.toCreate`
   and awaits `database.createCard` for each word, and `createEntry` then reads
   the row back (`supabase-repository.ts`, `createCard` + `getCard`). A 500-word
   import is **1,000 round trips**. Replace with one RPC:

   ```sql
   create or replace function public.create_vocabulary_batch(p_entries jsonb)
   returns setof public.vocabulary
   language plpgsql security invoker set search_path = ''
   as $$
   declare v_user uuid := (select auth.uid());
   begin
     return query
       insert into public.vocabulary
         (user_id, word, word_key, meaning, definition, example, date_added, request_id)
       select v_user, e->>'word', e->>'wordKey', e->>'meaning', e->>'definition',
              e->>'example', (e->>'dateAdded')::date, nullif(e->>'requestId','')::uuid
       from jsonb_array_elements(p_entries) as e
       on conflict do nothing
       returning *;
   end $$;
   ```

   Batches of 100, one transaction, and the response is the rows themselves.

2. **Write read-backs** — `createEntry`, `updateEntry`, `restoreEntry` each do
   two calls. Have the RPC `returning *` and pass the row back, so a write costs
   one RTT instead of two. This is the cheapest 50 % cut on every write path
   (review actions already do this correctly in `apply_review`).

3. **Chest rotation** — `server/gacha-service.ts` replays and retries up to 3
   times on purpose; with the `opens` version that is correct, and `find()` now
   removes the wasted retry after a network replay.

### 4.6 Pooling, replicas, PgBouncer — the honest answer

- The server talks **HTTPS to PostgREST**, not Postgres. PostgREST pools its own
  connections to Postgres, so **PgBouncer adds nothing here** and ProxySQL is
  MySQL-only. If a direct `pg` client is ever added (cron jobs, reports), use
  Supabase's pooler on **port 6543 (transaction mode)** and never hold a
  transaction open across HTTP calls.
- Keep-alive matters more than pooling: Node's undici pool is per-origin and
  reused automatically; do not create a new `fetch` agent per request.
- **Read replicas**: PostgREST on Supabase does not route reads to a replica by
  query. Replicas make sense for analytics/export (run them from a separate
  service on the replica) — not for the interactive API. Co-location (§3.3)
  beats a replica for TTFB.

## 5. Caching, layer by layer

| Layer | Today | Change | Where |
| --- | --- | --- | --- |
| Browser: hashed assets | no headers | `max-age=31536000, immutable` | §2.2 / Nginx / CF |
| Browser: HTML, `/sw.js` | no headers | `no-cache` + ETag | §2.2 |
| Browser: API | `no-store` (correct) | keep; cache only `/api/config` | §3.4 |
| Service worker | network-first shell, cache-first assets (`public/sw.js`) | precache the hashed entry chunks, purge old cache on activate | `public/sw.js` |
| Client data | network-first, IndexedDB fallback (`src/lib/offline/cached-api.ts`) | **stale-while-revalidate**: paint the cached read immediately, revalidate in the background, update the store | `cached-api.ts` |
| Server (process) | settings 30 s, schema 60 s (`supabase-accounts.ts`) | add read-through response cache (5–10 s) for `/api/library`, `/api/vocabulary`, `/api/analytics`; ETag from `max(updated_at)` | new module beside `gacha-service.ts` |
| Server (shared) | none | Redis **only when running > 1 instance**: rate limits are in-process today (`gacha-service.ts` `checkRate`, AI rate limits) and would be per-instance | `REDIS_URL` |
| Bytecode | none | `node --enable-source-maps=false` + `module.enableCompileCache()` (Node 24) | `server/index.ts` |

### 5.1 Client stale-while-revalidate

`withCachedReads` currently returns the network value, and falls back to the
cache only when the network fails. Inverting the order for reads that already
have a copy is a large perceived-speed win on repeat visits (the dashboard, the
bank and the calendar are cacheable reads):

```ts
// src/lib/offline/cached-api.ts, inside read()
const remembered = await recall<T>(name, args, dayScoped);
if (remembered !== null) {
  // Paint the device's copy now; refresh it behind the user's back.
  void run().then((value) => keep(name, args, value)).catch(() => undefined);
  return remembered;
}
return run().then(/* … */);
```

Writes already go through the outbox (`offline/sync-engine.ts`), so an
optimistic read is consistent with how the app already behaves offline. Bound
it: only for reads whose cache is under, say, 5 minutes old, and never for
`/api/gacha` (a purse must be exact) — the same `dayScoped` flag pattern.

### 5.2 Redis: when it is worth it, and what for

Do not add Redis while the app runs as one Node process — the in-process
settings cache and rate limiter are simpler and faster. Add it when there are
two or more instances, for exactly three things:

1. **Rate limits** (`checkRate` in `gacha-service.ts`, the AI limiter) — today
   two instances allow twice the requests.
2. **Session/claims cache** keyed by the token's `jti` with a TTL under the token
   lifetime, to skip re-verification on hot paths (JWKS verification is already
   local, so this is optional).
3. **Shared response cache** for the read endpoints, so a cache warmed on
   instance A helps instance B.

Sketch that keeps the store swappable:

```ts
export interface CounterStore {
  hit(key: string, windowMs: number, limit: number): Promise<{ allowed: boolean; retryAfter: number }>;
}
// memory implementation for one process, Redis (INCR + PEXPIRE) for many
```

### 5.3 Browser caching policy, in one table

| Path | Header |
| --- | --- |
| `/assets/*` (hashed) | `Cache-Control: public, max-age=31536000, immutable` |
| `/index.html`, `/sw.js` | `Cache-Control: no-cache` + `ETag` |
| `/api/config` | `Cache-Control: public, max-age=300, stale-while-revalidate=86400` |
| everything else under `/api/` | `Cache-Control: no-store` (already) |
| fonts | `Cache-Control: public, max-age=31536000, immutable` (hashed by Vite) |

## 6. Frontend

### 6.1 Split the 965 kB bundle per page

`src/App.tsx` imports every page statically. Two pages (Bank, Calendar) and the
whole chat UI are in the initial bundle even on the dashboard.

```tsx
import { lazy, Suspense } from 'react';

const BankPage = lazy(() => import('./pages/BankPage.js').then((m) => ({ default: m.BankPage })));
// …one per page

const PAGES: Record<RouteKey, { title: string; render: () => ReactNode }> = {
  bank: { title: 'Vocabulary bank', render: () => <BankPage /> },
};

// inside the shell, where PAGES[route].render() is called today:
<Suspense fallback={<PageSkeleton />}>{PAGES[route].render()}</Suspense>
```

Keep the dashboard and review screens eager (they are the landing pages), lazy
everything else. Expect the initial chunk to fall from 965 kB to roughly
300–400 kB raw once the four heaviest screens leave it — **measure with
`npm run build` and compare the `index-*.js` line**, then decide which pages are
worth prefetching on hover (`import()` in `onPointerEnter` on the nav links).

### 6.2 Resource hints

- `modulepreload` the auth chunk if it stays lazy (§2.3), and `preload` the two
  woff2 files actually used above the fold:

  ```html
  <link rel="preload" href="/assets/public-sans-latin-400-normal-*.woff2" as="font" type="font/woff2" crossorigin>
  ```
  (Vite can inject these via a tiny plugin that reads the manifest; do not
  hand-maintain hashes.)
- `preconnect` to the Supabase Auth origin (§2.4).
- No `dns-prefetch` is needed for anything else: the app makes no third-party
  requests at runtime.

### 6.3 Fonts

`src/main.tsx` imports 10 Fontsource CSS files → 20 emitted files (woff + woff2)
for 2 families × 2 subsets × 2–3 weights, ~288 kB on disk. Browsers download
only the woff2 they use, so the real cost is ~2–4 files; still:

- Drop the `.woff` fallbacks (all supported browsers take woff2) by importing
  only the woff2 variant (`@fontsource/.../latin-400.css` ships both; a
  `unicode-range`-respecting manual `@font-face` block with woff2 only halves
  the emitted set).
- Keep `font-display: swap` (Fontsource default) so text paints immediately.
- If Vietnamese is not the primary language for most users, load the
  `vietnamese` subsets only when the UI language is `vi` (the app already knows
  this: `useUiLanguage()`), otherwise they are dead bytes per user.

### 6.4 Images and media

There are no `<img>` or `<iframe>` elements in the app (emoji glyphs only), so
`loading="lazy"` and WebP/AVIF have nothing to act on today. If user-supplied
images or an avatar ever arrive: `<img loading="lazy" decoding="async"
width height>`, serve AVIF with a `srcset`, and never lazy-load the one image
above the fold. The `Icon.tsx` set is inline SVG and already optimal.

### 6.5 The service worker

`public/sw.js` is network-first for pages and cache-first for assets — the right
shape. Two improvements:

- Precache the built entry (`/assets/index-*.js`, `/assets/index-*.css`) during
  `install` by reading the manifest, so a repeat visit is served entirely from
  cache even if the network is slow (not only when it is dead).
- Bump `CACHE` from `v1` on each deploy (or use a build-injected hash), so the
  old bundle is evicted rather than kept forever.

## 7. How to verify each step

```bash
# 1. Bytes and compression
curl -s -o /dev/null -w '%{size_download}B in %{time_total}s\n' -H 'Accept-Encoding: gzip, br' \
  http://localhost:3000/assets/index-*.js

# 2. TTFB breakdown, warm and cold
curl -s -o /dev/null -w 'dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  http://localhost:3000/api/health

# 3. API throughput (mock mode is a fair floor; supabase mode needs a real account)
npx autocannon -c 50 -d 20 -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/review-queue

# 4. Real-user numbers from the app itself
#    (src/lib/perf.ts already times review.advance / review.save)
```

Add a browser-side probe for the numbers the server cannot see:

```ts
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.entryType === 'navigation') {
      const nav = entry as PerformanceNavigationTiming;
      console.info('TTFB', nav.responseStart, 'DOMContentLoaded', nav.domContentLoadedEventEnd);
    }
  }
}).observe({ type: 'navigation', buffered: true });
```

Budgets worth enforcing in CI (fail the build, not the user):

| Metric | Budget |
| --- | --- |
| Initial JS (gzip) | ≤ 250 kB |
| Initial CSS (gzip) | ≤ 20 kB |
| `/api/*` p95 TTFB (same region) | ≤ 150 ms |
| `/api/*` p95 TTFB (cross-region) | ≤ 400 ms |
| Lighthouse performance (mobile, throttled) | ≥ 90 |
| LCP | ≤ 1.5 s |

## 8. Order of work

| Phase | Change | Expected effect | Risk |
| --- | --- | --- | --- |
| 0 | compression, cache headers, parallel auth import, preconnect | −75 % transfer on first load; one RTT less on boot | very low |
| 1 | Nginx/CDN in front, Node in the Supabase region | TTFB from hundreds of ms to tens; static off Node | low |
| 2 | create/update RPCs return rows; import batch RPC | writes: 2 RTT → 1; 500-word import: 1,000 RTT → 5 | medium (SQL) |
| 3 | route-level code splitting, index verification | initial JS ≈ −50 %; protects DB plans | low |
| 4 | server response cache + client SWR | repeat visits paint instantly; fewer API calls | medium (staleness) |
| 5 | Redis (rate limits + shared cache) | only once > 1 instance | medium (new infra) |

Everything in phase 0 is a few dozen lines in files this project already has;
phase 1 is configuration, not code. Phases 2–4 should each ship with the
benchmark from §7 recorded before and after, so the roadmap becomes evidence
rather than intention.

## 9. Shipped, with the numbers

### Phase 0 — measured locally (`NODE_ENV=production`, mock data)

| Thing | Before | After |
| --- | --- | --- |
| `index-*.js` | 965.1 kB raw / 276.8 kB gzip, one chunk | **428.5 kB / 124.5 kB**, plus one chunk per page |
| Main chunk on the wire | 276,772 B gzip | **124,456 B** (−55 %) |
| `/api/vocabulary` on the wire | 5,486 B, uncompressed | **1,479 B** gzip (−73 %) |
| `/` and `/assets/*` headers | `last-modified` only | `no-cache` for HTML and `/sw.js`, `public, max-age=31536000, immutable` for hashed assets |
| Boot | `/api/config`, then the auth chunk | both in parallel; the Supabase origin is preconnected at build time when `SUPABASE_URL` is set |

The Vite `> 500 kB` warning is gone. `compress()` leaves `text/event-stream` alone,
so the AI chat stream is unaffected.

### Repeat visits

| Thing | Before | After |
| --- | --- | --- |
| Hashed assets on the CDN | `public, max-age=0, must-revalidate` on every request (measured on the Vercel deployment) | `vercel.json` sets `max-age=31536000, immutable`; self-hosting gets the same from `server/index.ts` |
| Service worker | precached `/` and `/index.html` only; cache name fixed at `v1` | precaches the entry JS and CSS as well (names come from the build), and takes its cache name from those names, so a deploy replaces the old bundle |
| `/api/config` | `no-store`, asked again on every boot | `public, max-age=300, stale-while-revalidate=86400` in production; unchanged in development |

Verified by running the built `dist/sw.js` in a sandbox: install fetches 4 entries,
a repeat request for the entry chunk is answered **with 0 network requests**, and a
build with new file names leaves only the new cache behind.

### Load hints (§6.2)

The HTML now starts two things the first screen already waits for, instead of leaving
them until the entry chunk has run: the sign-in chunk (56 kB gzip, imported by every
boot whether the deployment has accounts or not) and the two Public Sans 400 faces
body text is drawn in. Both go in at build time from the bundle, so the names are
never written by hand.

Same server, same machine, a fresh browser profile each time:

| | Entry chunk starts | Sign-in chunk starts | `public-sans-latin-400` starts |
| --- | --- | --- | --- |
| Without the hints | 307 ms | **418 ms** (+111) | **425 ms** (+118) |
| With the hints | 344 ms | **344 ms** (+0) | **343 ms** (+0) |

The production deployment before any of this work shows what the same serialisation
costs over a real network: entry 360→557 ms, sign-in chunk **2,072 ms** — 1.7 s after
the entry started, because it waited for the entry to run and `/api/config` to be
asked for. The 500/600 weights and the serif headings are deliberately not hinted:
they are not on the first screen, and each hint competes for the same connection.

### Still worth doing, and what each one is waiting for

| Left | Why it is not done |
| --- | --- |
| Phase 1, §3.3: run the function in the Supabase region | Needs the project's region. Measured today: `/api/health` answers with `x-vercel-id: hkg1::iad1::…`, so the function runs in Virginia whatever the database is near. |
| Phase 2, §4.5: RPCs that return rows, batched import | Needs a live Supabase project to write and measure the SQL against; unverifiable in mock mode, and a wrong migration would land on production data. |
| Phase 4 server side: response cache for `/api/library`, `/api/vocabulary`, `/api/analytics` | A 5 s TTL with no invalidation shows a word the user just edited in its old form, and the tests share one clock with the handlers, so a cache would have to be invalidated by every write route. Worth doing with ETag revalidation at the same time, not before. |
| Phase 4 client side: stale-while-revalidate in `withCachedReads` | The wrapper has no way to tell the page that the fresh copy arrived — `useRemote` (`src/hooks/useRemote.ts`) loads once per mount — so serving the old copy would paint yesterday's numbers and never correct them. It needs a revalidation channel to the hook first; the offline fallback stays as it is. |
| Phase 5: Redis | Only once more than one instance runs; the in-process settings cache and rate limit are faster today. |
| `vercel.json` headers, service worker precache | Written and verified locally, but the CDN only serves them after a deploy. |
