/// <reference types="@cloudflare/workers-types" />

export interface EnrichMessage {
  /** posts.id */
  postId: number;
  author: string;
  permlink: string;
  /** Which stages to (re)run. Default: all. */
  stages?: Stage[];
  /** Force recomputation even when the content hash is unchanged. */
  force?: boolean;
  /** Why it was enqueued — for logs only. */
  reason?: string;
}

export type Stage = "stats" | "embed" | "describe";
export const ALL_STAGES: Stage[] = ["stats", "embed", "describe"];

export interface Env {
  DB: D1Database;
  ART: R2Bucket;
  CACHE: KVNamespace;
  VEC: VectorizeIndex;
  AI: Ai;
  ENRICH_QUEUE: Queue<EnrichMessage>;
  INDEXER: DurableObjectNamespace;
  BACKFILL: Workflow;

  RPC_URL: string;
  RPC_FALLBACK_URLS?: string;
  APP_PREFIXES?: string;
  HF_EMBED_URL?: string;
  HF_TOKEN?: string; // secret
  EMBED_MODEL?: string;
  EMBED_DIM?: string;
  VLM_BACKEND?: "moondream" | "scout" | "off" | string;
  SCALER?: "xbrz" | "nearest" | string;
  UPSCALE_TARGET?: string;
  RESPECT_AI_TRAINING_FLAG?: string;
  STORE_IN_R2?: string;
  MARKET_CUSTOM_JSON_IDS?: string;
  TAIL_BLOCKS_PER_TICK?: string;
  TAIL_IDLE_SECONDS?: string;
  ADMIN_TOKEN?: string; // secret
}

export function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

export function int(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
}

export function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const now = (): number => Math.floor(Date.now() / 1000);
