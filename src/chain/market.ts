// Marketplace hook.
//
// As of Sept 2026 no custom_json marketplace operations exist on the Pixa chain, so this is a
// documented extension point rather than a filter with data. When Pixa Rex publishes the
// marketplace op ids, list them in MARKET_CUSTOM_JSON_IDS and map the payload here.
//
// Expected payload shape (adjust once the real one is known):
//   { "action": "list" | "unlist" | "sold", "author": "...", "permlink": "...", "price": "12.000 PXS" }

import type { Env } from "../env";
import { list } from "../env";
import { getPostByRef } from "../db/posts";
import { parseAsset, type CustomJsonOp } from "./rpc";

export function marketIds(env: Env): Set<string> {
  return new Set(list(env.MARKET_CUSTOM_JSON_IDS));
}

export async function handleMarketOp(env: Env, op: CustomJsonOp): Promise<void> {
  let payload: any;
  try {
    payload = JSON.parse(op.json);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  const events: any[] = Array.isArray(payload) ? payload : [payload];
  for (const ev of events) {
    const author = typeof ev.author === "string" ? ev.author : null;
    const permlink = typeof ev.permlink === "string" ? ev.permlink : null;
    if (!author || !permlink) continue;
    const post = await getPostByRef(env.DB, author, permlink);
    if (!post) continue;
    const action = String(ev.action ?? ev.type ?? "").toLowerCase();
    if (action === "list" || action === "sell") {
      const price = parseAsset(ev.price);
      const symbol = typeof ev.price === "string" ? ev.price.split(" ")[1] ?? null : null;
      await env.DB.prepare("UPDATE posts SET listed = 1, price = ?, price_symbol = ? WHERE id = ?").bind(price, symbol, post.id).run();
    } else if (action === "unlist" || action === "cancel" || action === "sold" || action === "buy") {
      await env.DB.prepare("UPDATE posts SET listed = 0 WHERE id = ?").bind(post.id).run();
    }
  }
}
