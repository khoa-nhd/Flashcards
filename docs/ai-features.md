# AI assistance: what it is, what it sends, how to turn it off

Four features can ask a language model for a draft. Everything else in the
app runs without one, and all four keep working — as plain manual entry —
when no model is configured or it does not answer.

| Feature | Where | What leaves this server |
| --- | --- | --- |
| **Smart Reader** | Add vocabulary → Smart Reader | The one sentence around the word you selected, plus that word. The sentence is taken from your own text by this server before anything is sent; the model never sees the rest of the passage. |
| **Writing Challenge coach** | Practice → Writing mode, after you submit | The sentence you wrote, plus the word, its meaning and its example (your own card data). |
| **Word family** | A word's panel → Build the word family (AI) | The word from your card and, where set, its meaning and definition. The model replies with the words formed from one root and which end is the base; you untick what does not belong, then it creates the missing words and links them — ordinary writes, reviewed by you. |
| **Example sentences** | A word's panel → More examples → Suggest example sentences (AI) | The word, its meaning, definition and example, plus the collocations you have saved for it (up to 10). The sentences come back as drafts; you can edit each one, and only the ones you leave ticked are saved as further examples. |

Nothing else is ever sent: not your vocabulary, not your history, not your
settings, and never another account's data — every request carries only what
you just typed or selected. The provider may keep what it receives — see
Settings → AI assistance — so do not paste anything private.

## Configuration

Read by `server/env.ts`, used only on the server; the browser never sees a
key (`tests/frontend-secrets.test.ts` enforces this):

| Variable | Meaning | Default |
| --- | --- | --- |
| `AI_API_KEY` | The provider's key. **Without it all four features are off** and say so. | — |
| `AI_BASE_URL` | The provider's OpenAI-compatible endpoint, ending in `/`. | Google Gemini's OpenAI-compatible endpoint |
| `AI_MODEL` | The model name sent with each request. | `gemini-2.5-flash` |
| `AI_TIMEOUT_MS` | How long to wait before giving up (1000–28000 ms). | `20000` |

Any provider that speaks the OpenAI chat protocol works: set the three values
and nothing in the code changes. The free tiers of Gemini and OpenRouter are
the intended defaults; their quotas are the reason for the limits below, and
they should be re-checked when a provider is first configured — quota figures
move.

## Limits and failure behaviour

- **Per-account request limit** for Smart Reader, the word family and the
  example sentences: a token bucket of 5 each, one earned back per minute,
  checked *before* a request is made (`server/ai/rate-limit.ts`). The coach
  has its own process-wide bucket of 10.
- **Every failure is a named, tested state** (`server/ai/adapter.ts`):
  not configured, timeout, rate-limited, invalid output, unavailable. The
  browser treats them the same way: keep the form, say what happened, carry on
  by hand. A model that answers nonsense is discarded — its reply must match a
  strict schema before anyone sees it.
- **Nothing the model says is saved by itself.** Smart Reader hands its draft
  to the ordinary add form; you check it and save it like anything typed. The
  word family and the example sentences are the same: the draft is reviewed
  row by row, and saving it is the ordinary create/link/add-example paths,
  with every word, link and sentence yours to keep or discard. The
  coach's note is stored beside your practice answer only after your answer
  has already been judged and saved — a failing model can never fail an
  answer.
- **The verdict never comes from the model.** Smart Reader's sentence is the
  server's, taken from your text. The Writing Challenge's correct/incorrect
  check is a pure function (`shared/study-modes.ts`), independent of the
  model. Review grading, mastery, review dates and FSRS are never touched by
  any AI call.
- **Frozen saving** (`REVIEW_WRITES_ENABLED=false`) refuses AI routes too:
  asking a model for a draft that cannot be saved only spends quota.

## Where things live

```
shared/ai.ts              the request/response contracts both sides share
shared/sentences.ts       the sentence around a word (server-side, pure)
server/ai/adapter.ts      one place a model is asked anything; named failures
server/ai/rate-limit.ts   per-account token bucket
server/ai/smart-reader.ts Smart Reader service + HTTP error mapping
server/ai/writing-coach.ts the Writing Challenge coach (see below)
server/ai/word-family.ts  the words formed from one root (needs schema 11)
server/ai/examples.ts     example sentences with the saved collocations
```
