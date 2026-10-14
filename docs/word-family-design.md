# Batch 4 (roadmap 2026-10-13): word families from root to derived - the design, ready to build

**Status: implemented 2026-10-14 (batch 4).** Migration
`20261020090000_root_derived.sql` (version 11), the `roots` capability, the
two AI routes and the word-panel UI all landed as this document planned;
`docs/upgrade-plan.md` and the README carry the "what", this file stays the
"why". The research below was done on branch
`newfeature` at commit `fcb04d4` (Batch 3). Every file path, line number and
pattern here was read from the code as it stands, so the next session can go
straight to writing code without re-exploring. When the batch lands, this
document stays as the "why"; the README and upgrade-plan carry the "what".

The four pieces of the batch, as approved in the roadmap:

1. **AI word-family builder** — a draft, reviewed before saving, of the words
   built from the same root as the word on screen.
2. **Root → derived storage** (migration v11) — a direction a plain relation
   cannot express: which word this one was formed from.
3. **Root timelines** — the chain root → this word → its own derived words,
   drawn in the word's panel.
4. **Collocation-bearing AI examples** — example sentences written around the
   collocations the reader has already saved for the word.

Owner decision (2026-10-14): build the code now; the owner applies the
migrations to live Supabase afterwards (`npm run supabase:verify` is always
the owner's step). Everything is additive and capability-gated, so the
features simply stay off until the database catches up.

## Invariants this batch must not touch

- Mastery, review dates and FSRS are never written by any of this; `rootId`
  is organisation, exactly like a collection membership.
- Every AI answer is a **draft**. Nothing is saved until the reader has seen
  it and pressed a save button; the writer path is the ordinary
  `createEntry` / `updateEntry` / `addExample` APIs.
- AI keys stay server-side; the model is reached only through
  `server/ai/adapter.ts`. No new dependencies.

## 1. Storage: migration v11, `vocabulary.root_id`

Additive column, nullable, one hop (root to derived, no chains read by the
app even though the column could hold one).

```sql
-- supabase/migrations/2026xxxx_root_derived.sql
-- The word this one was formed from. Additive: nullable, no backfill.
alter table public.vocabulary add column root_id uuid;

-- Single-column FK on purpose: a composite (root_id, user_id) FK with
-- ON DELETE SET NULL would null user_id too and break the row. Deleting a
-- root simply clears its children's pointer; ownership stays enforced by
-- RLS plus a server-side same-owner check on write.
alter table public.vocabulary
  add constraint vocabulary_root_id_fkey
  foreign key (root_id) references public.vocabulary (id) on delete set null;

alter table public.vocabulary
  add constraint vocabulary_root_id_not_self
  check (root_id is null or root_id <> id);

create index vocabulary_root_id_idx on public.vocabulary (root_id)
  where root_id is not null;

create or replace function public.app_schema_version() returns integer
language plpgsql stable as $$ begin return 11; end $$;
-- plus the revoke/grant boilerplate copied from
-- 20261016090000_collections_and_relations.sql
```

Cross-user `root_id` cannot be crafted through the app (the id is never
visible), and the service re-checks same-owner on every write (§2).

## 2. Version bump and capability — the exact ripple

- `server/supabase/supabase-database.ts` line 155: `LATEST_SCHEMA_VERSION = 10`
  → `11`. `scripts/lib/supabase-session.ts` and the verifier pick it up
  automatically.
- `supabase-repository.ts` line 66 `capabilitiesAt()`: add
  `roots: schemaVersion >= 11`.
- `shared/api.ts` line 65 `capabilitiesSchema`: add
  `roots: z.boolean().default(false)`; `NO_CAPABILITIES` (line 85) gains
  `roots: false`.
- Client reads capabilities through `useVocabulary().state.meta.capabilities`
  (pattern: `state.meta?.capabilities.undo === true`, see ReviewPage line 195,
  session-controller line 102). The UI gate is
  `state.meta?.capabilities.roots === true`.

## 3. `rootId` through the API surface

- `shared/api.ts` line 610 `vocabularyEntrySchema`: add
  `rootId: z.string().nullable().default(null)` — the default keeps responses
  from an older server parseable (the house version-gate trick).
- `shared/api.ts` line 719 `updateEntryRequestSchema` (strictObject): add
  `rootId: z.string().min(1).nullable().optional()`. `null` clears the pointer.
- `server/vocabulary-catalog.ts`: `EntryData` is derived from
  `VocabularyEntry`, so it gains `rootId` for free — **but every place that
  constructs an `EntryData` must add it; the compiler will find them all**
  (repository `toEntry`, in-memory stores, sample/no-store paths, tests).
  `NewEntry` and `EntryChanges` gain `rootId?: string | null`.
- `server/supabase/supabase-database.ts`: `cardRowSchema` (line ~28) gains
  `root_id: z.string().nullable().optional()`; `CARD_COLUMNS` (line ~46)
  stays as is and `cardColumns(schemaVersion)` (line 54) appends
  `', root_id'` when `schemaVersion >= 11`. Check `CardPatch` /
  `updateCard` in the same file when wiring the write.
- `server/supabase/supabase-repository.ts` line 32 `toEntry`: add
  `rootId: row.root_id ?? null`. Line 349 `updateEntry`: map
  `changes.rootId` onto `patch.root_id`.
- Service layer (`server/review-service.ts` update path): when
  `changes.rootId` is present but `!repository.capabilities.roots`, reject
  with the usual `not_supported` error; when set to a non-null id, verify it
  is a live entry of the same account before writing.
- `tests/helpers/fake-api.ts`: `entry()` (line 30) gains `rootId: null`;
  the `updateEntry` handler passes `rootId` through; the fake meta must be
  able to report `capabilities.roots: true` for the client tests.

## 4. The two AI features

Follow the SmartReader pattern exactly — it is the house template:

- Module pattern: `server/ai/smart-reader.ts` — a class with
  `constructor({ adapter, limiter })` and one method per feature; prompts ask
  for a **zod schema** via `adapter.ask({ system, prompt, maxOutputTokens }, schema)`
  (`server/ai/adapter.ts`); a model that cannot answer returns null fields
  rather than inventing. Rate limiter: `createTokenBucket` from
  `server/ai/rate-limit.ts` with a per-feature constant (`AI_RATE` is exported
  from smart-reader.ts; writing-coach has its own `WRITING_COACH_RATE`).
- Route pattern: `server/create-app.ts` line ~451 `POST /api/ai/extract` —
  refuses when `!config.writesRequested` (403 `read_only`, exact house
  message), `accountKey = c.get('scope').session?.account.id ?? 'sample'`,
  `catch (error) { if (error instanceof AiError) { aiErrorToHttp → HttpError } }`.
  The reader instance is built once near line 133 with
  `createAiAdapter(config.ai)`.
- Client pattern: `SmartReader.tsx` — no proactive config probe; the request
  is simply made and an `ApiError` with code `not_supported` is shown as
  "this server has no model configured". `api-client.ts` line 160/439 shows
  the `call('/api/ai/extract', schema, …)` wrapper to copy.
- Shared schemas go in `shared/ai.ts` next to the extract schemas, with the
  existing `AI_LIMITS` (word 200, field 600).

New shared schemas (names final, fields as designed):

```ts
aiWordFamilyRequestSchema   = { word, meaning?, definition? }
aiWordFamilyResponseSchema  = { family: [{ word, gloss, root: boolean }] }
//   The family always includes the requested word itself; exactly one row has
//   root: true (the word itself when it is the base form).

aiExamplesRequestSchema     = { word, meaning?, definition?, example?,
                                collocations: string[] }   // the reader's saved collocations, ≤ ~10
aiExamplesResponseSchema    = { examples: [{ sentence, uses: string|null }] }
//   `uses` names which of the provided collocations the sentence demonstrates,
//   or null when it demonstrates none. Where the word has no collocations the
//   request simply carries an empty list and the sentences are natural ones.
```

New server modules `server/ai/word-family.ts` and `server/ai/examples.ts`
(one feature each, mirroring smart-reader.ts), routes `POST /api/ai/word-family`
and `POST /api/ai/examples` in create-app.ts, client methods `api.wordFamily()`
and `api.suggestExamples()` in `src/lib/api-client.ts`.

## 5. UI — where it goes

`src/components/WordExtras.tsx` (384 lines) hosts Collections / Examples /
Relations / Connections; `Section`, `SMALL_BUTTON`, `messageOf` are the local
helpers to reuse. The two new components go in a **new file**
`src/components/WordFamily.tsx` (WordExtras is already large) and are mounted
from `WordExtras` between Relations and Connections.

1. **`FamilyTimeline({ entry })`** — reads `useVocabulary()`:
   `root = entries.find((item) => item.id === entry.rootId)` and
   `children = entries.filter((item) => item.rootId === entry.id)`.
   Renders the chain as chips with `→` separators —
   `[decide] → [decision (current)] → [decisive] [decisively]` — the current
   word's chip accented, every chip a button calling `openWord`. Renders
   nothing when the word has neither a root nor children, or when
   `capabilities.roots` is false (an old server simply never sends rootId, so
   the section disappears on its own).
2. **`FamilyBuilder({ entry, canWrite })`** — gated on
   `capabilities.roots && canWrite`. A button "Build the word family (AI)"
   fetches a draft; the review table is one row per member:
   checkbox | word | gloss | "in your bank" / "new". The row marked `root`
   has its checkbox fixed on (the root is what the links point at).
   Saving walks the rows: a missing member is created with
   `api.createEntry({ word, meaning: gloss, requestId })`; then every checked
   member — including the word on screen — gets
   `api.updateEntry(id, { rootId })`, where `rootId` is the root member's id,
   or `null` when the word on screen **is** the root. Finish with
   `vocabulary.reload()` and one summary line ("3 words added, 4 linked"),
   or a per-row list of what failed. `not_supported` shows the house note
   that the database cannot keep word families yet (Settings → Connection).
3. **AI examples** — inside the existing `Examples` section of WordExtras:
   a "Suggest example sentences (AI)" button; the request carries the word's
   saved collocations (`useLibrary().relations.filter(kind === 'collocation')`
   → `otherEnd` → the word texts). The draft rows are checkbox + editable
   textarea + a "uses: …" tag; saving a checked row is the ordinary
   `api.addExample(entry.id, { sentence, source: 'AI suggestion' })` and
   `library.putExample(...)`. When the word has no collocations the section
   says so before the request, so the reader knows what the sentences are.

## 6. Tests planned (mirroring the house layout)

- `tests/database/schema.test.ts` — expects the migration list and
  `app_schema_version()` = 10: update to 11 and assert the new column,
  index and constraints.
- `tests/server/gateway-versions.test.ts` — iterates 1..LATEST; re-run after
  the bump and fix any per-version assertions it makes.
- New `tests/server/word-family-api.test.ts` and
  `tests/server/examples-api.test.ts`, copying
  `tests/server/smart-reader-api.test.ts` (the model is faked through the
  adapter; assert the read-only guard, the schema the answer is parsed with,
  and the rate-limit path).
- `tests/server/vocabulary-api.test.ts` — update with `rootId`: read-back,
  clear with `null`, rejection of a foreign id, and `not_supported` when the
  capability is off.
- New `tests/client/word-family.test.tsx` — builder: draft appears after the
  button, unchecking a member excludes it, saving calls `createEntry` for the
  new words and `updateEntry({ rootId })` for the linked ones; timeline:
  root → current → children chips render and a chip click opens the word;
  AI examples: the draft's collocations reach the request, a checked row
  saves through `addExample` with its edited text.

## 7. Order of work for the next session

1. Migration file + `LATEST_SCHEMA_VERSION` + `capabilitiesAt` +
   capabilities schema + `tests/database/schema.test.ts` (+ gateway versions).
2. `rootId` through shared schemas → catalog → repository → service →
   fake-api (+ vocabulary API tests).
3. Shared AI schemas → `server/ai/word-family.ts`, `server/ai/examples.ts` →
   create-app routes → api-client (+ server AI tests).
4. `src/components/WordFamily.tsx` + WordExtras mount + Examples AI block
   (+ client tests).
5. Docs: README word-panel paragraph, `docs/ai-features.md` (what each new
   feature sends), `docs/supabase-schema.md` (`root_id` row), upgrade-plan
   Batch 4 section and migration table row. Full verify
   (`npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run build`),
   then one batch commit.
