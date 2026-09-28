// Shared ingestion path used by the live tail, the backfill workflow and the admin API.

import type { Env } from "../env";
import { ALL_STAGES, list } from "../env";
import { ChainRpc, type CondenserPost } from "./rpc";
import { appAllowed, parsePost } from "./parse";
import { upsertPost, setJob } from "../db/posts";

export function rpcFor(env: Env): ChainRpc {
  return new ChainRpc({ url: env.RPC_URL, fallbacks: list(env.RPC_FALLBACK_URLS) });
}

export interface IngestOutcome {
  postId: number | null;
  action: "inserted" | "updated" | "skipped-app" | "skipped-reply" | "missing" | "deleted";
  enqueued: boolean;
}

/** Ingest a post given its current state (from get_content or a bridge listing). */
export async function ingestPost(env: Env, post: CondenserPost, blockNum: number | null, reason: string): Promise<IngestOutcome> {
  if (post.parent_author) return { postId: null, action: "skipped-reply", enqueued: false };
  const parsed = parsePost(post);
  if (!appAllowed(parsed.app, list(env.APP_PREFIXES))) return { postId: null, action: "skipped-app", enqueued: false };

  const r = await upsertPost(env, parsed, blockNum);
  let enqueued = false;
  if (r.needsEnrich) {
    await env.ENRICH_QUEUE.send({ postId: r.id, author: parsed.author, permlink: parsed.permlink, stages: ALL_STAGES, reason });
    for (const s of ALL_STAGES) await setJob(env.DB, r.id, s, "queued");
    enqueued = true;
  }
  return { postId: r.id, action: parsed.deleted ? "deleted" : r.inserted ? "inserted" : "updated", enqueued };
}

/** Fetch the current state of a post from the chain and ingest it. */
export async function ingestPostRef(env: Env, author: string, permlink: string, blockNum: number | null, reason: string): Promise<IngestOutcome> {
  const rpc = rpcFor(env);
  const post = await rpc.getContent(author, permlink);
  if (!post) return { postId: null, action: "missing", enqueued: false };
  return ingestPost(env, post, blockNum, reason);
}
