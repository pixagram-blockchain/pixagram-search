// Nightly counter refresh. Votes and payouts change without any comment op, so posts created
// in the last 10 days (Pixa's payout window is 7 days; a margin covers late curation) are
// re-read with get_content. Older posts keep their final numbers.

import type { Env } from "../env";
import { now } from "../env";
import { parseAsset } from "./rpc";
import { rpcFor } from "./ingest";
import { updateCounters } from "../db/posts";

export async function refreshCounters(env: Env, windowDays = 10, max = 800): Promise<{ refreshed: number }> {
  const since = now() - windowDays * 86400;
  const rows = await env.DB
    .prepare("SELECT id, author, permlink FROM posts WHERE deleted = 0 AND created >= ? ORDER BY created DESC LIMIT ?")
    .bind(since, max)
    .all<{ id: number; author: string; permlink: string }>();
  const rpc = rpcFor(env);
  let refreshed = 0;
  for (const p of rows.results ?? []) {
    try {
      const c = await rpc.getContent(p.author, p.permlink);
      if (!c) continue;
      const payout = parseAsset(c.pending_payout_value) + parseAsset(c.total_payout_value) + parseAsset(c.curator_payout_value);
      const votes = typeof c.net_votes === "number" ? c.net_votes : Array.isArray(c.active_votes) ? c.active_votes.length : 0;
      await updateCounters(env.DB, p.id, votes, payout, c.children ?? 0);
      refreshed++;
    } catch (e) {
      console.warn("refresh failed", p.author, p.permlink, e instanceof Error ? e.message : e);
    }
  }
  return { refreshed };
}
