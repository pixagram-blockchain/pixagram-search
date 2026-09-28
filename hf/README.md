---
title: pixagram-search embeddings
emoji: 🟪
colorFrom: purple
colorTo: indigo
sdk: gradio
sdk_version: 6.28.0
app_file: app.py
pinned: false
license: apache-2.0
short_description: SigLIP image/text embeddings for the Pixagram search engine
---

# SigLIP embedding Space for pixagram-search

One model, two towers. The Cloudflare Worker sends artwork PNGs here while indexing and the
query text here at search time; both land in the same vector space, which is what makes
text → image search work. `app.py` is the Space entry point; it serves:

| route | |
|---|---|
| `POST /embed` | `{"inputs": {"images": ["<base64>", …], "texts": ["…", …]}}` → `{"model", "dim", "embeddings": [[…], …]}` (images first, then texts; L2-normalised) |
| `GET /health` | `{"ok", "model", "dim", "ready", "stub"}` — `ready` flips to true once the weights are loaded |
| `GET /` | Gradio page: embed a text or an image, score an image against captions |

## Deploy as a Space

1. Create a Space (SDK: **Gradio**, hardware: **CPU basic** is enough — a SigLIP-base pass on
   one artwork takes ~0.25 s on 2 vCPU; the queue consumer sends 1 image per call, 2 in flight).
2. Upload this folder's `README.md` (the frontmatter above is the Space config), `app.py`,
   `siglip.py`, `requirements.txt`. `handler.py` can stay; it is only used by Inference Endpoints.
3. Visibility:
   * **Private** Space (recommended): every request must carry an HF token that can read the
     Space — set that token as the Worker's `HF_TOKEN` secret. Leave `API_TOKEN` unset.
   * **Public** Space: set a Space secret `API_TOKEN` to a long random string and use the same
     string as the Worker's `HF_TOKEN`; `/embed` then rejects anything else with 401.
4. Worker: `npx wrangler secret put HF_TOKEN`, and set
   `HF_EMBED_URL = "https://<owner>-<space-name>.hf.space/embed"` in `wrangler.jsonc`
   (the host is `<owner>-<space-name>` with dots in the owner name replaced by dashes; the
   Space settings page shows the exact "Direct URL").
5. Deploy the Worker, then `scripts/admin.sh reindex-all '"embed"'` to fill the vectors in.

Cold start: the multilingual SigLIP base checkpoint is ~1.5 GB; the Space answers `/health`
in seconds and `/embed` blocks until the weights are loaded (about 20 s once cached, a few
minutes on the first build). Free CPU Spaces **sleep after 48 h without traffic**; the Worker
treats the wake-up page as a transient error and retries with backoff, and search simply runs
without the semantic leg until the Space is back. If that gap matters, use paid CPU hardware
and set the sleep time to "never".

## Test

```bash
curl -s https://<owner>-<space>.hf.space/health
curl -s https://<owner>-<space>.hf.space/embed -H "Authorization: Bearer $HF_TOKEN" \
  -H "Content-Type: application/json" -d '{"inputs":{"texts":["a swan on a lake at sunset"]}}' | jq '.dim'
```

Local run (any machine with Python 3.10+): `pip install -r requirements.txt && python app.py`,
then point the Worker's `.dev.vars` at `HF_EMBED_URL=http://127.0.0.1:7860/embed`.
`EMBED_STUB=1 python app.py` starts without weights and returns deterministic pseudo-vectors —
handy for wiring tests, never for production (`/health` reports `"stub": true`).

## Changing the model

Any CLIP/SigLIP-family model with `get_image_features` / `get_text_features` works: set the
`MODEL_ID` Space variable (e.g. `google/siglip-so400m-patch14-384`, 1152-d, English text tower).
A model change means a **new Vectorize index** with the new dimension → point `VEC` at it,
update `EMBED_MODEL` / `EMBED_DIM` → `POST /admin/reindex {"all": true, "stages": ["embed"],
"force": true}`. Vectors from different models must never share an index.

## Inference Endpoint instead of a Space

`handler.py` implements the `EndpointHandler` contract for a dedicated Inference Endpoint
(task *custom*, same `siglip.py`, same request/response shape). Use it when you want
autoscaling, private networking, or GPU without the Space UI. Then `HF_EMBED_URL` is the
endpoint URL itself and the Worker's `X-Scale-Up-Timeout: 600` header makes a scaled-to-zero
replica wake up within the request instead of returning 503.
