"""
SigLIP embedder shared by app.py (Space) and handler.py (Inference Endpoint).

One model, two towers: images for the indexing pipeline, texts for search queries — both land
in the same vector space, which is what makes text → image search work. Vectors are
L2-normalised so cosine similarity is a dot product (Vectorize metric: cosine).

Environment:
  MODEL_ID    Hub id of a SigLIP/CLIP-family model (default: multilingual SigLIP base, 768-d)
  MAX_BATCH   images/texts per forward pass (default 32)
  EMBED_STUB  "1" returns deterministic pseudo-vectors without loading any model — wiring tests only
"""

from __future__ import annotations

import base64
import hashlib
import io
import math
import os
import threading
from typing import Any, Dict, List, Optional

from PIL import Image

MODEL_ID = os.environ.get("MODEL_ID", "google/siglip-base-patch16-256-multilingual")
MAX_BATCH = int(os.environ.get("MAX_BATCH", "32"))
MAX_TEXT_TOKENS = 64  # SigLIP text-tower context
STUB = os.environ.get("EMBED_STUB", "") == "1"
STUB_DIM = int(os.environ.get("EMBED_STUB_DIM", "768"))


def decode_image(b64: str) -> Image.Image:
    """base64 (optionally a data URI) → RGB PIL image, transparency composited over white."""
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    img = Image.open(io.BytesIO(raw))
    img.load()
    return to_rgb(img)


def to_rgb(img: Image.Image) -> Image.Image:
    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, rgba)
    return img.convert("RGB")


class Embedder:
    """Lazy-loading, thread-safe wrapper around a SigLIP model."""

    def __init__(self, model_id: str = MODEL_ID) -> None:
        self.model_id = model_id
        self._lock = threading.Lock()
        self._model = None
        self._processor = None
        self.device = "cpu"
        self.dim = STUB_DIM if STUB else 0
        self.stub = STUB

    # ---- loading --------------------------------------------------------------------------

    def load(self) -> "Embedder":
        if self.stub or self._model is not None:
            return self
        with self._lock:
            if self._model is not None:
                return self
            import torch
            from transformers import AutoModel, AutoProcessor

            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            torch.set_num_threads(max(1, os.cpu_count() or 1))
            model = AutoModel.from_pretrained(self.model_id).to(self.device).eval()
            self._processor = AutoProcessor.from_pretrained(self.model_id)
            cfg = model.config
            self.dim = int(getattr(cfg, "projection_dim", 0) or getattr(cfg.text_config, "projection_size", 0) or cfg.text_config.hidden_size)
            self._model = model
        return self

    @property
    def ready(self) -> bool:
        return self.stub or self._model is not None

    # ---- embedding ------------------------------------------------------------------------

    def embed_images(self, images: List[Image.Image]) -> List[List[float]]:
        if self.stub:
            return [_stub_vector(hashlib.sha256(im.tobytes()).hexdigest()) for im in images]
        self.load()
        import torch

        out: List[List[float]] = []
        with torch.inference_mode():
            for i in range(0, len(images), MAX_BATCH):
                batch = [to_rgb(im) for im in images[i : i + MAX_BATCH]]
                inputs = self._processor(images=batch, return_tensors="pt").to(self.device)
                feats = self._model.get_image_features(**inputs)
                feats = _pooled(feats)
                feats = torch.nn.functional.normalize(feats, dim=-1)
                out.extend(feats.cpu().float().tolist())
        return out

    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        if self.stub:
            return [_stub_vector(hashlib.sha256(t.strip().lower().encode()).hexdigest()) for t in texts]
        self.load()
        import torch

        out: List[List[float]] = []
        with torch.inference_mode():
            for i in range(0, len(texts), MAX_BATCH):
                batch = [t if t.strip() else " " for t in texts[i : i + MAX_BATCH]]
                # SigLIP was trained with padding="max_length"; keep it so query vectors match.
                inputs = self._processor(
                    text=batch, padding="max_length", truncation=True, max_length=MAX_TEXT_TOKENS, return_tensors="pt"
                ).to(self.device)
                feats = self._model.get_text_features(**inputs)
                feats = _pooled(feats)
                feats = torch.nn.functional.normalize(feats, dim=-1)
                out.extend(feats.cpu().float().tolist())
        return out

    # ---- request handling shared by the Space route and the Endpoint handler -----------------

    def handle(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        {"inputs": {"images": [b64, ...], "texts": [str, ...]}}  (either key optional)
        → {"model", "dim", "embeddings": [image vectors..., text vectors...]}
        """
        inputs = payload.get("inputs", payload) if isinstance(payload, dict) else payload
        if isinstance(inputs, str):
            inputs = {"texts": [inputs]}
        if not isinstance(inputs, dict):
            raise ValueError("body must be {\"inputs\": {\"images\": [...], \"texts\": [...]}}")
        images_b64 = inputs.get("images") or []
        texts = inputs.get("texts") or []
        if isinstance(images_b64, str):
            images_b64 = [images_b64]
        if isinstance(texts, str):
            texts = [texts]
        if not images_b64 and not texts:
            raise ValueError("provide inputs.images (base64) and/or inputs.texts")
        if len(images_b64) + len(texts) > 256:
            raise ValueError("at most 256 items per request")

        embeddings: List[List[float]] = []
        if images_b64:
            embeddings.extend(self.embed_images([decode_image(b) for b in images_b64]))
        if texts:
            embeddings.extend(self.embed_texts([str(t) for t in texts]))
        return {"model": self.model_id if not self.stub else "stub", "dim": len(embeddings[0]) if embeddings else self.dim, "embeddings": embeddings}


def _pooled(feats):
    """transformers ≥5 may return a ModelOutput; older versions return the tensor directly."""
    if hasattr(feats, "pooler_output") and feats.pooler_output is not None:
        return feats.pooler_output
    if hasattr(feats, "last_hidden_state") and not hasattr(feats, "shape"):
        return feats.last_hidden_state
    return feats


def _stub_vector(seed_hex: str) -> List[float]:
    """Deterministic unit vector from a hash — lets the Worker ↔ Space wiring be tested without weights."""
    vals: List[float] = []
    h = seed_hex
    while len(vals) < STUB_DIM:
        h = hashlib.sha256(h.encode()).hexdigest()
        vals.extend(int(h[i : i + 2], 16) / 127.5 - 1.0 for i in range(0, 64, 2))
    vals = vals[:STUB_DIM]
    norm = math.sqrt(sum(v * v for v in vals)) or 1.0
    return [v / norm for v in vals]


_shared: Optional[Embedder] = None


def shared() -> Embedder:
    global _shared
    if _shared is None:
        _shared = Embedder()
    return _shared
