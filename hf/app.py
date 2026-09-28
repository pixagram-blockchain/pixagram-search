"""
Hugging Face Space entry point (sdk: gradio): SigLIP image + text embeddings for pixagram-search.

Two faces on one server (port 7860):
  POST /embed      JSON API used by the Cloudflare Worker (see siglip.Embedder.handle for the shape)
  GET  /health     {"ok", "model", "dim", "ready"}
  GET  /           Gradio demo page: embed a text or an image, compare an image with a caption

Space secrets / variables:
  API_TOKEN   optional shared secret; when set, /embed requires "Authorization: Bearer <API_TOKEN>"
              (for a *private* Space leave it unset — HF already gates requests with your HF token)
  MODEL_ID    override the model (default google/siglip-base-patch16-256-multilingual, 768-d)
"""

from __future__ import annotations

import os
import threading
import time
from typing import Optional

import gradio as gr
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from PIL import Image

from siglip import MODEL_ID, Embedder, shared, to_rgb

API_TOKEN = os.environ.get("API_TOKEN") or None
# Spaces expose port 7860 and set GRADIO_SERVER_PORT; PORT is honoured for other hosts.
PORT = int(os.environ.get("GRADIO_SERVER_PORT") or os.environ.get("PORT") or "7860")
HOST = os.environ.get("GRADIO_SERVER_NAME", "0.0.0.0")

embedder: Embedder = shared()
_started = time.time()

# Warm the model in the background so the first request does not pay the full load time.
threading.Thread(target=embedder.load, name="siglip-warmup", daemon=True).start()

api = FastAPI(title="pixagram-search embeddings", version="1.0")


@api.get("/health")
def health():
    return {"ok": True, "model": embedder.model_id, "dim": embedder.dim, "ready": embedder.ready, "stub": embedder.stub, "uptime_s": int(time.time() - _started)}


@api.post("/embed")
async def embed(request: Request, authorization: Optional[str] = Header(default=None)):
    if API_TOKEN and authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")
    try:
        # embedder.handle blocks while the model finishes loading on a cold start; the Worker
        # waits (its consumer has a 15-minute budget) rather than getting a 503.
        return JSONResponse(embedder.handle(payload))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # decoding errors etc.
        raise HTTPException(status_code=422, detail=f"{type(e).__name__}: {e}")


# ---- Gradio demo -------------------------------------------------------------------------


def _vector_view(vec):
    return {"dim": len(vec), "first_8": [round(v, 5) for v in vec[:8]], "norm": round(sum(v * v for v in vec) ** 0.5, 6)}


def ui_embed_text(text: str):
    if not text or not text.strip():
        return {"error": "type something"}
    vec = embedder.embed_texts([text])[0]
    return _vector_view(vec)


def ui_embed_image(img: Optional[Image.Image]):
    if img is None:
        return {"error": "upload an image"}
    vec = embedder.embed_images([to_rgb(img)])[0]
    return _vector_view(vec)


def ui_compare(img: Optional[Image.Image], texts: str):
    if img is None or not texts.strip():
        return {"error": "need an image and one caption per line"}
    captions = [t.strip() for t in texts.splitlines() if t.strip()]
    iv = embedder.embed_images([to_rgb(img)])[0]
    tvs = embedder.embed_texts(captions)
    scores = [(c, round(sum(a * b for a, b in zip(iv, tv)), 4)) for c, tv in zip(captions, tvs)]
    scores.sort(key=lambda x: -x[1])
    return {"cosine": scores}


with gr.Blocks(title="pixagram-search embeddings") as demo:
    gr.Markdown(
        f"## pixagram-search embeddings\n"
        f"Model `{MODEL_ID}` — the same vectors the search engine stores in Vectorize. "
        f"The Worker calls `POST /embed`; this page is for eyeballing the model on pixel art."
    )
    with gr.Tab("Text → vector"):
        t_in = gr.Textbox(label="query text", placeholder="a swan on a lake at sunset")
        t_btn = gr.Button("Embed")
        t_out = gr.JSON(label="vector")
        t_btn.click(ui_embed_text, inputs=t_in, outputs=t_out, api_name="embed_text")
    with gr.Tab("Image → vector"):
        i_in = gr.Image(type="pil", label="artwork (webp/png)")
        i_btn = gr.Button("Embed")
        i_out = gr.JSON(label="vector")
        i_btn.click(ui_embed_image, inputs=i_in, outputs=i_out, api_name="embed_image")
    with gr.Tab("Compare"):
        c_img = gr.Image(type="pil", label="artwork")
        c_txt = gr.Textbox(label="captions, one per line", lines=4, value="a swan on a lake at sunset\na space invader\na portrait of a woman\nabstract shapes")
        c_btn = gr.Button("Score")
        c_out = gr.JSON(label="cosine similarity per caption")
        c_btn.click(ui_compare, inputs=[c_img, c_txt], outputs=c_out, api_name="compare")

# ssr_mode=False is essential on Spaces: the platform sets GRADIO_SSR_MODE=True, which would make
# mount_gradio_app start Gradio's Node SSR server on 7860 before uvicorn binds it
# ("[Errno 98] address already in use"). Client-side rendering needs no extra process.
app = gr.mount_gradio_app(api, demo, path="/", ssr_mode=False)

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
