"""
Alternative deployment: a Hugging Face *Inference Endpoint* (dedicated) instead of a Space.
Endpoints look for this file and the EndpointHandler class; the Space uses app.py.
Same request/response contract, so the Worker does not care which one it talks to.
"""

from __future__ import annotations

from typing import Any, Dict

from siglip import Embedder


class EndpointHandler:
    def __init__(self, path: str = "") -> None:
        self.embedder = Embedder().load()

    def __call__(self, data: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return self.embedder.handle(data)
        except ValueError as e:
            return {"error": str(e), "model": self.embedder.model_id, "dim": self.embedder.dim, "embeddings": []}
