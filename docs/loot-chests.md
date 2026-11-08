# Loot chests

A collectible chest system for the vocabulary app: keys open chests, what falls
out stays in a collection, duplicates turn into shards, and shards buy more
keys. The rolls happen on the server; the browser only draws what it is told.

Schema version: **22** (`supabase/migrations/20261104090000_gacha.sql`).

## Where the pieces live

| Layer | File | What it does |
| --- | --- | --- |
| Rules (pure) | `shared/gacha.ts` | Rarity table, pity, duplicate recycler, economy, seeded RNG for tests |
| HTTP shapes | `shared/api.ts` | `gachaApiStateSchema`, `gachaOpenRequestSchema`, `gachaOpenResponseSchema`, `shardExchangeRequestSchema` |
| Service | `server/gacha-service.ts` | Daily grant, affordability, rate limit, idempotency, optimistic retries |
| Stores | `server/gacha-service.ts` (memory), `server/supabase/supabase-gacha-store.ts` | Persistence; the Supabase one commits through one RPC |
| Routes | `server/create-app.ts` | `GET /api/gacha`, `POST /api/gacha/open`, `POST /api/gacha/exchange` |
| Client | `src/lib/api-client.ts` (`GachaApi`), `src/pages/ChestsPage.tsx`, `src/lib/gacha-sound.ts` | The chest room, the reveal, the sounds |

The catalog (chests, items, odds) is code, not rows: it ships to the browser so
the room can be drawn offline, and the server reads the same constants, so the
odds the page shows are the odds it rolls.

## Data model

```
gacha_state      one row per account: keys, shards, pity, opens, last_grant_day
gacha_inventory  one row per collectible owned: quantity, first/last obtained
gacha_opens      append-only: request_id (unique per account), chest, count, results
```

- `opens` is a version counter. A write states the count it read; if the row has
  moved on, the write is refused and the service retries from the new balance.
- `gacha_opens.request_id` makes a retried request the *same* opening: the
  service answers with the stored results instead of rolling again.
- Row Level Security everywhere, `user_id = auth.uid()`, no delete policy, and
  the inventory/opens privileges are the minimum the app needs.
- `apply_gacha_open(...)` writes the balance, the inventory and the opening
  record in one transaction and returns `applied` / `conflict` / `replayed`.

Nothing about a chest is decided in the browser: the request names a chest and
a count, never a rarity, an item or a price.

## The odds

| Chest | Keys | Common | Rare | Epic | Legendary | Epic pity | Soft pity after | Hard pity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Wooden | 1 | 70% | 22% | 7% | 1% | 10 | 20 | 60 |
| Silver | 3 | 55% | 30% | 12% | 3% | 10 | 15 | 50 |
| Golden | 10 | 35% | 35% | 22% | 8% | 8 | 10 | 40 |

- **Epic pity:** the opening that reaches `epicPity` without an epic-or-better
  removes common *and* rare from the table, so it is guaranteed epic or
  legendary.
- **Soft pity:** past `softPityAfter` legendary openings, legendary odds climb
  by `softPityStep` each opening, capped by `softPityCap`. The bonus is taken
  from the ordinary end of the table, never invented, and the table is
  renormalised to 1.
- **Hard pity:** at `hardPity` the roll is legendary outright, before the dice
  are consulted.
- A batch of ten is resolved in order, each opening using the pity the previous
  one left behind, so a batch cannot be used to dodge pity.

## Economy

- `GACHA_KEYS_PER_DAY = 3`, granted once per calendar day in the account's own
  time zone; `GACHA_KEY_CAP = 99`.
- A duplicate becomes shards: common 2, rare 6, epic 20, legendary 60.
- `GACHA_SHARDS_PER_KEY = 10`, so a long unlucky run still moves forward.
- Starting purse in the sample (no-account) mode: 5 keys and 0 shards, plus the first visit's 3 daily keys (8 on the first load).

## The opening, beat by beat

1. **Chest selection** — three chests with their odds, cost and a pity line
   ("an epic within N more"). Buttons disabled when the keys are not there.
2. **Charge** (0.8 s; 1.25 s if an epic is coming, 1.9 s for a legendary) — the
   lid shakes, a seam of light pulses, a low ascending tone. A legendary shows
   a line of copy so the wait is anticipation, not a stall.
3. **Burst** (0.45 s) — a radial flash in the rarity's colour, a filtered noise
   hit and a falling tone.
4. **Reveal** — one card at a time, 420 ms apart: the card turns over (CSS
   `rotateX`), sparks fly outward from its centre, the rarity chime plays.
   `Skip the rest` jumps to the summary; a single reward waits for `Lovely`.
5. **10× summary** — every item with its rarity, `New` or `+shards`, the shard
   total, one button to close.

Sounds are synthesised with the Web Audio API (`src/lib/gacha-sound.ts`), so no
audio files ship and nothing is fetched. The context is created on the first
gesture. A `Sound on/off` toggle on the page mutes every cue.

## What keeps it fair (and how it is tested)

| Test | Proves |
| --- | --- |
| `tests/shared/gacha.test.ts` | 20 000 rolls land on the configured table; 10 000 carried-pity openings stay ordered and stable across seeds; epic/hard pity are guaranteed; soft pity climbs and caps; duplicates and shards add up; daily keys cap; shard trades are whole |
| `tests/server/gacha-api.test.ts` | daily grant once a day; a retried request id opens nothing more; an unaffordable chest is refused; bad chest/count/uuid are 400; a burst is 429 with `Retry-After`; two racing openings with one key → one 200, one 409; exchange works and refuses |
| `tests/database/gacha.test.ts` | the RPC writes state + inventory + opening together, replays an id, refuses a stale `opens`, and keeps accounts (and visitors) out |
| `tests/client/chests.test.tsx` | the room renders the collection, an opening reaches a reward card, a batch can be skipped to its summary |

## Edge cases and what the app does

- **Network drops mid-pull** — the roll may have committed. Pressing the button
  again reuses the same request id, so the player sees the same cards instead of
  paying twice. If the request never reached the server, the retry is a fresh
  opening.
- **Rapid clicking** — a sliding window of 8 openings per 10 s per account
  answers `429` with `Retry-After`; the buttons are also disabled while a
  request is in flight. The double-click that gets through is idempotent.
- **Not enough keys** — `409 insufficient_keys` with the shortfall in the
  message; the page reloads the state so the purse on screen is the real one.
- **Two devices at once** — `opens` is the version: the loser of the race
  re-reads and either opens with the real balance or is told it cannot afford
  it. The database function refuses a stale write rather than overwriting.
- **Full collection** — every drop is a duplicate with shards, and the summary
  says so; there is no inventory cap to hit.
- **Older database** — below version 22 the routes answer
  `409 not_supported` and the page says chests need the update.
- **Reduced motion** — the reveal is CSS-driven and the app already honours
  `prefers-reduced-motion`; the card and the numbers remain.
- **Performance** — no canvas or physics loop: the sparks are 8–18 absolutely
  positioned spans that end and are removed with the card, and the timers are
  cleared when the dialog closes, so nothing accumulates between opens.

## Running the checks

```
npx tsc --noEmit
npx eslint src/pages/ChestsPage.tsx src/lib/gacha-sound.ts server/gacha-service.ts \
  server/supabase/supabase-gacha-store.ts shared/gacha.ts
npx vitest run tests/shared/gacha.test.ts tests/server/gacha-api.test.ts \
  tests/database/gacha.test.ts tests/client/chests.test.tsx
```
