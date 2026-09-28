# pixagram-search

Image search engine for [Pixagram](https://pixagram.com) artworks, built on Cloudflare
(Workers, D1, Queues, Vectorize, Workers AI, R2, Durable Objects, Workflows) with one small
Hugging Face Space (`hf/app.py`) for image/text embeddings. It reads the Pixa chain directly — nothing
else is a source of truth — and exposes a JSON search API with full text, semantic search,
and filters by primary colour, author, tags, size, colour count, date, transparency, NSFW
and license.

```
Pixa chain (api.pixagram.com)
   │  block tail (Durable Object alarm)  +  account backfill (Workflow)
   ▼
D1 ─ posts, artworks, colours, tags, pHash chunks, jobs, FTS5 index
   │  Queue: one message per (re)ingested artwork
   ▼
consumer Worker: decode WebP/PNG → native stats → pHash → xBRZ upscale → PNG
   ├─► R2      orig/<sha256>.webp, up/<sha256>.png
   ├─► HF Space  SigLIP image embedding ──► Vectorize (cosine, metadata-filterable)
   └─► Workers AI (Moondream / Llama 4 Scout) JSON description ──► D1 + FTS
   ▲
search API Worker (Hono): D1 filters + FTS5 bm25  ⊕  Vectorize kNN  → reciprocal rank fusion
```

## What is on chain (verified Sept 2026)

The parser is written against live posts, not assumptions:

| | |
|---|---|
| artwork vs blog | `json_metadata.format` = `"image"` / `"markdown"` |
| image payload | the **whole body** is `data:image/webp;base64,…` (lossless VP8L today; PNG handled) |
| metadata | `tags[]`, `description`, `nsfw`, `license` (PIXA_LICENSE incl. `visitorRights["ai-training"]`, `royaltyPercentage`), `app: "pixagram/x.y.z"` |
| deletion | body edited to the literal `deleted` (there is no `delete_comment`) |
| sizes | typically 200–430 px on the long side; 2–370 KB |
| APIs | `condenser_api.get_content`, `bridge.get_account_posts` (20/page), `block_api.get_block_range`, `condenser_api.lookup_accounts`; `database_api.list_comments` is **not** enabled |
| marketplace | no `custom_json` ops yet → `src/chain/market.ts` is a documented hook |

## Layout

```
migrations/0001_init.sql     D1 schema: posts, artworks, artwork_colors, post_tags, phash_chunks, jobs,
                             search_docs + posts_fts (FTS5 external content, triggers), query_log, settings
src/index.ts                 Worker entry (fetch / queue / scheduled), WASM codec init, DO + Workflow exports
src/api.ts                   Hono routes: public search API + /admin/*
src/chain/rpc.ts             JSON-RPC client with fallbacks
src/chain/parse.ts           chain post → ParsedPost (format, data URI, tags, license, deleted)
src/chain/ingest.ts          upsert + enqueue
src/chain/indexer-do.ts      ChainIndexer Durable Object: irreversible-block tail
src/chain/backfill.ts        BackfillWorkflow: every account → every post
src/chain/refresh.ts         nightly votes/payout refresh (cron)
src/chain/market.ts          marketplace custom_json hook (stub)
src/db/posts.ts              D1 access, FTS doc writes, jobs
src/enrich/decode.ts         container sniffing (VP8/VP8L/VP8X, PNG), jSquash WASM decode, PNG encode
src/enrich/stats.ts          native stats: size class, exact colour count, transparency, background, palette, buckets
src/enrich/color.ts          sRGB→Lab, CIEDE2000, 20 named colours, clustering, bucketing
src/enrich/phash.ts          DCT pHash, Hamming, 8-bit chunks
src/enrich/upscale.ts        xBRZ (xbrz-js) / nearest, adaptive factor
src/enrich/describe.ts       Workers AI VLM → structured JSON
src/enrich/embed.ts          HF endpoint client, KV-cached query embeddings
src/enrich/consumer.ts       queue consumer (idempotent stages keyed on content hash)
src/search/params.ts         query-string → SearchRequest
src/search/sql.ts            filters, FTS5 match building, keyset browse, facets
src/search/rrf.ts            reciprocal rank fusion + mild boosts
src/search/service.ts        orchestration: browse / text / hybrid, similar, duplicates
hf/app.py                    Hugging Face Space entry point: POST /embed (Worker API) + Gradio demo page
hf/siglip.py                 SigLIP embedder shared by app.py and handler.py
hf/handler.py                same contract for a dedicated HF Inference Endpoint (alternative to the Space)
hf/README.md                 Space config (frontmatter) + deployment notes
scripts/create-resources.sh  one-time Cloudflare resource creation
scripts/admin.sh             admin API wrapper
test/                        vitest unit tests on real fixtures (WebP from the chain)
```

## Setup

Prerequisites: Node 20+, a Cloudflare account on **Workers Paid** (Queues, Durable Objects
and Workflows need it), optionally a Hugging Face account for semantic search.

```bash
npm install
npx wrangler login
scripts/create-resources.sh          # D1, KV, R2, Queues, Vectorize (+ metadata indexes)
#  → paste the D1 database_id and KV id into wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN  # any long random string
npm run db:migrate                   # applies migrations/ to the remote D1
npm run deploy
```

Semantic search (optional but the biggest quality jump): create a Gradio Space from the
`hf/` folder as described in `hf/README.md` (`app.py` is the entry point), then
`npx wrangler secret put HF_TOKEN` and set `HF_EMBED_URL` to the Space's `/embed` URL in
`wrangler.jsonc`. Without it, everything else works and `embed` jobs are marked *skipped*;
once it is configured, `scripts/admin.sh reindex-all '"embed"'` fills the vectors in.

### First run

```bash
export BASE=https://pixagram-search.<account>.workers.dev ADMIN_TOKEN=...
scripts/admin.sh backfill            # every account → every post; ~115 posts today, minutes
scripts/admin.sh backfill-status <id>
scripts/admin.sh start               # live tail from the current irreversible block
scripts/admin.sh stats               # counts per type, per stage, indexer cursor
```

The backfill Workflow and the tail are safe to run in any order and any number of times:
ingestion is an upsert and enrichment stages are skipped when the image's SHA-256 is unchanged.

### Local development

```bash
npm run db:migrate:local
echo 'ADMIN_TOKEN=devtoken' > .dev.vars
npm run dev                          # http://127.0.0.1:8787
BASE=http://127.0.0.1:8787 ADMIN_TOKEN=devtoken scripts/admin.sh ingest matus swan-1790532192509
curl 'http://127.0.0.1:8787/search?q=swan&facets=1'
```

Local D1, R2, KV, Queues, Durable Objects and Workflows are emulated by wrangler and the
chain RPC is reachable, so ingestion, the tail, the backfill and the enrichment pipeline up
to the vector store run locally. Vectorize and Workers AI have no local emulation
(`Binding VEC/AI needs to be run remotely` is expected in `wrangler dev`; add `"remote": true`
to those bindings in `wrangler.jsonc` to use the real ones from local dev). The Space can run
on your machine (`cd hf && pip install -r requirements.txt && python app.py`) with
`HF_EMBED_URL=http://127.0.0.1:7860/embed` in `.dev.vars`. `npm test` covers the pure modules
on real chain fixtures.

## Configuration (`wrangler.jsonc` → `vars`)

| var | default | meaning |
|---|---|---|
| `RPC_URL`, `RPC_FALLBACK_URLS` | api.pixagram.com, … | Hive-compatible JSON-RPC nodes |
| `APP_PREFIXES` | `pixagram` | only index posts whose `json_metadata.app` starts with one of these; empty = all |
| `HF_EMBED_URL`, `HF_TOKEN` (secret) | — | `https://<owner>-<space>.hf.space/embed`; empty disables semantic search |
| `EMBED_MODEL`, `EMBED_DIM` | siglip-base multilingual, 768 | must match the Space's `MODEL_ID` and the Vectorize index |
| `VLM_BACKEND` | `moondream` | `moondream` (cheap, fast) · `scout` (Llama 4 Scout, richer) · `off` |
| `SCALER`, `UPSCALE_TARGET` | `xbrz`, 800 | image fed to the AI and stored as preview; factor = ⌈target / long side⌉ capped at 6 |
| `RESPECT_AI_TRAINING_FLAG` | `false` | skip AI *description* when the license says `ai-training: false` (the flag is stored and filterable either way) |
| `STORE_IN_R2` | `true` | keep originals + upscaled PNGs in R2 (served at `/img/…`) |
| `MARKET_CUSTOM_JSON_IDS` | — | marketplace op ids for `src/chain/market.ts` |
| `TAIL_BLOCKS_PER_TICK`, `TAIL_IDLE_SECONDS` | 200, 3 | tail pacing |
| `ADMIN_TOKEN` (secret) | — | bearer token for `/admin/*` |

## API

All responses are JSON; CORS is open. Items have the shape below (blog posts have
`artwork: null`).

```jsonc
{
  "id": 1, "author": "matus", "permlink": "swan-1790532192509", "path": "/@matus/swan-1790532192509",
  "type": "artwork", "title": "Swan", "description": "Swan", "category": "bird", "tags": ["bird"],
  "created": 1790532192, "updated": 1790532192, "net_votes": 1, "payout": 14.469, "children": 0,
  "nsfw": false, "ai_training": true, "listed": false, "price": null,
  "artwork": {
    "hash": "98f673…", "mime": "image/webp", "bytes": 15752, "lossy": false,
    "width": 274, "height": 183, "size_class": "xlarge", "color_count": 56,
    "has_transparency": false, "primary_color": "tan", "background_hex": null,
    "palette": [{ "hex": "#f69f59", "share": 0.0998 }, …],
    "buckets": [{ "name": "tan", "weight": 0.4248 }, { "name": "navy", "weight": 0.2487 }, …],
    "phash": "f246a3b9d92c13b1",
    "images": { "original": "/img/orig/98f673….webp", "upscaled": "/img/up/98f673….png" },
    "upscaled_size": { "width": 822, "height": 549, "factor": 3 },
    "ai": { "caption": "…", "subjects": [], "tags": [], "style": "landscape", "mood": "calm", "text": "", "nsfw": 0.01 },
    "stages": { "stats": true, "embed": true, "describe": true }
  },
  "score": { "fused": 0.0183, "ranks": { "fts": 1, "vec": 4 } }
}
```

### `GET /search`

| param | |
|---|---|
| `q` | free text over title, description, tags, AI caption/tags, blog body (FTS5, bm25) **and** the SigLIP index when configured; results are fused with RRF |
| `type` | `artwork` \| `blog` |
| `author` | comma list / repeated |
| `tag` | comma list / repeated — all must match |
| `color` | **primary colour** ∈ `black white gray red orange yellow green lime teal cyan sky blue navy purple magenta pink brown tan olive maroon` |
| `has_color` | any palette bucket with weight ≥ `min_color_weight` (default 0.08) |
| `size` | `icon`(≤16) `tiny`(≤32) `small`(≤64) `medium`(≤128) `large`(≤256) `xlarge`(≤512) `huge` |
| `min_colors`, `max_colors` | exact unique colour count (native image) |
| `min_width`, `max_width`, `min_height`, `max_height` | px |
| `from`, `to` | date (`2026-09-01`) or unix seconds; `to` exclusive |
| `transparent` | `true` / `false` |
| `nsfw` | `exclude` (default: author flag off and AI estimate < 0.7) \| `include` \| `only` |
| `listed`, `ai_training` | `true` / `false` |
| `sort` | `relevance` (default with `q`) \| `newest` (default without) \| `oldest` \| `votes` \| `payout` |
| `limit` | 1–50 (24) |
| `cursor` | from `next_cursor` — keyset when browsing, offset within the ≤200 fused candidates when searching |
| `facets` | `1` adds counts for `primary_color`, `has_color`, `size_class`, `type`, `author`, `tag`, `month`, `color_count`, `transparency` under the same filters |
| `semantic` | `0` disables the vector leg |

```
/search?q=dragon+over+a+city&type=artwork&color=navy,black&size=large,xlarge&from=2026-09-01&facets=1
/search?has_color=red&min_colors=2&max_colors=8&sort=votes
/search?author=matus&sort=oldest&limit=50
```

Other routes:

| route | |
|---|---|
| `GET /similar/:id?limit=` | kNN on the stored vector (same filter params as `/search`); falls back to pHash neighbours when the post has no vector yet |
| `GET /duplicates/:id?max_distance=8` | pHash near-duplicates (indexed 8-bit chunk lookup, exact Hamming re-check) |
| `POST /search-by-image` | multipart `image` or JSON `{"image": "<base64\|data URI>"}` → semantic neighbours + duplicates |
| `GET /posts/:id`, `GET /posts/:author/:permlink` | one item with the full palette |
| `GET /img/orig/<sha256>.webp`, `GET /img/up/<sha256>.png` | R2-backed, immutable |
| `GET /vocab` | filter vocabularies for building a UI |
| `GET /healthz` | |

Admin (`Authorization: Bearer $ADMIN_TOKEN`): `GET /admin/stats`, `GET /admin/indexer`,
`POST /admin/indexer/start[?from=BLOCK]`, `POST /admin/indexer/stop`, `POST /admin/backfill
{authors?}`, `GET /admin/backfill/:id`, `POST /admin/ingest/:author/:permlink`, `POST
/admin/reindex {post_id|author|all, stages?, force?}`, `GET /admin/jobs/failed`, `GET
/admin/queries?days=7` (zero-result queries — the cheapest guide to missing synonyms).

## How ranking works

* **Filters** are SQL `WHERE` clauses (cached by D1, unscored). The same filters are mirrored
  into the Vectorize metadata filter where it can express them (author, primary colour, size
  class, date, colour count, nsfw, listed, ai_training); the rest (tags, `has_color`, pixel
  dimensions, transparency) are re-applied when the candidates are hydrated from D1.
* **Text** → FTS5 with `bm25(title 6, description 3, body 1, tags 4, ai_caption 2.5, ai_tags 3, author 0.5)`,
  implicit AND with a prefix on the last token; multi-word queries with < 5 hits are retried with OR.
* **Semantic** → the query is embedded by the same SigLIP model that embedded the images
  (cached in KV for 7 days), top-100 by cosine.
* **Fusion** → reciprocal rank fusion (k = 60), then a mild boost: `× (1 + 0.08·ln(1+votes))
  × (1 + 0.06·e^(−age/120d))`. Fused candidate sets are cached in KV for 60 s.

## Colour model

Stats are computed on the **native** image (xBRZ invents intermediate colours, so nothing
numeric is taken from the upscaled one). Pixels with alpha < 8 are transparent. The
background is the transparent backdrop when it covers ≥ 20 %, else the colour that dominates
the 1-px border (≥ 50 %) *and* ≥ 20 % of the image — it is excluded from the primary-colour
vote and reported as `background_hex`. Remaining colours (top 512 by coverage) are clustered
greedily in CIELAB with a CIEDE2000 threshold of 12, each cluster snapped to the nearest of
20 named colours, weights summed per name and normalised: `buckets`. `primary_color` is the
heaviest bucket. Lossy WebP (VP8) is flagged and its colour count is a ΔE-merged estimate.

## Operations

* **Model change** (embedding): create a new Vectorize index with the new dimension, point
  `VEC` at it, update `EMBED_MODEL`/`EMBED_DIM`, deploy, then `reindex-all '"embed"' true`.
  Vectors from different models must never share an index.
* **VLM change**: set `VLM_BACKEND`, deploy, `reindex-all '"describe"' true` — done by
  popularity order (`net_votes DESC`) so the artworks people find get described first.
* **Failures**: `scripts/admin.sh failed` lists per-stage errors. Queue retries with
  backoff (8 attempts) then the dead-letter queue `pixagram-enrich-dlq`; re-drive with
  `reindex-post <id>`.
* **Tail health**: `GET /admin/indexer` shows cursor vs irreversible block and the last
  error; a 10-minute cron re-arms the alarm if it is ever lost. Replay a range with
  `start <from_block>`.
* **Counters**: votes/payout are refreshed nightly for posts younger than 10 days
  (`src/chain/refresh.ts`).

## Limits designed around

Queue messages carry ids only (128 KB cap). D1 rows stay far below 2 MB because bodies of
artworks are never stored. Vectorize: ≤ 1536 dims, ≤ 100 results per query, metadata filter
< 2 KB, 10 indexed properties (8 used), inserts visible within minutes — so a freshly enriched
artwork appears in filters before it appears in semantic results. Worker CPU limit is raised
to 5 min; a 430 px artwork through decode + stats + xBRZ ×2 + PNG takes well under a second.
HF Space: one process, no server-side queue; consumer `max_concurrency: 2` is the throttle.

## Costs (order of magnitude)

Workers Paid $5/mo base; D1/KV/R2/Queues/Vectorize usage at Pixagram's size is cents.
Workers AI: Moondream $0.30/M input + $1.00/M output tokens — a description is roughly a
thousand tokens, i.e. ≈ $0.001 per artwork, once per content hash. HF Space: free on CPU basic
(sleeps after 48 h idle; the first query afterwards runs without the semantic leg while it
wakes), or paid CPU hardware with sleep disabled for a few dollars a month.

## Notes

* `xbrz-js` is a GPL-3 port of Zenju's xBRZ (itself GPL-3). It runs server-side only, which
  does not trigger distribution obligations; swap in your own xBRZ WASM by implementing
  `upscaleXbrz` in `src/enrich/upscale.ts` if you prefer.
* SVG artworks (`data:image/svg+xml`) are indexed as posts but skipped by the image pipeline
  (no rasteriser in Workers); they still get full-text search.
* The Hivemind endpoints cap page size at 20, hence the account-by-account backfill.
