// Client for the SigLIP embedding service (hf/app.py on a Hugging Face Space, or hf/handler.py on an
// Inference Endpoint — same contract). HF_EMBED_URL is the full URL of the embed route, e.g.
// https://<owner>-<space>.hf.space/embed
// One model, two towers: images for the pipeline, texts for queries. Vectors are L2-normalised
// by the handler so cosine similarity is a dot product.

import type { Env } from "../env";
import { int } from "../env";

export interface EmbedResult {
  model: string;
  dim: number;
  embeddings: number[][];
}

export class EmbedUnavailable extends Error {
  constructor(msg: string, public readonly retryable: boolean) {
    super(msg);
    this.name = "EmbedUnavailable";
  }
}

export function embeddingEnabled(env: Env): boolean {
  return !!env.HF_EMBED_URL;
}

async function call(env: Env, inputs: Record<string, unknown>): Promise<EmbedResult> {
  if (!env.HF_EMBED_URL) throw new EmbedUnavailable("HF_EMBED_URL not configured", false);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    // Inference Endpoints: hold the request while a scaled-to-zero replica wakes up (ignored by Spaces).
    "x-scale-up-timeout": "600",
  };
  if (env.HF_TOKEN) headers.authorization = `Bearer ${env.HF_TOKEN}`;
  const res = await fetch(env.HF_EMBED_URL, { method: "POST", headers, body: JSON.stringify({ inputs }) });
  if (res.status === 503 || res.status === 502 || res.status === 429) {
    throw new EmbedUnavailable(`embedding endpoint ${res.status}`, true);
  }
  if (!res.ok) throw new EmbedUnavailable(`embedding endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status >= 500);
  // A Space that is sleeping, building or restarting answers with an HTML page: treat as transient.
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EmbedUnavailable(`embedding endpoint returned non-JSON (${res.headers.get("content-type") ?? "?"}): ${text.slice(0, 120)}`, true);
  }
  const embeddings: number[][] = Array.isArray(json?.embeddings) ? json.embeddings : Array.isArray(json) ? json : [];
  if (!embeddings.length) throw new EmbedUnavailable("embedding endpoint returned no vectors", false);
  const expected = int(env.EMBED_DIM, 768);
  if (embeddings[0].length !== expected) {
    throw new EmbedUnavailable(`embedding dim ${embeddings[0].length} != EMBED_DIM ${expected} (Vectorize index must match)`, false);
  }
  return { model: json?.model ?? env.EMBED_MODEL ?? "unknown", dim: embeddings[0].length, embeddings };
}

/** Embed PNG/WebP images given as base64 strings (no data: prefix needed). */
export function embedImages(env: Env, imagesBase64: string[]): Promise<EmbedResult> {
  return call(env, { images: imagesBase64 });
}

export function embedTexts(env: Env, texts: string[]): Promise<EmbedResult> {
  return call(env, { texts });
}

/** Query-text embeddings are cached in KV (same text → same vector) to keep search latency low. */
export async function embedQueryCached(env: Env, text: string): Promise<number[]> {
  const norm = text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 256);
  const key = `qemb:${env.EMBED_MODEL ?? "m"}:${norm}`;
  const hit = await env.CACHE.get(key, "json").catch(() => null);
  if (Array.isArray(hit)) return hit as number[];
  const r = await embedTexts(env, [norm]);
  await env.CACHE.put(key, JSON.stringify(r.embeddings[0]), { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
  return r.embeddings[0];
}
